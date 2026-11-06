// Fort Flurry — boss brains: The Sno-Cone Truck and Abominable Steve (SPEC section 5).
// Bosses keep their own timers in foe.ai and, unlike ordinary foes, are still called while
// FLEEING so each can make a proper exit.
import { ACTOR, AFLAG, AUX, BALL, EV, SFX, STRUCT, TEAM } from './schema.js';
import { BOSS, BUILD, CELL, FOES, KID } from './constants.js';
import { COLONEL_LINES, atMapEdge, gapTo, hopCell, nearestStruct, say, shout, structCentre, turnToward } from './ai_foes.js';

const ARRIVE_RADIUS = 14;
const EXIT_SPEED_MUL = 1.6;
const EXIT_GIVE_UP_AFTER = 14;   // scenery can never hold a defeated boss on the map for long
const TRUCK_BUMP_EVERY = 0.7;
const TRUCK_BUMP_MUL = 0.5;
const TURRET_TURN_RATE = 2.5;
const STEVE_SIT_TIME = 5;
const STUCK_WINDOW = 3;
const STUCK_DISTANCE = 12;

const STEVE_LINES = Object.freeze({
  arrive: ['Mmph. Monday.', 'Nobody asked me if I wanted snow.', 'I just came for the quiet.'],
  mutter: [
    'This sweater was a gift.', 'I had plans today.', 'Why is it always the big fellow?', 'Too loud. All of you.',
    'I had one job, and it was a nap.', 'My hat is too small and I know it.',
  ],
  enrage: ['OKAY. NOW I AM CROSS.', 'THAT WAS MY GOOD SIDE.', 'NO MORE MISTER PATIENT.'],
  defeated: ['Is that cocoa? ...Thanks.', 'Oh. Marshmallows. That is nice.', 'Okay. Okay, that is better.'],
});

function unit(dx, dy) {
  const len = Math.hypot(dx, dy) || 1;
  return { x: dx / len, y: dy / len };
}

function isStuck(g, foe) {
  const ai = foe.ai;
  if (g.time - ai.anchorAt < STUCK_WINDOW) return false;
  const moved = Math.hypot(foe.x - ai.anchorX, foe.y - ai.anchorY);
  ai.anchorX = foe.x; ai.anchorY = foe.y; ai.anchorAt = g.time;
  return moved < STUCK_DISTANCE;
}

function holdAnchor(g, foe) {
  const ai = foe.ai;
  ai.anchorX = foe.x; ai.anchorY = foe.y; ai.anchorAt = g.time;
}

// Whether a big body fits down a straight line. Measured against the real scenery shapes,
// because the cell grid rounds a parked car up to whole cells and would close good roads.
function roadClear(g, x0, y0, x1, y1, r) {
  const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / (CELL / 2)));
  for (const o of g.map.obstacles) {
    if (!o.blocksMove) continue;
    for (let i = 0; i <= steps; i++) {
      const x = x0 + ((x1 - x0) * i) / steps, y = y0 + ((y1 - y0) * i) / steps;
      const gap = o.shape === 'circle'
        ? Math.hypot(x - o.x, y - o.y) - o.r
        : Math.hypot(Math.max(o.x - x, 0, x - o.x - o.w), Math.max(o.y - y, 0, y - o.y - o.h));
      if (gap < r) return false;
    }
  }
  return true;
}

// ---- The Sno-Cone Truck -------------------------------------------------------

function nearestVertex(path, x, y) {
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < path.length; i++) {
    const dist = Math.hypot(path[i].x - x, path[i].y - y);
    if (dist < bestDist) { bestDist = dist; best = i; }
  }
  return best;
}

function wakeTruck(g, foe) {
  const ai = foe.ai;
  const { parkEvery } = BOSS.truck;
  ai.awake = true;
  ai.leg = nearestVertex(g.map.truckPath, foe.x, foe.y);
  ai.heading = 0;
  ai.parkAt = g.time + parkEvery;
  ai.parkUntil = 0;
  ai.readyAt = g.time + foe.cd;
  ai.bumped = new Map();
  holdAnchor(g, foe);
  g.sfx(SFX.TRUCK_HORN, foe.x, foe.y);
  const colonel = g.colonel(TEAM.A);
  if (colonel) shout(g, colonel, COLONEL_LINES.truck);
}

function turretTarget(g, foe) {
  const { range } = FOES[ACTOR.TRUCK];
  const kid = g.nearestEnemy(foe, range);
  if (kid) return kid;
  const struct = nearestStruct(g, foe.x, foe.y, range);
  return struct ? structCentre(struct) : null;
}

function workTurret(g, foe) {
  const point = turretTarget(g, foe);
  if (!point) return;
  const { coneSpread, ballSpeed } = BOSS.truck;
  const angle = Math.atan2(point.y - foe.y, point.x - foe.x);
  // The paper cone swings round to its target, so a volley is something you can see coming.
  foe.aim = turnToward(foe.aim, angle, TURRET_TURN_RATE * g.dt);
  if (g.time < foe.ai.readyAt) return;
  const flight = Math.min(FOES[ACTOR.TRUCK].range + 60, Math.hypot(point.x - foe.x, point.y - foe.y) + 40) / ballSpeed;
  foe.aim = angle;
  for (const spread of [-coneSpread, 0, coneSpread]) {
    g.throwFlat(foe, angle + spread, { speed: ballSpeed, flight, dmg: foe.dmg, kind: BALL.CONE, seq: 0 });
  }
  foe.ai.readyAt = g.time + foe.cd;
}

function openDoors(g, foe) {
  const ai = foe.ai;
  const { parkTime, parkDmgMul, doorSquad } = BOSS.truck;
  ai.parkUntil = g.time + parkTime;
  foe.aux |= AUX.DOORS;
  foe.takeDmgMul = parkDmgMul;
  g.sfx(SFX.TRUCK_DOORS, foe.x, foe.y);

  // They hop out of the rear doors, so the squad appears behind the direction of travel.
  const back = ai.heading + Math.PI;
  const count = Math.round(doorSquad * g.countMul);
  for (let i = 0; i < count; i++) {
    const fan = back + (i - (count - 1) / 2) * 0.5;
    const x = foe.x + Math.cos(fan) * (foe.r + 22);
    const y = foe.y + Math.sin(fan) * (foe.r + 22);
    const { cx, cy } = g.cw.cellOf(x, y);
    const open = !g.cw.isObstacleCell(cx, cy);
    g.spawnFoe(ACTOR.PIPSQUEAK, open ? x : foe.x, open ? y : foe.y, { noFlakes: true });
  }
}

function closeDoors(g, foe) {
  const ai = foe.ai;
  foe.aux &= ~AUX.DOORS;
  foe.takeDmgMul = 1;
  ai.parkAt = g.time + BOSS.truck.parkEvery;
  ai.parkUntil = 0;
  holdAnchor(g, foe);
}

// Nothing the kids build survives the Truck, except the Colonel, whom it is not paid to hit.
function crushAround(g, foe) {
  const reach = foe.r + 2;
  const { cx, cy } = g.cw.cellOf(foe.x, foe.y);
  const span = Math.ceil(reach / CELL);
  for (let oy = -span; oy <= span; oy++) {
    for (let ox = -span; ox <= span; ox++) {
      const s = g.structAt(cx + ox, cy + oy);
      if (!s || s.kind === STRUCT.COLONEL || !BUILD[s.kind].solid) continue;
      if (gapTo(foe.x, foe.y, s) <= reach) g.damageStruct(s, s.hp, foe);
    }
  }
}

// Kids do not collide with actors, so without a nudge a truck would drive straight through
// them. Getting clipped by a bumper should feel like it.
function bumpKids(g, foe, ux, uy) {
  const ai = foe.ai;
  for (const kid of g.kids()) {
    if (kid.flags & (AFLAG.FROZEN | AFLAG.GRACE)) continue;
    const dist = Math.hypot(kid.x - foe.x, kid.y - foe.y);
    if (dist > foe.r + KID.radius) continue;
    if (g.time < (ai.bumped.get(kid.id) ?? 0)) continue;
    ai.bumped.set(kid.id, g.time + TRUCK_BUMP_EVERY);
    const away = unit(kid.x - foe.x + ux, kid.y - foe.y + uy);
    g.damageActor(kid, foe.dmg * TRUCK_BUMP_MUL, foe, { kx: away.x * KID.knockback * 2, ky: away.y * KID.knockback * 2, kind: -1 });
  }
}

function driveToward(g, foe, x, y, speed) {
  const ai = foe.ai;
  const dir = unit(x - foe.x, y - foe.y);
  const step = Math.min(speed * g.dt, Math.hypot(x - foe.x, y - foe.y));
  ai.heading = Math.atan2(dir.y, dir.x);
  const blocked = g.moveActor(foe, dir.x * step, dir.y * step);
  if (blocked && blocked.kind !== STRUCT.COLONEL) g.damageStruct(blocked, blocked.hp, foe);
  crushAround(g, foe);
  bumpKids(g, foe, dir.x, dir.y);
}

// Exit route: follow the loop to the vertex with the shortest clear run to an entrance, then
// take that street out. Scenery near the map edge means a straight line off the loop would
// wedge the truck behind someone's garage.
function chooseExit(g, foe) {
  const ai = foe.ai;
  const path = g.map.truckPath;
  const roads = [];
  for (const gate of g.map.entrances) {
    for (let v = 0; v < path.length; v++) {
      const loopLegs = (v - ai.leg + path.length) % path.length;
      roads.push({ vertex: v, gate, cost: loopLegs * 150 + Math.hypot(path[v].x - gate.x, path[v].y - gate.y) });
    }
  }
  roads.sort((a, b) => a.cost - b.cost);
  ai.exit = roads.find((road) => roadClear(g, path[road.vertex].x, path[road.vertex].y, road.gate.x, road.gate.y, foe.r)) ?? null;
  ai.onExitRoad = false;
  ai.leaveBy = g.time + EXIT_GIVE_UP_AFTER;
  foe.aux &= ~AUX.DOORS;
  foe.takeDmgMul = 1;
  g.sfx(SFX.TRUCK_HORN, foe.x, foe.y);
  const colonel = g.colonel(TEAM.A);
  if (colonel) shout(g, colonel, COLONEL_LINES.truckGone);
}

function pastTheEdge(x, y, map) {
  // Entrances sit just inside the border, so aim beyond them to keep the truck rolling.
  const left = x, right = map.w - x, top = y, bottom = map.h - y;
  const least = Math.min(left, right, top, bottom);
  if (least === left) return { x: -200, y };
  if (least === right) return { x: map.w + 200, y };
  return least === top ? { x, y: -200 } : { x, y: map.h + 200 };
}

function leaveTown(g, foe) {
  const ai = foe.ai;
  if (ai.exit === undefined) chooseExit(g, foe);
  const speed = foe.speed * EXIT_SPEED_MUL;
  const path = g.map.truckPath;
  const done = atMapEdge(g, foe, 10) || g.time >= ai.leaveBy || !ai.exit;
  if (done) { g.despawn(foe); return; }

  if (ai.onExitRoad) {
    const out = pastTheEdge(ai.exit.gate.x, ai.exit.gate.y, g.map);
    driveToward(g, foe, out.x, out.y, speed);
    return;
  }
  if (ai.leg === ai.exit.vertex && Math.hypot(path[ai.leg].x - foe.x, path[ai.leg].y - foe.y) <= ARRIVE_RADIUS) {
    ai.onExitRoad = true;
    return;
  }
  const next = path[ai.leg];
  driveToward(g, foe, next.x, next.y, speed);
  if (Math.hypot(next.x - foe.x, next.y - foe.y) <= ARRIVE_RADIUS && ai.leg !== ai.exit.vertex) {
    ai.leg = (ai.leg + 1) % path.length;
  }
}

export function updateTruck(g, foe) {
  const ai = foe.ai;
  if (!ai.awake) wakeTruck(g, foe);
  if (foe.flags & AFLAG.FLEEING) { leaveTown(g, foe); return; }

  workTurret(g, foe);

  if (ai.parkUntil > 0) {
    if (g.time >= ai.parkUntil) closeDoors(g, foe);
    return;
  }
  if (g.time >= ai.parkAt) { openDoors(g, foe); return; }

  const path = g.map.truckPath;
  const next = path[ai.leg];
  driveToward(g, foe, next.x, next.y, foe.speed);
  if (Math.hypot(next.x - foe.x, next.y - foe.y) <= ARRIVE_RADIUS) {
    ai.leg = (ai.leg + 1) % path.length;
    if (ai.leg === 0) g.sfx(SFX.TRUCK_HORN, foe.x, foe.y);
  }
  if (isStuck(g, foe)) ai.leg = (ai.leg + 1) % path.length;
}

// ---- Abominable Steve ---------------------------------------------------------

function wakeSteve(g, foe) {
  const ai = foe.ai;
  const { escortEvery } = BOSS.steve;
  ai.awake = true;
  ai.attacks = 0;
  ai.readyAt = g.time + foe.cd;
  ai.poundAt = 0;
  ai.escortAt = g.time + escortEvery;
  ai.mutterAt = g.time + 8;
  holdAnchor(g, foe);
  g.sfx(SFX.STEVE_ROAR, foe.x, foe.y);
  shout(g, foe, STEVE_LINES.arrive);
}

function sendEscort(g, foe) {
  const entrances = g.map.entrances;
  const gate = entrances[Math.floor(g.rng() * entrances.length)];
  const roster = [[ACTOR.PIPSQUEAK, Math.round(3 * g.countMul)], [ACTOR.SLINGER, Math.round(g.countMul)]];
  let i = 0;
  for (const [kind, count] of roster) {
    for (let n = 0; n < count; n++) {
      const spread = (i % 2 ? 1 : -1) * 16 * Math.ceil(i / 2);
      i += 1;
      g.spawnFoe(kind, gate.x + spread, gate.y + spread * 0.5, { noFlakes: true });
    }
  }
  foe.ai.escortAt = g.time + BOSS.steve.escortEvery;
}

function kidsInRadius(g, foe, radius) {
  const kids = [];
  for (const a of g.enemiesInRadius(foe.team, foe.x, foe.y, radius)) {
    if (a.kind === ACTOR.KID && !(a.flags & AFLAG.FROZEN)) kids.push(a);
  }
  return kids;
}

function structsInRadius(g, foe, radius) {
  const hit = [];
  for (const s of g.structs.values()) {
    if (s.team !== foe.team && BUILD[s.kind].solid && gapTo(foe.x, foe.y, s) <= radius) hit.push(s);
  }
  return hit;
}

function landPound(g, foe) {
  const { poundRadius } = BOSS.steve;
  foe.aux &= ~AUX.POUND;
  foe.ai.poundAt = 0;
  for (const kid of kidsInRadius(g, foe, poundRadius)) {
    const away = unit(kid.x - foe.x, kid.y - foe.y);
    g.damageActor(kid, foe.dmg, foe, { kx: away.x * KID.knockback * 2, ky: away.y * KID.knockback * 2, kind: -1 });
  }
  for (const s of structsInRadius(g, foe, poundRadius)) g.damageStruct(s, foe.dmg, foe);
  g.emit({ e: EV.QUAKE, x: foe.x, y: foe.y, amt: 1 });
  g.emit({ e: EV.SPLASH, x: foe.x, y: foe.y, r: poundRadius, k: -1 });
  g.sfx(SFX.STEVE_POUND, foe.x, foe.y);
}

function rollBoulder(g, foe) {
  const st = FOES[ACTOR.STEVE];
  const { boulderSpeed, boulderR0, boulderR1, boulderLife } = BOSS.steve;
  const kid = g.nearestEnemy(foe, st.range);
  const struct = nearestStruct(g, foe.x, foe.y, st.range);
  const kidDist = kid ? Math.hypot(kid.x - foe.x, kid.y - foe.y) : Infinity;
  const structDist = struct ? gapTo(foe.x, foe.y, struct) : Infinity;
  if (!kid && !struct) return false;
  const point = kidDist <= structDist ? kid : structCentre(struct);
  const angle = Math.atan2(point.y - foe.y, point.x - foe.x);
  foe.aim = angle;
  g.throwFlat(foe, angle, {
    speed: boulderSpeed, flight: boulderLife, dmg: foe.dmg, kind: BALL.BOULDER, r: boulderR0,
    grow: (boulderR1 - boulderR0) / boulderLife, rMax: boulderR1, life: boulderLife, seq: 0,
  });
  return true;
}

function chooseAttack(g, foe, cooldown) {
  const ai = foe.ai;
  const { poundRadius, poundTelegraph } = BOSS.steve;
  const third = ai.attacks % 3 === 2;
  const closeBy = kidsInRadius(g, foe, poundRadius).length > 0 || structsInRadius(g, foe, poundRadius).length > 0;
  if (closeBy && !third) {
    foe.aux |= AUX.POUND;
    ai.poundAt = g.time + poundTelegraph;
    ai.attacks += 1;
    ai.readyAt = g.time + cooldown;
    return;
  }
  if (rollBoulder(g, foe)) {
    ai.attacks += 1;
    ai.readyAt = g.time + cooldown;
  }
}

function sitDown(g, foe) {
  const ai = foe.ai;
  if (ai.sitUntil === undefined) {
    ai.sitUntil = g.time + STEVE_SIT_TIME;
    foe.aux &= ~AUX.POUND;
    foe.flags &= ~AFLAG.ENRAGED;
    g.sfx(SFX.CHEER, foe.x, foe.y);
    shout(g, foe, STEVE_LINES.defeated);
    const colonel = g.colonel(TEAM.A);
    if (colonel) shout(g, colonel, COLONEL_LINES.steveDone);
    return;
  }
  if (g.time >= ai.sitUntil) g.despawn(foe);
}

export function updateSteve(g, foe) {
  const ai = foe.ai;
  const st = BOSS.steve;
  if (!ai.awake) wakeSteve(g, foe);
  if (foe.flags & AFLAG.FLEEING) { sitDown(g, foe); return; }

  if (!(foe.flags & AFLAG.ENRAGED) && foe.hp < foe.maxHp * st.enrageAt) {
    foe.flags |= AFLAG.ENRAGED;
    g.blizzard = true;
    g.sfx(SFX.STEVE_ROAR, foe.x, foe.y);
    g.banner('Steve is very cross now', 'And he brought the weather with him.', 'boss');
    shout(g, foe, STEVE_LINES.enrage);
  }
  const enraged = (foe.flags & AFLAG.ENRAGED) !== 0;
  const speed = foe.speed * (enraged ? st.enrageSpeedMul : 1);
  const cooldown = foe.cd * (enraged ? st.enrageCdMul : 1);

  if (g.time >= ai.escortAt) sendEscort(g, foe);
  if (g.time >= ai.mutterAt) {
    ai.mutterAt = g.time + 9 + g.rng() * 6;
    say(g, foe, STEVE_LINES.mutter, 0.8);
  }

  if (ai.poundAt > 0) {
    if (g.time >= ai.poundAt) landPound(g, foe);
    holdAnchor(g, foe);
    return;
  }
  if (g.time >= ai.readyAt) chooseAttack(g, foe, cooldown);

  const colonel = g.colonel(TEAM.A);
  if (!colonel) return;
  const c = structCentre(colonel);
  if (Math.hypot(c.x - foe.x, c.y - foe.y) <= st.stopDist) {
    foe.aim = Math.atan2(c.y - foe.y, c.x - foe.x);
    holdAnchor(g, foe);
    return;
  }

  const field = g.flow(TEAM.FOES);
  const dir = field ? field.dirAt(foe.x, foe.y) : { dx: 0, dy: 0, blocker: null };
  if (dir.blocker) { holdAnchor(g, foe); return; }
  const step = speed * g.dt;
  g.moveActor(foe, dir.dx * step, dir.dy * step);
  foe.aim = Math.atan2(dir.dy, dir.dx);
  // Same stuck rule as everyone else: he clambers over whatever he wedged against.
  if (isStuck(g, foe)) hopCell(g, foe, dir.dx, dir.dy);
}
