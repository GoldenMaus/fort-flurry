// Three layers of proof. A virtual-time network runs Session against a real Room, so
// latency and jitter sweeps are deterministic and take milliseconds. A real Node server
// faces real ws clients, including hostile ones and raw sockets. And a real-time run over
// loopback checks that the same netcode holds up off the virtual clock.
import { after, test as nodeTest } from 'node:test';
import assert from 'node:assert/strict';
import { connect as tcpConnect } from 'node:net';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket as WS } from 'ws';
import { Room } from '../public/shared/room.js';
import { Game } from '../public/shared/game.js';
import { Session } from '../public/js/net/session.js';
import { WsTransport } from '../public/js/net/transport-ws.js';
import { makeWsConn, startServer } from '../server/index.js';
import { decodeInput, encodeSnapshot } from '../public/shared/protocol.js';
import {
  AFLAG, BIN, BTN, CLOSE, CMD, ERR, EV, GAME_NAME, LOBBY_OP, MODE, MSG, PHASE, PICKUP, PROTOCOL_VERSION, STRUCT,
} from '../public/shared/schema.js';
import {
  CONN_KILL_BYTES, DT, INTERP_TICKS, MAX_CONNS_PER_IP, MAX_INBOUND_BYTES, MAX_ROOMS, MAX_ROOMS_PER_IP, MAX_UNACKED,
  RECONNECT_GRACE_S, SIM_HZ, SNAP_DROP_BYTES, THROW,
} from '../public/shared/constants.js';
import { FakeGame } from './fixtures/fake-game.js';

// `npm test` sets no timeout, so one stuck socket here would hang the suite for everybody.
const test = (name, ...rest) => {
  const body = rest.pop();
  return nodeTest(name, { timeout: 30000, ...rest[0] }, body);
};

// A test that fails partway can still leave a socket or timer alive, which would hold this
// process open forever after every result is in. The exit code is already set by then.
after(() => {
  setTimeout(() => process.exit(), 500).unref();
});

// WsTransport reaches for the browser global. Node's own client keeps its socket open for
// about a minute after the server hangs up, which would hold the test process; the ws
// package offers the same browser-shaped API without that.
globalThis.WebSocket = WS;

const STEP_MS = 1000 / 60;
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let hexCount = 0;
const hex = (bytes) => {
  hexCount += 1;
  return hexCount.toString(16).padStart(bytes * 2, '0').slice(-bytes * 2);
};

// ---- virtual time ------------------------------------------------------------------

class VirtualClock {
  constructor() {
    this.t = 1000;
    this.timers = new Map();
    this.nextId = 1;
    this.now = () => this.t;
    this.wall = () => 1_700_000_000_000 + this.t;
    this.setTimeout = (fn, ms) => this._add(fn, ms, null);
    this.setInterval = (fn, ms) => this._add(fn, ms, ms);
    this.clearTimeout = (id) => this.timers.delete(id);
    this.clearInterval = (id) => this.timers.delete(id);
  }

  _add(fn, ms, every) {
    const id = this.nextId;
    this.nextId += 1;
    this.timers.set(id, { at: this.t + ms, fn, every });
    return id;
  }

  _nextDue(limit) {
    let best = null;
    for (const [id, timer] of this.timers) {
      if (timer.at <= limit && (best === null || timer.at < best.timer.at)) best = { id, timer };
    }
    return best;
  }

  // Sync on purpose: the network is the hot path. Promise chains get drained by settle().
  run(limit) {
    for (;;) {
      const due = this._nextDue(limit);
      if (!due) break;
      this.t = due.timer.at;
      if (due.timer.every === null) this.timers.delete(due.id);
      else due.timer.at += due.timer.every;
      due.timer.fn();
    }
    this.t = limit;
  }
}

const settle = () => new Promise((done) => setImmediate(done));

// One virtual connection: a transport for Session on one end, a conn for Room on the
// other. Delivery order is preserved like a reliable channel: jitter delays, never reorders.
class Link {
  constructor(net, { kind }) {
    this.net = net;
    this.kind = kind;
    this.id = `link${net.nextLink++}`;
    this.onmessage = null;
    this.onclose = null;
    this.dead = false;
    this.severed = false;
    this.black = false;
    this.sentByClient = [];
    this.lastAt = { up: 0, down: 0 };
    const link = this;
    this.conn = {
      id: this.id,
      send(data) {
        link._carry('down', data, () => {
          if (!link.dead) link.onmessage?.(data);
        });
      },
      close(reason) {
        link._carry('down', null, () => link._hangUp(reason));
      },
    };
  }

  _delay(dir) {
    const { oneWayMs, jitterMs, rng } = this.net;
    const at = Math.max(this.lastAt[dir], this.net.clock.t + oneWayMs + rng() * jitterMs);
    this.lastAt[dir] = at;
    return at - this.net.clock.t;
  }

  _carry(dir, data, deliver) {
    if (this.black) return;
    this.net.clock.setTimeout(deliver, this._delay(dir));
  }

  _hangUp(reason) {
    if (this.dead) return;
    this.dead = true;
    this.onclose?.(reason);
  }

  async connect() {
    const { net } = this;
    if (net.refuse) throw net.refuse;
    await new Promise((done) => net.clock.setTimeout(done, net.oneWayMs));
    net.room.addConn(this.conn);
  }

  send(data) {
    if (this.dead) return;
    this.sentByClient.push(data);
    const copy = data instanceof ArrayBuffer ? data.slice(0) : data;
    this._carry('up', data, () => {
      if (!this.severed) this.net.room.onData(this.id, copy);
    });
  }

  // A clean close: what is already on the wire still arrives, like a flushed socket.
  close() {
    if (this.dead) return;
    this.dead = true;
    this._carry('up', null, () => this.net.room.dropConn(this.id));
  }

  // The network drops the connection under both ends with no goodbye.
  sever() {
    this.severed = true;
    this._hangUp('severed');
    this.net.room.dropConn(this.id);
  }
}

class Net {
  constructor({ oneWayMs = 0, jitterMs = 0, seed = 1, GameClass = Game, kind = 'ws', solo = false } = {}) {
    this.clock = new VirtualClock();
    this.oneWayMs = oneWayMs;
    this.jitterMs = jitterMs;
    this.rng = seeded(seed);
    this.kind = kind;
    this.nextLink = 1;
    this.links = [];
    this.refuse = null;
    this.room = new Room({ code: 'BCDF', solo, GameClass, now: this.clock.now, randomHex: hex });
    this.sessions = [];
  }

  dialer(kind = this.kind) {
    return () => {
      const link = new Link(this, { kind });
      this.links.push(link);
      return link;
    };
  }

  session(opts = {}) {
    const s = new Session(this.dialer(opts.kind), { name: opts.name ?? 'Kid', look: {}, token: opts.token, clock: this.clock });
    s.fx = [];
    s.on('fx', (ev) => s.fx.push(ev));
    this.sessions.push(s);
    return s;
  }

  // Advances everything together at 60 fps, the way a browser would.
  async run(ms, onFrame) {
    const end = this.clock.t + ms;
    while (this.clock.t < end) {
      const to = Math.min(end, this.clock.t + STEP_MS);
      const dt = (to - this.clock.t) / 1000;
      this.clock.run(to);
      this.room.update(this.clock.t);
      onFrame?.(dt);
      for (const s of this.sessions) s.update(dt);
      await settle();
    }
  }

  async dial(session) {
    const started = session.start();
    await this.run(this.oneWayMs * 6 + 200);
    await started;
  }

  async startMatch(host, settings) {
    if (settings) host.lobbyOp(LOBBY_OP.SET, { settings });
    host.lobbyOp(LOBBY_OP.START);
    await this.run(this.oneWayMs * 4 + 400);
    assert.ok(host.inMatch, 'match started');
  }

  get kidOf() {
    return (id) => this.room.game.actors.get(id);
  }
}

const neutral = (over = {}) => ({ mx: 0, my: 0, aim: 0, btn: 0, tx: 0, ty: 0, ...over });

// Kids spawn around the Colonel, who stops balls and walkers, so tests that need open
// ground look away from him.
function awayFromFort(net, id) {
  const g = net.room.game;
  const kid = g.actors.get(id);
  return Math.atan2(kid.y - g.map.fort.y, kid.x - g.map.fort.x);
}

async function liveMatch(opts = {}, settings = undefined) {
  const net = new Net(opts);
  const s = net.session();
  await net.dial(s);
  await net.startMatch(s, settings);
  await net.run(500, () => s.setFrameInput(neutral()));
  return { net, s };
}

// ---- prediction ----------------------------------------------------------------------

const PROFILES = [
  { name: 'LAN', oneWayMs: 5, jitterMs: 2 },
  { name: 'typical', oneWayMs: 40, jitterMs: 15 },
  { name: 'rough', oneWayMs: 90, jitterMs: 40 },
  { name: 'awful', oneWayMs: 150, jitterMs: 80 },
];

// Figure-eights through the open ground around the fort, with stops.
function walk(frame) {
  const phase = Math.floor(frame / 45) % 8;
  const dirs = [[1, 0], [1, 1], [0, 1], [-1, 1], [0, 0], [-1, 0], [-1, -1], [0, -1]];
  const [mx, my] = dirs[phase];
  return neutral({ mx, my, aim: frame * 0.03 });
}

for (const profile of PROFILES) {
  test(`prediction tracks the host frame for frame on a ${profile.name} link`, async () => {
    const { net, s } = await liveMatch({ ...profile, seed: 7 });
    const predicted = new Map();
    const authoritative = new Map();
    let frame = 0;
    const shown = [];
    await net.run(12000, () => {
      s.setFrameInput(walk(frame));
      frame += 1;
      const p = s._pred;
      const last = s._pending.at(-1);
      if (p && last) predicted.set(last.seq, { x: p.x, y: p.y });
      const kid = net.kidOf(s.me);
      authoritative.set(net.room.game.ackSeq(s.me), { x: kid.x, y: kid.y });
      if (s.view.me) shown.push({ x: s.view.me.x, y: s.view.me.y });
    });
    const errors = [];
    for (const [seq, a] of authoritative) {
      const b = predicted.get(seq);
      if (b) errors.push(Math.hypot(a.x - b.x, a.y - b.y));
    }
    errors.sort((a, b) => a - b);
    const p95 = errors[Math.floor(errors.length * 0.95)];
    assert.ok(errors.length > 150, `compared ${errors.length} frames`);
    assert.ok(p95 < 2, `${profile.name}: p95 prediction error ${p95.toFixed(2)}`);

    // What the player sees must never teleport. Walking is about 3.4 units per frame.
    let worstStep = 0;
    for (let i = 1; i < shown.length; i++) worstStep = Math.max(worstStep, Math.hypot(shown[i].x - shown[i - 1].x, shown[i].y - shown[i - 1].y));
    assert.ok(worstStep < 14, `${profile.name}: visible jump of ${worstStep.toFixed(1)} units`);

    await net.run(1500 + profile.oneWayMs * 4, () => s.setFrameInput(neutral()));
    const kid = net.kidOf(s.me);
    const gap = Math.hypot(kid.x - s.view.me.x, kid.y - s.view.me.y);
    assert.ok(gap < 0.5, `${profile.name}: at rest the client is ${gap.toFixed(3)} units from the host`);
    assert.ok(Math.hypot(s._offX, s._offY) < 0.3, 'the correction offset decayed');
    const roundTripFrames = (2 * (profile.oneWayMs + profile.jitterMs)) / (DT * 1000);
    assert.ok(s._pending.length <= roundTripFrames + 3, `pending ${s._pending.length}`);
    s.leave();
  });
}

test('prediction uses exactly the floats the sim sees', async () => {
  const { net, s } = await liveMatch({ oneWayMs: 60 });
  await net.run(400, () => s.setFrameInput(neutral({ mx: 0.123456789, my: -0.3333333, aim: 1.23456789, tx: 12.7, ty: 45.2 })));
  const link = net.links[0];
  const bytes = link.sentByClient.filter((d) => d instanceof ArrayBuffer).at(-1);
  assert.equal(new Uint8Array(bytes)[0], BIN.INPUT);
  const predicted = s._pending.at(-1);
  assert.ok(predicted, 'a frame is in flight');
  assert.deepEqual({ ...predicted, cancelHeld: undefined }, { ...decodeInput(bytes.slice(0)), cancelHeld: undefined }, 'prediction stepped the decoded frame');
  assert.equal(predicted.mx, Math.round(0.123456789 * 127) / 127);
  assert.equal(predicted.tx, 13);
  s.leave();
});

test('a small server correction is hidden by the visual offset, a big one snaps', async () => {
  const { net, s } = await liveMatch({ oneWayMs: 30 });
  const kid = net.kidOf(s.me);
  await net.run(300, () => s.setFrameInput(neutral()));
  const before = s.view.me.x;
  kid.x += 30;
  let firstMove = null;
  let last = before;
  await net.run(400, () => {
    s.setFrameInput(neutral());
    const x = s.view.me?.x ?? last;
    if (firstMove === null && x !== before) firstMove = Math.abs(x - last);
    last = x;
  });
  assert.ok(firstMove !== null && firstMove < 10, `a 30 unit nudge eased in, first step ${firstMove}`);
  assert.ok(Math.abs(s.view.me.x - kid.x) < 2, 'and it arrived');

  kid.x += 300;
  const start = s.view.me.x;
  let frames = 0;
  await net.run(400, () => {
    s.setFrameInput(neutral());
    if (Math.abs((s.view.me?.x ?? start) - kid.x) > 5) frames += 1;
  });
  assert.ok(Math.abs(s.view.me.x - kid.x) < 0.5, 'a 300 unit correction snapped');
  assert.ok(frames < 12, `no long slide across the map (${frames} frames)`);
  s.leave();
});

test('a respawn event for me snaps at once with no easing', async () => {
  const { net, s } = await liveMatch({ oneWayMs: 20 });
  const kid = net.kidOf(s.me);
  kid.x += 60;
  net.room.game.emit({ e: EV.RESPAWN, id: s.me, x: kid.x, y: kid.y });
  await net.run(200, () => s.setFrameInput(neutral()));
  assert.ok(Math.abs(s.view.me.x - kid.x) < 0.5);
  s.leave();
});

test('with MAX_UNACKED frames unacked it stops predicting and sending', async () => {
  const { net, s } = await liveMatch();
  const link = net.links[0];
  const room = net.room;
  const realOnData = room.onData.bind(room);
  room.onData = () => {};
  const before = link.sentByClient.filter((d) => d instanceof ArrayBuffer).length;
  await net.run(2500, () => s.setFrameInput(neutral({ mx: 1 })));
  const sent = link.sentByClient.filter((d) => d instanceof ArrayBuffer).length - before;
  assert.ok(sent <= MAX_UNACKED, `sent ${sent}`);
  assert.equal(s._pending.length, MAX_UNACKED);
  room.onData = realOnData;
  s.leave();
});

test('if view.me is null no frames are sent', async () => {
  const net = new Net();
  const a = net.session({ name: 'Host' });
  await net.dial(a);
  await net.startMatch(a);
  // A Siege late joiner has no kid during FIGHT. Force FIGHT by ending the first build.
  net.room.game.beginFight();
  await net.run(200, () => a.setFrameInput(neutral()));
  const b = net.session({ name: 'Late' });
  await net.dial(b);
  await net.run(500, () => b.setFrameInput(neutral({ mx: 1 })));
  assert.equal(b.view.me, null);
  assert.equal(b.view.you, null);
  assert.ok(b.inMatch);
  const link = net.links.at(-1);
  assert.equal(link.sentByClient.filter((d) => d instanceof ArrayBuffer).length, 0);

  // At the next build phase the kid gets a body and the same conn starts playing.
  net.room.game.clearWave();
  const both = () => {
    a.setFrameInput(neutral());
    b.setFrameInput(neutral({ mx: 1 }));
  };
  await net.run(600, both);
  assert.equal(net.room.game.phase, PHASE.BUILD);
  assert.ok(b.view.me, 'hopped in');
  assert.ok(b.view.you);
  assert.ok(net.room.game.ackSeq(b.me) > 0, 'frames flow from seq 1 with no reconnect');
  a.leave();
  b.leave();
});

test('setFrameInput keeps latest values and ORs btn so a short tap survives', async () => {
  const { net, s } = await liveMatch();
  const link = net.links[0];
  const frames = () => link.sentByClient.filter((d) => d instanceof ArrayBuffer).map((b) => new DataView(b).getUint8(9));
  link.sentByClient.length = 0;
  s.setFrameInput(neutral({ btn: BTN.SLIDE }));
  s.setFrameInput(neutral({ btn: 0 }));
  s.update(DT + 0.001);
  assert.deepEqual(frames(), [BTN.SLIDE]);
  s.update(DT + 0.001);
  assert.deepEqual(frames(), [BTN.SLIDE, 0]);
  s.leave();
});

test('update clamps dt: a long stall yields at most 3 frames', async () => {
  const { net, s } = await liveMatch();
  const link = net.links[0];
  link.sentByClient.length = 0;
  s.setFrameInput(neutral());
  s.update(5);
  assert.equal(link.sentByClient.filter((d) => d instanceof ArrayBuffer).length, 3);
  s.leave();
});

// ---- tick estimate and interpolation ------------------------------------------------

test('renderTick never reverses and stays behind the newest snapshot', async () => {
  for (const profile of PROFILES) {
    const { net, s } = await liveMatch({ ...profile, seed: 3 });
    let prev = s.view.renderTick;
    const lags = [];
    await net.run(6000, () => {
      s.setFrameInput(neutral());
      assert.ok(s.view.renderTick >= prev, 'renderTick reversed');
      prev = s.view.renderTick;
      assert.ok(s.view.renderTick <= s._newestTick);
      lags.push(net.room.game.tick - s.view.renderTick);
    });
    const tail = lags.slice(-60);
    const avg = tail.reduce((a, b) => a + b, 0) / tail.length;
    const expected = profile.oneWayMs * SIM_HZ / 1000 + s._delay;
    assert.ok(Math.abs(avg - expected) < 3 + profile.jitterMs * SIM_HZ / 1000, `${profile.name}: lag ${avg.toFixed(1)} vs ${expected.toFixed(1)}`);
    assert.ok(s._delay >= INTERP_TICKS && s._delay <= 12);
    s.leave();
  }
});

test('renderTick holds at the newest snapshot through a stall, then carries on', async () => {
  const { net, s } = await liveMatch({ oneWayMs: 20 });
  await net.run(300, () => s.setFrameInput(neutral()));
  const link = net.links[0];
  link.black = true;
  await net.run(150, () => s.setFrameInput(neutral())); // let what is in flight land
  const newest = s._newestTick;
  await net.run(2000, () => {
    s.setFrameInput(neutral());
    assert.ok(s.view.renderTick <= newest, `renderTick ${s.view.renderTick} ran past snapshot ${newest}`);
  });
  assert.equal(s.view.renderTick, newest, 'it reached the last thing it knows and waited there');
  link.black = false;
  await net.run(800, () => s.setFrameInput(neutral()));
  assert.ok(s._newestTick > newest + 20);
  assert.ok(s.view.renderTick > newest, 'and resumed');
  s.leave();
});

test('after a long host pause interpolation returns within a second, not after the pause length', async () => {
  const { net, s } = await liveMatch({ kind: 'local', solo: true });
  await net.run(500, () => s.setFrameInput(neutral()));
  net.room.setPaused(true);
  await net.run(30000, () => s.setFrameInput(neutral()));
  net.room.setPaused(false);
  await net.run(1200, () => s.setFrameInput(neutral()));
  const lags = [];
  await net.run(500, () => {
    s.setFrameInput(neutral());
    lags.push(s._newestTick - s.view.renderTick);
  });
  const average = lags.reduce((a, b) => a + b, 0) / lags.length;
  assert.ok(average > 2, `renderTick trails the newest snapshot by ${average.toFixed(2)} ticks; 0 means no interpolation`);
  s.leave();
});

test('interpDelay grows with jitter, slowly, and only that far', async () => {
  const calm = await liveMatch({ oneWayMs: 40, jitterMs: 0 });
  await calm.net.run(5000, () => calm.s.setFrameInput(neutral()));
  assert.ok(calm.s._delay < INTERP_TICKS + 1, `calm delay ${calm.s._delay}`);
  calm.s.leave();
  const shaky = await liveMatch({ oneWayMs: 40, jitterMs: 120, seed: 11 });
  let biggestStep = 0;
  let last = shaky.s._delay;
  await shaky.net.run(8000, () => {
    shaky.s.setFrameInput(neutral());
    biggestStep = Math.max(biggestStep, Math.abs(shaky.s._delay - last));
    last = shaky.s._delay;
  });
  assert.ok(shaky.s._delay > INTERP_TICKS + 2, `shaky delay ${shaky.s._delay}`);
  assert.ok(biggestStep <= 0.02 * 2 + 1e-9, `moved ${biggestStep} in one 60 fps frame`);
  shaky.s.leave();
});

test('other kids interpolate smoothly between snapshots', async () => {
  const net = new Net({ oneWayMs: 30, jitterMs: 10, seed: 5 });
  const a = net.session({ name: 'Mover' });
  const b = net.session({ name: 'Watcher' });
  await net.dial(a);
  await net.dial(b);
  await net.startMatch(a);
  await net.run(300, () => {
    a.setFrameInput(neutral());
    b.setFrameInput(neutral());
  });
  const seen = [];
  const away = awayFromFort(net, a.me);
  const mx = Math.cos(away);
  const my = Math.sin(away);
  await net.run(1200, () => {
    a.setFrameInput(neutral({ mx, my }));
    b.setFrameInput(neutral());
    const other = b.view.actors.find((x) => x.id === a.me);
    if (other) seen.push({ x: other.x, y: other.y });
  });
  const steps = seen.slice(1).map((p, i) => Math.hypot(p.x - seen[i].x, p.y - seen[i].y));
  const walking = steps.slice(20, -5);
  const moving = walking.filter((d) => d > 0.05).length;
  assert.ok(Math.hypot(seen.at(-1).x - seen[0].x, seen.at(-1).y - seen[0].y) > 100, 'the watcher saw motion');
  assert.ok(moving >= walking.length * 0.95, `moved on ${moving} of ${walking.length} frames: stepping at 15 Hz would be about a quarter`);
  assert.ok(Math.max(...steps) < 9, `no jumps: walking is 3.4 units per frame, worst was ${Math.max(...steps).toFixed(1)}`);
  a.leave();
  b.leave();
});

test('an actor that teleports snaps, and aim takes the short way round', () => {
  const net = new Net();
  const s = net.session();
  s.inMatch = true;
  s.me = 1;
  const make = (tick, actor) => {
    const snap = { tick, ack: 0, you: null, actors: [actor], byId: new Map([[actor.id, actor]]) };
    s._ring.push(snap);
    s._newest = snap;
    s._newestTick = tick;
  };
  const base = { id: 2, kind: 0, team: 0, vx: 0, vy: 0, hp: 1, flags: 0, aux: 0 };
  make(10, { ...base, x: 100, y: 100, aim: 6.2 });
  make(12, { ...base, x: 110, y: 100, aim: 0.1 });
  make(14, { ...base, x: 600, y: 100, aim: 0.1 });
  s.view.renderTick = 11;
  s._composeActors();
  assert.equal(s.view.actors[0].x, 105);
  const mid = s.view.actors[0].aim;
  assert.ok(Math.abs(Math.sin(mid) - Math.sin((6.2 + 0.1 + Math.PI * 2) / 2)) < 0.01, `aim ${mid}`);
  s.view.renderTick = 13;
  s._composeActors();
  assert.equal(s.view.actors[0].x, 600);
  s.view.renderTick = 5;
  s._composeActors();
  assert.equal(s.view.actors[0].x, 100, 'before the first bracket, hold at the oldest');
});

// ---- events --------------------------------------------------------------------------

test('events are held until renderTick reaches them', async () => {
  const { net, s } = await liveMatch({ oneWayMs: 50 });
  const g = net.room.game;
  g.emit({ e: EV.BARK, id: 1, text: 'held' });
  const stamped = g.events.at(-1).t;
  let arrivedAt = null;
  let shownAt = null;
  await net.run(1200, () => {
    s.setFrameInput(neutral());
    if (arrivedAt === null && s._held.some((e) => e.text === 'held')) arrivedAt = s.view.renderTick;
    if (shownAt === null && s.fx.some((e) => e.text === 'held')) shownAt = s.view.renderTick;
  });
  assert.ok(arrivedAt !== null && arrivedAt < stamped, `arrived at renderTick ${arrivedAt}, stamped ${stamped}`);
  assert.ok(shownAt >= stamped);
  s.leave();
});

test('sAdd changes cw on arrival; view.structs changes at display time, with fx', async () => {
  const { net, s } = await liveMatch({ oneWayMs: 50 }, { mapId: 'court' });
  const g = net.room.game;
  const cell = { cx: Math.floor(g.map.fort.x / 40) + 3, cy: Math.floor(g.map.fort.y / 40) + 3 };
  assert.equal(s.view.cw.isSolidCell(cell.cx, cell.cy), false);
  const kid = net.kidOf(s.me);
  kid.x = cell.cx * 40 + 90;
  kid.y = cell.cy * 40;
  s.cmd(CMD.BUILD, { k: STRUCT.WALL, ...cell });
  let solidBeforeVisible = false;
  await net.run(1500, () => {
    s.setFrameInput(neutral());
    const solid = s.view.cw.isSolidCell(cell.cx, cell.cy);
    const visible = s.view.structs.some((x) => x.cx === cell.cx && x.cy === cell.cy);
    if (solid && !visible) solidBeforeVisible = true;
  });
  assert.ok(solidBeforeVisible, 'collision came first');
  const wall = s.view.structs.find((x) => x.cx === cell.cx && x.cy === cell.cy);
  assert.ok(wall, 'then it became visible');
  assert.ok(wall.bornAt > 0);
  assert.deepEqual(Object.keys(wall).sort(), ['bornAt', 'cx', 'cy', 'hp', 'id', 'kind', 'maxHp', 'ownerId', 'team']);
  assert.ok(s.fx.some((e) => e.e === EV.S_ADD && e.id === wall.id));
  s.leave();
});

test('private events skip the hold and still emit fx', async () => {
  const { net, s } = await liveMatch({ oneWayMs: 50, GameClass: FakeGame }, undefined);
  const g = net.room.game;
  g.emit({ e: EV.DENY, to: s.me, why: 'limit' });
  g.offer(s.me, ['boots', 'tongs', 'socks']);
  await net.run(150, () => s.setFrameInput(neutral()));
  assert.deepEqual(s.offer, ['boots', 'tongs', 'socks']);
  const deny = s.fx.find((e) => e.e === EV.DENY);
  assert.ok(deny);
  assert.ok(deny.t > s.view.renderTick, 'it did not wait for renderTick');
  g.emit({ e: EV.CARD, id: s.me, card: 'boots' });
  await net.run(800, () => s.setFrameInput(neutral()));
  assert.equal(s.offer, null, 'a card event for me clears the offer');
  s.leave();
});

test('unknown ids are ignored for sHp, sDel, pDel and ballEnd; sAdd, pAdd and ball upsert', async () => {
  const { net, s } = await liveMatch({ GameClass: FakeGame });
  const g = net.room.game;
  g.emit({ e: EV.S_HP, id: 9999, hp: 1 });
  g.emit({ e: EV.S_DEL, id: 9999, k: 0, cx: 1, cy: 1, why: 'x' });
  g.emit({ e: EV.P_DEL, id: 9999, k: 0, x: 0, y: 0, by: 0 });
  g.emit({ e: EV.BALL_END, id: 9999, x: 0, y: 0, z: 0, why: 'x', hit: 0 });
  g.emit({ e: EV.S_ADD, id: 5000, k: STRUCT.WALL, cx: 2, cy: 2, tm: 0, hp: 60, mhp: 60, by: 1 });
  g.emit({ e: EV.S_ADD, id: 5000, k: STRUCT.WALL, cx: 2, cy: 2, tm: 0, hp: 44, mhp: 60, by: 1 });
  g.emit({ e: EV.P_ADD, id: 7, k: PICKUP.ICE, x: 5, y: 5 });
  g.emit({ e: EV.P_ADD, id: 7, k: PICKUP.ICE, x: 9, y: 5 });
  await net.run(800, () => s.setFrameInput(neutral()));
  assert.equal(s.fx.filter((e) => e.id === 9999).length, 0);
  assert.equal(s.view.structs.filter((x) => x.id === 5000).length, 1);
  assert.equal(s.view.structs.find((x) => x.id === 5000).hp, 44);
  assert.equal(s.view.pickups.length, 1);
  assert.equal(s.view.pickups[0].x, 9);
  s.leave();
});

test('truce on cw follows meta', async () => {
  const net = new Net({ oneWayMs: 20 });
  const s = net.session();
  await net.dial(s);
  s.lobbyOp(LOBBY_OP.SET, { settings: { mode: MODE.FORTWARS } });
  s.lobbyOp(LOBBY_OP.ADD_BOT);
  await net.run(100);
  await net.startMatch(s);
  await net.run(200, () => s.setFrameInput(neutral()));
  assert.deepEqual(s.view.cw.truce, { ...s.view.map.truce, active: true });
  net.room.game.beginFight();
  await net.run(400, () => s.setFrameInput(neutral()));
  assert.equal(s.view.phase, PHASE.FIGHT);
  assert.equal(s.view.cw.truce, null);
  s.leave();
});

test('the opening banner survives the t <= FULL.tick rule', async () => {
  const { s } = await liveMatch();
  assert.ok(s.fx.some((e) => e.e === EV.BANNER), 'first banner reached fx');
  s.leave();
});

// ---- own throws ------------------------------------------------------------------------

async function pressThrow(net, s, frames = 3, input = {}) {
  await net.run(frames * 33.4, () => s.setFrameInput(neutral({ btn: BTN.THROW, ...input })));
  s.setFrameInput(neutral(input));
}

test('an own throw shows at once, links to the host ball, and fires fx exactly once', async () => {
  const { net, s } = await liveMatch({ oneWayMs: 60, jitterMs: 10, seed: 2 });
  await net.run(2500, () => s.setFrameInput(neutral())); // let ping settle
  s.fx.length = 0;
  const aim = awayFromFort(net, s.me);
  await pressThrow(net, s, 3, { aim });
  const started = net.clock.t;
  let shownAfter = null;
  let serverId = null;
  let linkedAt = null;
  const trail = [];
  await net.run(1500, () => {
    s.setFrameInput(neutral({ aim }));
    const ball = s.view.balls.find((b) => b.mine);
    if (ball) {
      if (shownAfter === null) shownAfter = net.clock.t - started;
      if (ball.id > 0 && serverId === null) {
        serverId = ball.id;
        linkedAt = net.clock.t - started;
      }
      trail.push({ x: ball.x, y: ball.y });
    }
  });
  // Worst case for the release itself is two 33 ms fixed steps: one still carries the
  // held bit, ORed in since the step before it. The host's answer takes 120 ms or more.
  assert.ok(shownAfter !== null && shownAfter <= 100, `visible after ${shownAfter} ms`);
  assert.ok(linkedAt > shownAfter + 80, `linked after ${linkedAt} ms, a round trip later`);
  assert.equal(s.fx.filter((e) => e.e === EV.THROW).length, 1, 'one throw fx');
  assert.equal(s.fx.filter((e) => e.e === EV.BALL).length, 1, 'one ball fx');
  assert.equal(s.fx.filter((e) => e.e === EV.BALL_END && e.id === serverId).length, 1);
  assert.equal(s.view.balls.length, 0, 'gone after landing');
  assert.equal(s._locals.length, 0);
  const speeds = trail.slice(1).map((p, i) => (p.x - trail[i].x) * Math.cos(aim) + (p.y - trail[i].y) * Math.sin(aim));
  const full = 540 / 60;
  assert.ok(speeds.every((d) => d >= -0.5), `never runs backward: ${Math.min(...speeds).toFixed(2)}`);
  assert.ok(Math.max(...speeds) < full * 2.2, `speed stays sane: ${Math.max(...speeds).toFixed(1)} vs ${full}`);
  s.leave();
});

test('a linked ball lands on server time, with the host landing tick', async () => {
  const { net, s } = await liveMatch({ oneWayMs: 80 });
  await net.run(2500, () => s.setFrameInput(neutral()));
  s.fx.length = 0;
  await pressThrow(net, s, 3, { aim: awayFromFort(net, s.me) });
  let endAt = null;
  let lastAt = 0;
  await net.run(1600, () => {
    s.setFrameInput(neutral());
    const end = s.fx.find((e) => e.e === EV.BALL_END);
    if (end && endAt === null) endAt = { tick: end.t, shownAtRender: s.view.renderTick };
    if (s.view.balls.length) lastAt = s.view.renderTick;
  });
  assert.ok(endAt, 'ballEnd played');
  assert.ok(Math.abs(endAt.shownAtRender - endAt.tick) < 1.5, 'ballEnd plays at its tick');
  assert.ok(lastAt <= endAt.tick + 1, `the ball stayed up until then (${lastAt} vs ${endAt.tick})`);
  s.leave();
});

// Local balls have no collision of their own, so until the host answers one can fly past
// what it will hit. Once ballEnd is here, held or not, it must not be shown beyond it.
test('an own ball goes no further than its impact point once ballEnd has arrived', async () => {
  const { net, s } = await liveMatch({ oneWayMs: 80 });
  await net.run(2500, () => s.setFrameInput(neutral()));
  const g = net.room.game;
  const kid = net.kidOf(s.me);
  const aim = Math.atan2(g.map.fort.y - kid.y, g.map.fort.x - kid.x);
  const start = { x: kid.x, y: kid.y };
  s.fx.length = 0;
  await pressThrow(net, s, 3, { aim });
  const afterEnd = [];
  await net.run(1400, () => {
    s.setFrameInput(neutral({ aim }));
    const local = s._locals[0];
    const ball = s.view.balls.find((b) => b.mine);
    if (ball && local?.endT !== null && local?.endT !== undefined) afterEnd.push(Math.hypot(ball.x - start.x, ball.y - start.y));
  });
  const end = s.fx.find((e) => e.e === EV.BALL_END);
  assert.ok(end && end.why === 'struct', `the ball should hit the Colonel, got ${end?.why}`);
  assert.ok(afterEnd.length > 2, `ballEnd was held for ${afterEnd.length} frames, so the cap had nothing to do`);
  // The cap is the ball's position at the end of the tick it hit in, while `end` is the
  // swept contact point inside that tick, so one tick of travel plus its radius is exact.
  const impact = Math.hypot(end.x - start.x, end.y - start.y);
  const farthest = Math.max(...afterEnd);
  const speed = THROW.quick.speed + (THROW.power.speed - THROW.quick.speed) * (3 / (THROW.chargeTime * SIM_HZ));
  const allowed = speed * DT + THROW.radius + 1;
  assert.ok(farthest <= impact + allowed, `shown ${(farthest - impact).toFixed(1)} units past the hit, allowed ${allowed.toFixed(1)}`);
  s.leave();
});

test('Triple Toss maps 3 to 3', async () => {
  const { net, s } = await liveMatch({ oneWayMs: 40 });
  const kid = net.kidOf(s.me);
  kid.special = PICKUP.TRIPLE;
  kid.specialN = 5;
  await net.run(600, () => s.setFrameInput(neutral()));
  s.fx.length = 0;
  await pressThrow(net, s, 3, { aim: awayFromFort(net, s.me) });
  let mostSeen = 0;
  const idsLinked = new Set();
  await net.run(1500, () => {
    s.setFrameInput(neutral());
    mostSeen = Math.max(mostSeen, s.view.balls.length);
    for (const b of s.view.balls) if (b.id > 0) idsLinked.add(b.id);
  });
  assert.equal(mostSeen, 3, 'three balls, never six');
  assert.equal(idsLinked.size, 3);
  assert.equal(s.fx.filter((e) => e.e === EV.THROW).length, 1);
  assert.equal(s.fx.filter((e) => e.e === EV.BALL).length, 3);
  s.leave();
});

test('a lob predicts the release and lands on the target', async () => {
  const { net, s } = await liveMatch({ oneWayMs: 40 });
  const kid = net.kidOf(s.me);
  const tx = Math.round(kid.x + 200);
  const ty = Math.round(kid.y);
  await net.run(100, () => s.setFrameInput(neutral({ btn: BTN.LOB, tx, ty })));
  s.setFrameInput(neutral({ tx, ty }));
  s.fx.length = 0;
  await net.run(100, () => s.setFrameInput(neutral({ tx, ty })));
  const thrown = s.fx.find((e) => e.e === EV.THROW);
  assert.ok(thrown?.lob, 'local lob fx');
  const ball = s.view.balls.find((b) => b.mine);
  assert.ok(ball, 'visible at once');
  assert.ok(Math.abs(ball.lx - tx) < 2 && Math.abs(ball.ly - ty) < 2, 'with the landing point for the reticle');
  await net.run(1600, () => s.setFrameInput(neutral({ tx, ty })));
  assert.equal(s.fx.filter((e) => e.e === EV.THROW).length, 1);
  assert.equal(s.view.balls.length, 0);
  s.leave();
});

test('no local ball without snow, on cooldown, or while frozen', async () => {
  const { net, s } = await liveMatch({ oneWayMs: 20 });
  const kid = net.kidOf(s.me);
  kid.balls = 0;
  await net.run(200, () => s.setFrameInput(neutral()));
  s.fx.length = 0;
  await pressThrow(net, s);
  await net.run(100, () => s.setFrameInput(neutral()));
  assert.equal(s.view.balls.length, 0);
  assert.equal(s.fx.filter((e) => e.e === EV.BALL).length, 0);

  kid.balls = 5;
  net.room.game.freezeKid(kid, null);
  await net.run(200, () => s.setFrameInput(neutral()));
  assert.ok(s.view.me.flags & AFLAG.FROZEN);
  await pressThrow(net, s);
  await net.run(100, () => s.setFrameInput(neutral()));
  assert.equal(s.fx.filter((e) => e.e === EV.BALL).length, 0, 'frozen');
  s.leave();
});

test('a charge cancelled with BTN.CANCEL throws nothing, even when the button is released later', async () => {
  const { net, s } = await liveMatch({ oneWayMs: 20 });
  s.fx.length = 0;
  await net.run(150, () => s.setFrameInput(neutral({ btn: BTN.THROW })));
  await net.run(50, () => s.setFrameInput(neutral({ btn: BTN.THROW | BTN.CANCEL })));
  await net.run(150, () => s.setFrameInput(neutral({ btn: BTN.THROW })));
  await net.run(300, () => s.setFrameInput(neutral()));
  assert.equal(s.fx.filter((e) => e.e === EV.BALL).length, 0);
  assert.equal(net.room.game.balls.size, 0);
  s.leave();
});

test('a mispredicted throw vanishes after 2*ping + 250 ms with no fx', async () => {
  const { net, s } = await liveMatch({ oneWayMs: 120 });
  await net.run(2500, () => s.setFrameInput(neutral()));
  const kid = net.kidOf(s.me);
  const aim = awayFromFort(net, s.me);
  await pressThrow(net, s, 2, { aim });
  // The host's state changes while the release is in flight, so the client cannot know.
  kid.balls = 0;
  s.fx.length = 0;
  await net.run(90, () => s.setFrameInput(neutral({ aim })));
  assert.equal(s.view.balls.length, 1, 'predicted');
  assert.equal(s.fx.filter((e) => e.e === EV.BALL).length, 1);
  s.fx.length = 0;
  const predictedAt = net.clock.t;
  let goneAt = null;
  await net.run(1200, () => {
    s.setFrameInput(neutral({ aim }));
    if (goneAt === null && s.view.balls.length === 0) goneAt = net.clock.t;
  });
  assert.ok(goneAt !== null);
  assert.ok(goneAt - predictedAt <= 2 * s.ping + 250 + 20, `gone after ${goneAt - predictedAt} ms, ping ${s.ping}`);
  assert.equal(s.fx.filter((e) => e.e === EV.BALL_END).length, 0, 'no fx for a throw that never was');
  assert.equal(net.room.game.balls.size, 0, 'and the host really never threw it');
  s.leave();
});

test('another kid\'s ball waits for renderTick and fires its fx at display time', async () => {
  const net = new Net({ oneWayMs: 40 });
  const a = net.session({ name: 'Thrower' });
  const b = net.session({ name: 'Target' });
  await net.dial(a);
  await net.dial(b);
  await net.startMatch(a);
  await net.run(500, () => {
    a.setFrameInput(neutral());
    b.setFrameInput(neutral());
  });
  b.fx.length = 0;
  const aim = awayFromFort(net, a.me);
  await net.run(100, () => {
    a.setFrameInput(neutral({ aim, btn: BTN.THROW }));
    b.setFrameInput(neutral());
  });
  let seen = 0;
  await net.run(1600, () => {
    a.setFrameInput(neutral({ aim }));
    b.setFrameInput(neutral());
    const ball = b.view.balls[0];
    if (ball) {
      seen += 1;
      assert.equal(ball.mine, false);
      assert.ok(ball.z >= 0);
    }
  });
  assert.ok(seen > 20, `visible for ${seen} frames`);
  assert.equal(b.fx.filter((e) => e.e === EV.THROW).length, 1, 'other kids get the throw fx');
  assert.equal(b.fx.filter((e) => e.e === EV.BALL).length, 1);
  a.leave();
  b.leave();
});

// ---- background -------------------------------------------------------------------------

test('background: no frames, no fx, state still applied, newest banner only', async () => {
  const { net, s } = await liveMatch({ oneWayMs: 30 });
  const g = net.room.game;
  const link = net.links[0];
  await net.run(300, () => s.setFrameInput(neutral()));
  s.setBackground(true);
  await net.run(100);
  s.fx.length = 0;
  link.sentByClient.length = 0;
  const kid = net.kidOf(s.me);
  g.banner('Old news');
  g.banner('Hot news');
  g.emit({ e: EV.BARK, id: 1, text: 'lost' });
  g.emit({ e: EV.S_ADD, id: 6001, k: STRUCT.WALL, cx: 3, cy: 3, tm: 0, hp: 60, mhp: 60, by: 1 });
  await net.run(2500);
  assert.equal(s.fx.length, 0, 'silence while hidden');
  assert.equal(link.sentByClient.filter((d) => d instanceof ArrayBuffer).length, 0, 'no frames');
  assert.ok(link.sentByClient.some((d) => typeof d === 'string' && JSON.parse(d).t === MSG.PING), 'PING continues');
  assert.ok(s.view.structs.some((x) => x.id === 6001), 'state applied');
  kid.x += 25;
  await net.run(200);
  s.setBackground(false);
  await net.run(50, () => s.setFrameInput(neutral()));
  assert.deepEqual(s.fx.filter((e) => e.e === EV.BANNER).map((e) => e.text), ['Hot news']);
  assert.ok(!s.fx.some((e) => e.text === 'lost'));
  assert.ok(Math.abs(s.view.me.x - kid.x) < 1, 'me resets to server state');
  assert.ok(s.view.renderTick > g.tick - 20, 'renderTick jumped forward');
  s.leave();
});

test('background drops expired balls on return', async () => {
  const { net, s } = await liveMatch({ oneWayMs: 20 });
  s.setBackground(true);
  await net.run(100);
  s._balls.set(99, { id: 99, k: 2, by: 0, tm: 0, x: 0, y: 0, z: 20, vx: 0, vy: 0, vz: 0, g: 900, r: 6, grow: 0, rMax: 6, lx: 0, ly: 0, ft: 3, t: s.view.renderTick - 20 });
  s._balls.set(98, { id: 98, k: 5, by: 0, tm: 0, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, g: 0, r: 6, grow: 0, rMax: 6, lx: 0, ly: 0, ft: 0, t: s.view.renderTick });
  s.setBackground(false);
  assert.ok(!s._balls.has(99));
  assert.ok(s._balls.has(98), 'a roller has no landing to miss');
  s.leave();
});

// ---- start and the handshake ----------------------------------------------------------------

test('start resolves on WELCOME and sets identity', async () => {
  const net = new Net({ GameClass: FakeGame });
  const s = net.session({ name: 'Ada' });
  await net.dial(s);
  assert.equal(s.me, 1);
  assert.equal(s.roomCode, 'BCDF');
  assert.ok(s.token);
  assert.equal(s.isHost, true);
  assert.equal(s.connected, true);
  assert.equal(s.lobby.state, 'lobby');
  s.leave();
});

test('start rejects {code,msg} for failures before WELCOME and emits nothing else', async () => {
  for (const code of [ERR.NO_ROOM, ERR.TIMEOUT, ERR.NET]) {
    const net = new Net({ GameClass: FakeGame });
    net.refuse = { code, msg: 'nope' };
    const s = net.session();
    const heard = [];
    s.on('error', (e) => heard.push(e));
    s.on('closed', (e) => heard.push(e));
    await assert.rejects(s.start(), (e) => e.code === code && typeof e.msg === 'string');
    assert.deepEqual(heard, []);
  }
});

test('an ERROR reply to HELLO rejects start; a bad version carries through', async () => {
  const net = new Net({ GameClass: FakeGame });
  const realOnData = net.room.onData.bind(net.room);
  net.room.onData = (id, data) => realOnData(id, typeof data === 'string' ? data.replace(`"v":${PROTOCOL_VERSION}`, '"v":0') : data);
  const s = net.session();
  const heard = [];
  s.on('closed', (e) => heard.push(e));
  const started = s.start();
  started.catch(() => {});
  await net.run(100);
  await assert.rejects(started, (e) => e.code === ERR.BAD_VERSION);
  assert.deepEqual(heard, []);
});

test('a host that never answers HELLO times out instead of hanging', async () => {
  const net = new Net({ GameClass: FakeGame });
  net.room.onData = () => {};
  const s = net.session();
  const started = s.start();
  started.catch(() => {});
  await net.run(10500);
  await assert.rejects(started, (e) => e.code === ERR.TIMEOUT);
});

test('leave during connect cancels start with no closed event', async () => {
  const net = new Net({ GameClass: FakeGame, oneWayMs: 100 });
  const s = net.session();
  const closed = [];
  s.on('closed', (e) => closed.push(e));
  const started = s.start();
  started.catch(() => {});
  s.leave();
  await assert.rejects(started);
  await net.run(500);
  assert.deepEqual(closed, []);
  assert.equal(net.room.slots.size, 0);
});

test('leave sends LEAVE, emits closed once, and the slot is gone', async () => {
  const net = new Net({ GameClass: FakeGame });
  const host = net.session({ name: 'Host' });
  const s = net.session({ name: 'Guest' });
  await net.dial(host);
  await net.dial(s);
  const closed = [];
  s.on('closed', (e) => closed.push(e));
  s.leave();
  s.leave();
  await net.run(100);
  assert.deepEqual(closed, [{ reason: CLOSE.LEFT }]);
  assert.equal(net.room.slots.size, 1);
  host.leave();
});

test('lobby ops, chat and START flow to every Session, and start fires after FULL', async () => {
  const net = new Net({ GameClass: FakeGame, oneWayMs: 15 });
  const host = net.session({ name: 'Host' });
  const guest = net.session({ name: 'Guest' });
  await net.dial(host);
  await net.dial(guest);
  const lobbies = [];
  guest.on('lobby', (l) => lobbies.push(l));
  const chats = [];
  guest.on('chat', (c) => chats.push(c));
  let viewAtStart = null;
  guest.on('start', () => {
    const v = guest.view;
    viewAtStart = { map: v.map?.id, meta: v.meta?.phase, structs: Array.isArray(v.structs), cw: !!v.cw, inMatch: guest.inMatch };
  });
  host.lobbyOp(LOBBY_OP.SET, { settings: { mapId: 'pond' } });
  host.chat('hello');
  await net.run(200);
  assert.equal(lobbies.at(-1).settings.mapId, 'pond');
  assert.equal(chats[0].text, 'hello');
  assert.equal(chats[0].name, 'Host');
  assert.equal(guest.isHost, false);
  assert.equal(guest.view.players.get(1).name, 'Host');
  host.lobbyOp(LOBBY_OP.START);
  await net.run(200);
  assert.deepEqual(viewAtStart, { map: 'pond', meta: PHASE.BUILD, structs: true, cw: true, inMatch: true });
  assert.equal(guest.view.mode, MODE.SIEGE);
  assert.equal(guest.view.mapId, 'pond');
  host.leave();
  guest.leave();
});

test('RESULT is stored and emitted; return to lobby ends the match', async () => {
  const net = new Net({ GameClass: FakeGame });
  const s = net.session();
  await net.dial(s);
  await net.startMatch(s);
  const results = [];
  s.on('result', (r) => results.push(r));
  net.room.game.over = true;
  await net.run(200, () => s.setFrameInput(neutral()));
  assert.equal(results.length, 1);
  assert.equal(s.result.won, true);
  assert.equal(s.result.t, undefined);
  const lobbies = [];
  s.on('lobby', (l) => lobbies.push(l.state));
  s.lobbyOp(LOBBY_OP.RETURN);
  await net.run(100);
  assert.deepEqual(lobbies, ['lobby']);
  assert.equal(s.inMatch, false);
  assert.equal(s.result, null);
  let started = 0;
  s.on('start', () => { started += 1; });
  s.lobbyOp(LOBBY_OP.START);
  await net.run(200);
  assert.equal(started, 1, 'Play Again is a new match, so it gets a new start event');
  s.leave();
});

test('ERROR after WELCOME is a non-fatal notice', async () => {
  const net = new Net({ GameClass: FakeGame });
  const s = net.session();
  await net.dial(s);
  const notes = [];
  s.on('error', (e) => notes.push(e));
  net.links[0].conn.send(JSON.stringify({ t: MSG.ERROR, code: ERR.RATE, msg: 'easy' }));
  await net.run(50);
  assert.deepEqual(notes, [{ code: ERR.RATE, msg: 'easy' }]);
  assert.equal(s.connected, true);
  s.leave();
});

// ---- reconnect --------------------------------------------------------------------------------

test('an unexpected close keeps the view, reconnects with the token and reclaims the slot', async () => {
  const net = new Net({ oneWayMs: 20 });
  const s = net.session({ name: 'Ada' });
  const other = net.session({ name: 'Bea' });
  await net.dial(s);
  await net.dial(other);
  await net.startMatch(s);
  await net.run(500, () => {
    s.setFrameInput(neutral({ mx: 1 }));
    other.setFrameInput(neutral());
  });
  const { me, token } = s;
  const log = [];
  s.on('reconnecting', (e) => log.push(['reconnecting', e.attempt]));
  s.on('reconnected', () => log.push(['reconnected']));
  let starts = 0;
  s.on('start', () => { starts += 1; });
  const seqBefore = s._seq;
  net.links[0].sever();
  assert.equal(s.connected, false);
  assert.equal(s.reconnecting, true);
  assert.ok(s.inMatch && s.view.map, 'the view survives');
  await net.run(100);
  assert.equal(net.room.game.players.get(me).afk, true);
  await net.run(1500, () => {
    s.setFrameInput(neutral());
    other.setFrameInput(neutral());
  });
  assert.deepEqual(log, [['reconnecting', 0], ['reconnecting', 1], ['reconnected']]);
  assert.equal(s.connected, true);
  assert.equal(s.me, me);
  assert.equal(s.token, token);
  assert.equal(net.room.game.players.get(me).afk, false);
  assert.equal(starts, 0, 'same seed is a resync, not a new start');
  assert.ok(seqBefore > 10);
  const link = net.links.at(-1);
  const firstFrame = link.sentByClient.find((d) => d instanceof ArrayBuffer);
  assert.equal(new DataView(firstFrame).getUint32(1, true), 1, 'a new connection restarts seq at 1');
  await net.run(500, () => {
    s.setFrameInput(neutral({ mx: -1 }));
    other.setFrameInput(neutral());
  });
  assert.ok(net.room.game.ackSeq(me) > 0, 'input flows again');
  s.leave();
  other.leave();
});

test('after a reconnect no input is sent until FULL has rebuilt the match', async () => {
  const { net, s } = await liveMatch({ oneWayMs: 30 });
  await net.run(400, () => s.setFrameInput(neutral({ mx: 1 })));
  const walkOn = () => s.setFrameInput(neutral({ mx: 1 }));
  const framesOnNewLink = () => net.links.at(-1).sentByClient.filter((d) => d instanceof ArrayBuffer).length;
  // WELCOME is immediate but FULL needs a flush, so a paused room holds that gap wide open.
  net.room.setPaused(true);
  net.links[0].sever();
  await net.run(1500, walkOn);
  assert.equal(s.connected, true, 'WELCOME arrived');
  assert.equal(net.links.length, 2);
  assert.equal(framesOnNewLink(), 0, 'no frames while the view is stale');
  net.room.setPaused(false);
  await net.run(600, walkOn);
  assert.ok(framesOnNewLink() > 0, 'and they flow as soon as FULL lands');
  s.leave();
});

test('a resync FULL clears held events, pending frames and balls, and drops stale events', async () => {
  const { net, s } = await liveMatch({ oneWayMs: 40 });
  await pressThrow(net, s);
  await net.run(100, () => s.setFrameInput(neutral()));
  net.room.game.emit({ e: EV.BARK, id: 1, text: 'pre-FULL' });
  await net.run(60, () => s.setFrameInput(neutral()));
  net.links[0].sever();
  await net.run(1800, () => s.setFrameInput(neutral()));
  assert.equal(s.connected, true);
  assert.ok(s.view.balls.every((b) => b.id > 0));
  assert.equal(s._locals.length, 0);
  assert.ok(s._held.every((e) => e.t > s._fullTick));
  s.leave();
});

test('events that land before FULL are dropped, since there is no world to apply them to yet', async () => {
  const net = new Net({ oneWayMs: 10 });
  const s = net.session();
  await net.dial(s);
  const inject = (msg) => s._onMessage(s._t, JSON.stringify(msg));
  inject({ t: MSG.START, mode: 'siege', mapId: 'court', difficulty: 'normal', waveCount: 5, seed: 'ab', tick: 0, players: [] });
  assert.equal(s.view.cw, null);
  inject({ t: MSG.EVENTS, tick: 2, ev: [{ e: EV.S_ADD, id: 7000, k: STRUCT.WALL, cx: 1, cy: 1, tm: 0, hp: 60, mhp: 60, by: 1, t: 2 }] });
  assert.equal(s._held.length, 0);
  s.leave();
});

test('a resync keeps the old actors on screen until the next snapshot', async () => {
  const net = new Net({ oneWayMs: 20 });
  const a = net.session({ name: 'A' });
  const b = net.session({ name: 'B' });
  await net.dial(a);
  await net.dial(b);
  await net.startMatch(a);
  const both = () => {
    a.setFrameInput(neutral());
    b.setFrameInput(neutral());
  };
  await net.run(500, both);
  let empty = 0;
  let meGone = 0;
  let youGone = 0;
  net.links[0].sever();
  await net.run(1800, () => {
    both();
    if (a.view.actors.length === 0) empty += 1;
    if (a.view.me === null) meGone += 1;
    if (a.view.you === null) youGone += 1;
  });
  assert.equal(a.connected, true);
  assert.equal(a._fullTick > 0, true, 'a FULL did arrive');
  assert.deepEqual([empty, meGone, youGone], [0, 0, 0], 'no flicker');
  a.leave();
  b.leave();
});

test('a retry whose host stays silent moves on after 10 s instead of burning the window', async () => {
  const net = new Net({ GameClass: FakeGame });
  const s = net.session();
  await net.dial(s);
  const dials = [];
  const dial = s._connectFn;
  s._connectFn = () => {
    dials.push(net.clock.t);
    return dial();
  };
  // A frozen host: the channel opens, then nothing ever comes back and nothing ever closes.
  // Room's own HELLO deadline cannot help, because frozen means Room is not running.
  net.room.addConn = () => {};
  net.room.onData = () => {};
  net.links[0].sever();
  await net.run(26000);
  assert.ok(dials.length >= 3, `only ${dials.length} attempts in 26 s`);
  assert.ok(dials[1] - dials[0] < 12000, `waited ${dials[1] - dials[0]} ms on a mute host`);
  s.leave();
});

test('a slot-holder reconnecting while a card is pending gets the offer back', async () => {
  const { net, s } = await liveMatch({ GameClass: FakeGame, oneWayMs: 10 });
  net.room.game.offer(s.me, ['boots', 'tongs', 'socks']);
  await net.run(100, () => s.setFrameInput(neutral()));
  assert.ok(s.offer);
  net.links[0].sever();
  await net.run(1500, () => s.setFrameInput(neutral()));
  assert.equal(s.connected, true);
  assert.deepEqual(s.offer, ['boots', 'tongs', 'socks']);
  s.leave();
});

test('retry schedule is 0.5, 1, 2 s, then every 4 s, until the grace window minus 5 s', async () => {
  const net = new Net({ GameClass: FakeGame });
  const s = net.session();
  await net.dial(s);
  const until = [];
  const attempts = [];
  s.on('reconnecting', (e) => {
    attempts.push(net.clock.t);
    until.push(e.until);
  });
  const closed = [];
  s.on('closed', (e) => closed.push(e));
  net.refuse = { code: ERR.NET, msg: 'offline' };
  const lostAt = net.clock.t;
  net.links[0].sever();
  await net.run(70000);
  const times = attempts.map((t) => (t - lostAt) / 1000);
  [0, 0.5, 1.5, 3.5, 7.5, 11.5, 15.5].forEach((want, i) => {
    // A retry resumes on the next frame, which adds up to one frame of drift per retry.
    assert.ok(Math.abs(times[i] - want) < 0.02 * (i + 1), `attempt ${i} at ${times[i]} s, wanted ${want}`);
  });
  assert.ok(times.at(-1) <= RECONNECT_GRACE_S - 5);
  assert.deepEqual(closed, [{ reason: CLOSE.NET_LOST }]);
  assert.equal(s.reconnecting, false);
  assert.equal(until[0], net.clock.wall() - net.clock.t + lostAt + (RECONNECT_GRACE_S - 5) * 1000);
});

test('a retry answered with noRoom ends with hostLeft at once in server mode', async () => {
  const net = new Net({ GameClass: FakeGame });
  const s = net.session();
  await net.dial(s);
  const closed = [];
  s.on('closed', (e) => closed.push(e));
  net.refuse = { code: ERR.NO_ROOM, msg: 'gone' };
  net.links[0].sever();
  await net.run(1000);
  assert.deepEqual(closed, [{ reason: CLOSE.HOST_LEFT }]);
});

test('P2P needs 3 consecutive noRoom results, because a blinking broker looks the same', async () => {
  const net = new Net({ GameClass: FakeGame, kind: 'p2p' });
  const s = net.session();
  await net.dial(s);
  const closed = [];
  s.on('closed', (e) => closed.push(e));
  const answers = [ERR.NO_ROOM, ERR.NO_ROOM, ERR.TIMEOUT, ERR.NO_ROOM, ERR.NO_ROOM, ERR.NO_ROOM];
  const dial = s._connectFn;
  let attempts = 0;
  s._connectFn = () => {
    const link = dial();
    link.connect = async () => {
      attempts += 1;
      throw { code: answers.shift() ?? ERR.NO_ROOM, msg: 'x' };
    };
    return link;
  };
  net.links[0].sever();
  await net.run(3000);
  assert.deepEqual(closed, [], 'two strikes are not enough');
  await net.run(30000);
  assert.deepEqual(closed, [{ reason: CLOSE.HOST_LEFT }]);
  assert.equal(attempts, 6, 'the streak restarted after a different answer');
});

test('a link that dies in the same tick as its WELCOME does not strand the session', async () => {
  const net = new Net({ GameClass: FakeGame });
  const s = net.session();
  await net.dial(s);
  const dial = s._connectFn;
  let doomed = true;
  s._connectFn = () => {
    const link = dial();
    if (doomed) {
      doomed = false;
      const realMessage = () => link.onmessage;
      const conn = link.conn;
      const send = conn.send;
      conn.send = (data) => {
        send(data);
        if (typeof data === 'string' && JSON.parse(data).t === MSG.WELCOME) {
          // Delivered back to back: nothing runs between WELCOME and the close.
          net.clock.setTimeout(() => {
            realMessage()?.(data);
            link.sever();
          }, 0);
          link.black = true;
        }
      };
    }
    return link;
  };
  const events = [];
  s.on('reconnected', () => events.push('reconnected'));
  s.on('closed', (e) => events.push(e.reason));
  net.links[0].sever();
  await net.run(4000);
  assert.equal(s.connected, true, 'a later retry finished the job');
  assert.equal(s.reconnecting, false);
  assert.ok(s.transport, 'and there is a live link');
  assert.deepEqual(events, ['reconnected']);
  s.leave();
});

test('a retry that finds the token kicked closes with kicked', async () => {
  const net = new Net({ GameClass: FakeGame });
  const host = net.session({ name: 'Host' });
  const s = net.session({ name: 'Guest' });
  await net.dial(host);
  await net.dial(s);
  const closed = [];
  s.on('closed', (e) => closed.push(e));
  net.links[1].sever();
  host.lobbyOp(LOBBY_OP.KICK, { id: s.me });
  await net.run(2000);
  assert.deepEqual(closed, [{ reason: CLOSE.KICKED }]);
  host.leave();
});

test('the local and p2pHost transports never retry', async () => {
  for (const kind of ['local', 'p2pHost']) {
    const net = new Net({ GameClass: FakeGame, kind });
    const s = net.session();
    await net.dial(s);
    const closed = [];
    const retrying = [];
    s.on('closed', (e) => closed.push(e));
    s.on('reconnecting', (e) => retrying.push(e));
    net.links[0].sever();
    await net.run(2000);
    assert.deepEqual(closed, [{ reason: CLOSE.NET_LOST }]);
    assert.deepEqual(retrying, []);
    assert.equal(net.links.length, 1);
  }
});

test('KICKED, CLOSED replaced and CLOSED hostLeft each close exactly once with no retry', async () => {
  for (const [send, want] of [
    [{ t: MSG.KICKED }, CLOSE.KICKED],
    [{ t: MSG.CLOSED, reason: CLOSE.REPLACED }, CLOSE.REPLACED],
    [{ t: MSG.CLOSED, reason: CLOSE.HOST_LEFT }, CLOSE.HOST_LEFT],
    [{ t: MSG.CLOSED, reason: CLOSE.RATE }, CLOSE.RATE],
    [{ t: MSG.CLOSED, reason: 'garbled' }, CLOSE.NET_LOST],
  ]) {
    const net = new Net({ GameClass: FakeGame });
    const s = net.session();
    await net.dial(s);
    const closed = [];
    s.on('closed', (e) => closed.push(e));
    net.links[0].conn.send(JSON.stringify(send));
    net.links[0].conn.close('bye');
    await net.run(3000);
    assert.deepEqual(closed, [{ reason: want }]);
    assert.equal(net.links.length, 1, 'no retry');
  }
});

test('a second tab with the same token replaces the first', async () => {
  const net = new Net({ GameClass: FakeGame });
  const first = net.session();
  await net.dial(first);
  const closed = [];
  first.on('closed', (e) => closed.push(e));
  const second = net.session({ token: first.token });
  await net.dial(second);
  await net.run(100);
  assert.deepEqual(closed, [{ reason: CLOSE.REPLACED }]);
  assert.equal(second.me, first.me);
  second.leave();
});

// ---- watchdog -------------------------------------------------------------------------------------

test('watchdog in a match: 4 s of silence is a hiccup, 10 s starts a reconnect', async () => {
  const { net, s } = await liveMatch();
  net.links[0].black = true;
  await net.run(3400, () => s.setFrameInput(neutral()));
  assert.equal(s.connected, true);
  await net.run(1200, () => s.setFrameInput(neutral()));
  assert.equal(s.connected, false, 'hiccup');
  assert.equal(s.reconnecting, false);
  await net.run(4800, () => s.setFrameInput(neutral()));
  assert.equal(s.reconnecting, false);
  await net.run(1200, () => s.setFrameInput(neutral()));
  assert.equal(s.reconnecting, true);
  await net.run(1000, () => s.setFrameInput(neutral()));
  assert.equal(s.connected, true, 'the retry worked');
  s.leave();
});

test('watchdog recovers from a hiccup the moment anything arrives', async () => {
  const { net, s } = await liveMatch();
  const link = net.links[0];
  link.black = true;
  await net.run(5000, () => s.setFrameInput(neutral()));
  assert.equal(s.connected, false);
  link.black = false;
  await net.run(200, () => s.setFrameInput(neutral()));
  assert.equal(s.connected, true);
  assert.equal(s.netStatus, 'ok');
  s.leave();
});

test('watchdog in the lobby: silence is fine, only a PING unanswered for 10 s counts', async () => {
  const net = new Net({ GameClass: FakeGame });
  const s = net.session();
  await net.dial(s);
  const retries = [];
  s.on('reconnecting', (e) => retries.push(e));
  await net.run(30000);
  assert.equal(s.connected, true, 'a quiet lobby with PONGs is healthy');
  assert.equal(retries.length, 0);
  net.links[0].black = true;
  await net.run(9000);
  assert.equal(retries.length, 0, 'not yet');
  await net.run(3500);
  assert.ok(retries.length > 0, 'a PING went unanswered for 10 s');
  s.leave();
});

test('watchdog ignores silence for 3 s after the tab returns', async () => {
  const { net, s } = await liveMatch();
  const link = net.links[0];
  const retries = [];
  s.on('reconnecting', (e) => retries.push(e));
  s.setBackground(true);
  link.black = true;
  await net.run(9500);
  s.setBackground(false);
  // The link stays quiet past the 10 s mark: without the grace this would start a reconnect.
  await net.run(2500, () => s.setFrameInput(neutral()));
  assert.deepEqual(retries, [], 'still inside the 3 s grace');
  link.black = false;
  await net.run(1000, () => s.setFrameInput(neutral()));
  assert.equal(s.connected, true);
  assert.deepEqual(retries, []);
  s.leave();
});

test('once the 3 s grace ends, real silence is acted on at once', async () => {
  const { net, s } = await liveMatch();
  const retries = [];
  s.on('reconnecting', (e) => retries.push(e));
  s.setBackground(true);
  net.links[0].black = true;
  await net.run(9500);
  s.setBackground(false);
  await net.run(3600, () => s.setFrameInput(neutral()));
  assert.ok(retries.length > 0);
  s.leave();
});

test('PING is on its own timer and never needs update()', async () => {
  const net = new Net({ GameClass: FakeGame, oneWayMs: 25 });
  const s = net.session();
  await net.dial(s);
  const link = net.links[0];
  const pings = () => link.sentByClient.filter((d) => typeof d === 'string' && JSON.parse(d).t === MSG.PING).length;
  const before = pings();
  for (let i = 0; i < 300; i++) {
    net.clock.run(net.clock.t + 20);
    net.room.update(net.clock.t);
    await settle();
  }
  assert.equal(pings() - before, 3);
  assert.ok(Math.abs(s.ping - 50) < 5, `ping ${s.ping}`);
  s.leave();
});

test('solo: a local room runs with no watchdog and the hidden pause is honored', async () => {
  const net = new Net({ kind: 'local', solo: true });
  const s = net.session();
  await net.dial(s);
  await net.startMatch(s);
  net.links[0].setPaused = (on) => net.room.setPaused(on);
  s.setPaused(true);
  const tick = net.room.game.tick;
  await net.run(12000);
  assert.equal(net.room.game.tick, tick, 'paused');
  assert.equal(s.connected, true, 'no watchdog on a local transport');
  assert.equal(s.reconnecting, false);
  s.leave();
});

// ---- a real server -----------------------------------------------------------------------------------

async function boot(opts = {}) {
  // Port 8101 is ours; 0 keeps a second suite running beside this one from colliding.
  for (const port of [8101, 8106, 0]) {
    try {
      return await startServer({ port, host: '127.0.0.1', log: () => {}, ...opts });
    } catch (err) {
      if (err.code !== 'EADDRINUSE') throw err;
    }
  }
  throw new Error('no port');
}

const wsUrl = (srv, query) => `ws://127.0.0.1:${srv.port}/ws?${query}`;

function rawClient(url, opts) {
  const ws = new WS(url, { perMessageDeflate: false, ...opts });
  ws.binaryType = 'arraybuffer';
  ws.msgs = [];
  ws.on('message', (data, isBinary) => ws.msgs.push(isBinary ? data : JSON.parse(data.toString())));
  ws.on('error', () => {});
  ws.opened = new Promise((done) => ws.once('open', done));
  ws.closedAt = new Promise((done) => ws.once('close', (code, reason) => done({ code, reason: reason.toString() })));
  return ws;
}

const until = async (check, what, ms = 10000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = check();
    if (v) return v;
    await sleep(10);
  }
  throw new Error(`timed out waiting for ${what}`);
};

const jsonOf = (ws, t) => ws.msgs.filter((m) => m?.t === t);

async function helloRoom(srv, name = 'Kid') {
  const ws = rawClient(wsUrl(srv, 'create=1'));
  await ws.opened;
  ws.send(JSON.stringify({ t: MSG.HELLO, v: PROTOCOL_VERSION, name, look: {} }));
  await until(() => jsonOf(ws, MSG.WELCOME)[0], 'WELCOME');
  return ws;
}

// Real Sessions hold real timers, so a test that fails halfway must still release them.
async function withRealTime(opts, body) {
  const srv = await boot(opts);
  const release = [];
  const keep = (fn) => release.push(fn);
  const session = (connect, name) => {
    const s = new Session(connect, { name, look: {} });
    keep(() => s.leave());
    return s;
  };
  const every = (ms, fn) => {
    const timer = setInterval(fn, ms);
    keep(() => clearInterval(timer));
  };
  try {
    await body({ srv, session, every });
  } finally {
    for (const fn of release.reverse()) fn();
    await srv.close();
  }
}

test('server: create, join, lobby and a match over real sockets with real Sessions', async () => {
  await withRealTime({ GameClass: FakeGame }, async ({ srv, session, every }) => {
    const host = session(() => new WsTransport(wsUrl(srv, 'create=1')), 'Host');
    await host.start();
    assert.equal(srv.rooms.size, 1);
    const code = host.roomCode;
    const guest = session(() => new WsTransport(wsUrl(srv, `room=${code}`)), 'Guest');
    await guest.start();
    await until(() => host.lobby?.players.length === 2, 'lobby sync');
    every(16, () => {
      host.update(0.016);
      guest.update(0.016);
    });
    host.lobbyOp(LOBBY_OP.START);
    await until(() => host.inMatch && guest.inMatch, 'match start');
    await until(() => guest.view.me && host.view.me, 'first snapshots');
    assert.equal(guest.view.actors.length, 2);
  });
});

test('server: ws?room with no such room answers noRoom; start rejects with that code', async () => {
  const srv = await boot();
  try {
    const s = new Session(() => new WsTransport(wsUrl(srv, 'room=ZZZZ')), { name: 'Lost', look: {} });
    await assert.rejects(s.start(), (e) => e.code === ERR.NO_ROOM);
    for (const q of ['room=', 'room=A', 'room=<script>', '', 'room=%00%00%00%00']) {
      const ws = rawClient(wsUrl(srv, q));
      await ws.closedAt;
      assert.equal(ws.msgs[0]?.code, ERR.NO_ROOM, q);
    }
  } finally {
    await srv.close();
  }
});

test('server: the socket lives at any path ending in ws, and nowhere else', async () => {
  const srv = await boot();
  try {
    const ok = rawClient(`ws://127.0.0.1:${srv.port}/sub/dir/ws?create=1`);
    await ok.opened;
    ok.close();
    const bad = new WS(`ws://127.0.0.1:${srv.port}/nope`);
    const outcome = await new Promise((done) => {
      bad.on('open', () => done('open'));
      bad.on('error', () => done('refused'));
    });
    assert.equal(outcome, 'refused');
  } finally {
    await srv.close();
  }
});

test('server: api/info reports the game', async () => {
  const srv = await boot();
  try {
    const a = await helloRoom(srv);
    const info = await (await fetch(`http://127.0.0.1:${srv.port}/api/info`)).json();
    assert.equal(info.game, GAME_NAME);
    assert.equal(info.version, PROTOCOL_VERSION);
    assert.equal(info.rooms, 1);
    assert.equal(info.players, 1);
    assert.ok(info.lanUrl === null || /^http:\/\/[\d.]+:\d+\/$/.test(info.lanUrl), String(info.lanUrl));
    const sub = await fetch(`http://127.0.0.1:${srv.port}/some/sub/path/api/info`);
    assert.equal((await sub.json()).game, GAME_NAME);
    const post = await fetch(`http://127.0.0.1:${srv.port}/api/info`, { method: 'POST' });
    assert.equal(post.status, 405);
    a.close();
  } finally {
    await srv.close();
  }
});

test('hostile: a frame over the size cap kills that conn and nothing else', async () => {
  const srv = await boot({ GameClass: FakeGame });
  try {
    const honest = await helloRoom(srv, 'Honest');
    const code = jsonOf(honest, MSG.WELCOME)[0].code;
    const evil = rawClient(wsUrl(srv, `room=${code}`));
    await evil.opened;
    evil.send(JSON.stringify({ t: MSG.HELLO, v: PROTOCOL_VERSION, name: 'Evil', look: {} }));
    await until(() => jsonOf(evil, MSG.WELCOME)[0], 'WELCOME');
    evil.send(Buffer.alloc(MAX_INBOUND_BYTES + 1, 0x41));
    const closed = await evil.closedAt;
    assert.equal(closed.code, 1009);
    const text = rawClient(wsUrl(srv, `room=${code}`));
    await text.opened;
    text.send('x'.repeat(5 * 1024 * 1024));
    assert.equal((await text.closedAt).code, 1009);
    honest.send(JSON.stringify({ t: MSG.PING, c: 1 }));
    await until(() => jsonOf(honest, MSG.PONG)[0], 'PONG after the attack');
    honest.close();
  } finally {
    await srv.close();
  }
});

test('hostile: garbage as a first message is refused, garbage later costs three strikes', async () => {
  const srv = await boot({ GameClass: FakeGame });
  try {
    const honest = await helloRoom(srv);
    const code = jsonOf(honest, MSG.WELCOME)[0].code;
    const first = rawClient(wsUrl(srv, `room=${code}`));
    await first.opened;
    first.send(Buffer.from([0xff, 0x00, 0x13, 0x37]));
    await first.closedAt;
    assert.equal(first.msgs[0].code, ERR.BAD_MSG);

    const later = rawClient(wsUrl(srv, `room=${code}`));
    await later.opened;
    later.send(JSON.stringify({ t: MSG.HELLO, v: PROTOCOL_VERSION, name: 'Junk', look: {} }));
    await until(() => jsonOf(later, MSG.WELCOME)[0], 'WELCOME');
    later.send('{{{{');
    later.send(Buffer.from([9, 9, 9]));
    later.send('[]');
    await later.closedAt;
    assert.ok(jsonOf(later, MSG.ERROR).some((m) => m.code === ERR.BAD_MSG));
    honest.close();
  } finally {
    await srv.close();
  }
});

test('hostile: a HELLO flood on one socket changes nothing, then gets it dropped for rate', async () => {
  const srv = await boot({ GameClass: FakeGame });
  try {
    const flood = await helloRoom(srv, 'Flood');
    const room = [...srv.rooms.values()][0];
    const hello = JSON.stringify({ t: MSG.HELLO, v: PROTOCOL_VERSION, name: 'Again', look: {} });
    for (let i = 0; i < 2000; i++) flood.send(hello);
    const closed = await flood.closedAt;
    assert.equal(closed.code, 4000);
    assert.equal(jsonOf(flood, MSG.CLOSED).at(-1).reason, CLOSE.RATE);
    assert.equal(room.slots.size, 1, 'no extra slots');
    assert.equal(jsonOf(flood, MSG.WELCOME).length, 1);
    assert.equal(room.slots.get(1).name, 'Flood');
  } finally {
    await srv.close();
  }
});

test('hostile: a HELLO flood across many sockets fills the room and no further', async () => {
  const srv = await boot({ GameClass: FakeGame });
  try {
    const first = await helloRoom(srv);
    const code = jsonOf(first, MSG.WELCOME)[0].code;
    const sockets = [];
    for (let i = 0; i < 40; i++) {
      const ws = rawClient(wsUrl(srv, `room=${code}`));
      sockets.push(ws);
      ws.once('open', () => ws.send(JSON.stringify({ t: MSG.HELLO, v: PROTOCOL_VERSION, name: `F${i}`, look: {} })));
    }
    await until(() => sockets.filter((w) => w.msgs.length > 0).length === sockets.length, 'every socket to get an answer');
    const answers = sockets.map((w) => (w.msgs[0].t === MSG.ERROR ? w.msgs[0].code : w.msgs[0].t));
    assert.equal(answers.filter((a) => a === MSG.WELCOME).length, 7, '7 more humans fill the room');
    assert.equal(answers.filter((a) => a === MSG.WELCOME || a === ERR.ROOM_FULL || a === ERR.SERVER_FULL).length, 40);
    assert.equal(srv.rooms.get(code).slots.size, 8);
    for (const w of sockets) w.terminate();
    first.close();
  } finally {
    await srv.close();
  }
});

test('limits: sockets from one IP stop at MAX_CONNS_PER_IP, silent ones included', async () => {
  const srv = await boot({ GameClass: FakeGame });
  try {
    const first = await helloRoom(srv);
    const code = jsonOf(first, MSG.WELCOME)[0].code;
    const idle = [];
    for (let i = 0; i < MAX_CONNS_PER_IP - 1; i++) {
      const ws = rawClient(wsUrl(srv, `room=${code}`));
      await ws.opened;
      idle.push(ws);
    }
    const over = rawClient(wsUrl(srv, `room=${code}`));
    await over.closedAt;
    assert.equal(over.msgs[0].code, ERR.SERVER_FULL);
    for (const w of idle) w.terminate();
    first.close();
  } finally {
    await srv.close();
  }
});

test('hostile: random binary and text noise from one client never disturbs another', async () => {
  const srv = await boot({ GameClass: FakeGame });
  try {
    const honest = await helloRoom(srv, 'Honest');
    const code = jsonOf(honest, MSG.WELCOME)[0].code;
    const rng = seeded(4);
    honest.send(JSON.stringify({ t: MSG.LOBBY, op: LOBBY_OP.START }));
    await until(() => honest.msgs.some((m) => m instanceof ArrayBuffer), 'snapshots');
    const noise = () => {
      const bytes = Buffer.alloc(Math.floor(rng() * 300));
      for (let j = 0; j < bytes.length; j++) bytes[j] = Math.floor(rng() * 256);
      if (rng() < 0.3 && bytes.length > 0) bytes[0] = BIN.INPUT;
      return rng() < 0.5 ? bytes : bytes.toString('latin1');
    };
    // A client dropped after HELLO rightly keeps its slot for the grace period, so only
    // seven of these fit in the room.
    for (let round = 0; round < 7; round++) {
      const evil = rawClient(wsUrl(srv, `room=${code}`));
      await evil.opened;
      evil.send(JSON.stringify({ t: MSG.HELLO, v: PROTOCOL_VERSION, name: 'Noise', look: {} }));
      await until(() => jsonOf(evil, MSG.WELCOME)[0], 'WELCOME');
      for (let i = 0; i < 50 && evil.readyState === 1; i++) evil.send(noise());
      await evil.closedAt;
    }
    for (let round = 0; round < 60; round++) {
      const evil = rawClient(wsUrl(srv, `room=${code}`));
      await evil.opened;
      evil.send(noise());
      await evil.closedAt;
    }
    const before = honest.msgs.filter((m) => m instanceof ArrayBuffer).length;
    await until(() => honest.msgs.filter((m) => m instanceof ArrayBuffer).length > before + 3, 'the match to keep running');
    honest.close();
  } finally {
    await srv.close();
  }
});

test('hostile: invalid UTF-8 and bad frame opcodes close the socket, not the server', async () => {
  const srv = await boot();
  try {
    const honest = await helloRoom(srv);
    const sock = tcpConnect(srv.port, '127.0.0.1');
    await new Promise((done) => sock.once('connect', done));
    sock.on('error', () => {});
    sock.write('GET /ws?create=1 HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n');
    await new Promise((done) => sock.once('data', done));
    const mask = Buffer.from([1, 2, 3, 4]);
    const payload = Buffer.from([0xc3, 0x28]);
    const masked = Buffer.from(payload.map((b, i) => b ^ mask[i % 4]));
    sock.write(Buffer.concat([Buffer.from([0x81, 0x80 | payload.length]), mask, masked]));
    sock.write(Buffer.from([0x8f, 0x80, 0, 0, 0, 0]));
    await new Promise((done) => sock.once('close', done));
    const bad = tcpConnect(srv.port, '127.0.0.1');
    await new Promise((done) => bad.once('connect', done));
    bad.on('error', () => {});
    bad.resume();
    bad.write('GET /ws?create=1 HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 99\r\n\r\n');
    await new Promise((done) => bad.once('close', done));
    honest.send(JSON.stringify({ t: MSG.PING, c: 2 }));
    await until(() => jsonOf(honest, MSG.PONG)[0], 'server alive');
    honest.close();
  } finally {
    await srv.close();
  }
});

test('limits: rooms per IP and the X-Forwarded-For opt-in', async () => {
  const srv = await boot();
  try {
    const held = [];
    for (let i = 0; i < MAX_ROOMS_PER_IP; i++) held.push(await helloRoom(srv));
    const over = rawClient(wsUrl(srv, 'create=1'));
    await over.closedAt;
    assert.equal(over.msgs[0].code, ERR.SERVER_FULL);
    const spoof = rawClient(wsUrl(srv, 'create=1'), { headers: { 'X-Forwarded-For': '9.9.9.9' } });
    await spoof.closedAt;
    assert.equal(spoof.msgs[0].code, ERR.SERVER_FULL, 'the header is ignored unless configured');
    for (const w of held) w.close();
  } finally {
    await srv.close();
  }
  const trusting = await boot({ trustProxy: true });
  try {
    const clients = [];
    for (let i = 0; i < MAX_ROOMS_PER_IP + 2; i++) {
      const ws = rawClient(wsUrl(trusting, 'create=1'), { headers: { 'X-Forwarded-For': `10.0.0.${i}, 1.1.1.1` } });
      await ws.opened;
      clients.push(ws);
    }
    await until(() => trusting.rooms.size === MAX_ROOMS_PER_IP + 2, 'rooms from distinct forwarded IPs');
    for (const w of clients) w.close();
  } finally {
    await trusting.close();
  }
});

test('limits: MAX_ROOMS holds across every IP', async () => {
  const srv = await boot({ trustProxy: true });
  try {
    const held = [];
    for (let i = 0; i < MAX_ROOMS; i++) {
      const ws = rawClient(wsUrl(srv, 'create=1'), { headers: { 'X-Forwarded-For': `10.1.${Math.floor(i / 4)}.1` } });
      held.push(ws);
      await ws.opened;
    }
    assert.equal(srv.rooms.size, MAX_ROOMS);
    const over = rawClient(wsUrl(srv, 'create=1'), { headers: { 'X-Forwarded-For': '10.9.9.9' } });
    await over.closedAt;
    assert.equal(over.msgs[0].code, ERR.SERVER_FULL);
    for (const w of held) w.terminate();
  } finally {
    await srv.close();
  }
});

test('limits: 20 bad codes in a minute refuse that IP for 5 minutes, and only that long', async () => {
  const srv = await boot();
  const realNow = Date.now;
  let skew = 0;
  Date.now = () => realNow() + skew;
  const tryCode = async () => {
    const ws = rawClient(wsUrl(srv, 'room=ZZZZ'));
    await ws.closedAt;
    return ws.msgs[0].code;
  };
  try {
    for (let i = 0; i < 19; i++) assert.equal(await tryCode(), ERR.NO_ROOM);
    skew += 61000;
    assert.equal(await tryCode(), ERR.NO_ROOM, 'older hits fell out of the minute');
    for (let i = 0; i < 18; i++) assert.equal(await tryCode(), ERR.NO_ROOM);
    assert.equal(await tryCode(), ERR.NO_ROOM, 'the 20th inside the window still gets its answer');
    assert.equal(await tryCode(), ERR.RATE, 'then the IP is refused');
    const refused = rawClient(wsUrl(srv, 'create=1'));
    await refused.closedAt;
    assert.equal(refused.msgs[0].code, ERR.RATE, 'for everything, not just bad codes');
    skew += 4 * 60000;
    assert.equal(await tryCode(), ERR.RATE, 'four minutes later, still refused');
    skew += 60000 + 1000;
    assert.equal(await tryCode(), ERR.NO_ROOM, 'after five, it is forgiven');
  } finally {
    Date.now = realNow;
    await srv.close();
  }
});

test('limits: a closing socket gives its slot back to the per-IP count', async () => {
  const srv = await boot();
  try {
    for (let round = 0; round < 3; round++) {
      const a = await helloRoom(srv);
      const code = jsonOf(a, MSG.WELCOME)[0].code;
      const batch = [];
      for (let i = 0; i < MAX_CONNS_PER_IP - 1; i++) {
        const ws = rawClient(wsUrl(srv, `room=${code}`));
        await ws.opened;
        batch.push(ws);
      }
      await sleep(20);
      for (const w of batch) w.terminate();
      a.terminate();
      await sleep(100);
    }
  } finally {
    await srv.close();
  }
});

test('liveness: a client that stops answering pings is terminated and goes AFK', async () => {
  const srv = await boot({ GameClass: FakeGame, pingEveryMs: 100, pongDeadlineMs: 1000 });
  try {
    const healthy = await helloRoom(srv, 'Awake');
    const code = jsonOf(healthy, MSG.WELCOME)[0].code;
    const dead = rawClient(wsUrl(srv, `room=${code}`), { autoPong: false });
    await dead.opened;
    dead.send(JSON.stringify({ t: MSG.HELLO, v: PROTOCOL_VERSION, name: 'Crashed', look: {} }));
    await until(() => jsonOf(dead, MSG.WELCOME)[0], 'WELCOME');
    await until(() => jsonOf(healthy, MSG.LOBBY_STATE).at(-1).players.find((p) => p.name === 'Crashed')?.connected === false, 'the drop');
    assert.equal(healthy.readyState, 1, 'pongs keep a live client connected');
    assert.equal(srv.rooms.get(code).slots.size, 2, 'it keeps the slot for reconnect');
    healthy.close();
  } finally {
    await srv.close();
  }
});

test('back-pressure: snapshots are skipped, JSON is not, and a full pipe kills the conn', () => {
  const sent = [];
  let slow = 0;
  const ws = { readyState: 1, bufferedAmount: 0, send: (d) => sent.push(d), close() {} };
  const conn = makeWsConn(1, ws, () => { slow += 1; });
  const snap = () => encodeSnapshot({ tick: 2, ack: 0, you: null, actors: [] });
  conn.send(snap());
  assert.equal(sent.length, 1);
  ws.bufferedAmount = SNAP_DROP_BYTES + 1;
  conn.send(snap());
  assert.equal(sent.length, 1, 'snapshot skipped');
  conn.send('{"t":"meta"}');
  assert.equal(sent.length, 2, 'JSON still goes');
  ws.bufferedAmount = CONN_KILL_BYTES + 1;
  conn.send('{"t":"meta"}');
  assert.equal(sent.length, 2);
  assert.equal(slow, 1);
  ws.readyState = 3;
  ws.bufferedAmount = 0;
  conn.send('{"t":"meta"}');
  assert.equal(sent.length, 2, 'a closed socket swallows sends');
});

test('back-pressure: a real client that stops reading never stalls the host or its peers', async () => {
  const srv = await boot({ GameClass: FakeGame });
  try {
    const honest = await helloRoom(srv, 'Reader');
    const code = jsonOf(honest, MSG.WELCOME)[0].code;
    const stuck = rawClient(wsUrl(srv, `room=${code}`));
    await stuck.opened;
    stuck.send(JSON.stringify({ t: MSG.HELLO, v: PROTOCOL_VERSION, name: 'Stuck', look: {} }));
    await until(() => jsonOf(stuck, MSG.WELCOME)[0], 'WELCOME');
    stuck._socket.pause();
    honest.send(JSON.stringify({ t: MSG.LOBBY, op: LOBBY_OP.START }));
    await until(() => honest.msgs.some((m) => m instanceof ArrayBuffer), 'snapshots');
    const before = honest.msgs.length;
    await until(() => honest.msgs.length - before >= 6, 'snapshots to keep flowing to the honest client');
    stuck.terminate();
    honest.close();
  } finally {
    await srv.close();
  }
});

// ---- the static handler ----------------------------------------------------------------------------

function rawRequest(port, lines) {
  return new Promise((done, fail) => {
    const sock = tcpConnect(port, '127.0.0.1');
    let out = '';
    sock.on('data', (d) => { out += d.toString('latin1'); });
    sock.on('error', fail);
    sock.on('close', () => done({ status: Number(out.split(' ')[1]), head: out.split('\r\n\r\n')[0], body: out.split('\r\n\r\n').slice(1).join('\r\n\r\n') }));
    sock.write(`${lines}\r\nHost: x\r\nConnection: close\r\n\r\n`);
  });
}

test('static: path traversal in every spelling stays inside public/', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ff-static-'));
  const pub = join(dir, 'public');
  mkdirSync(join(pub, 'sub'), { recursive: true });
  writeFileSync(join(pub, 'index.html'), '<!doctype html><title>home</title>');
  writeFileSync(join(pub, 'sub', 'ok.js'), 'export const ok = 1;');
  writeFileSync(join(dir, 'secret.txt'), 'TOP-SECRET');
  symlinkSync(join(dir, 'secret.txt'), join(pub, 'escape.txt'));
  symlinkSync(dir, join(pub, 'escape-dir'));
  const srv = await boot({ publicDir: pub });
  try {
    const attacks = [
      '/../secret.txt', '/../../secret.txt', '/sub/../../secret.txt', '/./../secret.txt', '/sub/../../../../../../etc/passwd',
      '/..%2fsecret.txt', '/%2e%2e/secret.txt', '/%2e%2e%2fsecret.txt', '/..%2F..%2Fsecret.txt', '/%2E%2E%2Fsecret.txt',
      '/sub/%2e%2e/%2e%2e/secret.txt', '/..%5csecret.txt', '/..\\secret.txt', '/....//secret.txt', '/..%252fsecret.txt',
      '/%252e%252e/secret.txt', '/..%00/secret.txt', '/secret.txt%00.html', '/%00', '/%', '/%zz', '/%E0%A4%A', '/%c0%ae%c0%ae/secret.txt',
      '//secret.txt', '/escape.txt', '/escape-dir/secret.txt', '/sub/../escape.txt',
    ];
    for (const path of attacks) {
      const res = await rawRequest(srv.port, `GET ${path} HTTP/1.1`);
      assert.ok(!res.body.includes('TOP-SECRET'), `${path} leaked the file`);
      assert.ok(res.status === 404 || res.status === 400, `${path} answered ${res.status}`);
    }
  } finally {
    await srv.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('static: GET and HEAD only, with correct types, and directories give index.html', async () => {
  const srv = await boot();
  try {
    const js = await rawRequest(srv.port, 'GET /shared/schema.js HTTP/1.1');
    assert.equal(js.status, 200);
    assert.match(js.head, /content-type: text\/javascript/i);
    assert.match(js.head, /x-content-type-options: nosniff/i);
    assert.ok(js.body.includes('PROTOCOL_VERSION'));
    const head = await rawRequest(srv.port, 'HEAD /shared/schema.js HTTP/1.1');
    assert.equal(head.status, 200);
    assert.equal(head.body, '');
    assert.match(head.head, /content-length: \d+/i);
    for (const verb of ['POST', 'PUT', 'DELETE', 'OPTIONS', 'TRACE', 'PATCH']) {
      const res = await rawRequest(srv.port, `${verb} /shared/schema.js HTTP/1.1`);
      assert.equal(res.status, 405, verb);
    }
    assert.equal((await rawRequest(srv.port, 'GET /no/such/file.js HTTP/1.1')).status, 404);
    assert.equal((await rawRequest(srv.port, 'GET /shared/schema.js?v=1#frag HTTP/1.1')).status, 200);
    const encoded = await rawRequest(srv.port, 'GET /shared/sch%65ma.js HTTP/1.1');
    assert.equal(encoded.status, 200, 'normal percent-encoding still works');
  } finally {
    await srv.close();
  }
});

// ---- real time ---------------------------------------------------------------------------------------

// A real ws transport with one-way delay and jitter on both directions.
class LaggyWs {
  constructor(url, oneWayMs, jitterMs, rng) {
    this.inner = new WsTransport(url);
    this.kind = this.inner.kind;
    this.oneWayMs = oneWayMs;
    this.jitterMs = jitterMs;
    this.rng = rng;
    this.lastIn = 0;
    this.lastOut = 0;
    this.inbound = [];
    this.outbound = [];
    this.onmessage = null;
    this.onclose = null;
    // Each timer takes the oldest message, not the one it was set for. Node truncates delays and
    // reads a cached clock, so two timers aimed at one moment can fire swapped, and a socket
    // never reorders: a swapped START and FULL is a failure no real connection can produce.
    this.inner.onmessage = (d) => {
      this.lastIn = this._when(this.lastIn);
      this.inbound.push(d);
      setTimeout(() => this.onmessage?.(this.inbound.shift()), this.lastIn - Date.now());
    };
    this.inner.onclose = (r) => this.onclose?.(r);
  }

  _when(last) {
    return Math.max(last, Date.now() + this.oneWayMs + this.rng() * this.jitterMs);
  }

  connect() {
    return this.inner.connect();
  }

  send(data) {
    this.lastOut = this._when(this.lastOut);
    this.outbound.push(data);
    setTimeout(() => this.inner.send(this.outbound.shift()), this.lastOut - Date.now());
  }

  close() {
    this.inner.close();
  }
}

// The strict numbers live in the virtual-time sweep above, where nothing can disturb them.
// This one runs beside the rest of the suite on a shared machine, so it asserts that the
// real-clock path converges at all, with margins that a loaded CPU cannot trip.
test('real time: prediction converges over a real server with 120 ms RTT and jitter', async () => {
  await withRealTime({}, async ({ srv, session, every }) => {
    const rng = seeded(21);
    const s = session(() => new LaggyWs(wsUrl(srv, 'create=1'), 60, 25, rng), 'Lag');
    await s.start();
    let last = performance.now();
    let frame = 0;
    let walking = true;
    every(16, () => {
      const now = performance.now();
      s.setFrameInput(walking ? walk(frame) : neutral());
      frame += 1;
      s.update((now - last) / 1000);
      last = now;
    });
    s.lobbyOp(LOBBY_OP.START);
    await until(() => s.view.me, 'own actor');
    const room = [...srv.rooms.values()][0];
    const errors = [];
    const stopAt = Date.now() + 3000;
    while (Date.now() < stopAt) {
      await sleep(50);
      const kid = room.game.actors.get(s.me);
      // The prediction leads the host by about one trip, so compare against the extrapolation.
      const lead = 0.09;
      errors.push(Math.hypot(kid.x + kid.vx * lead - s.view.me.x, kid.y + kid.vy * lead - s.view.me.y));
    }
    errors.sort((a, b) => a - b);
    const median = errors[Math.floor(errors.length / 2)];
    assert.ok(median < 60, `median divergence ${median.toFixed(1)} units while walking at 205 u/s`);
    walking = false;
    await until(() => {
      const kid = room.game.actors.get(s.me);
      return Math.hypot(kid.x - s.view.me.x, kid.y - s.view.me.y) < 1;
    }, 'the client to settle on the host position');
    assert.ok(s.ping > 80, `measured ping ${s.ping}`);
  });
});

test('real time: a killed socket reconnects through the real server and reclaims the slot', async () => {
  await withRealTime({ GameClass: FakeGame }, async ({ srv, session, every }) => {
    const host = session((code) => new WsTransport(wsUrl(srv, code ? `room=${code}` : 'create=1')), 'Host');
    await host.start();
    const code = host.roomCode;
    const guest = session(() => new WsTransport(wsUrl(srv, `room=${code}`)), 'Guest');
    await guest.start();
    every(16, () => {
      host.update(0.016);
      guest.update(0.016);
    });
    host.lobbyOp(LOBBY_OP.START);
    await until(() => guest.view.me, 'guest kid');
    const me = guest.me;
    let reconnected = 0;
    guest.on('reconnected', () => { reconnected += 1; });
    for (const ws of srv.wss.clients) ws.terminate();
    await until(() => reconnected === 1 && guest.connected && host.connected, 'both back');
    assert.equal(guest.me, me);
    await until(() => host.reconnecting === false && srv.rooms.get(code).slots.size === 2, 'both slots live');
  });
});

test('real time: the 5 s HELLO deadline closes a silent socket', async () => {
  const srv = await boot();
  try {
    const first = await helloRoom(srv);
    const code = jsonOf(first, MSG.WELCOME)[0].code;
    const started = Date.now();
    const mute = rawClient(wsUrl(srv, `room=${code}`));
    await mute.opened;
    await mute.closedAt;
    const waited = Date.now() - started;
    assert.ok(waited > 4900 && waited < 9000, `closed after ${waited} ms`);
    first.close();
  } finally {
    await srv.close();
  }
});
