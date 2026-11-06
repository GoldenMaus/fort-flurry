// A scripted stand-in for Session that exercises every piece of world art without a running match.
// Dev tool only: it builds a fake `view` by hand, drives it with a fixed-seed script and feeds the
// renderer the same fx events the real game would.
//
// URL params: ?scene=fight|build|faceoff|ffa|boss|catalog|heavy&map=court|pond|yard&day=0..1&blizzard=1
//             &quality=high|low|auto&bare=1 (hides the panel, for screenshots)
import { Renderer } from '../js/render/renderer.js';
import { getMap, MAPS } from '../shared/maps.js';
import { ACTOR, AFLAG, AUX, BALL, EV, EMOTES, MODE, PHASE, PICKUP, SFX, STRUCT, TEAM } from '../shared/schema.js';
import { BOT_NAMES, BUILD, CELL, FOES, KID, SIM_HZ, THROW } from '../shared/constants.js';

const DAY_PRESETS = { dawn: 0.02, morning: 0.16, noon: 0.33, afternoon: 0.5, golden: 0.64, dusk: 0.74, twilight: 0.84, night: 0.97 };
const SCENES = ['fight', 'build', 'faceoff', 'ffa', 'boss', 'catalog', 'heavy'];

function mulberry(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// A flat, featureless lot for the catalog: nothing competes with the art being inspected.
function catalogMap() {
  const obstacles = [];
  const put = (o) => obstacles.push({ shape: 'rect', blocksMove: true, blocksBalls: true, height: 60, rot: 0, variant: 0, ...o });
  const dot = (type, x, y, r, extra) => put({ type, shape: 'circle', x, y, r, ...extra });
  put({ type: 'house', x: 60, y: 90, w: 280, h: 200, variant: 0 });
  put({ type: 'house', x: 400, y: 120, w: 240, h: 160, variant: 1 });
  put({ type: 'house', x: 700, y: 120, w: 200, h: 160, variant: 2 });
  put({ type: 'house', x: 960, y: 90, w: 180, h: 190, rot: 90, variant: 3 });
  put({ type: 'house', x: 1200, y: 120, w: 240, h: 170, variant: 4 });
  put({ type: 'house', x: 1500, y: 130, w: 240, h: 130, variant: 5 });
  dot('pine', 90, 430, 24, { variant: 0 });
  dot('pine', 190, 430, 22, { variant: 1 });
  dot('pine', 290, 430, 20, { variant: 2 });
  dot('tree', 400, 430, 26, { variant: 0 });
  dot('tree', 520, 430, 26, { variant: 1 });
  dot('tree', 640, 430, 26, { variant: 2 });
  dot('bush', 740, 430, 18);
  dot('bush', 800, 430, 22, { variant: 1 });
  dot('rock', 880, 430, 26);
  dot('rock', 950, 430, 18, { variant: 1 });
  dot('lamp', 1020, 430, 8);
  dot('mailbox', 1080, 430, 9, { variant: 0 });
  dot('mailbox', 1120, 430, 9, { variant: 1 });
  dot('hydrant', 1170, 430, 10);
  dot('bin', 1220, 430, 14);
  dot('bin', 1270, 430, 15);
  put({ type: 'bench', x: 1320, y: 410, w: 100, h: 26 });
  put({ type: 'bench', x: 1450, y: 370, w: 26, h: 90, variant: 1, rot: 90 });
  put({ type: 'car', x: 1520, y: 390, w: 120, h: 46, variant: 0 });
  put({ type: 'car', x: 1660, y: 350, w: 46, h: 120, variant: 1, rot: 90 });
  put({ type: 'car', x: 60, y: 530, w: 120, h: 56, variant: 2 });
  put({ type: 'car', x: 210, y: 530, w: 120, h: 46, variant: 3 });
  put({ type: 'fence', x: 370, y: 560, w: 180, h: 10 });
  put({ type: 'fence', x: 590, y: 500, w: 10, h: 90, rot: 90 });
  put({ type: 'fence', x: 640, y: 560, w: 180, h: 10, variant: 1, blocksBalls: false, height: 56 });
  put({ type: 'fence', x: 860, y: 480, w: 10, h: 110, rot: 90, variant: 1, blocksBalls: false, height: 56 });
  put({ type: 'swing', x: 900, y: 510, w: 220, h: 70 });
  put({ type: 'swing', x: 1140, y: 500, w: 70, h: 180, rot: 90 });
  put({ type: 'slide', x: 1240, y: 520, w: 200, h: 56 });
  put({ type: 'slide', x: 1460, y: 500, w: 56, h: 160, rot: 90 });
  put({ type: 'monkeybars', x: 1540, y: 520, w: 200, h: 56 });
  put({ type: 'monkeybars', x: 1760, y: 480, w: 56, h: 160, rot: 90 });
  put({ type: 'schoolwall', x: 60, y: 660, w: 700, h: 200 });
  put({ type: 'schoolwall', x: 800, y: 660, w: 60, h: 300, rot: 90 });
  put({ type: 'unknown-thing', x: 900, y: 720, w: 80, h: 60, height: 50 });
  put({ type: 'unknown-thing', shape: 'circle', x: 1040, y: 760, r: 24, height: 50 });
  return {
    id: 'catalog', theme: 'court', name: 'Catalog', w: 1880, h: 1560, obstacles,
    ice: [{ shape: 'ellipse', x: 1400, y: 800, rx: 260, ry: 120 }, { shape: 'rect', x: 1220, y: 900, w: 300, h: 60 }],
    fort: { x: 480, y: 1080 }, forts: [{ x: 240, y: 1080 }, { x: 760, y: 1080 }], truce: { axis: 'y', at: 1000 },
    spawns: { siege: [], fortwars: [[], []], ffa: [] }, entrances: [{ x: 20, y: 1200 }], truckPath: [], lights: [],
    decor: [
      { type: 'road', points: [{ x: 1100, y: 1000 }, { x: 1300, y: 1040 }, { x: 1700, y: 1020 }], width: 90 },
      { type: 'path', points: [{ x: 1100, y: 1150 }, { x: 1300, y: 1120 }, { x: 1600, y: 1180 }], width: 44 },
      { type: 'bridge', x: 1560, y: 700, w: 200, h: 90 }, { type: 'snowpatch', x: 1200, y: 1220, w: 160, h: 90 },
      { type: 'sled', x: 1460, y: 1290 }, { type: 'shovel', x: 1580, y: 1290 }, { type: 'reeds', x: 1700, y: 1290 },
      { type: 'drift', x: 1120, y: 1320 }, { type: 'hopscotch', x: 1760, y: 1450 }, { type: 'tiretracks', x: 1300, y: 1420 },
      { type: 'no-such-decor', x: 1, y: 1 },
    ],
  };
}

class FakeMatch {
  constructor(renderer, map, opts) {
    this.renderer = renderer;
    this.map = map;
    this.opts = opts;
    this.rng = mulberry(20261106);
    this.time = 0;
    this.clock = 0;
    this.nextBallId = 1;
    this.nextId = 1000;
    this.flying = [];
    this.scripts = [];
    this.movers = [];
    const fort = map.fort;
    this.view = {
      map, mapId: map.id, mode: MODE.SIEGE, phase: PHASE.FIGHT, wave: 4, waveCount: 10, waveName: 'Lobs Away', dayT: opts.dayT, blizzard: opts.blizzard,
      meta: {
        phase: PHASE.FIGHT, wave: 4, foesLeft: 12, truce: false, next: null, leaderId: null, colonels: [],
        flakes: { [TEAM.A]: 22 }, cards: {}, boss: null,
      },
      renderTick: 1000, secondsLeft: null, me: null,
      you: { balls: 8, maxBalls: 10, mods: { lobSplashMul: 1, throwSpeedMul: 1, buildRangeMul: 1 } },
      actors: [], balls: [], structs: [], pickups: [], players: new Map(), cw: null,
    };
    this.ui = {
      tool: null, toolCell: null, toolState: null, toolValid: false, buildRange: KID.buildRange, aimX: fort.x, aimY: fort.y,
      lobbing: false, charge: 0, sticks: [], reduceMotion: false,
    };
  }

  id() {
    return this.nextId++;
  }

  // ---- fixture builders -----------------------------------------------------

  player(id, name, team, look) {
    this.view.players.set(id, { id, name, look, team, isBot: id > 3, connected: true });
  }

  kid(id, name, team, x, y, extra = {}) {
    const look = { hat: id % 6, coat: (id * 3) % 8, scarf: (id * 5 + 1) % 8, skin: id % 6 };
    this.player(id, name, team, look);
    const a = { id, kind: ACTOR.KID, team, x, y, vx: 0, vy: 0, aim: 0, hp: 1, flags: 0, aux: 0, ...extra };
    this.view.actors.push(a);
    return a;
  }

  foe(kind, x, y, extra = {}) {
    const a = { id: this.id(), kind, team: TEAM.FOES, x, y, vx: 0, vy: 0, aim: 0, hp: 1, flags: 0, aux: 0, ...extra };
    this.view.actors.push(a);
    return a;
  }

  struct(kind, cx, cy, hpFrac = 1, team = TEAM.A) {
    const mhp = BUILD[kind].hp;
    const s = { id: this.id(), kind, cx, cy, team, hp: mhp * hpFrac, maxHp: mhp, ownerId: 1, bornAt: 0 };
    this.view.structs.push(s);
    return s;
  }

  colonel(team, x, y, hpFrac = 1) {
    const s = this.struct(STRUCT.COLONEL, Math.round(x / CELL) - 1, Math.round(y / CELL) - 1, hpFrac, team);
    this.view.meta.colonels.push({ team, id: s.id, hp: s.hp, mhp: s.maxHp, nose: true });
    return s;
  }

  // Walks an actor back and forth between two points at a given speed.
  pace(a, x1, y1, speed) {
    this.movers.push({ a, x0: a.x, y0: a.y, x1, y1, speed, t: this.rng() });
  }

  every(seconds, fn, first = 0) {
    this.scripts.push({ seconds, fn, at: first });
  }

  // ---- fake balls -----------------------------------------------------------

  throwFlat(from, tx, ty, kind = BALL.QUICK, speed = THROW.quick.speed) {
    const d = Math.hypot(tx - from.x, ty - from.y) || 1;
    const flight = Math.min(d / speed, 1.1);
    const id = this.nextBallId++;
    const z0 = THROW.z0;
    const ball = { id, kind, x: from.x, y: from.y, z: z0, vx: ((tx - from.x) / d) * speed, vy: ((ty - from.y) / d) * speed, vz: 0, g: (2 * z0) / (flight * flight), r: kind === BALL.POWER ? 8 : 6, t: 0, flight, mine: from === this.view.me };
    if (kind === BALL.CONE) ball.r = 7;
    this.flying.push(ball);
    this.fx({ e: EV.BALL, id, k: kind, by: from.id, tm: from.team, x: ball.x, y: ball.y, z: z0, vx: ball.vx, vy: ball.vy, vz: 0, g: ball.g, r: ball.r });
    return ball;
  }

  throwLob(from, tx, ty) {
    const d = Math.hypot(tx - from.x, ty - from.y) || 1;
    const flight = THROW.lob.minFlight + d * THROW.lob.flightPerUnit;
    const g = THROW.lob.gravity;
    const id = this.nextBallId++;
    const z0 = THROW.z0;
    const ball = { id, kind: BALL.LOB, x: from.x, y: from.y, z: z0, vx: (tx - from.x) / flight, vy: (ty - from.y) / flight, vz: (0.5 * g * flight * flight - z0) / flight, g, r: 7, t: 0, flight, lx: tx, ly: ty, ft: Math.round(flight * SIM_HZ), mine: from === this.view.me, tm: from.team };
    this.flying.push(ball);
    this.fx({ e: EV.BALL, id, k: BALL.LOB, by: from.id, tm: from.team, x: ball.x, y: ball.y, z: z0, vx: ball.vx, vy: ball.vy, vz: ball.vz, g, r: 7, lx: tx, ly: ty, ft: ball.ft });
  }

  fx(ev) {
    this.renderer.onFx(ev, this.view);
  }

  // ---- step -----------------------------------------------------------------

  tick(dt) {
    this.time += dt;
    this.view.renderTick += dt * SIM_HZ;
    for (const m of this.movers) {
      const dx = m.x1 - m.x0;
      const dy = m.y1 - m.y0;
      const len = Math.hypot(dx, dy) || 1;
      m.t = (m.t + (m.speed * dt) / len) % 2;
      const k = m.t < 1 ? m.t : 2 - m.t;
      m.a.x = m.x0 + dx * k;
      m.a.y = m.y0 + dy * k;
      const sign = m.t < 1 ? 1 : -1;
      m.a.vx = ((dx / len) * m.speed) * sign;
      m.a.vy = ((dy / len) * m.speed) * sign;
      m.a.aim = Math.atan2(m.a.vy, m.a.vx);
    }
    for (const s of this.scripts) {
      s.at -= dt;
      if (s.at <= 0) {
        s.at += s.seconds;
        s.fn();
      }
    }
    const view = this.view;
    const out = [];
    for (const b of this.flying) {
      b.t += dt;
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      b.z += b.vz * dt;
      b.vz -= b.g * dt;
      if (b.t >= b.flight || b.z <= 0) {
        this.fx({ e: EV.BALL_END, id: b.id, x: b.x, y: b.y, z: 0, why: 'ground', hit: 0 });
        if (b.kind === BALL.LOB) this.fx({ e: EV.SPLASH, x: b.x, y: b.y, r: THROW.lob.splash, k: BALL.LOB });
      } else {
        out.push(b);
      }
    }
    this.flying = out;
    view.balls = out.concat(this.statics || []);
    const me = view.me;
    if (me && this.aimAt) {
      this.ui.aimX = this.aimAt.x;
      this.ui.aimY = this.aimAt.y;
      me.aim = Math.atan2(this.ui.aimY - me.y, this.ui.aimX - me.x);
    }
  }
}

// ---- scenes -----------------------------------------------------------------

function fortRing(m, cx, cy) {
  // A rough ring of walls, in every damage state, with the seams and corners that exercise joinery.
  const cells = [];
  for (let x = -4; x <= 5; x++) {
    cells.push([x, -4]);
    cells.push([x, 5]);
  }
  for (let y = -3; y <= 4; y++) {
    cells.push([-4, y]);
    cells.push([5, y]);
  }
  cells.forEach(([dx, dy], i) => {
    if ((dx === 0 || dx === 1) && dy === 5) return; // gate
    if ((dy === 0 || dy === 1) && dx === -4) return; // gate
    const frac = [1, 1, 1, 0.55, 1, 0.25, 1, 0.5, 1, 1, 0.2][i % 11];
    const kind = i % 7 === 3 || dy === -4 && dx > 1 ? STRUCT.ICEWALL : STRUCT.WALL;
    m.struct(kind, cx + dx, cy + dy, frac);
  });
}

function sceneFight(m) {
  const { map, view } = m;
  const fort = map.fort;
  const cx = Math.floor(fort.x / CELL);
  const cy = Math.floor(fort.y / CELL);
  m.colonel(TEAM.A, fort.x, fort.y, 0.8);
  fortRing(m, cx, cy);
  m.struct(STRUCT.PULT, cx - 2, cy - 3);
  m.struct(STRUCT.PULT, cx + 3, cy - 2, 0.5);
  m.struct(STRUCT.COCOA, cx + 3, cy + 3);
  m.struct(STRUCT.COCOA, cx - 3, cy + 3, 0.4);
  m.struct(STRUCT.DECOY, cx - 6, cy + 2);
  m.struct(STRUCT.DECOY, cx + 7, cy, 0.55);
  m.struct(STRUCT.DECOY, cx + 7, cy + 3, 0.25);
  for (const [dx, dy, f] of [[-6, -2, 1], [-7, -2, 0.5], [-6, -1, 0.3], [-7, -1, 1]]) m.struct(STRUCT.SLICK, cx + dx, cy + dy, f);

  const me = m.kid(1, 'Juno', TEAM.A, fort.x - 110, fort.y + 88, { flags: AFLAG.CHARGING, aux: 200 });
  view.me = me;
  const pal = m.kid(2, 'Bobble', TEAM.A, fort.x + 90, fort.y + 90);
  m.pace(pal, fort.x + 150, fort.y + 110, 150);
  m.kid(3, 'Galosh', TEAM.A, fort.x - 40, fort.y + 140, { flags: AFLAG.PACKING });
  m.kid(4, 'Toboggan', TEAM.A, fort.x - 210, fort.y - 40, { flags: AFLAG.FROZEN, aux: 120, hp: 0 });
  const sl = m.kid(5, 'Pompom', TEAM.A, fort.x + 20, fort.y - 110, { flags: AFLAG.SLIDING });
  m.pace(sl, fort.x + 170, fort.y - 130, 300);
  const bd = m.kid(6, 'Earflap', TEAM.A, fort.x - 260, fort.y + 200, { flags: AFLAG.BOARDING, hp: 0.6 });
  m.pace(bd, fort.x - 120, fort.y + 250, 280);
  m.kid(7, 'Woolly', TEAM.A, fort.x + 230, fort.y - 30, { flags: AFLAG.STUNNED, hp: 0.3 });
  m.kid(8, 'Toggle', TEAM.A, fort.x + 200, fort.y + 170, { flags: AFLAG.GRACE });
  m.aimAt = { x: fort.x - 360, y: fort.y + 60 };
  m.ui.charge = 0.72;

  const foes = [];
  const add = (kind, dx, dy, extra) => {
    const f = m.foe(kind, fort.x + dx, fort.y + dy, extra);
    foes.push(f);
    return f;
  };
  m.pace(add(ACTOR.PIPSQUEAK, -420, 60), fort.x - 330, fort.y + 70, FOES[ACTOR.PIPSQUEAK].speed);
  m.pace(add(ACTOR.PIPSQUEAK, -400, 150), fort.x - 320, fort.y + 170, FOES[ACTOR.PIPSQUEAK].speed);
  m.pace(add(ACTOR.SLINGER, -380, -50), fort.x - 300, fort.y - 80, FOES[ACTOR.SLINGER].speed);
  add(ACTOR.LOBBER, -470, -120);
  m.pace(add(ACTOR.BRUISER, -280, 100), fort.x - 200, fort.y + 110, FOES[ACTOR.BRUISER].speed);
  add(ACTOR.LIDKID, -300, 220, { flags: AFLAG.SHIELDED });
  m.pace(add(ACTOR.SNEAK, 300, 180, { aux: AUX.NOSE }), fort.x + 390, fort.y + 240, 160);
  m.pace(add(ACTOR.SLEDDER, -500, 230, { flags: AFLAG.SLEDDING }), fort.x - 90, fort.y + 300, FOES[ACTOR.SLEDDER].speed);
  add(ACTOR.PIPSQUEAK, 320, -130, { flags: AFLAG.FLEEING, hp: 0 });
  add(ACTOR.SLINGER, 390, 40, { hp: 0.5 });

  view.pickups.push({ id: 1, kind: PICKUP.ICE, x: fort.x - 60, y: fort.y + 230 });
  view.pickups.push({ id: 2, kind: PICKUP.COCOA, x: fort.x + 90, y: fort.y + 210 });
  view.pickups.push({ id: 3, kind: PICKUP.TRIPLE, x: fort.x - 170, y: fort.y + 280 });
  view.pickups.push({ id: 4, kind: PICKUP.GIANT, x: fort.x + 260, y: fort.y + 240 });
  view.pickups.push({ id: 5, kind: PICKUP.SLUSH, x: fort.x + 340, y: fort.y + 120 });
  view.pickups.push({ id: 6, kind: PICKUP.BOARD, x: fort.x - 330, y: fort.y + 300 });

  const rng = m.rng;
  const shooters = foes.filter((f) => !(f.flags & AFLAG.FLEEING));
  m.every(0.42, () => {
    const f = shooters[Math.floor(rng() * shooters.length)];
    m.throwFlat(f, fort.x + (rng() - 0.5) * 340, fort.y + (rng() - 0.5) * 260, BALL.QUICK, 360);
  });
  m.every(0.55, () => {
    const k = view.actors.filter((a) => a.kind === ACTOR.KID && !(a.flags & AFLAG.FROZEN));
    const a = k[Math.floor(rng() * k.length)];
    const f = shooters[Math.floor(rng() * shooters.length)];
    m.throwFlat(a, f.x, f.y, rng() < 0.25 ? BALL.POWER : rng() < 0.2 ? BALL.ICE : BALL.QUICK, rng() < 0.25 ? 860 : 540);
  }, 0.1);
  m.every(1.3, () => {
    m.throwLob(shooters[3], fort.x + (rng() - 0.6) * 240, fort.y + (rng() - 0.5) * 200);
    m.throwLob(me, fort.x - 310 + rng() * 40, fort.y + rng() * 60);
  }, 0.2);
  m.every(0.8, () => {
    const a = shooters[Math.floor(rng() * shooters.length)];
    a.hp = Math.max(0.1, a.hp - 0.1);
    m.fx({ e: EV.HIT, id: a.id, amt: 10 + Math.floor(rng() * 16), x: a.x, y: a.y, by: 1, k: BALL.QUICK });
    m.fx({ e: EV.FLAKES, amt: 2, x: a.x, y: a.y, tm: TEAM.A });
  }, 0.3);
  m.every(2.1, () => m.fx({ e: EV.HIT, id: 1, amt: 6, x: me.x, y: me.y, by: 0, k: BALL.QUICK }), 0.7);
  m.every(2.6, () => {
    const pick = view.structs[(Math.floor(rng() * view.structs.length))];
    if (pick.kind !== STRUCT.COLONEL) {
      pick.hp = Math.max(1, pick.hp - 10);
      m.fx({ e: EV.S_HP, id: pick.id, hp: pick.hp });
    }
  }, 1);
  m.every(2.4, () => m.fx({ e: EV.PULT, id: view.structs.find((s) => s.kind === STRUCT.PULT).id, ang: Math.PI * 0.9 }), 0.4);
  const lines = ['Hey! Over here!', 'You missed!', 'Is that all you got?', 'My mittens are soaked!', 'Cold cold cold cold'];
  let lineNo = 0;
  m.every(1.7, () => {
    const f = shooters[lineNo % shooters.length];
    m.fx({ e: EV.BARK, id: f.id, text: lines[lineNo++ % lines.length] });
  }, 0.05);
  m.every(5, () => m.fx({ e: EV.EMOTE, id: 2, n: 3 }), 0.5);
  m.every(4.2, () => m.fx({ e: EV.BARK, id: view.meta.colonels[0].id, text: 'Hold the line, troops!' }), 1.2);
}

function sceneBuild(m) {
  const { map, view } = m;
  const fort = map.fort;
  const cx = Math.floor(fort.x / CELL);
  const cy = Math.floor(fort.y / CELL);
  view.phase = PHASE.BUILD;
  view.meta.phase = PHASE.BUILD;
  view.meta.next = { foes: [{ k: ACTOR.PIPSQUEAK, n: 8 }], from: map.entrances.map((_, i) => i).slice(0, 3) };
  m.colonel(TEAM.A, fort.x, fort.y);
  for (let i = -3; i <= 4; i++) {
    m.struct(STRUCT.WALL, cx + i, cy - 4);
    if (i < 1 || i > 2) m.struct(STRUCT.WALL, cx + i, cy + 5);
  }
  for (let i = -3; i <= 4; i++) {
    m.struct(i % 3 ? STRUCT.WALL : STRUCT.ICEWALL, cx - 4, cy + i);
    m.struct(STRUCT.ICEWALL, cx + 5, cy + i);
  }
  m.struct(STRUCT.PULT, cx - 2, cy + 2);
  const me = m.kid(1, 'Juno', TEAM.A, fort.x + 90, fort.y + 100);
  view.me = me;
  m.kid(2, 'Bobble', TEAM.A, fort.x - 70, fort.y + 110);
  m.kid(3, 'Galosh', TEAM.A, fort.x + 80, fort.y - 80);
  m.aimAt = { x: fort.x + 110, y: fort.y + 110 };
  const tools = [
    { tool: STRUCT.WALL, state: 'ok', cell: [cx + 2, cy + 4] },
    { tool: STRUCT.ICEWALL, state: 'noFlakes', cell: [cx + 3, cy + 3] },
    { tool: STRUCT.COCOA, state: 'ok', cell: [cx + 2, cy + 3] },
    { tool: STRUCT.PULT, state: 'ok', cell: [cx + 3, cy + 2] },
    { tool: STRUCT.DECOY, state: 'badCell', cell: [cx, cy] },
    { tool: STRUCT.WALL, state: 'repair', cell: [cx - 2, cy - 4] },
    { tool: STRUCT.WALL, state: 'patch', cell: [cx - 1, cy - 1] },
    { tool: 'demolish', state: 'demolish', cell: [cx - 1, cy - 4] },
    { tool: STRUCT.SLICK, state: 'tooFar', cell: [cx + 9, cy + 6] },
  ];
  let i = m.opts.tool ?? 2;
  const apply = () => {
    const t = tools[i % tools.length];
    m.ui.tool = t.tool;
    m.ui.toolState = t.state;
    m.ui.toolCell = { cx: t.cell[0], cy: t.cell[1] };
    m.ui.toolValid = ['ok', 'repair', 'patch', 'demolish'].includes(t.state);
  };
  apply();
  m.cycleTool = () => {
    i++;
    apply();
  };
}

function sceneFaceoff(m) {
  const { map, view } = m;
  view.mode = MODE.FORTWARS;
  view.phase = PHASE.BUILD;
  view.meta.phase = PHASE.BUILD;
  view.meta.truce = true;
  const t = map.truce;
  const [fa, fb] = map.forts;
  m.colonel(TEAM.A, fa.x, fa.y);
  m.colonel(TEAM.B, fb.x, fb.y);
  const ax = t.axis === 'x' ? t.at : fa.x;
  const ay = t.axis === 'x' ? fa.y : t.at;
  const me = m.kid(1, 'Juno', TEAM.A, ax - 120, ay + 20);
  view.me = me;
  m.kid(2, 'Bobble', TEAM.A, ax - 60, ay - 80);
  m.kid(3, 'Galosh', TEAM.B, ax + 70, ay + 40);
  m.kid(4, 'Toboggan', TEAM.B, ax + 130, ay - 60);
  const cx = Math.floor(ax / CELL);
  const cy = Math.floor(ay / CELL);
  for (let i = -2; i <= 2; i++) {
    m.struct(STRUCT.WALL, cx - 4, cy + i, 1, TEAM.A);
    m.struct(STRUCT.ICEWALL, cx + 4, cy + i, 1, TEAM.B);
  }
  m.struct(STRUCT.DECOY, cx - 3, cy + 3, 1, TEAM.A);
  m.struct(STRUCT.DECOY, cx + 3, cy + 3, 1, TEAM.B);
  m.struct(STRUCT.COCOA, cx - 3, cy - 3, 1, TEAM.A);
  m.struct(STRUCT.COCOA, cx + 3, cy - 3, 1, TEAM.B);
  m.struct(STRUCT.PULT, cx - 5, cy, 1, TEAM.A);
  m.struct(STRUCT.PULT, cx + 5, cy, 1, TEAM.B);
  m.aimAt = { x: ax, y: ay };
}

function sceneFfa(m) {
  const { map, view } = m;
  view.mode = MODE.FFA;
  const c = { x: map.w / 2, y: map.h / 2 };
  const me = m.kid(1, 'Juno', TEAM.FFA_BASE, c.x - 90, c.y + 40);
  view.me = me;
  for (let i = 1; i < 8; i++) {
    const a = (i / 7) * Math.PI * 2;
    m.kid(i + 1, BOT_NAMES[i], TEAM.FFA_BASE + i, c.x + Math.cos(a) * 220, c.y + Math.sin(a) * 170);
  }
  view.meta.leaderId = 3;
  m.aimAt = { x: c.x, y: c.y };
}

function sceneBoss(m) {
  const { map, view } = m;
  const fort = map.fort;
  m.colonel(TEAM.A, fort.x, fort.y, 0.35);
  const me = m.kid(1, 'Juno', TEAM.A, fort.x - 40, fort.y + 170);
  view.me = me;
  m.kid(2, 'Bobble', TEAM.A, fort.x + 130, fort.y + 140);
  m.kid(3, 'Galosh', TEAM.A, fort.x + 340, fort.y + 340, { flags: AFLAG.FROZEN, aux: 60, hp: 0 });
  const truck = m.foe(ACTOR.TRUCK, fort.x - 320, fort.y - 10, { aux: AUX.DOORS, vx: 0, vy: 0 });
  const steve = m.foe(ACTOR.STEVE, fort.x + 260, fort.y - 120, { aux: AUX.POUND, flags: AFLAG.ENRAGED });
  m.aimAt = { x: truck.x, y: truck.y };
  m.ui.lobbing = true;
  view.me.flags = AFLAG.LOBAIM;
  m.foe(ACTOR.PIPSQUEAK, truck.x - 90, truck.y + 110);
  m.foe(ACTOR.PIPSQUEAK, truck.x - 30, truck.y + 130);
  m.statics = [
    { id: 5001, kind: BALL.BOULDER, x: fort.x + 90, y: fort.y - 100, z: 0, r: 36, vx: -130, vy: 70, vz: 0, g: 0 },
    { id: 5002, kind: BALL.GIANT, x: fort.x - 170, y: fort.y + 190, z: 0, r: 22, vx: 300, vy: 0, vz: 0, g: 0 },
    { id: 5003, kind: BALL.CONE, x: fort.x - 200, y: fort.y + 40, z: 26, r: 7, vx: 300, vy: 120, vz: 0, g: 0 },
    { id: 5004, kind: BALL.CONE, x: fort.x - 220, y: fort.y + 90, z: 22, r: 7, vx: 300, vy: 170, vz: 0, g: 0 },
    { id: 5005, kind: BALL.SLUSH, x: fort.x + 40, y: fort.y + 110, z: 30, r: 8, vx: 200, vy: -160, vz: 0, g: 0 },
    { id: 5006, kind: BALL.ICE, x: fort.x + 100, y: fort.y + 40, z: 24, r: 6, vx: 500, vy: -200, vz: 0, g: 0 },
    { id: 5007, kind: BALL.POWER, x: fort.x - 60, y: fort.y + 60, z: 22, r: 8, vx: -760, vy: -300, vz: 0, g: 0 },
  ];
  m.every(3.1, () => m.fx({ e: EV.QUAKE, x: steve.x, y: steve.y, amt: 1 }), 0.25);
  m.every(4, () => m.fx({ e: EV.SFX, name: SFX.CHEER, x: fort.x, y: fort.y - 50 }), 0.5);
  view.meta.foesLeft = 3;
  view.meta.boss = { kind: ACTOR.STEVE, name: FOES[ACTOR.STEVE].name, hp: 1500, mhp: 3200 };
}

function sceneCatalog(m) {
  const { view } = m;
  const baseCy = 25;
  const baseCx = 2;
  // Every struct at each damage level: rows by level, columns by kind.
  const kinds = [STRUCT.WALL, STRUCT.ICEWALL, STRUCT.DECOY, STRUCT.PULT, STRUCT.COCOA, STRUCT.SLICK];
  [1, 0.5, 0.2].forEach((f, row) => {
    kinds.forEach((k, col) => {
      m.struct(k, baseCx + col * 3, baseCy + row * 3, f);
      m.struct(k, baseCx + 18 + col * 2, baseCy + row * 3, f, TEAM.B);
    });
  });
  // Joinery demo: a corner, a T and a filled block for both wall kinds.
  const shape = [[0, 0], [1, 0], [2, 0], [3, 0], [0, 1], [0, 2], [3, 1], [1, 2], [2, 2], [3, 2]];
  for (const [x, y] of shape) m.struct(STRUCT.WALL, baseCx + x, baseCy + 9 + y);
  for (const [x, y] of shape) m.struct(STRUCT.ICEWALL, baseCx + 6 + x, baseCy + 9 + y);
  m.colonel(TEAM.A, (baseCx + 14) * CELL, (baseCy + 10) * CELL);
  Object.values(PICKUP).forEach((k, i) => view.pickups.push({ id: 100 + i, kind: k, x: 100 + i * 60, y: 1510 }));
  m.statics = Object.values(BALL).map((k, i) => ({ id: 9000 + i, kind: k, x: 520 + i * 70, y: 1510, z: 20, r: [6, 8, 7, 6, 8, 22, 7, 36][i], vx: 0, vy: 0, vz: 0, g: 0 }));
  // A kid standing around, but no `me`: the catalog is also the no-player camera path.
  m.kid(1, 'Juno', TEAM.A, 260, 1100);
  view.me = null;
}

function sceneHeavy(m) {
  const { map, view } = m;
  const fort = map.fort;
  const rng = m.rng;
  m.colonel(TEAM.A, fort.x, fort.y, 0.6);
  const cx = Math.floor(fort.x / CELL);
  const cy = Math.floor(fort.y / CELL);
  // Spec maximum for one team: 120 structures, dense and all in view.
  let n = 0;
  for (let r = 3; r <= 8 && n < 120; r++) {
    for (let i = -r; i <= r && n < 120; i++) {
      for (const [dx, dy] of [[i, -r], [i, r + 1], [-r, i], [r + 1, i]]) {
        if (n >= 120 || (i + r) % 3 === 0) continue;
        const kinds = [STRUCT.WALL, STRUCT.WALL, STRUCT.ICEWALL, STRUCT.WALL, STRUCT.PULT, STRUCT.COCOA, STRUCT.DECOY, STRUCT.SLICK];
        const k = kinds[n % kinds.length];
        m.struct(k, cx + dx, cy + dy, 0.2 + rng() * 0.8);
        n++;
      }
    }
  }
  const me = m.kid(1, 'Juno', TEAM.A, fort.x - 120, fort.y + 60, { flags: AFLAG.CHARGING, aux: 160 });
  view.me = me;
  for (let i = 2; i <= 8; i++) {
    const a = m.kid(i, BOT_NAMES[i - 1], TEAM.A, fort.x + (rng() - 0.5) * 300, fort.y + (rng() - 0.5) * 240);
    m.pace(a, a.x + 120, a.y + 40, 200);
  }
  m.aimAt = { x: fort.x - 400, y: fort.y };
  m.ui.charge = 0.6;
  const kinds = [ACTOR.PIPSQUEAK, ACTOR.PIPSQUEAK, ACTOR.SLINGER, ACTOR.LOBBER, ACTOR.BRUISER, ACTOR.SLEDDER, ACTOR.LIDKID, ACTOR.SNEAK];
  // MAX_ACTORS: 90 foes on top of 8 kids, packed into the view rather than spread over the map.
  const foes = [];
  for (let i = 0; i < 90; i++) {
    const a = rng() * Math.PI * 2;
    const d = 260 + rng() * 320;
    const f = m.foe(kinds[i % kinds.length], fort.x + Math.cos(a) * d, fort.y + Math.sin(a) * d * 0.7);
    m.pace(f, fort.x + Math.cos(a) * (d - 90), fort.y + Math.sin(a) * (d - 90) * 0.7, 80 + rng() * 60);
    foes.push(f);
  }
  m.foe(ACTOR.TRUCK, fort.x - 300, fort.y - 200, { aux: AUX.DOORS });
  m.foe(ACTOR.STEVE, fort.x + 310, fort.y + 80, { aux: AUX.POUND });
  for (let i = 0; i < 12; i++) view.pickups.push({ id: 200 + i, kind: i % 6, x: fort.x + (rng() - 0.5) * 700, y: fort.y + (rng() - 0.5) * 500 });
  m.every(0.03, () => {
    const f = foes[Math.floor(rng() * foes.length)];
    m.throwFlat(f, fort.x + (rng() - 0.5) * 300, fort.y + (rng() - 0.5) * 240, rng() < 0.2 ? BALL.CONE : BALL.QUICK, 480);
  });
  m.every(0.2, () => m.throwLob(foes[Math.floor(rng() * foes.length)], fort.x + (rng() - 0.5) * 300, fort.y + (rng() - 0.5) * 240));
  m.every(0.09, () => {
    const f = foes[Math.floor(rng() * foes.length)];
    m.fx({ e: EV.HIT, id: f.id, amt: 10 + Math.floor(rng() * 16), x: f.x, y: f.y, by: 1, k: BALL.QUICK });
  });
  m.every(0.5, () => m.fx({ e: EV.BARK, id: foes[Math.floor(rng() * foes.length)].id, text: EMOTES[Math.floor(rng() * EMOTES.length)] }));
  m.every(0.35, () => {
    const s = view.structs[1 + Math.floor(rng() * (view.structs.length - 1))];
    s.hp = Math.max(1, s.hp - 4);
    m.fx({ e: EV.S_HP, id: s.id, hp: s.hp });
  });
}

const BUILDERS = { fight: sceneFight, build: sceneBuild, faceoff: sceneFaceoff, ffa: sceneFfa, boss: sceneBoss, catalog: sceneCatalog, heavy: sceneHeavy };

// ---- page -------------------------------------------------------------------

const params = new URLSearchParams(location.search);
const canvas = document.getElementById('game');
const renderer = new Renderer(canvas, { quality: params.get('quality') || 'high' });
const panel = {
  scene: document.getElementById('scene'), map: document.getElementById('map'), day: document.getElementById('day'),
  blizzard: document.getElementById('blizzard'), quality: document.getElementById('quality'), run: document.getElementById('run'),
  stats: document.getElementById('stats'),
};
if (params.get('bare')) document.body.classList.add('bare');
for (const s of SCENES) panel.scene.add(new Option(s, s));
for (const m of MAPS) panel.map.add(new Option(m.name, m.id));
for (const k of Object.keys(DAY_PRESETS)) panel.day.add(new Option(k, k));
panel.day.value = 'noon';

let match = null;
let catalog = null;

function start(opts = {}) {
  const scene = opts.scene ?? panel.scene.value;
  const mapId = opts.map ?? panel.map.value;
  const day = opts.day ?? panel.day.value;
  const dayT = typeof day === 'number' ? day : DAY_PRESETS[day];
  const blizzard = opts.blizzard ?? panel.blizzard.checked;
  panel.scene.value = scene;
  panel.map.value = mapId;
  panel.blizzard.checked = blizzard;
  let map;
  if (scene === 'catalog') map = catalog || (catalog = catalogMap());
  else map = getMap(mapId);
  renderer.setMap(map);
  match = new FakeMatch(renderer, map, { dayT, blizzard, tool: opts.tool });
  BUILDERS[scene](match);
  match.tick(0.001);
  match.view.dayT = dayT;
  return match;
}

function frame(dt) {
  match.tick(dt);
  renderer.render(match.view, match.ui, dt);
}

// Runs n frames without waiting for rAF: gives repeatable screenshots at any tab visibility.
function step(n = 1, dt = 1 / 60) {
  for (let i = 0; i < n; i++) frame(dt);
}

// Measures real cost over `frames` rAF ticks. Reports draw CPU time and the true frame interval.
function measure(frames = 240) {
  return new Promise((resolve) => {
    const draws = [];
    const gaps = [];
    let last = performance.now();
    let left = frames;
    const tickFrame = () => {
      const now = performance.now();
      const dt = Math.min(0.1, (now - last) / 1000);
      gaps.push(now - last);
      last = now;
      const t0 = performance.now();
      frame(dt);
      draws.push(performance.now() - t0);
      if (--left > 0) requestAnimationFrame(tickFrame);
      else {
        const stat = (list) => {
          const s = [...list].sort((a, b) => a - b);
          const p = (q) => +s[Math.floor(q * (s.length - 1))].toFixed(2);
          return { mean: +(s.reduce((a, b) => a + b, 0) / s.length).toFixed(2), p50: p(0.5), p95: p(0.95), p99: p(0.99), max: +s[s.length - 1].toFixed(2) };
        };
        resolve({
          frames, draw: stat(draws), interval: stat(gaps.slice(1)),
          actors: match.view.actors.length, structs: match.view.structs.length, balls: match.view.balls.length,
          particles: renderer.fx.count, items: renderer.stats.items, canvas: [canvas.width, canvas.height], pixelRatio: +renderer.pixelRatio.toFixed(3),
          zoom: +renderer.zoom.toFixed(3), quality: renderer.low ? 'low' : 'high', spriteScale: renderer.spriteScale,
        });
      }
    };
    requestAnimationFrame(tickFrame);
  });
}

let last = 0;
function loop(now) {
  requestAnimationFrame(loop);
  if (!panel.run.checked || !match) return;
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  frame(dt);
  panel.stats.textContent = `${renderer.stats.drawMs.toFixed(1)} ms  ${renderer.fx.count} fx  ${renderer.stats.items} items`;
}

for (const key of ['scene', 'map', 'day']) panel[key].addEventListener('change', () => start());
panel.blizzard.addEventListener('change', () => { match.view.blizzard = panel.blizzard.checked; });
panel.quality.addEventListener('change', () => renderer.setQuality(panel.quality.value));
window.addEventListener('resize', () => renderer.resize());

start({
  scene: params.get('scene') || 'fight',
  map: params.get('map') || 'court',
  day: params.get('day') ? (Number.isNaN(+params.get('day')) ? params.get('day') : +params.get('day')) : 'noon',
  blizzard: params.get('blizzard') === '1',
});
if (params.get('paused')) panel.run.checked = false;
window.__gallery = { renderer, start, step, measure, get match() { return match; }, panel, ready: true };
requestAnimationFrame(loop);
