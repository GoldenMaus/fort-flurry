// P2P over the PeerJS cloud broker: the primary deployment. The broker only introduces
// peers; once a data channel is up it is not needed, so nothing here may treat a broker
// problem as a game problem. PeerJS is loaded on first use and never in the worker.
import { BIN, CLOSE, ERR, MSG } from '../../shared/schema.js';
import { MAX_INBOUND_BYTES, MAX_PLAYERS, P2P_ID_PREFIX } from '../../shared/constants.js';
import { ChunkAssembler, SEND, chunkMessage, makeRoomCode, sendVerdict } from '../../shared/protocol.js';
import { HostWorker, LOCAL_CONN } from './transport-local.js';

const PEER_OPEN_TIMEOUT_MS = 10000;
const CONNECT_DEADLINE_MS = 20000;
const CLOSE_FLUSH_MS = 500;
const CLOSE_POLL_MS = 20;
const HOST_CODE_TRIES = 8;
const MAX_CONNS = MAX_PLAYERS + 4;
const MAX_UNGREETED = 4;
const SILENCE_LIMIT_MS = 10000;
const NEGOTIATE_LIMIT_MS = CONNECT_DEADLINE_MS;
const BROKER_RETRY_BEATS = Object.freeze([1, 2, 4, 8, 15]);
const BROKER_STUCK_BEATS = 20;
const NET_ERRORS = Object.freeze(['network', 'server-error', 'socket-error', 'socket-closed']);

// Tests set this to force a path such as iceTransportPolicy 'relay'. Nothing in the
// game calls it, so a URL or a joiner can never reach it.
let configOverride = null;
export function setPeerConfigOverride(config) {
  configOverride = config;
}

let peerLib = null;
export async function loadPeerJs() {
  if (peerLib) return peerLib;
  try {
    await import('../../vendor/peerjs.min.js');
  } catch (err) {
    throw { code: ERR.NET, msg: `Could not load the P2P library: ${err.message}` };
  }
  peerLib = { Peer: window.peerjs.Peer, util: window.peerjs.util };
  return peerLib;
}

// Passing config replaces PeerJS's defaults outright, so its TURN servers survive only
// if they are merged back in here.
function peerOptions(util) {
  return {
    debug: 0,
    config: {
      ...util.defaultConfig,
      iceServers: [...util.defaultConfig.iceServers, { urls: 'stun:stun.cloudflare.com:3478' }],
      ...configOverride,
    },
  };
}

// Never close({flush:true}): with raw serialization it pushes a control object through
// dataChannel.send and throws.
function closeWhenFlushed(conn, then) {
  const started = performance.now();
  const check = () => {
    const buffered = conn.dataChannel?.bufferedAmount ?? 0;
    if (buffered > 0 && performance.now() - started < CLOSE_FLUSH_MS) {
      setTimeout(check, CLOSE_POLL_MS);
      return;
    }
    conn.close();
    then?.();
  };
  check();
}

export class P2PClientTransport {
  constructor(code) {
    this.kind = 'p2p';
    this.code = String(code).toUpperCase();
    this.peer = null;
    this.conn = null;
    this.onmessage = null;
    this.onclose = null;
    this.assembler = new ChunkAssembler();
    this.abort = null;
    this.gone = false;
  }

  async connect() {
    const { Peer, util } = await loadPeerJs();
    if (this.gone) throw { code: ERR.NET, msg: 'Closed' };
    await new Promise((resolve, reject) => {
      let settled = false;
      let deadline = null;
      let openDeadline = null;
      const settle = () => {
        settled = true;
        this.abort = null;
        clearTimeout(deadline);
        clearTimeout(openDeadline);
      };
      const fail = (code, msg) => {
        if (settled) return;
        settle();
        this._teardown();
        reject({ code, msg });
      };
      this.abort = () => fail(ERR.NET, 'Closed');
      deadline = setTimeout(() => fail(ERR.TIMEOUT, 'The room did not answer'), CONNECT_DEADLINE_MS);
      openDeadline = setTimeout(() => fail(ERR.NET, 'Could not reach the broker'), PEER_OPEN_TIMEOUT_MS);

      const peer = new Peer(peerOptions(util));
      this.peer = peer;
      peer.on('error', (err) => {
        // After the channel is up the broker no longer matters, and a dying broker
        // socket must not take a healthy match with it.
        if (settled) return;
        if (err.type === 'peer-unavailable') fail(ERR.NO_ROOM, 'No such room');
        else if (NET_ERRORS.includes(err.type)) fail(ERR.NET, err.message);
        else fail(ERR.TIMEOUT, err.message);
      });
      peer.once('open', () => {
        if (settled) return;
        clearTimeout(openDeadline);
        const conn = peer.connect(P2P_ID_PREFIX + this.code, { reliable: true, serialization: 'raw' });
        this.conn = conn;
        conn.on('open', () => {
          if (settled) return;
          settle();
          resolve();
        });
        conn.on('data', (data) => this._onData(data));
        conn.on('close', () => this._lost('closed'));
        conn.on('error', (err) => {
          if (settled) this._lost(err.type);
          else fail(ERR.TIMEOUT, err.message);
        });
        const pc = conn.peerConnection;
        pc?.addEventListener('connectionstatechange', () => {
          if (pc.connectionState !== 'failed') return;
          if (settled) this._lost('failed');
          else fail(ERR.TIMEOUT, 'The connection failed');
        });
      });
    });
  }

  _onData(data) {
    if (data instanceof ArrayBuffer && data.byteLength > 0 && new Uint8Array(data, 0, 1)[0] === BIN.CHUNK) {
      const whole = this.assembler.push(data);
      if (whole !== null) this.onmessage?.(whole);
      return;
    }
    this.onmessage?.(data);
  }

  _lost(reason) {
    if (this.gone) return;
    this._teardown();
    this.onclose?.(reason);
  }

  _teardown() {
    this.gone = true;
    this.assembler.reset();
    this.conn = null;
    this.peer?.destroy();
    this.peer = null;
  }

  send(data) {
    if (this.conn?.open) this.conn.send(data);
  }

  close() {
    if (this.gone) return;
    if (this.abort) {
      this.abort();
      return;
    }
    this.gone = true;
    this.assembler.reset();
    const { conn, peer } = this;
    this.conn = null;
    this.peer = null;
    // The LEAVE just sent should still arrive.
    if (conn) closeWhenFlushed(conn, () => peer?.destroy());
    else peer?.destroy();
  }
}

export class P2PHostTransport {
  constructor() {
    this.kind = 'p2pHost';
    this.netStatus = 'ok';
    this.code = null;
    this.peer = null;
    this.host = null;
    this.remotes = new Map();
    this.nextRemote = 1;
    this.onmessage = null;
    this.onclose = null;
    this.onstatus = null;
    this.retryIndex = 0;
    this.beatsToRetry = null;
    this.stuckBeats = 0;
    this.gone = false;
    this.abortClaim = null;
    this.onPageHide = () => this._pageHide();
  }

  async connect() {
    const lib = await loadPeerJs();
    const giveUpAt = performance.now() + CONNECT_DEADLINE_MS;
    for (let i = 0; i < HOST_CODE_TRIES; i++) {
      if (this.gone) throw { code: ERR.NET, msg: 'Closed' };
      const code = makeRoomCode(Math.random);
      if (await this._claim(lib, code, giveUpAt)) return;
    }
    throw { code: ERR.NET, msg: 'Could not find a free room code' };
  }

  // Resolves true once the broker has given us this code, false if the code was taken.
  // A Peer that gets unavailable-id has already destroyed itself.
  _claim({ Peer, util }, code, giveUpAt) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const peer = new Peer(P2P_ID_PREFIX + code, peerOptions(util));
      const settle = () => {
        settled = true;
        this.abortClaim = null;
        clearTimeout(timer);
      };
      const giveUp = (msg) => {
        if (settled) return;
        settle();
        peer.destroy();
        reject({ code: ERR.NET, msg });
      };
      const timer = setTimeout(() => giveUp('Could not reach the broker'),
        Math.max(0, Math.min(PEER_OPEN_TIMEOUT_MS, giveUpAt - performance.now())));
      this.abortClaim = () => giveUp('Closed');
      peer.on('error', (err) => {
        if (settled) {
          console.warn('P2P host:', err.type);
        } else if (err.type === 'unavailable-id') {
          settle();
          resolve(false);
        } else {
          giveUp(err.message);
        }
      });
      peer.once('open', () => {
        if (settled) return;
        settle();
        try {
          this._adopt(peer, code);
        } catch (err) {
          peer.destroy();
          reject({ code: ERR.NET, msg: `Could not start the game worker: ${err.message}` });
          return;
        }
        resolve(true);
      });
    });
  }

  _adopt(peer, code) {
    this.peer = peer;
    this.code = code;
    this.host = new HostWorker({
      onSend: (id, data) => this._fromRoom(id, data),
      onClose: (id, reason) => this._closeFromRoom(id, reason),
      onBeat: () => this._onBeat(),
      onError: (reason) => this._localGone(reason),
    });
    // Only now does the room exist, and only now can the code reach anyone.
    this.host.post({ op: 'init', code });
    this.host.post({ op: 'open', id: LOCAL_CONN });
    peer.on('connection', (conn) => this._onConnection(conn));
    peer.on('call', (call) => call.close());
    peer.on('disconnected', () => this._onBrokerLost());
    peer.on('open', () => this._onBrokerBack());
    window.addEventListener('pagehide', this.onPageHide);
  }

  // ---- broker -------------------------------------------------------------------

  _setStatus(status) {
    if (status === this.netStatus) return;
    this.netStatus = status;
    this.onstatus?.(status);
  }

  _onBrokerLost() {
    if (this.gone) return;
    this._setStatus('invitesPaused');
    if (this.beatsToRetry === null) {
      this.beatsToRetry = BROKER_RETRY_BEATS[Math.min(this.retryIndex, BROKER_RETRY_BEATS.length - 1)];
    }
  }

  _onBrokerBack() {
    this.retryIndex = 0;
    this.beatsToRetry = null;
    this.stuckBeats = 0;
    this._setStatus('ok');
  }

  // Worker beats, not main-thread timers: a background tab throttles its own timers,
  // and an alt-tabbed host is exactly when a dropped broker socket gets noticed.
  _brokerBeat() {
    const peer = this.peer;
    if (!peer || peer.destroyed) return;
    if (peer.open) {
      this.stuckBeats = 0;
      return;
    }
    if (this.beatsToRetry === null) {
      // A reconnect in flight normally ends in 'open' or 'disconnected'. If the socket
      // hangs instead, force the disconnect so the schedule keeps going.
      this.stuckBeats += 1;
      if (!peer.disconnected && this.stuckBeats >= BROKER_STUCK_BEATS) {
        this.stuckBeats = 0;
        peer.disconnect();
      }
      return;
    }
    this.beatsToRetry -= 1;
    if (this.beatsToRetry > 0) return;
    this.beatsToRetry = null;
    this.retryIndex += 1;
    if (peer.disconnected && !peer.destroyed) peer.reconnect();
  }

  // ---- remote peers -------------------------------------------------------------

  _onConnection(conn) {
    const now = performance.now();
    const r = { id: `p${this.nextRemote++}`, conn, open: false, greeted: false, lastRx: now, since: now, msgId: 0 };
    // Handlers go on before anything can return: PeerJS fires these from its own
    // callbacks, and a conn that fails negotiation never emits 'close'.
    conn.on('data', (data) => this._onRemoteData(r, data));
    conn.on('close', () => this._remoteGone(r));
    conn.on('error', () => this._remoteGone(r));
    conn.on('open', () => this._onRemoteOpen(r));
    let ungreeted = 0;
    for (const other of this.remotes.values()) if (!other.greeted) ungreeted += 1;
    if (conn.serialization !== 'raw' || this.remotes.size >= MAX_CONNS || ungreeted >= MAX_UNGREETED) {
      conn.close();
      return;
    }
    this.remotes.set(r.id, r);
  }

  _onRemoteOpen(r) {
    if (!this.remotes.has(r.id)) return;
    r.open = true;
    r.lastRx = performance.now();
    this.host.post({ op: 'open', id: r.id });
  }

  _onRemoteData(r, data) {
    if (!r.open || !this.remotes.has(r.id)) return;
    r.lastRx = performance.now();
    const binary = data instanceof ArrayBuffer;
    const size = binary ? data.byteLength : typeof data === 'string' ? data.length : Infinity;
    if (size > MAX_INBOUND_BYTES || (binary && size > 0 && new Uint8Array(data, 0, 1)[0] === BIN.CHUNK)) {
      this._dropRemote(r);
      return;
    }
    r.greeted = true;
    this.host.send(r.id, data);
  }

  // PeerJS closed it, or it never finished opening.
  _remoteGone(r) {
    if (!this.remotes.delete(r.id)) return;
    if (r.open) this.host.post({ op: 'close', id: r.id });
    else r.conn.close();
  }

  // We are ending it. No flush: the peer is hostile, silent or stuck.
  _dropRemote(r) {
    if (!this.remotes.delete(r.id)) return;
    r.conn.close();
    if (r.open) this.host.post({ op: 'close', id: r.id });
  }

  _onBeat() {
    this._brokerBeat();
    const now = performance.now();
    for (const r of this.remotes.values()) {
      if (r.open) {
        if (now - r.lastRx > SILENCE_LIMIT_MS || r.conn.peerConnection?.connectionState === 'failed') this._dropRemote(r);
      } else if (now - r.since > NEGOTIATE_LIMIT_MS) {
        this._dropRemote(r);
      }
    }
  }

  // ---- room -> wire ---------------------------------------------------------------

  _fromRoom(id, data) {
    if (id === LOCAL_CONN) {
      this.onmessage?.(data);
      return;
    }
    const r = this.remotes.get(id);
    if (r?.open) this._sendRemote(r, data);
  }

  _sendRemote(r, data) {
    const verdict = sendVerdict(data, r.conn.dataChannel?.bufferedAmount ?? 0);
    if (verdict === SEND.SKIP) return;
    if (verdict === SEND.KILL) {
      // The client reconnects and gets FULL; a queue this deep would only get staler.
      this._dropRemote(r);
      return;
    }
    let frames;
    try {
      frames = chunkMessage(data, r.msgId);
    } catch (err) {
      console.error('P2P host: unsendable message', err);
      this._dropRemote(r);
      return;
    }
    if (!frames) {
      r.conn.send(data);
      return;
    }
    r.msgId = (r.msgId + 1) & 0xffff;
    // One synchronous loop, so no other message can land between the frames.
    for (const frame of frames) r.conn.send(frame);
  }

  _closeFromRoom(id, reason) {
    if (id === LOCAL_CONN) {
      this._localGone(reason);
      return;
    }
    const r = this.remotes.get(id);
    if (!r) return;
    this.remotes.delete(id);
    closeWhenFlushed(r.conn);
  }

  // ---- ending -----------------------------------------------------------------------

  _localGone(reason) {
    if (this.gone) return;
    this.close();
    this.onclose?.(reason);
  }

  _sayGoodbye() {
    const bye = JSON.stringify({ t: MSG.CLOSED, reason: CLOSE.HOST_LEFT });
    for (const r of this.remotes.values()) {
      if (!r.open) continue;
      try {
        r.conn.send(bye);
      } catch {
        // That channel is already gone; the others still deserve the message.
      }
    }
  }

  // The page is going away, so nothing after this call can run. All of it is synchronous.
  _pageHide() {
    if (this.gone) return;
    this.gone = true;
    this._sayGoodbye();
    this.peer?.destroy();
    this.host?.terminate();
  }

  send(data) {
    this.host?.send(LOCAL_CONN, data);
  }

  close() {
    if (this.gone) return;
    this.gone = true;
    this.abortClaim?.();
    window.removeEventListener('pagehide', this.onPageHide);
    this._sayGoodbye();
    this.host?.terminate();
    this.host = null;
    const { peer } = this;
    this.peer = null;
    const conns = [...this.remotes.values()].map((r) => r.conn);
    this.remotes.clear();
    let waiting = conns.length;
    if (waiting === 0) {
      peer?.destroy();
      return;
    }
    for (const conn of conns) {
      closeWhenFlushed(conn, () => {
        waiting -= 1;
        if (waiting === 0) peer?.destroy();
      });
    }
  }
}
