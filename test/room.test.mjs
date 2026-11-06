import test from 'node:test';
import assert from 'node:assert/strict';
import { Room } from '../public/shared/room.js';
import { decodeSnapshot, encodeInput } from '../public/shared/protocol.js';
import { BIN, CLOSE, CMD, ERR, EV, LOBBY_OP, MODE, MSG, PHASE, PROTOCOL_VERSION, STRUCT, TEAM } from '../public/shared/schema.js';
import { BOT_NAMES, DT, LOOK, MAX_INBOUND_BYTES, MAX_PLAYERS, RECONNECT_GRACE_S, SNAP_EVERY } from '../public/shared/constants.js';
import { FakeGame } from './fixtures/fake-game.js';

const TICK_MS = DT * 1000;
let hexCounter = 0;
const randomHex = (bytes) => {
  hexCounter += 1;
  return hexCounter.toString(16).padStart(bytes * 2, '0').slice(-bytes * 2);
};

class Conn {
  constructor(id) {
    this.id = id;
    this.sent = [];
    this.closed = null;
    this.closeCount = 0;
    this.onCloseHook = null;
  }

  send(data) {
    if (this.closed === null) this.sent.push(data);
  }

  close(reason) {
    this.closed = reason;
    this.closeCount += 1;
    if (this.onCloseHook) this.onCloseHook();
  }

  jsons(type) {
    const all = this.sent.filter((m) => typeof m === 'string').map((m) => JSON.parse(m));
    return type === undefined ? all : all.filter((m) => m.t === type);
  }

  last(type) {
    return this.jsons(type).at(-1);
  }

  snapshots() {
    return this.sent.filter((m) => m instanceof ArrayBuffer).map(decodeSnapshot);
  }

  // A compact trace of the stream, for order assertions.
  kinds() {
    return this.sent.map((m) => (typeof m === 'string' ? JSON.parse(m).t : 'snap'));
  }

  clear() {
    this.sent = [];
  }
}

function setup(opts = {}) {
  const clock = { t: 1000 };
  const emptied = [];
  const room = new Room({
    code: 'BCDF',
    now: () => clock.t,
    randomHex,
    GameClass: FakeGame,
    onEmpty: () => emptied.push(clock.t),
    ...opts,
  });
  let nextId = 1;
  const connect = (id = nextId++) => {
    const c = new Conn(id);
    room.addConn(c);
    return c;
  };
  const hello = (c, extra = {}) => room.onData(c.id, JSON.stringify({ t: MSG.HELLO, v: PROTOCOL_VERSION, name: `Kid${c.id}`, look: {}, ...extra }));
  const join = (extra) => {
    const c = connect();
    hello(c, extra);
    return c;
  };
  const lobby = (c, op, data = {}) => room.onData(c.id, JSON.stringify({ t: MSG.LOBBY, op, ...data }));
  const cmd = (c, name, data = {}) => room.onData(c.id, JSON.stringify({ t: MSG.CMD, c: name, ...data }));
  // Advance by whole ticks through the real accumulator; +0.5 ms absorbs float dust.
  const ticks = (n) => {
    for (let i = 0; i < n; i++) {
      clock.t += TICK_MS;
      room.update(clock.t + 0.0001);
    }
  };
  const flushNow = () => {
    while (FakeGame.last.tick % SNAP_EVERY !== SNAP_EVERY - 1) ticks(1);
    ticks(1);
  };
  const advance = (ms) => {
    clock.t += ms;
    room.update(clock.t);
  };
  return { room, clock, connect, hello, join, lobby, cmd, ticks, flushNow, advance, emptied };
}

function startedMatch(n = 2) {
  const s = setup();
  const conns = Array.from({ length: n }, () => s.join());
  s.lobby(conns[0], LOBBY_OP.START);
  s.room.update(s.clock.t);
  conns.forEach((c) => c.clear());
  return { ...s, conns, g: FakeGame.last };
}

// ---- joining ---------------------------------------------------------------------

test('HELLO gets WELCOME with id, token, code and hostId, then LOBBY_STATE', () => {
  const { join } = setup();
  const a = join({ name: 'Ada' });
  assert.deepEqual(a.kinds(), [MSG.WELCOME, MSG.LOBBY_STATE]);
  const w = a.last(MSG.WELCOME);
  assert.equal(w.you, 1);
  assert.equal(w.code, 'BCDF');
  assert.equal(w.hostId, 1);
  assert.match(w.token, /^[0-9a-f]{32}$/);
  const l = a.last(MSG.LOBBY_STATE);
  assert.equal(l.state, 'lobby');
  assert.equal(l.hostId, 1);
  assert.deepEqual(Object.keys(l.players[0]).sort(), ['connected', 'id', 'isBot', 'look', 'name', 'ready', 'team']);
  assert.equal(l.players[0].name, 'Ada');
});

test('names and looks are sanitized on the way in, with a usable fallback', () => {
  const { join } = setup();
  const a = join({ name: '   ', look: { hat: 99, coat: -4, scarf: 'x', skin: null } });
  const p = a.last(MSG.LOBBY_STATE).players[0];
  assert.ok(p.name.length > 0);
  assert.equal(p.look.hat, LOOK.hat.length - 1);
  assert.equal(p.look.coat, 0);
});

test('tokens never appear in a lobby broadcast', () => {
  const { join } = setup();
  const a = join();
  const b = join();
  const token = b.last(MSG.WELCOME).token;
  assert.ok(!a.sent.join('').includes(token));
});

test('a first message other than HELLO drops the conn', () => {
  for (const first of [JSON.stringify({ t: MSG.PING, c: 1 }), 'garbage', encodeInput({ seq: 1, mx: 0, my: 0, aim: 0, btn: 0, tx: 0, ty: 0 })]) {
    const { connect, room } = setup();
    const c = connect();
    room.onData(c.id, first);
    assert.ok(c.closed !== null, 'closed');
    assert.equal(c.last(MSG.ERROR).code, ERR.BAD_MSG);
    assert.equal(room.conns.size, 0);
  }
});

test('a bad protocol version is refused with an error and no slot', () => {
  const { connect, hello, room } = setup();
  const c = connect();
  hello(c, { v: PROTOCOL_VERSION + 1 });
  assert.equal(c.last(MSG.ERROR).code, ERR.BAD_VERSION);
  assert.ok(c.closed !== null);
  assert.equal(room.slots.size, 0);
});

test('a conn with no HELLO is closed after 5 s, not before', () => {
  const { connect, advance, room } = setup();
  const c = connect();
  advance(4999);
  assert.equal(c.closed, null);
  advance(2);
  assert.ok(c.closed !== null);
  assert.equal(room.conns.size, 0);
});

test('Room never drops a bound conn for silence', () => {
  const { join, advance } = setup();
  const a = join();
  for (let i = 0; i < 100; i++) advance(1000);
  assert.equal(a.closed, null);
});

test('player ids are the lowest free, bots included, and survive reconnect', () => {
  const { join, lobby, room } = setup();
  const a = join();
  const b = join();
  lobby(a, LOBBY_OP.ADD_BOT);
  const c = join();
  assert.equal(c.last(MSG.WELCOME).you, 4);
  room.onData(b.id, JSON.stringify({ t: MSG.LEAVE }));
  const d = join();
  assert.equal(d.last(MSG.WELCOME).you, 2);
});

// ---- lobby ops and host rights -----------------------------------------------------

test('LOBBY set is host only, partial and sanitized', () => {
  const { join, lobby, room } = setup();
  const a = join();
  const b = join();
  lobby(b, LOBBY_OP.SET, { settings: { mapId: 'pond' } });
  assert.equal(room.settings.mapId, 'court');
  lobby(a, LOBBY_OP.SET, { settings: { mapId: 'pond', waveCount: 5, junk: 1 } });
  assert.deepEqual(room.settings, { mode: MODE.SIEGE, mapId: 'pond', difficulty: 'normal', waveCount: 5 });
  assert.equal(b.last(MSG.LOBBY_STATE).settings.mapId, 'pond');
  lobby(a, LOBBY_OP.SET, { settings: { mapId: 'moon', waveCount: 3 } });
  assert.equal(room.settings.mapId, 'pond');
  assert.equal(room.settings.waveCount, 5);
});

test('LOBBY me updates name, look and the ready check mark', () => {
  const { join, lobby } = setup();
  const a = join();
  lobby(a, LOBBY_OP.ME, { name: ' Bea ', look: { hat: 2 }, ready: true });
  const p = a.last(MSG.LOBBY_STATE).players[0];
  assert.equal(p.name, 'Bea');
  assert.equal(p.look.hat, 2);
  assert.equal(p.ready, true);
  lobby(a, LOBBY_OP.ME, { name: '   ' });
  assert.equal(a.last(MSG.LOBBY_STATE).players[0].name, 'Bea', 'an empty rename is ignored');
});

test('every host-only op is ignored from a non-host', () => {
  const { join, lobby, room } = setup();
  const a = join();
  const b = join();
  lobby(a, LOBBY_OP.ADD_BOT);
  const before = a.sent.length;
  lobby(b, LOBBY_OP.ADD_BOT);
  lobby(b, LOBBY_OP.DEL_BOT, { id: 3 });
  lobby(b, LOBBY_OP.KICK, { id: 1 });
  lobby(b, LOBBY_OP.START);
  lobby(b, LOBBY_OP.SET, { settings: { mode: MODE.FFA } });
  lobby(b, LOBBY_OP.RETURN);
  assert.equal(room.slots.size, 3);
  assert.equal(room.state, 'lobby');
  assert.equal(room.settings.mode, MODE.SIEGE);
  assert.equal(a.sent.length, before);
  assert.equal(b.closed, null, 'trying is not grounds for a drop');
});

test('bots get a random look and the first unused name; the host removes them', () => {
  const { join, lobby, room } = setup();
  const a = join();
  lobby(a, LOBBY_OP.ADD_BOT);
  lobby(a, LOBBY_OP.ADD_BOT);
  const players = a.last(MSG.LOBBY_STATE).players;
  assert.deepEqual(players.filter((p) => p.isBot).map((p) => p.name), [BOT_NAMES[0], BOT_NAMES[1]]);
  assert.ok(players[1].connected, 'bots always read as connected');
  lobby(a, LOBBY_OP.DEL_BOT, { id: 2 });
  lobby(a, LOBBY_OP.ADD_BOT);
  assert.equal(a.last(MSG.LOBBY_STATE).players.find((p) => p.id === 2).name, BOT_NAMES[0]);
  lobby(a, LOBBY_OP.DEL_BOT, { id: 1 });
  assert.equal(room.slots.size, 3, 'DEL_BOT never removes a human');
});

test('the room holds at most 8 kids', () => {
  const { join, lobby, room } = setup();
  const a = join();
  for (let i = 0; i < 12; i++) lobby(a, LOBBY_OP.ADD_BOT);
  assert.equal(room.slots.size, MAX_PLAYERS);
});

test('a joining human replaces the newest bot when the room holds 8 kids', () => {
  const { join, lobby, room } = setup();
  const a = join();
  for (let i = 0; i < 7; i++) lobby(a, LOBBY_OP.ADD_BOT);
  lobby(a, LOBBY_OP.DEL_BOT, { id: 3 });
  lobby(a, LOBBY_OP.ADD_BOT); // id 3 again, and now the newest despite the lower id
  const b = join();
  assert.equal(b.last(MSG.WELCOME).you, 3);
  assert.equal(room.slots.size, MAX_PLAYERS);
  const players = a.last(MSG.LOBBY_STATE).players;
  assert.equal(players.filter((p) => p.isBot).length, 6);
  assert.equal(players.find((p) => p.id === 3).isBot, false);
});

test('roomFull means 8 humans, even if some are mid-reconnect', () => {
  const { join, connect, hello, room } = setup();
  const humans = Array.from({ length: 8 }, () => join());
  room.dropConn(humans[3].id);
  const c = connect();
  hello(c);
  assert.equal(c.last(MSG.ERROR).code, ERR.ROOM_FULL);
  assert.ok(c.closed !== null);
});

test('a human replaces a bot during a match too, through the Game', () => {
  const { join, lobby, room, clock } = setup();
  const a = join();
  for (let i = 0; i < 7; i++) lobby(a, LOBBY_OP.ADD_BOT);
  lobby(a, LOBBY_OP.START);
  room.update(clock.t);
  const g = FakeGame.last;
  const b = join();
  const names = g.calls.map((c) => c[0]);
  assert.ok(names.indexOf('removePlayer') < names.indexOf('addPlayer'));
  assert.equal(g.calls.find((c) => c[0] === 'removePlayer')[1], 8);
  assert.equal(g.calls.find((c) => c[0] === 'addPlayer')[1].id, b.last(MSG.WELCOME).you);
});

// ---- teams -------------------------------------------------------------------------

test('Siege puts everyone on TEAM.A', () => {
  const { join, lobby, room } = setup();
  const a = join();
  join();
  lobby(a, LOBBY_OP.ADD_BOT);
  lobby(a, LOBBY_OP.ME, { team: TEAM.B });
  for (const s of room.slots.values()) assert.equal(s.team, TEAM.A);
});

test('Face-Off auto-balances, honors a pick, and resolves bots', () => {
  const { join, lobby, room } = setup();
  const a = join();
  lobby(a, LOBBY_OP.SET, { settings: { mode: MODE.FORTWARS } });
  const b = join();
  const c = join();
  const d = join();
  const teams = () => [...room.slots.values()].map((s) => s.team);
  assert.deepEqual(teams().sort(), [TEAM.A, TEAM.A, TEAM.B, TEAM.B]);
  lobby(c, LOBBY_OP.ME, { team: TEAM.B });
  assert.equal(room.slots.get(3).team, TEAM.B);
  lobby(b, LOBBY_OP.ME, { team: 7 });
  assert.notEqual(room.slots.get(2).team, 7, 'only real teams are accepted');
  lobby(a, LOBBY_OP.ADD_BOT, { team: TEAM.B });
  assert.equal(room.slots.get(5).team, TEAM.B);
  assert.ok(d.closed === null);
});

test('switching mode re-resolves every team', () => {
  const { join, lobby, room } = setup();
  const a = join();
  join();
  join();
  lobby(a, LOBBY_OP.SET, { settings: { mode: MODE.FORTWARS } });
  assert.deepEqual([...room.slots.values()].map((s) => s.team), [TEAM.A, TEAM.B, TEAM.A]);
  lobby(a, LOBBY_OP.SET, { settings: { mode: MODE.FFA } });
  assert.deepEqual([...room.slots.values()].map((s) => s.team), [TEAM.FFA_BASE, TEAM.FFA_BASE + 1, TEAM.FFA_BASE + 2]);
  lobby(a, LOBBY_OP.SET, { settings: { mode: MODE.SIEGE } });
  assert.deepEqual([...room.slots.values()].map((s) => s.team), [TEAM.A, TEAM.A, TEAM.A]);
});

test('FFA teams take the lowest free slot', () => {
  const { join, lobby, room } = setup();
  const a = join();
  lobby(a, LOBBY_OP.SET, { settings: { mode: MODE.FFA } });
  const b = join();
  join();
  room.onData(b.id, JSON.stringify({ t: MSG.LEAVE }));
  join();
  assert.deepEqual([...room.slots.values()].map((s) => s.team).sort((x, y) => x - y), [TEAM.FFA_BASE, TEAM.FFA_BASE + 1, TEAM.FFA_BASE + 2]);
});

test('Room resolves team before the Game hears about a late joiner', () => {
  const { join, lobby, room, clock } = setup();
  const a = join();
  lobby(a, LOBBY_OP.SET, { settings: { mode: MODE.FORTWARS } });
  join();
  join();
  lobby(a, LOBBY_OP.START);
  room.update(clock.t);
  join();
  assert.equal(FakeGame.last.calls.find((c) => c[0] === 'addPlayer')[1].team, TEAM.B);
});

// ---- start -------------------------------------------------------------------------

test('auto-balanced teams shown in the lobby do not move at Start', () => {
  const { join, lobby, room } = setup();
  const a = join();
  lobby(a, LOBBY_OP.SET, { settings: { mode: MODE.FORTWARS } });
  const b = join();
  const c = join();
  room.onData(b.id, JSON.stringify({ t: MSG.LEAVE }));
  join();
  const shown = a.last(MSG.LOBBY_STATE).players.map((p) => [p.id, p.team]);
  lobby(a, LOBBY_OP.START);
  assert.equal(room.state, 'playing');
  assert.deepEqual(FakeGame.last.opts.players.map((p) => [p.id, p.team]), shown);
  assert.equal(c.closed, null);
});

test('Start needs a kid on each team in Face-Off and 2 kids in FFA', () => {
  const s = setup();
  const a = s.join();
  s.lobby(a, LOBBY_OP.SET, { settings: { mode: MODE.FORTWARS } });
  s.lobby(a, LOBBY_OP.START);
  assert.equal(s.room.state, 'lobby');
  s.lobby(a, LOBBY_OP.SET, { settings: { mode: MODE.FFA } });
  s.lobby(a, LOBBY_OP.START);
  assert.equal(s.room.state, 'lobby');
  s.lobby(a, LOBBY_OP.ADD_BOT);
  s.lobby(a, LOBBY_OP.START);
  assert.equal(s.room.state, 'playing');
});

test('the host can always start a one-kid Siege, ready or not', () => {
  const { join, lobby, room } = setup();
  const a = join();
  join();
  lobby(a, LOBBY_OP.START);
  assert.equal(room.state, 'playing');
});

test('START is immediately followed by FULL and carries seed and roster', () => {
  const { join, lobby } = setup();
  const a = join();
  lobby(a, LOBBY_OP.ADD_BOT);
  a.clear();
  lobby(a, LOBBY_OP.START);
  assert.deepEqual(a.kinds(), [MSG.LOBBY_STATE, MSG.START, MSG.FULL]);
  const s = a.last(MSG.START);
  assert.match(s.seed, /^[0-9a-f]{32}$/);
  assert.equal(s.mode, MODE.SIEGE);
  assert.equal(s.mapId, 'court');
  assert.equal(s.players.length, 2);
  assert.deepEqual(Object.keys(s.players[0]).sort(), ['connected', 'id', 'isBot', 'look', 'name', 'ready', 'team']);
  assert.equal(a.last(MSG.LOBBY_STATE).state, 'playing');
  assert.equal(a.last(MSG.FULL).tick, FakeGame.last.tick);
  assert.deepEqual(Object.keys(FakeGame.last.opts).sort(), ['difficulty', 'mapId', 'mode', 'players', 'seed', 'waveCount']);
});

test('a human still in their grace period starts the match AFK', () => {
  const { join, lobby, room } = setup();
  const a = join();
  const b = join();
  room.dropConn(b.id);
  lobby(a, LOBBY_OP.START);
  assert.deepEqual(FakeGame.last.calls.filter((c) => c[0] === 'setAfk'), [['setAfk', 2, true]]);
});

// ---- flush -------------------------------------------------------------------------

test('flush order per conn is META, EVENTS, then the snapshot', () => {
  const { conns, g, ticks, flushNow } = startedMatch(1);
  const [a] = conns;
  g.phase = PHASE.FIGHT;
  g.emit({ e: EV.BANNER, text: 'Go', sub: '', kind: 'wave' });
  flushNow();
  assert.deepEqual(a.kinds(), [MSG.META, MSG.EVENTS, 'snap']);
  a.clear();
  ticks(SNAP_EVERY);
  assert.deepEqual(a.kinds(), ['snap'], 'nothing due, nothing sent but the snapshot');
});

test('game-stream messages never leave between flushes', () => {
  const { conns, g, ticks, room, clock } = startedMatch(1);
  const [a] = conns;
  ticks(SNAP_EVERY - (g.tick % SNAP_EVERY));
  a.clear();
  g.emit({ e: EV.BANNER, text: 'Mid', sub: '', kind: 'info' });
  g.phase = PHASE.FIGHT;
  clock.t += TICK_MS;
  room.update(clock.t + 0.0001);
  assert.notEqual(g.tick % SNAP_EVERY, 0);
  assert.deepEqual(a.kinds(), []);
  ticks(1);
  assert.deepEqual(a.kinds(), [MSG.META, MSG.EVENTS, 'snap']);
});

test('snapshots carry the flushed tick and each conn gets its own buffer', () => {
  const { conns, g, flushNow } = startedMatch(2);
  flushNow();
  const [a, b] = conns;
  const bufA = a.sent.at(-1);
  const bufB = b.sent.at(-1);
  assert.notEqual(bufA, bufB, 'a shared buffer would be detached by the first transfer');
  assert.equal(decodeSnapshot(bufA).tick, g.tick);
  assert.equal(new Uint8Array(bufA)[0], BIN.SNAPSHOT);
});

test('META goes out at once on phase, wave, round, truce or blizzard changes', () => {
  for (const change of [
    (g) => { g.phase = PHASE.FIGHT; }, (g) => { g.wave = 2; }, (g) => { g.round = 2; }, (g) => { g.truce = true; }, (g) => { g.blizzard = true; },
  ]) {
    const { conns, g, ticks, flushNow } = startedMatch(1);
    ticks(SNAP_EVERY * 2);
    conns[0].clear();
    change(g);
    flushNow();
    assert.deepEqual(conns[0].kinds(), [MSG.META, 'snap'], String(change));
    assert.equal(conns[0].last(MSG.META).tick, g.tick);
  }
});

test('other META changes wait for 8 ticks since the last one, and only if something changed', () => {
  const { conns, g, ticks } = startedMatch(1);
  const [a] = conns;
  ticks(20);
  assert.equal(a.jsons(MSG.META).length, 0, 'nothing changed');
  g.flakes = 30;
  ticks(2);
  assert.equal(a.jsons(MSG.META).length, 1, 'quiet for long enough, so it goes on the next flush');
  a.clear();
  g.flakes = 31;
  ticks(6);
  assert.equal(a.jsons(MSG.META).length, 0, 'too soon');
  ticks(2);
  assert.equal(a.jsons(MSG.META).length, 1);
});

test('private events go only to their owner, in their own EVENTS message', () => {
  const { conns, g, flushNow } = startedMatch(2);
  const [a, b] = conns;
  g.emit({ e: EV.BANNER, text: 'All', sub: '', kind: 'info' });
  g.offer(2, ['x', 'y', 'z']);
  flushNow();
  assert.deepEqual(a.jsons(MSG.EVENTS).map((m) => m.ev.map((e) => e.e)), [[EV.BANNER]]);
  assert.deepEqual(b.jsons(MSG.EVENTS).map((m) => m.ev.map((e) => e.e)), [[EV.BANNER], [EV.PICK_OFFER]]);
  assert.deepEqual(b.kinds(), [MSG.EVENTS, MSG.EVENTS, 'snap']);
  assert.ok(!a.sent.filter((m) => typeof m === 'string').join('').includes('"offer"'));
});

test('private events for an offline player are dropped', () => {
  const { conns, g, flushNow, room } = startedMatch(2);
  const [a, b] = conns;
  room.dropConn(b.id);
  b.clear();
  a.clear();
  g.emit({ e: EV.DENY, to: 2, why: 'limit' });
  flushNow();
  assert.equal(b.sent.length, 0);
  assert.equal(a.jsons(MSG.EVENTS).length, 0);
});

test('events keep flowing as one batch when several ticks pass before a flush', () => {
  const { conns, g, ticks, flushNow } = startedMatch(1);
  ticks(SNAP_EVERY - (g.tick % SNAP_EVERY));
  conns[0].clear();
  g.emit({ e: EV.QUAKE, x: 0, y: 0, amt: 1 });
  ticks(1);
  g.emit({ e: EV.QUAKE, x: 1, y: 1, amt: 1 });
  flushNow();
  assert.equal(conns[0].jsons(MSG.EVENTS).length, 1);
  assert.equal(conns[0].last(MSG.EVENTS).ev.length, 2);
});

// ---- update and pause ----------------------------------------------------------------

test('update runs fixed steps and carries the remainder', () => {
  const { conns, g, room, clock } = startedMatch(1);
  assert.equal(conns.length, 1);
  clock.t += TICK_MS * 2.5;
  room.update(clock.t);
  assert.equal(g.tick, 2);
  clock.t += TICK_MS * 0.5 + 0.01;
  room.update(clock.t);
  assert.equal(g.tick, 3);
});

test('after 5 ticks in one call the rest of the time is discarded', () => {
  const { g, room, clock } = startedMatch(1);
  clock.t += TICK_MS * 40;
  room.update(clock.t);
  assert.equal(g.tick, 5);
  clock.t += TICK_MS * 0.5;
  room.update(clock.t);
  assert.equal(g.tick, 5, 'nothing was banked');
});

test('setPaused skips ticks and discards the elapsed time', () => {
  const { g, room, clock } = startedMatch(1);
  room.setPaused(true);
  for (let i = 0; i < 20; i++) {
    clock.t += TICK_MS;
    room.update(clock.t);
  }
  assert.equal(g.tick, 0);
  room.setPaused(false);
  room.update(clock.t);
  assert.equal(g.tick, 0, 'the pause does not come back as a burst');
  clock.t += TICK_MS + 0.01;
  room.update(clock.t);
  assert.equal(g.tick, 1);
});

// ---- late join and reconnect -----------------------------------------------------------

test('late join: WELCOME at once, the rest right after the next flush, to that conn only', () => {
  const { conns, join, g, flushNow, ticks } = startedMatch(1);
  ticks(SNAP_EVERY - (g.tick % SNAP_EVERY) + 1);
  const b = join();
  assert.deepEqual(b.kinds(), [MSG.WELCOME]);
  assert.ok(conns[0].kinds().includes(MSG.LOBBY_STATE), 'the roster change still reaches everyone else at once');
  conns[0].clear();
  flushNow();
  assert.deepEqual(b.kinds(), [MSG.WELCOME, MSG.LOBBY_STATE, MSG.START, MSG.FULL]);
  assert.equal(b.last(MSG.FULL).tick, g.tick, 'FULL.tick equals the tick just flushed');
  assert.equal(b.last(MSG.LOBBY_STATE).state, 'playing');
  assert.deepEqual(conns[0].kinds(), ['snap']);
  b.clear();
  ticks(SNAP_EVERY);
  assert.deepEqual(b.kinds(), ['snap'], 'after the serve the conn is on the normal stream');
});

test('a late joiner is not sent anything from the flush it is served after', () => {
  const { join, g, flushNow } = startedMatch(1);
  const b = join();
  g.emit({ e: EV.BANNER, text: 'Stale', sub: '', kind: 'info' });
  flushNow();
  assert.equal(b.jsons(MSG.EVENTS).length, 0, 'FULL already covers that tick');
  assert.equal(b.snapshots().length, 0);
});

test('a pending offer follows FULL in an EVENTS message, to that conn only', () => {
  const { conns, join, g, flushNow, room } = startedMatch(2);
  const [, b] = conns;
  g.offer(2, ['a', 'b', 'c']);
  flushNow();
  assert.ok(b.jsons(MSG.EVENTS).length);
  room.dropConn(b.id);
  const c = join({ token: room.slots.get(2).token });
  flushNow();
  assert.deepEqual(c.kinds(), [MSG.WELCOME, MSG.LOBBY_STATE, MSG.START, MSG.FULL, MSG.EVENTS]);
  const ev = c.last(MSG.EVENTS).ev[0];
  assert.equal(ev.e, EV.PICK_OFFER);
  assert.deepEqual(ev.cards, ['a', 'b', 'c']);
  assert.equal(ev.to, 2);
});

test('reclaim order: older conn gets CLOSED replaced and closes, no AFK, then setAfk(false), then resetInput', () => {
  const { conns, join, g, room } = startedMatch(2);
  const [, b] = conns;
  const token = room.slots.get(2).token;
  const order = [];
  b.onCloseHook = () => {
    order.push('old closed');
    room.dropConn(b.id); // a transport reports the close synchronously
  };
  g.calls.length = 0;
  const b2 = join({ token });
  assert.equal(b.closed, CLOSE.REPLACED);
  assert.equal(b.last(MSG.CLOSED).reason, CLOSE.REPLACED);
  assert.deepEqual(order, ['old closed']);
  assert.deepEqual(g.calls, [['setAfk', 2, false], ['resetInput', 2]], 'no setAfk(true), even with a synchronous dropConn');
  assert.equal(b2.last(MSG.WELCOME).you, 2);
  assert.equal(b2.last(MSG.WELCOME).token, token);
  assert.equal(room.slots.get(2).conn.conn, b2);
});

test('dropConn is a no-op for a conn no longer bound to a slot', () => {
  const { conns, join, g, room } = startedMatch(2);
  const [, b] = conns;
  const b2 = join({ token: room.slots.get(2).token });
  g.calls.length = 0;
  room.dropConn(b.id);
  room.dropConn(b.id);
  room.dropConn('nobody');
  assert.deepEqual(g.calls, []);
  assert.equal(room.slots.get(2).conn.conn, b2);
});

test('a dropped player goes AFK, keeps the slot, and reclaims it with resync', () => {
  const { conns, join, g, room, flushNow } = startedMatch(2);
  const [a, b] = conns;
  room.dropConn(b.id);
  assert.deepEqual(g.calls.filter((c) => c[0] === 'setAfk'), [['setAfk', 2, true]]);
  assert.equal(a.last(MSG.LOBBY_STATE).players.find((p) => p.id === 2).connected, false);
  const token = room.slots.get(2).token;
  const b2 = join({ token });
  assert.equal(a.last(MSG.LOBBY_STATE).players.find((p) => p.id === 2).connected, true);
  flushNow();
  assert.deepEqual(b2.kinds(), [MSG.WELCOME, MSG.LOBBY_STATE, MSG.START, MSG.FULL]);
});

test('the slot is removed after the grace period and the token becomes a new player', () => {
  const { conns, join, g, room, advance } = startedMatch(2);
  const [a, b] = conns;
  const token = room.slots.get(2).token;
  room.dropConn(b.id);
  advance(RECONNECT_GRACE_S * 1000 - 1);
  assert.ok(room.slots.has(2));
  advance(2);
  assert.ok(!room.slots.has(2));
  assert.ok(g.calls.some((c) => c[0] === 'removePlayer' && c[1] === 2));
  assert.equal(a.last(MSG.LOBBY_STATE).players.length, 1);
  const c = join({ token });
  const w = c.last(MSG.WELCOME);
  assert.notEqual(w.token, token, 'an expired token buys a new identity');
});

test('an unknown token is simply a new player', () => {
  const { join } = setup();
  const a = join({ token: 'f'.repeat(32) });
  assert.equal(a.last(MSG.WELCOME).you, 1);
  assert.notEqual(a.last(MSG.WELCOME).token, 'f'.repeat(32));
});

test('reclaim works in the lobby, keeps the host, and needs no match service', () => {
  const { join, room } = setup();
  const a = join();
  const token = a.last(MSG.WELCOME).token;
  room.dropConn(a.id);
  const a2 = join({ token });
  assert.equal(a2.last(MSG.WELCOME).hostId, 1);
  assert.deepEqual(a2.kinds(), [MSG.WELCOME, MSG.LOBBY_STATE]);
});

// ---- host handover ----------------------------------------------------------------------

test('server mode: the next human inherits host rights when the host leaves', () => {
  const { join, lobby, room } = setup();
  const a = join();
  lobby(a, LOBBY_OP.ADD_BOT);
  const b = join();
  const c = join();
  room.onData(a.id, JSON.stringify({ t: MSG.LEAVE }));
  assert.equal(room.hostId, 3);
  assert.equal(b.last(MSG.LOBBY_STATE).hostId, 3);
  lobby(b, LOBBY_OP.SET, { settings: { mapId: 'yard' } });
  assert.equal(c.last(MSG.LOBBY_STATE).settings.mapId, 'yard');
});

test('server mode: a dropped host keeps the role through the grace period, then passes it on', () => {
  const { join, advance, room } = setup();
  const a = join();
  const b = join();
  room.dropConn(a.id);
  advance(1000);
  assert.equal(room.hostId, 1);
  advance(RECONNECT_GRACE_S * 1000);
  assert.equal(room.hostId, 2);
  assert.equal(b.last(MSG.LOBBY_STATE).hostId, 2);
});

test('an heir who is connected beats one who is not', () => {
  const { join, room } = setup();
  const a = join();
  const b = join();
  join();
  room.dropConn(b.id);
  room.onData(a.id, JSON.stringify({ t: MSG.LEAVE }));
  assert.equal(room.hostId, 3);
});

test('P2P: a joiner who says HELLO first does not take the room from the local conn', () => {
  const { connect, hello, room } = setup();
  const local = connect('local');
  const remote = connect('peer1');
  hello(remote);
  assert.equal(room.hostId, 0);
  hello(local);
  assert.equal(room.hostId, local.last(MSG.WELCOME).you);
  assert.equal(remote.last(MSG.LOBBY_STATE).hostId, room.hostId);
});

test('P2P: when the local host goes, everyone hears hostLeft and the room ends', () => {
  for (const leave of [(s, c) => s.room.onData(c.id, JSON.stringify({ t: MSG.LEAVE })), (s, c) => s.room.dropConn(c.id)]) {
    const s = setup();
    const local = s.connect('local');
    s.hello(local);
    const remote = s.join();
    leave(s, local);
    assert.equal(remote.last(MSG.CLOSED).reason, CLOSE.HOST_LEFT);
    assert.ok(remote.closed !== null);
    assert.equal(s.room.destroyed, true);
    assert.equal(s.emptied.length, 1);
  }
});

// ---- room lifetime ------------------------------------------------------------------------

test('a room with no connected human is destroyed after the grace period', () => {
  const { join, advance, room, emptied } = setup();
  const a = join();
  room.dropConn(a.id);
  advance(RECONNECT_GRACE_S * 1000 - 1);
  assert.equal(emptied.length, 0);
  advance(2);
  assert.equal(emptied.length, 1);
  assert.equal(room.destroyed, true);
});

test('a reconnect inside the grace period keeps the room alive', () => {
  const { join, advance, room, emptied } = setup();
  const a = join();
  const token = a.last(MSG.WELCOME).token;
  room.dropConn(a.id);
  advance(RECONNECT_GRACE_S * 1000 - 100);
  join({ token });
  advance(RECONNECT_GRACE_S * 1000 * 2);
  assert.equal(emptied.length, 0);
});

test('a room nobody ever joined also expires', () => {
  const { advance, emptied } = setup();
  advance(RECONNECT_GRACE_S * 1000 + 1);
  assert.equal(emptied.length, 1);
});

test('a solo room is destroyed immediately', () => {
  const { connect, hello, room, emptied, advance } = setup({ solo: true });
  const c = connect('local');
  hello(c);
  room.dropConn('local');
  advance(1);
  assert.equal(emptied.length, 1);
});

test('destroy tells remaining conns, is idempotent, and later calls are harmless', () => {
  const { join, room, connect } = setup();
  const a = join();
  room.destroy();
  room.destroy();
  assert.equal(a.closeCount, 1);
  assert.equal(a.last(MSG.CLOSED).reason, CLOSE.HOST_LEFT);
  room.update(5000);
  room.dropConn(a.id);
  room.onData(a.id, 'x');
  const late = connect();
  assert.ok(late.closed !== null);
});

// ---- kick ---------------------------------------------------------------------------------

test('a kicked player hears KICKED, loses the slot, and the token is refused for the room\'s life', () => {
  const { join, lobby, connect, hello, room, advance } = setup();
  const a = join();
  const b = join();
  const token = b.last(MSG.WELCOME).token;
  lobby(a, LOBBY_OP.KICK, { id: 2 });
  assert.ok(b.kinds().includes(MSG.KICKED));
  assert.equal(b.closed, CLOSE.KICKED);
  assert.ok(!room.slots.has(2));
  assert.equal(a.last(MSG.LOBBY_STATE).players.length, 1);
  advance(RECONNECT_GRACE_S * 1000 * 2);
  const c = connect();
  hello(c, { token });
  assert.deepEqual(c.kinds(), [MSG.KICKED]);
  assert.equal(c.closed, CLOSE.KICKED);
  assert.ok(!room.slots.has(2));
});

test('kicking works during a match and on an offline player', () => {
  const { conns, lobby, room, g, connect, hello } = startedMatch(3);
  const [a, b, c] = conns;
  const offlineToken = room.slots.get(3).token;
  room.dropConn(c.id);
  lobby(a, LOBBY_OP.KICK, { id: 3 });
  lobby(a, LOBBY_OP.KICK, { id: 2 });
  assert.ok(g.calls.some((x) => x[0] === 'removePlayer' && x[1] === 3));
  assert.ok(g.calls.some((x) => x[0] === 'removePlayer' && x[1] === 2));
  assert.equal(b.closed, CLOSE.KICKED);
  const again = connect();
  hello(again, { token: offlineToken });
  assert.deepEqual(again.kinds(), [MSG.KICKED]);
});

test('the host cannot kick themselves', () => {
  const { join, lobby, room } = setup();
  const a = join();
  lobby(a, LOBBY_OP.KICK, { id: 1 });
  assert.ok(room.slots.has(1));
  assert.equal(a.closed, null);
});

// ---- chat and ping --------------------------------------------------------------------------

test('chat is sanitized and broadcast; empty chat goes nowhere', () => {
  const { join, room } = setup();
  const a = join({ name: 'Ada' });
  const b = join();
  room.onData(a.id, JSON.stringify({ t: MSG.CHAT, text: ' hi\nthere ' }));
  assert.deepEqual(b.last(MSG.CHAT_MSG), { t: MSG.CHAT_MSG, id: 1, name: 'Ada', text: 'hi there' });
  assert.ok(a.last(MSG.CHAT_MSG));
  b.clear();
  room.onData(a.id, JSON.stringify({ t: MSG.CHAT, text: '   ' }));
  assert.equal(b.sent.length, 0);
});

test('PING is answered at once with the sim tick', () => {
  const { conns, ticks, room, g } = startedMatch(1);
  ticks(3);
  room.onData(conns[0].id, JSON.stringify({ t: MSG.PING, c: 42 }));
  assert.deepEqual(conns[0].last(MSG.PONG), { t: MSG.PONG, c: 42, tick: g.tick });
});

// ---- rate limits ----------------------------------------------------------------------------

function drain(send, n) {
  for (let i = 0; i < n; i++) send(i);
}

test('input bucket: burst 150, refill 45/s, overflow discarded silently', () => {
  const { conns, room, g, clock } = startedMatch(1);
  const [a] = conns;
  const send = (seq) => room.onData(a.id, encodeInput({ seq: seq + 1, mx: 0, my: 0, aim: 0, btn: 0, tx: 0, ty: 0 }));
  drain(send, 200);
  const kid = g.kids.get(1);
  assert.equal(kid.queue.length, 150);
  assert.equal(a.closed, null);
  clock.t += 1000;
  drain((i) => send(200 + i), 100);
  assert.equal(kid.queue.length, 195, '45 more after a second');
});

test('cmd bucket: burst 40, refill 20/s', () => {
  const { conns, cmd, g, clock } = startedMatch(1);
  const [a] = conns;
  drain(() => cmd(a, CMD.READY), 60);
  assert.equal(g.calls.filter((c) => c[0] === 'command').length, 40);
  clock.t += 1000;
  drain(() => cmd(a, CMD.READY), 60);
  assert.equal(g.calls.filter((c) => c[0] === 'command').length, 60);
});

test('chat bucket: burst 4, refill 2/s', () => {
  const { join, room, clock } = setup();
  const a = join();
  drain(() => room.onData(a.id, JSON.stringify({ t: MSG.CHAT, text: 'x' })), 10);
  assert.equal(a.jsons(MSG.CHAT_MSG).length, 4);
  clock.t += 1000;
  drain(() => room.onData(a.id, JSON.stringify({ t: MSG.CHAT, text: 'x' })), 10);
  assert.equal(a.jsons(MSG.CHAT_MSG).length, 6);
});

test('other JSON bucket: burst 30, refill 10/s, covers PING, LOBBY and repeat HELLO', () => {
  const { join, room, clock, lobby, hello } = setup();
  const a = join();
  drain((i) => room.onData(a.id, JSON.stringify({ t: MSG.PING, c: i })), 40);
  assert.equal(a.jsons(MSG.PONG).length, 30);
  a.clear();
  lobby(a, LOBBY_OP.ME, { ready: true });
  assert.equal(a.sent.length, 0, 'LOBBY shares the bucket');
  clock.t += 1000;
  drain(() => hello(a), 10);
  drain((i) => room.onData(a.id, JSON.stringify({ t: MSG.PING, c: i })), 5);
  assert.equal(a.jsons(MSG.PONG).length, 0, 'a repeat HELLO spends the same budget');
});

test('a bound conn sending HELLO again changes nothing', () => {
  const { join, hello, room } = setup();
  const a = join({ name: 'Ada' });
  const welcomes = a.jsons(MSG.WELCOME).length;
  for (let i = 0; i < 5; i++) hello(a, { name: 'Mallory', token: 'x' });
  assert.equal(room.slots.size, 1);
  assert.equal(room.slots.get(1).name, 'Ada');
  assert.equal(a.jsons(MSG.WELCOME).length, welcomes);
});

test('300 discards within 10 s drop the conn with reason rate', () => {
  const { join, room, clock } = setup();
  const a = join();
  const b = join();
  const spam = () => room.onData(a.id, JSON.stringify({ t: MSG.CHAT, text: 'x' }));
  drain(spam, 4);
  for (let i = 0; i < 299; i++) {
    spam();
    clock.t += 1;
  }
  assert.equal(a.closed, null, '299 is under the limit');
  spam();
  assert.equal(a.closed, CLOSE.RATE);
  assert.equal(a.last(MSG.CLOSED).reason, CLOSE.RATE);
  assert.equal(b.last(MSG.LOBBY_STATE).players.find((p) => p.id === 1).connected, false);
  assert.ok(room.slots.has(1), 'a rate drop is a drop, not a kick');
});

test('discards spread over more than 10 s never drop the conn', () => {
  const { join, room, clock } = setup();
  const a = join();
  const spam = () => room.onData(a.id, JSON.stringify({ t: MSG.CHAT, text: 'x' }));
  drain(spam, 4);
  for (let i = 0; i < 2000; i++) {
    spam();
    clock.t += 40; // 25 msg/s: 2/s are served, 23/s are discarded, about 230 per 10 s
  }
  assert.equal(a.closed, null);
});

// ---- malformed traffic ------------------------------------------------------------------------

const MALFORMED = [
  'not json',
  '[1,2,3]',
  'null',
  '42',
  '"text"',
  '{}',
  '{"t":5}',
  '{"t":"nonsense"}',
  JSON.stringify({ t: MSG.WELCOME }),
  JSON.stringify({ t: MSG.PING }),
  JSON.stringify({ t: MSG.PING, c: 'x' }),
  '{"t":"ping","c":1e999}',
  '{"t":"ping","c":null}',
  JSON.stringify({ t: MSG.CHAT }),
  JSON.stringify({ t: MSG.CHAT, text: 5 }),
  JSON.stringify({ t: MSG.LOBBY }),
  JSON.stringify({ t: MSG.LOBBY, op: 'explode' }),
  JSON.stringify({ t: MSG.LOBBY, op: LOBBY_OP.SET }),
  JSON.stringify({ t: MSG.LOBBY, op: LOBBY_OP.SET, settings: 'x' }),
  JSON.stringify({ t: MSG.LOBBY, op: LOBBY_OP.KICK, id: 'x' }),
  JSON.stringify({ t: MSG.LOBBY, op: LOBBY_OP.DEL_BOT }),
  JSON.stringify({ t: MSG.LOBBY, op: LOBBY_OP.ADD_BOT, team: 'x' }),
  JSON.stringify({ t: MSG.CMD }),
  JSON.stringify({ t: MSG.CMD, c: 'explode' }),
  JSON.stringify({ t: MSG.CMD, c: CMD.BUILD, k: 'x', cx: 1, cy: 1 }),
  JSON.stringify({ t: MSG.CMD, c: CMD.BUILD, k: 0, cx: 1.5, cy: 1 }),
  '{"t":"cmd","c":"build","k":0,"cx":1e999,"cy":1}',
  JSON.stringify({ t: MSG.CMD, c: CMD.BUILD, k: 0, cx: 1e12, cy: 1 }),
  JSON.stringify({ t: MSG.CMD, c: CMD.DEMOLISH, cx: 'x', cy: 1 }),
  JSON.stringify({ t: MSG.CMD, c: CMD.CARD, i: -1 }),
  JSON.stringify({ t: MSG.CMD, c: CMD.EMOTE, n: 99 }),
  JSON.stringify({ t: MSG.CMD, c: CMD.EMOTE }),
  'x'.repeat(MAX_INBOUND_BYTES + 1),
  new ArrayBuffer(0),
  new ArrayBuffer(13),
  new ArrayBuffer(14),
  new ArrayBuffer(MAX_INBOUND_BYTES + 1),
  new Uint8Array([BIN.CHUNK, 0, 0, 0]).buffer,
  new Uint8Array([BIN.SNAPSHOT, 0, 0, 0]).buffer,
  undefined,
  null,
  5,
  {},
  new Uint8Array(14),
];

test('every kind of malformed message counts, and the third one drops the conn', () => {
  for (const bad of MALFORMED) {
    const { conns, room, g } = startedMatch(1);
    const [a] = conns;
    room.onData(a.id, bad);
    room.onData(a.id, bad);
    assert.equal(a.closed, null, `two of ${String(bad).slice(0, 50)} is not a drop`);
    room.onData(a.id, bad);
    assert.equal(a.closed, ERR.BAD_MSG, `three of ${String(bad).slice(0, 50)} is`);
    assert.equal(g.calls.filter((c) => c[0] === 'command').length, 0, 'nothing malformed reaches the Game');
  }
});

test('a malformed drop keeps the slot, like any other drop', () => {
  const { conns, room, g } = startedMatch(2);
  const [a, b] = conns;
  for (let i = 0; i < 3; i++) room.onData(b.id, 'nope');
  assert.ok(room.slots.has(2));
  assert.equal(a.last(MSG.LOBBY_STATE).players.find((p) => p.id === 2).connected, false);
  assert.ok(g.calls.some((c) => c[0] === 'setAfk' && c[1] === 2 && c[2] === true));
});

test('a sim exception reachable from the wire costs that conn a strike, not the room', () => {
  const { conns, room, g, cmd, ticks } = startedMatch(2);
  const [a, b] = conns;
  g.command = () => {
    throw new Error('sim bug');
  };
  cmd(b, CMD.READY);
  cmd(b, CMD.READY);
  assert.equal(b.closed, null);
  cmd(b, CMD.READY);
  assert.equal(b.closed, ERR.BAD_MSG, 'three strikes');
  assert.equal(room.destroyed, false);
  ticks(4);
  assert.ok(a.snapshots().length > 0, 'everyone else plays on');
});

test('valid commands reach the Game with known fields only', () => {
  const { conns, room, g } = startedMatch(1);
  room.onData(conns[0].id, JSON.stringify({ t: MSG.CMD, c: CMD.BUILD, k: STRUCT.WALL, cx: 3, cy: 4, evil: true, t2: 1 }));
  assert.deepEqual(g.calls.find((c) => c[0] === 'command'), ['command', 1, { c: CMD.BUILD, k: STRUCT.WALL, cx: 3, cy: 4 }]);
});

test('commands and inputs sent from the lobby are ignored without penalty', () => {
  const { join, cmd, room } = setup();
  const a = join();
  cmd(a, CMD.READY);
  room.onData(a.id, encodeInput({ seq: 1, mx: 0, my: 0, aim: 0, btn: 0, tx: 0, ty: 0 }));
  assert.equal(a.closed, null);
  assert.equal(room.conns.get(a.id).malformed, 0);
});

test('a hostile __proto__ payload changes nothing', () => {
  const { join, room } = setup();
  const a = join();
  room.onData(a.id, '{"t":"lobby","op":"set","settings":{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}}}}');
  assert.equal({}.polluted, undefined);
  assert.equal(room.settings.polluted, undefined);
});

test('fuzz: random JSON shapes never throw and never corrupt the room', () => {
  const { conns, room, g } = startedMatch(2);
  const [, b] = conns;
  let seed = 12345;
  const rng = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const values = [null, true, false, 0, -1, 1.5, 1e308, '', 'x', [], {}, [1], { a: 1 }];
  const pick = (list) => list[Math.floor(rng() * list.length)];
  const types = Object.values(MSG);
  const ops = Object.values(LOBBY_OP);
  const cmds = Object.values(CMD);
  for (let i = 0; i < 20000; i++) {
    const c = room.conns.get(b.id);
    if (c) c.malformed = 0; // keep the conn alive so the handlers keep getting exercised
    const msg = { t: pick(types), op: pick(ops), c: pick(cmds) };
    for (const key of ['k', 'cx', 'cy', 'i', 'n', 'id', 'team', 'text', 'name', 'look', 'settings', 'token', 'v', 'ready']) {
      if (rng() < 0.5) msg[key] = pick(values);
    }
    room.onData(b.id, JSON.stringify(msg));
    if (i % 50 === 0) {
      // Rate limits would otherwise silence nearly everything after the first burst.
      for (const bucket of Object.values(c?.buckets ?? {})) bucket.tokens = bucket.burst;
      c?.discards.splice(0);
    }
  }
  assert.ok(room.slots.has(1));
  assert.equal(room.hostId, 1);
  assert.equal(room.state, 'playing');
  assert.ok(g.tick >= 0);
});

// ---- result and return ---------------------------------------------------------------------------

test('RESULT follows the flush that ends the match, and only once', () => {
  const { conns, g, flushNow, ticks } = startedMatch(1);
  g.over = true;
  flushNow();
  assert.deepEqual(conns[0].kinds().slice(-2), ['snap', MSG.RESULT]);
  assert.equal(conns[0].last(MSG.RESULT).won, true);
  ticks(20);
  assert.equal(conns[0].jsons(MSG.RESULT).length, 1);
});

test('a joiner after the end still gets the result', () => {
  const { join, g, flushNow } = startedMatch(1);
  g.over = true;
  flushNow();
  const b = join();
  flushNow();
  assert.deepEqual(b.kinds(), [MSG.WELCOME, MSG.LOBBY_STATE, MSG.START, MSG.FULL, MSG.RESULT]);
});

test('RETURN is host only and only after the match, and Play Again gets a new seed', () => {
  const { conns, g, lobby, room, flushNow } = startedMatch(2);
  const [a, b] = conns;
  const seed = a.jsons(MSG.START).length ? a.last(MSG.START).seed : room.seed;
  lobby(a, LOBBY_OP.RETURN);
  assert.equal(room.state, 'playing', 'a match in progress cannot be returned');
  g.over = true;
  flushNow();
  lobby(b, LOBBY_OP.RETURN);
  assert.equal(room.state, 'playing');
  lobby(a, LOBBY_OP.RETURN);
  assert.equal(room.state, 'lobby');
  assert.equal(b.last(MSG.LOBBY_STATE).state, 'lobby');
  assert.equal(room.game, null);
  lobby(a, LOBBY_OP.START);
  assert.equal(room.state, 'playing');
  assert.notEqual(b.last(MSG.START).seed, seed);
  assert.notEqual(FakeGame.last, g);
});

test('lobby-only ops are ignored during a match', () => {
  const { conns, lobby, room } = startedMatch(2);
  const [a] = conns;
  lobby(a, LOBBY_OP.ADD_BOT);
  lobby(a, LOBBY_OP.SET, { settings: { mapId: 'pond' } });
  lobby(a, LOBBY_OP.ME, { name: 'New' });
  lobby(a, LOBBY_OP.START);
  assert.equal(room.slots.size, 2);
  assert.equal(room.settings.mapId, 'court');
  assert.equal(room.slots.get(1).name, 'Kid1');
});

test('a dead conn does not break the flush for anyone else', () => {
  const { conns, room, flushNow } = startedMatch(2);
  const [a, b] = conns;
  a.send = () => {
    throw new Error('socket gone');
  };
  flushNow();
  assert.ok(b.snapshots().length > 0);
  assert.equal(room.destroyed, false);
});

test('a transport that drops inside send during a flush is safe', () => {
  const { conns, room, flushNow } = startedMatch(3);
  const [a, b, c] = conns;
  const original = b.send.bind(b);
  b.send = (data) => {
    original(data);
    room.dropConn(b.id);
  };
  flushNow();
  assert.ok(a.snapshots().length > 0);
  assert.ok(c.snapshots().length > 0);
});
