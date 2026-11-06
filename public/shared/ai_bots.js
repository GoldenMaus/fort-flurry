// Fort Flurry — bot kids (SPEC sections 3 and 7).
// A bot plays through the same input frames a human sends, so it can never do anything a
// person could not. Siege bots are buddies: helpful, a bit better than a beginner. Rival bots
// in Face-Off and Free-for-All aim loosely and react late on purpose, because the job of a
// PvP bot is to lose to a new player in a way that feels earned.
import { ACTOR, AFLAG, AUX, BALL, BTN, CMD, DIFFICULTY, EMOTES, MODE, PHASE, PICKUP, STRUCT, TEAM } from './schema.js';
import { BUILD, CELL, FOES, KID, REPAIR_COST_MUL, SIM_HZ, THROW } from './constants.js';
import { angleGap, structCentre } from './ai_foes.js';

const UNSEEN = AFLAG.FLEEING | AFLAG.FROZEN | AFLAG.GRACE;
const VISION = 900;
const SIEGE_LEASH = 340;         // buddies stay near the fort unless chasing the Colonel's nose
const BACK_OFF_RANGE = 110;
const REPATH_EVERY = 0.4;
const LOOKAHEAD_CELLS = 10;
const STUCK_CHECK_EVERY = 1;
const STUCK_MOVED_UNDER = 10;
const WIGGLE_TIME = 0.45;
const PICKUP_REACH = 340;
const THAW_REACH_SIEGE = 700;
const THAW_REACH_PVP = 300;
const REPAIR_SHARE = 0.25;       // SPEC: bots beside humans spend at most this share per phase
const REPAIR_BELOW = 0.7;
const BUILD_PACE = 0.3;
const BUILD_RETRY_AFTER = 1.5;
const LATE_FLINGER_AFTER = 100;
const SHIELD_HALF_ARC = FOES[ACTOR.LIDKID].shieldArc / 2;
const EMOTE_HELP = EMOTES.indexOf('Help!');
const EMOTE_THANKS = EMOTES.indexOf('Thanks!');

// `rest` is how often a strafing kid pauses, and a paused kid is a fair target. `structPause`
// scales the gap between shots at buildings. `fort` is what a bots-only team puts up, where
// `lateFlingers` of the flingers wait until well into the fight. `marchAfter` is how long
// raiders hold back once a fight starts, and a `homebody` raider runs back to defend.
const BUDDY = Object.freeze({
  think: 0.25, react: 0.25, aimError: 0.07, lead: 0.8, shotGap: 0.6, shotJitter: 0.35,
  dodge: 0.5, slide: 0.4, lowBalls: 2, packTo: 7, engage: 270, bailAt: 0, rest: 0.2,
  structPause: 0.6, fort: { flingers: 2, lateFlingers: 0, walls: 14 }, marchAfter: 0,
});

// Rivals are tuned against a scripted first-time player (see the world test). That player wins
// most duels on Cozy and Normal, gets close Face-Off rounds, and has to work hard on Blizzard.
const RIVALS = Object.freeze({
  [DIFFICULTY.COZY]: {
    think: 0.5, react: 0.9, aimError: 0.2, lead: 0.35, shotGap: 1.9, shotJitter: 1, dodge: 0.05, slide: 0, lowBalls: 2, packTo: 6,
    engage: 300, bailAt: 0.35, rest: 0.7, structPause: 2, fort: { flingers: 2, lateFlingers: 1, walls: 6 }, marchAfter: 45, homebody: true,
  },
  [DIFFICULTY.NORMAL]: {
    think: 0.4, react: 0.7, aimError: 0.17, lead: 0.45, shotGap: 1.55, shotJitter: 0.8, dodge: 0.1, slide: 0.1, lowBalls: 2, packTo: 6,
    engage: 290, bailAt: 0.3, rest: 0.6, structPause: 2, fort: { flingers: 2, lateFlingers: 1, walls: 8 }, marchAfter: 35, homebody: true,
  },
  [DIFFICULTY.BLIZZARD]: {
    think: 0.33, react: 0.5, aimError: 0.13, lead: 0.62, shotGap: 1.15, shotJitter: 0.6, dodge: 0.25, slide: 0.2, lowBalls: 2, packTo: 7,
    engage: 280, bailAt: 0.25, rest: 0.4, structPause: 0.9, fort: { flingers: 2, lateFlingers: 0, walls: 14 }, marchAfter: 10,
  },
});

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const isStruct = (t) => t.cx !== undefined;
const pointOf = (t) => (isStruct(t) ? structCentre(t) : t);

function stillThere(g, t) {
  if (isStruct(t)) return g.structs.get(t.id) === t;
  return g.actors.get(t.id) === t && !(t.flags & UNSEEN);
}

function hostiles(g, kid) {
  const list = [];
  for (const a of g.actors.values()) {
    if (a.team !== kid.team && !(a.flags & UNSEEN)) list.push(a);
  }
  return list;
}

function nearestOf(list, x, y) {
  let best = null;
  let bestDist = Infinity;
  for (const a of list) {
    const d = Math.hypot(a.x - x, a.y - y);
    if (d < bestDist) { bestDist = d; best = a; }
  }
  return { actor: best, dist: bestDist };
}

// ---- walking ------------------------------------------------------------------

const grids = new WeakMap();

function gridFor(g) {
  let grid = grids.get(g);
  if (!grid) {
    const cols = Math.ceil(g.map.w / CELL), rows = Math.ceil(g.map.h / CELL);
    grid = { cols, rows, steps: new Int32Array(cols * rows), queue: new Int32Array(cols * rows) };
    grids.set(g, grid);
  }
  return grid;
}

// Whether a kid could walk straight from a to b. Cells are coarser than bodies, so this errs
// on the cautious side, and two side rays stop a shoulder clipping a corner.
function clearWalk(g, x0, y0, x1, y1) {
  const cw = g.cw;
  const dx = x1 - x0, dy = y1 - y0;
  const length = Math.hypot(dx, dy);
  if (length < 1) return true;
  const px = (-dy / length) * (KID.radius - 1), py = (dx / length) * (KID.radius - 1);
  const start = cw.cellOf(x0, y0);
  const steps = Math.ceil(length / 16);
  for (let i = 1; i <= steps; i++) {
    const x = x0 + (dx * i) / steps, y = y0 + (dy * i) / steps;
    for (const side of [0, 1, -1]) {
      const { cx, cy } = cw.cellOf(x + px * side, y + py * side);
      if (cx === start.cx && cy === start.cy) continue;
      if (cw.isSolidCell(cx, cy)) return false;
    }
  }
  return true;
}

// Breadth-first from the goal until it touches the start, then steer for the farthest path
// cell in a straight clear line. Returns null when walls have sealed the goal off entirely.
function findWay(g, x0, y0, x1, y1) {
  if (clearWalk(g, x0, y0, x1, y1)) return { x: x1, y: y1 };
  const { cols, rows, steps, queue } = gridFor(g);
  const cw = g.cw;
  const cellIndex = (x, y) => {
    const { cx, cy } = cw.cellOf(x, y);
    return Math.min(rows - 1, Math.max(0, cy)) * cols + Math.min(cols - 1, Math.max(0, cx));
  };
  const start = cellIndex(x0, y0), goal = cellIndex(x1, y1);
  const open = (cx, cy) => cx >= 0 && cy >= 0 && cx < cols && cy < rows
    && (cy * cols + cx === start || !cw.isSolidCell(cx, cy));

  steps.fill(-1);
  steps[goal] = 0;
  queue[0] = goal;
  let tail = 1;
  for (let head = 0; head < tail && steps[start] < 0; head++) {
    const here = queue[head];
    const hx = here % cols, hy = (here - hx) / cols;
    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) {
        if (!ox && !oy) continue;
        const cx = hx + ox, cy = hy + oy;
        if (!open(cx, cy) || steps[cy * cols + cx] >= 0) continue;
        if (ox && oy && !(open(hx + ox, hy) && open(hx, hy + oy))) continue;
        steps[cy * cols + cx] = steps[here] + 1;
        queue[tail++] = cy * cols + cx;
      }
    }
  }
  if (steps[start] < 0) return null;

  let here = start;
  let way = null;
  for (let walked = 0; walked < LOOKAHEAD_CELLS && here !== goal; walked++) {
    const hx = here % cols, hy = (here - hx) / cols;
    let next = -1;
    let nextSteps = steps[here];
    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) {
        const cx = hx + ox, cy = hy + oy;
        if (cx < 0 || cy < 0 || cx >= cols || cy >= rows) continue;
        const i = cy * cols + cx;
        if (steps[i] < 0 || steps[i] >= nextSteps) continue;
        if (ox && oy && !(open(hx + ox, hy) && open(hx, hy + oy))) continue;
        next = i;
        nextSteps = steps[i];
      }
    }
    if (next < 0) break;
    here = next;
    const wx = ((here % cols) + 0.5) * CELL, wy = (Math.floor(here / cols) + 0.5) * CELL;
    if (way === null || clearWalk(g, x0, y0, wx, wy)) way = { x: wx, y: wy };
    else break;
  }
  return way;
}

function steerFor(g, kid, f, x, y) {
  const d = Math.hypot(x - kid.x, y - kid.y) || 1;
  let ux = (x - kid.x) / d, uy = (y - kid.y) / d;
  if (g.cw.isIce(kid.x, kid.y)) {
    // Thrust is weak on ice, so aim the thrust at the velocity error, not at the goal.
    // That cancels sideways drift instead of orbiting the target like a bad skater.
    const wantX = ux * KID.iceMaxSpeed - kid.vx, wantY = uy * KID.iceMaxSpeed - kid.vy;
    const want = Math.hypot(wantX, wantY) || 1;
    ux = wantX / want;
    uy = wantY / want;
  }
  f.mx = ux;
  f.my = uy;
}

function brake(g, kid, f) {
  const speed = Math.hypot(kid.vx, kid.vy);
  if (speed > 30 && g.cw.isIce(kid.x, kid.y)) {
    f.mx = -kid.vx / speed;
    f.my = -kid.vy / speed;
  }
}

function wiggleIfStuck(g, kid, ai, f) {
  if (g.time >= ai.stuckCheckAt) {
    const moved = Math.hypot(kid.x - ai.stuckX, kid.y - ai.stuckY);
    if (ai.walking && moved < STUCK_MOVED_UNDER) {
      ai.wiggleUntil = g.time + WIGGLE_TIME;
      ai.wiggleAngle = g.rng() * Math.PI * 2;
      ai.wayAt = 0;
    }
    ai.stuckX = kid.x; ai.stuckY = kid.y;
    ai.stuckCheckAt = g.time + STUCK_CHECK_EVERY;
  }
  if (g.time >= ai.wiggleUntil) return false;
  f.mx = Math.cos(ai.wiggleAngle);
  f.my = Math.sin(ai.wiggleAngle);
  return true;
}

// One step toward (x,y). Returns true once within `stop` of it.
function goTo(g, kid, ai, f, x, y, stop) {
  if (Math.hypot(x - kid.x, y - kid.y) <= stop) {
    ai.walking = false;
    brake(g, kid, f);
    return true;
  }
  ai.walking = true;
  if (wiggleIfStuck(g, kid, ai, f)) return false;
  if (g.time >= ai.wayAt || Math.hypot(ai.goalX - x, ai.goalY - y) > 48) {
    ai.wayAt = g.time + REPATH_EVERY;
    ai.goalX = x; ai.goalY = y;
    ai.way = findWay(g, kid.x, kid.y, x, y);
  }
  const way = ai.way ?? { x, y };
  steerFor(g, kid, f, way.x, way.y);
  return false;
}

function standableNear(g, x, y, avoidIce) {
  const cw = g.cw;
  const { cx, cy } = cw.cellOf(x, y);
  for (let ring = 0; ring <= 8; ring++) {
    for (let oy = -ring; oy <= ring; oy++) {
      for (let ox = -ring; ox <= ring; ox++) {
        if (Math.max(Math.abs(ox), Math.abs(oy)) !== ring) continue;
        const qx = cx + ox, qy = cy + oy;
        const wx = (qx + 0.5) * CELL, wy = (qy + 0.5) * CELL;
        if (cw.isSolidCell(qx, qy) || (avoidIce && cw.isIce(wx, wy))) continue;
        return { x: wx, y: wy };
      }
    }
  }
  return { x, y };
}

// ---- memory -------------------------------------------------------------------

function freshBrain(g, kid) {
  const ai = kid.ai;
  ai.bot = true;
  ai.skill = g.mode === MODE.SIEGE ? BUDDY : RIVALS[g.difficulty] ?? RIVALS[DIFFICULTY.NORMAL];
  ai.thinkAt = g.time + g.rng() * ai.skill.think;
  ai.target = null;
  ai.targetSince = 0;
  ai.sees = false;
  ai.task = null;
  ai.shot = null;
  ai.nextShotAt = g.time + g.rng();
  ai.packing = false;
  ai.walking = false;
  ai.wayAt = 0;
  ai.way = null;
  ai.goalX = kid.x; ai.goalY = kid.y;
  ai.stuckX = kid.x; ai.stuckY = kid.y;
  ai.stuckCheckAt = g.time + STUCK_CHECK_EVERY;
  ai.wiggleUntil = 0;
  ai.wiggleAngle = 0;
  ai.dodgeUntil = 0;
  ai.dodgeX = 0; ai.dodgeY = 0;
  ai.seenBalls = new Set();
  ai.strafe = kid.id % 2 ? 1 : -1;
  ai.strafeFlipAt = g.time + 1 + g.rng() * 2;
  ai.post = null;
  ai.phase = null;
  ai.wasFrozen = false;
  // A little personality: some kids wind up, some just throw.
  ai.windup = (kid.id * 7) % 3 === 0 ? 0.6 : 0;
  return ai;
}

// Per-team notes the bots share: repair spending and the build plan.
const books = new WeakMap();

function bookFor(g, team) {
  let teams = books.get(g);
  if (!teams) { teams = new Map(); books.set(g, teams); }
  let book = teams.get(team);
  if (!book) {
    book = { phase: null, spent: 0, plan: null, nextBuildAt: 0, hasHuman: false };
    teams.set(team, book);
  }
  if (book.phase !== g.phase) {
    book.phase = g.phase;
    book.spent = 0;
    book.phaseAt = g.time;
    book.hasHuman = false;
    for (const kid of g.kids()) if (kid.team === team && !kid.isBot) book.hasHuman = true;
    if (g.phase === PHASE.BUILD) book.plan = null;
  }
  return book;
}

function slotOf(g, kid) {
  let slot = 0;
  for (const other of g.kids()) {
    if (other.team === kid.team && other.isBot && other.id < kid.id) slot += 1;
  }
  return slot;
}

function friendAtHand(g, kid) {
  for (const friend of g.kids()) {
    if (friend !== kid && friend.team === kid.team && dist(friend, kid) <= KID.thawRange) return true;
  }
  return false;
}

// Shouts are what make a bot read as a kid. "Thanks!" only counts if someone is there to thank.
function noteFreeze(g, kid, ai) {
  const frozen = (kid.flags & AFLAG.FROZEN) !== 0;
  if (frozen && !ai.wasFrozen && g.rng() < 0.35) g.command(kid.id, { c: CMD.EMOTE, n: EMOTE_HELP });
  if (!frozen && ai.wasFrozen && friendAtHand(g, kid) && g.rng() < 0.6) g.command(kid.id, { c: CMD.EMOTE, n: EMOTE_THANKS });
  ai.wasFrozen = frozen;
}

// ---- spending -----------------------------------------------------------------

function repairCostOf(kind) {
  return Math.ceil(REPAIR_COST_MUL * BUILD[kind].cost);
}

// The most damaged thing this team can afford to fix, optionally only within `reach`.
function worstDamage(g, kid, book, reach) {
  const flakes = g.flakes[kid.team] ?? 0;
  const cap = book.hasHuman ? REPAIR_SHARE * (flakes + book.spent) - book.spent : Infinity;
  let worst = null;
  let worstHealth = REPAIR_BELOW;
  for (const s of g.structs.values()) {
    if (s.team !== kid.team || s.kind === STRUCT.COLONEL) continue;
    const health = s.hp / s.maxHp;
    if (health >= worstHealth) continue;
    const cost = repairCostOf(s.kind);
    if (cost > cap || cost > flakes) continue;
    if (dist(kid, structCentre(s)) > reach) continue;
    worst = s;
    worstHealth = health;
  }
  return worst;
}

function repairSomething(g, kid, book) {
  const job = worstDamage(g, kid, book, KID.buildRange * kid.mods.buildRangeMul);
  if (!job) return false;
  const flakes = g.flakes[kid.team] ?? 0;
  g.command(kid.id, { c: CMD.BUILD, k: job.kind, cx: job.cx, cy: job.cy });
  book.spent += Math.max(0, flakes - (g.flakes[kid.team] ?? 0));
  book.nextBuildAt = g.time + BUILD_PACE;
  return true;
}

// A bots-only team's fort: flingers first, then a ring of walls from the side facing the
// enemy backward. Corners and the rear stay open, or the bots would wall themselves in.
function ringPlan(g, colonel, enemy, fort) {
  const fromX = colonel.cx + 1, fromY = colonel.cy + 1;
  let towardX = g.map.w / 2 / CELL, towardY = g.map.h / 2 / CELL;
  if (enemy) { towardX = enemy.cx + 1; towardY = enemy.cy + 1; }
  const len = Math.hypot(towardX - fromX, towardY - fromY) || 1;
  const ux = (towardX - fromX) / len, uy = (towardY - fromY) / len;
  const inner = 2, outer = 3;
  const cells = [];
  for (let oy = -outer; oy <= outer + 1; oy++) {
    for (let ox = -outer; ox <= outer + 1; ox++) {
      const onRing = ox === -outer || ox === outer + 1 || oy === -outer || oy === outer + 1;
      if (!onRing) continue;
      const corner = (ox === -outer || ox === outer + 1) && (oy === -outer || oy === outer + 1);
      if (corner) continue;
      const facing = (ox - 0.5) * ux + (oy - 0.5) * uy;
      if (facing < -2.5) continue;
      cells.push({ k: STRUCT.WALL, cx: colonel.cx + ox, cy: colonel.cy + oy, facing, triedAt: -Infinity });
    }
  }
  cells.sort((a, b) => b.facing - a.facing);
  const sideX = -uy, sideY = ux;
  const flingers = [-1, 1].slice(0, fort.flingers).map((side) => ({
    k: STRUCT.PULT,
    cx: colonel.cx + Math.round(0.5 + ux * inner + sideX * side * inner),
    cy: colonel.cy + Math.round(0.5 + uy * inner + sideY * side * inner),
    facing: 0, triedAt: -Infinity,
  }));
  const free = (c) => !g.cw.isSolidCell(c.cx, c.cy);
  const open = flingers.filter(free);
  const late = open.splice(open.length - fort.lateFlingers, fort.lateFlingers).map((c) => ({ ...c, late: true }));
  return [...open, ...cells.filter(free).slice(0, fort.walls), ...late];
}

// Free-for-All has no Colonel. A personal budget of a few walls in front of the kid is cover
// enough, and leaving flingers out keeps bots from out-building someone on their first game.
function coverPlan(g, kid) {
  const towardX = g.map.w / 2 - kid.x, towardY = g.map.h / 2 - kid.y;
  const len = Math.hypot(towardX, towardY) || 1;
  const ux = towardX / len, uy = towardY / len;
  const { cx, cy } = g.cw.cellOf(kid.x + ux * CELL * 2.5, kid.y + uy * CELL * 2.5);
  const sideX = Math.round(-uy), sideY = Math.round(ux);
  return [-1, 0, 1]
    .map((i) => ({ k: STRUCT.WALL, cx: cx + sideX * i, cy: cy + sideY * i, facing: 0, triedAt: -Infinity }))
    .filter((c) => !g.cw.isSolidCell(c.cx, c.cy));
}

function buildFromPlan(g, kid, book) {
  if (!book.plan) {
    const colonel = g.colonel(kid.team);
    const rival = kid.team === TEAM.A ? g.colonel(TEAM.B) : g.colonel(TEAM.A);
    book.plan = colonel ? ringPlan(g, colonel, rival, kid.ai.skill.fort) : coverPlan(g, kid);
  }
  const reach = KID.buildRange * kid.mods.buildRangeMul;
  const flakes = g.flakes[kid.team] ?? 0;
  for (const item of book.plan) {
    if (g.structAt(item.cx, item.cy) || g.time - item.triedAt < BUILD_RETRY_AFTER) continue;
    if (item.late && !(g.phase === PHASE.FIGHT && g.time >= book.phaseAt + LATE_FLINGER_AFTER)) continue;
    if (BUILD[item.k].cost > flakes) continue;
    if (Math.hypot((item.cx + 0.5) * CELL - kid.x, (item.cy + 0.5) * CELL - kid.y) > reach) continue;
    item.triedAt = g.time;
    g.command(kid.id, { c: CMD.BUILD, k: item.k, cx: item.cx, cy: item.cy });
    book.nextBuildAt = g.time + BUILD_PACE;
    return true;
  }
  return false;
}

function spendFlakes(g, kid, book) {
  if (g.time < book.nextBuildAt) return;
  if (repairSomething(g, kid, book)) return;
  if (!book.hasHuman) buildFromPlan(g, kid, book);
}

// ---- BUILD --------------------------------------------------------------------

function fortOf(g, team) {
  const colonel = g.colonel(team);
  return colonel ? structCentre(colonel) : null;
}

// Where to wait out the countdown. Siege bots go to the side the next wave comes from, far
// enough out that they are never standing on the cell a human is trying to build on.
function choosePost(g, kid, ai) {
  const slot = slotOf(g, kid);
  const fort = fortOf(g, kid.team);
  if (!fort) return { x: kid.x, y: kid.y };
  let tx, ty;
  const rival = g.mode === MODE.FORTWARS ? fortOf(g, kid.team === TEAM.A ? TEAM.B : TEAM.A) : null;
  if (rival) {
    tx = rival.x; ty = rival.y;
  } else {
    const from = g.meta().next?.from ?? [];
    const entrances = g.map.entrances;
    const gate = entrances[from[slot % Math.max(1, from.length)] ?? slot % entrances.length];
    tx = gate.x; ty = gate.y;
  }
  const len = Math.hypot(tx - fort.x, ty - fort.y) || 1;
  const ux = (tx - fort.x) / len, uy = (ty - fort.y) / len;
  const side = (slot % 2 ? 1 : -1) * (40 + 48 * Math.floor(slot / 2));
  const out = g.mode === MODE.SIEGE ? 250 : 170;
  return standableNear(g, fort.x + ux * out - uy * side, fort.y + uy * out + ux * side, true);
}

function runBuild(g, kid, ai, book, f) {
  if (ai.phase !== g.phase) {
    ai.phase = g.phase;
    ai.post = choosePost(g, kid, ai);
    ai.shot = null;
    ai.target = null;
  }
  spendFlakes(g, kid, book);
  // Standing still is all packing takes, so arriving at the post tops the bot up for free.
  const job = worstDamage(g, kid, book, Infinity);
  if (job) {
    const c = structCentre(job);
    goTo(g, kid, ai, f, c.x, c.y, KID.buildRange * kid.mods.buildRangeMul * 0.8);
  } else {
    goTo(g, kid, ai, f, ai.post.x, ai.post.y, 10);
  }
  if (Math.hypot(f.mx, f.my) > 0.1) f.aim = Math.atan2(f.my, f.mx);
}

// ---- deciding what to do ------------------------------------------------------

function friendToThaw(g, kid, reach) {
  let best = null;
  let bestScore = reach;
  for (const friend of g.kids()) {
    if (friend === kid || friend.team !== kid.team || !(friend.flags & AFLAG.FROZEN)) continue;
    const d = dist(kid, friend);
    const score = friend.isBot ? d * 1.3 : d;
    if (score >= bestScore) continue;
    // One rescuer per friend; the rest of the crew keeps the foes busy.
    let closer = false;
    for (const other of g.kids()) {
      if (other === kid || !other.isBot || other.team !== kid.team || other.flags & AFLAG.FROZEN) continue;
      if (dist(other, friend) < d) { closer = true; break; }
    }
    if (closer) continue;
    best = friend;
    bestScore = score;
  }
  return best;
}

function pickupWorthGrabbing(g, kid) {
  let best = null;
  let bestDist = PICKUP_REACH;
  for (const p of g.pickups.values()) {
    const d = dist(kid, p);
    if (d >= bestDist) continue;
    if (p.kind === PICKUP.COCOA) {
      if (kid.hp > kid.maxHp * 0.7) continue;
    } else if (p.kind !== PICKUP.BOARD && kid.specialN > 1) {
      continue;
    }
    best = p;
    bestDist = d;
  }
  return best;
}

function wantsToPack(kid, ai, nearest) {
  const { lowBalls, packTo } = ai.skill;
  if (ai.packing) {
    if (kid.balls >= Math.min(packTo, kid.maxBalls) || nearest < 90) ai.packing = false;
  } else if (kid.balls === 0 ? nearest > 90 : kid.balls <= lowBalls && nearest > 180) {
    ai.packing = true;
  }
  return ai.packing;
}

function holdForPacking(g, kid) {
  if (!g.cw.isIce(kid.x, kid.y)) return { x: kid.x, y: kid.y, stop: 40 };
  const spot = standableNear(g, kid.x, kid.y, true);
  return { x: spot.x, y: spot.y, stop: 12 };
}

function engagePoint(g, kid, ai, target, leashAround) {
  const p = pointOf(target);
  const here = dist(kid, p);
  const { engage } = ai.skill;
  let x = kid.x, y = kid.y, stop = 40;
  if (here > engage + 40 || !ai.sees) {
    const ux = (kid.x - p.x) / (here || 1), uy = (kid.y - p.y) / (here || 1);
    x = p.x + ux * (ai.sees ? engage : engage * 0.55);
    y = p.y + uy * (ai.sees ? engage : engage * 0.55);
  } else if (here < BACK_OFF_RANGE) {
    const ux = (kid.x - p.x) / (here || 1), uy = (kid.y - p.y) / (here || 1);
    x = kid.x + ux * 90;
    y = kid.y + uy * 90;
  } else {
    // In range and in sight: drift from side to side, with the odd pause.
    const ux = (p.x - kid.x) / (here || 1), uy = (p.y - kid.y) / (here || 1);
    x = kid.x - uy * ai.strafe * 70;
    y = kid.y + ux * ai.strafe * 70;
    stop = 16;
  }
  if (leashAround) {
    const away = Math.hypot(x - leashAround.x, y - leashAround.y);
    if (away > SIEGE_LEASH) {
      x = leashAround.x + ((x - leashAround.x) / away) * SIEGE_LEASH;
      y = leashAround.y + ((y - leashAround.y) / away) * SIEGE_LEASH;
    }
  }
  return { x, y, stop };
}

function setTarget(g, kid, ai, target) {
  if (target !== ai.target) {
    ai.target = target;
    ai.targetSince = g.time;
  }
  if (!target) { ai.sees = false; return; }
  const p = pointOf(target);
  ai.sees = g.los(kid.x, kid.y, p.x, p.y);
}

function siegeThreatScore(a, kid, fort) {
  let score = dist(kid, a) * 0.6 + (fort ? dist(fort, a) * 0.4 : 0);
  if (a.kind === ACTOR.SNEAK) score -= a.aux & AUX.NOSE ? 800 : 350;
  if (a.flags & AFLAG.SLEDDING) score -= 120;
  if (FOES[a.kind]?.boss) score += 140;
  return score;
}

// Buddies guard the Colonel, but a human out on a limb pulls the guard line toward them.
function guardAnchor(g, kid, fort) {
  if (!fort) return null;
  let best = null;
  let bestDist = 300;
  for (const friend of g.kids()) {
    if (friend.isBot || friend.team !== kid.team || friend.flags & (AFLAG.FROZEN | AFLAG.AFK)) continue;
    const away = dist(friend, fort);
    if (away > bestDist) { best = friend; bestDist = away; }
  }
  return best ? { x: (fort.x + best.x) / 2, y: (fort.y + best.y) / 2 } : fort;
}

function planSiege(g, kid, ai, book) {
  const fort = fortOf(g, kid.team);
  const foes = hostiles(g, kid);
  const closest = nearestOf(foes, kid.x, kid.y);
  spendFlakes(g, kid, book);

  let target = null;
  let bestScore = Infinity;
  for (const a of foes) {
    if (dist(kid, a) > VISION) continue;
    const score = siegeThreatScore(a, kid, fort);
    if (score < bestScore) { bestScore = score; target = a; }
  }
  setTarget(g, kid, ai, target);

  const friend = friendToThaw(g, kid, THAW_REACH_SIEGE);
  if (friend && closest.dist > 70) return { x: friend.x, y: friend.y, stop: KID.thawRange - 10 };
  if (wantsToPack(kid, ai, closest.dist)) return holdForPacking(g, kid);

  const pickup = pickupWorthGrabbing(g, kid);
  if (pickup) return { x: pickup.x, y: pickup.y, stop: 6 };

  if (target) {
    const chasingNose = target.kind === ACTOR.SNEAK && (target.aux & AUX.NOSE) !== 0;
    return engagePoint(g, kid, ai, target, chasingNose ? null : guardAnchor(g, kid, fort));
  }
  // Quiet moment: wander back to the post rather than standing wherever the last foe fell.
  if (ai.post) return { x: ai.post.x, y: ai.post.y, stop: 30 };
  return { x: kid.x, y: kid.y, stop: 40 };
}

function rivalInFront(kid, enemies, reach) {
  const { actor, dist: d } = nearestOf(enemies, kid.x, kid.y);
  return d <= reach ? actor : null;
}

function bailOut(g, kid, ai, enemies, home) {
  if (ai.skill.bailAt <= 0 || kid.hp > kid.maxHp * ai.skill.bailAt) return null;
  const { actor, dist: d } = nearestOf(enemies, kid.x, kid.y);
  if (!actor || d > 260) return null;
  if (home) return { x: home.x, y: home.y, stop: 60 };
  return { x: kid.x + ((kid.x - actor.x) / (d || 1)) * 220, y: kid.y + ((kid.y - actor.y) / (d || 1)) * 220, stop: 20 };
}

// Go around whatever can be gone around, and break only what truly seals the way. The flow
// field alone prices walls as passable, so it would march a bot straight into its own ring.
function raidColonel(g, kid, ai, colonel) {
  const c = structCentre(colonel);
  if (dist(kid, c) <= ai.skill.engage + 40 && ai.sees) return engagePoint(g, kid, ai, colonel, null);
  const way = findWay(g, kid.x, kid.y, c.x, c.y);
  if (way) return { x: way.x, y: way.y, stop: 4 };
  const blocker = g.flow(kid.team)?.dirAt(kid.x, kid.y).blocker ?? null;
  if (blocker && blocker.team !== kid.team) {
    setTarget(g, kid, ai, blocker);
    return engagePoint(g, kid, ai, blocker, null);
  }
  return { flow: true };
}

function planFaceOff(g, kid, ai, book) {
  const home = fortOf(g, kid.team);
  const enemyColonel = g.colonel(kid.team === TEAM.A ? TEAM.B : TEAM.A);
  const enemies = hostiles(g, kid);
  const closest = nearestOf(enemies, kid.x, kid.y);
  const raider = slotOf(g, kid) % 2 === 0;
  spendFlakes(g, kid, book);

  // Anyone at the gates comes first, and anyone close enough to hit is next.
  const atHome = enemies.filter((e) => dist(e, home) < 340);
  const defending = atHome.length > 0 && (!raider || ai.skill.homebody || dist(kid, home) < 500);
  const target = defending ? nearestOf(atHome, kid.x, kid.y).actor : rivalInFront(kid, enemies, raider ? 300 : 430);
  setTarget(g, kid, ai, target ?? (raider && g.time >= ai.marchAt ? enemyColonel : null));

  const bail = bailOut(g, kid, ai, enemies, home);
  if (bail) return bail;
  const friend = friendToThaw(g, kid, THAW_REACH_PVP);
  if (friend && closest.dist > 150) return { x: friend.x, y: friend.y, stop: KID.thawRange - 10 };
  if (wantsToPack(kid, ai, closest.dist)) return holdForPacking(g, kid);
  const pickup = pickupWorthGrabbing(g, kid);
  if (pickup && closest.dist > 200) return { x: pickup.x, y: pickup.y, stop: 6 };
  if (target) return engagePoint(g, kid, ai, target, null);
  if (raider && g.time >= ai.marchAt) return raidColonel(g, kid, ai, enemyColonel);
  return { x: ai.post.x, y: ai.post.y, stop: 30 };
}

function planFfa(g, kid, ai, book) {
  const enemies = hostiles(g, kid);
  const closest = nearestOf(enemies, kid.x, kid.y);
  spendFlakes(g, kid, book);

  // Humans read as a little farther away than they are, and nobody piles onto a kid two
  // others are already after, so a new player is never the whole room's only target.
  let target = null;
  let bestScore = Infinity;
  for (const e of enemies) {
    let hunters = 0;
    for (const other of g.kids()) {
      if (other !== kid && other.isBot && other.ai.target === e) hunters += 1;
    }
    const score = dist(kid, e) + (e.isBot ? 0 : 90) + (hunters >= 2 ? 260 : 0);
    if (score < bestScore) { bestScore = score; target = e; }
  }
  setTarget(g, kid, ai, target);

  const bail = bailOut(g, kid, ai, enemies, null);
  if (bail) return bail;
  if (wantsToPack(kid, ai, closest.dist)) return holdForPacking(g, kid);
  const pickup = pickupWorthGrabbing(g, kid);
  if (pickup && closest.dist > 160) return { x: pickup.x, y: pickup.y, stop: 6 };
  if (target) return engagePoint(g, kid, ai, target, null);
  return { x: g.map.w / 2, y: g.map.h / 2, stop: 120 };
}

// ---- throwing -----------------------------------------------------------------

const lerp = (a, b, t) => a + (b - a) * t;

function throwReach(charge, mods) {
  const speed = lerp(THROW.quick.speed, THROW.power.speed, charge) * mods.throwSpeedMul;
  return speed * lerp(THROW.quick.flight, THROW.power.flight, charge);
}

function chargeFor(range, mods) {
  for (let c = 0; c <= 1; c += 0.1) {
    if (throwReach(c, mods) >= range) return c;
  }
  return 1;
}

function lidFacesMe(target, kid) {
  if (!(target.flags & AFLAG.SHIELDED)) return false;
  const toMe = Math.atan2(kid.y - target.y, kid.x - target.x);
  return Math.abs(angleGap(target.aim, toMe)) <= SHIELD_HALF_ARC;
}

function bunchedAround(g, kid, target) {
  let count = 0;
  for (const a of g.actors.values()) {
    if (a.team !== kid.team && !(a.flags & UNSEEN) && dist(a, target) <= THROW.lob.splash * kid.mods.lobSplashMul) count += 1;
  }
  return count;
}

function chooseShot(g, kid, ai, target) {
  const p = pointOf(target);
  const range = dist(kid, p);
  const { cost, maxRange } = THROW.lob;
  const lobbable = kid.balls >= cost && range <= maxRange * 0.97 && range >= 90;
  const struct = isStruct(target);
  const lidUp = !struct && lidFacesMe(target, kid);

  const bunch = !struct && ai.skill === BUDDY && kid.balls >= 5 && bunchedAround(g, kid, target) >= 3;
  if (lobbable && (lidUp || !ai.sees || bunch)) {
    return { lob: true, hold: 3 + Math.floor(g.rng() * 3), ticks: 0, cost };
  }
  if (lidUp || !ai.sees) return null;
  if (range > throwReach(1, kid.mods) * 0.97) return null;

  // Buildings and big bodies do not dodge, so they always get the full wind-up.
  let charge = chargeFor(range + 10, kid.mods);
  if (struct || (ai.skill === BUDDY && FOES[target.kind]?.hp >= 100)) charge = 1;
  else charge = Math.max(charge, ai.windup);
  const hold = Math.max(1, Math.ceil(charge * THROW.chargeTime * SIM_HZ) + 1);
  return { lob: false, hold, ticks: 0, cost: 1, charge };
}

function leadPoint(kid, target, seconds, skill) {
  if (isStruct(target)) return structCentre(target);
  return { x: target.x + target.vx * seconds * skill.lead, y: target.y + target.vy * seconds * skill.lead };
}

function runShot(g, kid, ai, f) {
  const target = ai.target;
  const live = target !== null && stillThere(g, target);

  if (ai.shot) {
    const shot = ai.shot;
    if (!live || kid.balls < shot.cost) {
      f.btn |= BTN.CANCEL;
      ai.shot = null;
      ai.nextShotAt = g.time + 0.2;
      return;
    }
    shot.ticks += 1;
    const p = pointOf(target);
    if (shot.lob) {
      const flight = THROW.lob.minFlight + dist(kid, p) * THROW.lob.flightPerUnit;
      const spot = leadPoint(kid, target, flight, ai.skill);
      f.tx = spot.x + shot.errX;
      f.ty = spot.y + shot.errY;
      f.aim = Math.atan2(f.ty - kid.y, f.tx - kid.x);
      if (shot.ticks < shot.hold) f.btn |= BTN.LOB;
    } else {
      const speed = lerp(THROW.quick.speed, THROW.power.speed, shot.charge) * kid.mods.throwSpeedMul;
      const spot = leadPoint(kid, target, dist(kid, p) / speed, ai.skill);
      f.aim = Math.atan2(spot.y - kid.y, spot.x - kid.x) + shot.err;
      f.tx = spot.x;
      f.ty = spot.y;
      if (shot.ticks < shot.hold) f.btn |= BTN.THROW;
    }
    if (shot.ticks >= shot.hold) {
      ai.shot = null;
      const pause = isStruct(target) ? ai.skill.structPause : 1;
      ai.nextShotAt = g.time + (ai.skill.shotGap + g.rng() * ai.skill.shotJitter) * pause;
    }
    return;
  }

  if (!live) return;
  const p = pointOf(target);
  f.aim = Math.atan2(p.y - kid.y, p.x - kid.x);
  f.tx = p.x;
  f.ty = p.y;
  if (g.time < ai.nextShotAt || (!isStruct(target) && g.time < ai.targetSince + ai.skill.react)) return;
  if (kid.throwCd > 0 || kid.balls <= 0 || ai.packing) return;

  const shot = chooseShot(g, kid, ai, target);
  if (!shot) return;
  shot.err = (g.rng() * 2 - 1) * ai.skill.aimError;
  const miss = dist(kid, p) * ai.skill.aimError * 0.5;
  shot.errX = (g.rng() * 2 - 1) * miss;
  shot.errY = (g.rng() * 2 - 1) * miss;
  ai.shot = shot;
  f.btn |= shot.lob ? BTN.LOB : BTN.THROW;
}

// ---- dodging ------------------------------------------------------------------

function senseIncoming(g, kid, ai) {
  if ((g.tick + kid.id) % 3 !== 0 || g.time < ai.dodgeUntil) return;
  for (const b of g.balls.values()) {
    if (b.team === kid.team || ai.seenBalls.has(b.id)) continue;
    let awayX = 0, awayY = 0;
    if (b.kind === BALL.LOB) {
      const d = Math.hypot(kid.x - b.lx, kid.y - b.ly);
      if (d > THROW.lob.splash + 16) continue;
      awayX = (kid.x - b.lx) / (d || 1);
      awayY = (kid.y - b.ly) / (d || 1);
    } else {
      const speed2 = b.vx * b.vx + b.vy * b.vy;
      if (speed2 < 1) continue;
      const rx = kid.x - b.x, ry = kid.y - b.y;
      const t = (rx * b.vx + ry * b.vy) / speed2;
      if (t < 0 || t > 0.55) continue;
      const missX = rx - b.vx * t, missY = ry - b.vy * t;
      const miss = Math.hypot(missX, missY);
      if (miss > KID.radius + (b.r ?? THROW.radius) + 10) continue;
      awayX = miss > 0.5 ? missX / miss : -b.vy / Math.sqrt(speed2);
      awayY = miss > 0.5 ? missY / miss : b.vx / Math.sqrt(speed2);
    }
    ai.seenBalls.add(b.id);
    if (ai.seenBalls.size > 40) ai.seenBalls.clear();
    if (g.rng() >= ai.skill.dodge) continue;
    ai.dodgeX = awayX;
    ai.dodgeY = awayY;
    ai.dodgeUntil = g.time + 0.3;
    if (kid.slideCd <= 0 && g.rng() < ai.skill.slide) ai.slideNow = true;
    return;
  }
}

// ---- the fight ----------------------------------------------------------------

function runFight(g, kid, ai, book, f) {
  if (ai.phase !== g.phase) {
    ai.phase = g.phase;
    ai.thinkAt = 0;
    ai.packing = false;
    ai.marchAt = g.time + ai.skill.marchAfter;
  }
  if (g.time >= ai.strafeFlipAt) {
    if (g.rng() < ai.skill.rest) {
      ai.strafe = 0;
    } else {
      ai.strafe = g.rng() < 0.5 ? 1 : -1;
    }
    ai.strafeFlipAt = g.time + 0.8 + g.rng() * 1.6;
  }
  if (g.time >= ai.thinkAt) {
    ai.thinkAt = g.time + ai.skill.think;
    if (g.mode === MODE.SIEGE) ai.task = planSiege(g, kid, ai, book);
    else if (g.mode === MODE.FORTWARS) ai.task = planFaceOff(g, kid, ai, book);
    else ai.task = planFfa(g, kid, ai, book);
  }

  const task = ai.task;
  if (task?.flow) {
    const dir = g.flow(kid.team)?.dirAt(kid.x, kid.y);
    if (dir) steerFor(g, kid, f, kid.x + dir.dx * CELL, kid.y + dir.dy * CELL);
  } else if (task) {
    goTo(g, kid, ai, f, task.x, task.y, task.stop);
  }
  senseIncoming(g, kid, ai);
  if (g.time < ai.dodgeUntil) {
    f.mx = ai.dodgeX;
    f.my = ai.dodgeY;
    if (ai.slideNow) {
      f.btn |= BTN.SLIDE;
      ai.slideNow = false;
    }
  }
  if (Math.hypot(f.mx, f.my) > 0.1) f.aim = Math.atan2(f.my, f.mx);
  runShot(g, kid, ai, f);
}

export function botFrame(g, kid) {
  const ai = kid.ai.bot ? kid.ai : freshBrain(g, kid);
  const f = { seq: 0, mx: 0, my: 0, aim: kid.aim, btn: 0, tx: kid.x, ty: kid.y };
  noteFreeze(g, kid, ai);
  if (kid.flags & (AFLAG.FROZEN | AFLAG.LOCKED)) {
    ai.shot = null;
    ai.task = null;
    ai.target = null;
    return f;
  }
  const book = bookFor(g, kid.team);
  if (g.phase === PHASE.BUILD) runBuild(g, kid, ai, book, f);
  else if (g.phase === PHASE.FIGHT) runFight(g, kid, ai, book, f);
  return f;
}
