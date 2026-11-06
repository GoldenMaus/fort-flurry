// Simulation core tests: rng, physics, flow field and the Game (SPEC 2, 3, 4, 7, 10).
//
// Games here run on a small map of their own, so nothing depends on how the shipped maps
// are laid out. Foes that a test only needs as targets are stunned for the whole test,
// which keeps real AI out of the way without replacing it.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  ACTOR, AFLAG, AUX, BALL, BTN, CMD, DIFFICULTY, EV, MODE, PHASE, PICKUP, SFX, STRUCT, TEAM,
} from '../public/shared/schema.js';
import {
  BOSS, BUILD, CELL, DEMOLISH_REFUND, DIFF, DT, FAIR_SHARE, FFA, FOES, FORTWARS, KID, MAX_ACTORS, MAX_INPUT_BACKLOG,
  MAX_STRUCTS_PER_TEAM, REPAIR_COST_MUL, SIEGE, SIM_HZ, SPECIAL, TEAMMATE_DEMOLISH_COOLDOWN, TEAMMATE_DEMOLISH_RANGE, THROW,
} from '../public/shared/constants.js';
import { createRng } from '../public/shared/rng.js';
import {
  canPlace, collideCircle, createCollisionWorld, demolishState, raycastFlat, stepKidMotion,
} from '../public/shared/physics.js';
import { FlowField } from '../public/shared/flowfield.js';
import { Game } from '../public/shared/game.js';
import { MAPS } from '../public/shared/maps.js';
import { decodeInput, decodeSnapshot, encodeInput, encodeSnapshot } from '../public/shared/protocol.js';
import { CARDS, defaultMods, modsFromCards } from '../public/shared/cards.js';

// ---- fixtures -----------------------------------------------------------------

const near = (actual, expected, tolerance = 1e-9, label = '') => {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label} expected ${expected}, got ${actual}`);
};

const ring = (cx, cy, r, n) => Array.from({ length: n }, (_, i) => {
  const a = (i / n) * Math.PI * 2;
  return { x: Math.round(cx + r * Math.cos(a)), y: Math.round(cy + r * Math.sin(a)) };
});

function testMap(extra = {}) {
  return {
    id: 'test', theme: 'court', name: 'Test Court', blurb: '', w: 1200, h: 800,
    obstacles: [
      { type: 'house', shape: 'rect', x: 120, y: 120, w: 80, h: 80, blocksMove: true, blocksBalls: true, height: 110 },
      { type: 'tree', shape: 'circle', x: 1000, y: 160, r: 30, blocksMove: true, blocksBalls: true, height: 120 },
      { type: 'fence', shape: 'rect', x: 880, y: 600, w: 160, h: 10, blocksMove: true, blocksBalls: false, height: 42 },
      { type: 'swing', shape: 'rect', x: 160, y: 640, w: 40, h: 40, blocksMove: false, blocksBalls: false, height: 90 },
    ],
    ice: [
      { shape: 'ellipse', x: 340, y: 660, rx: 100, ry: 60 },
      { shape: 'rect', x: 760, y: 80, w: 120, h: 80 },
    ],
    fort: { x: 600, y: 400 },
    forts: [{ x: 240, y: 400 }, { x: 960, y: 400 }],
    truce: { axis: 'x', at: 600 },
    spawns: {
      siege: [
        { x: 520, y: 300 }, { x: 680, y: 300 }, { x: 520, y: 500 }, { x: 680, y: 500 },
        { x: 480, y: 340 }, { x: 720, y: 340 }, { x: 480, y: 460 }, { x: 720, y: 460 },
      ],
      fortwars: [
        Array.from({ length: 8 }, (_, i) => ({ x: 120, y: 260 + i * 40 })),
        Array.from({ length: 8 }, (_, i) => ({ x: 1080, y: 260 + i * 40 })),
      ],
      ffa: [
        { x: 100, y: 60 }, { x: 1100, y: 60 }, { x: 100, y: 740 }, { x: 1100, y: 740 },
        { x: 600, y: 60 }, { x: 600, y: 740 }, { x: 60, y: 400 }, { x: 1140, y: 400 },
      ],
    },
    entrances: [{ x: 20, y: 400 }, { x: 1180, y: 400 }, { x: 600, y: 780 }],
    truckPath: ring(600, 400, 300, 12),
    lights: [],
    decor: [],
    ...extra,
  };
}

const blankMap = (extra = {}) => testMap({ obstacles: [], ice: [], ...extra });

const human = (id, extra = {}) => ({ id, name: `Kid ${id}`, look: null, team: TEAM.A, isBot: false, ...extra });
const bot = (id, extra = {}) => human(id, { isBot: true, ...extra });

function siege(players = [human(1)], opts = {}) {
  return new Game({ mode: MODE.SIEGE, map: testMap(), difficulty: DIFFICULTY.NORMAL, waveCount: 5, seed: 7, players, ...opts });
}

function faceOff(players = [human(1), human(2, { team: TEAM.B })], opts = {}) {
  return new Game({ mode: MODE.FORTWARS, map: testMap(), difficulty: DIFFICULTY.NORMAL, seed: 7, players, ...opts });
}

function ffa(ids = [1, 2], opts = {}) {
  const players = ids.map((id, slot) => human(id, { team: TEAM.FFA_BASE + slot }));
  return new Game({ mode: MODE.FFA, map: testMap(), difficulty: DIFFICULTY.NORMAL, seed: 7, players, ...opts });
}

// Feeds a kid one input frame per tick, like a healthy connection.
class Pad {
  constructor(g, id) {
    this.g = g;
    this.id = id;
    this.seq = 0;
  }

  get kid() {
    return this.g.actors.get(this.id);
  }

  queue(over = {}) {
    this.seq += 1;
    const { kid } = this;
    this.g.queueInput(this.id, { seq: this.seq, mx: 0, my: 0, aim: kid.aim, btn: 0, tx: kid.x, ty: kid.y, ...over });
    return this.seq;
  }

  tick(over = {}, times = 1) {
    for (let i = 0; i < times; i++) {
      this.queue(over);
      this.g.step();
    }
    return this;
  }
}

// A target dummy: past its spawn GRACE and stunned, so no AI ever runs on it.
function dummy(g, kind, x, y, hp) {
  const foe = g.spawnFoe(kind, x, y);
  foe.flags &= ~AFLAG.GRACE;
  foe.graceT = 0;
  foe.stunT = 1e6;
  if (hp !== undefined) {
    foe.hp = hp;
    foe.maxHp = hp;
  }
  return foe;
}

const eventsOf = (g, kind) => g.drainEvents().filter((e) => e.e === kind);

function stepUntil(g, done, limit = 40000) {
  for (let i = 0; i < limit; i++) {
    if (done()) return;
    g.step();
    g.drainEvents();
  }
  assert.fail(`condition not reached within ${limit} ticks (tick ${g.tick}, phase ${g.phase}, wave ${g.wave})`);
}

// For loops that need their own per-tick work rather than a bare g.step().
function spin(tick, done, limit = 40000) {
  for (let i = 0; i < limit; i++) {
    if (done()) return;
    tick();
  }
  assert.fail(`condition not reached within ${limit} iterations`);
}

const startFight = (g) => stepUntil(g, () => g.phase === PHASE.FIGHT);

function clearFoes(g) {
  for (const foe of g.foes()) g.freezeOrFlee(foe, null);
}

// Beats the current wave however it is made up: everything that shows up gives up.
function beatWave(g) {
  const wave = g.wave;
  stepUntil(g, () => {
    clearFoes(g);
    return g.isOver() || g.wave !== wave;
  });
}

// ---- rng ----------------------------------------------------------------------

test('rng: a seed replays exactly, stays in [0,1), and nearby seeds diverge', () => {
  const a = createRng('deadbeef');
  const b = createRng('deadbeef');
  const c = createRng('deadbeee');
  let same = 0;
  for (let i = 0; i < 2000; i++) {
    const v = a();
    assert.equal(v, b());
    assert.ok(v >= 0 && v < 1);
    if (v === c()) same += 1;
  }
  assert.equal(same, 0);
  assert.equal(createRng(7)(), createRng('7')(), 'numbers and strings flatten alike');
});

test('rng: output is roughly uniform', () => {
  const rng = createRng(1);
  const buckets = new Array(10).fill(0);
  for (let i = 0; i < 50000; i++) buckets[Math.floor(rng() * 10)] += 1;
  for (const count of buckets) assert.ok(Math.abs(count - 5000) < 400, `bucket holds ${count}`);
});

// ---- stepKidMotion ------------------------------------------------------------

function motionKid(x = 400, y = 300, over = {}) {
  return { x, y, vx: 0, vy: 0, slideT: 0, slideCd: 0, boardT: 0, slowT: 0, stunT: 0, prevBtn: 0, flags: 0, mods: defaultMods(), ...over };
}

const walkFrame = (over = {}) => ({ mx: 0, my: 0, aim: 0, btn: 0, ...over });

function drive(cw, kid, frame, times) {
  for (let i = 0; i < times; i++) stepKidMotion(kid, frame, cw, DT);
  return kid;
}

function randomFrames(seed, count) {
  const rng = createRng(seed);
  const frames = [];
  let btn = 0;
  for (let i = 0; i < count; i++) {
    if (rng() < 0.15) btn = Math.floor(rng() * 16);
    frames.push({ mx: rng() * 2 - 1, my: rng() * 2 - 1, aim: rng() * Math.PI * 2, btn });
  }
  return frames;
}

test('stepKidMotion: mutates in place, returns the kid, touches nothing else', () => {
  const cw = createCollisionWorld(blankMap());
  const kid = motionKid();
  const frame = Object.freeze(walkFrame({ mx: 1 }));
  assert.equal(stepKidMotion(kid, frame, cw, DT), kid);
  assert.ok(kid.x > 400);
});

test('stepKidMotion: identical inputs from one state give bit-identical results', () => {
  const frames = randomFrames(11, 2000);
  const map = testMap();
  const run = () => {
    const cw = createCollisionWorld(map);
    cw.setStruct(12, 8, true, 1, 34);
    const kid = motionKid(520, 300, { slowT: 1, boardT: 2 });
    return frames.map((f) => ({ ...stepKidMotion(kid, f, cw, DT), mods: null }));
  };
  assert.deepEqual(run(), run());
});

test('stepKidMotion: replaying unacked frames from a snapshot lands exactly where the host did', () => {
  const map = testMap();
  const host = createCollisionWorld(map);
  const client = createCollisionWorld(map);
  for (const cw of [host, client]) cw.setStruct(10, 7, true, 1, 34);
  const frames = randomFrames(23, 600);
  const kid = motionKid(520, 300);
  for (let ack = 0; ack < frames.length; ack += 37) {
    // What a client reconciles from: the fields Session copies out of Actor and You.
    const snapshot = { ...kid, mods: kid.mods };
    const unacked = frames.slice(ack, ack + 37);
    for (const f of unacked) stepKidMotion(kid, f, host, DT);
    const predicted = { ...snapshot };
    for (const f of unacked) stepKidMotion(predicted, f, client, DT);
    assert.deepEqual(predicted, kid);
  }
});

test('stepKidMotion: walks up to KID.speed, and diagonals are no faster', () => {
  const cw = createCollisionWorld(blankMap());
  const straight = drive(cw, motionKid(), walkFrame({ mx: 1 }), 12);
  near(straight.vx, KID.speed, 1e-6);
  const diagonal = drive(cw, motionKid(), walkFrame({ mx: 1, my: 1 }), 12);
  near(Math.hypot(diagonal.vx, diagonal.vy), KID.speed, 1e-6);
});

test('stepKidMotion: drag stops a kid who lets go', () => {
  const cw = createCollisionWorld(blankMap());
  const kid = drive(cw, motionKid(), walkFrame({ mx: 1 }), 12);
  drive(cw, kid, walkFrame(), 20);
  assert.equal(kid.vx, 0);
});

test('stepKidMotion: charge slows you whatever the ammo; mods, board and slow all scale speed', () => {
  const cw = createCollisionWorld(blankMap());
  const top = (over, btn = 0) => drive(cw, motionKid(100, 300, over), walkFrame({ mx: 1, btn }), 14).vx;
  near(top({}, BTN.THROW), KID.speed * KID.chargeSpeedMul, 1e-6, 'throw');
  near(top({}, BTN.LOB), KID.speed * KID.chargeSpeedMul, 1e-6, 'lob');
  near(top({ mods: { ...defaultMods(), speedMul: 1.5 } }), KID.speed * 1.5, 1e-6, 'speedMul');
  near(top({ boardT: 5 }), KID.speed * KID.boardSpeedMul, 1e-6, 'board');
  near(top({ slowT: 5 }), KID.speed * KID.slowSpeedMul, 1e-6, 'slow');
});

test('stepKidMotion: FROZEN and LOCKED zero velocity, record prevBtn, and timers still run', () => {
  const cw = createCollisionWorld(blankMap());
  for (const flag of [AFLAG.FROZEN, AFLAG.LOCKED]) {
    const kid = motionKid(400, 300, { flags: flag, vx: 90, vy: -40, slideCd: 1, boardT: 1, slowT: 1, stunT: 1, slideT: 0.2 });
    stepKidMotion(kid, walkFrame({ mx: 1, btn: BTN.SLIDE }), cw, DT);
    assert.deepEqual([kid.x, kid.y, kid.vx, kid.vy], [400, 300, 0, 0]);
    assert.equal(kid.prevBtn, BTN.SLIDE);
    near(kid.slideCd, 1 - DT);
    near(kid.boardT, 1 - DT);
    near(kid.slowT, 1 - DT);
    near(kid.stunT, 1 - DT);
    near(kid.slideT, 0.2 - DT);
  }
});

test('stepKidMotion: only FROZEN and LOCKED are read from flags', () => {
  const cw = createCollisionWorld(blankMap());
  const flags = Object.values(AFLAG).reduce((all, f) => all | f, 0) & ~(AFLAG.FROZEN | AFLAG.LOCKED);
  const plain = drive(cw, motionKid(), walkFrame({ mx: 1 }), 5);
  const flagged = drive(cw, motionKid(400, 300, { flags }), walkFrame({ mx: 1 }), 5);
  assert.equal(flagged.x, plain.x);
});

test('stepKidMotion: stun ignores movement and blocks slide starts, drag still applies', () => {
  const cw = createCollisionWorld(blankMap());
  const kid = motionKid(400, 300, { stunT: 1, vx: 200 });
  stepKidMotion(kid, walkFrame({ mx: -1, btn: BTN.SLIDE }), cw, DT);
  assert.equal(kid.slideT, 0);
  assert.ok(kid.vx > 0 && kid.vx < 200, 'decelerates by drag, not by steering');
});

test('stepKidMotion: a slide starts on the press edge only, along move, and sets its cooldown', () => {
  const cw = createCollisionWorld(blankMap());
  const mods = { ...defaultMods(), slideCdMul: 0.5 };
  const kid = motionKid(400, 300, { mods });
  const press = walkFrame({ mx: 0, my: 1, btn: BTN.SLIDE });
  stepKidMotion(kid, press, cw, DT);
  assert.equal(kid.slideT, KID.slideTime);
  near(kid.slideCd, KID.slideCooldown * 0.5);
  near(kid.vy, KID.slideSpeed);
  near(kid.vx, 0);
  const firstCd = kid.slideCd;
  stepKidMotion(kid, press, cw, DT);
  near(kid.slideCd, firstCd - DT, 1e-9, 'held button is not a new press');
});

test('stepKidMotion: a slide with no move input goes along aim', () => {
  const cw = createCollisionWorld(blankMap());
  const kid = stepKidMotion(motionKid(), walkFrame({ mx: 0.05, my: 0, aim: Math.PI / 2, btn: BTN.SLIDE }), cw, DT);
  near(kid.vy, KID.slideSpeed, 1e-6);
  near(kid.vx, 0, 1e-6);
});

test('stepKidMotion: slide lasts slideTime, ignores steering, then the kid is back to walking', () => {
  const cw = createCollisionWorld(blankMap());
  const kid = motionKid(100, 300);
  stepKidMotion(kid, walkFrame({ mx: 1, btn: BTN.SLIDE }), cw, DT);
  let sliding = 1;
  for (;;) {
    stepKidMotion(kid, walkFrame({ my: 1 }), cw, DT);
    if (kid.slideT <= 0) break;
    near(Math.hypot(kid.vx, kid.vy), KID.slideSpeed, 1e-6);
    near(kid.vy, 0, 1e-6, 'steering is ignored');
    sliding += 1;
    assert.ok(sliding < 30);
  }
  assert.equal(sliding, Math.ceil(KID.slideTime * SIM_HZ));
  drive(cw, kid, walkFrame({ my: 1 }), 15);
  near(kid.vy, KID.speed, 1e-6);
  near(kid.vx, 0, 1e-6);
});

test('stepKidMotion: a slide cannot restart until its cooldown has run out', () => {
  const cw = createCollisionWorld(blankMap());
  const kid = motionKid(100, 100);
  const press = walkFrame({ mx: 1, btn: BTN.SLIDE });
  const release = walkFrame({ mx: 1 });
  stepKidMotion(kid, press, cw, DT);
  stepKidMotion(kid, release, cw, DT);
  stepKidMotion(kid, press, cw, DT);
  near(kid.slideCd, KID.slideCooldown - 2 * DT, 1e-9, 'second press changed nothing');
  drive(cw, kid, release, Math.ceil(KID.slideCooldown * SIM_HZ));
  assert.equal(kid.slideCd, 0);
  stepKidMotion(kid, press, cw, DT);
  assert.equal(kid.slideT, KID.slideTime);
});

test('stepKidMotion: knockback is simply velocity it then works off', () => {
  const cw = createCollisionWorld(blankMap());
  const kid = motionKid(400, 300, { vx: 300 });
  stepKidMotion(kid, walkFrame(), cw, DT);
  assert.ok(kid.x > 400, 'carried along');
  assert.ok(kid.vx < 300, 'losing speed');
});

test('stepKidMotion: timers tick per applied frame and land on exactly zero', () => {
  const cw = createCollisionWorld(blankMap());
  const kid = motionKid(400, 300, { boardT: DT * 2.5 });
  drive(cw, kid, walkFrame(), 3);
  assert.equal(kid.boardT, 0);
});

// ---- collision ----------------------------------------------------------------

test('collision: walls stop a kid at their radius, and they slide along them', () => {
  const cw = createCollisionWorld(testMap());
  const kid = drive(cw, motionKid(60, 160), walkFrame({ mx: 1 }), 40);
  near(kid.x, 120 - KID.radius, 1e-6, 'stopped at the house');
  near(kid.y, 160, 1e-6);
  assert.equal(kid.vx, 0);
  const before = kid.y;
  drive(cw, kid, walkFrame({ mx: 1, my: 1 }), 5);
  near(kid.x, 120 - KID.radius, 1e-6, 'still against it');
  assert.ok(kid.y > before + 10, 'sliding down the wall');
});

test('collision: a long wall of cells has no catching seams', () => {
  const cw = createCollisionWorld(blankMap());
  for (let cx = 2; cx < 20; cx++) cw.setStruct(cx, 5, true, 1, 34);
  const kid = motionKid(100, 5 * CELL - KID.radius);
  // Pressing into the wall while walking along it must not lose speed at cell joins.
  drive(cw, kid, walkFrame({ mx: 1, my: 0.3 }), 10);
  const speeds = [];
  for (let i = 0; i < 40; i++) {
    const before = kid.x;
    stepKidMotion(kid, walkFrame({ mx: 1, my: 0.3 }), cw, DT);
    speeds.push(kid.x - before);
    near(kid.y, 5 * CELL - KID.radius, 1e-6);
  }
  assert.ok(Math.max(...speeds) - Math.min(...speeds) < 0.5, 'steady pace along the wall');
});

test('collision: circles deflect, map edges hold, nothing gets out', () => {
  const cw = createCollisionWorld(testMap());
  const kid = drive(cw, motionKid(900, 160), walkFrame({ mx: 1, my: 0.1 }), 60);
  assert.ok(Math.hypot(kid.x - 1000, kid.y - 160) >= 30 + KID.radius - 1e-6);
  const corner = drive(cw, motionKid(40, 40), walkFrame({ mx: -1, my: -1 }), 30);
  assert.deepEqual([corner.x, corner.y], [KID.radius, KID.radius]);
  const far = drive(cw, motionKid(1190, 790), walkFrame({ mx: 1, my: 1 }), 30);
  assert.deepEqual([far.x, far.y], [1200 - KID.radius, 800 - KID.radius]);
});

test('collision: speed cannot tunnel through a thin fence', () => {
  const cw = createCollisionWorld(testMap());
  const body = { x: 960, y: 620, vx: 0, vy: 0, r: KID.radius };
  body.y = 420;
  const startY = 590;
  body.y = 690;
  collideCircle(cw, body, 960, startY);
  assert.ok(body.y < 600, `went through to y=${body.y}`);
});

test('collision: fast slides into a struct wall stop at it', () => {
  const cw = createCollisionWorld(blankMap());
  cw.setStruct(10, 7, true, 1, 34);
  const kid = motionKid(340, 7.5 * CELL);
  stepKidMotion(kid, walkFrame({ mx: 1, btn: BTN.SLIDE }), cw, DT);
  drive(cw, kid, walkFrame(), 12);
  assert.ok(kid.x <= 400 - KID.radius + 1e-6);
});

test('collision: structs are solid only while set, and Slick is recorded but passable', () => {
  const cw = createCollisionWorld(blankMap());
  cw.setStruct(10, 7, true, 1, 34);
  assert.equal(cw.isSolidCell(10, 7), true);
  assert.equal(cw.isObstacleCell(10, 7), false);
  cw.clearStruct(10, 7);
  assert.equal(cw.isSolidCell(10, 7), false);
  const kid = drive(cw, motionKid(340, 300), walkFrame({ mx: 1 }), 30);
  assert.ok(kid.x > 440);

  cw.setStruct(10, 7, false, 1, 0);
  assert.equal(cw.isSolidCell(10, 7), false);
  assert.equal(cw.isStructCell(10, 7), true);

  cw.setStruct(4, 4, true, 2, 90);
  for (const [cx, cy] of [[4, 4], [5, 4], [4, 5], [5, 5]]) assert.equal(cw.isSolidCell(cx, cy), true);
  cw.clearStruct(4, 4, 2);
  for (const [cx, cy] of [[4, 4], [5, 4], [4, 5], [5, 5]]) assert.equal(cw.isSolidCell(cx, cy), false);
});

test('collision: cell queries follow the spec', () => {
  const cw = createCollisionWorld(testMap());
  assert.deepEqual(cw.cellOf(85, 39.9), { cx: 2, cy: 0 });
  assert.equal(cw.isSolidCell(-1, 0), true, 'out of map');
  assert.equal(cw.isObstacleCell(0, 999), true, 'out of map');
  assert.equal(cw.isObstacleCell(3, 3), true, 'inside the house');
  assert.equal(cw.isSolidCell(3, 3), true);
  assert.equal(cw.isObstacleCell(4, 16), false, 'swings do not block movement');
  assert.equal(cw.isObstacleCell(25, 3), true, 'the tree');
  assert.equal(cw.isObstacleCell(0, 0), false);
});

test('truce rope: holds a body on its side, a radius away, on either axis', () => {
  const cw = createCollisionWorld(blankMap());
  cw.truce = { axis: 'x', at: 600, active: true };
  const west = drive(cw, motionKid(500, 300), walkFrame({ mx: 1 }), 40);
  near(west.x, 600 - KID.radius);
  const east = drive(cw, motionKid(700, 300), walkFrame({ mx: -1 }), 40);
  near(east.x, 600 + KID.radius);

  cw.truce = { axis: 'y', at: 400, active: true };
  const north = drive(cw, motionKid(300, 300), walkFrame({ my: 1 }), 40);
  near(north.y, 400 - KID.radius);
  const south = drive(cw, motionKid(300, 500), walkFrame({ my: -1 }), 40);
  near(south.y, 400 + KID.radius);
});

test('truce rope: a belly slide cannot jump it, and a dropped rope is no rope', () => {
  const cw = createCollisionWorld(blankMap());
  cw.truce = { axis: 'x', at: 600, active: true };
  const kid = motionKid(590 - KID.radius, 300);
  stepKidMotion(kid, walkFrame({ mx: 1, btn: BTN.SLIDE }), cw, DT);
  drive(cw, kid, walkFrame({ mx: 1 }), 12);
  assert.ok(kid.x <= 600 - KID.radius);

  cw.truce = { axis: 'x', at: 600, active: false };
  assert.ok(drive(cw, motionKid(560, 300), walkFrame({ mx: 1 }), 30).x > 600);
  cw.truce = null;
  assert.ok(drive(cw, motionKid(560, 300), walkFrame({ mx: 1 }), 30).x > 600);
});

test('ice: both shapes register', () => {
  const cw = createCollisionWorld(testMap());
  assert.equal(cw.isIce(340, 660), true);
  assert.equal(cw.isIce(435, 660), true);
  assert.equal(cw.isIce(445, 660), false);
  assert.equal(cw.isIce(760, 80), true);
  assert.equal(cw.isIce(880, 160), true);
  assert.equal(cw.isIce(881, 160), false);
});

test('ice: slow to get going, slow to stop, faster at the top end', () => {
  const map = blankMap({ ice: [{ shape: 'rect', x: 0, y: 0, w: 1200, h: 800 }] });
  const ice = createCollisionWorld(map);
  const snow = createCollisionWorld(blankMap());
  near(drive(ice, motionKid(100, 400), walkFrame({ mx: 1 }), 3).vx, 3 * KID.iceAccel * DT, 1e-6);
  assert.ok(drive(snow, motionKid(100, 400), walkFrame({ mx: 1 }), 3).vx > 150);

  near(drive(ice, motionKid(40, 400), walkFrame({ mx: 1 }), 30).vx, KID.iceMaxSpeed, 1e-6);

  const coasting = drive(ice, motionKid(100, 400, { vx: 200 }), walkFrame(), 30);
  near(coasting.vx, 200 * (1 - KID.iceDrag * DT) ** 30, 1e-6, 'still sliding after a second:');
  assert.equal(drive(snow, motionKid(100, 400, { vx: 200 }), walkFrame(), 30).vx, 0);
});

// ---- raycastFlat --------------------------------------------------------------

test('raycastFlat: blocksBalls obstacles stop it, at the point of contact', () => {
  const cw = createCollisionWorld(testMap());
  const hit = raycastFlat(cw, 60, 160, 300, 160, 20);
  assert.equal(hit.what, 'obstacle');
  assert.equal(hit.structCell, null);
  near(hit.x, 120);
  near(hit.y, 160);
  const round = raycastFlat(cw, 900, 160, 1100, 160, 20);
  assert.equal(round.what, 'obstacle');
  near(round.x, 970);
});

test('raycastFlat: fences that block feet let balls through, as do height-less gaps', () => {
  const cw = createCollisionWorld(testMap());
  assert.equal(raycastFlat(cw, 960, 560, 960, 660, 20), null);
  assert.equal(raycastFlat(cw, 300, 300, 400, 300, 20), null);
});

test('raycastFlat: solid structs block below their height only, and name the cell', () => {
  const cw = createCollisionWorld(blankMap());
  cw.setStruct(10, 7, true, 1, 34);
  const hit = raycastFlat(cw, 300, 300, 500, 300, 20);
  assert.equal(hit.what, 'struct');
  assert.deepEqual(hit.structCell, { cx: 10, cy: 7 });
  near(hit.x, 400);
  assert.equal(raycastFlat(cw, 300, 300, 500, 300, 34), null, 'at height exactly is over it');
  cw.setStruct(11, 7, false, 1, 0);
  cw.clearStruct(10, 7);
  assert.equal(raycastFlat(cw, 300, 300, 500, 300, 0), null, 'Slick is not solid');
});

test('raycastFlat: picks the nearest of several, in any direction, and steep lines miss no cell', () => {
  const cw = createCollisionWorld(blankMap());
  cw.setStruct(5, 5, true, 1, 34);
  cw.setStruct(8, 5, true, 1, 34);
  assert.deepEqual(raycastFlat(cw, 100, 220, 400, 220, 0).structCell, { cx: 5, cy: 5 });
  assert.deepEqual(raycastFlat(cw, 400, 220, 100, 220, 0).structCell, { cx: 8, cy: 5 });
  const diagonal = createCollisionWorld(blankMap());
  diagonal.setStruct(6, 6, true, 1, 34);
  assert.deepEqual(raycastFlat(diagonal, 200, 200, 300, 300, 0).structCell, { cx: 6, cy: 6 });
  assert.deepEqual(raycastFlat(diagonal, 300, 300, 200, 200, 0).structCell, { cx: 6, cy: 6 });
  assert.equal(raycastFlat(diagonal, 330, 200, 330, 240, 0), null);
});

test('raycastFlat: leaves the map without complaint', () => {
  const cw = createCollisionWorld(blankMap());
  assert.equal(raycastFlat(cw, 1180, 400, 1300, 400, 20), null);
  assert.equal(raycastFlat(cw, -50, 400, 40, 400, 20), null);
});

// ---- canPlace and demolishState ------------------------------------------------

function placementQuery(over = {}) {
  return {
    structs: new Map(), actors: new Map(), flakes: 100, team: TEAM.A, x: 300, y: 300, range: 240,
    phase: PHASE.BUILD, mode: MODE.SIEGE, pultLimit: 4, spendLeft: 65535, patchesLeft: 3, playersPresent: () => true, ...over,
  };
}

const wallAt = (id, cx, cy, over = {}) => ({ id, kind: STRUCT.WALL, cx, cy, team: TEAM.A, hp: 60, maxHp: 60, ownerId: 1, ...over });
const colonelAt = (cx, cy, over = {}) => ({ id: 1000, kind: STRUCT.COLONEL, cx, cy, team: TEAM.A, hp: 1000, maxHp: 1500, ownerId: 0, ...over });

test('canPlace: an open cell in range is ok', () => {
  const cw = createCollisionWorld(testMap());
  assert.equal(canPlace(cw, placementQuery(), STRUCT.WALL, 7, 7), 'ok');
});

test('canPlace: out of map, obstacle overlap, the Colonel tool and nonsense kinds are badCell', () => {
  const cw = createCollisionWorld(testMap());
  const q = placementQuery({ range: 1e6 });
  assert.equal(canPlace(cw, q, STRUCT.WALL, -1, 7), 'badCell');
  assert.equal(canPlace(cw, q, STRUCT.WALL, 7, 999), 'badCell');
  assert.equal(canPlace(cw, q, STRUCT.WALL, 3, 3), 'badCell', 'in the house');
  assert.equal(canPlace(cw, q, STRUCT.WALL, 4, 16), 'badCell', 'under the swings');
  assert.equal(canPlace(cw, q, STRUCT.COLONEL, 7, 7), 'badCell');
  assert.equal(canPlace(cw, q, 99, 7, 7), 'badCell');
});

test('canPlace: nothing within entranceNoBuild of a Siege entrance, but other modes may', () => {
  const cw = createCollisionWorld(blankMap());
  const q = placementQuery({ x: 100, y: 400, range: 1000 });
  assert.equal(canPlace(cw, q, STRUCT.WALL, 2, 10), 'badCell');
  assert.equal(canPlace(cw, { ...q, mode: MODE.FFA }, STRUCT.WALL, 2, 10), 'ok');
  assert.equal(canPlace(cw, q, STRUCT.WALL, 4, 10), 'ok', 'just outside the circle');
});

test('canPlace: Face-Off is own-half only in both phases, and an active rope enforces it too', () => {
  const cw = createCollisionWorld(blankMap());
  const q = placementQuery({ mode: MODE.FORTWARS, x: 600, y: 300, range: 1000 });
  for (const phase of [PHASE.BUILD, PHASE.FIGHT]) {
    assert.equal(canPlace(cw, { ...q, phase }, STRUCT.WALL, 14, 7), 'ok');
    assert.equal(canPlace(cw, { ...q, phase }, STRUCT.WALL, 15, 7), 'badCell');
    assert.equal(canPlace(cw, { ...q, phase, team: TEAM.B }, STRUCT.WALL, 15, 7), 'ok');
    assert.equal(canPlace(cw, { ...q, phase, team: TEAM.B }, STRUCT.WALL, 14, 7), 'badCell');
  }
  cw.truce = { axis: 'x', at: 600, active: true };
  assert.equal(canPlace(cw, { ...q, mode: MODE.FFA }, STRUCT.WALL, 15, 7), 'badCell');
});

test('canPlace: range is measured to the cell centre', () => {
  const cw = createCollisionWorld(blankMap());
  const q = placementQuery({ x: 300, y: 300, range: 100 });
  assert.equal(canPlace(cw, q, STRUCT.WALL, 9, 7), 'ok');
  assert.equal(canPlace(cw, q, STRUCT.WALL, 10, 7), 'tooFar');
});

test('canPlace: repair needs own team, same kind, damage, and the money', () => {
  const cw = createCollisionWorld(blankMap());
  const hurt = wallAt(1, 7, 7, { hp: 30 });
  const structs = new Map([[1, hurt]]);
  const q = placementQuery({ structs });
  assert.equal(canPlace(cw, q, STRUCT.WALL, 7, 7), 'repair');
  assert.equal(canPlace(cw, { ...q, flakes: 0 }, STRUCT.WALL, 7, 7), 'noFlakes');
  assert.equal(canPlace(cw, { ...q, spendLeft: 0 }, STRUCT.WALL, 7, 7), 'limit');
  assert.equal(canPlace(cw, q, STRUCT.ICEWALL, 7, 7), 'badCell', 'other tool');
  assert.equal(canPlace(cw, { ...q, team: TEAM.B, mode: MODE.FFA }, STRUCT.WALL, 7, 7), 'badCell', 'not yours');
  hurt.hp = 60;
  assert.equal(canPlace(cw, q, STRUCT.WALL, 7, 7), 'badCell', 'nothing to repair');
});

test('canPlace: patch is the WALL tool on your hurt Colonel in BUILD with patches left', () => {
  const cw = createCollisionWorld(blankMap());
  const structs = new Map([[1000, colonelAt(7, 7)]]);
  const q = placementQuery({ structs });
  for (const [cx, cy] of [[7, 7], [8, 7], [7, 8], [8, 8]]) assert.equal(canPlace(cw, q, STRUCT.WALL, cx, cy), 'patch');
  const healthy = new Map([[1000, colonelAt(7, 7, { hp: 1500 })]]);
  assert.equal(canPlace(cw, { ...q, structs: healthy }, STRUCT.WALL, 7, 7), 'badCell', 'nothing to patch');
  assert.equal(canPlace(cw, { ...q, phase: PHASE.FIGHT }, STRUCT.WALL, 7, 7), 'badCell');
  assert.equal(canPlace(cw, { ...q, patchesLeft: 0 }, STRUCT.WALL, 7, 7), 'badCell');
  assert.equal(canPlace(cw, q, STRUCT.ICEWALL, 7, 7), 'badCell');
  assert.equal(canPlace(cw, { ...q, flakes: SIEGE.colonelPatch.cost - 1 }, STRUCT.WALL, 7, 7), 'noFlakes');
  assert.equal(canPlace(cw, { ...q, spendLeft: SIEGE.colonelPatch.cost - 1 }, STRUCT.WALL, 7, 7), 'limit');
});

test('canPlace: solid kinds refuse a cell with an actor on it, Slick does not', () => {
  const cw = createCollisionWorld(blankMap());
  const actors = new Map([[1, { x: 7.5 * CELL, y: 7.5 * CELL, r: KID.radius }]]);
  const q = placementQuery({ actors });
  assert.equal(canPlace(cw, q, STRUCT.WALL, 7, 7), 'badCell');
  assert.equal(canPlace(cw, q, STRUCT.SLICK, 7, 7), 'ok');
  actors.get(1).x = 6 * CELL + 30;
  assert.equal(canPlace(cw, q, STRUCT.WALL, 7, 7), 'badCell', 'the body overlaps, not just the centre');
  actors.get(1).x = 6 * CELL + 20;
  assert.equal(canPlace(cw, q, STRUCT.WALL, 7, 7), 'ok');
});

test('canPlace: the team cap and flinger limit answer limit', () => {
  const cw = createCollisionWorld(blankMap());
  const full = new Map();
  for (let i = 0; i < MAX_STRUCTS_PER_TEAM; i++) full.set(i, wallAt(i, 20 + (i % 10), 1 + Math.floor(i / 10)));
  assert.equal(canPlace(cw, placementQuery({ structs: full }), STRUCT.WALL, 7, 7), 'limit');

  const pults = new Map([[1, wallAt(1, 20, 1, { kind: STRUCT.PULT })], [2, wallAt(2, 21, 1, { kind: STRUCT.PULT })]]);
  const q = placementQuery({ structs: pults, pultLimit: 2 });
  assert.equal(canPlace(cw, q, STRUCT.PULT, 7, 7), 'limit');
  assert.equal(canPlace(cw, q, STRUCT.WALL, 7, 7), 'ok');
  assert.equal(canPlace(cw, { ...q, pultLimit: 3 }, STRUCT.PULT, 7, 7), 'ok');
});

test('canPlace: flakes then spendLeft, using each kind\'s cost', () => {
  const cw = createCollisionWorld(blankMap());
  const q = placementQuery({ flakes: 9 });
  assert.equal(canPlace(cw, q, STRUCT.PULT, 7, 7), 'noFlakes');
  assert.equal(canPlace(cw, q, STRUCT.COCOA, 7, 7), 'ok');
  assert.equal(canPlace(cw, { ...q, spendLeft: 2 }, STRUCT.ICEWALL, 7, 7), 'limit');
  assert.equal(canPlace(cw, { ...q, flakes: 0, spendLeft: 0 }, STRUCT.WALL, 7, 7), 'noFlakes', 'flakes first');
});

test('canPlace: the order of the rules is the contract', () => {
  const cw = createCollisionWorld(blankMap());
  const broke = placementQuery({ flakes: 0, spendLeft: 0, x: 1000, y: 700, range: 10 });
  assert.equal(canPlace(cw, { ...broke, mode: MODE.FORTWARS }, STRUCT.WALL, 25, 10), 'badCell', 'half before range');
  assert.equal(canPlace(cw, broke, STRUCT.WALL, 15, 7), 'tooFar', 'range before money');
  const q = placementQuery({ flakes: 0, actors: new Map([[1, { x: 7.5 * CELL, y: 7.5 * CELL, r: 14 }]]) });
  assert.equal(canPlace(cw, q, STRUCT.WALL, 7, 7), 'badCell', 'occupied before money');
});

test('canPlace: the client may pass arrays where the sim has Maps', () => {
  const cw = createCollisionWorld(blankMap());
  const q = placementQuery({ structs: [wallAt(1, 7, 7, { hp: 10 })], actors: [{ x: 300, y: 340, r: 14 }] });
  assert.equal(canPlace(cw, q, STRUCT.WALL, 7, 7), 'repair');
  assert.equal(canPlace(cw, q, STRUCT.WALL, 7, 8), 'badCell');
});

test('demolishState: the Colonel, enemy structs and nothing at all are badCell', () => {
  const q = placementQuery();
  assert.equal(demolishState(q, colonelAt(7, 7), 1), 'badCell');
  assert.equal(demolishState(q, wallAt(1, 7, 7, { team: TEAM.B }), 1), 'badCell');
  assert.equal(demolishState(q, null, 1), 'badCell');
});

test('demolishState: your own within build range; an absent owner\'s is treated as yours', () => {
  const q = placementQuery({ x: 300, y: 300, range: 100 });
  assert.equal(demolishState(q, wallAt(1, 9, 7, { ownerId: 1 }), 1), 'ok');
  assert.equal(demolishState(q, wallAt(1, 12, 7, { ownerId: 1 }), 1), 'tooFar');
  const gone = { ...q, playersPresent: () => false };
  assert.equal(demolishState(gone, wallAt(1, 9, 7, { ownerId: 2 }), 1), 'ok');
});

test('demolishState: a present teammate\'s struct needs you right beside it', () => {
  const q = placementQuery({ x: 300, y: 300, range: 240 });
  const reach = TEAMMATE_DEMOLISH_RANGE;
  assert.equal(demolishState({ ...q, x: 7.5 * CELL - reach + 1, y: 7.5 * CELL }, wallAt(1, 7, 7, { ownerId: 2 }), 1), 'ok');
  assert.equal(demolishState({ ...q, x: 7.5 * CELL - reach - 1, y: 7.5 * CELL }, wallAt(1, 7, 7, { ownerId: 2 }), 1), 'tooFar');
});

// ---- FlowField ----------------------------------------------------------------

function fieldWorld(map = testMap()) {
  const cw = createCollisionWorld(map);
  const world = {
    cw, map, tick: 0, structRev: 0, structs: new Map(),
    structAt(cx, cy) {
      for (const s of this.structs.values()) {
        const size = BUILD[s.kind].size || 1;
        if (cx >= s.cx && cx < s.cx + size && cy >= s.cy && cy < s.cy + size) return s;
      }
      return null;
    },
    add(s) {
      this.structs.set(s.id, s);
      cw.setStruct(s.cx, s.cy, BUILD[s.kind].solid, BUILD[s.kind].size || 1, BUILD[s.kind].height);
      this.structRev += 1;
    },
    remove(s) {
      this.structs.delete(s.id);
      cw.clearStruct(s.cx, s.cy, BUILD[s.kind].size || 1);
      this.structRev += 1;
    },
  };
  return world;
}

function walkField(field, world, x, y, limit = 400) {
  const path = [];
  for (let i = 0; i < limit; i++) {
    const { dx, dy, blocker } = field.dirAt(x, y);
    path.push({ x, y, blocker });
    if (blocker !== null || (dx === 0 && dy === 0)) return path;
    x += dx * 10;
    y += dy * 10;
  }
  return path;
}

const fortGoals = [{ cx: 14, cy: 9 }, { cx: 15, cy: 9 }, { cx: 14, cy: 10 }, { cx: 15, cy: 10 }];

test('FlowField: walks around scenery to the goal and never through it', () => {
  const world = fieldWorld();
  const field = new FlowField(world, fortGoals);
  const path = walkField(field, world, 60, 160);
  const end = path[path.length - 1];
  assert.equal(Math.floor(end.x / CELL) >= 14 && Math.floor(end.x / CELL) <= 15, true, `ended at ${end.x},${end.y}`);
  for (const p of path) {
    const { cx, cy } = world.cw.cellOf(p.x, p.y);
    assert.equal(world.cw.isObstacleCell(cx, cy), false, `path entered obstacle cell ${cx},${cy}`);
  }
});

test('FlowField: dirAt is a unit vector, and zero on the goal', () => {
  const world = fieldWorld();
  const field = new FlowField(world, fortGoals);
  const { dx, dy, blocker } = field.dirAt(300, 300);
  near(Math.hypot(dx, dy), 1);
  assert.equal(blocker, null);
  assert.deepEqual(field.dirAt(14.5 * CELL, 9.5 * CELL), { dx: 0, dy: 0, blocker: null });
});

test('FlowField: a sealed fort still has a route, and blocker names the wall in the way', () => {
  const world = fieldWorld();
  let id = 1;
  const walls = [];
  for (let cy = 7; cy <= 12; cy++) {
    for (let cx = 12; cx <= 17; cx++) {
      if (cx > 12 && cx < 17 && cy > 7 && cy < 12) continue;
      const wall = wallAt(id++, cx, cy);
      walls.push(wall);
      world.add(wall);
    }
  }
  const field = new FlowField(world, fortGoals);
  const end = walkField(field, world, 100, 400).at(-1);
  assert.ok(walls.includes(end.blocker), 'stopped by a wall of the ring');
});

test('FlowField: foes break in through the cheapest wall', () => {
  const world = fieldWorld(blankMap());
  let id = 1;
  const walls = new Map();
  for (let cy = 0; cy < 20; cy++) {
    const wall = wallAt(id++, 10, cy, { kind: STRUCT.ICEWALL, hp: 1000, maxHp: 1000 });
    walls.set(cy, wall);
    world.add(wall);
  }
  const weak = walls.get(14);
  weak.hp = 1;
  const field = new FlowField(world, [{ cx: 25, cy: 10 }]);
  assert.equal(walkField(field, world, 100, 400).at(-1).blocker, weak);
});

test('FlowField: no diagonal squeeze between two corners', () => {
  const world = fieldWorld(blankMap());
  world.add(wallAt(1, 10, 10));
  world.add(wallAt(2, 11, 11));
  const field = new FlowField(world, [{ cx: 11, cy: 10 }]);
  const { dx, dy, blocker } = field.dirAt(10.5 * CELL, 11.5 * CELL);
  assert.equal(blocker !== null || Math.abs(dx) < 0.01 || Math.abs(dy) < 0.01, true, 'moves square-on');
});

test('FlowField: rebuilds at most twice a second, and only after a change', () => {
  const world = fieldWorld();
  const field = new FlowField(world, fortGoals);
  const built = field.rebuilds;
  for (world.tick = 1; world.tick <= 60; world.tick += 1) field.dirAt(300, 300);
  assert.equal(field.rebuilds, built, 'nothing changed');

  const wall = wallAt(1, 7, 7);
  for (world.tick = 61; world.tick <= 120; world.tick += 1) {
    world.structRev += 1;
    field.dirAt(300, 300);
  }
  assert.ok(field.rebuilds - built <= 4, `rebuilt ${field.rebuilds - built} times in 2 s`);
  assert.ok(field.rebuilds - built >= 3);

  const before = field.rebuilds;
  world.add(wall);
  world.tick += SIM_HZ;
  field.dirAt(300, 300);
  assert.equal(field.rebuilds, before + 1);
});

test('FlowField: a new wall re-routes foes once the throttle lets it', () => {
  const world = fieldWorld(blankMap());
  const field = new FlowField(world, [{ cx: 15, cy: 10 }]);
  assert.ok(field.dirAt(100, 420).dx > 0.9);
  for (let cy = 5; cy <= 15; cy++) world.add(wallAt(cy, 3, cy));
  world.tick += SIM_HZ;
  const route = walkField(field, world, 100, 420);
  const reachedGoal = route.at(-1).blocker === null;
  assert.equal(reachedGoal, true, 'a detour is cheaper than chewing through');
  assert.ok(route.some((p) => p.y < 5 * CELL || p.y > 16 * CELL), 'and it goes around the end');
});

test('FlowField: paths prefer open ground over hugging scenery', () => {
  const world = fieldWorld(blankMap({
    obstacles: [{ type: 'house', shape: 'rect', x: 400, y: 0, w: 40, h: 600, blocksMove: true, blocksBalls: true, height: 100 }],
  }));
  const field = new FlowField(world, [{ cx: 20, cy: 2 }]);
  const route = walkField(field, world, 200, 80);
  const corner = route.filter((p) => p.x > 380 && p.x < 460);
  assert.ok(corner.length > 0);
  assert.ok(corner.every((p) => p.y >= 600 + CELL - 1), 'rounds the corner with a cell to spare');
});

test('FlowField: a body stuck in an obstacle cell is led back out', () => {
  const world = fieldWorld();
  const field = new FlowField(world, fortGoals);
  const { dx, dy } = field.dirAt(125, 125);
  assert.ok(dx !== 0 || dy !== 0);
  assert.ok(dx < 0 || dy < 0, 'heads for the nearest open neighbour');
});

test('FlowField: positions off the map clamp onto it', () => {
  const world = fieldWorld();
  const field = new FlowField(world, fortGoals);
  const { dx, dy } = field.dirAt(-30, 1000);
  near(Math.hypot(dx, dy), 1);
});

// ---- ids ----------------------------------------------------------------------

test('ids: a kid\'s actor id is its player id', () => {
  const g = siege([human(3), human(7), bot(12)]);
  assert.deepEqual([...g.actors.keys()].sort((a, b) => a - b), [3, 7, 12]);
  assert.equal(g.actors.get(12).isBot, true);
  assert.equal(g.actors.get(3).kind, ACTOR.KID);
});

test('ids: foes and structs share one counter from 1000, balls count on their own', () => {
  const g = siege();
  const colonel = g.colonel(TEAM.A);
  assert.equal(colonel.id, 1000);
  const foe = g.spawnFoe(ACTOR.PIPSQUEAK, 100, 400);
  assert.equal(foe.id, 1001);
  g.command(1, { c: CMD.BUILD, k: STRUCT.WALL, cx: 13, cy: 5 });
  const wall = g.structAt(13, 5);
  assert.equal(wall.id, 1002);
  const ball = g.throwFlat(g.actors.get(1), 0);
  assert.equal(ball.id, 1);
  assert.equal(g.throwFlat(g.actors.get(1), 0).id, 2);
});

test('ids: the counter wraps 65535 -> 1000 and steps over anything still live', () => {
  const g = siege();
  assert.ok(g.colonel(TEAM.A).id === 1000);
  const live = g.spawnFoe(ACTOR.PIPSQUEAK, 100, 400);
  g.nextId = 65534;
  const top = g.spawnFoe(ACTOR.PIPSQUEAK, 100, 400);
  assert.equal(top.id, 65535);
  const wrapped = g.spawnFoe(ACTOR.PIPSQUEAK, 100, 400);
  assert.equal(wrapped.id, live.id + 1, 'skipped 1000 (Colonel) and 1001 (live foe)');
  g.despawn(live);
  g.nextId = 65535;
  assert.equal(g.spawnFoe(ACTOR.PIPSQUEAK, 100, 400).id, live.id, 'a freed id is reusable');
});

test('ids: nothing allocated is ever 0, and hit.by and thaw.by use 0 for nobody', () => {
  const g = siege([human(1), human(2)]);
  const kid = g.actors.get(1);
  g.damageActor(kid, 5, null);
  assert.equal(eventsOf(g, EV.HIT)[0].by, 0);
  assert.equal(g.colonel(TEAM.A).ownerId, 0);
});

// ---- launch math --------------------------------------------------------------

function closedForm(ball, n) {
  return {
    x: ball.x + ball.vx * n * DT,
    y: ball.y + ball.vy * n * DT,
    z: ball.z + ball.vz * n * DT - ball.g * DT * DT * n * (n - 1) / 2,
  };
}

test('launch: a flat ball matches the closed form at every integer n and lands at t+N', () => {
  const g = siege();
  const kid = g.actors.get(1);
  const ball = g.throwFlat(kid, -0.5, { speed: 540, flight: 0.72, dmg: 10 });
  const start = { ...ball };
  const N = Math.round(0.72 / DT);
  near(ball.g, 2 * THROW.z0 / (DT * DT * N * (N - 1)));
  assert.equal(ball.vz, 0);
  assert.equal(ball.z, THROW.z0);
  for (let n = 1; n < N; n++) {
    g.step();
    const want = closedForm(start, n);
    near(ball.x, want.x, 1e-6, `x at n=${n}`);
    near(ball.y, want.y, 1e-6, `y at n=${n}`);
    near(ball.z, want.z, 1e-6, `z at n=${n}`);
    assert.ok(ball.z > 0);
    assert.ok(g.balls.has(ball.id), `still flying at n=${n}`);
  }
  g.drainEvents();
  g.step();
  const end = g.drainEvents().find((e) => e.e === EV.BALL_END);
  assert.equal(end.why, 'ground');
  assert.equal(end.z, 0);
  assert.equal(end.t, start.t0 + N);
  assert.equal(g.balls.has(ball.id), false);
});

test('launch: N is never under 2', () => {
  const g = siege();
  const ball = g.throwFlat(g.actors.get(1), 0, { speed: 100, flight: 0.001 });
  assert.equal(ball.life, 2);
  assert.ok(Number.isFinite(ball.g));
});

test('launch: a lob matches the closed form and lands exactly on target at t+N', () => {
  const g = siege();
  const kid = g.actors.get(1);
  const target = { x: 901.5, y: 203.25 };
  const distance = Math.hypot(target.x - kid.x, target.y - kid.y);
  const ball = g.throwLob(kid, target.x, target.y, { dmg: 20, splash: 46 });
  const start = { ...ball };
  const N = Math.round((THROW.lob.minFlight + distance * THROW.lob.flightPerUnit) / DT);
  assert.equal(ball.ft, N);
  assert.equal(ball.g, THROW.lob.gravity);
  near(ball.vx, (target.x - kid.x) / (N * DT));
  near(ball.vy, (target.y - kid.y) / (N * DT));
  near(ball.vz, (THROW.lob.gravity * DT * DT * N * (N - 1) / 2 - THROW.z0) / (N * DT));
  for (let n = 1; n < N; n++) {
    g.step();
    const want = closedForm(start, n);
    near(ball.x, want.x, 1e-6);
    near(ball.y, want.y, 1e-6);
    near(ball.z, want.z, 1e-6);
  }
  g.drainEvents();
  g.step();
  const events = g.drainEvents();
  const end = events.find((e) => e.e === EV.BALL_END);
  assert.deepEqual([end.x, end.y, end.z, end.t], [901.5, 203.25, 0, start.t0 + N]);
  assert.equal(end.why, 'ground');
  const splash = events.find((e) => e.e === EV.SPLASH);
  assert.deepEqual([splash.x, splash.y, splash.r, splash.k], [901.5, 203.25, 46, BALL.LOB]);
  near(closedForm(start, N).z, 0, 1e-9, 'the closed form agrees it landed');
});

test('launch: opts.flight overrides the lob\'s own flight time', () => {
  const g = siege();
  const ball = g.throwLob(g.actors.get(1), 700, 150, { flight: 1.5 });
  assert.equal(ball.ft, 45);
});

test('launch: rollers stay at z=0 and grow by the closed form up to rMax', () => {
  const g = siege();
  const kid = g.actors.get(1);
  const ball = g.throwFlat(kid, -0.6, {
    speed: 50, dmg: 5, kind: BALL.GIANT, r: 14, grow: 6, rMax: 20, life: 3.5,
  });
  assert.equal(ball.z, 0);
  assert.equal(ball.g, 0);
  for (let n = 1; n <= 100; n++) {
    g.step();
    assert.equal(ball.z, 0);
    near(ball.r, Math.min(20, 14 + 6 * n * DT), 1e-9, `r at n=${n}`);
  }
  stepUntil(g, () => !g.balls.has(ball.id), 40);
});

test('launch: the ball event is the ball at its own tick, and seq rides along', () => {
  const g = siege();
  const pad = new Pad(g, 1);
  pad.tick({ btn: BTN.THROW, aim: -0.4 });
  const seq = pad.queue({ btn: 0, aim: -0.4 });
  g.drainEvents();
  g.step();
  const events = g.drainEvents();
  const ev = events.find((e) => e.e === EV.BALL);
  const ball = g.balls.get(ev.id);
  assert.equal(ev.t, g.tick);
  assert.equal(ev.seq, seq);
  assert.equal(ball.t0, g.tick);
  for (const key of ['x', 'y', 'z', 'vx', 'vy', 'vz', 'g']) near(ev[key], ball[key], 0.0051, key);
  assert.deepEqual(Object.keys(ev).sort(), ['by', 'e', 'ft', 'g', 'grow', 'id', 'k', 'lx', 'ly', 'r', 'rMax', 'seq', 't', 'tm', 'vx', 'vy', 'vz', 'x', 'y', 'z'].sort());
  assert.equal(ev.ft, 0, 'lx, ly, ft belong to arcing balls');
  assert.ok(events.some((e) => e.e === EV.THROW && e.id === 1 && e.lob === false));
  const positionAtSpawn = ball.x;
  g.step();
  near(ball.x, positionAtSpawn + ball.vx * DT, 1e-9, 'first advance is the tick after spawning');
});

test('launch: arcing balls carry their landing in lx, ly, ft', () => {
  const g = siege();
  g.throwLob(g.actors.get(1), 800, 200, { dmg: 5 });
  const ev = g.drainEvents().find((e) => e.e === EV.BALL);
  assert.deepEqual([ev.lx, ev.ly], [800, 200]);
  assert.ok(ev.ft >= 2);
});

// ---- ball impacts -------------------------------------------------------------

test('walls: a flat ball stops at a wall while a lob sails over it', () => {
  const g = siege();
  g.command(1, { c: CMD.BUILD, k: STRUCT.WALL, cx: 15, cy: 7 });
  const wall = g.structAt(15, 7);
  const kid = g.actors.get(1);
  g.drainEvents();

  const flat = g.throwFlat(kid, 0, { speed: 540, flight: 0.72, dmg: 10 });
  spin(() => g.step(), () => !g.balls.has(flat.id), 40);
  const hitWall = g.drainEvents().find((e) => e.e === EV.BALL_END);
  assert.equal(hitWall.why, 'struct');
  assert.equal(hitWall.hit, wall.id);
  near(hitWall.x, 600, 0.01);
  assert.equal(wall.hp, wall.maxHp, 'your own wall takes no damage');

  const foe = dummy(g, ACTOR.PIPSQUEAK, 800, 300);
  foe.hp = 10000;
  foe.maxHp = 10000;
  const lob = g.throwLob(kid, 800, 300, { dmg: 20, splash: 46 });
  spin(() => g.step(), () => !g.balls.has(lob.id), 60);
  const landed = g.drainEvents().filter((e) => e.e === EV.BALL_END).at(-1);
  assert.equal(landed.why, 'ground');
  near(foe.hp, 10000 - 20, 1e-9);
});

test('walls: an enemy flat ball damages the wall and the kid behind it is safe', () => {
  const g = siege();
  g.command(1, { c: CMD.BUILD, k: STRUCT.WALL, cx: 15, cy: 7 });
  const wall = g.structAt(15, 7);
  const kid = g.actors.get(1);
  const foe = dummy(g, ACTOR.PIPSQUEAK, 800, 300);
  g.throwFlat(foe, Math.PI, { speed: 360, flight: 1.5, dmg: 6 });
  g.drainEvents();
  for (let i = 0; i < 40; i++) g.step();
  assert.equal(wall.hp, wall.maxHp - 6);
  assert.equal(kid.hp, kid.maxHp);
  const events = g.drainEvents();
  assert.deepEqual(events.filter((e) => e.e === EV.S_HP).map((e) => [e.id, e.hp]), [[wall.id, 54]]);
});

test('walls: scenery ends balls too, but chain-link lets them through', () => {
  const g = siege();
  const kid = g.actors.get(1);
  kid.x = 60;
  kid.y = 160;
  g.throwFlat(kid, 0, { speed: 540, flight: 0.72, dmg: 10 });
  g.drainEvents();
  for (let i = 0; i < 8; i++) g.step();
  assert.equal(g.drainEvents().find((e) => e.e === EV.BALL_END).why, 'obstacle');

  kid.x = 960;
  kid.y = 560;
  const foe = dummy(g, ACTOR.PIPSQUEAK, 960, 660);
  g.throwFlat(kid, Math.PI / 2, { speed: 540, flight: 0.72, dmg: 10 });
  for (let i = 0; i < 12; i++) g.step();
  assert.ok(foe.hp < foe.maxHp, 'hit through the fence');
});

test('hits: damage, knockback along the ball, stats, and the ball ends on the target', () => {
  const g = siege();
  const kid = g.actors.get(1);
  const foe = dummy(g, ACTOR.BRUISER, kid.x + 200, kid.y);
  const startX = foe.x;
  g.drainEvents();
  g.throwFlat(kid, 0, { speed: 540, flight: 0.72, dmg: 10, kind: BALL.QUICK });
  for (let i = 0; i < 13; i++) g.step();
  const events = g.drainEvents();
  const hit = events.find((e) => e.e === EV.HIT);
  assert.deepEqual([hit.id, hit.amt, hit.by, hit.k], [foe.id, 10, 1, BALL.QUICK]);
  const end = events.find((e) => e.e === EV.BALL_END);
  assert.deepEqual([end.why, end.hit], ['actor', foe.id]);
  assert.equal(foe.hp, foe.maxHp - 10);
  assert.equal(kid.stats.hits, 1);
  for (let i = 0; i < 5; i++) g.step();
  assert.ok(foe.x > startX, 'knocked back along the ball');
});

test('hits: kids get knockback as velocity', () => {
  const g = siege();
  const kid = g.actors.get(1);
  const foe = dummy(g, ACTOR.PIPSQUEAK, kid.x + 100, kid.y);
  g.throwFlat(foe, Math.PI, { speed: 500, flight: 1, dmg: 6 });
  for (let i = 0; i < 6; i++) g.step();
  assert.ok(kid.vx < 0 || kid.x < 520, 'pushed away from the thrower');
  assert.equal(kid.hp, kid.maxHp - 6);
});

test('hits: takeDmgMul scales what lands', () => {
  const g = siege();
  const foe = dummy(g, ACTOR.BRUISER, 300, 300);
  foe.takeDmgMul = 2;
  g.damageActor(foe, 10, null, {});
  assert.equal(foe.hp, foe.maxHp - 20);
});

test('hits: no friendly fire, balls pass through friends', () => {
  const g = siege([human(1), human(2)]);
  const a = g.actors.get(1);
  const b = g.actors.get(2);
  b.x = a.x + 100;
  b.y = a.y;
  const foe = dummy(g, ACTOR.PIPSQUEAK, a.x + 200, a.y);
  g.throwFlat(a, 0, { speed: 540, flight: 0.72, dmg: 10 });
  for (let i = 0; i < 13; i++) g.step();
  assert.equal(b.hp, b.maxHp);
  assert.ok(foe.hp < foe.maxHp);
});

test('hits: GRACE and FLEEING foes cannot be hit, and do not stop the ball', () => {
  const g = siege();
  const kid = g.actors.get(1);
  const fresh = g.spawnFoe(ACTOR.PIPSQUEAK, kid.x + 100, kid.y);
  assert.ok(fresh.flags & AFLAG.GRACE);
  const beaten = dummy(g, ACTOR.PIPSQUEAK, kid.x + 150, kid.y);
  g.freezeOrFlee(beaten, null);
  const target = dummy(g, ACTOR.PIPSQUEAK, kid.x + 220, kid.y);
  g.throwFlat(kid, 0, { speed: 540, flight: 0.72, dmg: 5 });
  for (let i = 0; i < 14; i++) g.step();
  assert.equal(fresh.hp, fresh.maxHp);
  assert.ok(target.hp < target.maxHp, 'the ball carried on to the real target');
  assert.equal(g.damageActor(fresh, 5, null), 0);
  assert.equal(g.damageActor(beaten, 5, null), 0);
});

test('hits: frozen kids are passed through, and a foe\'s team cannot hurt itself', () => {
  const g = siege([human(1), human(2)]);
  const frozen = g.actors.get(1);
  const other = g.actors.get(2);
  g.freezeOrFlee(frozen, null);
  other.x = frozen.x - 100;
  other.y = frozen.y;
  const foe = dummy(g, ACTOR.PIPSQUEAK, frozen.x + 100, frozen.y);
  const pal = dummy(g, ACTOR.PIPSQUEAK, frozen.x + 50, frozen.y);
  g.throwFlat(foe, Math.PI, { speed: 500, flight: 1, dmg: 6 });
  for (let i = 0; i < 16; i++) g.step();
  assert.equal(pal.hp, pal.maxHp);
  assert.ok(other.hp < other.maxHp, 'it went on through the ice block');
});

test('hits: a ball that outruns its map ends with why out', () => {
  const g = siege();
  const kid = g.actors.get(1);
  kid.x = 1180;
  kid.y = 300;
  g.throwFlat(kid, 0, { speed: 540, flight: 0.72, dmg: 5 });
  g.drainEvents();
  for (let i = 0; i < 5; i++) g.step();
  assert.equal(g.drainEvents().find((e) => e.e === EV.BALL_END).why, 'out');
});

test('splash: reaches actors and enemy structs in radius, and only those', () => {
  const g = faceOff([human(1), human(2, { team: TEAM.B }), human(3, { team: TEAM.B })]);
  startFight(g);
  const thrower = g.actors.get(1);
  const closeBy = g.actors.get(2);
  const farOff = g.actors.get(3);
  closeBy.x = 900;
  closeBy.y = 200;
  farOff.x = 1040;
  farOff.y = 200;
  g.flakes[TEAM.B] = 100;
  g.command(2, { c: CMD.BUILD, k: STRUCT.WALL, cx: 23, cy: 4 });
  const wall = g.structAt(23, 4);
  thrower.x = 500;
  thrower.y = 200;
  const ball = g.throwLob(thrower, 910, 190, { dmg: 20, splash: 46 });
  spin(() => g.step(), () => !g.balls.has(ball.id), 60);
  assert.equal(closeBy.hp, closeBy.maxHp - 20);
  assert.equal(farOff.hp, farOff.maxHp);
  assert.equal(wall.hp, wall.maxHp - 20);
});

test('splash: lobSplashMul widens a kid\'s lob, throwDmgMul strengthens it', () => {
  const g = siege();
  const pad = new Pad(g, 1);
  const { kid } = pad;
  kid.cards = ['bigsplat', 'icecore'];
  kid.mods = modsFromCards(kid.cards);
  pad.tick({ btn: BTN.LOB, tx: 700, ty: 200 });
  g.drainEvents();
  pad.tick({ btn: 0, tx: 700, ty: 200 });
  const ball = [...g.balls.values()].at(-1);
  near(ball.splash, THROW.lob.splash * 1.3);
  near(ball.dmg, THROW.lob.dmg * 1.2);
});

test('shield: blocks flat balls from the front, not the back; lobs and splash bypass it', () => {
  const g = siege();
  const kid = g.actors.get(1);
  const lid = dummy(g, ACTOR.LIDKID, kid.x + 150, kid.y);
  lid.flags |= AFLAG.SHIELDED;
  lid.aim = Math.PI;
  g.drainEvents();
  g.throwFlat(kid, 0, { speed: 540, flight: 0.72, dmg: 10 });
  for (let i = 0; i < 10; i++) g.step();
  const end = g.drainEvents().find((e) => e.e === EV.BALL_END);
  assert.deepEqual([end.why, end.hit], ['shield', lid.id]);
  assert.equal(lid.hp, lid.maxHp);

  lid.aim = 0;
  g.throwFlat(kid, 0, { speed: 540, flight: 0.72, dmg: 10 });
  for (let i = 0; i < 10; i++) g.step();
  assert.equal(lid.hp, lid.maxHp - 10, 'open from behind');

  lid.aim = Math.PI;
  const before = lid.hp;
  const lob = g.throwLob(kid, lid.x, lid.y, { dmg: 7, splash: 40 });
  spin(() => g.step(), () => !g.balls.has(lob.id), 60);
  assert.equal(lid.hp, before - 7);
});

test('shield: the arc is FOES.shieldArc wide around aim', () => {
  const g = siege();
  const kid = g.actors.get(1);
  const half = FOES[ACTOR.LIDKID].shieldArc / 2;
  const lid = dummy(g, ACTOR.LIDKID, kid.x + 150, kid.y, 1000);
  lid.flags |= AFLAG.SHIELDED;
  lid.aim = Math.PI + half - 0.05;
  g.throwFlat(kid, 0, { speed: 540, flight: 0.72, dmg: 10 });
  for (let i = 0; i < 10; i++) g.step();
  assert.equal(lid.hp, 1000, 'inside the arc');
  lid.aim = Math.PI + half + 0.05;
  g.throwFlat(kid, 0, { speed: 540, flight: 0.72, dmg: 10 });
  for (let i = 0; i < 10; i++) g.step();
  assert.equal(lid.hp, 990, 'just outside it');
});

// ---- throwing by input --------------------------------------------------------

test('charge: a tap is a QUICK ball at quick numbers, costing one', () => {
  const g = siege();
  const pad = new Pad(g, 1);
  const balls = pad.kid.balls;
  pad.tick({ btn: BTN.THROW });
  assert.ok(pad.kid.flags & AFLAG.CHARGING);
  pad.tick({ btn: 0 });
  assert.equal(pad.kid.flags & AFLAG.CHARGING, 0);
  const ball = [...g.balls.values()][0];
  assert.equal(ball.kind, BALL.QUICK);
  near(Math.hypot(ball.vx, ball.vy), THROW.quick.speed);
  near(ball.dmg, THROW.quick.dmg);
  assert.equal(ball.life, Math.round(THROW.quick.flight / DT));
  assert.equal(pad.kid.balls, balls - 1);
  near(pad.kid.throwCd, THROW.cooldown);
});

test('charge: a full hold is a POWER ball; halfway is halfway and still not POWER', () => {
  const g = siege();
  const pad = new Pad(g, 1);
  pad.tick({ btn: BTN.THROW }, 1 + Math.ceil(THROW.chargeTime * SIM_HZ));
  assert.ok(pad.kid.charge >= 0.98);
  assert.equal(pad.kid.aux, Math.round(pad.kid.charge * 255));
  pad.tick({ btn: 0 });
  const power = [...g.balls.values()].at(-1);
  assert.equal(power.kind, BALL.POWER);
  near(Math.hypot(power.vx, power.vy), THROW.power.speed, 1);
  near(power.dmg, THROW.power.dmg, 0.1);

  pad.tick({}, 10);
  const halfFrames = Math.round((THROW.chargeTime * SIM_HZ) / 2);
  pad.tick({ btn: BTN.THROW }, halfFrames + 1);
  const c = pad.kid.charge;
  near(c, 0.5, 0.05);
  pad.tick({ btn: 0 });
  const mid = [...g.balls.values()].at(-1);
  assert.equal(mid.kind, BALL.QUICK);
  near(Math.hypot(mid.vx, mid.vy), THROW.quick.speed + (THROW.power.speed - THROW.quick.speed) * c, 1e-6);
});

test('charge: 0.98 is the POWER line', () => {
  const g = siege();
  const pad = new Pad(g, 1);
  const just = Math.floor(0.97 * THROW.chargeTime * SIM_HZ);
  pad.tick({ btn: BTN.THROW }, 1 + just);
  assert.ok(pad.kid.charge < 0.98);
  pad.tick({ btn: 0 });
  assert.equal([...g.balls.values()].at(-1).kind, BALL.QUICK);
});

test('charge: throwSpeedMul and throwDmgMul apply', () => {
  const g = siege();
  const pad = new Pad(g, 1);
  pad.kid.mods = { ...defaultMods(), throwSpeedMul: 1.5, throwDmgMul: 2 };
  pad.tick({ btn: BTN.THROW });
  pad.tick({ btn: 0 });
  const ball = [...g.balls.values()][0];
  near(Math.hypot(ball.vx, ball.vy), THROW.quick.speed * 1.5);
  near(ball.dmg, THROW.quick.dmg * 2);
});

test('cancel: clears a charge with no throw and no cost, even if the button stays down', () => {
  const g = siege();
  const pad = new Pad(g, 1);
  const balls = pad.kid.balls;
  pad.tick({ btn: BTN.THROW }, 10);
  assert.ok(pad.kid.charge > 0);
  pad.tick({ btn: BTN.THROW | BTN.CANCEL });
  assert.equal(pad.kid.charge, 0);
  assert.equal(pad.kid.flags & AFLAG.CHARGING, 0);
  pad.tick({ btn: BTN.THROW }, 5);
  assert.equal(pad.kid.charge, 0, 'held button does not revive it');
  pad.tick({ btn: 0 });
  assert.equal(g.balls.size, 0);
  assert.equal(pad.kid.balls, balls);
  pad.tick({ btn: BTN.THROW });
  assert.ok(pad.kid.flags & AFLAG.CHARGING, 'a fresh press works');
});

test('cancel: CANCEL with the button released throws nothing', () => {
  const g = siege();
  const pad = new Pad(g, 1);
  pad.tick({ btn: BTN.THROW }, 5);
  pad.tick({ btn: BTN.CANCEL });
  pad.tick({ btn: 0 });
  assert.equal(g.balls.size, 0);
});

test('cancel: clears a lob the same way', () => {
  const g = siege();
  const pad = new Pad(g, 1);
  const balls = pad.kid.balls;
  pad.tick({ btn: BTN.LOB }, 5);
  assert.ok(pad.kid.flags & AFLAG.LOBAIM);
  pad.tick({ btn: BTN.LOB | BTN.CANCEL });
  assert.equal(pad.kid.flags & AFLAG.LOBAIM, 0);
  pad.tick({ btn: 0 });
  assert.equal(g.balls.size, 0);
  assert.equal(pad.kid.balls, balls);
});

test('throwing: no snow is a private noBalls deny and nothing flies', () => {
  const g = siege();
  const pad = new Pad(g, 1);
  pad.kid.balls = 0;
  pad.tick({ btn: BTN.THROW });
  g.drainEvents();
  pad.tick({ btn: 0 });
  const deny = g.drainEvents().find((e) => e.e === EV.DENY);
  assert.deepEqual([deny.to, deny.why], [1, 'noBalls']);
  assert.equal(g.balls.size, 0);
});

test('throwing: a release during cooldown throws nothing', () => {
  const g = siege();
  const pad = new Pad(g, 1);
  pad.tick({ btn: BTN.THROW });
  pad.tick({ btn: 0 });
  assert.equal(g.balls.size, 1);
  pad.tick({ btn: BTN.THROW });
  pad.tick({ btn: 0 });
  assert.equal(g.balls.size, 1);
  near(pad.kid.throwCd, THROW.cooldown - 2 * DT);
  const frames = Math.ceil(THROW.cooldown * SIM_HZ);
  pad.tick({}, frames);
  assert.equal(pad.kid.throwCd, 0);
  pad.tick({ btn: BTN.THROW });
  pad.tick({ btn: 0 });
  assert.equal(g.balls.size, 2);
});

test('lob: costs lob.cost, sets its own cooldown, carries the seq, and aims at tx,ty', () => {
  const g = siege();
  const pad = new Pad(g, 1);
  const balls = pad.kid.balls;
  pad.tick({ btn: BTN.LOB, tx: 700, ty: 180 });
  assert.ok(pad.kid.flags & AFLAG.LOBAIM);
  g.drainEvents();
  const seq = pad.queue({ btn: 0, tx: 700, ty: 180 });
  g.step();
  const events = g.drainEvents();
  const ev = events.find((e) => e.e === EV.BALL);
  assert.equal(ev.k, BALL.LOB);
  assert.equal(ev.seq, seq);
  assert.deepEqual([ev.lx, ev.ly], [700, 180]);
  assert.equal(pad.kid.balls, balls - THROW.lob.cost);
  near(pad.kid.throwCd, THROW.lob.cooldown);
  assert.ok(events.some((e) => e.e === EV.THROW && e.lob === true));
});

test('lob: targets clamp to maxRange along the same line', () => {
  const g = siege();
  const pad = new Pad(g, 1);
  const { kid } = pad;
  kid.x = 200;
  kid.y = 500;
  pad.tick({ btn: BTN.LOB, tx: 1100, ty: 500 });
  g.drainEvents();
  pad.tick({ btn: 0, tx: 1100, ty: 500 });
  const ev = g.drainEvents().find((e) => e.e === EV.BALL);
  near(ev.lx, kid.x + THROW.lob.maxRange, 0.01);
  near(ev.ly, 500, 0.01);
});

test('lob: one ball is not enough', () => {
  const g = siege();
  const pad = new Pad(g, 1);
  pad.kid.balls = 1;
  pad.tick({ btn: BTN.LOB });
  g.drainEvents();
  pad.tick({ btn: 0 });
  assert.equal(g.drainEvents().find((e) => e.e === EV.DENY).why, 'noBalls');
  assert.equal(pad.kid.balls, 1);
});

test('throwing: frozen and locked kids throw nothing and lose any charge', () => {
  const g = siege([human(1), human(2)]);
  const pad = new Pad(g, 1);
  pad.tick({ btn: BTN.THROW }, 5);
  g.freezeOrFlee(pad.kid, null);
  assert.equal(pad.kid.charge, 0);
  pad.tick({ btn: BTN.THROW }, 3);
  pad.tick({ btn: 0 });
  assert.equal(g.balls.size, 0);
});

test('throwing: a button held through a thaw starts charging once free', () => {
  const g = siege();
  const pad = new Pad(g, 1);
  g.freezeOrFlee(pad.kid, null);
  pad.tick({ btn: BTN.THROW }, 3);
  g.thawKid(pad.kid, null);
  pad.tick({ btn: BTN.THROW }, 3);
  assert.ok(pad.kid.flags & AFLAG.CHARGING);
  pad.tick({ btn: 0 });
  assert.equal(g.balls.size, 1);
});

// ---- packing ------------------------------------------------------------------

const packTicks = (mul = 1) => Math.ceil((KID.packDelay + KID.packTime * mul) * SIM_HZ) + 1;

test('packing: standing still packs balls up to the cap, flagged and with no reload key', () => {
  const g = siege();
  const pad = new Pad(g, 1);
  const { kid } = pad;
  kid.balls = 3;
  pad.tick({}, Math.ceil(KID.packDelay * SIM_HZ) - 1);
  assert.equal(kid.flags & AFLAG.PACKING, 0, 'not before packDelay');
  pad.tick({}, 2);
  assert.ok(kid.flags & AFLAG.PACKING);
  assert.equal(kid.balls, 3);
  pad.tick({}, packTicks());
  assert.ok(kid.balls >= 4);
  spin(() => pad.tick(), () => kid.balls === kid.maxBalls, 300);
  pad.tick({}, 3);
  assert.equal(kid.balls, kid.maxBalls);
  assert.equal(kid.flags & AFLAG.PACKING, 0, 'stops at the cap');
});

test('packing: one ball takes packTime after the delay, scaled by packTimeMul', () => {
  const g = siege();
  const pad = new Pad(g, 1);
  const { kid } = pad;
  kid.balls = 0;
  kid.mods = { ...defaultMods(), packTimeMul: 0.5 };
  let frames = 0;
  while (kid.balls === 0) {
    pad.tick();
    frames += 1;
    assert.ok(frames < 60);
  }
  near(frames, (KID.packDelay + KID.packTime * 0.5) * SIM_HZ, 1.5);
});

test('packing: moving resets it, and so does still gliding at speed', () => {
  const g = siege();
  const pad = new Pad(g, 1);
  const { kid } = pad;
  kid.balls = 3;
  pad.tick({}, 10);
  assert.ok(kid.packT > 0);
  pad.tick({ mx: 1 });
  assert.equal(kid.packT, 0);
  assert.equal(kid.flags & AFLAG.PACKING, 0);
  kid.vx = 150;
  pad.tick();
  assert.equal(kid.packT, 0, 'speed >= 20 is not standing still');
});

test('packing: charging interrupts it, and throwing resets it', () => {
  const g = siege();
  const pad = new Pad(g, 1);
  const { kid } = pad;
  kid.balls = 3;
  pad.tick({}, 10);
  pad.tick({ btn: BTN.THROW }, 2);
  assert.equal(kid.packT, 0);
  assert.equal(kid.flags & AFLAG.PACKING, 0);
  const balls = kid.balls;
  pad.tick({ btn: BTN.THROW }, 20);
  assert.equal(kid.balls, balls, 'no packing while charging');
});

test('packing: none on ice', () => {
  const g = siege();
  const pad = new Pad(g, 1);
  const { kid } = pad;
  kid.x = 340;
  kid.y = 660;
  kid.balls = 3;
  pad.tick({}, 40);
  assert.equal(kid.balls, 3);
  assert.equal(kid.packT, 0);
});

test('packing: none while frozen', () => {
  const g = siege([human(1), human(2)]);
  const pad = new Pad(g, 1);
  pad.kid.balls = 3;
  g.freezeOrFlee(pad.kid, null);
  pad.tick({}, 40);
  assert.equal(pad.kid.balls, 3);
});

// ---- slide --------------------------------------------------------------------

test('slide: emits once when it starts, and SLIDING tracks slideT', () => {
  const g = siege();
  const pad = new Pad(g, 1);
  g.drainEvents();
  pad.tick({ mx: 1, btn: BTN.SLIDE });
  assert.equal(g.drainEvents().filter((e) => e.e === EV.SLIDE).length, 1);
  assert.ok(pad.kid.flags & AFLAG.SLIDING);
  pad.tick({ mx: 1, btn: BTN.SLIDE }, 3);
  assert.equal(g.drainEvents().filter((e) => e.e === EV.SLIDE).length, 0);
  pad.tick({ mx: 1 }, 15);
  assert.equal(pad.kid.flags & AFLAG.SLIDING, 0);
});

test('slide: immune to flat balls while sliding, still hit by splash', () => {
  const g = siege();
  const pad = new Pad(g, 1);
  const { kid } = pad;
  const foe = dummy(g, ACTOR.PIPSQUEAK, kid.x + 60, kid.y);
  pad.tick({ my: 1, btn: BTN.SLIDE });
  assert.ok(kid.slideT > 0);
  const ball = g.throwFlat(foe, Math.PI, { speed: 1200, flight: 1, dmg: 9 });
  foe.x = kid.x + 40;
  foe.y = kid.y;
  ball.x = foe.x;
  ball.y = foe.y;
  ball.vy = 0;
  pad.tick({ my: 1 });
  assert.equal(kid.hp, kid.maxHp, 'the flat ball went straight through');

  kid.slideT = 0.2;
  const splash = g.throwLob(foe, kid.x, kid.y + 8, { flight: 0.1, dmg: 9, splash: 60 });
  assert.equal(splash.life, 3);
  pad.tick({ my: 1 }, 3);
  assert.ok(kid.slideT > 0 || kid.hp < kid.maxHp);
  assert.equal(kid.hp, kid.maxHp - 9);
});

test('slide: slideCdMul shortens the cooldown', () => {
  const g = siege();
  const pad = new Pad(g, 1);
  pad.kid.mods = { ...defaultMods(), slideCdMul: 0.5 };
  pad.tick({ mx: 1, btn: BTN.SLIDE });
  near(pad.kid.slideCd, KID.slideCooldown * 0.5);
});

// ---- specials and pickups -----------------------------------------------------

function give(g, kid, kind) {
  g.nextPickupId += 1;
  const p = { id: g.nextPickupId, kind, x: kid.x, y: kid.y, expiresAt: g.tick + 900 };
  g.pickups.set(p.id, p);
  return p;
}

test('specials: a pickup replaces the current special and pDel names the taker', () => {
  const g = siege();
  const pad = new Pad(g, 1);
  const { kid } = pad;
  give(g, kid, PICKUP.ICE);
  g.drainEvents();
  pad.tick();
  assert.equal(kid.special, PICKUP.ICE);
  assert.equal(kid.specialN, SPECIAL[PICKUP.ICE].uses);
  const del = g.drainEvents().find((e) => e.e === EV.P_DEL);
  assert.equal(del.by, 1);
  assert.equal(g.pickups.size, 0);
  give(g, kid, PICKUP.TRIPLE);
  pad.tick();
  assert.equal(kid.special, PICKUP.TRIPLE);
  assert.equal(kid.specialN, SPECIAL[PICKUP.TRIPLE].uses);
  assert.equal(g.privateState(1).special, PICKUP.TRIPLE);
});

test('specials: with none, You.special is 255', () => {
  const g = siege();
  assert.equal(g.privateState(1).special, 255);
  assert.equal(g.actors.get(1).specialN, 0);
});

test('specials: Ice Chunk does double damage, pierces one target, doubles against structs', () => {
  const g = siege();
  const pad = new Pad(g, 1);
  const { kid } = pad;
  kid.special = PICKUP.ICE;
  kid.specialN = 5;
  const first = dummy(g, ACTOR.BRUISER, kid.x + 100, kid.y, 1000);
  const second = dummy(g, ACTOR.BRUISER, kid.x + 170, kid.y, 1000);
  const third = dummy(g, ACTOR.BRUISER, kid.x + 240, kid.y, 1000);
  pad.tick({ btn: BTN.THROW, aim: 0 });
  pad.tick({ btn: 0, aim: 0 });
  assert.equal([...g.balls.values()][0].kind, BALL.ICE);
  pad.tick({ aim: 0 }, 20);
  near(first.hp, 1000 - THROW.quick.dmg * 2);
  near(second.hp, 1000 - THROW.quick.dmg * 2);
  assert.equal(third.hp, 1000, 'one pierce, not two');
  assert.equal(kid.specialN, 4);
});

test('specials: the last use clears the special', () => {
  const g = siege();
  const pad = new Pad(g, 1);
  pad.kid.special = PICKUP.ICE;
  pad.kid.specialN = 1;
  pad.tick({ btn: BTN.THROW });
  pad.tick({ btn: 0 });
  assert.equal(pad.kid.special, null);
  assert.equal(pad.kid.specialN, 0);
});

test('specials: Slushball bursts on impact and slows what it catches', () => {
  const g = siege();
  const pad = new Pad(g, 1);
  const { kid } = pad;
  kid.special = PICKUP.SLUSH;
  kid.specialN = 5;
  const target = dummy(g, ACTOR.BRUISER, kid.x + 100, kid.y, 1000);
  const neighbour = dummy(g, ACTOR.BRUISER, kid.x + 100, kid.y + 40, 1000);
  pad.tick({ btn: BTN.THROW, aim: 0 });
  g.drainEvents();
  pad.tick({ btn: 0, aim: 0 });
  pad.tick({ aim: 0 }, 8);
  const splash = g.drainEvents().find((e) => e.e === EV.SPLASH);
  assert.deepEqual([splash.r, splash.k], [SPECIAL[PICKUP.SLUSH].splash, BALL.SLUSH]);
  assert.ok(target.hp < 1000);
  assert.ok(neighbour.hp < 1000);
  assert.ok(target.slowT > 0);
  assert.ok(target.flags & AFLAG.SLOWED);
  assert.equal(target.maxHp - target.hp, THROW.quick.dmg, 'one dose, not a direct hit plus splash');
});

test('specials: Triple Toss is three balls for one snowball, one throw event, one seq', () => {
  const g = siege();
  const pad = new Pad(g, 1);
  const { kid } = pad;
  kid.special = PICKUP.TRIPLE;
  kid.specialN = 5;
  const balls = kid.balls;
  pad.tick({ btn: BTN.THROW, aim: 0 });
  g.drainEvents();
  const seq = pad.queue({ btn: 0, aim: 0 });
  g.step();
  const events = g.drainEvents();
  const thrown = events.filter((e) => e.e === EV.BALL);
  assert.equal(thrown.length, 3);
  assert.ok(thrown.every((e) => e.seq === seq));
  assert.equal(events.filter((e) => e.e === EV.THROW).length, 1);
  assert.equal(kid.balls, balls - 1);
  const angles = [...g.balls.values()].map((b) => Math.atan2(b.vy, b.vx)).sort((a, b) => a - b);
  near(angles[0], -SPECIAL[PICKUP.TRIPLE].spread);
  near(angles[1], 0);
  near(angles[2], SPECIAL[PICKUP.TRIPLE].spread);
});

test('specials: Giant Roller rolls at z=0, bowls through foes, stuns, expires', () => {
  const g = siege();
  const pad = new Pad(g, 1);
  const { kid } = pad;
  kid.special = PICKUP.GIANT;
  kid.specialN = 1;
  const spec = SPECIAL[PICKUP.GIANT];
  const one = g.spawnFoe(ACTOR.BRUISER, kid.x - 100, kid.y);
  const two = g.spawnFoe(ACTOR.BRUISER, kid.x - 200, kid.y);
  for (const foe of [one, two]) {
    foe.flags &= ~AFLAG.GRACE;
    foe.graceT = 0;
    foe.hp = 1000;
    foe.maxHp = 1000;
    foe.stunT = 0.001;
  }
  pad.tick({ btn: BTN.THROW, aim: Math.PI });
  pad.tick({ btn: 0, aim: Math.PI });
  const ball = [...g.balls.values()][0];
  assert.deepEqual([ball.kind, ball.z, ball.r, ball.rMax, ball.grow], [BALL.GIANT, 0, spec.r0, spec.r1, spec.grow]);
  near(Math.hypot(ball.vx, ball.vy), spec.speed);
  assert.equal(ball.life, spec.life * SIM_HZ);
  for (let i = 0; i < 30 && one.hp === 1000; i++) pad.tick({ aim: Math.PI });
  assert.equal(one.hp, 1000 - spec.dmg);
  assert.ok(one.stunT > 0.5, 'stunned on the way past');
  assert.ok(g.balls.has(ball.id), 'kept rolling');
  for (let i = 0; i < 30 && two.hp === 1000; i++) pad.tick({ aim: Math.PI });
  assert.equal(two.hp, 1000 - spec.dmg);
  assert.equal(one.hp, 1000 - spec.dmg, 'each target once');
  g.drainEvents();
  for (let i = 0; i < 120 && g.balls.has(ball.id); i++) pad.tick({ aim: Math.PI });
  assert.equal(g.balls.has(ball.id), false);
});

test('specials: Hot Cocoa heals instantly and leaves the special alone', () => {
  const g = siege();
  const pad = new Pad(g, 1);
  const { kid } = pad;
  kid.hp = 30;
  kid.special = PICKUP.ICE;
  kid.specialN = 2;
  give(g, kid, PICKUP.COCOA);
  pad.tick();
  assert.equal(kid.hp, 30 + SPECIAL[PICKUP.COCOA].heal);
  assert.equal(kid.special, PICKUP.ICE);
  kid.hp = kid.maxHp - 3;
  give(g, kid, PICKUP.COCOA);
  pad.tick();
  assert.equal(kid.hp, kid.maxHp);
});

test('specials: the Snowboard grants boardTime of speed', () => {
  const g = siege();
  const pad = new Pad(g, 1);
  give(g, pad.kid, PICKUP.BOARD);
  pad.tick();
  near(pad.kid.boardT, KID.boardTime);
  assert.ok(pad.kid.flags & AFLAG.BOARDING);
  pad.tick({ mx: 1 }, 15);
  near(pad.kid.vx, KID.speed * KID.boardSpeedMul, 1e-6);
});

test('pickups: frozen kids cannot collect, and unclaimed ones expire with a pDel', () => {
  const g = siege([human(1), human(2)]);
  const kid = g.actors.get(1);
  g.freezeOrFlee(kid, null);
  const p = give(g, kid, PICKUP.ICE);
  g.step();
  assert.equal(g.pickups.size, 1);
  p.expiresAt = g.tick + 1;
  g.drainEvents();
  g.step();
  assert.equal(g.pickups.size, 0);
  const del = g.drainEvents().find((e) => e.e === EV.P_DEL);
  assert.deepEqual([del.id, del.by], [p.id, 0]);
});

// ---- warmth, freeze, thaw -----------------------------------------------------

test('warmth: regen waits for regenDelay after the last hit, scaled by regenMul', () => {
  const g = siege();
  const kid = g.actors.get(1);
  g.damageActor(kid, 50, null);
  for (let i = 0; i < KID.regenDelay * SIM_HZ - 1; i++) g.step();
  assert.equal(kid.hp, 50);
  kid.mods = { ...defaultMods(), regenMul: 2 };
  for (let i = 0; i < SIM_HZ + 1; i++) g.step();
  near(kid.hp, 50 + KID.regenPerSec * 2, 1);
  g.damageActor(kid, 1, null);
  const after = kid.hp;
  for (let i = 0; i < 30; i++) g.step();
  assert.equal(kid.hp, after, 'a new hit resets the delay');
});

test('freeze: warmth reaching 0 freezes, at hp 0, with an event and no movement', () => {
  const g = siege([human(1), human(2)]);
  const pad = new Pad(g, 1);
  const { kid } = pad;
  const foe = dummy(g, ACTOR.PIPSQUEAK, 100, 400);
  g.drainEvents();
  g.damageActor(kid, 1000, foe, { kx: 100, ky: 0 });
  const freeze = g.drainEvents().find((e) => e.e === EV.FREEZE);
  assert.deepEqual([freeze.id, freeze.by], [1, foe.id]);
  assert.equal(kid.hp, 0);
  assert.ok(kid.flags & AFLAG.FROZEN);
  const { x, y } = kid;
  pad.tick({ mx: 1 }, 5);
  assert.deepEqual([kid.x, kid.y], [x, y]);
  assert.equal(g.damageActor(kid, 5, foe), 0, 'nothing more to take');
  near(kid.frozenT, KID.frozenAutoThaw - 5 * DT);
  assert.equal(g.privateState(1).frozenT, Math.ceil(KID.frozenAutoThaw - 5 * DT));
});

test('thaw: a friend standing close thaws in thawTime, with credit and GRACE', () => {
  const g = siege([human(1), human(2)]);
  const frozen = g.actors.get(1);
  const friend = g.actors.get(2);
  friend.x = frozen.x + KID.thawRange - 1;
  friend.y = frozen.y;
  g.freezeOrFlee(frozen, null);
  g.drainEvents();
  let ticks = 0;
  while (frozen.flags & AFLAG.FROZEN) {
    g.step();
    ticks += 1;
    assert.ok(ticks < 100);
  }
  near(ticks, KID.thawTime * SIM_HZ, 1);
  const thaw = g.drainEvents().find((e) => e.e === EV.THAW);
  assert.deepEqual([thaw.id, thaw.by], [1, 2]);
  assert.equal(frozen.hp, KID.thawWarmth);
  assert.equal(friend.stats.thaws, 1);
  assert.ok(frozen.flags & AFLAG.GRACE);
});

test('thaw: progress is cumulative, shows in aux, and survives the friend stepping away', () => {
  const g = siege([human(1), human(2)]);
  const frozen = g.actors.get(1);
  const friend = g.actors.get(2);
  friend.x = frozen.x + 20;
  friend.y = frozen.y;
  g.freezeOrFlee(frozen, null);
  for (let i = 0; i < 30; i++) g.step();
  const aux = frozen.aux;
  assert.ok(aux > 0 && aux < 255);
  friend.x = frozen.x + KID.thawRange + 40;
  for (let i = 0; i < 30; i++) g.step();
  assert.equal(frozen.aux, aux, 'held, not lost');
  friend.x = frozen.x + 20;
  let ticks = 0;
  while (frozen.flags & AFLAG.FROZEN) {
    g.step();
    ticks += 1;
    assert.ok(ticks < 60);
  }
  near(ticks, KID.thawTime * SIM_HZ - 30, 1);
});

test('thaw: a Cocoa Stand doubles the speed and stands do not stack', () => {
  for (const stands of [1, 3]) {
    const g = siege([human(1), human(2)]);
    const frozen = g.actors.get(1);
    const friend = g.actors.get(2);
    friend.x = frozen.x + 20;
    friend.y = frozen.y;
    g.flakes[TEAM.A] = 100;
    const builder = g.actors.get(1);
    for (let i = 0; i < stands; i++) g.command(1, { c: CMD.BUILD, k: STRUCT.COCOA, cx: 11 + i, cy: 5 });
    assert.equal([...g.structs.values()].filter((s) => s.kind === STRUCT.COCOA).length, stands);
    g.freezeOrFlee(builder, null);
    let ticks = 0;
    while (frozen.flags & AFLAG.FROZEN) {
      g.step();
      ticks += 1;
      assert.ok(ticks < 100);
    }
    near(ticks, (KID.thawTime * SIM_HZ) / BUILD[STRUCT.COCOA].thawMul, 1, `${stands} stands`);
  }
});

test('thaw: thawTimeMul belongs to the friend doing the thawing', () => {
  const g = siege([human(1), human(2)]);
  const frozen = g.actors.get(1);
  const friend = g.actors.get(2);
  friend.x = frozen.x + 20;
  friend.y = frozen.y;
  friend.mods = { ...defaultMods(), thawTimeMul: 0.5 };
  g.freezeOrFlee(frozen, null);
  let ticks = 0;
  while (frozen.flags & AFLAG.FROZEN) {
    g.step();
    ticks += 1;
  }
  near(ticks, KID.thawTime * 0.5 * SIM_HZ, 1);
});

test('thaw: frozen friends can\'t help', () => {
  const g = siege([human(1), human(2), human(3)]);
  const a = g.actors.get(1);
  const b = g.actors.get(2);
  b.x = a.x + 10;
  b.y = a.y;
  g.freezeOrFlee(a, null);
  g.freezeOrFlee(b, null);
  for (let i = 0; i < KID.thawTime * SIM_HZ + 10; i++) g.step();
  assert.ok(a.flags & AFLAG.FROZEN);
  assert.equal(a.aux, 0);
});

test('thaw: auto-thaw after frozenAutoThaw at autoThawWarmth, by nobody', () => {
  const g = siege([human(1), human(2)]);
  const frozen = g.actors.get(1);
  g.freezeOrFlee(frozen, null);
  g.drainEvents();
  for (let i = 0; i < KID.frozenAutoThaw * SIM_HZ - 2; i++) g.step();
  assert.ok(frozen.flags & AFLAG.FROZEN, 'not early');
  for (let i = 0; i < 4; i++) g.step();
  assert.equal(frozen.flags & AFLAG.FROZEN, 0);
  assert.equal(frozen.hp, KID.autoThawWarmth);
  assert.equal(g.drainEvents().find((e) => e.e === EV.THAW).by, 0);
  assert.ok(frozen.flags & AFLAG.GRACE);
});

test('thaw: with no teammate unfrozen, remaining auto-thaw caps at loneAutoThaw', () => {
  const alone = siege();
  const kid = alone.actors.get(1);
  alone.freezeOrFlee(kid, null);
  alone.step();
  assert.ok(kid.frozenT <= KID.loneAutoThaw);
  let ticks = 1;
  while (kid.flags & AFLAG.FROZEN) {
    alone.step();
    ticks += 1;
    assert.ok(ticks < 1000);
  }
  near(ticks, KID.loneAutoThaw * SIM_HZ, 1);

  const pair = siege([human(1), bot(2)]);
  const [a, b] = [pair.actors.get(1), pair.actors.get(2)];
  pair.freezeOrFlee(a, null);
  pair.step();
  assert.ok(a.frozenT > KID.loneAutoThaw, 'a bot on its feet is still a teammate');
  pair.freezeOrFlee(b, null);
  pair.step();
  assert.ok(a.frozenT <= KID.loneAutoThaw, 'a wipe caps everyone');
  assert.ok(b.frozenT <= KID.loneAutoThaw);
});

test('thaw: a wipe does not end the game', () => {
  const g = siege([human(1), human(2)]);
  for (const kid of g.kids()) g.freezeOrFlee(kid, null);
  for (let i = 0; i < 20; i++) g.step();
  assert.equal(g.isOver(), false);
});

test('grace: balls pass through for thawGrace, foes ignore you, and it then ends', () => {
  const g = siege([human(1), human(2)]);
  const kid = g.actors.get(1);
  g.freezeOrFlee(kid, null);
  g.thawKid(kid, null);
  const foe = dummy(g, ACTOR.PIPSQUEAK, kid.x + 100, kid.y);
  const other = g.actors.get(2);
  other.x = 40;
  other.y = 40;
  assert.equal(g.nearestEnemy(foe, 200), null, 'foes do not see you');
  assert.deepEqual(g.enemiesInRadius(foe.team, kid.x, kid.y, 50), []);
  g.throwFlat(foe, Math.PI, { speed: 500, flight: 1, dmg: 6 });
  for (let i = 0; i < 10; i++) g.step();
  assert.equal(kid.hp, KID.autoThawWarmth);
  for (let i = 0; i < KID.thawGrace * SIM_HZ; i++) g.step();
  assert.equal(kid.flags & AFLAG.GRACE, 0);
  assert.equal(g.nearestEnemy(foe, 200), kid);
});

test('grace: throwing ends it early', () => {
  const g = siege([human(1), human(2)]);
  const pad = new Pad(g, 1);
  g.freezeOrFlee(pad.kid, null);
  g.thawKid(pad.kid, null);
  assert.ok(pad.kid.flags & AFLAG.GRACE);
  pad.tick({ btn: BTN.THROW });
  assert.ok(pad.kid.flags & AFLAG.GRACE, 'charging alone keeps it');
  pad.tick({ btn: 0 });
  assert.equal(pad.kid.flags & AFLAG.GRACE, 0);
  assert.equal(pad.kid.graceT, 0);
});

test('cocoa: heals healPerSec in range, once however many stands', () => {
  const g = siege();
  const kid = g.actors.get(1);
  g.flakes[TEAM.A] = 100;
  g.command(1, { c: CMD.BUILD, k: STRUCT.COCOA, cx: 11, cy: 5 });
  g.command(1, { c: CMD.BUILD, k: STRUCT.COCOA, cx: 12, cy: 5 });
  kid.hp = 20;
  kid.sinceHit = 0;
  for (let i = 0; i < SIM_HZ; i++) g.step();
  near(kid.hp, 20 + BUILD[STRUCT.COCOA].healPerSec, 0.01);
});

test('cocoa: out of range does nothing', () => {
  const g = siege();
  const kid = g.actors.get(1);
  g.command(1, { c: CMD.BUILD, k: STRUCT.COCOA, cx: 11, cy: 5 });
  kid.x = 900;
  kid.y = 700;
  kid.hp = 20;
  kid.sinceHit = 0;
  for (let i = 0; i < SIM_HZ; i++) g.step();
  assert.equal(kid.hp, 20);
});

// ---- input rule ---------------------------------------------------------------

function spyFrames(g) {
  const seen = [];
  const applyFrame = g.applyFrame.bind(g);
  g.applyFrame = (kid, frame) => {
    seen.push({ ...frame, kidId: kid.id });
    applyFrame(kid, frame);
  };
  return seen;
}

test('input: ignores seq <= last queued, and a kid with no input state', () => {
  const g = siege();
  const seen = spyFrames(g);
  const frame = (seq) => ({ seq, mx: 0, my: 0, aim: 0, btn: 0, tx: 0, ty: 0 });
  g.queueInput(1, frame(5));
  g.queueInput(1, frame(5));
  g.queueInput(1, frame(3));
  g.queueInput(1, frame(6));
  g.queueInput(99, frame(1));
  g.step();
  assert.deepEqual(seen.map((f) => f.seq), [5, 6]);
  assert.equal(g.ackSeq(1), 6);
  assert.equal(g.ackSeq(99), 0);
});

test('input: credit gains 1 a tick from 1, so a fresh kid applies at most 2 at once', () => {
  const g = siege();
  const seen = spyFrames(g);
  const pad = new Pad(g, 1);
  for (let i = 0; i < 4; i++) pad.queue();
  g.step();
  assert.deepEqual(seen.map((f) => f.seq), [1, 2]);
  g.step();
  assert.deepEqual(seen.map((f) => f.seq), [1, 2, 3]);
  g.step();
  assert.deepEqual(seen.map((f) => f.seq), [1, 2, 3, 4]);
});

test('input: credit banks up to MAX_INPUT_BACKLOG, allowing one catch-up burst', () => {
  const g = siege();
  const seen = spyFrames(g);
  const pad = new Pad(g, 1);
  for (let i = 0; i < 4; i++) g.step();
  seen.length = 0;
  for (let i = 0; i < MAX_INPUT_BACKLOG; i++) pad.queue();
  g.step();
  assert.equal(seen.length, MAX_INPUT_BACKLOG);
  assert.equal(g.ackSeq(1), MAX_INPUT_BACKLOG);
});

test('input: credit never exceeds the cap however long the silence', () => {
  const g = siege();
  for (let i = 0; i < 40; i++) g.step();
  assert.equal(g.inputs.get(1).credit, MAX_INPUT_BACKLOG);
});

test('input: a backlog over the cap drops oldest down to 2, ORing btn forward and acking', () => {
  const g = siege();
  const seen = spyFrames(g);
  const pad = new Pad(g, 1);
  const buttons = [BTN.SLIDE, 0, BTN.THROW, 0, BTN.LOB, 0, 0];
  for (const btn of buttons) pad.queue({ btn });
  g.step();
  assert.equal(seen[0].seq, 6, 'frames 1..5 were dropped');
  assert.equal(seen[0].btn, BTN.SLIDE | BTN.THROW | BTN.LOB);
  assert.equal(seen[1].seq, 7);
  assert.equal(seen[1].btn, 0);
  assert.equal(g.ackSeq(1), 7);
});

test('input: dropping never loses a press and release', () => {
  const g = siege();
  const pad = new Pad(g, 1);
  for (let i = 0; i < 4; i++) g.step();
  // A tap buried in a backlog: down at 2, up from 3 on. Only 8 and 9 survive the drop.
  for (const btn of [0, BTN.THROW, 0, 0, 0, 0, 0, 0, 0]) pad.queue({ btn, aim: -0.5 });
  g.step();
  assert.equal(g.balls.size, 1, 'the tap still threw a ball');
});

test('input: a queue over 2 for 30 straight ticks drops one, ORing and acking it', () => {
  const g = siege();
  const seen = spyFrames(g);
  const pad = new Pad(g, 1);
  // Spend the spare credit so exactly one frame applies per tick, with 3 frames waiting
  // at the rule's check on every tick.
  pad.queue();
  pad.queue();
  g.step();
  for (let i = 0; i < 3; i++) pad.queue();
  g.step();
  assert.equal(g.inputs.get(1).credit, 0);
  seen.length = 0;
  let dropTick = -1;
  for (let i = 0; i < 40 && dropTick < 0; i++) {
    pad.queue({ btn: i === 27 ? BTN.SLIDE : 0 });
    const ack = g.ackSeq(1);
    g.step();
    if (g.ackSeq(1) - ack > 1) dropTick = i;
  }
  assert.ok(dropTick >= 0, 'a frame was dropped');
  assert.ok(dropTick <= 31);
  const applied = seen.map((f) => f.seq);
  const gap = applied.findIndex((seq, i) => i > 0 && seq !== applied[i - 1] + 1);
  assert.ok(gap > 0, 'one seq is missing from what was applied');
  assert.equal(applied[gap] - applied[gap - 1], 2);
  assert.equal(g.inputs.get(1).backedUpTicks, 0);
});

test('input: a queue that dips to 2 restarts the 30-tick count', () => {
  const g = siege();
  const pad = new Pad(g, 1);
  pad.queue();
  pad.queue();
  g.step();
  for (let i = 0; i < 3; i++) pad.queue();
  g.step();
  for (let i = 0; i < 20; i++) {
    pad.queue();
    g.step();
  }
  assert.ok(g.inputs.get(1).backedUpTicks > 15);
  g.step();
  g.step();
  assert.equal(g.inputs.get(1).backedUpTicks, 0);
});

test('input: a starved kid waits 6 ticks, then gets neutral frames, ack unchanged', () => {
  const g = siege();
  const seen = spyFrames(g);
  const pad = new Pad(g, 1);
  pad.tick({ mx: 1, aim: 1.25, tx: 300, ty: 310 });
  const ack = g.ackSeq(1);
  seen.length = 0;
  for (let i = 0; i < 6; i++) g.step();
  assert.equal(seen.length, 0, 'simply waits');
  g.step();
  assert.equal(seen.length, 1);
  const neutral = seen[0];
  assert.deepEqual([neutral.mx, neutral.my, neutral.btn, neutral.aim, neutral.tx, neutral.ty], [0, 0, BTN.CANCEL, 1.25, 300, 310]);
  assert.equal(g.ackSeq(1), ack);
  g.step();
  assert.equal(seen.length, 2, 'one per tick from then on');
  assert.equal(g.ackSeq(1), ack);
});

test('input: a frame is never repeated', () => {
  const g = siege();
  const seen = spyFrames(g);
  const pad = new Pad(g, 1);
  pad.tick({ mx: 1 }, 3);
  const { x } = pad.kid;
  for (let i = 0; i < 40; i++) g.step();
  const seqs = seen.filter((f) => f.seq !== undefined).map((f) => f.seq);
  assert.deepEqual(seqs, [1, 2, 3]);
  assert.ok(seen.slice(3).every((f) => f.mx === 0 && f.my === 0));
  assert.ok(pad.kid.x < x + 20, 'it does not keep walking on stale input');
});

test('input: a charge held when the connection stalls is cancelled, not thrown', () => {
  const g = siege();
  const pad = new Pad(g, 1);
  const balls = pad.kid.balls;
  pad.tick({ btn: BTN.THROW }, 10);
  for (let i = 0; i < 10; i++) g.step();
  assert.equal(pad.kid.charge, 0);
  pad.tick({ btn: 0 });
  assert.equal(g.balls.size, 0);
  assert.equal(pad.kid.balls, balls);
});

test('input: motion timers wait for applied frames while a kid is starved', () => {
  const g = siege();
  const pad = new Pad(g, 1);
  pad.tick({ mx: 1, btn: BTN.SLIDE });
  const cd = pad.kid.slideCd;
  for (let i = 0; i < 6; i++) g.step();
  assert.equal(pad.kid.slideCd, cd, 'no frame, no tick');
  g.step();
  near(pad.kid.slideCd, cd - DT);
});

test('input: AFK after 5 s of silence, cleared when frames return', () => {
  const g = siege();
  const pad = new Pad(g, 1);
  pad.tick();
  for (let i = 0; i < 5 * SIM_HZ - 1; i++) g.step();
  assert.equal(pad.kid.flags & AFLAG.AFK, 0);
  g.step();
  assert.ok(pad.kid.flags & AFLAG.AFK);
  pad.tick();
  assert.equal(pad.kid.flags & AFLAG.AFK, 0);
});

test('input: ackSeq advances while frozen, while LOCKED, and in BUILD', () => {
  const g = siege([human(1), human(2)]);
  const pad = new Pad(g, 1);
  pad.tick({}, 3);
  assert.equal(g.ackSeq(1), 3);
  g.freezeOrFlee(pad.kid, null);
  const { x } = pad.kid;
  pad.tick({ mx: 1 }, 3);
  assert.equal(g.ackSeq(1), 6);
  assert.equal(pad.kid.x, x);

  const f = faceOff();
  const locked = new Pad(f, 1);
  locked.tick({}, 2);
  f.colonel(TEAM.B).hp = 0;
  stepUntil(f, () => f.phase === PHASE.FIGHT);
  f.colonel(TEAM.B).hp = 0;
  locked.tick();
  assert.equal(f.phase, PHASE.ROUND_END);
  assert.ok(locked.kid.flags & AFLAG.LOCKED);
  const before = f.ackSeq(1);
  locked.tick({ mx: 1 }, 2);
  assert.equal(f.ackSeq(1), before + 2);
});

test('input: resetInput restarts seq at 1 with credit 1', () => {
  const g = siege();
  const seen = spyFrames(g);
  const pad = new Pad(g, 1);
  pad.tick({}, 5);
  for (let i = 0; i < 4; i++) pad.queue();
  g.resetInput(1);
  assert.equal(g.ackSeq(1), 0);
  assert.equal(g.inputs.get(1).credit, 1);
  assert.equal(g.inputs.get(1).queue.length, 0);
  seen.length = 0;
  g.queueInput(1, { seq: 1, mx: 0, my: 0, aim: 0, btn: 0, tx: 0, ty: 0 });
  g.step();
  assert.deepEqual(seen.map((f) => f.seq), [1]);
  assert.equal(g.ackSeq(1), 1);
});

test('input: bots apply exactly one frame a tick with the seq ignored', () => {
  const g = siege([human(1), bot(2)]);
  const seen = spyFrames(g);
  for (let i = 0; i < 5; i++) g.step();
  assert.equal(seen.filter((f) => f.kidId === 2).length, 5);
  assert.equal(g.ackSeq(2), 0);
});

test('input: garbage numbers in a frame cannot reach the simulation', () => {
  const g = siege();
  const pad = new Pad(g, 1);
  pad.tick({ mx: NaN, my: Infinity, aim: NaN, tx: NaN, ty: -Infinity, btn: 255 });
  const { kid } = pad;
  for (const key of ['x', 'y', 'vx', 'vy', 'aim', 'tx', 'ty']) assert.ok(Number.isFinite(kid[key]), key);
  assert.equal(kid.prevBtn & ~15, 0, 'unknown button bits are stripped');
});

// ---- building -----------------------------------------------------------------

const buildOk = (g, k, cx, cy, id = 1) => {
  g.command(id, { c: CMD.BUILD, k, cx, cy });
  assert.ok(g.structAt(cx, cy), 'it was built');
  return g.structAt(cx, cy);
};

const denied = (g) => g.drainEvents().filter((e) => e.e === EV.DENY).map((e) => e.why);

test('build: spends the team\'s Flakes, tracks the owner, announces sAdd, updates cw', () => {
  const g = siege();
  g.drainEvents();
  const wall = buildOk(g, STRUCT.WALL, 13, 5);
  assert.deepEqual(
    [wall.kind, wall.cx, wall.cy, wall.team, wall.hp, wall.maxHp, wall.ownerId],
    [STRUCT.WALL, 13, 5, TEAM.A, 60, 60, 1],
  );
  assert.equal(g.flakes[TEAM.A], SIEGE.startFlakes - BUILD[STRUCT.WALL].cost);
  assert.equal(g.actors.get(1).stats.built, 1);
  assert.equal(g.cw.isSolidCell(13, 5), true);
  const add = g.drainEvents().find((e) => e.e === EV.S_ADD);
  assert.deepEqual(
    [add.id, add.k, add.cx, add.cy, add.tm, add.hp, add.mhp, add.by],
    [wall.id, STRUCT.WALL, 13, 5, TEAM.A, 60, 60, 1],
  );
});

test('build: works in FIGHT too, but not in ROUND_END, OVER or while frozen', () => {
  const g = siege();
  startFight(g);
  buildOk(g, STRUCT.WALL, 13, 5);
  g.freezeOrFlee(g.actors.get(1), null);
  g.drainEvents();
  g.command(1, { c: CMD.BUILD, k: STRUCT.WALL, cx: 12, cy: 5 });
  assert.equal(g.structAt(12, 5), null);
  assert.deepEqual(denied(g), ['badCell']);
});

test('build: refusals are private and use canPlace\'s words', () => {
  const g = siege();
  const kid = g.actors.get(1);
  g.drainEvents();
  g.flakes[TEAM.A] = 1;
  g.command(1, { c: CMD.BUILD, k: STRUCT.WALL, cx: 13, cy: 5 });
  const [deny] = g.drainEvents();
  assert.deepEqual([deny.e, deny.to, deny.why], [EV.DENY, 1, 'noFlakes']);
  g.flakes[TEAM.A] = 100;
  g.command(1, { c: CMD.BUILD, k: STRUCT.WALL, cx: 29, cy: 18 });
  assert.deepEqual(denied(g), ['tooFar']);
  g.command(1, { c: CMD.BUILD, k: STRUCT.WALL, cx: Math.floor(kid.x / CELL), cy: Math.floor(kid.y / CELL) });
  assert.deepEqual(denied(g), ['badCell']);
  g.command(1, { c: CMD.BUILD, k: 'wall', cx: 1.5, cy: null });
  assert.deepEqual(denied(g), ['badCell']);
  assert.equal(g.flakes[TEAM.A], 100, 'nothing charged');
});

test('build: entrances keep their no-build ring in Siege', () => {
  const g = siege();
  const kid = g.actors.get(1);
  kid.x = 100;
  kid.y = 300;
  g.command(1, { c: CMD.BUILD, k: STRUCT.WALL, cx: 2, cy: 9 });
  assert.equal(g.structAt(2, 9), null);
});

test('build: buildRangeMul and wallHpMul are honored, wall kinds only', () => {
  const g = siege();
  const kid = g.actors.get(1);
  kid.mods = { ...defaultMods(), buildRangeMul: 2, wallHpMul: 1.25 };
  g.flakes[TEAM.A] = 100;
  const wall = buildOk(g, STRUCT.WALL, 13 + 10, 7);
  assert.equal(wall.maxHp, BUILD[STRUCT.WALL].hp * 1.25);
  assert.equal(wall.hp, wall.maxHp);
  const ice = buildOk(g, STRUCT.ICEWALL, 13, 5);
  assert.equal(ice.maxHp, BUILD[STRUCT.ICEWALL].hp * 1.25);
  const coat = buildOk(g, STRUCT.DECOY, 12, 5);
  assert.equal(coat.maxHp, BUILD[STRUCT.DECOY].hp);
});

test('build: flinger limit is base + perPlayer * ceil(weighted team), FFA one each', () => {
  const g = siege([human(1), bot(2)]);
  const { base, perPlayer } = BUILD[STRUCT.PULT].limit;
  assert.equal(g.meta().pultLimit[TEAM.A], base + perPlayer * Math.ceil(1.5));
  const f = ffa();
  assert.equal(f.meta().pultLimit[TEAM.FFA_BASE], 1);
  assert.equal(f.meta().pultLimit[TEAM.FFA_BASE + 1], 1);
});

test('build: a cell cannot be double-booked, and Slick can be stood on', () => {
  const g = siege();
  const kid = g.actors.get(1);
  const cell = g.cw.cellOf(kid.x, kid.y);
  const slick = buildOk(g, STRUCT.SLICK, cell.cx, cell.cy);
  assert.equal(g.cw.isSolidCell(cell.cx, cell.cy), false);
  g.drainEvents();
  g.command(1, { c: CMD.BUILD, k: STRUCT.WALL, cx: cell.cx, cy: cell.cy });
  assert.deepEqual(denied(g), ['badCell']);
  assert.equal(g.structAt(cell.cx, cell.cy), slick);
});

test('repair: full hp for ceil(REPAIR_COST_MUL * cost), by any kid on the team', () => {
  const g = siege([human(1), human(2)]);
  const wall = buildOk(g, STRUCT.ICEWALL, 13, 5);
  wall.hp = 10;
  const flakes = g.flakes[TEAM.A];
  g.actors.get(2).x = 520;
  g.actors.get(2).y = 260;
  g.drainEvents();
  g.command(2, { c: CMD.BUILD, k: STRUCT.ICEWALL, cx: 13, cy: 5 });
  assert.equal(wall.hp, wall.maxHp);
  assert.equal(g.flakes[TEAM.A], flakes - Math.ceil(REPAIR_COST_MUL * BUILD[STRUCT.ICEWALL].cost));
  assert.equal(wall.ownerId, 1);
  const events = g.drainEvents();
  assert.deepEqual(events.filter((e) => e.e === EV.S_HP).map((e) => e.hp), [wall.maxHp]);
  assert.equal(g.actors.get(2).stats.built, 0, 'repairs do not count as built');
});

test('repair: short on Flakes is noFlakes and an undamaged wall is badCell', () => {
  const g = siege();
  const wall = buildOk(g, STRUCT.WALL, 13, 5);
  g.drainEvents();
  g.command(1, { c: CMD.BUILD, k: STRUCT.WALL, cx: 13, cy: 5 });
  assert.deepEqual(denied(g), ['badCell']);
  wall.hp = 1;
  g.flakes[TEAM.A] = 0;
  g.command(1, { c: CMD.BUILD, k: STRUCT.WALL, cx: 13, cy: 5 });
  assert.deepEqual(denied(g), ['noFlakes']);
  assert.equal(wall.hp, 1);
});

test('patch: +pct of mhp for cost, three per BUILD, BUILD only', () => {
  const g = siege();
  const kid = g.actors.get(1);
  const col = g.colonel(TEAM.A);
  kid.x = 540;
  kid.y = 340;
  col.hp = col.maxHp / 2;
  g.flakes[TEAM.A] = 100;
  const { pct, cost, perBuild } = SIEGE.colonelPatch;
  assert.equal(g.meta().patchesLeft, perBuild);
  for (let i = 1; i <= perBuild; i++) {
    g.command(1, { c: CMD.BUILD, k: STRUCT.WALL, cx: col.cx, cy: col.cy });
    near(col.hp, col.maxHp / 2 + i * pct * col.maxHp);
    assert.equal(g.flakes[TEAM.A], 100 - i * cost);
    assert.equal(g.meta().patchesLeft, perBuild - i);
  }
  g.drainEvents();
  g.command(1, { c: CMD.BUILD, k: STRUCT.WALL, cx: col.cx + 1, cy: col.cy + 1 });
  assert.deepEqual(denied(g), ['badCell']);
  near(col.hp, col.maxHp / 2 + perBuild * pct * col.maxHp);
});

test('patch: every Colonel cell works, and hp never passes the cap', () => {
  const g = siege();
  const kid = g.actors.get(1);
  const col = g.colonel(TEAM.A);
  kid.x = 540;
  kid.y = 340;
  col.hp = col.maxHp - 1;
  g.command(1, { c: CMD.BUILD, k: STRUCT.WALL, cx: col.cx + 1, cy: col.cy + 1 });
  assert.equal(col.hp, col.maxHp);
});

test('patch: refused on a healthy Colonel so a painted wall line can\'t waste Flakes', () => {
  const g = siege();
  const kid = g.actors.get(1);
  const col = g.colonel(TEAM.A);
  kid.x = 540;
  kid.y = 340;
  const flakes = g.flakes[TEAM.A];
  g.drainEvents();
  g.command(1, { c: CMD.BUILD, k: STRUCT.WALL, cx: col.cx, cy: col.cy });
  assert.deepEqual(denied(g), ['badCell']);
  assert.equal(g.flakes[TEAM.A], flakes);
  assert.equal(g.meta().patchesLeft, SIEGE.colonelPatch.perBuild);
});

test('patch: not in FIGHT, and each new BUILD refills them', () => {
  const g = siege();
  const kid = g.actors.get(1);
  const col = g.colonel(TEAM.A);
  kid.x = 540;
  kid.y = 340;
  col.hp = col.maxHp / 2;
  g.command(1, { c: CMD.BUILD, k: STRUCT.WALL, cx: col.cx, cy: col.cy });
  assert.equal(g.meta().patchesLeft, SIEGE.colonelPatch.perBuild - 1);
  startFight(g);
  const hp = col.hp;
  g.drainEvents();
  kid.x = 540;
  kid.y = 340;
  g.command(1, { c: CMD.BUILD, k: STRUCT.WALL, cx: col.cx, cy: col.cy });
  assert.deepEqual(denied(g), ['badCell']);
  assert.equal(col.hp, hp);
  beatWave(g);
  assert.equal(g.phase, PHASE.BUILD);
  assert.equal(g.meta().patchesLeft, SIEGE.colonelPatch.perBuild);
});

test('demolish: your own refunds floor(0.5 * cost * hp fraction) and clears the cell', () => {
  const g = siege();
  const wall = buildOk(g, STRUCT.PULT, 13, 5);
  wall.hp = wall.maxHp * 0.7;
  const flakes = g.flakes[TEAM.A];
  g.drainEvents();
  g.command(1, { c: CMD.DEMOLISH, cx: 13, cy: 5 });
  assert.equal(g.structAt(13, 5), null);
  assert.equal(g.cw.isSolidCell(13, 5), false);
  assert.equal(g.flakes[TEAM.A], flakes + Math.floor(DEMOLISH_REFUND * BUILD[STRUCT.PULT].cost * 0.7));
  const del = g.drainEvents().find((e) => e.e === EV.S_DEL);
  assert.deepEqual([del.id, del.k, del.cx, del.cy, del.why], [wall.id, STRUCT.PULT, 13, 5, 'demolished']);
});

test('demolish: the Colonel is refused on all four cells and takes no harm', () => {
  const g = siege();
  const kid = g.actors.get(1);
  const col = g.colonel(TEAM.A);
  kid.x = 540;
  kid.y = 340;
  g.drainEvents();
  for (const [ox, oy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
    g.command(1, { c: CMD.DEMOLISH, cx: col.cx + ox, cy: col.cy + oy });
    assert.deepEqual(denied(g), ['badCell']);
  }
  assert.equal(g.structs.get(col.id), col);
  assert.equal(col.hp, col.maxHp);
  assert.equal(g.cw.isSolidCell(col.cx, col.cy), true);
});

test('demolish: empty cells and enemy structs are badCell, and range is enforced', () => {
  const g = faceOff();
  const pad = new Pad(g, 1);
  g.drainEvents();
  g.command(1, { c: CMD.DEMOLISH, cx: 8, cy: 8 });
  assert.deepEqual(denied(g), ['badCell']);
  const mine = buildOk(g, STRUCT.WALL, 5, 8);
  pad.kid.x = 500;
  pad.kid.y = 700;
  g.command(1, { c: CMD.DEMOLISH, cx: 5, cy: 8 });
  assert.deepEqual(denied(g), ['tooFar']);
  assert.equal(g.structs.get(mine.id), mine);
});

test('demolish: a teammate\'s struct needs you within range, refunds nothing, and has a cooldown', () => {
  const g = siege([human(1), human(2)]);
  const a = new Pad(g, 1);
  const b = new Pad(g, 2);
  const first = buildOk(g, STRUCT.WALL, 13, 5, 2);
  const second = buildOk(g, STRUCT.WALL, 14, 5, 2);
  const flakes = g.flakes[TEAM.A];
  a.kid.x = 13.5 * CELL + TEAMMATE_DEMOLISH_RANGE + 20;
  a.kid.y = 5.5 * CELL;
  g.drainEvents();
  g.command(1, { c: CMD.DEMOLISH, cx: 13, cy: 5 });
  assert.deepEqual(denied(g), ['tooFar']);

  a.kid.x = 13.5 * CELL;
  a.kid.y = 6.5 * CELL;
  g.command(1, { c: CMD.DEMOLISH, cx: 13, cy: 5 });
  assert.equal(g.structs.has(first.id), false);
  assert.equal(g.flakes[TEAM.A], flakes, 'no refund');

  g.drainEvents();
  g.command(1, { c: CMD.DEMOLISH, cx: 14, cy: 5 });
  assert.deepEqual(denied(g), ['limit']);
  assert.ok(g.structs.has(second.id));

  for (let i = 0; i < TEAMMATE_DEMOLISH_COOLDOWN * SIM_HZ; i++) {
    a.queue();
    b.queue();
    g.step();
  }
  g.drainEvents();
  g.command(1, { c: CMD.DEMOLISH, cx: 14, cy: 5 });
  assert.equal(g.structs.has(second.id), false);
});

test('demolish: an AFK or departed owner\'s struct is treated like your own', () => {
  const g = siege([human(1), human(2), human(3)]);
  g.actors.get(3).x = 500;
  g.actors.get(3).y = 300;
  const wall = buildOk(g, STRUCT.ICEWALL, 13, 5, 2);
  const other = buildOk(g, STRUCT.ICEWALL, 12, 5, 3);
  g.setAfk(2, true);
  const flakes = g.flakes[TEAM.A];
  g.command(1, { c: CMD.DEMOLISH, cx: 13, cy: 5 });
  assert.equal(g.structs.has(wall.id), false);
  assert.equal(g.flakes[TEAM.A], flakes + Math.floor(DEMOLISH_REFUND * BUILD[STRUCT.ICEWALL].cost));
  g.removePlayer(3);
  g.command(1, { c: CMD.DEMOLISH, cx: 12, cy: 5 });
  assert.equal(g.structs.has(other.id), false);
});

test('fair share: only with minHumans on the team; spending draws it down; over budget is limit', () => {
  const lonely = siege([human(1), human(2)]);
  assert.equal(lonely.actors.get(1).spendLeft, Infinity);
  assert.equal(lonely.privateState(1).spendLeft, 65535);

  const g = siege([human(1), human(2), human(3)]);
  const share = Math.max(FAIR_SHARE.minFlakes, Math.ceil((FAIR_SHARE.poolMul * SIEGE.startFlakes) / 3));
  const kid = g.actors.get(1);
  assert.equal(kid.spendLeft, share);
  g.flakes[TEAM.A] = 500;
  const pad = [];
  for (let i = 0; i < 8; i++) pad.push(i);
  const cost = BUILD[STRUCT.WALL].cost;
  let built = 0;
  for (const i of pad) {
    g.command(1, { c: CMD.BUILD, k: STRUCT.WALL, cx: 8 + i, cy: 5 });
    if (g.structAt(8 + i, 5)) built += 1;
  }
  assert.equal(built, 8);
  assert.equal(kid.spendLeft, share - 8 * cost);
  kid.spendLeft = 1;
  g.drainEvents();
  g.command(1, { c: CMD.BUILD, k: STRUCT.WALL, cx: 7, cy: 6 });
  assert.deepEqual(denied(g), ['limit']);
});

test('fair share: recomputed against the pool at each BUILD and FIGHT start', () => {
  const g = siege([human(1), human(2), human(3)]);
  g.flakes[TEAM.A] = 300;
  startFight(g);
  assert.equal(g.actors.get(1).spendLeft, Math.ceil((FAIR_SHARE.poolMul * 300) / 3));
  g.flakes[TEAM.A] = 3;
  beatWave(g);
  assert.equal(g.actors.get(1).spendLeft, Math.max(FAIR_SHARE.minFlakes, Math.ceil((FAIR_SHARE.poolMul * g.flakes[TEAM.A]) / 3)));
});

test('fair share: bots are not part of it', () => {
  const g = siege([human(1), human(2), human(3), bot(4)]);
  assert.equal(g.actors.get(4).spendLeft, Infinity);
});

test('bots beside a human only repair, within 25% of the pool per phase', () => {
  const g = siege([human(1), bot(2)]);
  const buddy = g.actors.get(2);
  buddy.x = 520;
  buddy.y = 260;
  g.flakes[TEAM.A] = 40;
  g.refreshBudgets();
  g.command(2, { c: CMD.BUILD, k: STRUCT.WALL, cx: 12, cy: 5 });
  assert.equal(g.structAt(12, 5), null, 'bots do not choose what gets built');
  const wall = buildOk(g, STRUCT.ICEWALL, 13, 5);
  const budget = 0.25 * 40;
  const repair = Math.ceil(REPAIR_COST_MUL * BUILD[STRUCT.ICEWALL].cost);
  let spent = 0;
  for (let i = 0; i < 10; i++) {
    wall.hp = 1;
    g.command(2, { c: CMD.BUILD, k: STRUCT.ICEWALL, cx: 13, cy: 5 });
    if (wall.hp === wall.maxHp) spent += repair;
  }
  assert.ok(spent > 0);
  assert.ok(spent <= budget + repair - 1, `spent ${spent} of ${budget}`);
});

test('bots with no human on the team build for themselves', () => {
  const g = faceOff([human(1), bot(2, { team: TEAM.B })]);
  const b = g.actors.get(2);
  g.command(2, { c: CMD.BUILD, k: STRUCT.WALL, cx: Math.floor(b.x / CELL) - 2, cy: Math.floor(b.y / CELL) });
  assert.ok(g.structAt(Math.floor(b.x / CELL) - 2, Math.floor(b.y / CELL)));
});

test('structures: a destroyed wall is removed with why destroyed and stops blocking', () => {
  const g = siege();
  const wall = buildOk(g, STRUCT.WALL, 13, 5);
  const foe = dummy(g, ACTOR.PIPSQUEAK, 100, 400);
  g.drainEvents();
  g.damageStruct(wall, 1000, foe);
  const del = g.drainEvents().find((e) => e.e === EV.S_DEL);
  assert.equal(del.why, 'destroyed');
  assert.equal(g.structAt(13, 5), null);
  assert.equal(g.cw.isSolidCell(13, 5), false);
});

test('structures: sHp coalesces to one per dirty struct, at drain, and skips dead structs', () => {
  const g = siege();
  const a = buildOk(g, STRUCT.ICEWALL, 13, 5);
  const b = buildOk(g, STRUCT.ICEWALL, 12, 5);
  const c = buildOk(g, STRUCT.WALL, 11, 5);
  const foe = dummy(g, ACTOR.PIPSQUEAK, 100, 400);
  g.drainEvents();
  g.damageStruct(a, 3, foe);
  g.damageStruct(a, 3, foe);
  g.damageStruct(a, 3, foe);
  g.damageStruct(b, 1.2345, foe);
  g.damageStruct(c, 1, foe);
  g.damageStruct(c, 1000, foe);
  const updates = g.drainEvents().filter((e) => e.e === EV.S_HP);
  assert.deepEqual(updates.map((e) => [e.id, e.hp]), [[a.id, a.hp], [b.id, 178.77]]);
  assert.ok(updates.every((e) => e.t === g.tick));
  assert.deepEqual(g.drainEvents(), [], 'the queue is empty after a drain');
});

test('structures: nothing hurts its own team\'s structs', () => {
  const g = siege();
  const wall = buildOk(g, STRUCT.WALL, 13, 5);
  g.damageStruct(wall, 10, g.actors.get(1));
  assert.equal(wall.hp, wall.maxHp);
});

test('structures: g.structAt knows all four Colonel cells', () => {
  const g = siege();
  const col = g.colonel(TEAM.A);
  assert.deepEqual([col.cx, col.cy], [14, 9]);
  for (const [cx, cy] of [[14, 9], [15, 9], [14, 10], [15, 10]]) assert.equal(g.structAt(cx, cy), col);
  assert.equal(g.structAt(13, 9), null);
  assert.equal(g.structAt(-1, -1), null);
  assert.equal(g.colonel(TEAM.B), null);
});

test('flinger: fires at the nearest foe in range, leading it, in FIGHT only', () => {
  const g = siege();
  const pult = buildOk(g, STRUCT.PULT, 13, 5);
  const foe = dummy(g, ACTOR.BRUISER, pult.x + 300, pult.y, 1000);
  foe.vx = 0;
  g.drainEvents();
  for (let i = 0; i < 10; i++) g.step();
  assert.equal(eventsOf(g, EV.PULT).length, 0, 'no firing during BUILD');
  g.beginFight();
  g.drainEvents();
  g.step();
  const events = g.drainEvents();
  const fired = events.find((e) => e.e === EV.PULT);
  assert.equal(fired.id, pult.id);
  near(fired.ang, Math.atan2(foe.y - pult.y, foe.x - pult.x), 0.01);
  const ball = events.find((e) => e.e === EV.BALL);
  assert.equal(ball.by, 1);
  assert.equal(ball.k, BALL.LOB);
  assert.deepEqual([ball.lx, ball.ly], [foe.x, foe.y]);
  for (let i = 0; i < 40; i++) g.step();
  assert.equal(foe.hp, 1000 - BUILD[STRUCT.PULT].dmg);
});

test('flinger: aims at where a moving target will be', () => {
  const g = siege();
  const pult = buildOk(g, STRUCT.PULT, 13, 5);
  g.beginFight();
  const foe = g.spawnFoe(ACTOR.PIPSQUEAK, pult.x + 300, pult.y);
  foe.flags &= ~AFLAG.GRACE;
  foe.graceT = 0;
  foe.stunT = 1e6;
  g.stepFoes = () => {};
  foe.vx = 60;
  g.drainEvents();
  g.step();
  const ball = g.drainEvents().find((e) => e.e === EV.BALL);
  const flight = THROW.lob.minFlight + 300 * THROW.lob.flightPerUnit;
  near(ball.lx, foe.x + 60 * flight, 0.02);
});

test('flinger: pultDmgMul is team-wide while its holder plays', () => {
  const g = siege([human(1), human(2)]);
  const pult = buildOk(g, STRUCT.PULT, 13, 5);
  g.actors.get(2).mods = { ...defaultMods(), pultDmgMul: 1.3 };
  const foe = dummy(g, ACTOR.BRUISER, pult.x + 200, pult.y, 1000);
  g.beginFight();
  for (let i = 0; i < 40; i++) g.step();
  near(foe.hp, 1000 - BUILD[STRUCT.PULT].dmg * 1.3);
  g.removePlayer(2);
  assert.equal(g.pultDamageMul(TEAM.A), 1);
});

test('flinger: respects its cooldown', () => {
  const g = siege();
  const pult = buildOk(g, STRUCT.PULT, 13, 5);
  dummy(g, ACTOR.BRUISER, pult.x + 200, pult.y, 100000);
  g.beginFight();
  g.drainEvents();
  let shots = 0;
  const seconds = 3 * BUILD[STRUCT.PULT].cooldown;
  for (let i = 0; i < seconds * SIM_HZ; i++) {
    g.step();
    shots += g.drainEvents().filter((e) => e.e === EV.PULT).length;
  }
  near(shots, 3, 1);
});

// ---- foe plumbing -------------------------------------------------------------

test('spawnFoe: fills the record from FOES, DIFF and player scaling', () => {
  const g = siege([human(1), human(2)], { difficulty: DIFFICULTY.BLIZZARD });
  const foe = g.spawnFoe(ACTOR.SLINGER, 100, 200, { hpMul: 2 });
  const spec = FOES[ACTOR.SLINGER];
  const diff = DIFF[DIFFICULTY.BLIZZARD];
  near(foe.hp, spec.hp * diff.hp * (1 + SIEGE.perExtraPlayerHp) * 2);
  assert.equal(foe.maxHp, foe.hp);
  near(foe.dmg, spec.dmg * diff.dmg);
  assert.deepEqual([foe.r, foe.speed, foe.cd, foe.team], [spec.r, spec.speed, spec.cd, TEAM.FOES]);
  assert.deepEqual(foe.ai, {});
  assert.equal(foe.takeDmgMul, 1);
  assert.ok(foe.flags & AFLAG.GRACE);
  const boss = g.spawnFoe(ACTOR.STEVE, 100, 200);
  near(boss.hp, FOES[ACTOR.STEVE].hp * diff.hp * (1 + SIEGE.perExtraPlayerBossHp));
});

test('spawnFoe: a point past the map edge is pulled back onto it', () => {
  const g = siege();
  const foe = g.spawnFoe(ACTOR.PIPSQUEAK, -40, 900);
  assert.deepEqual([foe.x, foe.y], [foe.r, g.map.h - foe.r]);
});

test('spawnFoe: emits spawn and returns null at MAX_ACTORS, except bosses', () => {
  const g = siege();
  g.drainEvents();
  const first = g.spawnFoe(ACTOR.PIPSQUEAK, 100, 200);
  const ev = g.drainEvents().find((e) => e.e === EV.SPAWN);
  assert.deepEqual([ev.id, ev.k, ev.x, ev.y], [first.id, ACTOR.PIPSQUEAK, 100, 200]);
  for (let i = 1; i < MAX_ACTORS; i++) assert.ok(g.spawnFoe(ACTOR.PIPSQUEAK, 100, 200));
  assert.equal(g.spawnFoe(ACTOR.PIPSQUEAK, 100, 200), null);
  assert.ok(g.spawnFoe(ACTOR.TRUCK, 100, 200));
  assert.equal(g.spawnFoe(999, 100, 200), null);
});

test('dispatch: GRACE foes do nothing for foeSpawnGrace, then wake', () => {
  const g = siege();
  const foe = g.spawnFoe(ACTOR.PIPSQUEAK, 100, 400);
  for (let i = 0; i < SIEGE.foeSpawnGrace * SIM_HZ - 1; i++) g.step();
  assert.deepEqual([foe.x, foe.y], [100, 400], 'held in place');
  assert.ok(foe.flags & AFLAG.GRACE);
  for (let i = 0; i < 3; i++) g.step();
  assert.equal(foe.flags & AFLAG.GRACE, 0);
});

test('dispatch: a stunned foe does nothing until it runs out, and the flag follows', () => {
  const g = siege();
  const foe = dummy(g, ACTOR.PIPSQUEAK, 100, 400);
  foe.stunT = 0.2;
  g.step();
  assert.ok(foe.flags & AFLAG.STUNNED);
  assert.equal(foe.x, 100);
  for (let i = 0; i < 10; i++) g.step();
  assert.equal(foe.flags & AFLAG.STUNNED, 0);
});

test('fleeing: a beaten foe leaves by the nearest open edge and despawns, harmless', () => {
  const g = siege();
  const foe = dummy(g, ACTOR.PIPSQUEAK, 300, 300);
  g.drainEvents();
  g.freezeOrFlee(foe, null);
  const flee = g.drainEvents().find((e) => e.e === EV.FLEE);
  assert.deepEqual([flee.id, flee.x, flee.y], [foe.id, 300, 300]);
  assert.ok(foe.flags & AFLAG.FLEEING);
  assert.equal(foe.hp, 0);
  for (let i = 0; i < 20 * SIM_HZ && g.actors.has(foe.id); i++) g.step();
  assert.equal(g.actors.has(foe.id), false);
});

test('fleeing: skirts houses rather than running into them', () => {
  const g = siege();
  const foe = dummy(g, ACTOR.PIPSQUEAK, 160, 240);
  g.freezeOrFlee(foe, null);
  for (let i = 0; i < 20 * SIM_HZ && g.actors.has(foe.id); i++) {
    g.step();
    assert.ok(foe.fleeT < 15, 'never needed the timeout');
  }
  assert.equal(g.actors.has(foe.id), false);
});

test('fleeing: foes do not target fleeing, and flakes are paid once', () => {
  const g = siege();
  const kid = g.actors.get(1);
  const foe = dummy(g, ACTOR.PIPSQUEAK, kid.x + 60, kid.y);
  const flakes = g.flakes[TEAM.A];
  g.freezeOrFlee(foe, kid);
  g.freezeOrFlee(foe, kid);
  near(g.flakes[TEAM.A], flakes + FOES[ACTOR.PIPSQUEAK].flakes);
  assert.equal(kid.stats.freezes, 1);
  assert.equal(g.nearestEnemy(kid, 200), null);
});

test('flakes: kills pay flakes / sqrt(countMul) as floats, flakeBonus unscaled, meta floors', () => {
  const g = siege([human(1), human(2)]);
  near(g.countMul, 1.55);
  const kid = g.actors.get(1);
  kid.mods = { ...defaultMods(), flakeBonus: 1 };
  const flakes = g.flakes[TEAM.A];
  const foe = dummy(g, ACTOR.SLINGER, 100, 400);
  g.drainEvents();
  g.damageActor(foe, 10000, kid, {});
  const expected = FOES[ACTOR.SLINGER].flakes / Math.sqrt(1.55) + 1;
  near(g.flakes[TEAM.A], flakes + expected);
  near(kid.stats.flakes, expected);
  const ev = g.drainEvents().find((e) => e.e === EV.FLAKES);
  near(ev.amt, expected, 0.005);
  assert.equal(ev.tm, TEAM.A);
  assert.equal(g.meta().flakes[TEAM.A], Math.floor(flakes + expected));
});

test('flakes: noFlakes foes pay nothing, though beating one still counts as a freeze', () => {
  const g = siege();
  const kid = g.actors.get(1);
  const foe = g.spawnFoe(ACTOR.PIPSQUEAK, 100, 400, { noFlakes: true });
  const flakes = g.flakes[TEAM.A];
  g.freezeOrFlee(foe, kid);
  assert.equal(g.flakes[TEAM.A], flakes);
  assert.equal(kid.stats.freezes, 1);
  assert.equal(kid.stats.flakes, 0);
});

test('moveActor: moves, updates velocity, is stopped by structs and reports them', () => {
  const g = siege();
  const foe = dummy(g, ACTOR.PIPSQUEAK, 300, 300);
  assert.equal(g.moveActor(foe, 4, 0), null);
  near(foe.x, 304);
  near(foe.vx, 4 / DT);
  const wall = buildOk(g, STRUCT.WALL, 13, 5);
  foe.x = 13 * CELL - foe.r - 1;
  foe.y = 5.5 * CELL;
  assert.equal(g.moveActor(foe, 4, 0), wall);
  near(foe.x, 13 * CELL - foe.r);
});

test('moveActor: scraping along a wall is not being blocked by it', () => {
  const g = siege();
  buildOk(g, STRUCT.WALL, 13, 5);
  const foe = dummy(g, ACTOR.PIPSQUEAK, 13.5 * CELL, 5 * CELL - 11);
  assert.equal(g.moveActor(foe, 3, 0.5), null);
  assert.ok(foe.x > 13.5 * CELL);
});

test('moveActor: SLOWED halves the stride and Slick applies it, on enemy actors only', () => {
  const g = siege();
  const foe = dummy(g, ACTOR.PIPSQUEAK, 300, 300);
  foe.slowT = 1;
  g.moveActor(foe, 10, 0);
  near(foe.x, 300 + 10 * KID.slowSpeedMul);

  const slick = buildOk(g, STRUCT.SLICK, 13, 5);
  const walker = dummy(g, ACTOR.PIPSQUEAK, slick.x, slick.y);
  g.moveActor(walker, 10, 0);
  near(walker.slowT, BUILD[STRUCT.SLICK].slow);
  assert.ok(walker.flags & AFLAG.SLOWED);
  assert.ok(walker.x < slick.x + 10, 'skids instead of striding');
});

test('moveActor: a slowed foe recovers as slowT runs down', () => {
  const g = siege();
  const foe = dummy(g, ACTOR.PIPSQUEAK, 300, 300);
  foe.slowT = 0.1;
  g.step();
  assert.ok(foe.flags & AFLAG.SLOWED);
  for (let i = 0; i < 5; i++) g.step();
  assert.equal(foe.slowT, 0);
  assert.equal(foe.flags & AFLAG.SLOWED, 0);
});

test('moveActor: vault ignores structs at 0.6x but obstacles still stop it', () => {
  const g = siege();
  buildOk(g, STRUCT.WALL, 13, 5);
  const foe = dummy(g, ACTOR.SNEAK, 13 * CELL - 13, 5.5 * CELL);
  assert.equal(g.moveActor(foe, 8, 0, { vault: true }), null);
  near(foe.x, 13 * CELL - 13 + 8, 1e-9, 'full stride up to the cell, walking into the body of the wall');
  foe.x = 13 * CELL - 5;
  g.moveActor(foe, 10, 0, { vault: true });
  near(foe.x, 13 * CELL - 5 + 6, 1e-9, 'stepping onto the cell');
  foe.x = 13.5 * CELL;
  g.moveActor(foe, 10, 0, { vault: true });
  near(foe.x, 13.5 * CELL + 6, 1e-9, 'still slowed while over the cell');

  const hopper = dummy(g, ACTOR.SNEAK, 120 - 13, 160);
  g.moveActor(hopper, 10, 0, { vault: true });
  near(hopper.x, 120 - 12, 1e-6, 'houses are not walls');
});

test('nearestEnemy: skips FLEEING, FROZEN and GRACE; enemiesInRadius skips only FLEEING and GRACE', () => {
  const g = siege([human(1), human(2), human(3)]);
  const [a, b, c] = [g.actors.get(1), g.actors.get(2), g.actors.get(3)];
  const foe = dummy(g, ACTOR.PIPSQUEAK, 300, 300);
  a.x = 310;
  a.y = 300;
  b.x = 320;
  b.y = 300;
  c.x = 330;
  c.y = 300;
  assert.equal(g.nearestEnemy(foe, 100), a);
  g.freezeOrFlee(a, null);
  assert.equal(g.nearestEnemy(foe, 100), b);
  b.flags |= AFLAG.GRACE;
  assert.equal(g.nearestEnemy(foe, 100), c);
  assert.equal(g.nearestEnemy(foe, 10), null);
  assert.deepEqual(g.enemiesInRadius(TEAM.FOES, 300, 300, 100), [a, c]);
  assert.deepEqual(g.enemiesInRadius(TEAM.A, 300, 300, 5), [foe]);
  assert.equal(g.nearestEnemy(a, 100), foe, 'works from either side');
});

test('los: walls and scenery block it, chain-link does not, a wall is its own target', () => {
  const g = siege();
  assert.equal(g.los(300, 300, 500, 300), true);
  assert.equal(g.los(60, 160, 300, 160), false);
  assert.equal(g.los(960, 560, 960, 660), true);
  const wall = buildOk(g, STRUCT.WALL, 13, 5);
  assert.equal(g.los(300, 220, 700, 220), false);
  assert.equal(g.los(300, 220, wall.x, wall.y), true);
});

test('g.flow: foes head for the Siege Colonel, teams for each other, FFA for nobody', () => {
  const g = siege();
  assert.ok(g.flow(TEAM.FOES) instanceof FlowField);
  assert.equal(g.flow(TEAM.FOES), g.flow(TEAM.FOES));
  assert.equal(g.flow(TEAM.A), null);
  const { dx } = g.flow(TEAM.FOES).dirAt(100, 400);
  assert.ok(dx > 0);

  const f = faceOff();
  assert.ok(f.flow(TEAM.A).dirAt(400, 400).dx > 0);
  assert.ok(f.flow(TEAM.B).dirAt(800, 400).dx < 0);
  assert.equal(f.flow(TEAM.FOES), null);
  assert.equal(ffa().flow(TEAM.FFA_BASE), null);
});

test('g.flow: building changes the route within half a second', () => {
  const g = siege();
  const field = g.flow(TEAM.FOES);
  const built = field.rebuilds;
  buildOk(g, STRUCT.WALL, 13, 5);
  for (let i = 0; i < 16; i++) {
    g.step();
    field.dirAt(100, 400);
  }
  assert.equal(field.rebuilds, built + 1);
});

test('g.bark, g.banner, g.sfx and g.awardFlakes emit what the spec says', () => {
  const g = siege();
  const col = g.colonel(TEAM.A);
  g.drainEvents();
  g.bark(col, 'Harrumph.');
  g.banner('Hello', 'There', 'info');
  g.sfx(SFX.CHEER, 10, 20);
  g.awardFlakes(TEAM.A, 1.5, 30, 40);
  const events = g.drainEvents();
  assert.deepEqual(events.map((e) => e.e), [EV.BARK, EV.BANNER, EV.SFX, EV.FLAKES]);
  assert.deepEqual([events[0].id, events[0].text], [col.id, 'Harrumph.']);
  assert.deepEqual([events[1].text, events[1].sub, events[1].kind], ['Hello', 'There', 'info']);
  assert.deepEqual([events[2].name, events[2].x, events[2].y], [SFX.CHEER, 10, 20]);
  assert.deepEqual([events[3].amt, events[3].x, events[3].y, events[3].tm], [1.5, 30, 40, TEAM.A]);
  assert.equal(g.flakes[TEAM.A], SIEGE.startFlakes + 1.5);
});

test('g.sfx accepts only the names in SFX', () => {
  const g = siege();
  g.drainEvents();
  g.sfx('kazoo', 1, 2);
  assert.deepEqual(g.drainEvents(), []);
});

test('the Colonel harrumphs when hit, but not in a nonstop stream', () => {
  const g = siege();
  const col = g.colonel(TEAM.A);
  const foe = dummy(g, ACTOR.PIPSQUEAK, 100, 400);
  g.drainEvents();
  for (let i = 0; i < 20; i++) g.damageStruct(col, 1, foe);
  assert.equal(g.drainEvents().filter((e) => e.e === EV.SFX && e.name === SFX.HARRUMPH).length, 1);
});

test('a boss falling sends its escorts running and pays no Flakes for them', () => {
  const g = siege();
  const boss = dummy(g, ACTOR.TRUCK, 300, 300);
  const escort = dummy(g, ACTOR.PIPSQUEAK, 400, 300);
  const flakes = g.flakes[TEAM.A];
  g.freezeOrFlee(boss, g.actors.get(1));
  assert.ok(boss.flags & AFLAG.FLEEING);
  assert.ok(escort.flags & AFLAG.FLEEING);
  near(g.flakes[TEAM.A], flakes + FOES[ACTOR.TRUCK].flakes);
});

test('a Carrot Thief frozen mid-getaway hands the nose back', () => {
  const g = siege();
  const thief = dummy(g, ACTOR.SNEAK, 300, 300);
  thief.aux |= AUX.NOSE;
  assert.equal(g.meta().colonels[0].nose, false);
  g.freezeOrFlee(thief, g.actors.get(1));
  assert.equal(thief.aux & AUX.NOSE, 0);
  assert.equal(g.meta().colonels[0].nose, true);
});

test('boulders: roll through structs hurting each once, x boulderStructMul; scenery stops them', () => {
  const g = siege();
  const steve = dummy(g, ACTOR.STEVE, 300, 300);
  const kid = g.actors.get(1);
  kid.x = 340;
  kid.y = 300;
  const first = buildOk(g, STRUCT.ICEWALL, 10, 7);
  const second = buildOk(g, STRUCT.ICEWALL, 12, 7);
  const { boulderSpeed, boulderR0, boulderR1, boulderLife, boulderStructMul } = BOSS.steve;
  g.throwFlat(steve, 0, {
    speed: boulderSpeed, flight: boulderLife, dmg: 10, kind: BALL.BOULDER, r: boulderR0,
    grow: (boulderR1 - boulderR0) / boulderLife, rMax: boulderR1, life: boulderLife,
  });
  for (let i = 0; i < 60; i++) g.step();
  assert.equal(first.hp, first.maxHp - 10 * boulderStructMul);
  assert.equal(second.hp, second.maxHp - 10 * boulderStructMul);
  assert.equal(kid.hp, kid.maxHp - 10);
});

// ---- cards --------------------------------------------------------------------

test('cards: offered privately at each Siege BUILD but the first; bots pick for themselves', () => {
  const g = siege([human(1), bot(2)]);
  assert.equal(g.actors.get(1).offer, null);
  assert.equal(g.fullState(1).offer, null);
  startFight(g);
  const events = [];
  spin(() => { g.step(); events.push(...g.drainEvents()); clearFoes(g); }, () => g.wave === 2);
  const offers = events.filter((e) => e.e === EV.PICK_OFFER);
  assert.equal(offers.length, 1);
  assert.equal(offers[0].to, 1);
  assert.equal(offers[0].cards.length, 3);
  assert.equal(new Set(offers[0].cards).size, 3);
  assert.deepEqual(g.fullState(1).offer, offers[0].cards);
  assert.equal(g.actors.get(2).cards.length, 1);
  assert.equal(g.actors.get(2).offer, null);
  assert.ok(events.some((e) => e.e === EV.CARD && e.id === 2));
});

test('cards: CMD.CARD takes the offer, derives mods, maxBalls and maxHp', () => {
  const g = siege();
  const kid = g.actors.get(1);
  kid.offer = ['earmuffs', 'mittens', 'boots'];
  g.drainEvents();
  g.command(1, { c: CMD.CARD, i: 1 });
  assert.deepEqual(kid.cards, ['mittens']);
  assert.equal(kid.maxBalls, KID.maxBalls + 3);
  assert.deepEqual(kid.mods, modsFromCards(['mittens']));
  assert.equal(kid.offer, null);
  const ev = g.drainEvents().find((e) => e.e === EV.CARD);
  assert.deepEqual([ev.id, ev.card], [1, 'mittens']);
  kid.offer = ['earmuffs', 'mittens', 'boots'];
  g.command(1, { c: CMD.CARD, i: 0 });
  assert.equal(kid.maxHp, KID.maxWarmth + 25);
  assert.equal(kid.hp, kid.maxHp);
  assert.deepEqual(g.meta().cards[1], ['mittens', 'earmuffs']);
});

test('cards: a bad index or no offer is ignored', () => {
  const g = siege();
  const kid = g.actors.get(1);
  g.command(1, { c: CMD.CARD, i: 0 });
  kid.offer = ['earmuffs', 'mittens', 'boots'];
  g.command(1, { c: CMD.CARD, i: 7 });
  g.command(1, { c: CMD.CARD, i: -1 });
  assert.deepEqual(kid.cards, []);
  assert.ok(kid.offer);
});

test('cards: unchosen offers auto-pick when the phase ends', () => {
  const g = siege();
  const kid = g.actors.get(1);
  kid.offer = ['earmuffs', 'mittens', 'boots'];
  g.drainEvents();
  startFight(g);
  assert.equal(kid.cards.length, 1);
  assert.ok(['earmuffs', 'mittens', 'boots'].includes(kid.cards[0]));
  assert.equal(kid.offer, null);
});

test('cards: every id in the deck can be taken and every mod key survives', () => {
  const g = siege();
  const kid = g.actors.get(1);
  for (const card of CARDS) {
    kid.offer = [card.id];
    g.command(1, { c: CMD.CARD, i: 0 });
  }
  assert.deepEqual(kid.mods, modsFromCards(kid.cards));
  assert.equal(kid.cards.length, CARDS.length);
  assert.ok(kid.mods.speedMul > 1 && kid.mods.maxBalls > 0 && kid.mods.flakeBonus > 0);
});

// ---- Siege flow ---------------------------------------------------------------

test('siege: opens in BUILD on wave 1 with the Colonel up and startFlakes', () => {
  const g = siege();
  assert.equal(g.phase, PHASE.BUILD);
  assert.equal(g.wave, 1);
  assert.equal(g.flakes[TEAM.A], SIEGE.startFlakes);
  assert.equal(g.endsAtTick, SIEGE.firstBuildTime * SIM_HZ);
  const col = g.colonel(TEAM.A);
  assert.equal(col.hp, BUILD[STRUCT.COLONEL].hp);
  assert.equal(g.actors.get(1).x, testMap().spawns.siege[0].x);
});

test('siege: colonel hp and countMul follow weighted players, bots at half, AFK at none', () => {
  const g = siege([human(1), human(2), bot(3), bot(4)]);
  near(g.weightedPlayers(), 3);
  const col = g.colonel(TEAM.A);
  near(col.maxHp, BUILD[STRUCT.COLONEL].hp * (1 + SIEGE.colonelHpPerExtraPlayer * 2));
  near(g.countMul, 1 + SIEGE.perExtraPlayerCount * 2);

  const lone = siege([human(1)]);
  lone.setAfk(1, true);
  near(lone.weightedPlayers(), 1, 1e-9, 'never below 1');
});

test('siege: weight is recomputed at BUILD start, keeping the Colonel\'s hp fraction', () => {
  const g = siege([human(1), human(2)]);
  const col = g.colonel(TEAM.A);
  col.hp = col.maxHp * 0.5;
  const bigMax = col.maxHp;
  startFight(g);
  g.setAfk(2, true);
  near(col.maxHp, bigMax, 1e-9, 'not mid-wave');
  beatWave(g);
  assert.ok(col.maxHp < bigMax);
  near(col.maxHp, BUILD[STRUCT.COLONEL].hp);
  near(col.hp / col.maxHp, 0.5 + SIEGE.colonelRegenBetweenWaves, 1e-9);
});

test('siege: a Colonel whose cap changed tells clients through an sAdd upsert', () => {
  const g = siege([human(1), human(2)]);
  const col = g.colonel(TEAM.A);
  g.setAfk(2, true);
  startFight(g);
  const events = [];
  spin(() => { g.step(); events.push(...g.drainEvents()); clearFoes(g); }, () => g.wave === 2);
  const upsert = events.filter((e) => e.e === EV.S_ADD && e.id === col.id);
  assert.equal(upsert.length, 1);
  near(upsert[0].mhp, col.maxHp, 0.01);
});

test('siege: FIGHT starts on time and refills every kid to maxBalls', () => {
  const g = siege([human(1), bot(2)]);
  const kid = g.actors.get(1);
  kid.balls = 2;
  kid.mods = { ...defaultMods(), maxBalls: 3 };
  kid.maxBalls = KID.maxBalls + 3;
  stepUntil(g, () => g.phase === PHASE.FIGHT);
  assert.equal(g.tick, SIEGE.firstBuildTime * SIM_HZ);
  assert.equal(kid.balls, kid.maxBalls);
  assert.equal(g.meta().endsAtTick, null);
  assert.equal(g.meta().next, null);
});

test('siege: a cleared wave pays, heals 15%, thaws everyone, and starts the next BUILD', () => {
  const g = siege([human(1), human(2)]);
  const col = g.colonel(TEAM.A);
  const [a, b] = [g.actors.get(1), g.actors.get(2)];
  startFight(g);
  col.hp = col.maxHp / 2;
  g.freezeOrFlee(a, null);
  g.freezeOrFlee(b, null);
  const flakes = g.flakes[TEAM.A];
  stepUntil(g, () => g.foes().length > 0 || g.wave === 2);
  const events = [];
  spin(() => { g.step(); events.push(...g.drainEvents()); clearFoes(g); }, () => g.wave === 2);
  near(g.flakes[TEAM.A], flakes + SIEGE.waveBonusBase + SIEGE.waveBonusPerWave + (g.flakes[TEAM.A] - flakes - SIEGE.waveBonusBase - SIEGE.waveBonusPerWave));
  const bonus = events.filter((e) => e.e === EV.FLAKES).at(-1);
  assert.equal(bonus.amt, SIEGE.waveBonusBase + SIEGE.waveBonusPerWave * 1);
  near(col.hp, col.maxHp * 0.65);
  assert.equal(a.flags & AFLAG.FROZEN, 0);
  assert.equal(b.flags & AFLAG.FROZEN, 0);
  assert.equal(g.phase, PHASE.BUILD);
  assert.equal(g.endsAtTick, g.tick + SIEGE.buildTime * SIM_HZ);
  assert.ok(g.meta().next.foes.length > 0);
});

test('siege: foes still spawning or standing keep the wave open', () => {
  const g = siege();
  startFight(g);
  const foe = dummy(g, ACTOR.PIPSQUEAK, 300, 300);
  g.runner.done = true;
  g.runner.remaining = 0;
  g.runner.update = () => {};
  for (let i = 0; i < 30; i++) g.step();
  assert.equal(g.phase, PHASE.FIGHT);
  assert.equal(g.meta().foesLeft, 1);
  g.freezeOrFlee(foe, null);
  g.step();
  assert.equal(g.phase, PHASE.BUILD, 'a fleeing foe is no longer a reason to wait');
});

test('siege: foesLeft counts unspawned and live foes, not fleeing ones', () => {
  const g = siege();
  startFight(g);
  const left = g.meta().foesLeft;
  assert.equal(left, g.runner.remaining);
  const foe = dummy(g, ACTOR.PIPSQUEAK, 300, 300);
  assert.equal(g.meta().foesLeft, left + 1);
  g.freezeOrFlee(foe, null);
  assert.equal(g.meta().foesLeft, left);
});

test('siege: clearing the last wave wins, and the Colonel falling loses', () => {
  const won = siege([human(1), bot(2)], { waveCount: 5 });
  for (let i = 0; i < 5 && !won.isOver(); i++) {
    startFight(won);
    beatWave(won);
  }
  assert.equal(won.isOver(), true);
  assert.equal(won.wave, 5);
  const result = won.result();
  assert.deepEqual([result.mode, result.won, result.winnerTeam], [MODE.SIEGE, true, TEAM.A]);
  assert.deepEqual(result.winners.sort(), [1, 2]);
  assert.equal(won.meta().phase, PHASE.OVER);
  assert.equal(won.endsAtTick, null);
  assert.equal(result.players.length, 2);

  const lost = siege();
  startFight(lost);
  lost.colonel(TEAM.A).hp = 0;
  lost.step();
  assert.equal(lost.isOver(), true);
  assert.deepEqual([lost.result().won, lost.result().winnerTeam, lost.result().winners], [false, null, []]);
  assert.ok(lost.actors.get(1).flags & AFLAG.LOCKED);
});

test('siege: Endless keeps going past any finale, and dayT cycles', () => {
  const g = siege([human(1)], { waveCount: 0 });
  for (let wave = 1; wave <= 12; wave++) {
    assert.equal(g.wave, wave);
    startFight(g);
    beatWave(g);
  }
  assert.equal(g.isOver(), false);
  assert.ok(g.dayPos > 1, 'past one full day');
  const { dayT } = g.meta();
  assert.ok(dayT >= 0 && dayT <= 1);
});

test('siege: Ready needs every present human, ends BUILD now, and pays for the time saved', () => {
  const g = siege([human(1), human(2), bot(3)]);
  for (let i = 0; i < 60; i++) g.step();
  const flakes = g.flakes[TEAM.A];
  const left = (g.endsAtTick - g.tick) / SIM_HZ;
  g.command(1, { c: CMD.READY });
  assert.deepEqual(g.meta().ready, { have: 1, need: 2, ids: [1] });
  g.command(1, { c: CMD.READY });
  assert.deepEqual(g.meta().ready, { have: 0, need: 2, ids: [] }, 'it toggles');
  g.command(1, { c: CMD.READY });
  assert.equal(g.phase, PHASE.BUILD);
  g.command(2, { c: CMD.READY });
  assert.equal(g.phase, PHASE.FIGHT);
  assert.equal(g.flakes[TEAM.A], flakes + Math.floor(left * SIEGE.readyBonusPerSec));
  assert.deepEqual(g.meta().ready, { have: 0, need: 0, ids: [] });
});

test('siege: AFK humans do not hold Ready back, and bots are never asked', () => {
  const g = siege([human(1), human(2)]);
  g.setAfk(2, true);
  assert.equal(g.meta().ready.need, 1);
  g.command(1, { c: CMD.READY });
  assert.equal(g.phase, PHASE.FIGHT);

  const stale = siege([human(1), human(2)]);
  stale.command(1, { c: CMD.READY });
  stale.setAfk(2, true);
  stale.step();
  assert.equal(stale.phase, PHASE.FIGHT, 'the last holdout going away also completes it');
});

test('siege: bots cannot ready up, and an all-bot team just waits', () => {
  const g = siege([bot(1), bot(2)]);
  g.command(1, { c: CMD.READY });
  assert.equal(g.meta().ready.need, 0);
  g.step();
  assert.equal(g.phase, PHASE.BUILD);
});

test('siege: Ready is ignored outside BUILD', () => {
  const g = siege();
  startFight(g);
  g.command(1, { c: CMD.READY });
  assert.equal(g.meta().ready.have, 0);
});

test('siege: stragglers get a Lunchtime banner after waveOvertime, no Flakes, wave cleared', () => {
  const g = siege();
  startFight(g);
  const foe = dummy(g, ACTOR.PIPSQUEAK, 300, 300);
  g.runner.done = true;
  g.runner.remaining = 0;
  g.runner.update = () => {};
  const flakes = g.flakes[TEAM.A];
  const lastTick = g.tick + SIEGE.waveOvertime * SIM_HZ + 3;
  const events = [];
  while (g.wave === 1 && g.tick < lastTick) {
    g.step();
    events.push(...g.drainEvents());
  }
  assert.equal(g.wave, 2);
  assert.ok(events.some((e) => e.e === EV.BANNER && e.text === 'Lunchtime!'));
  assert.ok(foe.flags & AFLAG.FLEEING);
  assert.equal(g.flakes[TEAM.A], flakes + SIEGE.waveBonusBase + SIEGE.waveBonusPerWave, 'only the wave bonus');
});

test('siege: a boss wave has no Lunchtime, and a leaving boss holds the wave for its exit', () => {
  const g = siege([human(1)], { waveCount: 10 });
  g.wave = 10;
  g.openSiegeBuild(false);
  startFight(g);
  stepUntil(g, () => g.foes().some((f) => FOES[f.kind].boss));
  const boss = g.foes().find((f) => FOES[f.kind].boss);
  boss.stunT = 1e6;
  g.doneTick = g.tick - SIEGE.waveOvertime * SIM_HZ - 1;
  g.step();
  assert.equal(boss.flags & AFLAG.FLEEING, 0);
  assert.equal(g.phase, PHASE.FIGHT);
  assert.deepEqual([g.meta().boss.kind, g.meta().boss.hp], [boss.kind, Math.round(boss.hp)]);

  boss.stunT = 0;
  g.freezeOrFlee(boss, null);
  assert.equal(g.meta().boss, null);
  g.step();
  assert.equal(g.isOver(), false, 'the wave waits for the exit');
  stepUntil(g, () => !g.actors.has(boss.id), 31 * SIM_HZ);
  stepUntil(g, () => g.isOver(), 5);
  assert.equal(g.result().won, true);
});

test('siege: blizzard clears with the wave', () => {
  const g = siege();
  startFight(g);
  g.blizzard = true;
  assert.equal(g.meta().blizzard, true);
  beatWave(g);
  assert.equal(g.blizzard, false);
});

test('siege: foes only drop pickups on a real defeat, at PICKUP_DROP_CHANCE', () => {
  const g = siege();
  const kid = g.actors.get(1);
  let drops = 0;
  const rounds = 3000;
  for (let i = 0; i < rounds; i++) {
    const foe = g.spawnFoe(ACTOR.PIPSQUEAK, 300, 300);
    g.freezeOrFlee(foe, kid);
    g.despawn(foe);
    if (g.pickups.size > 0) {
      drops += 1;
      g.pickups.clear();
    }
  }
  near(drops / rounds, 0.08, 0.02);
  const free = g.spawnFoe(ACTOR.PIPSQUEAK, 300, 300, { noFlakes: true });
  for (let i = 0; i < 200; i++) {
    free.flags = 0;
    g.freezeOrFlee(free, kid);
  }
  assert.equal(g.pickups.size, 0);
});

test('dayT: runs 0 to 1 across a Siege run, never backwards', () => {
  const g = siege([human(1)], { waveCount: 5 });
  assert.equal(g.meta().dayT, 0);
  let last = 0;
  let moved = false;
  const watch = () => {
    const { dayT } = g.meta();
    assert.ok(dayT >= last - 1e-9, `dayT went back from ${last} to ${dayT}`);
    if (dayT > last) moved = true;
    last = dayT;
  };
  for (let i = 0; i < 5 && !g.isOver(); i++) {
    const wave = g.wave;
    spin(() => { g.step(); watch(); clearFoes(g); }, () => g.isOver() || g.wave !== wave);
  }
  assert.ok(moved);
  assert.ok(last > 0.6, `reached ${last}`);
  assert.ok(last <= 1);
});

// ---- Fort Face-Off flow -------------------------------------------------------

const team = (ids, t, make = human) => ids.map((id) => make(id, { team: t }));

test('face-off: Colonels at map.forts, sized by the largest team', () => {
  const g = faceOff([...team([1, 2, 3], TEAM.A), ...team([4], TEAM.B)]);
  const a = g.colonel(TEAM.A);
  const b = g.colonel(TEAM.B);
  assert.deepEqual([a.cx, a.cy], [5, 9]);
  assert.deepEqual([b.cx, b.cy], [23, 9]);
  const hp = FORTWARS.colonelHp + FORTWARS.colonelHpPerExtraKid * 2;
  assert.equal(a.maxHp, hp);
  assert.equal(b.maxHp, hp);
  assert.equal(g.flakes[TEAM.A], FORTWARS.startFlakes);
  assert.equal(g.flakes[TEAM.B], FORTWARS.startFlakes);
  assert.equal(g.round, 1);
  assert.deepEqual(g.meta().colonels.map((c) => c.team), [TEAM.A, TEAM.B]);
});

test('face-off: BUILD has the rope up, kids can\'t cross, throws are ignored, packing works', () => {
  const g = faceOff();
  const pad = new Pad(g, 1);
  const { kid } = pad;
  assert.equal(g.phase, PHASE.BUILD);
  assert.equal(g.endsAtTick, FORTWARS.buildTime * SIM_HZ);
  assert.equal(g.meta().truce, true);
  assert.deepEqual(g.cw.truce, { ...g.map.truce, active: true });

  kid.x = 560;
  pad.tick({ mx: 1 }, 40);
  assert.ok(kid.x <= 600 - KID.radius);

  const balls = kid.balls;
  pad.tick({ btn: BTN.THROW }, 5);
  assert.equal(kid.flags & AFLAG.CHARGING, 0);
  pad.tick({ btn: 0 });
  pad.tick({ btn: BTN.LOB }, 5);
  assert.equal(kid.flags & AFLAG.LOBAIM, 0);
  pad.tick({ btn: 0 });
  assert.equal(g.balls.size, 0);
  assert.equal(kid.balls, balls);

  kid.balls = 3;
  pad.tick({}, packTicks() + 2);
  assert.ok(kid.balls > 3, 'packing still works');
});

test('face-off: building is own-half only in both phases', () => {
  const g = faceOff();
  const pad = new Pad(g, 1);
  pad.kid.x = 570;
  pad.kid.y = 300;
  g.drainEvents();
  g.command(1, { c: CMD.BUILD, k: STRUCT.WALL, cx: 15, cy: 7 });
  assert.deepEqual(denied(g), ['badCell']);
  buildOk(g, STRUCT.WALL, 14, 8);
  stepUntil(g, () => g.phase === PHASE.FIGHT);
  assert.equal(g.meta().truce, false);
  assert.equal(g.cw.truce, null);
  pad.kid.x = 570;
  pad.kid.y = 300;
  g.drainEvents();
  g.command(1, { c: CMD.BUILD, k: STRUCT.WALL, cx: 15, cy: 7 });
  assert.deepEqual(denied(g), ['badCell']);
  buildOk(g, STRUCT.WALL, 12, 7);
});

test('face-off: FIGHT lets throws through, runs up to roundTime, and refills', () => {
  const g = faceOff();
  const pad = new Pad(g, 1);
  pad.kid.balls = 1;
  stepUntil(g, () => g.phase === PHASE.FIGHT);
  assert.equal(g.endsAtTick, g.tick + FORTWARS.roundTime * SIM_HZ);
  assert.equal(pad.kid.balls, pad.kid.maxBalls);
  pad.tick({ btn: BTN.THROW });
  pad.tick({ btn: 0 });
  assert.equal(g.balls.size, 1);
});

test('face-off: a Colonel at 0 ends the round; next round resets everything', () => {
  const g = faceOff([...team([1], TEAM.A), ...team([2], TEAM.B)]);
  const a = new Pad(g, 1);
  a.kid.x = 300;
  a.kid.y = 200;
  const wall = buildOk(g, STRUCT.WALL, 8, 5);
  stepUntil(g, () => g.phase === PHASE.FIGHT);
  a.kid.stats.hits = 5;
  a.kid.balls = 2;
  a.kid.special = PICKUP.ICE;
  a.kid.specialN = 3;
  g.flakes[TEAM.A] = 999;
  g.damageActor(a.kid, 30, null);
  const firstColonel = g.colonel(TEAM.B);
  g.damageStruct(firstColonel, 1e6, a.kid);
  g.drainEvents();
  g.step();
  assert.equal(g.phase, PHASE.ROUND_END);
  assert.equal(g.round, 1);
  assert.deepEqual(g.meta().roundWins, { [TEAM.A]: 1, [TEAM.B]: 0 });
  assert.ok(a.kid.flags & AFLAG.LOCKED);
  assert.equal(g.endsAtTick, g.tick + FORTWARS.roundEndTime * SIM_HZ);

  const events = [];
  spin(() => { g.step(); events.push(...g.drainEvents()); }, () => g.round === 2);
  assert.equal(g.phase, PHASE.BUILD);
  assert.equal(g.structs.has(wall.id), false);
  assert.ok(events.some((e) => e.e === EV.S_DEL && e.id === wall.id && e.why === 'reset'));
  assert.notEqual(g.colonel(TEAM.B), firstColonel);
  assert.equal(g.colonel(TEAM.B).hp, g.colonel(TEAM.B).maxHp);
  assert.equal(g.flakes[TEAM.A], FORTWARS.startFlakes);
  assert.deepEqual([a.kid.hp, a.kid.balls, a.kid.special, a.kid.flags & AFLAG.LOCKED], [a.kid.maxHp, KID.startBalls, null, 0]);
  assert.deepEqual([a.kid.x, a.kid.y], [g.map.spawns.fortwars[0][0].x, g.map.spawns.fortwars[0][0].y]);
  assert.ok(events.some((e) => e.e === EV.RESPAWN && e.id === 1));
  assert.equal(a.kid.stats.hits, 5, 'stats span the match');
  assert.equal(g.meta().truce, true);
});

test('face-off: first to roundsToWin takes the match', () => {
  const g = faceOff([...team([1, 2], TEAM.A), ...team([3], TEAM.B)]);
  for (let round = 1; round <= FORTWARS.roundsToWin; round++) {
    stepUntil(g, () => g.phase === PHASE.FIGHT);
    g.damageStruct(g.colonel(TEAM.B), 1e6, g.actors.get(1));
    g.step();
    if (round < FORTWARS.roundsToWin) stepUntil(g, () => g.round === round + 1);
  }
  assert.equal(g.isOver(), true);
  const result = g.result();
  assert.equal(result.winnerTeam, TEAM.A);
  assert.deepEqual(result.winners.sort(), [1, 2]);
  assert.equal(result.won, true);
  assert.ok(g.actors.get(3).flags & AFLAG.LOCKED);
});

test('face-off: sudden death drains from suddenDeathAt at the scaled rate', () => {
  const g = faceOff([...team([1, 2], TEAM.A), ...team([3, 4], TEAM.B)]);
  stepUntil(g, () => g.phase === PHASE.FIGHT);
  const fightStart = g.tick;
  const col = g.colonel(TEAM.A);
  const mhp = col.maxHp;
  stepUntil(g, () => g.tick === fightStart + FORTWARS.suddenDeathAt * SIM_HZ - 1);
  assert.equal(col.hp, mhp);
  assert.equal(g.meta().suddenDeath, false);
  g.step();
  assert.equal(g.meta().suddenDeath, true);
  for (let i = 0; i < SIM_HZ - 1; i++) g.step();
  near(mhp - col.hp, (FORTWARS.suddenDeathPerSec * mhp) / FORTWARS.colonelHp, 0.01);
});

test('face-off: untouched Colonels both fall before the timer; a round never replays', () => {
  const g = faceOff([...team([1, 2], TEAM.A), ...team([3], TEAM.B)]);
  stepUntil(g, () => g.phase === PHASE.FIGHT);
  const fightStart = g.tick;
  const timer = fightStart + FORTWARS.roundTime * SIM_HZ;
  stepUntil(g, () => g.phase !== PHASE.FIGHT);
  assert.equal(g.phase, PHASE.ROUND_END);
  assert.ok(g.tick < timer, `ended at ${g.tick - fightStart} of ${timer - fightStart}`);
  const expected = FORTWARS.suddenDeathAt + FORTWARS.colonelHp / FORTWARS.suddenDeathPerSec;
  near((g.tick - fightStart) / SIM_HZ, expected, 0.2);
  assert.equal(g.meta().roundWins[TEAM.A] + g.meta().roundWins[TEAM.B], 1);
  assert.equal(g.colonel(TEAM.A).hp, 0);
  assert.equal(g.colonel(TEAM.B).hp, 0);
  stepUntil(g, () => g.round === 2);
});

test('face-off: a whole match of idle kids still ends, by sudden death alone', () => {
  const g = faceOff();
  stepUntil(g, () => g.isOver(), 1000 * SIM_HZ);
  assert.equal(g.result().won, true);
  assert.ok([TEAM.A, TEAM.B].includes(g.result().winnerTeam));
  assert.equal(g.meta().roundWins[g.result().winnerTeam], FORTWARS.roundsToWin);
});

test('face-off: both down on one tick goes to Colonel damage, then freezes, then rng', () => {
  const both = (setup) => {
    const g = faceOff();
    stepUntil(g, () => g.phase === PHASE.FIGHT);
    setup(g);
    g.colonel(TEAM.A).hp = 0;
    g.colonel(TEAM.B).hp = 0;
    g.step();
    return g.meta().roundWins;
  };
  assert.equal(both((g) => g.damageStruct(g.colonel(TEAM.A), 5, g.actors.get(2)))[TEAM.B], 1, 'more Colonel damage');
  assert.equal(both((g) => g.damageActor(g.actors.get(2), 1e6, g.actors.get(1)))[TEAM.A], 1, 'more freezes');
  const seeds = new Set();
  for (let seed = 0; seed < 30; seed++) {
    const g = faceOff(undefined, { seed });
    stepUntil(g, () => g.phase === PHASE.FIGHT);
    g.colonel(TEAM.A).hp = 0;
    g.colonel(TEAM.B).hp = 0;
    g.step();
    seeds.add(g.meta().roundWins[TEAM.A]);
    assert.equal(g.meta().roundWins[TEAM.A] + g.meta().roundWins[TEAM.B], 1, 'exactly one winner');
  }
  assert.equal(seeds.size, 2, 'the rng can go either way');
});

test('face-off: at the timer the higher hp fraction wins, ties go to tie-breaks', () => {
  const g = faceOff();
  stepUntil(g, () => g.phase === PHASE.FIGHT);
  g.colonel(TEAM.A).hp = g.colonel(TEAM.A).maxHp * 0.5;
  g.colonel(TEAM.B).hp = g.colonel(TEAM.B).maxHp * 0.8;
  g.suddenDeath = true;
  const damage = g.damageStruct.bind(g);
  g.damageStruct = (s, amt, src) => { if (src !== null) damage(s, amt, src); };
  g.endsAtTick = g.tick + 1;
  g.step();
  assert.deepEqual(g.meta().roundWins, { [TEAM.A]: 0, [TEAM.B]: 1 });

  const tied = faceOff();
  stepUntil(tied, () => tied.phase === PHASE.FIGHT);
  tied.damageStruct(tied.colonel(TEAM.B), 5, tied.actors.get(1));
  tied.colonel(TEAM.A).hp = tied.colonel(TEAM.B).hp;
  tied.endsAtTick = tied.tick + 1;
  tied.step();
  assert.equal(tied.meta().roundWins[TEAM.A], 1, 'equal fractions, A dealt more');
});

test('face-off: flakes trickle in FIGHT, and each freeze pays the freezer\'s team', () => {
  const g = faceOff();
  stepUntil(g, () => g.phase === PHASE.FIGHT);
  const before = g.flakes[TEAM.A];
  for (let i = 0; i < 3 * SIM_HZ; i++) g.step();
  near(g.flakes[TEAM.A] - before, 3 * FORTWARS.flakePerSec, 1e-6);
  near(g.flakes[TEAM.B] - before, 3 * FORTWARS.flakePerSec, 1e-6);
  const bank = g.flakes[TEAM.A];
  g.damageActor(g.actors.get(2), 1e6, g.actors.get(1));
  near(g.flakes[TEAM.A], bank + FORTWARS.flakesPerFreeze);
  assert.equal(g.actors.get(1).stats.freezes, 1);
});

test('face-off: frozen kids respawn at home after respawnTime unless thawed first', () => {
  const g = faceOff([...team([1, 2], TEAM.A), ...team([3], TEAM.B)]);
  stepUntil(g, () => g.phase === PHASE.FIGHT);
  const kid = g.actors.get(1);
  kid.x = 500;
  kid.y = 200;
  kid.balls = 0;
  g.damageActor(kid, 1e6, g.actors.get(3));
  g.drainEvents();
  const home = g.map.spawns.fortwars[0][0];
  for (let i = 0; i < FORTWARS.respawnTime * SIM_HZ - 1; i++) g.step();
  assert.ok(kid.flags & AFLAG.FROZEN);
  g.step();
  g.step();
  assert.equal(kid.flags & AFLAG.FROZEN, 0);
  assert.deepEqual([kid.x, kid.y], [home.x, home.y]);
  assert.equal(kid.hp, kid.maxHp);
  assert.ok(kid.flags & AFLAG.GRACE);
  assert.ok(kid.balls > 0);
  const ev = g.drainEvents().find((e) => e.e === EV.RESPAWN);
  assert.deepEqual([ev.id, ev.x, ev.y], [1, home.x, home.y]);

  const friend = g.actors.get(2);
  kid.flags &= ~AFLAG.GRACE;
  kid.graceT = 0;
  g.damageActor(kid, 1e6, g.actors.get(3));
  friend.x = kid.x + 20;
  friend.y = kid.y;
  g.drainEvents();
  spin(() => g.step(), () => (kid.flags & AFLAG.FROZEN) === 0, 200);
  assert.ok(g.drainEvents().some((e) => e.e === EV.THAW && e.by === 2));
});

test('face-off: neutral pickups drop on the centre line every pickupEvery', () => {
  const g = faceOff();
  stepUntil(g, () => g.phase === PHASE.FIGHT);
  const adds = [];
  for (let i = 0; i < FORTWARS.pickupEvery * 3 * SIM_HZ + 2; i++) {
    g.step();
    adds.push(...g.drainEvents().filter((e) => e.e === EV.P_ADD));
  }
  assert.equal(adds.length, 3);
  assert.ok(adds.every((p) => p.x === g.map.truce.at));
});

test('face-off: enemy kids skid on a Slick, its builders do not', () => {
  const g = faceOff();
  const kid = g.actors.get(2);
  const own = g.actors.get(1);
  stepUntil(g, () => g.phase === PHASE.FIGHT);
  const slick = g.addStruct(STRUCT.SLICK, 3, 15, TEAM.A, 1, 30);
  kid.x = slick.x;
  kid.y = slick.y;
  own.x = slick.x;
  own.y = slick.y;
  g.step();
  assert.ok(kid.slowT > 0);
  assert.equal(own.slowT, 0);
});

test('face-off: Ready is available in BUILD with no bonus', () => {
  const g = faceOff();
  const flakes = g.flakes[TEAM.A];
  g.command(1, { c: CMD.READY });
  g.command(2, { c: CMD.READY });
  assert.equal(g.phase, PHASE.FIGHT);
  assert.equal(g.flakes[TEAM.A], flakes);
});

test('face-off: no cards are ever offered', () => {
  const g = faceOff();
  stepUntil(g, () => g.phase === PHASE.FIGHT);
  g.damageStruct(g.colonel(TEAM.B), 1e6, g.actors.get(1));
  g.step();
  const events = [];
  spin(() => { g.step(); events.push(...g.drainEvents()); }, () => g.round === 2);
  assert.equal(events.filter((e) => e.e === EV.PICK_OFFER).length, 0);
});

// ---- Free-for-All flow --------------------------------------------------------

test('ffa: every kid is its own team, with no Colonel and personal Flakes', () => {
  const g = ffa([1, 2, 3]);
  assert.deepEqual(g.kids().map((k) => k.team), [100, 101, 102]);
  assert.equal(g.colonels.size, 0);
  assert.deepEqual(g.meta().colonels, []);
  assert.deepEqual(g.meta().flakes, { 100: FFA.startFlakes, 101: FFA.startFlakes, 102: FFA.startFlakes });
  assert.equal(g.endsAtTick, FFA.buildTime * SIM_HZ);
  assert.equal(g.actors.get(2).x, g.map.spawns.ffa[1].x);
  assert.equal(g.meta().patchesLeft, 0);
});

test('ffa: BUILD ignores throws, then a timed FIGHT', () => {
  const g = ffa();
  const pad = new Pad(g, 1);
  pad.tick({ btn: BTN.THROW }, 3);
  pad.tick({ btn: 0 });
  assert.equal(g.balls.size, 0);
  stepUntil(g, () => g.phase === PHASE.FIGHT);
  assert.equal(g.endsAtTick, g.tick + FFA.matchTime * SIM_HZ);
});

test('ffa: kids can hit each other; freezes pay personal Flakes and score', () => {
  const g = ffa();
  stepUntil(g, () => g.phase === PHASE.FIGHT);
  const [a, b] = [g.actors.get(1), g.actors.get(2)];
  b.x = a.x + 100;
  b.y = a.y;
  g.throwFlat(a, 0, { speed: 540, flight: 0.72, dmg: 10 });
  for (let i = 0; i < 7; i++) g.step();
  assert.equal(b.hp, b.maxHp - 10);
  assert.equal(a.stats.hits, 1);
  const bank = g.flakes[a.team];
  g.damageActor(b, 1e6, a);
  assert.equal(a.stats.freezes, 1);
  near(g.flakes[a.team], bank + FFA.flakesPerFreeze);
  assert.equal(g.flakes[b.team], FFA.startFlakes);
});

test('ffa: respawn after respawnTime at the point farthest from the nearest enemy, with GRACE', () => {
  const g = ffa([1, 2, 3]);
  stepUntil(g, () => g.phase === PHASE.FIGHT);
  const [a, b, c] = [g.actors.get(1), g.actors.get(2), g.actors.get(3)];
  b.x = 100;
  b.y = 80;
  c.x = 130;
  c.y = 60;
  g.damageActor(a, 1e6, b);
  g.drainEvents();
  for (let i = 0; i < FFA.respawnTime * SIM_HZ + 1; i++) g.step();
  assert.equal(a.flags & AFLAG.FROZEN, 0);
  assert.ok(a.flags & AFLAG.GRACE);
  const distances = g.map.spawns.ffa.map((p) => Math.min(Math.hypot(p.x - b.x, p.y - b.y), Math.hypot(p.x - c.x, p.y - c.y)));
  const best = g.map.spawns.ffa[distances.indexOf(Math.max(...distances))];
  assert.deepEqual([a.x, a.y], [best.x, best.y]);
  assert.ok(g.drainEvents().some((e) => e.e === EV.RESPAWN && e.id === 1));
});

test('ffa: leaderId is the strict leader or null', () => {
  const g = ffa([1, 2, 3]);
  const [a, b] = [g.actors.get(1), g.actors.get(2)];
  assert.equal(g.meta().leaderId, null);
  a.stats.freezes = 2;
  assert.equal(g.meta().leaderId, 1);
  b.stats.freezes = 2;
  assert.equal(g.meta().leaderId, null);
  b.stats.freezes = 3;
  assert.equal(g.meta().leaderId, 2);
  assert.equal(siege().meta().leaderId, null);
});

test('ffa: freezing a leader who leads by leaderBonusLead counts double, and not before', () => {
  const g = ffa([1, 2, 3]);
  stepUntil(g, () => g.phase === PHASE.FIGHT);
  const [a, b, c] = [g.actors.get(1), g.actors.get(2), g.actors.get(3)];
  a.stats.freezes = FFA.leaderBonusLead;
  g.damageActor(a, 1e6, b);
  assert.equal(b.stats.freezes, 2);

  a.flags &= ~AFLAG.FROZEN;
  a.hp = a.maxHp;
  c.stats.freezes = 1;
  b.stats.freezes = 1;
  a.stats.freezes = FFA.leaderBonusLead;
  g.damageActor(a, 1e6, b);
  assert.equal(b.stats.freezes, 2, 'a lead of two is not enough');
});

test('ffa: first to freezesToWin ends it at once with that kid winning', () => {
  const g = ffa([1, 2]);
  stepUntil(g, () => g.phase === PHASE.FIGHT);
  const [a, b] = [g.actors.get(1), g.actors.get(2)];
  a.stats.freezes = FFA.freezesToWin - 1;
  g.damageActor(b, 1e6, a);
  g.step();
  assert.equal(g.isOver(), true);
  assert.deepEqual(g.result().winners, [1]);
  assert.equal(g.result().winnerTeam, a.team);
});

test('ffa: at matchTime most freezes wins, then more hits, then a shared win', () => {
  const finish = (setup) => {
    const g = ffa([1, 2, 3]);
    stepUntil(g, () => g.phase === PHASE.FIGHT);
    setup(g.actors.get(1), g.actors.get(2), g.actors.get(3));
    g.endsAtTick = g.tick + 1;
    g.step();
    return g.result();
  };
  assert.deepEqual(finish((a, b) => { a.stats.freezes = 2; b.stats.freezes = 1; b.stats.hits = 50; }).winners, [1]);
  assert.deepEqual(finish((a, b) => { a.stats.freezes = 2; b.stats.freezes = 2; b.stats.hits = 5; }).winners, [2]);
  const shared = finish((a, b) => { a.stats.freezes = 2; b.stats.freezes = 2; a.stats.hits = 5; b.stats.hits = 5; });
  assert.deepEqual(shared.winners.sort(), [1, 2]);
  assert.equal(shared.winnerTeam, null);
  assert.equal(shared.won, true);
});

test('ffa: pickups appear on their timer', () => {
  const g = ffa();
  stepUntil(g, () => g.phase === PHASE.FIGHT);
  let adds = 0;
  for (let i = 0; i < FFA.pickupEvery * SIM_HZ + 2; i++) {
    g.step();
    adds += g.drainEvents().filter((e) => e.e === EV.P_ADD).length;
  }
  assert.equal(adds, 1);
});

test('ffa: a run with nothing happening still ends at matchTime', () => {
  const g = ffa();
  stepUntil(g, () => g.isOver(), (FFA.buildTime + FFA.matchTime + 2) * SIM_HZ);
  assert.equal(g.result().won, true);
  assert.deepEqual(g.result().winners.sort(), [1, 2], 'nobody scored, so everyone shares it');
});

// ---- events, meta, full state --------------------------------------------------

test('events: stamped with g.tick inside a step, and rounded to 2 decimals', () => {
  const g = siege();
  g.step();
  const foe = dummy(g, ACTOR.PIPSQUEAK, 100.123456, 200.98765);
  const ev = g.drainEvents().find((e) => e.e === EV.SPAWN);
  assert.deepEqual([ev.x, ev.y], [100.12, 200.99]);
  assert.equal(foe.x, 100.123456, 'the sim itself keeps full precision');
  assert.equal(ev.t, g.tick);
});

test('events: the opening banner outlives a FULL at tick 0, setup noise does not', () => {
  const events = siege().drainEvents();
  const banner = events.find((e) => e.e === EV.BANNER);
  assert.ok(banner.t > 0, 'Session keeps only events past FULL.tick');
  assert.ok(events.filter((e) => e.e === EV.S_ADD).every((e) => e.t === 0));
});

test('events: draining clears the queue', () => {
  const g = siege();
  g.bark(g.colonel(TEAM.A), 'hi');
  assert.ok(g.drainEvents().length > 0);
  assert.deepEqual(g.drainEvents(), []);
});

test('events: commands between ticks stamp the tick they will be delivered with', () => {
  const g = siege();
  for (let i = 0; i < 4; i++) g.step();
  g.drainEvents();
  g.command(1, { c: CMD.BUILD, k: STRUCT.WALL, cx: 13, cy: 5 });
  const add = g.drainEvents().find((e) => e.e === EV.S_ADD);
  assert.equal(add.t, g.tick + 1, 'a FULL taken at this tick must not swallow it');
});

test('events: private ones carry to, public ones do not', () => {
  const g = siege([human(1), human(2)]);
  g.drainEvents();
  g.actors.get(2).balls = 0;
  g.command(1, { c: CMD.BUILD, k: STRUCT.WALL, cx: 29, cy: 18 });
  g.command(2, { c: CMD.EMOTE, n: 1 });
  const events = g.drainEvents();
  const deny = events.find((e) => e.e === EV.DENY);
  assert.deepEqual([deny.to, deny.why], [1, 'tooFar']);
  const emote = events.find((e) => e.e === EV.EMOTE);
  assert.deepEqual([emote.id, emote.n], [2, 1]);
  assert.equal(emote.to, undefined);
});

test('events: emotes outside the list are ignored', () => {
  const g = siege();
  g.drainEvents();
  g.command(1, { c: CMD.EMOTE, n: 99 });
  g.command(1, { c: CMD.EMOTE, n: 0.5 });
  assert.deepEqual(g.drainEvents(), []);
});

test('events: bots never receive a deny', () => {
  const g = faceOff([human(1), bot(2, { team: TEAM.B })]);
  g.drainEvents();
  g.command(2, { c: CMD.BUILD, k: STRUCT.WALL, cx: 0, cy: -1 });
  assert.equal(g.drainEvents().filter((e) => e.e === EV.DENY).length, 0);
});

test('events: commands from strangers or with no payload are ignored', () => {
  const g = siege();
  g.drainEvents();
  g.command(42, { c: CMD.BUILD, k: STRUCT.WALL, cx: 13, cy: 5 });
  g.command(1, null);
  g.command(1, { c: 'nonsense' });
  assert.deepEqual(g.drainEvents(), []);
});

test('events: a kid\'s every state change is reported for the HUD', () => {
  const g = siege([human(1), human(2)]);
  const kid = g.actors.get(1);
  g.drainEvents();
  g.damageActor(kid, 1e6, null);
  g.thawKid(kid, g.actors.get(2));
  assert.deepEqual(g.drainEvents().map((e) => e.e), [EV.HIT, EV.FREEZE, EV.THAW]);
});

const META_KEYS = [
  'phase', 'wave', 'waveCount', 'waveName', 'waveSub', 'endsAtTick', 'dayT', 'blizzard', 'flakes', 'colonels', 'foesLeft',
  'round', 'roundWins', 'boss', 'ready', 'scores', 'truce', 'suddenDeath', 'next', 'cards', 'leaderId', 'pultLimit', 'patchesLeft',
];

test('meta: exact shape in every mode, and JSON-safe', () => {
  for (const g of [siege([human(1), bot(2)]), faceOff(), ffa()]) {
    const m = g.meta();
    assert.deepEqual(Object.keys(m).sort(), [...META_KEYS].sort());
    assert.deepEqual(JSON.parse(JSON.stringify(m)), m);
    assert.deepEqual(Object.keys(m.ready).sort(), ['have', 'ids', 'need']);
    for (const s of m.scores) assert.deepEqual(Object.keys(s).sort(), ['built', 'flakes', 'freezes', 'hits', 'id', 'thaws']);
    for (const c of m.colonels) assert.deepEqual(Object.keys(c).sort(), ['hp', 'id', 'mhp', 'nose', 'team']);
  }
});

test('meta: siege content', () => {
  const g = siege([human(1)]);
  const m = g.meta();
  assert.equal(m.phase, PHASE.BUILD);
  assert.deepEqual([m.wave, m.waveCount], [1, 5]);
  assert.equal(typeof m.waveName, 'string');
  assert.ok(m.waveName.length > 0);
  assert.equal(m.endsAtTick, SIEGE.firstBuildTime * SIM_HZ);
  assert.deepEqual(m.flakes, { [TEAM.A]: SIEGE.startFlakes });
  assert.deepEqual(m.next, g.runner.preview);
  assert.equal(m.boss, null);
  assert.equal(m.truce, false);
  assert.equal(m.suddenDeath, false);
  assert.deepEqual(m.cards, { 1: [] });
});

test('meta: floors flakes and rounds hp to integers, dayT to 3 decimals', () => {
  const g = siege();
  g.flakes[TEAM.A] = 12.99;
  const col = g.colonel(TEAM.A);
  col.hp = 1234.56;
  const m = g.meta();
  assert.equal(m.flakes[TEAM.A], 12);
  assert.equal(m.colonels[0].hp, 1235);
  for (let i = 0; i < 400; i++) g.step();
  const { dayT } = g.meta();
  assert.equal(Number(dayT.toFixed(3)), dayT);
});

test('meta: no field changes every tick', () => {
  for (const g of [siege([human(1), bot(2)]), faceOff(), ffa()]) {
    stepUntil(g, () => g.tick >= 90 && (g.phase === PHASE.BUILD || g.phase === PHASE.FIGHT));
    const changes = {};
    let last = g.meta();
    const window = 120;
    for (let i = 0; i < window; i++) {
      g.step();
      g.drainEvents();
      const m = g.meta();
      for (const key of Object.keys(m)) {
        if (JSON.stringify(m[key]) !== JSON.stringify(last[key])) changes[key] = (changes[key] ?? 0) + 1;
      }
      last = m;
    }
    for (const [key, count] of Object.entries(changes)) {
      assert.ok(count < window / 4, `${g.mode}: meta.${key} changed on ${count} of ${window} ticks`);
    }
    assert.equal('tick' in g.meta(), false);
    assert.equal('time' in g.meta(), false);
  }
});

test('meta: a quiet Siege BUILD has identical metas tick to tick', () => {
  const g = siege([human(1)]);
  const pad = new Pad(g, 1);
  pad.tick({}, 3);
  const before = JSON.stringify(g.meta());
  pad.tick();
  assert.equal(JSON.stringify(g.meta()), before);
});

test('result: null until the end; JSON-safe and complete after', () => {
  const g = siege([human(1), bot(2)]);
  assert.equal(g.result(), null);
  assert.equal(g.isOver(), false);
  g.colonel(TEAM.A).hp = 0;
  g.step();
  const r = g.result();
  assert.deepEqual(Object.keys(r).sort(), ['mode', 'players', 'summary', 'winnerTeam', 'winners', 'won']);
  assert.deepEqual(JSON.parse(JSON.stringify(r)), r);
  assert.equal(typeof r.summary, 'string');
  assert.ok(r.summary.length > 0);
  for (const p of r.players) {
    assert.deepEqual(Object.keys(p).sort(), ['award', 'id', 'stats']);
    assert.deepEqual(Object.keys(p.stats).sort(), ['built', 'flakes', 'freezes', 'hits', 'thaws']);
  }
});

test('result: each award goes to the top of its stat, one per kid, nothing for zero', () => {
  const g = siege([human(1), human(2), human(3), human(4), human(5)]);
  const s = (id) => g.actors.get(id).stats;
  s(1).hits = 9;
  s(2).built = 7;
  s(3).thaws = 2;
  s(4).freezes = 6;
  g.colonel(TEAM.A).hp = 0;
  g.step();
  const award = Object.fromEntries(g.result().players.map((p) => [p.id, p.award]));
  assert.deepEqual(award, { 1: 'mitten', 2: 'foreman', 3: 'cocoa', 4: 'iceberg', 5: null });
});

test('result: a kid who tops two stats keeps the first and the second moves on', () => {
  const g = siege([human(1), human(2)]);
  const s = (id) => g.actors.get(id).stats;
  s(1).hits = 9;
  s(1).freezes = 9;
  s(2).freezes = 1;
  g.colonel(TEAM.A).hp = 0;
  g.step();
  const award = Object.fromEntries(g.result().players.map((p) => [p.id, p.award]));
  assert.deepEqual(award, { 1: 'mitten', 2: 'iceberg' });
});

test('fullState: JSON-safe, with structs, pickups, live balls, meta and the offer', () => {
  const g = siege();
  const kid = g.actors.get(1);
  const wall = buildOk(g, STRUCT.WALL, 13, 5);
  wall.hp = 12.3456;
  give(g, kid, PICKUP.ICE);
  const lob = g.throwLob(kid, 800, 150, { dmg: 5 });
  kid.offer = ['boots', 'tongs', 'sweater'];
  for (let i = 0; i < 3; i++) g.step();
  kid.offer = ['boots', 'tongs', 'sweater'];
  g.nextPickupId += 1;
  g.pickups.set(g.nextPickupId, { id: g.nextPickupId, kind: PICKUP.BOARD, x: 1000, y: 700, expiresAt: g.tick + 900 });
  const full = g.fullState(1);
  assert.deepEqual(Object.keys(full).sort(), ['balls', 'meta', 'offer', 'pickups', 'structs', 'tick']);
  assert.deepEqual(JSON.parse(JSON.stringify(full)), full);
  assert.equal(full.tick, g.tick);
  const record = full.structs.find((s) => s.id === wall.id);
  assert.deepEqual(record, { id: wall.id, kind: STRUCT.WALL, cx: 13, cy: 5, team: TEAM.A, hp: 12.35, maxHp: 60, ownerId: 1 });
  assert.equal(full.structs.length, 2, 'Colonel included');
  assert.deepEqual(Object.keys(full.pickups.at(-1)).sort(), ['id', 'kind', 'x', 'y']);
  assert.deepEqual(full.offer, ['boots', 'tongs', 'sweater']);
  assert.equal(g.fullState(2).offer, null);
  assert.deepEqual(full.meta, g.meta());

  const ball = full.balls.find((b) => b.id === lob.id);
  assert.equal(ball.t, g.tick);
  assert.equal(ball.e, EV.BALL);
  near(ball.x, lob.x, 0.0051);
  near(ball.z, lob.z, 0.0051);
  near(ball.vz, lob.vz, 0.0051);
  assert.equal(ball.ft, lob.life - 3, 'ticks left, so the closed form lands it on time');
  const landing = ball.z + ball.vz * ball.ft * DT - ball.g * DT * DT * ball.ft * (ball.ft - 1) / 2;
  near(landing, 0, 0.1, 'current values still satisfy the closed form');
});

test('fullState: balls share every key with the ball event', () => {
  const g = siege();
  g.throwFlat(g.actors.get(1), 0.2);
  const ev = g.drainEvents().find((e) => e.e === EV.BALL);
  const [ball] = g.fullState(1).balls;
  assert.deepEqual(Object.keys(ball).sort(), Object.keys(ev).sort());
});

// ---- snapshots ----------------------------------------------------------------

test('snapshot: actor records in wire shape, hp as a fraction', () => {
  const g = siege();
  const pad = new Pad(g, 1);
  const foe = dummy(g, ACTOR.BRUISER, 100, 100);
  foe.hp = foe.maxHp / 2;
  pad.kid.hp = 25;
  pad.tick({ aim: 2 });
  const records = g.actorsForSnapshot();
  assert.equal(records.length, 2);
  for (const r of records) {
    assert.deepEqual(Object.keys(r).sort(), ['aim', 'aux', 'flags', 'hp', 'id', 'kind', 'team', 'vx', 'vy', 'x', 'y']);
    assert.ok(r.hp >= 0 && r.hp <= 1);
    assert.ok(r.aux >= 0 && r.aux <= 255 && Number.isInteger(r.aux));
  }
  assert.equal(records.find((r) => r.id === 1).hp, 0.25);
  assert.equal(records.find((r) => r.id === 1).aim, 2);
  assert.equal(records.find((r) => r.id === foe.id).hp, 0.5);
});

test('snapshot: You record has exactly the spec fields, in seconds', () => {
  const g = siege();
  const you = g.privateState(1);
  assert.deepEqual(Object.keys(you).sort(), [
    'balls', 'boardT', 'frozenT', 'maxBalls', 'maxWarmth', 'packT', 'prevBtn', 'slideCd', 'slideT', 'slowT',
    'spendLeft', 'special', 'specialN', 'stunT', 'throwCd', 'warmth',
  ].sort());
  assert.equal(you.warmth, KID.maxWarmth);
  assert.equal(you.frozenT, 0);
  assert.equal(g.privateState(99), null);
  const foe = g.spawnFoe(ACTOR.PIPSQUEAK, 100, 100);
  assert.equal(g.privateState(foe.id), null);
});

test('snapshot: real records survive the wire format in every state', () => {
  const g = siege([human(1), human(2)]);
  const pad = new Pad(g, 1);
  pad.kid.special = PICKUP.TRIPLE;
  pad.kid.specialN = 4;
  pad.tick({ btn: BTN.THROW, aim: 5.5 }, 12);
  dummy(g, ACTOR.TRUCK, 300, 300).aux |= AUX.DOORS;
  const buffer = encodeSnapshot({ tick: g.tick, ack: g.ackSeq(1), you: g.privateState(1), actors: g.actorsForSnapshot() });
  const snap = decodeSnapshot(buffer);
  assert.equal(snap.tick, g.tick);
  assert.equal(snap.ack, 12);
  assert.equal(snap.you.special, PICKUP.TRIPLE);
  assert.equal(snap.you.spendLeft, 65535);
  const me = snap.actors.find((a) => a.id === 1);
  assert.ok(me.flags & AFLAG.CHARGING);
  near(me.aux / 255, pad.kid.charge, 0.01);
  near(me.aim, 5.5, 0.03);
  near(me.x, pad.kid.x, 0.13);
  assert.equal(snap.actors.length, 3);

  g.freezeOrFlee(pad.kid, null);
  pad.tick();
  const frozen = decodeSnapshot(encodeSnapshot({ tick: g.tick, ack: 0, you: g.privateState(1), actors: g.actorsForSnapshot() }));
  assert.equal(frozen.you.frozenT, KID.frozenAutoThaw);
  assert.equal(frozen.you.warmth, 0);
  assert.equal(frozen.actors.find((a) => a.id === 1).hp, 0);

  const noSpecial = decodeSnapshot(encodeSnapshot({ tick: 1, ack: 0, you: g.privateState(2), actors: [] }));
  assert.equal(noSpecial.you.special, 255, 'none is distinct from PICKUP.ICE, which is 0');
});

test('snapshot: a frame through the wire format plays the same as it would locally', () => {
  const frame = { seq: 1, mx: 0.73, my: -0.41, aim: 2.2, btn: BTN.SLIDE, tx: 410, ty: 222 };
  const wire = decodeInput(encodeInput(frame));
  const cw = createCollisionWorld(blankMap());
  const a = stepKidMotion(motionKid(), wire, cw, DT);
  const g = siege();
  const kid = g.actors.get(1);
  kid.x = 400;
  kid.y = 300;
  g.queueInput(1, wire);
  g.step();
  for (const key of ['x', 'y', 'vx', 'vy', 'slideT', 'slideCd', 'prevBtn']) assert.equal(kid[key], a[key], key);
});

test('snapshot: g.foes and g.kids split the actors, and survive edits while iterating', () => {
  const g = siege([human(1), bot(2)]);
  const a = g.spawnFoe(ACTOR.PIPSQUEAK, 100, 100);
  const b = g.spawnFoe(ACTOR.PIPSQUEAK, 100, 100);
  assert.deepEqual([...g.foes()], [a, b]);
  assert.deepEqual([...g.kids()].map((k) => k.id), [1, 2]);
  for (const foe of g.foes()) g.despawn(foe);
  assert.equal(g.foes().length, 0);
});

// ---- players joining and leaving -----------------------------------------------

test('late joiner: a Siege kid has no body until the next BUILD starts', () => {
  const g = siege();
  startFight(g);
  g.addPlayer(human(2));
  assert.equal(g.privateState(2), null);
  assert.equal(g.ackSeq(2), 0);
  assert.equal(g.actors.has(2), false);
  g.queueInput(2, { seq: 1, mx: 1, my: 0, aim: 0, btn: 0, tx: 0, ty: 0 });
  g.step();
  assert.equal(g.ackSeq(2), 0, 'input is ignored');
  g.command(2, { c: CMD.BUILD, k: STRUCT.WALL, cx: 13, cy: 5 });
  assert.equal(g.structAt(13, 5), null);
  assert.equal(g.fullState(2).offer, null);
  g.setAfk(2, true);
  g.setAfk(2, false);
  g.resetInput(2);

  const events = [];
  spin(() => { g.step(); events.push(...g.drainEvents()); clearFoes(g); }, () => g.wave === 2);
  assert.equal(g.phase, PHASE.BUILD);
  const kid = g.actors.get(2);
  assert.ok(kid);
  assert.notEqual(g.privateState(2), null);
  assert.ok(events.some((e) => e.e === EV.RESPAWN && e.id === 2));
  assert.ok(events.some((e) => e.e === EV.PICK_OFFER && e.to === 2), 'they get a card like anyone else');
  g.queueInput(2, { seq: 1, mx: 1, my: 0, aim: 0, btn: 0, tx: 0, ty: 0 });
  g.step();
  assert.equal(g.ackSeq(2), 1);
});

test('late joiner: counts in the weighted head-count, rescaling at that BUILD', () => {
  const g = siege();
  const pad = new Pad(g, 1);
  while (g.phase !== PHASE.FIGHT) pad.tick();
  g.addPlayer(human(2));
  near(g.weightedPlayers(), 2);
  near(g.countMul, 1, 1e-9, 'not mid-wave');
  while (g.wave === 1) {
    pad.tick();
    clearFoes(g);
  }
  near(g.countMul, 1 + SIEGE.perExtraPlayerCount);
});

test('late joiner: joining during BUILD still waits for the next BUILD start', () => {
  const g = siege();
  g.addPlayer(human(2));
  assert.equal(g.privateState(2), null);
  assert.equal(g.meta().ready.need, 1);
});

test('late joiner: Face-Off and FFA spawn at once', () => {
  const f = faceOff();
  f.addPlayer(human(3, { team: TEAM.B }));
  assert.notEqual(f.privateState(3), null);
  assert.equal(f.actors.get(3).team, TEAM.B);

  const a = ffa();
  a.addPlayer(human(3, { team: TEAM.FFA_BASE + 2 }));
  assert.notEqual(a.privateState(3), null);
  assert.equal(a.flakes[TEAM.FFA_BASE + 2], FFA.startFlakes);
});

test('late joiner: adding the same id twice changes nothing', () => {
  const g = siege();
  const kid = g.actors.get(1);
  g.addPlayer(human(1));
  assert.equal(g.actors.get(1), kid);
});

test('leaving: removePlayer takes the kid and their input, leaves their structs', () => {
  const g = siege([human(1), human(2)]);
  const wall = buildOk(g, STRUCT.WALL, 13, 5, 2);
  g.command(2, { c: CMD.READY });
  g.removePlayer(2);
  assert.equal(g.actors.has(2), false);
  assert.equal(g.privateState(2), null);
  assert.equal(g.ackSeq(2), 0);
  assert.ok(g.structs.has(wall.id));
  assert.equal(g.meta().ready.have, 0);
  g.queueInput(2, { seq: 9, mx: 0, my: 0, aim: 0, btn: 0, tx: 0, ty: 0 });
  g.removePlayer(2);
  g.step();
});

test('leaving: a ball outlives its thrower without crediting anyone', () => {
  const g = siege([human(1), human(2)]);
  const kid = g.actors.get(2);
  const foe = dummy(g, ACTOR.BRUISER, kid.x + 80, kid.y, 1000);
  g.throwFlat(kid, 0, { speed: 540, flight: 0.72, dmg: 10 });
  g.removePlayer(2);
  for (let i = 0; i < 8; i++) g.step();
  assert.equal(foe.hp, 990);
});

test('afk: setAfk sets and clears the flag at once, and a disconnected kid idles', () => {
  const g = siege([human(1), human(2)]);
  const pad = new Pad(g, 1);
  g.setAfk(1, true);
  assert.ok(pad.kid.flags & AFLAG.AFK);
  for (let i = 0; i < 20; i++) g.step();
  assert.ok(pad.kid.flags & AFLAG.AFK);
  g.setAfk(1, false);
  g.resetInput(1);
  pad.seq = 0;
  pad.tick();
  assert.equal(pad.kid.flags & AFLAG.AFK, 0);
  assert.equal(g.ackSeq(1), 1);
});

// ---- determinism and the shipped maps -------------------------------------------

function scriptedRun(seed, mapIndex, mode, ticks) {
  const players = mode === MODE.SIEGE
    ? [human(1), bot(2), bot(3)]
    : mode === MODE.FORTWARS
      ? [human(1), bot(2), bot(3, { team: TEAM.B }), bot(4, { team: TEAM.B })]
      : [1, 2, 3, 4].map((id, i) => (id === 1 ? human(id, { team: TEAM.FFA_BASE + i }) : bot(id, { team: TEAM.FFA_BASE + i })));
  const g = new Game({ mode, mapId: MAPS[mapIndex].id, difficulty: DIFFICULTY.NORMAL, waveCount: 5, seed, players });
  const script = createRng(`${seed}-script`);
  const log = [];
  let seq = 0;
  for (let i = 0; i < ticks && !g.isOver(); i++) {
    seq += 1;
    g.queueInput(1, {
      seq, mx: script() * 2 - 1, my: script() * 2 - 1, aim: script() * 6.28, btn: script() < 0.3 ? BTN.THROW : 0,
      tx: script() * g.map.w, ty: script() * g.map.h,
    });
    g.step();
    if (i % 2 === 0) log.push(JSON.stringify([g.tick, g.actorsForSnapshot(), g.drainEvents()]));
  }
  return { log, meta: JSON.stringify(g.meta()) };
}

test('determinism: one seed and one input script replay identically, foes and bots included', () => {
  for (const mode of [MODE.SIEGE, MODE.FORTWARS, MODE.FFA]) {
    const first = scriptedRun('cafe', 0, mode, 1800);
    const second = scriptedRun('cafe', 0, mode, 1800);
    assert.equal(first.log.length, second.log.length);
    for (let i = 0; i < first.log.length; i++) assert.equal(first.log[i], second.log[i], `${mode} diverged at sample ${i}`);
    assert.equal(first.meta, second.meta);
  }
});

test('determinism: a different seed plays out differently', () => {
  const a = scriptedRun('cafe', 0, MODE.SIEGE, 1800);
  const b = scriptedRun('beef', 0, MODE.SIEGE, 1800);
  assert.notEqual(a.meta + a.log.at(-1), b.meta + b.log.at(-1));
});

test('shipped maps: every Colonel sits on the grid', () => {
  for (const map of MAPS) {
    for (const fort of [map.fort, ...map.forts]) {
      assert.equal(fort.x % CELL, 0, `${map.id} fort x`);
      assert.equal(fort.y % CELL, 0, `${map.id} fort y`);
    }
  }
});

test('shipped maps: nobody starts a match inside anything', () => {
  const eight = (team) => Array.from({ length: 8 }, (_, i) => human(i + 1, { team: team(i) }));
  const lineups = [
    [MODE.SIEGE, eight(() => TEAM.A)],
    [MODE.FORTWARS, [...eight(() => TEAM.A), ...eight(() => TEAM.B).map((p) => ({ ...p, id: p.id + 8 }))]],
    [MODE.FFA, eight((i) => TEAM.FFA_BASE + i)],
  ];
  for (const map of MAPS) {
    for (const [mode, players] of lineups) {
      const g = new Game({ mode, mapId: map.id, seed: 1, waveCount: 5, players });
      for (const kid of g.kids()) {
        const body = { x: kid.x, y: kid.y, r: kid.r };
        collideCircle(g.cw, body, kid.x, kid.y);
        assert.deepEqual([body.x, body.y], [kid.x, kid.y], `${map.id}/${mode} kid ${kid.id} would be shoved out of something`);
      }
    }
  }
});

test('shipped maps: every mode constructs and every entrance can reach the Colonel', () => {
  for (const map of MAPS) {
    const g = new Game({ mode: MODE.SIEGE, mapId: map.id, seed: 1, waveCount: 5, players: [human(1)] });
    assert.equal(g.map, map);
    for (const e of map.entrances) {
      const { cx, cy } = g.cw.cellOf(e.x, e.y);
      assert.ok(Number.isFinite(g.flow(TEAM.FOES).cost[cy * g.cw.cols + cx]), `${map.id} entrance ${e.x},${e.y} is cut off`);
    }
    assert.ok(new Game({ mode: MODE.FORTWARS, mapId: map.id, seed: 1, players: [human(1), human(2, { team: TEAM.B })] }).colonel(TEAM.B));
    assert.ok(new Game({ mode: MODE.FFA, mapId: map.id, seed: 1, players: [human(1, { team: 100 }), human(2, { team: 101 })] }).kids().length === 2);
  }
});

// ---- soak ---------------------------------------------------------------------

function assertSane(g, label) {
  const check = (v, what) => assert.ok(Number.isFinite(v), `${label}: ${what} is ${v} at tick ${g.tick}`);
  let foes = 0;
  let bosses = 0;
  for (const a of g.actors.values()) {
    for (const key of ['x', 'y', 'vx', 'vy', 'aim', 'hp', 'maxHp', 'stunT', 'slowT']) check(a[key], `actor ${a.id} ${key}`);
    assert.ok(a.x >= -1 && a.x <= g.map.w + 1 && a.y >= -1 && a.y <= g.map.h + 1, `${label}: actor ${a.id} off the map at ${a.x},${a.y}`);
    if (a.kind === ACTOR.KID) {
      assert.ok(a.balls >= 0 && a.balls <= a.maxBalls, `${label}: kid ${a.id} holds ${a.balls} balls`);
      assert.ok(a.hp >= 0 && a.hp <= a.maxHp + 1e-9, `${label}: kid ${a.id} warmth ${a.hp}`);
    } else if (FOES[a.kind].boss) {
      bosses += 1;
    } else {
      foes += 1;
    }
  }
  assert.ok(foes <= MAX_ACTORS, `${label}: ${foes} foes`);
  assert.ok(bosses <= 2, `${label}: ${bosses} bosses`);
  assert.ok(g.balls.size <= 300, `${label}: ${g.balls.size} balls`);
  assert.ok(g.structs.size <= 2 * MAX_STRUCTS_PER_TEAM + 2 || g.mode === MODE.FFA, `${label}: ${g.structs.size} structs`);
  assert.ok(g.pickups.size <= 12, `${label}: ${g.pickups.size} pickups`);
  for (const b of g.balls.values()) {
    for (const key of ['x', 'y', 'z', 'vx', 'vy', 'vz', 'g', 'r']) check(b[key], `ball ${b.id} ${key}`);
  }
  for (const s of g.structs.values()) {
    check(s.hp, `struct ${s.id} hp`);
    assert.ok(s.hp >= 0 && s.hp <= s.maxHp + 1e-9, `${label}: struct ${s.id} hp ${s.hp}/${s.maxHp}`);
  }
  for (const team of Object.keys(g.flakes)) {
    check(g.flakes[team], `flakes ${team}`);
    assert.ok(g.flakes[team] >= 0, `${label}: team ${team} is ${g.flakes[team]} Flakes in debt`);
  }
}

function soakMatch({ mode, mapId, seed, ticks, players, waveCount = 0, difficulty = DIFFICULTY.NORMAL, keepColonelUp = false }) {
  const g = new Game({ mode, mapId, seed, players, waveCount, difficulty });
  const rng = createRng(`${seed}-input`);
  const label = `${mode}/${mapId}/${seed}`;
  const humans = players.filter((p) => !p.isBot).map((p) => ({ id: p.id, seq: 0, mx: 0, my: 0, btn: 0 }));
  let events = 0;
  for (let i = 0; i < ticks && !g.isOver(); i++) {
    for (const h of humans) {
      const kid = g.actors.get(h.id);
      if (kid === undefined) continue;
      if (rng() < 0.08) {
        h.mx = rng() * 2 - 1;
        h.my = rng() * 2 - 1;
      }
      if (rng() < 0.15) h.btn = Math.floor(rng() * 16);
      // Some of the time, input arrives in bursts or not at all, like a bad connection.
      const burst = rng() < 0.05 ? Math.floor(rng() * 9) : 1;
      for (let f = 0; f < burst; f++) {
        h.seq += 1;
        g.queueInput(h.id, {
          seq: h.seq, mx: h.mx, my: h.my, aim: rng() * Math.PI * 2, btn: h.btn,
          tx: kid.x + (rng() - 0.5) * 900, ty: kid.y + (rng() - 0.5) * 900,
        });
      }
      if (rng() < 0.02) {
        const cx = Math.floor((kid.x + (rng() - 0.5) * 400) / CELL);
        const cy = Math.floor((kid.y + (rng() - 0.5) * 400) / CELL);
        if (rng() < 0.7) g.command(h.id, { c: CMD.BUILD, k: Math.floor(rng() * 6), cx, cy });
        else g.command(h.id, { c: CMD.DEMOLISH, cx, cy });
      }
      if (rng() < 0.002) g.command(h.id, { c: CMD.READY });
      if (rng() < 0.01) g.command(h.id, { c: CMD.CARD, i: Math.floor(rng() * 3) });
      if (rng() < 0.002) g.command(h.id, { c: CMD.EMOTE, n: Math.floor(rng() * 6) });
    }
    g.step();
    if (keepColonelUp) g.colonel(TEAM.A).hp = g.colonel(TEAM.A).maxHp;
    if (g.tick % 2 === 0) {
      const drained = g.drainEvents();
      events += drained.length;
      for (const ev of drained) {
        assert.equal(typeof ev.e, 'string');
        assert.ok(Number.isInteger(ev.t));
        for (const v of Object.values(ev)) if (typeof v === 'number') assert.ok(Number.isFinite(v), `${label}: event ${ev.e} carries ${v}`);
      }
    }
    if (g.tick % 30 === 0) {
      assertSane(g, label);
      JSON.stringify(g.meta());
      g.actorsForSnapshot();
      for (const h of humans) {
        g.privateState(h.id);
        g.fullState(h.id);
        assert.ok(g.inputs.has(h.id) === false || g.inputs.get(h.id).queue.length <= 16, `${label}: input queue ran away`);
      }
    }
  }
  assertSane(g, label);
  assert.ok(events > 0);
  return g;
}

// Matches end on their own schedule, so a budget of ticks is spent across as many as it
// takes. Ending early would otherwise pass for a long, clean run.
function soak(options) {
  let played = 0;
  let matches = 0;
  while (played < options.ticks) {
    const g = soakMatch({ ...options, seed: `${options.seed}-${matches}`, ticks: options.ticks - played });
    played += g.tick;
    matches += 1;
  }
  return { played, matches };
}

test('soak: Siege Endless on every map with bots and flaky humans', { timeout: 120000 }, () => {
  for (const [index, map] of MAPS.entries()) {
    const { played } = soak({
      mode: MODE.SIEGE, mapId: map.id, seed: `siege-${index}`, ticks: 54000,
      players: [human(1), human(2), bot(3), bot(4)], difficulty: index === 2 ? DIFFICULTY.BLIZZARD : DIFFICULTY.NORMAL,
    });
    assert.ok(played >= 54000);
  }
});

test('soak: a Colonel who never falls carries Endless deep past both bosses', { timeout: 120000 }, () => {
  for (const [index, map] of MAPS.entries()) {
    const g = soakMatch({
      mode: MODE.SIEGE, mapId: map.id, seed: `deep-${index}`, ticks: 45000, keepColonelUp: true,
      players: [human(1), bot(2), bot(3), bot(4), bot(5), bot(6), bot(7), bot(8)],
    });
    assert.equal(g.tick, 45000);
    assert.ok(g.wave > 10, `${map.id} only reached wave ${g.wave}`);
  }
});

test('soak: Fort Face-Off with full teams on every map', { timeout: 120000 }, () => {
  for (const [index, map] of MAPS.entries()) {
    const { matches } = soak({
      mode: MODE.FORTWARS, mapId: map.id, seed: `fort-${index}`, ticks: 36000,
      players: [human(1), bot(2), bot(3), bot(4), human(5, { team: TEAM.B }), bot(6, { team: TEAM.B }), bot(7, { team: TEAM.B }), bot(8, { team: TEAM.B })],
    });
    assert.ok(matches >= 1);
  }
});

test('soak: Free-for-All with eight kids on every map', { timeout: 120000 }, () => {
  for (const [index, map] of MAPS.entries()) {
    const players = Array.from({ length: 8 }, (_, i) => (i < 2 ? human(i + 1, { team: TEAM.FFA_BASE + i }) : bot(i + 1, { team: TEAM.FFA_BASE + i })));
    const { matches } = soak({ mode: MODE.FFA, mapId: map.id, seed: `ffa-${index}`, ticks: 18000, players });
    assert.ok(matches >= 3, 'every one of them ended by itself');
  }
});

test('soak: a boss wave with a full field stays within bounds', { timeout: 120000 }, () => {
  const g = new Game({
    mode: MODE.SIEGE, mapId: 'court', seed: 'boss', waveCount: 0, difficulty: DIFFICULTY.BLIZZARD,
    players: Array.from({ length: 8 }, (_, i) => bot(i + 1)),
  });
  g.wave = 10;
  g.openSiegeBuild(false);
  for (let i = 0; i < 18000; i++) {
    g.step();
    g.drainEvents();
    g.colonel(TEAM.A).hp = g.colonel(TEAM.A).maxHp;
    if (g.tick % 30 === 0) assertSane(g, 'boss');
  }
  assertSane(g, 'boss');
});
