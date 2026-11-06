// Fort Flurry — foe brains (SPEC section 5).
// Pure functions over the Game. All memory lives in foe.ai; randomness comes from g.rng()
// so a seed replays the same fight. Bosses live in ai_bosses.js.
import { ACTOR, AFLAG, AUX, BALL, EV, SFX, STRUCT, TEAM } from './schema.js';
import { BUILD, CELL, FOES, KID, THROW } from './constants.js';

const THINK_EVERY = 0.5;
const GRUDGE_TIME = 3;          // how long a foe remembers who hit it
const NOTICE_RANGE = 220;       // a kid this close beats any building as a target
const STUCK_WINDOW = 3;
const STUCK_DISTANCE = 12;
const CROWD_REFRESH_TICKS = 4;
const CROWD_PUSH = 0.55;

// Per-kind throwing style. Numbers from FOES stay in constants.js; these are personality.
const THROWERS = Object.freeze({
  [ACTOR.PIPSQUEAK]: { spread: 0.09, lead: 0, shy: 0 },
  [ACTOR.SLINGER]: { spread: 0.025, lead: 0.55, shy: 170 },
  [ACTOR.LIDKID]: { spread: 0.07, lead: 0, shy: 0 },
  [ACTOR.SLEDDER]: { spread: 0.09, lead: 0, shy: 0 },
});
const LOBBER_SHY = 160;
const LOBBER_LEAD = 0.75;
const LOBBER_CLUSTER_RADIUS = 90;
const LID_THROW_ARC = 0.35;     // a Lid Kid only throws at what its lid is pointing at
const SLED_CRASH_FRACTION = 0.3;

// ---- words --------------------------------------------------------------------

export const COLONEL_LINES = Object.freeze({
  waveStart: [
    'Positions, troops! Snowy side up!',
    'Steady now. Steady-ish.',
    'I have a bucket and I am prepared to wear it.',
    'Remember your training. We had training, yes?',
    'Eyes front! Mine are coal, but yours will do.',
    'Hold the line! Any line! Draw one if you must!',
    'Nobody panic. I have been standing here for hours.',
    'Mittens up, Brigade!',
  ],
  waveClear: [
    'Ha! Tell your friends. Actually, do not.',
    'Well melted, team. I mean, not melted.',
    'Another wave repelled by sheer posture.',
    'Put that in the history books. Spell it right.',
  ],
  noseGrabbed: [
    'My nose! Stop that child!',
    'Hey! That carrot was load-bearing!',
    'Thief! Thief with very cold fingers!',
    'I could smell that coming. Until now.',
  ],
  noseLost: [
    'He got away with it! I keep spares, but still!',
    'That was my Sunday carrot!',
    'I shall be writing a very stern letter.',
  ],
  truck: [
    'That chime! Nobody buy anything!',
    'Hold your allowance, troops! It is a trap!',
    'Hit it when the doors open! That is where the syrup lives!',
  ],
  truckGone: ['And stay off my cul-de-sac!', 'Refunds are not available!'],
  steve: [
    'Steve. We talked about this.',
    'Steve, buddy, is this about the sweater?',
    'Evening, Steve. Rough day?',
  ],
  steveDone: ['Somebody get that fellow a cocoa.', 'There, there, Steve. There, there.'],
});

export const FOE_LINES = Object.freeze({
  [ACTOR.PIPSQUEAK]: [
    'I call the big one!', 'My mom says I am fast!', 'Is it snack time yet?', 'Charge! Wait, what is charge?',
    'I am telling everybody!', 'My boots are on the wrong feet!', 'Nice bucket, mister!',
  ],
  [ACTOR.SLINGER]: [
    'Wind speed: mittens.', 'These goggles were very expensive.', 'Calculating. Carry the snow.',
    'I saw that in a documentary.', 'Do not make me adjust my strap.',
  ],
  [ACTOR.LOBBER]: [
    'Up she goes!', 'Walls are more of a suggestion.', 'Look up! No, the other up!', 'Special delivery!',
    'This one has a nice arc to it.',
  ],
  [ACTOR.BRUISER]: [
    'Excuse me. Coming through.', 'Sorry about your wall.', 'I am not big. I am layered.',
    'Is this your wall? It was nice.', 'My grandma knit this. Mind the sleeves.',
  ],
  [ACTOR.SLEDDER]: [
    'No brakes! NO BRAKES!', 'Steering is a myth!', 'This sled has opinions!', 'Wheeeeeee!', 'Which way is stop?',
  ],
  [ACTOR.LIDKID]: [
    'Can not hit this lid!', 'It still smells like banana.', 'Lid up! Lid up!',
    'My shield has seen things. Mostly coffee grounds.', 'Mind the lid. It is very dented.',
  ],
  [ACTOR.SNEAK]: [
    'Just borrowing it!', 'Nothing to see here!', 'Shhh. I am a snowdrift.', 'One carrot, two carrot...',
  ],
});

export const GIVE_UP_LINES = Object.freeze([
  'Okay, my toes are cold!', 'I have homework!', 'Mom is calling me!', 'Good game, good game!',
  'I surrender my snack!', 'I can not feel my nose!', 'Tell your Colonel he is pretty cool.',
  'I forgot my other mitten!', 'Same time tomorrow?',
]);

// A speech bubble lands better when it is rare, so the whole battlefield shares one
// cooldown and chatter never drowns out the Colonel.
const speech = new WeakMap();

function speechOf(g) {
  let state = speech.get(g);
  if (!state) {
    state = { quietUntil: 0 };
    speech.set(g, state);
  }
  return state;
}

export function say(g, who, lines, chance = 1, gap = 4) {
  const state = speechOf(g);
  if (g.time < state.quietUntil || g.rng() >= chance) return;
  shout(g, who, lines, gap);
}

// For lines that must land whatever else is being said, like the Colonel losing his nose.
export function shout(g, who, lines, gap = 4) {
  g.bark(who, lines[Math.floor(g.rng() * lines.length)]);
  speechOf(g).quietUntil = g.time + gap;
}

// ---- geometry -----------------------------------------------------------------

const sizeOf = (struct) => BUILD[struct.kind].size ?? 1;

export function structCentre(struct) {
  const half = sizeOf(struct) / 2;
  return { x: (struct.cx + half) * CELL, y: (struct.cy + half) * CELL };
}

// Gap from a point to the near face of a struct, 0 when inside it.
export function gapTo(x, y, struct) {
  const span = sizeOf(struct) * CELL;
  const left = struct.cx * CELL, top = struct.cy * CELL;
  const dx = Math.max(left - x, 0, x - (left + span));
  const dy = Math.max(top - y, 0, y - (top + span));
  return Math.hypot(dx, dy);
}

export function turnToward(from, to, maxStep) {
  const diff = angleGap(from, to);
  if (Math.abs(diff) <= maxStep) return to;
  return from + Math.sign(diff) * maxStep;
}

export function angleGap(from, to) {
  return Math.atan2(Math.sin(to - from), Math.cos(to - from));
}

export function nearestStruct(g, x, y, range, skipTeam = TEAM.FOES) {
  let best = null;
  let bestGap = range;
  for (const s of g.structs.values()) {
    if (s.team === skipTeam || !BUILD[s.kind].solid) continue;
    const gap = gapTo(x, y, s);
    if (gap <= bestGap) { best = s; bestGap = gap; }
  }
  return best;
}

// ---- memory and movement ------------------------------------------------------

function wake(g, foe, st, cd) {
  const ai = foe.ai;
  ai.awake = true;
  dressFoe(foe);
  ai.thinkAt = g.time + g.rng() * THINK_EVERY;
  ai.readyAt = g.time + g.rng() * cd;   // squads should not fire in lockstep
  ai.kid = null;
  ai.struct = null;
  ai.grudge = false;
  ai.sees = false;
  ai.bump = null;
  ai.pushX = 0;
  ai.pushY = 0;
  ai.anchorX = foe.x;
  ai.anchorY = foe.y;
  ai.anchorAt = g.time;
  ai.coats = new Map();
  say(g, foe, FOE_LINES[foe.kind], 0.12);
}

const NO_WAY = Object.freeze({ dx: 0, dy: 0, blocker: null });

function flowAt(g, foe) {
  const field = g.flow(TEAM.FOES);
  return field ? field.dirAt(foe.x, foe.y) : NO_WAY;
}

// Foes share one flow field, so without this a whole squad walks in a single file and
// reads as one blob. A soft shove apart keeps them looking like a crowd of kids.
function shuffleApart(g, foe) {
  const ai = foe.ai;
  if ((g.tick + foe.id) % CROWD_REFRESH_TICKS !== 0) return;
  let px = 0, py = 0;
  for (const other of g.foes()) {
    if (other === foe || other.flags & AFLAG.FLEEING) continue;
    const dx = foe.x - other.x, dy = foe.y - other.y;
    const reach = foe.r + other.r + 6;
    if (Math.abs(dx) > reach || Math.abs(dy) > reach) continue;
    const dist = Math.hypot(dx, dy);
    if (dist >= reach) continue;
    if (dist < 0.01) { px += foe.id % 2 ? 1 : -1; continue; }
    const weight = (reach - dist) / reach;
    px += (dx / dist) * weight;
    py += (dy / dist) * weight;
  }
  ai.pushX = px * CROWD_PUSH;
  ai.pushY = py * CROWD_PUSH;
}

// What is physically in the way: the flow field's opinion, or else the last wall this body
// actually pressed against. A body wider than a cell can touch walls the field never names.
function blockerAhead(g, foe, dir) {
  const ai = foe.ai;
  if (ai.bump && g.structs.get(ai.bump.id) !== ai.bump) ai.bump = null;
  return dir.blocker ?? ai.bump;
}

function walk(g, foe, ux, uy, speed, opts) {
  const ai = foe.ai;
  const step = speed * g.dt;
  let mx = ux + ai.pushX, my = uy + ai.pushY;
  const len = Math.hypot(mx, my);
  if (len > 1) { mx /= len; my /= len; }
  ai.bump = g.moveActor(foe, mx * step, my * step, opts) ?? null;
}

// Kids who have stopped to throw still shuffle out of each other's way, so a squad at range
// fans out into a line instead of stacking on the spot where the first one stopped.
function jostle(g, foe, speed) {
  const { pushX, pushY } = foe.ai;
  if (pushX === 0 && pushY === 0) return;
  const step = speed * g.dt * 0.5;
  g.moveActor(foe, pushX * step, pushY * step);
}

// Hops the foe one cell along (dx,dy). The stuck rule exists precisely to bypass collision,
// so this and Steve's copy of the rule are the only places AI code writes a position directly.
export function hopCell(g, foe, dx, dy) {
  const { cx, cy } = g.cw.cellOf(foe.x, foe.y);
  foe.x = (cx + Math.round(dx) + 0.5) * CELL;
  foe.y = (cy + Math.round(dy) + 0.5) * CELL;
}

// `way` is where this foe is trying to go. A foe that was not walking this tick passes null.
function noteProgress(g, foe, way) {
  const ai = foe.ai;
  if (!way) {
    ai.anchorX = foe.x; ai.anchorY = foe.y; ai.anchorAt = g.time;
    return;
  }
  if (g.time - ai.anchorAt < STUCK_WINDOW) return;
  if (Math.hypot(foe.x - ai.anchorX, foe.y - ai.anchorY) < STUCK_DISTANCE) hopCell(g, foe, way.dx, way.dy);
  ai.anchorX = foe.x; ai.anchorY = foe.y; ai.anchorAt = g.time;
}

// ---- targeting ----------------------------------------------------------------

const targetable = (kid) => !(kid.flags & (AFLAG.FROZEN | AFLAG.GRACE | AFLAG.FLEEING));

function kidWhoHitMe(g, foe) {
  const id = foe.lastHitBy;
  if (!id || g.time - foe.lastHitAt > GRUDGE_TIME) return null;
  const kid = g.actors.get(id);
  return kid && kid.kind === ACTOR.KID && targetable(kid) ? kid : null;
}

// A coat is rolled for once per foe, so standing near one does not eventually fool everybody.
function coatThatFooledMe(g, foe) {
  const ai = foe.ai;
  const { aggroRange, aggroChance } = BUILD[STRUCT.DECOY];
  let best = null;
  let bestDist = aggroRange;
  for (const s of g.structs.values()) {
    if (s.kind !== STRUCT.DECOY) continue;
    const c = structCentre(s);
    const dist = Math.hypot(c.x - foe.x, c.y - foe.y);
    if (dist > aggroRange) continue;
    if (!ai.coats.has(s.id)) ai.coats.set(s.id, g.rng() < aggroChance);
    if (ai.coats.get(s.id) && dist <= bestDist) { best = s; bestDist = dist; }
  }
  return best;
}

function chooseTarget(g, foe, dir) {
  const ai = foe.ai;
  ai.kid = kidWhoHitMe(g, foe);
  ai.grudge = ai.kid !== null;
  ai.struct = null;
  if (!ai.kid) ai.kid = g.nearestEnemy(foe, NOTICE_RANGE);
  if (!ai.kid) ai.struct = coatThatFooledMe(g, foe) ?? dir.blocker ?? g.colonel(TEAM.A);
}

function targetStillGood(g, foe) {
  const ai = foe.ai;
  if (ai.kid) return g.actors.get(ai.kid.id) === ai.kid && targetable(ai.kid);
  if (ai.struct) return g.structs.get(ai.struct.id) === ai.struct;
  return false;
}

function refreshTarget(g, foe, dir) {
  const ai = foe.ai;
  if (g.time >= ai.thinkAt || !targetStillGood(g, foe)) {
    ai.thinkAt = g.time + THINK_EVERY;
    chooseTarget(g, foe, dir);
    const point = aimPoint(foe);
    ai.sees = point !== null && g.los(foe.x, foe.y, point.x, point.y);
  }
}

function aimPoint(foe) {
  const ai = foe.ai;
  if (ai.kid) return ai.kid;
  if (ai.struct) return structCentre(ai.struct);
  return null;
}

// ---- attacks ------------------------------------------------------------------

function throwAt(g, foe, x, y, view, baseAngle) {
  const dist = Math.hypot(x - foe.x, y - foe.y);
  const flight = Math.min(view.range + 60, dist + 40) / view.ballSpeed;
  const angle = baseAngle + (g.rng() * 2 - 1) * view.spread;
  g.throwFlat(foe, angle, { speed: view.ballSpeed, flight, dmg: view.dmg, kind: BALL.QUICK, seq: 0 });
  foe.ai.readyAt = g.time + view.cd;
}

function ledPoint(foe, kid, view) {
  if (!view.lead) return kid;
  const flightTime = Math.hypot(kid.x - foe.x, kid.y - foe.y) / view.ballSpeed;
  return { x: kid.x + kid.vx * flightTime * view.lead, y: kid.y + kid.vy * flightTime * view.lead };
}

function throwerView(foe, st) {
  const style = THROWERS[foe.kind];
  if (foe.kind === ACTOR.SLEDDER) {
    return {
      ...style, range: st.footRange, speed: st.footSpeed, cd: st.footCd, ballSpeed: st.ballSpeed,
      dmg: st.footDmg * (foe.dmg / st.dmg),
    };
  }
  return { ...style, range: st.range, speed: foe.speed, cd: foe.cd, ballSpeed: st.ballSpeed, dmg: foe.dmg, turnRate: st.turnRate };
}

function updateThrower(g, foe, st) {
  const ai = foe.ai;
  ai.view ??= throwerView(foe, st);
  const { view } = ai;
  const dir = flowAt(g, foe);
  const blocker = blockerAhead(g, foe, dir);
  refreshTarget(g, foe, dir);

  const point = aimPoint(foe);
  const dist = point ? Math.hypot(point.x - foe.x, point.y - foe.y) : Infinity;
  const reach = view.range + (ai.struct ? sizeOf(ai.struct) * CELL * 0.5 : 0);
  const shooting = point !== null && dist <= reach && ai.sees;

  // Lobs and splash ignore the lid, and it only covers the front, so the Lid Kid's whole
  // character is that slow turn: circle inside 200 units and it can not keep up.
  let lookAt = point ?? { x: foe.x + dir.dx, y: foe.y + dir.dy };
  if (!shooting && blocker) lookAt = structCentre(blocker);
  const wantAngle = Math.atan2(lookAt.y - foe.y, lookAt.x - foe.x);
  foe.aim = view.turnRate ? turnToward(foe.aim, wantAngle, view.turnRate * g.dt) : wantAngle;
  if (foe.kind === ACTOR.LIDKID) foe.flags |= AFLAG.SHIELDED;

  const ready = g.time >= ai.readyAt && (!view.turnRate || Math.abs(angleGap(foe.aim, wantAngle)) <= LID_THROW_ARC);

  let way = null;
  if (shooting) {
    if (view.shy) keepDistance(g, foe, view.shy, view.speed);
    jostle(g, foe, view.speed);
    if (ready) {
      const shotAt = ai.kid ? ledPoint(foe, ai.kid, view) : point;
      const base = view.turnRate ? foe.aim : Math.atan2(shotAt.y - foe.y, shotAt.x - foe.x);
      throwAt(g, foe, shotAt.x, shotAt.y, view, base);
    }
  } else if (blocker) {
    if (ready) {
      const c = structCentre(blocker);
      throwAt(g, foe, c.x, c.y, view, view.turnRate ? foe.aim : wantAngle);
    }
  } else {
    way = dir;
    if (ai.kid && ai.grudge) {
      walk(g, foe, Math.cos(wantAngle), Math.sin(wantAngle), view.speed);
    } else {
      walk(g, foe, dir.dx, dir.dy, view.speed);
    }
  }
  noteProgress(g, foe, way);
}

function keepDistance(g, foe, shy, speed) {
  const near = g.nearestEnemy(foe, shy);
  if (!near) return;
  const dist = Math.hypot(foe.x - near.x, foe.y - near.y) || 1;
  walk(g, foe, (foe.x - near.x) / dist, (foe.y - near.y) / dist, speed * 0.7);
}

// ---- Lobber -------------------------------------------------------------------

// A lob lands exactly where it was aimed, so a cluster's centre is worth more than any one
// kid. Returns the middle of the best group of two or more, or null.
function clusterInRange(g, foe, range) {
  let best = null;
  let bestCount = 1;
  const kids = [];
  for (const kid of g.kids()) {
    if (targetable(kid) && Math.hypot(kid.x - foe.x, kid.y - foe.y) <= range) kids.push(kid);
  }
  for (const a of kids) {
    let sx = 0, sy = 0, count = 0;
    for (const b of kids) {
      if (Math.hypot(a.x - b.x, a.y - b.y) > LOBBER_CLUSTER_RADIUS) continue;
      sx += b.x; sy += b.y; count += 1;
    }
    if (count > bestCount) { bestCount = count; best = { x: sx / count, y: sy / count }; }
  }
  return best;
}

function chooseLobSpot(g, foe, st, dir) {
  const ai = foe.ai;
  const range = st.range;
  const within = (p) => Math.hypot(p.x - foe.x, p.y - foe.y) <= range;

  ai.kid = kidWhoHitMe(g, foe);
  if (ai.kid && within(ai.kid)) return null;
  const cluster = clusterInRange(g, foe, range);
  if (cluster) { ai.kid = null; return cluster; }
  ai.kid = g.nearestEnemy(foe, NOTICE_RANGE);
  if (ai.kid) return null;

  const coat = coatThatFooledMe(g, foe);
  if (coat) return structCentre(coat);
  if (dir.blocker) return structCentre(dir.blocker);
  const near = nearestStruct(g, foe.x, foe.y, range);
  if (near) return structCentre(near);
  const colonel = g.colonel(TEAM.A);
  if (colonel) {
    const c = structCentre(colonel);
    if (within(c)) return c;
  }
  return null;
}

function updateLobber(g, foe, st) {
  const ai = foe.ai;
  const dir = flowAt(g, foe);
  if (g.time >= ai.thinkAt || (ai.kid && !targetStillGood(g, foe))) {
    ai.thinkAt = g.time + THINK_EVERY;
    ai.spot = chooseLobSpot(g, foe, st, dir);
  }

  let spot = ai.spot;
  if (ai.kid) {
    const flight = THROW.lob.minFlight + Math.hypot(ai.kid.x - foe.x, ai.kid.y - foe.y) * THROW.lob.flightPerUnit;
    spot = { x: ai.kid.x + ai.kid.vx * flight * LOBBER_LEAD, y: ai.kid.y + ai.kid.vy * flight * LOBBER_LEAD };
  }

  if (spot) {
    foe.aim = Math.atan2(spot.y - foe.y, spot.x - foe.x);
    keepDistance(g, foe, LOBBER_SHY, foe.speed);
    if (g.time >= ai.readyAt) {
      g.throwLob(foe, spot.x, spot.y, { dmg: foe.dmg, splash: st.splash, kind: BALL.LOB, seq: 0 });
      ai.readyAt = g.time + foe.cd;
    }
    noteProgress(g, foe, null);
  } else {
    foe.aim = Math.atan2(dir.dy, dir.dx);
    walk(g, foe, dir.dx, dir.dy, foe.speed);
    noteProgress(g, foe, dir);
  }
}

// ---- Big Kid ------------------------------------------------------------------

function shoveStruct(g, foe, struct) {
  const c = structCentre(struct);
  foe.aim = Math.atan2(c.y - foe.y, c.x - foe.x);
  if (g.time < foe.ai.readyAt) return;
  g.emit({ e: EV.THROW, id: foe.id, lob: false });
  g.damageStruct(struct, foe.dmg, foe);
  foe.ai.readyAt = g.time + foe.cd;
}

function shoveKid(g, foe, kid) {
  const dist = Math.hypot(kid.x - foe.x, kid.y - foe.y) || 1;
  const ux = (kid.x - foe.x) / dist, uy = (kid.y - foe.y) / dist;
  foe.aim = Math.atan2(uy, ux);
  if (g.time < foe.ai.readyAt) return;
  const shove = KID.knockback * 2.5;
  g.emit({ e: EV.THROW, id: foe.id, lob: false });
  g.damageActor(kid, foe.dmg, foe, { kx: ux * shove, ky: uy * shove, kind: -1 });
  foe.ai.readyAt = g.time + foe.cd;
}

function updateBigKid(g, foe, st) {
  const ai = foe.ai;
  const dir = flowAt(g, foe);
  const blocker = blockerAhead(g, foe, dir);

  if (g.time >= ai.thinkAt || (ai.struct && !targetStillGood(g, foe))) {
    ai.thinkAt = g.time + THINK_EVERY;
    ai.struct = coatThatFooledMe(g, foe);
  }

  const kid = g.nearestEnemy(foe, st.range);
  const colonel = g.colonel(TEAM.A);
  let way = null;
  if (kid) {
    shoveKid(g, foe, kid);
  } else if (blocker) {
    shoveStruct(g, foe, blocker);
  } else if (ai.struct) {
    if (gapTo(foe.x, foe.y, ai.struct) <= st.range) {
      shoveStruct(g, foe, ai.struct);
    } else {
      way = dir;
      const c = structCentre(ai.struct);
      const dist = Math.hypot(c.x - foe.x, c.y - foe.y) || 1;
      foe.aim = Math.atan2(c.y - foe.y, c.x - foe.x);
      walk(g, foe, (c.x - foe.x) / dist, (c.y - foe.y) / dist, foe.speed);
    }
  } else if (colonel && gapTo(foe.x, foe.y, colonel) <= st.range) {
    shoveStruct(g, foe, colonel);
  } else {
    way = dir;
    foe.aim = Math.atan2(dir.dy, dir.dx);
    walk(g, foe, dir.dx, dir.dy, foe.speed);
  }
  noteProgress(g, foe, way);
}

// ---- Sledder ------------------------------------------------------------------

// How far a sled can run from (x,y) toward (tx,ty) before meeting scenery. Built walls do
// not count: a sledder has no idea they are there, which is the fun of walls.
function runway(g, x, y, tx, ty, r) {
  const dist = Math.hypot(tx - x, ty - y);
  const steps = Math.ceil(dist / (CELL / 2));
  const sideX = (-(ty - y) / dist) * r, sideY = ((tx - x) / dist) * r;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const px = x + (tx - x) * t, py = y + (ty - y) * t;
    for (const side of [0, 1, -1]) {
      const { cx, cy } = g.cw.cellOf(px + sideX * side, py + sideY * side);
      if (g.cw.isObstacleCell(cx, cy)) return (dist * (i - 1)) / steps;
    }
  }
  return dist;
}

function chooseLane(g, foe) {
  const ai = foe.ai;
  const colonel = g.colonel(TEAM.A);
  const goal = colonel ? structCentre(colonel) : { x: g.map.w / 2, y: g.map.h / 2 };
  const dx = goal.x - foe.x, dy = goal.y - foe.y;
  const dist = Math.hypot(dx, dy) || 1;
  const nx = -dy / dist, ny = dx / dist;

  // Straight at the Colonel if the street allows it, otherwise fan out and take the
  // longest run. A little jitter so a brigade spreads over the lane instead of tailgating.
  const jitter = (g.rng() * 2 - 1) * 30;
  let bestX = goal.x, bestY = goal.y, bestRun = -1;
  for (const offset of [0, 80, -80, 160, -160, 240, -240, 320, -320]) {
    const tx = goal.x + nx * (offset + jitter), ty = goal.y + ny * (offset + jitter);
    const run = runway(g, foe.x, foe.y, tx, ty, foe.r) / Math.hypot(tx - foe.x, ty - foe.y);
    if (run > bestRun + 0.02) { bestRun = run; bestX = tx; bestY = ty; }
  }
  ai.laneAngle = Math.atan2(bestY - foe.y, bestX - foe.x);
  ai.hitKids = new Set();
}

function crashSled(g, foe, st, struct) {
  foe.flags &= ~AFLAG.SLEDDING;
  if (struct) g.damageStruct(struct, foe.dmg, foe);
  g.sfx(SFX.SLED_CRASH, foe.x, foe.y);
  foe.ai.readyAt = g.time + st.footCd;
  say(g, foe, ['Ow! Worth it!', 'I meant to do that.', 'Who put that there?'], 0.4);
}

function updateSled(g, foe, st) {
  const ai = foe.ai;
  if (ai.laneAngle === undefined) chooseLane(g, foe);
  const ux = Math.cos(ai.laneAngle), uy = Math.sin(ai.laneAngle);
  const step = foe.speed * g.dt;
  const px = foe.x, py = foe.y;
  foe.aim = ai.laneAngle;
  const struct = g.moveActor(foe, ux * step, uy * step);

  const scale = foe.dmg / st.dmg;
  for (const kid of g.kids()) {
    if (ai.hitKids.has(kid.id) || !targetable(kid) || kid.team === foe.team) continue;
    if (Math.hypot(kid.x - foe.x, kid.y - foe.y) > foe.r + KID.radius) continue;
    ai.hitKids.add(kid.id);
    g.damageActor(kid, st.kidDmg * scale, foe, { kx: ux * KID.knockback * 2, ky: uy * KID.knockback * 2, kind: -1, stun: st.kidStun });
  }

  if (struct) crashSled(g, foe, st, struct);
  else if (Math.hypot(foe.x - px, foe.y - py) < step * SLED_CRASH_FRACTION) crashSled(g, foe, st, null);
}

// ---- Carrot Thief -------------------------------------------------------------

// One breadth-first pass over the static scenery, from every open border cell inward.
// Thieves need it because "the nearest edge" on Maple Court is usually behind a house.
const exitFields = new WeakMap();

function exitField(g) {
  let field = exitFields.get(g);
  if (field) return field;
  const cols = Math.ceil(g.map.w / CELL), rows = Math.ceil(g.map.h / CELL);
  const next = new Int32Array(cols * rows).fill(-1);
  const queue = [];
  const open = (cx, cy) => cx >= 0 && cy >= 0 && cx < cols && cy < rows && !g.cw.isObstacleCell(cx, cy);
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      if ((cx === 0 || cy === 0 || cx === cols - 1 || cy === rows - 1) && open(cx, cy)) {
        next[cy * cols + cx] = cy * cols + cx;
        queue.push(cy * cols + cx);
      }
    }
  }
  const steps = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
  for (let head = 0; head < queue.length; head++) {
    const here = queue[head];
    const hx = here % cols, hy = (here - hx) / cols;
    for (const [sx, sy] of steps) {
      const cx = hx + sx, cy = hy + sy;
      if (!open(cx, cy) || next[cy * cols + cx] !== -1) continue;
      if (sx && sy && !(open(hx + sx, hy) && open(hx, hy + sy))) continue;
      next[cy * cols + cx] = here;
      queue.push(cy * cols + cx);
    }
  }
  field = { cols, rows, next };
  exitFields.set(g, field);
  return field;
}

function dirToEdge(g, foe) {
  const { cols, rows, next } = exitField(g);
  const cx = Math.min(cols - 1, Math.max(0, Math.floor(foe.x / CELL)));
  const cy = Math.min(rows - 1, Math.max(0, Math.floor(foe.y / CELL)));
  const here = cy * cols + cx;
  const to = next[here];
  // Already on the rim: head straight out over the nearest border.
  if (to === here || to === -1) {
    const left = foe.x, right = g.map.w - foe.x, top = foe.y, bottom = g.map.h - foe.y;
    const least = Math.min(left, right, top, bottom);
    if (least === left) return { dx: -1, dy: 0 };
    if (least === right) return { dx: 1, dy: 0 };
    return least === top ? { dx: 0, dy: -1 } : { dx: 0, dy: 1 };
  }
  const tx = ((to % cols) + 0.5) * CELL, ty = (Math.floor(to / cols) + 0.5) * CELL;
  const dist = Math.hypot(tx - foe.x, ty - foe.y) || 1;
  return { dx: (tx - foe.x) / dist, dy: (ty - foe.y) / dist };
}

export function atMapEdge(g, actor, margin = 4) {
  const pad = actor.r + margin;
  return actor.x <= pad || actor.y <= pad || actor.x >= g.map.w - pad || actor.y >= g.map.h - pad;
}

function updateThief(g, foe, st) {
  const colonel = g.colonel(TEAM.A);
  if (foe.aux & AUX.NOSE) {
    const dir = dirToEdge(g, foe);
    foe.aim = Math.atan2(dir.dy, dir.dx);
    walk(g, foe, dir.dx, dir.dy, foe.speed, { vault: true });
    noteProgress(g, foe, dir);
    if (atMapEdge(g, foe)) {
      if (colonel) {
        g.damageStruct(colonel, (st.stealPct * colonel.maxHp) / Math.max(1, g.countMul), foe);
        shout(g, colonel, COLONEL_LINES.noseLost);
      }
      g.despawn(foe);
    }
    return;
  }

  if (!colonel) return;
  if (gapTo(foe.x, foe.y, colonel) <= st.range) {
    foe.aux |= AUX.NOSE;
    g.sfx(SFX.NOSE_GRAB, foe.x, foe.y);
    shout(g, colonel, COLONEL_LINES.noseGrabbed);
    return;
  }
  let dir = flowAt(g, foe);
  if (dir.dx === 0 && dir.dy === 0) {
    const c = structCentre(colonel);
    const dist = Math.hypot(c.x - foe.x, c.y - foe.y) || 1;
    dir = { dx: (c.x - foe.x) / dist, dy: (c.y - foe.y) / dist };
  }
  foe.aim = Math.atan2(dir.dy, dir.dx);
  walk(g, foe, dir.dx, dir.dy, foe.speed, { vault: true });
  noteProgress(g, foe, dir);
}

// ---- entry points -------------------------------------------------------------

// Flags that should already be right while a fresh foe waits out its spawn GRACE, because
// the AI is not called until that ends and a sledder must not pop onto its sled.
export function dressFoe(foe) {
  if (foe.kind === ACTOR.SLEDDER) foe.flags |= AFLAG.SLEDDING;
  if (foe.kind === ACTOR.LIDKID) foe.flags |= AFLAG.SHIELDED;
}

export function updateFoe(g, foe) {
  const st = FOES[foe.kind];
  if (!foe.ai.awake) wake(g, foe, st, foe.kind === ACTOR.SLEDDER ? st.footCd : foe.cd);
  shuffleApart(g, foe);

  switch (foe.kind) {
    case ACTOR.LOBBER:
      updateLobber(g, foe, st);
      break;
    case ACTOR.BRUISER:
      updateBigKid(g, foe, st);
      break;
    case ACTOR.SNEAK:
      updateThief(g, foe, st);
      break;
    case ACTOR.SLEDDER:
      if (foe.flags & AFLAG.SLEDDING) updateSled(g, foe, st);
      else updateThrower(g, foe, st);
      break;
    default:
      updateThrower(g, foe, st);
  }
}
