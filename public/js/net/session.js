// The client's view of a room: connection lifecycle, prediction, interpolation and the
// event stream. The sim stays authoritative; everything here exists to hide latency from
// the player without ever disagreeing with the host for long.
import {
  AFLAG, BALL, BIN, BTN, CLOSE, ERR, EV, MODE, MSG, PHASE, PICKUP, PROTOCOL_VERSION,
} from '../../shared/schema.js';
import {
  BUILD, DT, INTERP_TICKS, KID, MAX_UNACKED, RECONNECT_GRACE_S, SIM_HZ, SPECIAL, THROW,
} from '../../shared/constants.js';
import { decodeInput, decodeSnapshot, encodeInput } from '../../shared/protocol.js';
import { createCollisionWorld, stepKidMotion } from '../../shared/physics.js';
import { modsFromCards } from '../../shared/cards.js';
import { getMap } from '../../shared/maps.js';

const TAU = Math.PI * 2;
const MAX_DT = 0.1;
const MAX_FRAMES_PER_UPDATE = 3;
const RING_CAP = 32;
const SAMPLE_WINDOW_MS = 2000;
const SNAP_UNITS = 120;
const CORRECTION_RATE = 12;
const MAX_INTERP_TICKS = 12;
const INTERP_DRIFT_PER_TICK = 0.02;
const RESYNC_EST_TICKS = 15;
const MAX_EST_LEAD_TICKS = 15;

const PING_EVERY_MS = 2000;
const WATCHDOG_EVERY_MS = 500;
const HICCUP_MS = 4000;
const SILENCE_MS = 10000;
const VISIBLE_GRACE_MS = 3000;
const WELCOME_DEADLINE_MS = 10000;
const RETRY_DELAYS_MS = Object.freeze([500, 1000, 2000]);
const RETRY_EVERY_MS = 4000;
const RETRY_WINDOW_MS = (RECONNECT_GRACE_S - 5) * 1000;
const P2P_NO_ROOM_STRIKES = 3;

const UNREACHED_BALL_MS = 250;
const AIM_BUTTONS = BTN.THROW | BTN.LOB;
const FULL_POWER_CHARGE = 0.98;
const NO_SPECIAL = 255;

const systemClock = {
  now: () => performance.now(),
  wall: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (id) => clearInterval(id),
};

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

function lerpAngle(a, b, t) {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  else if (d < -Math.PI) d += TAU;
  return a + d * t;
}

function emptyView() {
  return {
    map: null, mapId: null, mode: null, phase: null, wave: 0, waveCount: 0, waveName: '', dayT: 0, blizzard: false,
    meta: null, renderTick: 0, secondsLeft: null, me: null, you: null, actors: [], balls: [], structs: [], pickups: [],
    players: new Map(), cw: null,
  };
}

// FULL and sAdd describe a struct with different key names, and the renderer wants one.
function structRecord(s, bornAt) {
  return {
    id: s.id,
    kind: s.k ?? s.kind,
    cx: s.cx,
    cy: s.cy,
    team: s.tm ?? s.team,
    hp: s.hp,
    maxHp: s.mhp ?? s.maxHp,
    ownerId: s.by ?? s.ownerId ?? 0,
    bornAt,
  };
}

function pickupRecord(p) {
  return { id: p.id, kind: p.k ?? p.kind, x: p.x, y: p.y };
}

// The closed form from SPEC section 7. n is ticks since launch and may be fractional.
// Position and radius are current; the velocities stay the launch values, which is how
// the renderer tells an arcing ball from a flat one for its landing reticle.
function ballAt(out, b, n) {
  out.x = b.x + b.vx * n * DT;
  out.y = b.y + b.vy * n * DT;
  out.z = Math.max(0, b.z + b.vz * n * DT - b.g * DT * DT * n * (n - 1) / 2);
  out.r = b.grow ? Math.min(b.rMax, b.r + b.grow * n * DT) : b.r;
  out.vx = b.vx;
  out.vy = b.vy;
  out.vz = b.vz;
  out.g = b.g;
  out.lx = b.lx;
  out.ly = b.ly;
  out.ft = b.ft;
}

export class Session {
  constructor(connect, { name, look, token = null, clock = systemClock } = {}) {
    this._connectFn = connect;
    this._name = name;
    this._look = look;
    this._clock = clock;

    this.token = token;
    this.me = 0;
    this.roomCode = null;
    this.lobby = null;
    this.inMatch = false;
    this.ping = 0;
    this.connected = false;
    this.reconnecting = false;
    this.netStatus = 'ok';
    this.result = null;
    this.offer = null;
    this.view = emptyView();

    this._handlers = new Map();
    this._t = null;
    this._dialing = null;
    this._hello = null;
    this._startPromise = null;
    this._welcomed = false;
    this._finished = false;
    this._hostId = 0;
    this._pingTimer = null;
    this._watchdogTimer = null;
    this._sleep = null;
    this._lastRx = 0;
    this._oldestPing = null;
    this._ignoreSilenceUntil = 0;
    this._background = false;

    this._seed = null;
    this._match = null;
    this._waitingFull = false;
    this._fullTick = -1;
    this._mods = modsFromCards([]);
    this._modsKey = '';

    this._ring = [];
    this._newest = null;
    this._newestTick = -1;
    this._snapDirty = false;
    this._samples = [];
    this._est = 0;
    this._delay = INTERP_TICKS;
    this._pool = new Map();

    this._input = { mx: 0, my: 0, aim: 0, tx: 0, ty: 0, btn: 0, pressed: 0 };
    this._acc = 0;
    this._seq = 0;
    this._pending = [];
    this._pred = null;
    this._offX = 0;
    this._offY = 0;
    this._snapMe = false;
    this._ackedCancelHeld = false;

    this._held = [];
    this._newestBanner = null;
    this._structs = new Map();
    this._pickups = new Map();
    this._balls = new Map();
    this._locals = [];
    this._nextLocalId = -1;
  }

  // ---- events ---------------------------------------------------------------------

  on(name, fn) {
    if (!this._handlers.has(name)) this._handlers.set(name, new Set());
    this._handlers.get(name).add(fn);
    return this;
  }

  off(name, fn) {
    this._handlers.get(name)?.delete(fn);
    return this;
  }

  _emit(name, arg) {
    const set = this._handlers.get(name);
    if (!set) return;
    for (const fn of [...set]) {
      try {
        fn(arg);
      } catch (err) {
        // A bug in a renderer callback must not corrupt the netcode's state machine.
        console.error(`Session '${name}' handler failed`, err);
      }
    }
  }

  // ---- public surface ---------------------------------------------------------------

  get isHost() {
    return (this.lobby ? this.lobby.hostId : this._hostId) === this.me && this.me !== 0;
  }

  get transport() {
    return this._t;
  }

  setPaused(on) {
    this._t?.setPaused?.(on);
  }

  start() {
    if (!this._startPromise) {
      this._startPromise = this._dial(null).catch((err) => {
        this._finish(null);
        throw err;
      });
    }
    return this._startPromise;
  }

  lobbyOp(op, data = {}) {
    this._sendJson({ ...data, t: MSG.LOBBY, op });
  }

  chat(text) {
    this._sendJson({ t: MSG.CHAT, text });
  }

  cmd(c, data = {}) {
    this._sendJson({ ...data, t: MSG.CMD, c });
  }

  setFrameInput(frame) {
    const i = this._input;
    i.mx = frame.mx;
    i.my = frame.my;
    i.aim = frame.aim;
    i.tx = frame.tx;
    i.ty = frame.ty;
    i.btn = frame.btn;
    // A tap can start and end between two fixed steps; ORing keeps it alive until one runs.
    i.pressed |= frame.btn;
  }

  leave() {
    if (this._finished) return;
    this._sendJson({ t: MSG.LEAVE });
    this._hello?.reject({ code: CLOSE.LEFT, msg: 'Cancelled' });
    this._finish(CLOSE.LEFT);
  }

  setBackground(on) {
    const hidden = !!on;
    if (hidden === this._background) return;
    this._background = hidden;
    if (hidden) this._enterBackground();
    else this._leaveBackground();
  }

  // ---- connection ---------------------------------------------------------------------

  _sendJson(obj) {
    this._t?.send(JSON.stringify(obj));
  }

  // One connect + HELLO. Resolves on WELCOME. Handlers go on before connect() because a
  // server may answer the socket opening with an ERROR before we ever say HELLO.
  async _dial(maxMs) {
    const t = this._connectFn(this.roomCode ?? undefined);
    this._dialing = t;
    const welcome = new Promise((resolve, reject) => {
      this._hello = { resolve, reject };
    });
    welcome.catch(() => {});
    t.onmessage = (data) => this._onMessage(t, data);
    t.onclose = (reason) => this._onTransportClose(t, reason);
    const timers = [];
    const giveUpAfter = (ms, msg) => {
      timers.push(this._clock.setTimeout(() => this._hello?.reject({ code: ERR.TIMEOUT, msg }), ms));
    };
    if (maxMs !== null) giveUpAfter(maxMs, 'Out of time');
    try {
      const connecting = Promise.resolve().then(() => t.connect());
      connecting.catch(() => {});
      await Promise.race([connecting, welcome]);
      if (this._finished) throw { code: CLOSE.LEFT, msg: 'Cancelled' };
      t.send(JSON.stringify({
        t: MSG.HELLO, v: PROTOCOL_VERSION, name: this._name, look: this._look, ...(this.token ? { token: this.token } : {}),
      }));
      giveUpAfter(WELCOME_DEADLINE_MS, 'No answer from the room');
      await welcome;
    } catch (err) {
      t.onmessage = null;
      t.onclose = null;
      t.close();
      throw { code: err?.code ?? ERR.NET, msg: err?.msg ?? String(err?.message ?? err) };
    } finally {
      for (const timer of timers) this._clock.clearTimeout(timer);
      this._dialing = null;
      this._hello = null;
    }
  }

  _onWelcome(t, msg) {
    this._t = t;
    this.me = msg.you;
    this.token = msg.token;
    this.roomCode = msg.code;
    this._hostId = msg.hostId;
    this.connected = true;
    this._lastRx = this._clock.now();
    this._oldestPing = null;
    // A new connection is a new input stream on the host, so seq restarts and anything
    // still unacked belongs to a stream that no longer exists.
    this._seq = 0;
    this._pending.length = 0;
    this._ackedCancelHeld = false;
    this._acc = 0;
    // Mid-match, nothing is trustworthy until FULL lands right after the next flush.
    this._waitingFull = this.inMatch;
    if (t.kind === 'p2pHost') {
      this.netStatus = t.netStatus;
      t.onstatus = (status) => {
        this.netStatus = status;
      };
    } else {
      this.netStatus = 'ok';
    }
    if (!this._welcomed) {
      this._welcomed = true;
      this._pingTimer = this._clock.setInterval(() => this._sendPing(), PING_EVERY_MS);
      this._watchdogTimer = this._clock.setInterval(() => this._watchdog(), WATCHDOG_EVERY_MS);
    }
    this._sendPing();
    this._hello?.resolve();
  }

  _onTransportClose(t, reason) {
    if (this._finished) return;
    if (t === this._dialing && t !== this._t) {
      this._hello?.reject({ code: ERR.NET, msg: `Connection closed: ${reason}` });
      return;
    }
    if (t === this._t) this._onLost();
  }

  _onLost() {
    const t = this._t;
    this._t = null;
    if (t) {
      t.onmessage = null;
      t.onclose = null;
      t.close();
    }
    this.connected = false;
    if (t?.kind === 'local' || t?.kind === 'p2pHost') {
      this._finish(CLOSE.NET_LOST);
      return;
    }
    this._reconnect(t?.kind === 'p2p');
  }

  async _reconnect(p2p) {
    if (this.reconnecting || this._finished) return;
    this.reconnecting = true;
    this.netStatus = 'reconnecting';
    const startedAt = this._clock.now();
    const until = this._clock.wall() + RETRY_WINDOW_MS;
    this._emit('reconnecting', { attempt: 0, until });
    let attempt = 0;
    let noRoomStrikes = 0;
    for (;;) {
      await this._wait(RETRY_DELAYS_MS[attempt] ?? RETRY_EVERY_MS);
      if (this._finished) return;
      const left = RETRY_WINDOW_MS - (this._clock.now() - startedAt);
      if (left <= 0) {
        this._finish(CLOSE.NET_LOST);
        return;
      }
      attempt += 1;
      this._emit('reconnecting', { attempt, until });
      try {
        await this._dial(left);
      } catch (err) {
        if (this._finished) return;
        if (err.code === CLOSE.KICKED) {
          this._finish(CLOSE.KICKED);
          return;
        }
        if (err.code === ERR.ROOM_FULL || err.code === ERR.BAD_VERSION) {
          this._finish(CLOSE.NET_LOST);
          return;
        }
        // A P2P host whose broker link is blinking also reads as "no such peer", so
        // only repeated answers mean the room is really gone.
        noRoomStrikes = err.code === ERR.NO_ROOM ? noRoomStrikes + 1 : 0;
        if (noRoomStrikes >= (p2p ? P2P_NO_ROOM_STRIKES : 1)) {
          this._finish(CLOSE.HOST_LEFT);
          return;
        }
        continue;
      }
      // The link can die in the same tick as its WELCOME. _onLost was a no-op then, since
      // this loop was still running, so only this check keeps the retries going.
      if (!this._t) continue;
      this.reconnecting = false;
      this.netStatus = 'ok';
      this._emit('reconnected');
      return;
    }
  }

  _wait(ms) {
    return new Promise((resolve) => {
      const timer = this._clock.setTimeout(() => {
        this._sleep = null;
        resolve();
      }, ms);
      this._sleep = { timer, resolve };
    });
  }

  // `reason` null means start() failed: no WELCOME ever happened, so no 'closed' either.
  _finish(reason) {
    if (this._finished) return;
    this._finished = true;
    this._clock.clearInterval(this._pingTimer);
    this._clock.clearInterval(this._watchdogTimer);
    if (this._sleep) {
      this._clock.clearTimeout(this._sleep.timer);
      this._sleep.resolve();
      this._sleep = null;
    }
    for (const t of [this._t, this._dialing]) {
      if (!t) continue;
      t.onmessage = null;
      t.onclose = null;
      t.close();
    }
    this._t = null;
    this.connected = false;
    this.reconnecting = false;
    this.inMatch = false;
    if (reason !== null && this._welcomed) this._emit('closed', { reason });
  }

  // ---- liveness -------------------------------------------------------------------------

  _sendPing() {
    if (!this._t) return;
    const now = this._clock.now();
    if (this._oldestPing === null) this._oldestPing = now;
    this._sendJson({ t: MSG.PING, c: Math.round(now * 1000) / 1000 });
  }

  _onPong(msg) {
    const rtt = this._clock.now() - msg.c;
    this._oldestPing = null;
    if (rtt >= 0) this.ping = this.ping === 0 ? rtt : this.ping * 0.7 + rtt * 0.3;
  }

  _watchdog() {
    const t = this._t;
    if (!t || t.kind === 'local' || t.kind === 'p2pHost') return;
    const now = this._clock.now();
    if (now < this._ignoreSilenceUntil) return;
    if (this.inMatch) {
      const silent = now - this._lastRx;
      if (silent >= SILENCE_MS) {
        this._onLost();
      } else if (silent >= HICCUP_MS) {
        this.connected = false;
        this.netStatus = 'hiccup';
      }
    } else if (this._oldestPing !== null && now - this._oldestPing >= SILENCE_MS) {
      this._onLost();
    }
  }

  // ---- inbound --------------------------------------------------------------------------

  _onMessage(t, data) {
    if (this._finished) return;
    if (t !== this._t && t !== this._dialing) return;
    this._lastRx = this._clock.now();
    if (!this.connected && t === this._t) {
      this.connected = true;
      this.netStatus = 'ok';
    }
    if (typeof data !== 'string') {
      if (data instanceof ArrayBuffer && data.byteLength > 0 && new Uint8Array(data, 0, 1)[0] === BIN.SNAPSHOT) this._onSnapshot(data);
      return;
    }
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    switch (msg?.t) {
      case MSG.WELCOME: this._onWelcome(t, msg); break;
      case MSG.ERROR: this._onError(msg); break;
      case MSG.KICKED: this._onKicked(); break;
      case MSG.CLOSED: this._finish(Object.values(CLOSE).includes(msg.reason) ? msg.reason : CLOSE.NET_LOST); break;
      case MSG.LOBBY_STATE: this._onLobbyState(msg); break;
      case MSG.START: this._onStart(msg); break;
      case MSG.FULL: this._onFull(msg); break;
      case MSG.META: this._applyMeta(msg.m); break;
      case MSG.EVENTS: this._onEvents(msg); break;
      case MSG.RESULT: this._onResult(msg); break;
      case MSG.CHAT_MSG: this._emit('chat', msg); break;
      case MSG.PONG: this._onPong(msg); break;
      default: break;
    }
  }

  _onError(msg) {
    const err = { code: msg.code, msg: msg.msg };
    if (this._hello) this._hello.reject(err);
    else this._emit('error', err);
  }

  _onKicked() {
    if (this._hello) this._hello.reject({ code: CLOSE.KICKED, msg: 'Removed by the host' });
    else this._finish(CLOSE.KICKED);
  }

  _onResult(msg) {
    const { t, ...result } = msg;
    this.result = result;
    this._emit('result', result);
  }

  _onLobbyState(msg) {
    this.lobby = msg;
    this._rebuildPlayers(msg.players);
    if (msg.state === 'lobby' && this.inMatch) this._endMatch();
    this._emit('lobby', msg);
  }

  _rebuildPlayers(list) {
    const players = this.view.players;
    players.clear();
    for (const p of list) {
      players.set(p.id, { id: p.id, name: p.name, look: p.look, team: p.team, isBot: p.isBot, connected: p.connected });
    }
  }

  _endMatch() {
    const v = this.view;
    this.inMatch = false;
    this._waitingFull = false;
    this.result = null;
    this.offer = null;
    this._seed = null;
    this._match = null;
    this._resetStream();
    v.me = null;
    v.you = null;
    v.actors.length = 0;
    v.balls.length = 0;
    v.structs.length = 0;
    v.pickups.length = 0;
  }

  _resetStream() {
    this._held.length = 0;
    this._pending.length = 0;
    this._balls.clear();
    this._locals.length = 0;
    this._ring.length = 0;
    this._samples.length = 0;
    this._newest = null;
    this._snapDirty = false;
    this._pred = null;
    this._offX = 0;
    this._offY = 0;
    this._ackedCancelHeld = false;
    this._newestBanner = null;
  }

  _onStart(msg) {
    this._match = msg;
    this._rebuildPlayers(msg.players);
    this._waitingFull = true;
  }

  _onFull(msg) {
    const start = this._match;
    if (!start) return;
    const v = this.view;
    const resync = start.seed === this._seed;
    this._seed = start.seed;
    this._resetStream();
    this._structs.clear();
    this._pickups.clear();
    v.structs.length = 0;
    v.pickups.length = 0;

    v.mode = start.mode;
    v.mapId = start.mapId;
    v.waveCount = start.waveCount;
    v.map = getMap(start.mapId);
    v.cw = createCollisionWorld(v.map);
    for (const s of msg.structs) {
      const rec = structRecord(s, 0);
      this._structs.set(rec.id, rec);
      v.structs.push(rec);
      this._cwAdd(rec.kind, rec.cx, rec.cy);
    }
    for (const p of msg.pickups) {
      const rec = pickupRecord(p);
      this._pickups.set(rec.id, rec);
      v.pickups.push(rec);
    }
    for (const b of msg.balls) this._balls.set(b.id, b);

    this._fullTick = msg.tick;
    this._newestTick = msg.tick;
    this._est = msg.tick;
    this._delay = INTERP_TICKS;
    v.renderTick = msg.tick;
    this.offer = null;
    // A resync keeps the old actors on screen until the next snapshot, a flush away.
    if (!resync) {
      this.result = null;
      v.me = null;
      v.you = null;
      v.actors.length = 0;
    }
    this._waitingFull = false;
    this.inMatch = true;
    this._applyMeta(msg.meta);
    if (!resync) this._emit('start');
  }

  _cwAdd(kind, cx, cy) {
    const b = BUILD[kind];
    if (b) this.view.cw.setStruct(cx, cy, b.solid, b.size || 1, b.height);
  }

  _cwRemove(kind, cx, cy) {
    this.view.cw.clearStruct(cx, cy, BUILD[kind]?.size || 1);
  }

  _applyMeta(m) {
    if (!m) return;
    const v = this.view;
    v.meta = m;
    v.phase = m.phase;
    v.wave = m.wave;
    v.waveCount = m.waveCount;
    v.waveName = m.waveName;
    v.dayT = m.dayT;
    v.blizzard = m.blizzard;
    if (v.cw) v.cw.truce = m.truce ? { ...v.map.truce, active: true } : null;
    const cards = m.cards?.[this.me] ?? [];
    const speed = m.speedMul ?? 1;
    const key = `${cards.join()}|${speed}`;
    if (key !== this._modsKey) {
      this._modsKey = key;
      const base = modsFromCards(cards);
      // Classic speeds every kid up each round, so prediction must move as fast as the host.
      this._mods = speed === 1 ? base : { ...base, speedMul: base.speedMul * speed, throwSpeedMul: base.throwSpeedMul * speed };
      if (this._pred) this._pred.mods = this._mods;
      if (v.you) v.you.mods = this._mods;
    }
    this._emit('meta', m);
  }

  _onSnapshot(buf) {
    if (!this.inMatch || this._waitingFull) return;
    const s = decodeSnapshot(buf);
    if (!s || s.tick <= this._newestTick) return;
    s.byId = new Map();
    for (const a of s.actors) s.byId.set(a.id, a);
    if (this._ring.length >= RING_CAP) this._ring.shift();
    this._ring.push(s);
    this._newest = s;
    this._newestTick = s.tick;
    this._snapDirty = true;
    if (s.you) {
      s.you.mods = this._mods;
      this.view.you = s.you;
    } else {
      this.view.you = null;
    }
    const now = this._clock.now();
    const samples = this._samples;
    samples.push({ at: now, off: s.tick - now * SIM_HZ / 1000 });
    while (samples.length > 1 && now - samples[0].at > SAMPLE_WINDOW_MS) samples.shift();
  }

  // ---- events ---------------------------------------------------------------------------

  _onEvents(msg) {
    // Before FULL there is no world to apply them to, and FULL supersedes them anyway.
    if (!this.inMatch || this._waitingFull) return;
    for (const ev of msg.ev) {
      if (ev.to !== undefined) {
        // Private events have no place on the render timeline, and a pending offer is
        // stamped with FULL's own tick, so they skip the hold and the staleness check.
        if (ev.e === EV.PICK_OFFER) this.offer = ev.cards;
        if (!this._background) this._emit('fx', ev);
      } else if (ev.t > this._fullTick) {
        this._arrive(ev);
      }
    }
  }

  _arrive(ev) {
    switch (ev.e) {
      case EV.S_ADD:
        this._cwAdd(ev.k, ev.cx, ev.cy);
        break;
      case EV.S_DEL:
        this._cwRemove(ev.k, ev.cx, ev.cy);
        break;
      case EV.RESPAWN:
        if (ev.id === this.me) this._snapMe = true;
        break;
      case EV.THROW:
        if (ev.id === this.me) return;
        break;
      case EV.BALL:
        if (ev.by === this.me && this._linkBall(ev)) return;
        break;
      case EV.BALL_END: {
        const local = this._locals.find((l) => l.serverId === ev.id);
        if (local) local.endT = ev.t;
        break;
      }
      default:
        break;
    }
    if (this._background) this._applyHidden(ev);
    else this._held.push(ev);
  }

  _showEvents() {
    const held = this._held;
    const rt = this.view.renderTick;
    let n = 0;
    while (n < held.length && held[n].t <= rt) {
      const ev = held[n];
      n += 1;
      if (this._applyState(ev)) this._emit('fx', ev);
    }
    if (n > 0) held.splice(0, n);
  }

  // Returns false for an update about something the client does not know, which also
  // means there is nothing to show for it.
  _applyState(ev) {
    const v = this.view;
    switch (ev.e) {
      case EV.S_ADD: {
        const old = this._structs.get(ev.id);
        if (old) {
          Object.assign(old, structRecord(ev, old.bornAt));
        } else {
          const rec = structRecord(ev, ev.t);
          this._structs.set(rec.id, rec);
          v.structs.push(rec);
        }
        return true;
      }
      case EV.S_HP: {
        const s = this._structs.get(ev.id);
        if (!s) return false;
        s.hp = ev.hp;
        return true;
      }
      case EV.S_DEL: {
        const s = this._structs.get(ev.id);
        if (!s) return false;
        this._structs.delete(ev.id);
        v.structs.splice(v.structs.indexOf(s), 1);
        return true;
      }
      case EV.P_ADD: {
        const old = this._pickups.get(ev.id);
        if (old) {
          Object.assign(old, pickupRecord(ev));
        } else {
          const rec = pickupRecord(ev);
          this._pickups.set(rec.id, rec);
          v.pickups.push(rec);
        }
        return true;
      }
      case EV.P_DEL: {
        const p = this._pickups.get(ev.id);
        if (!p) return false;
        this._pickups.delete(ev.id);
        v.pickups.splice(v.pickups.indexOf(p), 1);
        return true;
      }
      case EV.BALL:
        this._balls.set(ev.id, ev);
        return true;
      case EV.BALL_END: {
        const i = this._locals.findIndex((l) => l.serverId === ev.id);
        if (i >= 0) {
          this._locals.splice(i, 1);
          return true;
        }
        return this._balls.delete(ev.id);
      }
      case EV.CARD:
        if (ev.id === this.me) this.offer = null;
        return true;
      default:
        return true;
    }
  }

  // ---- background -------------------------------------------------------------------------

  _applyHidden(ev) {
    if (ev.e === EV.BANNER) this._newestBanner = ev;
    else this._applyState(ev);
  }

  _enterBackground() {
    for (const ev of this._held) this._applyHidden(ev);
    this._held.length = 0;
    this._pending.length = 0;
    this._locals.length = 0;
    this._input.btn = 0;
    this._input.pressed = 0;
    this._input.mx = 0;
    this._input.my = 0;
    this._acc = 0;
  }

  _leaveBackground() {
    const now = this._clock.now();
    const v = this.view;
    this._ignoreSilenceUntil = now + VISIBLE_GRACE_MS;
    if (!this.inMatch) return;
    if (this._newest) {
      v.renderTick = Math.max(v.renderTick, this._newestTick - this._delay);
      this._est = Math.max(this._est, this._newestTick);
      this._snapDirty = true;
    }
    this._pred = null;
    this._offX = 0;
    this._offY = 0;
    for (const [id, b] of this._balls) {
      const n = v.renderTick - b.t;
      const landed = b.ft > 0 ? n >= b.ft : b.g > 0 && b.z + b.vz * n * DT - b.g * DT * DT * n * (n - 1) / 2 <= 0;
      if (landed) this._balls.delete(id);
    }
    if (this._newestBanner) {
      this._emit('fx', this._newestBanner);
      this._newestBanner = null;
    }
  }

  // ---- the frame --------------------------------------------------------------------------

  update(dtSeconds) {
    if (!this.inMatch) return;
    const dt = clamp(Number.isFinite(dtSeconds) ? dtSeconds : 0, 0, MAX_DT);
    const now = this._clock.now();
    this._advanceClock(dt, now);
    const v = this.view;
    if (!this._background) {
      this._reconcile();
      this._runInput(dt);
      const keep = Math.exp(-CORRECTION_RATE * dt);
      this._offX *= keep;
      this._offY *= keep;
      this._showEvents();
      this._composeActors();
      this._composeBalls(now);
    }
    const ends = v.meta?.endsAtTick;
    v.secondsLeft = ends === null || ends === undefined ? null : Math.max(0, (ends - v.renderTick) / SIM_HZ);
  }

  // Tick estimate from SPEC 8.4. The largest offset is the sample that was delayed least,
  // so it is the best guess at the host's real clock.
  _advanceClock(dt, now) {
    const samples = this._samples;
    if (samples.length === 0) return;
    let hi = -Infinity;
    let lo = Infinity;
    for (const s of samples) {
      if (s.off > hi) hi = s.off;
      if (s.off < lo) lo = s.off;
    }
    const target = now * SIM_HZ / 1000 + hi;
    const err = target - this._est;
    const before = this._est;
    if (err > RESYNC_EST_TICKS) this._est = target;
    else this._est += dt * SIM_HZ * clamp(1 + err * 0.1, 0, 1.25);
    // During a host pause wall time runs on while ticks do not. An estimate left to follow
    // the clock ends up as far ahead as the pause was long, and since it may only wait, not
    // reverse, renderTick would sit on the newest snapshot for just as long afterwards.
    this._est = Math.max(before, Math.min(this._est, this._newestTick + MAX_EST_LEAD_TICKS));
    const want = clamp(INTERP_TICKS + 2 * (hi - lo), INTERP_TICKS, MAX_INTERP_TICKS);
    const drift = INTERP_DRIFT_PER_TICK * dt * SIM_HZ;
    this._delay += clamp(want - this._delay, -drift, drift);
    const v = this.view;
    v.renderTick = Math.max(v.renderTick, Math.min(this._est - this._delay, this._newestTick));
  }

  // ---- prediction ---------------------------------------------------------------------------

  _reconcile() {
    if (!this._snapDirty) return;
    this._snapDirty = false;
    const s = this._newest;
    const actor = s.byId.get(this.me);
    const you = s.you;
    if (!actor || !you) {
      this._pred = null;
      this._pending.length = 0;
      this._offX = 0;
      this._offY = 0;
      return;
    }
    const before = this._pred;
    const shownX = before ? before.x + this._offX : actor.x;
    const shownY = before ? before.y + this._offY : actor.y;
    const p = before ?? { r: KID.radius };
    p.x = actor.x;
    p.y = actor.y;
    p.vx = actor.vx;
    p.vy = actor.vy;
    p.flags = actor.flags;
    p.slideT = you.slideT;
    p.slideCd = you.slideCd;
    p.boardT = you.boardT;
    p.slowT = you.slowT;
    p.stunT = you.stunT;
    p.prevBtn = you.prevBtn;
    p.mods = this._mods;
    p.balls = you.balls;
    p.throwCd = you.throwCd;
    p.special = you.special;
    p.specialN = you.specialN;
    p.armed = actor.flags & AFLAG.CHARGING ? BTN.THROW : actor.flags & AFLAG.LOBAIM ? BTN.LOB : 0;
    p.charge = p.armed === BTN.THROW ? actor.aux / 255 : 0;
    this._pred = p;
    const pending = this._pending;
    let acked = 0;
    while (acked < pending.length && pending[acked].seq <= s.ack) acked += 1;
    if (acked > 0) {
      // The cancel latch is not on the wire, but it is a pure function of the frames.
      this._ackedCancelHeld = pending[acked - 1].cancelHeld;
      pending.splice(0, acked);
    }
    p.cancelHeld = this._ackedCancelHeld;
    for (const f of pending) this._predict(p, f, false);
    this._offX = shownX - p.x;
    this._offY = shownY - p.y;
    if (this._snapMe || Math.hypot(this._offX, this._offY) > SNAP_UNITS) {
      this._snapMe = false;
      this._offX = 0;
      this._offY = 0;
    }
  }

  _runInput(dt) {
    this._acc += dt;
    let frames = 0;
    while (this._acc >= DT && frames < MAX_FRAMES_PER_UPDATE) {
      this._acc -= DT;
      frames += 1;
      this._fixedStep();
    }
    if (this._acc >= DT) this._acc = 0;
  }

  _fixedStep() {
    const i = this._input;
    const btn = i.btn | i.pressed;
    i.pressed = 0;
    const p = this._pred;
    if (!p || !this._t || this._waitingFull || this._pending.length >= MAX_UNACKED) return;
    const wire = encodeInput({ seq: this._seq + 1, mx: i.mx, my: i.my, aim: i.aim, btn, tx: i.tx, ty: i.ty });
    // Exactly what the host will decode, so a replay can land on exactly what it computes.
    const frame = decodeInput(wire);
    this._seq = frame.seq;
    this._pending.push(frame);
    this._t.send(wire);
    this._predict(p, frame, true);
  }

  _predict(p, frame, live) {
    stepKidMotion(p, frame, this.view.cw, DT);
    this._predictThrow(p, frame, live);
    frame.cancelHeld = p.cancelHeld;
  }

  // The host's throw rules, step for step, far enough to know a ball leaves on this frame.
  // It only decides when to show one early; the host's `ball` event is what counts.
  _predictThrow(p, frame, live) {
    const { btn } = frame;
    const v = this.view;
    if (p.throwCd > 0) p.throwCd = Math.max(0, p.throwCd - DT);
    const open = v.phase === PHASE.FIGHT || (v.phase === PHASE.BUILD && v.mode === MODE.SIEGE);
    if (p.flags & (AFLAG.FROZEN | AFLAG.LOCKED) || !open) {
      p.armed = 0;
      p.charge = 0;
      return;
    }
    if (btn & BTN.CANCEL) {
      p.armed = 0;
      p.charge = 0;
      p.cancelHeld = (btn & AIM_BUTTONS) !== 0;
      return;
    }
    if (!(btn & AIM_BUTTONS)) p.cancelHeld = false;
    if (p.armed === BTN.THROW) {
      if (btn & BTN.THROW) {
        p.charge = Math.min(1, p.charge + DT / THROW.chargeTime);
      } else {
        this._releaseThrow(p, frame, live);
        p.armed = 0;
        p.charge = 0;
      }
    } else if (p.armed === BTN.LOB && !(btn & BTN.LOB)) {
      this._releaseLob(p, frame, live);
      p.armed = 0;
    }
    if (p.armed === 0 && btn & AIM_BUTTONS && !p.cancelHeld) {
      p.armed = btn & BTN.THROW ? BTN.THROW : BTN.LOB;
      p.charge = 0;
    }
  }

  _releaseThrow(p, frame, live) {
    if (p.throwCd > 0 || p.balls < 1) return;
    p.balls -= 1;
    p.throwCd = THROW.cooldown;
    const { special } = p;
    if (special !== NO_SPECIAL) {
      p.specialN -= 1;
      if (p.specialN <= 0) p.special = NO_SPECIAL;
    }
    if (!live) return;
    const c = p.charge;
    const { quick, power } = THROW;
    const speed = (quick.speed + (power.speed - quick.speed) * c) * this._mods.throwSpeedMul;
    const flight = Math.max(2, Math.round((quick.flight + (power.flight - quick.flight) * c) / DT));
    if (special === PICKUP.GIANT) {
      const giant = SPECIAL[PICKUP.GIANT];
      const fast = giant.speed * this._mods.throwSpeedMul;
      this._spawnLocal(p, frame, {
        kind: giant.ball, z: 0, vx: Math.cos(frame.aim) * fast, vy: Math.sin(frame.aim) * fast, vz: 0, g: 0, r: giant.r0,
        grow: giant.grow, rMax: giant.r1, flight: giant.life, lx: 0, ly: 0, ft: 0,
      }, false, true);
      return;
    }
    const kind = special === PICKUP.ICE || special === PICKUP.SLUSH ? SPECIAL[special].ball : c >= FULL_POWER_CHARGE ? BALL.POWER : BALL.QUICK;
    // The order the host spawns them in, because linking is by order.
    const spread = special === PICKUP.TRIPLE ? SPECIAL[PICKUP.TRIPLE].spread : 0;
    const angles = spread > 0 ? [frame.aim, frame.aim - spread, frame.aim + spread] : [frame.aim];
    angles.forEach((angle, i) => {
      this._spawnLocal(p, frame, {
        kind, z: THROW.z0, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed, vz: 0,
        g: 2 * THROW.z0 / (DT * DT * flight * (flight - 1)), r: THROW.radius, grow: 0, rMax: THROW.radius,
        flight: flight * DT, lx: 0, ly: 0, ft: 0,
      }, false, i === 0);
    });
  }

  _releaseLob(p, frame, live) {
    const { lob } = THROW;
    if (p.throwCd > 0 || p.balls < lob.cost) return;
    p.balls -= lob.cost;
    p.throwCd = lob.cooldown;
    if (!live) return;
    let dx = frame.tx - p.x;
    let dy = frame.ty - p.y;
    const reach = Math.hypot(dx, dy);
    if (reach > lob.maxRange) {
      dx *= lob.maxRange / reach;
      dy *= lob.maxRange / reach;
    }
    const { map } = this.view;
    const tx = clamp(p.x + dx, 0, map.w);
    const ty = clamp(p.y + dy, 0, map.h);
    dx = tx - p.x;
    dy = ty - p.y;
    const ticks = Math.max(2, Math.round((lob.minFlight + Math.hypot(dx, dy) * lob.flightPerUnit) / DT));
    const seconds = ticks * DT;
    this._spawnLocal(p, frame, {
      kind: BALL.LOB, z: THROW.z0, vx: dx / seconds, vy: dy / seconds,
      vz: (lob.gravity * DT * DT * ticks * (ticks - 1) / 2 - THROW.z0) / seconds, g: lob.gravity, r: THROW.radius, grow: 0,
      rMax: THROW.radius, flight: seconds, lx: tx, ly: ty, ft: ticks,
    }, true, true);
  }

  _spawnLocal(p, frame, b, lob, announce) {
    const id = this._nextLocalId;
    this._nextLocalId -= 1;
    const L = this.ping / 1000 + this._delay * DT;
    const local = {
      ...b, id, seq: frame.seq, x: p.x, y: p.y, born: this._clock.now(), L, F: Math.max(0.8 * b.flight, L / 0.7),
      serverId: null, evT: 0, endT: null,
    };
    this._locals.push(local);
    const t = this._est;
    if (announce) this._emit('fx', { e: EV.THROW, id: this.me, lob, t });
    this._emit('fx', {
      e: EV.BALL, id, k: b.kind, by: this.me, tm: this.view.me?.team ?? 0, x: local.x, y: local.y, z: b.z, vx: b.vx,
      vy: b.vy, vz: b.vz, g: b.g, r: b.r, grow: b.grow, rMax: b.rMax, seq: frame.seq, lx: b.lx, ly: b.ly, ft: b.ft, t,
    });
  }

  // An own `ball` event takes the oldest unlinked local ball at or before its input
  // frame. Returns false when prediction never showed this throw, and then the event
  // plays like anyone else's.
  _linkBall(ev) {
    const l = this._locals.find((b) => b.serverId === null && b.seq <= ev.seq);
    if (!l) return false;
    const a = (this._clock.now() - l.born) / 1000;
    l.serverId = ev.id;
    l.evT = ev.t;
    l.kind = ev.k;
    l.x = ev.x;
    l.y = ev.y;
    l.z = ev.z;
    l.vx = ev.vx;
    l.vy = ev.vy;
    l.vz = ev.vz;
    l.g = ev.g;
    l.r = ev.r;
    l.grow = ev.grow;
    l.rMax = ev.rMax;
    l.lx = ev.lx;
    l.ly = ev.ly;
    l.ft = ev.ft;
    if (ev.ft > 0) l.flight = ev.ft * DT;
    l.L = a + (ev.t - this.view.renderTick) * DT;
    l.F = Math.max(0.8 * l.flight, l.L / 0.7);
    return true;
  }

  // ---- composing the view ---------------------------------------------------------------------

  _composeActors() {
    const v = this.view;
    const ring = this._ring;
    if (ring.length === 0) return;
    const rt = v.renderTick;
    let i = ring.length - 1;
    while (i > 0 && ring[i].tick > rt) i -= 1;
    const older = ring[i];
    const newer = ring[i + 1] ?? older;
    const alpha = newer === older || rt <= older.tick ? (newer === older ? 1 : 0) : (rt - older.tick) / (newer.tick - older.tick);

    const out = v.actors;
    let n = 0;
    for (const b of newer.actors) {
      if (b.id === this.me) continue;
      const o = this._pooled(b.id);
      const a = older.byId.get(b.id);
      if (a && Math.hypot(b.x - a.x, b.y - a.y) <= SNAP_UNITS) {
        o.x = a.x + (b.x - a.x) * alpha;
        o.y = a.y + (b.y - a.y) * alpha;
        o.aim = lerpAngle(a.aim, b.aim, alpha);
      } else {
        o.x = b.x;
        o.y = b.y;
        o.aim = b.aim;
      }
      o.vx = b.vx;
      o.vy = b.vy;
      o.kind = b.kind;
      o.team = b.team;
      o.hp = b.hp;
      o.flags = b.flags;
      o.aux = b.aux;
      out[n] = o;
      n += 1;
    }
    const mine = this._newest?.byId.get(this.me);
    if (mine) {
      const o = this._pooled(this.me);
      const p = this._pred;
      o.x = p ? p.x + this._offX : mine.x;
      o.y = p ? p.y + this._offY : mine.y;
      o.vx = p ? p.vx : mine.vx;
      o.vy = p ? p.vy : mine.vy;
      o.aim = p ? this._input.aim : mine.aim;
      o.kind = mine.kind;
      o.team = mine.team;
      o.hp = mine.hp;
      o.flags = mine.flags;
      o.aux = mine.aux;
      out[n] = o;
      n += 1;
      v.me = o;
    } else {
      v.me = null;
    }
    out.length = n;
    if (this._pool.size > n * 2 + 16) {
      const live = new Set(out);
      for (const [id, o] of this._pool) if (!live.has(o)) this._pool.delete(id);
    }
  }

  _pooled(id) {
    let o = this._pool.get(id);
    if (!o) {
      o = { id };
      this._pool.set(id, o);
    }
    return o;
  }

  _composeBalls(now) {
    const v = this.view;
    const out = v.balls;
    let n = 0;
    const slot = () => {
      const o = out[n] ?? (out[n] = {});
      n += 1;
      return o;
    };
    for (const b of this._balls.values()) {
      const age = v.renderTick - b.t;
      if (age < 0) continue;
      const o = slot();
      ballAt(o, b, age);
      o.id = b.id;
      o.kind = b.k;
      o.mine = b.by === this.me;
    }
    const locals = this._locals;
    const expiry = 2 * this.ping + UNREACHED_BALL_MS;
    for (let i = locals.length - 1; i >= 0; i--) {
      if (locals[i].serverId === null && now - locals[i].born > expiry) locals.splice(i, 1);
    }
    for (const l of locals) {
      const a = (now - l.born) / 1000;
      // Starts slow and catches up, so the ball leaves the hand now yet lands on host time.
      let age = a - l.L * Math.min(1, a / l.F);
      if (l.endT !== null) age = Math.min(age, (l.endT - l.evT) * DT);
      const o = slot();
      ballAt(o, l, Math.max(0, age) / DT);
      o.id = l.serverId ?? l.id;
      o.kind = l.kind;
      o.mine = true;
    }
    out.length = n;
  }
}
