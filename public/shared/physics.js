// Fort Flurry — collision world, kid motion and the build rules (SPEC section 10).
//
// This file runs on the host and, for prediction and build previews, in every browser.
// A frame replayed on a client has to land where the host put it, so nothing here may
// depend on rng or clocks. Math.hypot and Math.exp give different last digits on different
// engines, so motion sticks to arithmetic and sqrt; the only trig is a slide along aim,
// where a last-digit difference is far below what reconciliation corrects anyway.

import { AFLAG, BTN, MODE, PHASE, STRUCT } from './schema.js';
import {
  BUILD, CELL, KID, MAX_STRUCTS_PER_TEAM, REPAIR_COST_MUL, SIEGE, TEAMMATE_DEMOLISH_RANGE,
} from './constants.js';

const HAS_STRUCT = 1;
const SOLID_STRUCT = 2;

// Each pass of the push-out resolves the single deepest contact. Four passes settle
// any corner a kid can reach on the build grid.
const PUSH_PASSES = 4;
// A body may advance at most this fraction of its radius per collision pass. Slides and
// knockback move far enough per tick to step clean over a 10-unit fence otherwise.
const MAX_STEP_OF_RADIUS = 0.8;
const NEARLY_STOPPED = 1;

// Written by the penetrate* helpers. Module scratch keeps the per-tick collision loop
// allocation-free; it is consumed immediately and never carries state between calls.
let normalX = 0;
let normalY = 0;

// Depth of a circle inside a box, 0 when clear, leaving the exit direction in normalX/Y.
function penetrateBox(x, y, r, left, top, right, bottom) {
  const px = x < left ? left : x > right ? right : x;
  const py = y < top ? top : y > bottom ? bottom : y;
  const dx = x - px;
  const dy = y - py;
  const d2 = dx * dx + dy * dy;
  if (d2 >= r * r) return 0;
  if (d2 > 0) {
    const d = Math.sqrt(d2);
    normalX = dx / d;
    normalY = dy / d;
    return r - d;
  }
  // Centre inside the box, so there is no nearest point to push away from.
  const toLeft = x - left;
  const toRight = right - x;
  const toTop = y - top;
  const toBottom = bottom - y;
  const least = Math.min(toLeft, toRight, toTop, toBottom);
  if (least === toLeft) { normalX = -1; normalY = 0; }
  else if (least === toRight) { normalX = 1; normalY = 0; }
  else if (least === toTop) { normalX = 0; normalY = -1; }
  else { normalX = 0; normalY = 1; }
  return r + least;
}

function penetrateCircle(x, y, r, ox, oy, or) {
  const dx = x - ox;
  const dy = y - oy;
  const reach = r + or;
  const d2 = dx * dx + dy * dy;
  if (d2 >= reach * reach) return 0;
  if (d2 > 0) {
    const d = Math.sqrt(d2);
    normalX = dx / d;
    normalY = dy / d;
    return reach - d;
  }
  normalX = 1;
  normalY = 0;
  return reach;
}

function circleTouchesBox(x, y, r, left, top, right, bottom) {
  const px = x < left ? left : x > right ? right : x;
  const py = y < top ? top : y > bottom ? bottom : y;
  const dx = x - px;
  const dy = y - py;
  return dx * dx + dy * dy < r * r;
}

// Fraction along the segment where it first enters the box, or Infinity. Slab method.
function segmentIntoBox(x0, y0, dx, dy, left, top, right, bottom) {
  let tMin = 0;
  let tMax = 1;
  if (dx === 0) {
    if (x0 < left || x0 > right) return Infinity;
  } else {
    let a = (left - x0) / dx;
    let b = (right - x0) / dx;
    if (a > b) { const swap = a; a = b; b = swap; }
    if (a > tMin) tMin = a;
    if (b < tMax) tMax = b;
    if (tMin > tMax) return Infinity;
  }
  if (dy === 0) {
    if (y0 < top || y0 > bottom) return Infinity;
  } else {
    let a = (top - y0) / dy;
    let b = (bottom - y0) / dy;
    if (a > b) { const swap = a; a = b; b = swap; }
    if (a > tMin) tMin = a;
    if (b < tMax) tMax = b;
    if (tMin > tMax) return Infinity;
  }
  return tMin;
}

export function segmentIntoCircle(x0, y0, dx, dy, cx, cy, r) {
  const fx = x0 - cx;
  const fy = y0 - cy;
  const c = fx * fx + fy * fy - r * r;
  if (c <= 0) return 0;
  const a = dx * dx + dy * dy;
  if (a === 0) return Infinity;
  const b = fx * dx + fy * dy;
  const disc = b * b - a * c;
  if (disc < 0 || b >= 0) return Infinity;
  const t = (-b - Math.sqrt(disc)) / a;
  return t <= 1 ? t : Infinity;
}

class CollisionWorld {
  constructor(map) {
    this.map = map;
    this.cols = Math.ceil(map.w / CELL);
    this.rows = Math.ceil(map.h / CELL);
    this.truce = null;
    const cells = this.cols * this.rows;
    this.structBits = new Uint8Array(cells);
    this.structHeight = new Float64Array(cells);
    this.moveBlocked = new Uint8Array(cells);
    // Swings and the like let kids through but still can't have a wall built inside them.
    this.occupied = new Uint8Array(cells);
    // Per-cell obstacle lists, so a body only looks at what is under it. A big house
    // appears in many cells; `seen` stops it being tested more than once per query.
    this.moveBuckets = new Array(cells).fill(null);
    this.ballBuckets = new Array(cells).fill(null);
    const obstacles = map.obstacles ?? [];
    this.seen = new Uint32Array(obstacles.length);
    this.seenStamp = 0;
    obstacles.forEach((o, index) => this.indexObstacle(o, index));
  }

  indexObstacle(o, index) {
    const circle = o.shape === 'circle';
    const left = circle ? o.x - o.r : o.x;
    const top = circle ? o.y - o.r : o.y;
    const right = circle ? o.x + o.r : o.x + o.w;
    const bottom = circle ? o.y + o.r : o.y + o.h;
    const entry = { o, index, circle, left, top, right, bottom };
    const c0 = Math.max(0, Math.floor(left / CELL));
    const c1 = Math.min(this.cols - 1, Math.ceil(right / CELL) - 1);
    const r0 = Math.max(0, Math.floor(top / CELL));
    const r1 = Math.min(this.rows - 1, Math.ceil(bottom / CELL) - 1);
    for (let cy = r0; cy <= r1; cy++) {
      for (let cx = c0; cx <= c1; cx++) {
        const cellLeft = cx * CELL;
        const cellTop = cy * CELL;
        if (circle && !circleTouchesBox(o.x, o.y, o.r, cellLeft, cellTop, cellLeft + CELL, cellTop + CELL)) continue;
        const i = cy * this.cols + cx;
        this.occupied[i] = 1;
        if (o.blocksMove) {
          this.moveBlocked[i] = 1;
          (this.moveBuckets[i] ??= []).push(entry);
        }
        if (o.blocksBalls) (this.ballBuckets[i] ??= []).push(entry);
      }
    }
  }

  inBounds(cx, cy) {
    return cx >= 0 && cy >= 0 && cx < this.cols && cy < this.rows;
  }

  setStruct(cx, cy, solid, size = 1, height = 0) {
    for (let y = cy; y < cy + size; y++) {
      for (let x = cx; x < cx + size; x++) {
        if (!this.inBounds(x, y)) continue;
        const i = y * this.cols + x;
        this.structBits[i] = HAS_STRUCT | (solid ? SOLID_STRUCT : 0);
        this.structHeight[i] = solid ? height : 0;
      }
    }
  }

  clearStruct(cx, cy, size = 1) {
    for (let y = cy; y < cy + size; y++) {
      for (let x = cx; x < cx + size; x++) {
        if (!this.inBounds(x, y)) continue;
        const i = y * this.cols + x;
        this.structBits[i] = 0;
        this.structHeight[i] = 0;
      }
    }
  }

  cellOf(x, y) {
    return { cx: Math.floor(x / CELL), cy: Math.floor(y / CELL) };
  }

  isIce(x, y) {
    const zones = this.map.ice;
    if (!zones) return false;
    for (let i = 0; i < zones.length; i++) {
      const z = zones[i];
      if (z.shape === 'ellipse') {
        const dx = (x - z.x) / z.rx;
        const dy = (y - z.y) / z.ry;
        if (dx * dx + dy * dy <= 1) return true;
      } else if (x >= z.x && x <= z.x + z.w && y >= z.y && y <= z.y + z.h) {
        return true;
      }
    }
    return false;
  }

  isSolidCell(cx, cy) {
    if (!this.inBounds(cx, cy)) return true;
    const i = cy * this.cols + cx;
    return this.moveBlocked[i] === 1 || (this.structBits[i] & SOLID_STRUCT) !== 0;
  }

  isObstacleCell(cx, cy) {
    if (!this.inBounds(cx, cy)) return true;
    return this.moveBlocked[cy * this.cols + cx] === 1;
  }

  hasObstacleOverlap(cx, cy) {
    if (!this.inBounds(cx, cy)) return true;
    return this.occupied[cy * this.cols + cx] === 1;
  }

  isStructCell(cx, cy) {
    return this.inBounds(cx, cy) && this.structBits[cy * this.cols + cx] !== 0;
  }

  isSolidStructCell(cx, cy) {
    return this.inBounds(cx, cy) && (this.structBits[cy * this.cols + cx] & SOLID_STRUCT) !== 0;
  }
}

export function createCollisionWorld(map) {
  return new CollisionWorld(map);
}

function removeInwardVelocity(body, nx, ny) {
  const into = body.vx * nx + body.vy * ny;
  if (into < 0) {
    body.vx -= into * nx;
    body.vy -= into * ny;
  }
}

// Resolves the deepest contact first, then re-measures. Taking contacts in discovery
// order instead makes a kid sliding along a straight wall catch the corners between
// cells, because a neighbouring cell's corner can register before the face under them.
function pushOut(cw, body, r, ignoreStructs) {
  let touched = -1;
  for (let pass = 0; pass < PUSH_PASSES; pass++) {
    const x = body.x;
    const y = body.y;
    let depth = 0;
    let nx = 0;
    let ny = 0;
    let structCell = -1;
    const c0 = Math.max(0, Math.floor((x - r) / CELL));
    const c1 = Math.min(cw.cols - 1, Math.floor((x + r) / CELL));
    const r0 = Math.max(0, Math.floor((y - r) / CELL));
    const r1 = Math.min(cw.rows - 1, Math.floor((y + r) / CELL));
    const stamp = ++cw.seenStamp;
    for (let cy = r0; cy <= r1; cy++) {
      for (let cx = c0; cx <= c1; cx++) {
        const i = cy * cw.cols + cx;
        if (!ignoreStructs && (cw.structBits[i] & SOLID_STRUCT) !== 0) {
          const left = cx * CELL;
          const top = cy * CELL;
          const d = penetrateBox(x, y, r, left, top, left + CELL, top + CELL);
          if (d > depth) {
            depth = d;
            nx = normalX;
            ny = normalY;
            structCell = i;
          }
        }
        const bucket = cw.moveBuckets[i];
        if (bucket === null) continue;
        for (let b = 0; b < bucket.length; b++) {
          const entry = bucket[b];
          if (cw.seen[entry.index] === stamp) continue;
          cw.seen[entry.index] = stamp;
          const d = entry.circle
            ? penetrateCircle(x, y, r, entry.o.x, entry.o.y, entry.o.r)
            : penetrateBox(x, y, r, entry.left, entry.top, entry.right, entry.bottom);
          if (d > depth) {
            depth = d;
            nx = normalX;
            ny = normalY;
            structCell = -1;
          }
        }
      }
    }
    if (depth <= 0) break;
    body.x = x + nx * depth;
    body.y = y + ny * depth;
    removeInwardVelocity(body, nx, ny);
    if (structCell >= 0 && touched < 0) touched = structCell;
  }
  return touched;
}

function keepInMap(cw, body, r) {
  const maxX = cw.map.w - r;
  const maxY = cw.map.h - r;
  if (body.x < r) { body.x = r; if (body.vx < 0) body.vx = 0; }
  else if (body.x > maxX) { body.x = maxX; if (body.vx > 0) body.vx = 0; }
  if (body.y < r) { body.y = r; if (body.vy < 0) body.vy = 0; }
  else if (body.y > maxY) { body.y = maxY; if (body.vy > 0) body.vy = 0; }
}

function keepOffRope(cw, body, r, prevX, prevY) {
  const rope = cw.truce;
  if (!rope || !rope.active) return;
  if (rope.axis === 'x') {
    if (prevX < rope.at) {
      if (body.x > rope.at - r) { body.x = rope.at - r; if (body.vx > 0) body.vx = 0; }
    } else if (body.x < rope.at + r) {
      body.x = rope.at + r;
      if (body.vx < 0) body.vx = 0;
    }
  } else if (prevY < rope.at) {
    if (body.y > rope.at - r) { body.y = rope.at - r; if (body.vy > 0) body.vy = 0; }
  } else if (body.y < rope.at + r) {
    body.y = rope.at + r;
    if (body.vy < 0) body.vy = 0;
  }
}

// body.x/y hold the wanted position on entry and the legal one on exit. Returns the
// first struct cell touched as {cx,cy}, or null. `opts.ignoreStructs` is the Thief's
// vault: obstacles and map edges still stop it, walls do not.
export function collideCircle(cw, body, prevX, prevY, opts) {
  const r = body.r ?? KID.radius;
  const ignoreStructs = opts !== undefined && opts.ignoreStructs === true;
  const wantX = body.x;
  const wantY = body.y;
  const dx = wantX - prevX;
  const dy = wantY - prevY;
  const distance = Math.sqrt(dx * dx + dy * dy);
  const maxStep = r * MAX_STEP_OF_RADIUS;
  let touched = -1;
  if (distance > maxStep) {
    const steps = Math.ceil(distance / maxStep);
    const stepX = dx / steps;
    const stepY = dy / steps;
    body.x = prevX;
    body.y = prevY;
    for (let i = 0; i < steps; i++) {
      body.x += stepX;
      body.y += stepY;
      const hit = pushOut(cw, body, r, ignoreStructs);
      if (hit >= 0 && touched < 0) touched = hit;
    }
  } else {
    touched = pushOut(cw, body, r, ignoreStructs);
  }
  keepInMap(cw, body, r);
  keepOffRope(cw, body, r, prevX, prevY);
  if (touched < 0) return null;
  return { cx: touched % cw.cols, cy: Math.floor(touched / cw.cols) };
}

// First thing a flat ball at height z meets between two points. Map edges are not
// reported here: leaving the map is a ball's own 'out' ending, not a collision.
export function raycastFlat(cw, x0, y0, x1, y1, z = 0) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  let cx = Math.floor(x0 / CELL);
  let cy = Math.floor(y0 / CELL);
  const endX = Math.floor(x1 / CELL);
  const endY = Math.floor(y1 / CELL);
  const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0;
  const stepY = dy > 0 ? 1 : dy < 0 ? -1 : 0;
  const deltaX = dx !== 0 ? CELL / Math.abs(dx) : Infinity;
  const deltaY = dy !== 0 ? CELL / Math.abs(dy) : Infinity;
  let nextX = dx !== 0 ? ((stepX > 0 ? (cx + 1) * CELL : cx * CELL) - x0) / dx : Infinity;
  let nextY = dy !== 0 ? ((stepY > 0 ? (cy + 1) * CELL : cy * CELL) - y0) / dy : Infinity;
  let entered = 0;
  let bestT = Infinity;
  let bestStruct = -1;
  const stamp = ++cw.seenStamp;
  const limit = Math.abs(endX - cx) + Math.abs(endY - cy) + 2;
  for (let walked = 0; walked < limit; walked++) {
    if (cw.inBounds(cx, cy)) {
      const i = cy * cw.cols + cx;
      if ((cw.structBits[i] & SOLID_STRUCT) !== 0 && z < cw.structHeight[i] && entered < bestT) {
        bestT = entered;
        bestStruct = i;
      }
      const bucket = cw.ballBuckets[i];
      if (bucket !== null) {
        for (let b = 0; b < bucket.length; b++) {
          const entry = bucket[b];
          if (cw.seen[entry.index] === stamp) continue;
          cw.seen[entry.index] = stamp;
          const t = entry.circle
            ? segmentIntoCircle(x0, y0, dx, dy, entry.o.x, entry.o.y, entry.o.r)
            : segmentIntoBox(x0, y0, dx, dy, entry.left, entry.top, entry.right, entry.bottom);
          if (t < bestT) {
            bestT = t;
            bestStruct = -1;
          }
        }
      }
    }
    const leaving = nextX < nextY ? nextX : nextY;
    // Obstacles span cells, so a hit found early may lie past this cell. Only once the
    // walk has passed it can nothing nearer turn up.
    if (bestT <= leaving || (cx === endX && cy === endY) || leaving > 1) break;
    entered = leaving;
    if (nextX < nextY) {
      cx += stepX;
      nextX += deltaX;
    } else {
      cy += stepY;
      nextY += deltaY;
    }
  }
  if (bestT > 1) return null;
  const hit = { x: x0 + dx * bestT, y: y0 + dy * bestT, what: 'obstacle', structCell: null, t: bestT };
  if (bestStruct >= 0) {
    hit.what = 'struct';
    hit.structCell = { cx: bestStruct % cw.cols, cy: Math.floor(bestStruct / cw.cols) };
  }
  return hit;
}

// A kid mid-countdown should reach exactly zero, never a small negative that a later
// `> 0` test or the u8 wire encoding would have to clean up.
function countDown(t, dt) {
  return t > dt ? t - dt : 0;
}

export function stepKidMotion(kid, frame, cw, dt) {
  kid.slideT = countDown(kid.slideT, dt);
  kid.slideCd = countDown(kid.slideCd, dt);
  kid.boardT = countDown(kid.boardT, dt);
  kid.slowT = countDown(kid.slowT, dt);
  kid.stunT = countDown(kid.stunT, dt);
  const btn = frame.btn;

  if ((kid.flags & (AFLAG.FROZEN | AFLAG.LOCKED)) !== 0) {
    kid.vx = 0;
    kid.vy = 0;
    kid.prevBtn = btn;
    return kid;
  }

  const stunned = kid.stunT > 0;
  let mx = stunned ? 0 : frame.mx;
  let my = stunned ? 0 : frame.my;
  let push = Math.sqrt(mx * mx + my * my);
  if (push > 1) {
    mx /= push;
    my /= push;
    push = 1;
  }

  const mods = kid.mods;
  const pressedSlide = (btn & BTN.SLIDE) !== 0 && (kid.prevBtn & BTN.SLIDE) === 0;
  if (pressedSlide && kid.slideCd <= 0 && !stunned) {
    kid.slideT = KID.slideTime;
    kid.slideCd = KID.slideCooldown * mods.slideCdMul;
    if (push < 0.1) {
      kid.vx = Math.cos(frame.aim) * KID.slideSpeed;
      kid.vy = Math.sin(frame.aim) * KID.slideSpeed;
    } else {
      kid.vx = (mx / push) * KID.slideSpeed;
      kid.vy = (my / push) * KID.slideSpeed;
    }
  }

  if (kid.slideT > 0) {
    // Direction lives in the velocity so a wall can deflect a slide along itself.
    const speed = Math.sqrt(kid.vx * kid.vx + kid.vy * kid.vy);
    if (speed > NEARLY_STOPPED) {
      kid.vx = (kid.vx / speed) * KID.slideSpeed;
      kid.vy = (kid.vy / speed) * KID.slideSpeed;
    }
  } else {
    const onIce = cw.isIce(kid.x, kid.y);
    if (push > 0) {
      let top = (onIce ? KID.iceMaxSpeed : KID.speed) * mods.speedMul;
      if ((btn & (BTN.THROW | BTN.LOB)) !== 0) top *= KID.chargeSpeedMul;
      if (kid.boardT > 0) top *= KID.boardSpeedMul;
      if (kid.slowT > 0) top *= KID.slowSpeedMul;
      // Plain thrust against drag would top out at accel/drag, well short of KID.speed.
      // Closing on the wish velocity reaches it exactly, and bleeds off knockback and
      // slide speed at the same rate instead of clipping them.
      const dvx = mx * top - kid.vx;
      const dvy = my * top - kid.vy;
      const gap = Math.sqrt(dvx * dvx + dvy * dvy);
      const reach = (onIce ? KID.iceAccel : KID.accel) * dt;
      if (gap <= reach) {
        kid.vx += dvx;
        kid.vy += dvy;
      } else {
        kid.vx += (dvx / gap) * reach;
        kid.vy += (dvy / gap) * reach;
      }
    } else {
      const keep = Math.max(0, 1 - (onIce ? KID.iceDrag : KID.drag) * dt);
      kid.vx *= keep;
      kid.vy *= keep;
      if (kid.vx * kid.vx + kid.vy * kid.vy < NEARLY_STOPPED) {
        kid.vx = 0;
        kid.vy = 0;
      }
    }
  }

  const prevX = kid.x;
  const prevY = kid.y;
  kid.x += kid.vx * dt;
  kid.y += kid.vy * dt;
  collideCircle(cw, kid, prevX, prevY);
  kid.prevBtn = btn;
  return kid;
}

// The client hands over arrays where the sim has Maps; both must work.
function listOf(collection) {
  return collection instanceof Map ? collection.values() : collection;
}

function structSize(s) {
  return BUILD[s.kind].size || 1;
}

function structInCell(structs, cx, cy) {
  for (const s of listOf(structs)) {
    const size = structSize(s);
    if (cx >= s.cx && cx < s.cx + size && cy >= s.cy && cy < s.cy + size) return s;
  }
  return null;
}

function onOwnHalf(cw, team, cx, cy) {
  const { truce, forts } = cw.map;
  const home = forts?.[team];
  if (!truce || !home) return true;
  const low = (truce.axis === 'x' ? cx : cy) * CELL;
  const homeSide = truce.axis === 'x' ? home.x : home.y;
  return homeSide < truce.at ? low + CELL <= truce.at : low >= truce.at;
}

function actorOverCell(actors, cx, cy) {
  const left = cx * CELL;
  const top = cy * CELL;
  for (const a of listOf(actors)) {
    const r = a.r ?? KID.radius;
    if (circleTouchesBox(a.x, a.y, r, left, top, left + CELL, top + CELL)) return true;
  }
  return false;
}

function spendRefusal(q, cost) {
  if (q.flakes < cost) return 'noFlakes';
  if (q.spendLeft < cost) return 'limit';
  return null;
}

export function repairCost(kind) {
  return Math.ceil(REPAIR_COST_MUL * BUILD[kind].cost);
}

// The one validity rule, shared by Game.command and the client's preview, so the ghost
// on screen and the host's answer cannot disagree. The order is part of the contract.
export function canPlace(cw, q, kind, cx, cy) {
  const spec = BUILD[kind];
  if (spec === undefined || kind === STRUCT.COLONEL) return 'badCell';
  if (cw.hasObstacleOverlap(cx, cy)) return 'badCell';

  const midX = (cx + 0.5) * CELL;
  const midY = (cy + 0.5) * CELL;
  if (q.mode === MODE.SIEGE) {
    const reach = SIEGE.entranceNoBuild * SIEGE.entranceNoBuild;
    for (const e of cw.map.entrances ?? []) {
      const dx = midX - e.x;
      const dy = midY - e.y;
      if (dx * dx + dy * dy < reach) return 'badCell';
    }
  }
  if (((cw.truce && cw.truce.active) || q.mode === MODE.FORTWARS) && !onOwnHalf(cw, q.team, cx, cy)) return 'badCell';

  const dx = midX - q.x;
  const dy = midY - q.y;
  if (dx * dx + dy * dy > q.range * q.range) return 'tooFar';

  const here = structInCell(q.structs, cx, cy);
  if (here !== null) {
    if (here.team === q.team && here.kind === kind && here.hp < here.maxHp) {
      return spendRefusal(q, repairCost(kind)) ?? 'repair';
    }
    // A healthy Colonel has nothing to patch, so the preview and the host both refuse him.
    if (here.team === q.team && here.kind === STRUCT.COLONEL && kind === STRUCT.WALL
      && q.phase === PHASE.BUILD && q.patchesLeft > 0 && here.hp < here.maxHp) {
      return spendRefusal(q, SIEGE.colonelPatch.cost) ?? 'patch';
    }
    return 'badCell';
  }

  if (spec.solid && actorOverCell(q.actors, cx, cy)) return 'badCell';

  let teamStructs = 0;
  let teamPults = 0;
  for (const s of listOf(q.structs)) {
    if (s.team !== q.team || s.kind === STRUCT.COLONEL) continue;
    teamStructs++;
    if (s.kind === STRUCT.PULT) teamPults++;
  }
  if (teamStructs >= MAX_STRUCTS_PER_TEAM) return 'limit';
  if (kind === STRUCT.PULT && teamPults >= q.pultLimit) return 'limit';

  return spendRefusal(q, spec.cost) ?? 'ok';
}

export function demolishState(q, struct, playerId) {
  if (!struct || struct.kind === STRUCT.COLONEL || struct.team !== q.team) return 'badCell';
  const half = (structSize(struct) * CELL) / 2;
  const dx = struct.cx * CELL + half - q.x;
  const dy = struct.cy * CELL + half - q.y;
  const distance2 = dx * dx + dy * dy;
  const own = struct.ownerId === playerId || !q.playersPresent(struct.ownerId);
  const reach = own ? q.range : TEAMMATE_DEMOLISH_RANGE;
  return distance2 <= reach * reach ? 'ok' : 'tooFar';
}
