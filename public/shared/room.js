// Fort Flurry Room: the lobby and the running Game. It knows nothing about sockets,
// so the same class runs in Node, in the solo worker and in the P2P host worker.
// Everything a conn sends is hostile until proven otherwise; liveness is the
// transports' job, not Room's.
import {
  TEAM_MODES,
  CLOSE, CMD, EMOTES, ERR, EV, LOBBY_OP, MODE, MSG, PROTOCOL_VERSION, TEAM,
} from './schema.js';
import {
  BOT_NAMES, DT, LOOK, MAX_INBOUND_BYTES, MAX_PLAYERS, RECONNECT_GRACE_S, SNAP_EVERY,
} from './constants.js';
import {
  DEFAULT_SETTINGS, decodeInput, encodeSnapshot, sanitizeChat, sanitizeLook, sanitizeName,
  sanitizeSettings,
} from './protocol.js';
import { Game } from './game.js';

const HELLO_TIMEOUT_MS = 5000;
const TICK_MS = DT * 1000;
const MAX_TICKS_PER_UPDATE = 5;
const META_EVERY_TICKS = 8;
const MALFORMED_LIMIT = 3;
const DISCARD_LIMIT = 300;
const DISCARD_WINDOW_MS = 10000;
const GRACE_MS = RECONNECT_GRACE_S * 1000;
const MAX_PLAYER_ID = 999;
const CELL_LIMIT = 4096;
const FALLBACK_NAME = 'Snowkid';
const LOCAL_CONN = 'local';

const RATE = Object.freeze({
  input: { perSec: 45, burst: 150 },
  cmd: { perSec: 20, burst: 40 },
  chat: { perSec: 2, burst: 4 },
  other: { perSec: 10, burst: 30 },
});

class Bucket {
  constructor({ perSec, burst }, now) {
    this.perSec = perSec;
    this.burst = burst;
    this.tokens = burst;
    this.at = now;
  }

  take(now) {
    const refill = (now - this.at) / 1000 * this.perSec;
    if (refill > 0) {
      this.tokens = Math.min(this.burst, this.tokens + refill);
      this.at = now;
    }
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

const isRecord = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isCell = (v) => Number.isInteger(v) && v >= -CELL_LIMIT && v <= CELL_LIMIT;

export class Room {
  constructor({ code, solo = false, onEmpty = null, log = null, now, randomHex, GameClass = Game }) {
    this.code = code;
    this.solo = solo;
    this.onEmpty = onEmpty;
    this.log = log;
    this.now = now;
    this.randomHex = randomHex;
    this.GameClass = GameClass;

    this.state = 'lobby';
    this.settings = { ...DEFAULT_SETTINGS };
    this.hostId = 0;
    this.conns = new Map();
    this.slots = new Map();
    this.kickedTokens = new Set();
    this.game = null;
    this.seed = null;
    this.resultSent = false;
    this.paused = false;
    this.destroyed = false;

    this.acc = 0;
    this.lastUpdate = null;
    this.joinCounter = 0;
    this.everHadHuman = false;
    this.emptySince = now();
    this.lastMeta = null;
    this.lastMetaJson = '';
    this.lastMetaTick = 0;
  }

  // ---- the host's interface ---------------------------------------------------

  addConn(conn) {
    if (this.destroyed) {
      conn.close(CLOSE.HOST_LEFT);
      return;
    }
    const now = this.now();
    this.conns.set(conn.id, {
      id: conn.id,
      conn,
      slot: null,
      openedAt: now,
      malformed: 0,
      discards: [],
      discardAt: 0,
      needsMatch: false,
      buckets: {
        input: new Bucket(RATE.input, now),
        cmd: new Bucket(RATE.cmd, now),
        chat: new Bucket(RATE.chat, now),
        other: new Bucket(RATE.other, now),
      },
    });
  }

  onData(connId, data) {
    const c = this.conns.get(connId);
    if (!c) return;
    try {
      this._receive(c, data);
    } catch (err) {
      // A sim bug a client can reach must cost that client, not the room: uncaught, this
      // would end every player's match in a worker and take a whole Node host down.
      this._log('message handler failed', err);
      this._malformed(c);
    }
  }

  _receive(c, data) {
    if (typeof data === 'string') {
      if (data.length > MAX_INBOUND_BYTES) return this._malformed(c);
      let msg;
      try {
        msg = JSON.parse(data);
      } catch {
        return this._malformed(c);
      }
      if (!isRecord(msg) || typeof msg.t !== 'string') return this._malformed(c);
      return this._onJson(c, msg);
    }
    if (data instanceof ArrayBuffer && data.byteLength <= MAX_INBOUND_BYTES) return this._onBinary(c, data);
    return this._malformed(c);
  }

  dropConn(connId) {
    const c = this.conns.get(connId);
    if (!c) return;
    this.conns.delete(connId);
    const slot = c.slot;
    if (!slot || slot.conn !== c) return;
    this._markDropped(slot, c);
  }

  update(nowMs = this.now()) {
    if (this.destroyed) return;
    this._housekeep(nowMs);
    if (this.destroyed) return;
    const elapsed = this.lastUpdate === null ? 0 : nowMs - this.lastUpdate;
    this.lastUpdate = nowMs;
    if (!this.game || this.paused) {
      this.acc = 0;
      return;
    }
    this.acc += Math.max(0, elapsed);
    let ticks = 0;
    while (this.acc >= TICK_MS && this.game) {
      this.acc -= TICK_MS;
      this._step();
      ticks += 1;
      if (ticks >= MAX_TICKS_PER_UPDATE) {
        // A stalled host must not fast-forward the match: the time is gone.
        this.acc = 0;
        break;
      }
    }
  }

  setPaused(on) {
    this.paused = !!on;
    this.acc = 0;
  }

  destroy(reason = CLOSE.HOST_LEFT) {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const c of this.conns.values()) {
      this._sendJson(c, { t: MSG.CLOSED, reason });
      this._close(c, reason);
    }
    this.conns.clear();
    this.slots.clear();
    this.game = null;
  }

  get humanCount() {
    let n = 0;
    for (const s of this.slots.values()) if (!s.isBot && s.conn) n += 1;
    return n;
  }

  // ---- inbound ------------------------------------------------------------------

  _onJson(c, msg) {
    if (!c.slot) {
      if (msg.t !== MSG.HELLO) return this._refuse(c, ERR.BAD_MSG, 'First message must be HELLO');
      return this._onHello(c, msg);
    }
    const now = this.now();
    switch (msg.t) {
      case MSG.CMD:
        return c.buckets.cmd.take(now) ? this._onCmd(c, msg) : this._discard(c);
      case MSG.CHAT:
        return c.buckets.chat.take(now) ? this._onChat(c, msg) : this._discard(c);
      case MSG.LOBBY:
        return c.buckets.other.take(now) ? this._onLobby(c, msg) : this._discard(c);
      case MSG.PING:
        return c.buckets.other.take(now) ? this._onPing(c, msg) : this._discard(c);
      case MSG.LEAVE:
        return c.buckets.other.take(now) ? this._onLeave(c) : this._discard(c);
      case MSG.HELLO:
        // A conn is already bound; a repeat changes nothing, it only spends budget.
        return c.buckets.other.take(now) ? undefined : this._discard(c);
      default:
        return this._malformed(c);
    }
  }

  _onBinary(c, buf) {
    if (!c.slot) return this._refuse(c, ERR.BAD_MSG, 'First message must be HELLO');
    const frame = decodeInput(buf);
    if (!frame) return this._malformed(c);
    if (!c.buckets.input.take(this.now())) return this._discard(c);
    if (this.game) this.game.queueInput(c.slot.id, frame);
  }

  _malformed(c) {
    if (!c.slot) return this._refuse(c, ERR.BAD_MSG, 'First message must be HELLO');
    c.malformed += 1;
    if (c.malformed < MALFORMED_LIMIT) return undefined;
    this._log('dropping conn: malformed traffic', c.id);
    return this._ejectConn(c, () => this._sendJson(c, { t: MSG.ERROR, code: ERR.BAD_MSG, msg: 'Bad messages' }), ERR.BAD_MSG);
  }

  _discard(c) {
    // A ring of the last 300 discard times: full and the oldest under 10 s old means
    // the conn crossed the limit, with no per-message allocation.
    const now = this.now();
    if (c.discards.length < DISCARD_LIMIT) {
      c.discards.push(now);
      if (c.discards.length < DISCARD_LIMIT) return;
    } else {
      c.discards[c.discardAt] = now;
      c.discardAt = (c.discardAt + 1) % DISCARD_LIMIT;
    }
    if (now - c.discards[c.discardAt] >= DISCARD_WINDOW_MS) return;
    this._log('dropping conn: rate', c.id);
    this._ejectConn(c, () => this._sendJson(c, { t: MSG.CLOSED, reason: CLOSE.RATE }), CLOSE.RATE);
  }

  _refuse(c, code, msg) {
    this._sendJson(c, { t: MSG.ERROR, code, msg });
    this._forget(c, code);
  }

  // Close a bound conn on Room's own initiative. Unbinding first keeps the transport's
  // later dropConn a no-op; the slot keeps its grace period like any other drop.
  _ejectConn(c, notify, reason) {
    notify();
    const slot = c.slot;
    this._forget(c, reason);
    if (slot && slot.conn === c) this._markDropped(slot, c);
  }

  _forget(c, reason) {
    this.conns.delete(c.id);
    this._close(c, reason);
  }

  _close(c, reason) {
    try {
      c.conn.close(reason);
    } catch (err) {
      this._log('close failed', err);
    }
  }

  // ---- joining ------------------------------------------------------------------

  _onHello(c, msg) {
    if (msg.v !== PROTOCOL_VERSION) return this._refuse(c, ERR.BAD_VERSION, 'Protocol version mismatch');
    const token = typeof msg.token === 'string' ? msg.token : null;
    if (token !== null && this.kickedTokens.has(token)) {
      this._sendJson(c, { t: MSG.KICKED });
      return this._forget(c, CLOSE.KICKED);
    }
    const slot = token === null ? undefined : this._slotByToken(token);
    if (slot) return this._reclaim(c, slot);
    return this._join(c, msg);
  }

  _slotByToken(token) {
    for (const s of this.slots.values()) if (s.token === token) return s;
    return undefined;
  }

  _join(c, msg) {
    if (this._humans().length >= MAX_PLAYERS) return this._refuse(c, ERR.ROOM_FULL, 'Room is full');
    if (this.slots.size >= MAX_PLAYERS) this._removeSlot(this._newestBot());
    const slot = this._makeSlot({
      name: sanitizeName(msg.name) || FALLBACK_NAME,
      look: sanitizeLook(msg.look),
      isBot: false,
      token: this.randomHex(16),
    });
    this._assignTeam(slot);
    this.slots.set(slot.id, slot);
    if (this.game) this.game.addPlayer(this._gamePlayer(slot));
    this._bind(c, slot);
    this._claimHost(slot, c);
    this._greet(c, slot);
  }

  _reclaim(c, slot) {
    const old = slot.conn;
    if (old && old !== c) {
      // _forget unregisters the conn before closing it, so a transport calling dropConn
      // from inside close() finds nothing and this never reads as the player dropping out.
      this._sendJson(old, { t: MSG.CLOSED, reason: CLOSE.REPLACED });
      this._forget(old, CLOSE.REPLACED);
    }
    this._bind(c, slot);
    if (this.game) {
      this.game.setAfk(slot.id, false);
      this.game.resetInput(slot.id);
    }
    this._greet(c, slot);
  }

  _bind(c, slot) {
    c.slot = slot;
    slot.conn = c;
    slot.droppedAt = null;
    this.everHadHuman = true;
    this.emptySince = null;
  }

  // A P2P room belongs to the browser hosting it. A joiner who gets its HELLO in first
  // must not take host rights from the local conn.
  _claimHost(slot, c) {
    if (this.hostId !== 0) return;
    const local = this.conns.get(LOCAL_CONN);
    if (local && local !== c) return;
    this.hostId = slot.id;
  }

  _greet(c, slot) {
    this._sendJson(c, { t: MSG.WELCOME, you: slot.id, token: slot.token, code: this.code, hostId: this.hostId });
    if (this.game) c.needsMatch = true;
    this._broadcastLobby();
  }

  // ---- slots ---------------------------------------------------------------------

  _makeSlot({ name, look, isBot, token, pick = null }) {
    this.joinCounter += 1;
    return {
      id: this._freeId(),
      name,
      look,
      isBot,
      token,
      team: TEAM.A,
      pick,
      ready: false,
      conn: null,
      droppedAt: null,
      order: this.joinCounter,
    };
  }

  _freeId() {
    for (let id = 1; id <= MAX_PLAYER_ID; id++) if (!this.slots.has(id)) return id;
    throw new RangeError('no free player id');
  }

  _humans() {
    return [...this.slots.values()].filter((s) => !s.isBot);
  }

  _newestBot() {
    let newest = null;
    for (const s of this.slots.values()) if (s.isBot && (!newest || s.order > newest.order)) newest = s;
    return newest;
  }

  _markDropped(slot, c) {
    slot.conn = null;
    slot.droppedAt = this.now();
    if (this.game) this.game.setAfk(slot.id, true);
    if (c.id === LOCAL_CONN && !this.solo) return this._hostGone();
    if (this.humanCount === 0) this.emptySince = this.now();
    this._broadcastLobby();
  }

  // The local conn leaving is the host's browser leaving: nobody can inherit a P2P room.
  _hostGone() {
    this.destroy(CLOSE.HOST_LEFT);
    if (this.onEmpty) this.onEmpty();
  }

  _removeSlot(slot) {
    this.slots.delete(slot.id);
    if (this.game) this.game.removePlayer(slot.id);
    if (slot.id !== this.hostId) return;
    const heirs = this._humans().sort((a, b) => (!!b.conn - !!a.conn) || a.order - b.order);
    this.hostId = heirs.length ? heirs[0].id : 0;
  }

  _gamePlayer(slot) {
    return { id: slot.id, name: slot.name, look: slot.look, team: slot.team, isBot: slot.isBot };
  }

  _assignTeam(slot) {
    if (this.settings.mode === MODE.FFA) {
      const used = new Set();
      for (const s of this.slots.values()) if (s !== slot) used.add(s.team);
      let n = 0;
      while (used.has(TEAM.FFA_BASE + n)) n += 1;
      slot.team = TEAM.FFA_BASE + n;
    } else if (TEAM_MODES.includes(this.settings.mode)) {
      if (slot.pick !== null) {
        slot.team = slot.pick;
        return;
      }
      let a = 0;
      let b = 0;
      for (const s of this.slots.values()) {
        if (s === slot) continue;
        if (s.team === TEAM.A) a += 1;
        else if (s.team === TEAM.B) b += 1;
      }
      slot.team = b < a ? TEAM.B : TEAM.A;
    } else {
      slot.team = TEAM.A;
    }
  }

  // Mode changes invalidate every team id. Walk in join order so an auto-balanced
  // roster comes out the same for everyone, and clear first so FFA slots repack from 0.
  _reassignTeams() {
    const slots = [...this.slots.values()].sort((a, b) => a.order - b.order);
    for (const s of slots) s.team = -1;
    for (const s of slots) if (s.pick !== null) this._assignTeam(s);
    for (const s of slots) if (s.pick === null) this._assignTeam(s);
  }

  _addBot(pick) {
    if (this.slots.size >= MAX_PLAYERS) return;
    const taken = new Set();
    for (const s of this.slots.values()) if (s.isBot) taken.add(s.name);
    const name = BOT_NAMES.find((n) => !taken.has(n)) || BOT_NAMES[0];
    const slot = this._makeSlot({ name, look: this._randomLook(), isBot: true, token: null, pick });
    this._assignTeam(slot);
    this.slots.set(slot.id, slot);
    this._broadcastLobby();
  }

  _randomLook() {
    const hex = this.randomHex(4);
    const byte = (i) => parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return {
      hat: byte(0) % LOOK.hat.length,
      coat: byte(1) % LOOK.coat.length,
      scarf: byte(2) % LOOK.scarf.length,
      skin: byte(3) % LOOK.skin.length,
    };
  }

  // ---- lobby ---------------------------------------------------------------------

  _onLobby(c, msg) {
    const slot = c.slot;
    const host = slot.id === this.hostId;
    const inLobby = this.state === 'lobby';
    switch (msg.op) {
      case LOBBY_OP.ME:
        return inLobby ? this._onMe(c, msg) : undefined;
      case LOBBY_OP.SET:
        if (!isRecord(msg.settings)) return this._malformed(c);
        if (!host || !inLobby) return undefined;
        this.settings = sanitizeSettings(msg.settings, this.settings);
        this._reassignTeams();
        return this._broadcastLobby();
      case LOBBY_OP.START:
        if (host && inLobby && this._canStart()) this._start();
        return undefined;
      case LOBBY_OP.KICK:
        if (!Number.isInteger(msg.id)) return this._malformed(c);
        return host ? this._kick(msg.id) : undefined;
      case LOBBY_OP.ADD_BOT: {
        if (msg.team !== undefined && !Number.isInteger(msg.team)) return this._malformed(c);
        if (!host || !inLobby) return undefined;
        const fortwars = TEAM_MODES.includes(this.settings.mode);
        return this._addBot(fortwars && (msg.team === TEAM.A || msg.team === TEAM.B) ? msg.team : null);
      }
      case LOBBY_OP.DEL_BOT: {
        if (!Number.isInteger(msg.id)) return this._malformed(c);
        if (!host || !inLobby) return undefined;
        const bot = this.slots.get(msg.id);
        if (!bot || !bot.isBot) return undefined;
        this._removeSlot(bot);
        return this._broadcastLobby();
      }
      case LOBBY_OP.RETURN:
        if (host && this.game && this.game.isOver()) this._returnToLobby();
        return undefined;
      default:
        return this._malformed(c);
    }
  }

  _onMe(c, msg) {
    const slot = c.slot;
    let changed = false;
    if (msg.name !== undefined) {
      const name = sanitizeName(msg.name);
      if (name && name !== slot.name) {
        slot.name = name;
        changed = true;
      }
    }
    if (msg.look !== undefined) {
      slot.look = sanitizeLook(msg.look);
      changed = true;
    }
    if (msg.ready !== undefined && !!msg.ready !== slot.ready) {
      slot.ready = !!msg.ready;
      changed = true;
    }
    if (TEAM_MODES.includes(this.settings.mode) && (msg.team === TEAM.A || msg.team === TEAM.B)) {
      slot.pick = msg.team;
      slot.team = msg.team;
      changed = true;
    }
    if (changed) this._broadcastLobby();
  }

  _kick(id) {
    const slot = this.slots.get(id);
    if (!slot || id === this.hostId) return;
    if (slot.token) this.kickedTokens.add(slot.token);
    const c = slot.conn;
    this._removeSlot(slot);
    if (c) {
      c.slot = null;
      this._sendJson(c, { t: MSG.KICKED });
      this._forget(c, CLOSE.KICKED);
    }
    this._broadcastLobby();
  }

  _onLeave(c) {
    const slot = c.slot;
    c.slot = null;
    slot.conn = null;
    this._forget(c, CLOSE.LEFT);
    if (c.id === LOCAL_CONN && !this.solo) return this._hostGone();
    this._removeSlot(slot);
    if (this.humanCount === 0) this.emptySince = this.now();
    this._broadcastLobby();
  }

  _onChat(c, msg) {
    if (typeof msg.text !== 'string') return this._malformed(c);
    const text = sanitizeChat(msg.text);
    if (!text) return;
    const line = JSON.stringify({ t: MSG.CHAT_MSG, id: c.slot.id, name: c.slot.name, text });
    for (const other of this.conns.values()) if (other.slot) this._send(other, line);
  }

  _onPing(c, msg) {
    if (typeof msg.c !== 'number' || !Number.isFinite(msg.c)) return this._malformed(c);
    this._sendJson(c, { t: MSG.PONG, c: msg.c, tick: this.game ? this.game.tick : 0 });
  }

  _onCmd(c, msg) {
    const clean = this._cleanCmd(msg);
    if (!clean) return this._malformed(c);
    if (this.game) this.game.command(c.slot.id, clean);
  }

  // Rebuilds the command from known fields only, so nothing a client invents ever
  // reaches the sim.
  _cleanCmd(msg) {
    switch (msg.c) {
      case CMD.BUILD:
        if (Number.isInteger(msg.k) && msg.k >= 0 && msg.k <= 255 && isCell(msg.cx) && isCell(msg.cy)) {
          return { c: CMD.BUILD, k: msg.k, cx: msg.cx, cy: msg.cy };
        }
        return null;
      case CMD.DEMOLISH:
        return isCell(msg.cx) && isCell(msg.cy) ? { c: CMD.DEMOLISH, cx: msg.cx, cy: msg.cy } : null;
      case CMD.CARD:
        return Number.isInteger(msg.i) && msg.i >= 0 && msg.i <= 255 ? { c: CMD.CARD, i: msg.i } : null;
      case CMD.READY:
        return { c: CMD.READY };
      case CMD.EMOTE:
        return Number.isInteger(msg.n) && msg.n >= 0 && msg.n < EMOTES.length ? { c: CMD.EMOTE, n: msg.n } : null;
      default:
        return null;
    }
  }

  // ---- match ---------------------------------------------------------------------

  _canStart() {
    const slots = [...this.slots.values()];
    if (this.settings.mode === MODE.FFA) return slots.length >= 2;
    if (TEAM_MODES.includes(this.settings.mode)) {
      return slots.some((s) => s.team === TEAM.A) && slots.some((s) => s.team === TEAM.B);
    }
    return slots.length >= 1;
  }

  _start() {
    this.seed = this.randomHex(16);
    const players = [...this.slots.values()].sort((a, b) => a.id - b.id).map((s) => this._gamePlayer(s));
    this.game = new this.GameClass({ ...this.settings, seed: this.seed, players });
    for (const s of this.slots.values()) if (!s.isBot && !s.conn) this.game.setAfk(s.id, true);
    this.state = 'playing';
    this.resultSent = false;
    this.acc = 0;
    this.lastUpdate = null;
    const meta = this.game.meta();
    this.lastMeta = meta;
    this.lastMetaJson = JSON.stringify(meta);
    this.lastMetaTick = this.game.tick;
    for (const c of this.conns.values()) if (c.slot) this._serveMatch(c);
  }

  _returnToLobby() {
    this.game = null;
    this.seed = null;
    this.state = 'lobby';
    this.resultSent = false;
    for (const s of this.slots.values()) s.ready = false;
    for (const c of this.conns.values()) c.needsMatch = false;
    this._broadcastLobby();
  }

  _step() {
    const g = this.game;
    g.step();
    if (g.tick % SNAP_EVERY === 0) this._flush(g);
  }

  // The only place game-stream messages leave Room, so a client always sees META, then
  // EVENTS, then the snapshot of one tick. A conn waiting for its match is served after
  // this flush, which is what makes FULL.tick equal the tick just flushed.
  _flush(g) {
    const tick = g.tick;
    const shared = [];
    const privateFor = new Map();
    for (const ev of g.drainEvents()) {
      if (ev.to === undefined) {
        shared.push(ev);
      } else {
        const list = privateFor.get(ev.to);
        if (list) list.push(ev);
        else privateFor.set(ev.to, [ev]);
      }
    }
    const metaMsg = this._metaIfDue(g, tick);
    const eventsMsg = shared.length ? JSON.stringify({ t: MSG.EVENTS, tick, ev: shared }) : null;
    const actors = g.actorsForSnapshot();
    const late = [];
    for (const c of this.conns.values()) {
      if (!c.slot) continue;
      if (c.needsMatch) {
        late.push(c);
        continue;
      }
      if (metaMsg) this._send(c, metaMsg);
      if (eventsMsg) this._send(c, eventsMsg);
      const mine = privateFor.get(c.slot.id);
      if (mine) this._sendJson(c, { t: MSG.EVENTS, tick, ev: mine });
      const id = c.slot.id;
      this._send(c, encodeSnapshot({ tick, ack: g.ackSeq(id), you: g.privateState(id), actors }));
    }
    for (const c of late) this._serveMatch(c);
    if (!this.resultSent && g.isOver()) {
      this.resultSent = true;
      const result = JSON.stringify({ t: MSG.RESULT, ...g.result() });
      for (const c of this.conns.values()) if (c.slot) this._send(c, result);
    }
  }

  _metaIfDue(g, tick) {
    const m = g.meta();
    const last = this.lastMeta;
    const urgent = !last || m.phase !== last.phase || m.wave !== last.wave || m.round !== last.round
      || m.truce !== last.truce || m.blizzard !== last.blizzard;
    if (!urgent && tick - this.lastMetaTick < META_EVERY_TICKS) return null;
    const json = JSON.stringify(m);
    if (!urgent && json === this.lastMetaJson) return null;
    this.lastMeta = m;
    this.lastMetaJson = json;
    this.lastMetaTick = tick;
    return `{"t":${JSON.stringify(MSG.META)},"tick":${tick},"m":${json}}`;
  }

  _serveMatch(c) {
    const g = this.game;
    const id = c.slot.id;
    c.needsMatch = false;
    this._send(c, this._lobbyJson());
    this._sendJson(c, {
      t: MSG.START, ...this.settings, seed: this.seed, tick: g.tick, players: this._players(),
    });
    const full = g.fullState(id);
    this._sendJson(c, { t: MSG.FULL, ...full });
    if (full.offer) {
      this._sendJson(c, { t: MSG.EVENTS, tick: g.tick, ev: [{ e: EV.PICK_OFFER, to: id, cards: full.offer, t: g.tick }] });
    }
    if (this.resultSent) this._sendJson(c, { t: MSG.RESULT, ...g.result() });
  }

  // ---- housekeeping --------------------------------------------------------------

  _housekeep(nowMs) {
    for (const c of this.conns.values()) {
      if (!c.slot && nowMs - c.openedAt > HELLO_TIMEOUT_MS) this._refuse(c, ERR.TIMEOUT, 'No HELLO');
    }
    let rosterChanged = false;
    for (const s of this.slots.values()) {
      if (s.droppedAt !== null && !s.isBot && nowMs - s.droppedAt >= GRACE_MS) {
        this._removeSlot(s);
        rosterChanged = true;
      }
    }
    if (rosterChanged) this._broadcastLobby();
    if (this.humanCount > 0) {
      this.emptySince = null;
      return;
    }
    if (this.emptySince === null) this.emptySince = nowMs;
    if ((this.solo && this.everHadHuman) || nowMs - this.emptySince >= GRACE_MS) {
      this.destroy(CLOSE.HOST_LEFT);
      if (this.onEmpty) this.onEmpty();
    }
  }

  // ---- outbound ------------------------------------------------------------------

  _players() {
    return [...this.slots.values()].sort((a, b) => a.id - b.id).map((s) => ({
      id: s.id,
      name: s.name,
      look: s.look,
      team: s.team,
      ready: s.ready,
      isBot: s.isBot,
      connected: s.isBot || s.conn !== null,
    }));
  }

  _lobbyJson() {
    return JSON.stringify({
      t: MSG.LOBBY_STATE,
      code: this.code,
      hostId: this.hostId,
      state: this.state,
      settings: this.settings,
      players: this._players(),
    });
  }

  _broadcastLobby() {
    if (this.destroyed) return;
    const json = this._lobbyJson();
    // A conn waiting for its match gets LOBBY_STATE as part of that service.
    for (const c of this.conns.values()) if (c.slot && !c.needsMatch) this._send(c, json);
  }

  _sendJson(c, obj) {
    this._send(c, JSON.stringify(obj));
  }

  _send(c, data) {
    try {
      c.conn.send(data);
    } catch (err) {
      this._log('send failed', err);
    }
  }

  _log(...args) {
    if (this.log) this.log(...args);
  }
}

