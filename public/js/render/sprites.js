// Fort Flurry — character art: the public face of the sprite system. See SPEC 11.0 and 12.
// Bodies are cached sprites (sprite-atlas.js), scarf tails are live paths, squash is a drawImage
// transform. Everything an actor reacts to is read off its snapshot, so this module needs no events:
// an hp drop is a hit, a falling CHARGING flag is a throw, a new ball near a foe is that foe's arm.

import { ACTOR, AFLAG, AUX, BALL, MODE } from '../../shared/schema.js';
import { BOSS, CELL, DEFAULT_LOOK } from '../../shared/constants.js';
import { SpriteAtlas, blit } from './sprite-atlas.js';
import {
  DIR_ANGLE, KID_BOX, KID_FRAMES, dir8, dirBase, dirFlip, paintKid, kidColors, kidKey, teamColorOf,
  tailAnchor, poseCrouch, poseLean, paintBoard, boardColors,
} from './sprite-chibi.js';
import { FOE_BOX, SLED_BOX, paintFoe, paintFleeFlag, paintLid, paintSled } from './sprite-foes.js';
import { CONE_BOX, coneSeat, paintCone, paintDoorLeaves, paintTruck, rearFacesCamera, truckBox } from './sprite-truck.js';
import {
  STEVE_ARM_BOX, STEVE_BODY_BOX, STEVE_FOOT_BOX, STEVE_SIT_BOX, paintSteveArm, paintSteveBody, paintSteveFoot, paintSteveSitting,
} from './sprite-steve.js';
import {
  BUCKET_BOX, COLONEL_BOX, COLONEL_FOOT_Y, HEAD_Y, TIER_LOSS, paintArm as paintColonelArm, paintBucket, paintColonelBody,
  paintFaceLive, paintFallingBit, tierOf,
} from './sprite-colonel.js';
import { paintIcon } from './sprite-icons.js';
import { TAU, alpha, capsule, ell, star5, tone } from './sprite-paint.js';

// ---- lobby preview ---------------------------------------------------------------------------------

const KID_POSE_ALIAS = {
  walking: 'walk', charging: 'charge', throwing: 'throw', packing: 'pack', sliding: 'slide',
  snowboarding: 'ride', board: 'ride', boarding: 'ride', stunned: 'stun',
};

// Painted directly, so it stays sharp at any size. (x,y) is the ground under the kid's feet, the same
// anchor actors use in the world. Pass team only when team colours apply, i.e. in Face-Off.
export function drawKid(ctx, look, x, y, scale = 1, opts = {}) {
  const raw = opts.pose ?? 'idle';
  const name = KID_POSE_ALIAS[raw] ?? raw;
  const pose = KID_FRAMES[name] ? name : 'idle';
  const d = opts.dir ?? 2;
  const frames = KID_FRAMES[pose];
  const frame = opts.frame ?? (Math.floor((opts.time ?? 0) * 8) % frames);
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(dirFlip(d) ? -scale : scale, scale);
  paintKid(ctx, look ?? DEFAULT_LOOK, teamColorOf(opts.team), pose, frame, dirBase(d));
  ctx.restore();
}

// ---- icons -----------------------------------------------------------------------------------------

const iconMasters = new Map();

// Always a fresh canvas: DOM nodes can live in only one place, and callers put icons in several.
export function iconCanvas(name, cssPx = 32) {
  const dpr = typeof window !== 'undefined' ? Math.min(window.devicePixelRatio || 1, 3) : 1;
  const px = Math.max(1, Math.round(cssPx * dpr));
  const key = `${name}|${px}`;
  let master = iconMasters.get(key);
  if (!master) {
    master = document.createElement('canvas');
    master.width = master.height = px;
    const m = master.getContext('2d');
    m.scale(px / 64, px / 64);
    paintIcon(m, String(name));
    iconMasters.set(key, master);
  }
  const c = document.createElement('canvas');
  c.width = c.height = px;
  c.style.width = c.style.height = `${cssPx}px`;
  c.getContext('2d').drawImage(master, 0, 0);
  return c;
}

// ---- scarf tails -----------------------------------------------------------------------------------

const TAIL_POINTS = 5;

function makeTail(len) {
  return {
    n: TAIL_POINTS, seg: len / (TAIL_POINTS - 1),
    x: new Float32Array(TAIL_POINTS), y: new Float32Array(TAIL_POINTS),
    vx: new Float32Array(TAIL_POINTS), vy: new Float32Array(TAIL_POINTS),
  };
}

// The tail is simulated around its anchor in the relative wind of the kid's own motion, so a respawn
// teleport can't yank it and it needs no world position.
function stepTail(T, wx, wy, dt, time, phase, lean) {
  const drag = 9, grav = 300;
  const speed = Math.hypot(wx, wy);
  const px = speed > 1 ? -wy / speed : 1, py = speed > 1 ? wx / speed : 0;
  for (let i = 1; i < T.n; i++) {
    const flut = Math.sin(time * 11 + i * 1.5 + phase) * (18 + speed * 0.42) * (i / T.n);
    T.vx[i] += ((wx + lean + px * flut - T.vx[i]) * drag) * dt;
    T.vy[i] += ((wy + py * flut - T.vy[i]) * drag + grav) * dt;
    T.x[i] += T.vx[i] * dt;
    T.y[i] += T.vy[i] * dt;
  }
  for (let i = 1; i < T.n; i++) {
    const dx = T.x[i] - T.x[i - 1], dy = T.y[i] - T.y[i - 1];
    const d = Math.hypot(dx, dy) || 1;
    const k = T.seg / d;
    T.x[i] = T.x[i - 1] + dx * k;
    T.y[i] = T.y[i - 1] + dy * k;
  }
}

function strokeTail(ctx, T, ax, ay, color, tip, w) {
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(ax, ay);
  for (let i = 1; i < T.n - 1; i++) {
    const mx = (T.x[i] + T.x[i + 1]) / 2, my = (T.y[i] + T.y[i + 1]) / 2;
    ctx.quadraticCurveTo(ax + T.x[i], ay + T.y[i], ax + mx, ay + my);
  }
  ctx.lineTo(ax + T.x[T.n - 1], ay + T.y[T.n - 1]);
  ctx.strokeStyle = color;
  ctx.lineWidth = w;
  ctx.stroke();
  // A pale end stripe: the only thing that shows which way a thin tail is pointing at game size.
  const e = T.n - 1;
  ctx.beginPath();
  ctx.moveTo(ax + (T.x[e] + T.x[e - 1]) / 2, ay + (T.y[e] + T.y[e - 1]) / 2);
  ctx.lineTo(ax + T.x[e], ay + T.y[e]);
  ctx.strokeStyle = tip;
  ctx.stroke();
}

// ---- sprite keys -----------------------------------------------------------------------------------

// Keys are numbers: a crowd looks up ninety of them every frame, and strings would be ninety bits of
// garbage per frame for nothing.
const F_KID = 1 << 24, F_FOE = 2 << 24, F_STEVE = 3 << 24, F_TRUCK = 4 << 24, F_CONE = 5 << 24;
const F_LID = 6 << 24, F_BOARD = 7 << 24, F_COLONEL = 8 << 24, F_BUCKET = 9 << 24, F_MISC = 10 << 24;
const K_STAR = F_MISC + 1, K_SLUSH = F_MISC + 2, K_ARM = F_MISC + 3, K_FOOT = F_MISC + 4, K_SIT = F_MISC + 8, K_FLAG = F_MISC + 12, K_WRECK = F_MISC + 16;

const KID_POSES = Object.keys(KID_FRAMES);
const KID_POSE_ID = Object.fromEntries(KID_POSES.map((n, i) => [n, i]));
const FOE_POSES = ['idle', 'walk', 'throw', 'hit', 'stun', 'flee', 'sled', 'sledflee'];
const FOE_POSE_ID = Object.fromEntries(FOE_POSES.map((n, i) => [n, i]));
const STEVE_MOODS = ['tired', 'blink', 'strain', 'mad', 'madblink'];
const STEVE_MOOD_ID = Object.fromEntries(STEVE_MOODS.map((n, i) => [n, i]));

// ---- per-actor state -------------------------------------------------------------------------------

const HIT_TIME = 0.2;
const FLASH_TIME = 0.13;
const THROW_TIME = 0.24;
const HEAVE_TIME = 0.55;
const SLAM_TIME = 0.5;
const COAST_SPEED = 12; // below this an actor counts as standing still

function newState(a, time) {
  return {
    seen: time, stepped: time - 1 / 60,
    hp: a.hp, flags: a.flags, aux: a.aux,
    hitT: 0, flashT: 0, throwT: 0, lobT: 0,
    walk: (a.id * 0.381966) % 1,
    sq: 0, sqv: 0,
    dir: dir8(a.aim || 0),
    // Something first seen on the move is already pointing that way; it doesn't turn into it.
    heading: a.vx || a.vy ? Math.atan2(a.vy, a.vx) : (a.aim || 0),
    sig: -1, slot: 0, C: null, tipColor: '', backColor: '', tailA: null, tailB: null,
    door: 0, recoil: 0,
    wind: 0, slamT: 0, heaveT: 0,
    wreckT: 0, wreckX: 0, wreckY: 0, wreckDir: 0,
  };
}

function wrapAngle(a) {
  let d = a % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
}

// Sticky facing: flow-field walkers wobble around a sector edge, and without a dead band they'd flip
// between two facings every few frames.
function holdDir(cur, angle) {
  return Math.abs(wrapAngle(angle - cur * (Math.PI / 4))) < 0.54 ? cur : dir8(angle);
}

function turnToward(from, to, max) {
  return from + Math.max(-max, Math.min(max, wrapAngle(to - from)));
}

const approach = (v, to, max) => (v < to ? Math.min(to, v + max) : Math.max(to, v - max));

// World units per full stride. Legs matching the ground going by are most of "not sliding around".
const STRIDE = {
  [ACTOR.PIPSQUEAK]: 34, [ACTOR.SLINGER]: 52, [ACTOR.LOBBER]: 36, [ACTOR.BRUISER]: 56,
  [ACTOR.SLEDDER]: 40, [ACTOR.LIDKID]: 42, [ACTOR.SNEAK]: 54,
};

// Top of the head, for stars and snores.
const HEAD_TOP = {
  [ACTOR.KID]: 43, [ACTOR.PIPSQUEAK]: 42, [ACTOR.SLINGER]: 50, [ACTOR.LOBBER]: 46, [ACTOR.BRUISER]: 74,
  [ACTOR.SLEDDER]: 44, [ACTOR.LIDKID]: 44, [ACTOR.SNEAK]: 34, [ACTOR.STEVE]: 134,
};

const STAR_BOX = Object.freeze({ w: 12, h: 12, ax: 6, ay: 6 });
const LID_BOX = Object.freeze({ w: 46, h: 46, ax: 23, ay: 23 });
const LID_STEPS = 24;
const CONE_STEPS = 32;
const TRUCK_STEPS = 24;
const FLAG_BOX = Object.freeze({ w: 30, h: 36, ax: 4, ay: 32 });
const BOARD_BOX = Object.freeze({ w: 64, h: 44, ax: 32, ay: 22 });
const SLUSH_BOX = Object.freeze({ w: 36, h: 18, ax: 18, ay: 9 });
const LID_ARM = '#b98b3e';
const PAT_CYCLE = Object.freeze([0, 1, 2, 1]);
const WRECK_TIME = 3;
const anchor = { x: 0, y: 0 };

const paintStar = (ctx) => star5(ctx, 0, 0, 4.4, '#ffd76a');

function paintSlush(ctx) {
  ell(ctx, 0, 0, 15, 5.4, alpha('#8fb6d6', 0.65));
  ell(ctx, -6, -1, 5, 1.8, 'rgba(255,255,255,0.6)');
  ell(ctx, 7, 1, 3.4, 1.3, 'rgba(255,255,255,0.45)');
}

// Steve's limbs hang from fixed points on his body. His art is never mirrored because of the name tag,
// so westward facings negate these offsets instead.
const STEVE_LAYOUT = Array.from({ length: 8 }, (_, d) => {
  const west = d >= 3 && d <= 5 ? -1 : 1;
  if (d === 0 || d === 4) return { a: west * -5, b: west * 8, bFront: false, footGap: 9, swing: 1 };
  if (d % 2) return { a: west * -24, b: west * 31, bFront: true, footGap: 19, swing: 0.4 };
  return { a: -30, b: 30, bFront: true, footGap: 21, swing: 0 };
});

// LOCKED kids have stopped playing. The ones who won get to celebrate, from what the meta already says.
function kidWon(a, meta) {
  if (!meta) return false;
  const cols = meta.colonels;
  if (!cols || cols.length === 0) return meta.leaderId === a.id;
  let mine = -1, best = -1;
  for (const c of cols) {
    const f = c.hp / (c.mhp || 1);
    if (c.team === a.team) mine = f;
    else if (f > best) best = f;
  }
  return mine > 0 && mine > best;
}

export class ActorArt {
  constructor(opts = {}) {
    this.atlas = new SpriteAtlas({ scale: opts.scale ?? 2 });
    this.states = new Map();
    this.frameTime = -1;
    this.pruneAt = 0;
    this.ballsPrev = new Set();
    this.ballsNow = new Set();
    this.lookSlots = new Map();
  }

  setScale(s) {
    this.atlas.setScale(s);
  }

  forget(id) {
    this.states.delete(id);
  }

  // The renderer redraws teammates for its x-ray pass, so simulation advances once per frame time.
  _step(st, time, dt) {
    st.seen = time;
    if (time <= st.stepped) return 0;
    const step = Math.min(dt > 0 ? dt : time - st.stepped, 0.1);
    st.stepped = time;
    return step;
  }

  _beginFrame(time, view) {
    if (time === this.frameTime) return;
    this.frameTime = time;
    this.atlas.tick();
    this._scanBalls(view);
    if (time >= this.pruneAt) {
      // forget() is the normal path; this catches actors that left while nobody was drawing them.
      this.pruneAt = time + 5;
      for (const [id, st] of this.states) if (time - st.seen > 8) this.states.delete(id);
    }
  }

  // Balls in the view carry no thrower, but a ball's first sighting is right at the hand that threw
  // it. That is enough to play foe arm animations without any extra plumbing from the renderer.
  _scanBalls(view) {
    const balls = view?.balls;
    if (!balls) return;
    const now = this.ballsNow, prev = this.ballsPrev;
    now.clear();
    for (const b of balls) {
      now.add(b.id);
      if (prev.has(b.id) || b.mine) continue;
      const boss = b.kind === BALL.CONE || b.kind === BALL.BOULDER;
      let best = null, bestD = 60 * 60;
      for (const a of view.actors ?? []) {
        if (a.kind === ACTOR.TRUCK || a.kind === ACTOR.STEVE) {
          if (boss) { best = a; break; }
          continue;
        }
        const dx = a.x - b.x, dy = a.y - b.y;
        const d = dx * dx + dy * dy;
        if (d < bestD) { best = a; bestD = d; }
      }
      // Kids are in the race so a teammate's throw isn't credited to the foe beside them. Their own arm
      // animation comes from the CHARGING flag instead.
      if (!best || best.kind === ACTOR.KID) continue;
      const st = this.states.get(best.id);
      if (!st) continue;
      if (best.kind === ACTOR.TRUCK) st.recoil = 1;
      else if (best.kind === ACTOR.STEVE) st.heaveT = HEAVE_TIME;
      else st.throwT = THROW_TIME;
    }
    this.ballsNow = prev;
    this.ballsPrev = now;
  }

  draw(ctx, a, info = {}) {
    const time = info.time ?? 0;
    this._beginFrame(time, info.view);
    let st = this.states.get(a.id);
    if (!st) {
      st = newState(a, time);
      this.states.set(a.id, st);
    }
    const step = this._step(st, time, info.dt ?? 0);
    switch (a.kind) {
      case ACTOR.KID: this._kid(ctx, a, info, st, step, time); break;
      case ACTOR.TRUCK: this._truck(ctx, a, st, step, time); break;
      case ACTOR.STEVE: this._steve(ctx, a, st, step, time); break;
      default: this._foe(ctx, a, st, step, time);
    }
  }

  _reactions(a, st, step) {
    if (a.hp < st.hp - 0.002) {
      st.hitT = HIT_TIME;
      st.flashT = FLASH_TIME;
      st.sqv -= 5;
    }
    st.hp = a.hp;
    st.hitT = Math.max(0, st.hitT - step);
    st.flashT = Math.max(0, st.flashT - step);
    st.throwT = Math.max(0, st.throwT - step);
    st.lobT = Math.max(0, st.lobT - step);
    // Underdamped on purpose: the single overshoot is what makes a hit feel rubbery rather than scaled.
    st.sqv += (-st.sq * 190 - st.sqv * 15) * step;
    st.sq += st.sqv * step;
  }

  _flash(ctx, st, key, box, paint, strength, x, y, flip, sx, sy) {
    const keep = ctx.globalAlpha;
    ctx.globalAlpha = keep * (st.flashT / FLASH_TIME) * strength;
    blit(ctx, this.atlas.flashOf(key, box, paint), x, y, flip, sx, sy);
    ctx.globalAlpha = keep;
  }

  _stars(ctx, x, y, time, r) {
    const e = this.atlas.get(K_STAR, STAR_BOX, paintStar);
    for (let i = 0; i < 3; i++) {
      const t = time * 5.2 + (i * TAU) / 3;
      blit(ctx, e, x + Math.cos(t) * r, y + Math.sin(t) * r * 0.36);
    }
  }

  _snore(ctx, x, y, time) {
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 1.5;
    for (let i = 0; i < 2; i++) {
      const t = (time * 0.6 + i * 0.5) % 1;
      const s = 3 + t * 2.4;
      const px = x + 8 + t * 9, py = y - t * 15;
      ctx.strokeStyle = alpha('#564c7c', 1 - t);
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.lineTo(px + s, py);
      ctx.lineTo(px, py + s);
      ctx.lineTo(px + s, py + s);
      ctx.stroke();
    }
  }

  // ---- kids ----------------------------------------------------------------------------------------

  // Everything derived from a look, redone only when the look changes rather than sixty times a second.
  _kidLook(st, look, teamColor, team) {
    const sig = ((((look.hat | 0) * 8 + (look.coat | 0)) * 8 + (look.scarf | 0)) * 8 + (look.skin | 0)) * 4 + (teamColor ? team + 1 : 0);
    if (sig === st.sig) return;
    st.sig = sig;
    const name = kidKey(look, teamColor);
    let slot = this.lookSlots.get(name);
    if (slot === undefined) {
      slot = this.lookSlots.size + 1;
      this.lookSlots.set(name, slot);
    }
    st.slot = slot;
    st.C = kidColors(look, teamColor);
    st.tipColor = tone(st.C.scarf, 0.45);
    st.backColor = tone(st.C.scarf, -0.2);
  }

  _kid(ctx, a, info, st, step, time) {
    const fl = a.flags;
    const was = st.flags;
    const atlas = this.atlas;
    const look = info.player?.look ?? DEFAULT_LOOK;
    const view = info.view;
    const teamColor = view?.mode === MODE.FORTWARS ? teamColorOf(a.team) : null;
    this._kidLook(st, look, teamColor, a.team);
    this._reactions(a, st, step);
    const held = AFLAG.FROZEN | AFLAG.STUNNED;
    if ((was & AFLAG.CHARGING) && !(fl & AFLAG.CHARGING) && !(fl & held)) {
      st.throwT = THROW_TIME;
      st.sqv += 3.4;
    }
    if ((was & AFLAG.LOBAIM) && !(fl & AFLAG.LOBAIM) && !(fl & held)) {
      st.lobT = THROW_TIME;
      st.sqv += 3.4;
    }
    st.flags = fl;

    const vx = a.vx || 0, vy = a.vy || 0;
    const speed = Math.hypot(vx, vy);
    let pose = 'idle', frame = 0;
    st.dir = holdDir(st.dir, a.aim || 0);
    if (fl & AFLAG.FROZEN) {
      pose = 'frozen';
      frame = Math.min(3, Math.floor(((a.aux || 0) / 256) * 4));
    } else if (fl & AFLAG.SLIDING) {
      pose = 'slide';
      frame = Math.floor(time * 14) & 1;
      if (speed > 1) st.dir = dir8(Math.atan2(vy, vx));
    } else if (st.hitT > 0) {
      pose = 'hit';
    } else if (fl & AFLAG.STUNNED) {
      pose = 'stun';
      frame = Math.floor(time * 5) & 1;
    } else if (fl & AFLAG.CHARGING) {
      pose = 'charge';
      frame = Math.min(3, Math.floor(((a.aux || 0) / 256) * 4));
    } else if (fl & AFLAG.LOBAIM) {
      pose = 'lobaim';
      frame = Math.floor(time * 4) % 3;
    } else if (st.throwT > 0) {
      pose = 'throw';
      frame = Math.min(2, Math.floor((1 - st.throwT / THROW_TIME) * 3));
    } else if (st.lobT > 0) {
      pose = 'lob';
      frame = Math.min(2, Math.floor((1 - st.lobT / THROW_TIME) * 3));
    } else if ((fl & AFLAG.LOCKED) && kidWon(a, view?.meta)) {
      pose = 'cheer';
      frame = Math.floor((time + a.id * 0.37) * 5) & 1;
    } else if (fl & AFLAG.PACKING) {
      pose = 'pack';
      frame = PAT_CYCLE[Math.floor(time * 9) & 3];
    } else if (fl & AFLAG.BOARDING) {
      pose = 'ride';
      frame = Math.floor(time * 4) & 1;
    } else if (speed > COAST_SPEED) {
      pose = 'walk';
      st.walk = (st.walk + (speed * step) / 62) % 1;
      frame = Math.floor(st.walk * 6);
    } else {
      // Mostly still with a slow breath and a blink every few seconds, staggered per kid.
      const t = time + a.id * 0.73;
      frame = (t % 3.4) < 0.13 ? 2 : (Math.floor(t * 1.6) & 1);
    }

    const dir = st.dir;
    const base = dirBase(dir), flip = dirFlip(dir);
    const key = F_KID + (st.slot << 10) + (KID_POSE_ID[pose] << 6) + (frame << 3) + base;
    let e = atlas.peek(key);
    if (!e) e = atlas.get(key, KID_BOX, (c) => paintKid(c, look, teamColor, pose, frame, base));

    const prevAlpha = ctx.globalAlpha;
    // GRACE flickers so friends can see the kid can't be hit yet.
    if (fl & AFLAG.GRACE) ctx.globalAlpha = prevAlpha * (0.6 + 0.3 * Math.sin(time * 22));
    if (fl & AFLAG.SLOWED) blit(ctx, atlas.get(K_SLUSH, SLUSH_BOX, paintSlush), a.x, a.y);

    const frozen = pose === 'frozen';
    const tailed = !frozen && pose !== 'slide';
    tailAnchor(anchor, base, poseCrouch(pose), poseLean(pose));
    if (!st.tailA) {
      st.tailA = makeTail(17);
      st.tailB = makeTail(12.5);
    }
    const sx = 1 - st.sq * 0.75, sy = 1 + st.sq;
    const ox = flip ? -anchor.x : anchor.x;
    const tailX = a.x + ox * sx, tailY = a.y + anchor.y * sy;
    const scarf = st.C.scarf;
    let front = false;
    if (tailed) {
      if (step > 0) {
        // The two tails lean apart so they read as a pair instead of one thick stripe.
        const out = ox >= 0 ? 1 : -1;
        stepTail(st.tailA, -vx, -vy, step, time, a.id, out * 10);
        stepTail(st.tailB, -vx, -vy, step, time, a.id + 2, -out * 8);
      }
      // A tail streaming up the screen is behind the kid; one hanging or streaming down is in front.
      front = st.tailA.y[TAIL_POINTS - 1] > -1;
      if (!front) {
        strokeTail(ctx, st.tailB, tailX, tailY, st.backColor, st.tipColor, 3.1);
        strokeTail(ctx, st.tailA, tailX, tailY, scarf, st.tipColor, 3.6);
      }
    }

    if ((fl & AFLAG.BOARDING) && tailed) {
      if (speed > 20) st.heading = Math.atan2(vy, vx);
      const bi = ((Math.round(st.heading / (TAU / 16)) % 16) + 16) % 16;
      const bk = F_BOARD + (st.slot << 4) + bi;
      const be = atlas.peek(bk) ?? atlas.get(bk, BOARD_BOX, (c) => paintBoard(c, (bi / 16) * TAU, boardColors(look, teamColor)));
      blit(ctx, be, a.x, a.y);
    }

    blit(ctx, e, a.x, a.y, flip, sx, sy);
    if (st.flashT > 0) {
      this._flash(ctx, st, key, KID_BOX, (c) => paintKid(c, look, teamColor, pose, frame, base), 0.85, a.x, a.y, flip, sx, sy);
    }

    if (front && tailed) {
      strokeTail(ctx, st.tailB, tailX, tailY, st.backColor, st.tipColor, 3.1);
      strokeTail(ctx, st.tailA, tailX, tailY, scarf, st.tipColor, 3.6);
    }
    if (pose === 'stun') this._stars(ctx, a.x, a.y - HEAD_TOP[ACTOR.KID], time, 13);
    if (fl & AFLAG.AFK) this._snore(ctx, a.x, a.y - HEAD_TOP[ACTOR.KID], time);
    ctx.globalAlpha = prevAlpha;
  }

  // ---- regular foes --------------------------------------------------------------------------------

  _foe(ctx, a, st, step, time) {
    const fl = a.flags;
    // The sim can get ahead of the art: an unknown kind is drawn as a Pipsqueak, not as a crash.
    const kind = FOE_BOX[a.kind] ? a.kind : ACTOR.PIPSQUEAK;
    const atlas = this.atlas;
    this._reactions(a, st, step);
    if ((st.flags & AFLAG.SLEDDING) && !(fl & AFLAG.SLEDDING)) {
      st.wreckT = WRECK_TIME;
      st.wreckX = a.x;
      st.wreckY = a.y;
      st.wreckDir = st.dir;
    }
    st.flags = fl;
    const vx = a.vx || 0, vy = a.vy || 0;
    const speed = Math.hypot(vx, vy);
    const moving = speed > COAST_SPEED;
    const carrying = kind === ACTOR.SNEAK && (a.aux & AUX.NOSE) !== 0;
    const fleeing = (fl & AFLAG.FLEEING) !== 0;
    const sledding = kind === ACTOR.SLEDDER && (fl & AFLAG.SLEDDING) !== 0;

    let name = 'idle', frame = 0;
    if (moving) st.walk = (st.walk + (speed * step) / (STRIDE[kind] ?? 42)) % 1;
    if (sledding) {
      name = fleeing ? 'sledflee' : 'sled';
      frame = Math.floor(time * 8) & 1;
    } else if (fleeing) {
      name = 'flee';
      frame = Math.floor(st.walk * 4);
    } else if (st.hitT > 0) {
      name = 'hit';
    } else if (fl & AFLAG.STUNNED) {
      name = 'stun';
      frame = Math.floor(time * 5) & 1;
    } else if (st.throwT > 0) {
      name = 'throw';
      frame = st.throwT > THROW_TIME / 2 ? 0 : 1;
    } else if (moving) {
      name = 'walk';
      frame = Math.floor(st.walk * 4);
    } else {
      frame = Math.floor((time + a.id * 0.31) * 1.7) & 1;
    }

    // Walkers face where they are going, shooters face their target, and a hit doesn't spin anyone.
    if (name !== 'hit') st.dir = holdDir(st.dir, moving && name !== 'throw' ? Math.atan2(vy, vx) : (a.aim || 0));
    const dir = st.dir;
    const base = dirBase(dir), flip = dirFlip(dir);
    const key = F_FOE + (kind << 12) + (FOE_POSE_ID[name] << 8) + (frame << 4) + (base << 1) + (carrying ? 1 : 0);
    const box = sledding ? SLED_BOX : FOE_BOX[kind];
    let e = atlas.peek(key);
    if (!e) e = atlas.get(key, box, (c) => paintFoe(c, kind, name, frame, base, carrying));

    const prevAlpha = ctx.globalAlpha;
    if (fl & AFLAG.GRACE) ctx.globalAlpha = prevAlpha * (0.55 + 0.3 * Math.sin(time * 22));
    if (fl & AFLAG.SLOWED) blit(ctx, atlas.get(K_SLUSH, SLUSH_BOX, paintSlush), a.x, a.y);

    if (st.wreckT > 0) this._wreck(ctx, st, step, prevAlpha);

    const lidded = kind === ACTOR.LIDKID && !fleeing;
    const aim = a.aim || 0;
    const lidBehind = lidded && Math.sin(aim) < -0.1;
    if (lidBehind) this._lid(ctx, a, aim);

    const sx = 1 - st.sq * 0.75, sy = 1 + st.sq;
    blit(ctx, e, a.x, a.y, flip, sx, sy);
    if (st.flashT > 0) {
      this._flash(ctx, st, key, box, (c) => paintFoe(c, kind, name, frame, base, carrying), 0.85, a.x, a.y, flip, sx, sy);
    }
    if (lidded && !lidBehind) this._lid(ctx, a, aim);
    if (name === 'stun') this._stars(ctx, a.x, a.y - (HEAD_TOP[kind] ?? 44), time, 12);
    ctx.globalAlpha = prevAlpha;
  }

  // A crashed sled stays where it stopped for a moment, so the kid visibly climbs off something.
  _wreck(ctx, st, step, prevAlpha) {
    st.wreckT = Math.max(0, st.wreckT - step);
    const d = st.wreckDir, base = dirBase(d);
    const e = this.atlas.get(K_WRECK + base, SLED_BOX, (c) => paintSled(c, DIR_ANGLE[base]));
    const keep = ctx.globalAlpha;
    ctx.globalAlpha = prevAlpha * Math.min(1, st.wreckT);
    blit(ctx, e, st.wreckX, st.wreckY, dirFlip(d), 1, 1, 0.08);
    ctx.globalAlpha = keep;
  }

  // The lid is held out at arm's length on its own bearing. The arm is live because it has to reach a
  // lid the body isn't facing, which no fixed sprite frame could.
  _lid(ctx, a, aim) {
    const n = ((Math.round(aim / (TAU / LID_STEPS)) % LID_STEPS) + LID_STEPS) % LID_STEPS;
    const key = F_LID + n;
    const e = this.atlas.peek(key) ?? this.atlas.get(key, LID_BOX, (c) => paintLid(c, (n / LID_STEPS) * TAU));
    const c = Math.cos(aim), s = Math.sin(aim);
    const cx = a.x + c * 16, cy = a.y - 15 + s * 7;
    capsule(ctx, a.x + c * 5, a.y - 18 + s * 2, 3.2, cx, cy, 2.8, LID_ARM);
    blit(ctx, e, cx, cy);
  }

  // ---- The Sno-Cone Truck --------------------------------------------------------------------------

  _truck(ctx, a, st, step, time) {
    const atlas = this.atlas;
    this._reactions(a, st, step);
    const vx = a.vx || 0, vy = a.vy || 0;
    const speed = Math.hypot(vx, vy);
    if (speed > 6) st.heading = turnToward(st.heading, Math.atan2(vy, vx), 3 * step + 0.001);
    const want = (a.aux & AUX.DOORS) !== 0 ? 1 : 0;
    st.door = approach(st.door, want, step * 2.6);
    st.recoil = approach(st.recoil, 0, step * 4.5);

    const raw = ((Math.round(st.heading / (TAU / TRUCK_STEPS)) % TRUCK_STEPS) + TRUCK_STEPS) % TRUCK_STEPS;
    const quarter = TRUCK_STEPS / 4;
    // The van is symmetric port and starboard, so west-facing headings are mirrors of east-facing ones.
    const westward = raw > quarter && raw < quarter * 3;
    const idx = westward ? (TRUCK_STEPS / 2 - raw + TRUCK_STEPS) % TRUCK_STEPS : raw;
    const paintedH = (idx / TRUCK_STEPS) * TAU;
    const trueH = (raw / TRUCK_STEPS) * TAU;
    const open = st.door > 0.01;
    const key = F_TRUCK + (idx << 1) + (open ? 1 : 0);
    const box = truckBox(paintedH);
    const paint = (c) => paintTruck(c, paintedH, open);
    const e = atlas.get(key, box, paint);

    const rattle = speed > 6 ? Math.sin(time * 19) * 0.55 : 0;
    const x = a.x, y = a.y + rattle;
    const rearNear = rearFacesCamera(trueH);
    if (open && !rearNear) paintDoorLeaves(ctx, trueH, x, y, st.door, 1);
    const sx = 1 - st.sq * 0.2, sy = 1 + st.sq * 0.3;
    blit(ctx, e, x, y, westward, sx, sy);
    if (st.flashT > 0) this._flash(ctx, st, key, box, paint, 0.5, x, y, westward, sx, sy);
    if (open && rearNear) paintDoorLeaves(ctx, trueH, x, y, st.door, 1);

    const seat = coneSeat(trueH);
    const aim = a.aim || 0;
    const ci = ((Math.round(aim / (TAU / CONE_STEPS)) % CONE_STEPS) + CONE_STEPS) % CONE_STEPS;
    const ck = F_CONE + ci;
    const ce = atlas.peek(ck) ?? atlas.get(ck, CONE_BOX, (c) => paintCone(c, (ci / CONE_STEPS) * TAU));
    const kick = st.recoil * 7;
    blit(ctx, ce, x + seat.x - Math.cos(aim) * kick, y + seat.y - Math.sin(aim) * kick * 0.6 + st.recoil * 2, false, 1 + st.recoil * 0.08, 1 - st.recoil * 0.12);
    if (a.flags & AFLAG.FLEEING) {
      // Even a truck knows when it's beaten.
      const f = Math.floor(time * 6) & 1;
      const fe = atlas.get(K_FLAG + f, FLAG_BOX, (c) => paintFleeFlag(c, f));
      blit(ctx, fe, x + seat.x + 20, y + seat.y - 30);
    }
  }

  // ---- Abominable Steve ----------------------------------------------------------------------------

  _steve(ctx, a, st, step, time) {
    const atlas = this.atlas;
    const fl = a.flags;
    this._reactions(a, st, step);
    const winding = (a.aux & AUX.POUND) !== 0;
    const wasWinding = (st.aux & AUX.POUND) !== 0;
    if (wasWinding && !winding) {
      st.slamT = SLAM_TIME;
      st.sqv -= 7;
    }
    st.aux = a.aux;
    st.wind = winding ? Math.min(1, st.wind + step / BOSS.steve.poundTelegraph) : Math.max(0, st.wind - step * 5);
    st.slamT = Math.max(0, st.slamT - step);
    st.heaveT = Math.max(0, st.heaveT - step);

    if (fl & AFLAG.FLEEING) {
      if (!(st.flags & AFLAG.FLEEING)) st.sqv -= 7; // the plop as he finally sits down
      st.flags = fl;
      this._steveSits(ctx, a, st, time);
      return;
    }
    st.flags = fl;

    const enraged = (fl & AFLAG.ENRAGED) !== 0;
    const vx = a.vx || 0, vy = a.vy || 0;
    const speed = Math.hypot(vx, vy);
    const moving = speed > 6;
    if (moving) st.walk = (st.walk + (speed * step) / 120) % 1;
    st.dir = holdDir(st.dir, moving ? Math.atan2(vy, vx) : (a.aim || 0));
    const dir = st.dir;
    const L = STEVE_LAYOUT[dir];

    const blinking = (time + 1.3) % 4.2 < 0.16;
    const mood = st.wind > 0.05 || st.slamT > 0.15 ? 'strain'
      : enraged ? (blinking ? 'madblink' : 'mad')
        : blinking ? 'blink' : 'tired';
    const key = F_STEVE + (dir << 4) + STEVE_MOOD_ID[mood];
    const paintBody = (c) => paintSteveBody(c, dir, mood);
    const body = atlas.get(key, STEVE_BODY_BOX, paintBody);
    const arm = atlas.get(K_ARM, STEVE_ARM_BOX, paintSteveArm);
    const foot = atlas.get(K_FOOT, STEVE_FOOT_BOX, paintSteveFoot);

    const p = st.walk * TAU;
    const swing = moving ? Math.sin(p) : 0;
    const lift = moving ? Math.cos(p) : 0;
    // Slow breath at rest, a wide weary roll on the move, and when enraged he trembles.
    const breathe = moving ? 0 : Math.sin(time * 1.6) * 0.012;
    const tremble = enraged ? Math.sin(time * 37) * 0.8 : 0;
    const slam = st.slamT / SLAM_TIME;
    const wind = st.wind;
    const stretch = wind * 0.05 - (slam > 0 ? slam * slam * 0.1 : 0);
    const bodyLift = Math.abs(lift) * 2.6;

    ctx.save();
    ctx.translate(a.x + tremble, a.y);

    // Feet carry the gait; in profile they stride fore and aft, head-on they lift in turn.
    const stride = 15 * L.swing;
    blit(ctx, foot, L.footGap - swing * stride, Math.max(0, -lift) * -7 + 1);
    blit(ctx, foot, -L.footGap + swing * stride, Math.max(0, lift) * -7 + 3);

    const pivotY = -71 - bodyLift;
    const pose = { arm, st, wind, slam, swing, reach: 0.4 + L.swing };
    if (!L.bFront) steveArm(ctx, L.b, pivotY, pose);

    ctx.save();
    ctx.translate(0, -bodyLift);
    ctx.rotate(swing * 0.06);
    const sq = st.sq + stretch;
    ctx.scale(1 - sq * 0.7 - breathe * 0.5, 1 + sq + breathe);
    blit(ctx, body, 0, 0);
    if (st.flashT > 0) this._flash(ctx, st, key, STEVE_BODY_BOX, paintBody, 0.55, 0, 0);
    ctx.restore();

    steveArm(ctx, L.a, pivotY, pose);
    if (L.bFront) steveArm(ctx, L.b, pivotY, pose);
    ctx.restore();

    if (enraged) this._steam(ctx, a.x, a.y - 112, time);
    if (fl & AFLAG.STUNNED) this._stars(ctx, a.x, a.y - HEAD_TOP[ACTOR.STEVE], time, 26);
  }

  // Puffs off the top of an overheated yeti. Plain fills: four small ellipses, one boss.
  _steam(ctx, x, y, time) {
    for (let i = 0; i < 4; i++) {
      const t = (time * 0.9 + i * 0.25) % 1;
      const side = i % 2 ? 1 : -1;
      ell(ctx, x + side * (18 + t * 16), y + 8 - t * 24, 3 + t * 5, 2.6 + t * 4.4, `rgba(255,255,255,${0.75 * (1 - t)})`);
    }
  }

  _steveSits(ctx, a, st, time) {
    const frame = Math.floor(time * 1.2) & 1;
    const e = this.atlas.get(K_SIT + frame, STEVE_SIT_BOX, (c) => paintSteveSitting(c, frame));
    blit(ctx, e, a.x, a.y, false, 1 - st.sq * 0.6, 1 + st.sq);
    for (let i = 0; i < 3; i++) {
      const t = (time * 0.55 + i / 3) % 1;
      const wob = Math.sin(t * 7 + i * 2) * 3;
      ell(ctx, a.x + wob, a.y - 42 - t * 34, 2.6 + t * 3.4, 2.2 + t * 2.6, `rgba(255,255,255,${0.7 * (1 - t)})`);
    }
  }

  // ---- Colonel Carrot ------------------------------------------------------------------------------

  drawColonel(ctx, s, info = {}) {
    const time = info.time ?? 0;
    const view = info.view;
    this._beginFrame(time, view);
    const atlas = this.atlas;
    let st = this.states.get(s.id);
    if (!st) {
      st = {
        seen: time, stepped: time - 1 / 60, hp: s.hp, hitT: 0, flashT: 0, sq: 0, sqv: 0,
        lookX: 0, lookY: 0.2, tier: tierOf(s.hp / (s.maxHp || 1)), bits: [], bucketY: 0, bucketV: 0,
      };
      this.states.set(s.id, st);
    }
    const step = this._step(st, time, info.dt ?? 0);

    const x = (s.cx + 1) * CELL, y = s.cy * CELL + COLONEL_FOOT_Y;
    const tier = tierOf(Math.max(0, s.hp / (s.maxHp || 1)));

    if (s.hp < st.hp - 0.5) {
      st.hitT = 0.34;
      st.flashT = FLASH_TIME;
      st.sqv -= 3.2;
      st.bucketV -= 62;
    }
    st.hp = s.hp;
    // Each lost threshold throws one piece of him onto the snow, so damage is an event and not a swap.
    while (st.tier < tier) {
      st.tier++;
      const side = st.tier % 2 ? 1 : -1;
      st.bits.push({
        x: side * (6 + st.tier), y: HEAD_Y + 12 + st.tier * 3, vx: side * (40 + st.tier * 6), vy: -120,
        rot: 0, vr: side * 9, life: 0.9, kind: TIER_LOSS[st.tier - 1],
      });
    }
    if (st.tier > tier) st.tier = tier; // patched between waves: his bits go back on

    st.hitT = Math.max(0, st.hitT - step);
    st.flashT = Math.max(0, st.flashT - step);
    st.sqv += (-st.sq * 240 - st.sqv * 17) * step;
    st.sq += st.sqv * step;
    st.bucketV += (-st.bucketY * 420 - st.bucketV * 22) * step;
    st.bucketY += st.bucketV * step;

    // Find the nose thief or the nearest enemy. A carrier outranks everything: that is his nose.
    let threat = null, best = Infinity, noseGone = false;
    const actors = view?.actors;
    if (actors) {
      for (const a of actors) {
        if (a.team === s.team || (a.flags & (AFLAG.FLEEING | AFLAG.FROZEN))) continue;
        const dx = a.x - x, dy = a.y - (y - 70);
        let d = dx * dx + dy * dy;
        if (a.kind === ACTOR.SNEAK && (a.aux & AUX.NOSE)) {
          noseGone = true;
          d = -1;
        }
        if (d < best) { best = d; threat = a; }
      }
    }
    let tx, ty;
    if (threat) {
      const dx = threat.x - x, dy = threat.y - (y - 70);
      const d = Math.hypot(dx, dy) || 1;
      tx = dx / d;
      ty = dy / d;
    } else {
      // Nothing to glare at: he inspects the troops, slowly.
      tx = Math.sin(time * 0.5 + s.id) * 0.55;
      ty = 0.28;
    }
    const k = Math.min(1, step * 9);
    st.lookX += (tx - st.lookX) * k;
    st.lookY += (ty - st.lookY) * k;

    const squint = st.hitT > 0;
    const breathe = Math.sin(time * 1.5 + s.id) * 0.007;
    const sy = 1 + st.sq + breathe, sx = 1 - st.sq * 0.8 - breathe * 0.5;
    const curTier = st.tier;
    const key = F_COLONEL + ((s.team & 255) << 4) + curTier;
    const paintBody = (c) => paintColonelBody(c, curTier, s.team);
    const e = atlas.get(key, COLONEL_BOX, paintBody);

    ctx.save();
    ctx.translate(x, y);
    ctx.scale(sx, sy);
    if (st.hitT > 0) ctx.rotate(Math.sin(st.hitT * 42) * 0.018);
    blit(ctx, e, 0, 0);

    paintFaceLive(ctx, 0, HEAD_Y, st.lookX, st.lookY, {
      squint, shock: noseGone && !squint, noNose: noseGone, worry: curTier >= 3,
    });

    // Bucket: slips further down one side as he takes damage, and hops when he is hit.
    const tilt = curTier >= 5 ? 0.3 : curTier >= 3 ? 0.14 : 0;
    const bucket = atlas.get(F_BUCKET + curTier, BUCKET_BOX, (c) => paintBucket(c, curTier));
    blit(ctx, bucket, tilt * 12, HEAD_Y - 10 + tilt * 9 + st.bucketY * 0.05, false, 1, 1, tilt);

    // Arms. The left is the one that snaps; the right never stops saluting unless his nose is gone.
    paintColonelArm(ctx, 19, -56, 30, -46, 25, -34, curTier >= 3);
    const flinch = st.hitT > 0 ? st.hitT / 0.34 : 0;
    const droop = curTier >= 6 ? 9 : curTier >= 4 ? 3 : 0;
    if (noseGone) {
      // Fist in the air, shaking: "you bring that back".
      paintColonelArm(ctx, -19, -56, -33, -62, -36 + Math.sin(time * 24) * 2.2, -82, false);
    } else {
      paintColonelArm(ctx, -19, -56, -31, -67 + droop * 0.4 + flinch * 7, -15 - flinch * 6, -85 + droop + flinch * 16, false);
    }

    for (const b of st.bits) {
      if (step > 0) {
        b.life -= step;
        b.vy += 620 * step;
        b.x += b.vx * step;
        b.y += b.vy * step;
        b.rot += b.vr * step;
        if (b.y > -4) { b.y = -4; b.vy *= -0.3; b.vx *= 0.5; b.vr *= 0.5; }
      }
      paintFallingBit(ctx, b.x, b.y, b.kind, b.rot);
    }
    if (st.bits.length && st.bits[0].life <= 0) st.bits.shift();

    if (st.flashT > 0) this._flash(ctx, st, key, COLONEL_BOX, paintBody, 0.6, 0, 0);
    ctx.restore();
  }
}

function steveArm(ctx, x, pivot, pose) {
  const { arm, st, wind, slam, swing, reach } = pose;
  const out = x < 0 ? 1 : -1;
  const hang = 0.26 * out + swing * (x < 0 ? 0.26 : -0.26) * reach;
  const raised = out * 2.86;
  const down = out * 0.5;
  let ang = hang + (raised - hang) * Math.min(1, wind * wind * (3 - 2 * wind));
  if (slam > 0) ang = down + (hang - down) * (1 - slam) * 0.6;
  if (st.heaveT > 0) {
    const h = Math.sin((1 - st.heaveT / HEAVE_TIME) * Math.PI);
    ang += (raised * 0.7 - ang) * h;
  }
  if (st.hitT > 0) ang += out * 0.25;
  blit(ctx, arm, x * (1 - (slam > 0 ? slam * 0.25 : 0)), pivot, false, 1, 1, ang);
}
