// Fort Flurry — the chibi rig shared by kids and foes.
// A pose is written once in body space (forward, right, up) and projected for whichever way the
// character faces, so all eight facings come from one definition. Foes reuse this rig through hooks,
// which is what keeps a Pipsqueak and a player's kid looking like they live in the same book.

import { LOOK, DEFAULT_LOOK, TEAM_STYLE } from '../../shared/constants.js';
import {
  TAU, INK, ICE, ICE_HI, ICE_DEEP, GOLD, GOLD_LO, CREAM,
  ell, line, curve, capsule, litFill, linGrad, tone, mix, alpha, clipped, snowball, seeded, poly,
} from './sprite-paint.js';

// Five painted facings; the three westward ones are mirror blits.
export const DIR_ANGLE = [0, Math.PI / 4, Math.PI / 2, -Math.PI / 4, -Math.PI / 2];
const DIR8_BASE = [0, 1, 2, 1, 0, 3, 4, 3];
const DIR8_FLIP = [false, false, false, true, true, true, false, false];

export function dir8(angle) {
  return ((Math.round(angle / (Math.PI / 4)) % 8) + 8) % 8;
}
export const dirBase = (d) => DIR8_BASE[d];
export const dirFlip = (d) => DIR8_FLIP[d];

// How much the sprite plane shows the ground. The world is unsquashed, but a little body looks wrong
// with that much depth: at 1.0 a walking kid's feet would travel further on screen than its height.
const DEPTH = 0.5;

export const KID_DIMS = Object.freeze({
  R: 10.4, headU: 29, neckU: 21.5, shoulderU: 18, shoulderR: 10.2, hipU: 7, hipR: 4.6, footR: 5,
  torso: [[12.2, 8, 5.2], [12, 13, 5.2], [10.6, 18, 4.8]],
  arm: [3.9, 3.1], mitt: 3.5, leg: [3.8, 3.2], crouch: 6,
});

export const KID_BOX = Object.freeze({ w: 64, h: 70, ax: 32, ay: 58 });

export function makeRig(dims, pose) {
  const th = pose.th ?? Math.PI / 2;
  const c = Math.cos(th), s = Math.sin(th);
  const P = (f, r, u) => [f * c - r * s, (f * s + r * c) * DEPTH - u];
  const dep = (f, r) => f * s + r * c;
  const crouch = pose.crouch || 0, lean = pose.lean || 0, side = pose.side || 0, bob = pose.bob || 0;
  const drop = crouch * dims.crouch;
  const up = (u) => u - drop + bob;
  const headAt = P(lean, side, up(dims.headU));
  const rig = {
    th, c, s, P, dep, pose, dims, lean, side, crouch, drop, up,
    back: s < -0.3,
    R: dims.R, hx: headAt[0], hy: headAt[1],
    chest: P(lean * 0.55, side * 0.55, up(dims.shoulderU)),
    belly: P(lean * 0.25, side * 0.25, up(dims.torso[0][1])),
    neck: P(lean * 0.8, side * 0.8, up(dims.neckU)),
    hand: { L: pose.handL, R: pose.handR },
    foot: { L: pose.footL, R: pose.footR },
  };
  return rig;
}

function paintLeg(ctx, rig, C, side) {
  const { P, dims } = rig;
  const sgn = side === 'L' ? -1 : 1;
  const foot = rig.foot[side];
  const hip = P(rig.lean * 0.1, sgn * dims.hipR + rig.side * 0.1, rig.up(dims.hipU));
  const ankle = P(foot[0], foot[1], foot[2] + 2.6);
  capsule(ctx, hip[0], hip[1], dims.leg[0], ankle[0], ankle[1], dims.leg[1], litFill(ctx, hip[0], (hip[1] + ankle[1]) / 2, 6, 6, C.pants, 0.14, 0.22));
  const toe = P(foot[0] + 1.6, foot[1], foot[2] + 1.8);
  const w = 3.3 + 1.9 * Math.abs(rig.c);
  ell(ctx, toe[0], toe[1], w, 3.15, litFill(ctx, toe[0], toe[1], w, 3.1, C.boot, 0.2, 0.25));
  ell(ctx, toe[0] - 0.8, toe[1] - 1, w * 0.46, 0.9, alpha('#ffffff', 0.22));
}

function paintArm(ctx, rig, C, side) {
  const { P, dims, pose } = rig;
  const sgn = side === 'L' ? -1 : 1;
  const hand = rig.hand[side];
  const sh = P(rig.lean * 0.55, sgn * dims.shoulderR + rig.side * 0.55, rig.up(dims.shoulderU));
  const hd = P(hand[0], hand[1], hand[2] - rig.drop * 0.2 + (pose.bob || 0));
  const fill = litFill(ctx, (sh[0] + hd[0]) / 2, (sh[1] + hd[1]) / 2, 7, 7, C.coat, 0.2, 0.24);
  capsule(ctx, sh[0], sh[1], dims.arm[0], hd[0], hd[1], dims.arm[1], fill);
  // A paler cuff separates mitten from sleeve; without it the arm melts into the coat at game size.
  const k = 0.76;
  const cx = sh[0] + (hd[0] - sh[0]) * k, cy = sh[1] + (hd[1] - sh[1]) * k;
  ell(ctx, cx, cy, dims.arm[1] * 0.96, dims.arm[1] * 0.96, tone(C.coat, 0.3));
  rig.hooks.hand?.(ctx, rig, side, hd);
  // The ball sits on top of the mitten: held any lower, the mitten hides most of it at game size.
  if (pose.ball && pose.ball.side === side) snowball(ctx, hd[0] - 0.8, hd[1] - pose.ball.r * 0.96, pose.ball.r);
  ell(ctx, hd[0], hd[1], dims.mitt, dims.mitt * 0.94, litFill(ctx, hd[0], hd[1], dims.mitt, dims.mitt, C.mitt, 0.24, 0.24));
  const ta = Math.atan2(hd[1] - sh[1], hd[0] - sh[0]) + (side === 'L' ? 1.1 : -1.1);
  ell(ctx, hd[0] + Math.cos(ta) * dims.mitt * 0.82, hd[1] + Math.sin(ta) * dims.mitt * 0.82, dims.mitt * 0.46, dims.mitt * 0.42, tone(C.mitt, 0.1));
}

function paintTorso(ctx, rig, C) {
  const { P, dims, lean, side, up, s } = rig;
  const rows = dims.torso;
  // Stacked quilted rolls: this bumpy edge is what says "puffy coat" when a kid is 40 px tall.
  for (let i = 0; i < rows.length; i++) {
    const [w, u, h] = rows[i];
    const t = (u - rows[0][1]) / (rows[rows.length - 1][1] - rows[0][1] || 1);
    const p = P(lean * (0.2 + t * 0.4), side * (0.2 + t * 0.4), up(u));
    ell(ctx, p[0], p[1], w, h + 0.8, litFill(ctx, p[0], p[1], w, h + 1, C.coat, 0.2 - i * 0.02 + t * 0.06, 0.22));
    if (i > 0) {
      ctx.beginPath();
      ctx.ellipse(p[0], p[1] + 0.2, w * 0.97, h + 0.8, 0, 0.14 * Math.PI, 0.86 * Math.PI);
      ctx.strokeStyle = alpha(tone(C.coat, -0.42), 0.34);
      ctx.lineWidth = 0.8;
      ctx.lineCap = 'round';
      ctx.stroke();
    }
  }
  if (s > -0.3 && C.zip !== null) {
    const top = P(lean * 0.6 + 9.4, side * 0.6, up(rows[rows.length - 1][1] + 1));
    const bot = P(lean * 0.2 + 10.4, side * 0.2, up(rows[0][1] - 4));
    line(ctx, top[0], top[1] + 2, bot[0], bot[1], C.zip ?? alpha(tone(C.coat, 0.5), 0.75), 0.9);
  }
  if (s < -0.3 && C.hood !== false) {
    const p = P(lean * 0.7 - 2.5, side * 0.7, up(dims.neckU - 1));
    ell(ctx, p[0], p[1] + 2, 7.4, 4.6, tone(C.coat, -0.16));
  }
}

function paintScarfWrap(ctx, rig, C) {
  const { neck, P, up, dims, s, lean, side } = rig;
  const [x, y] = neck;
  ell(ctx, x, y, 10.2, 4.2, litFill(ctx, x, y, 10, 4, C.scarf, 0.24, 0.3));
  // The fold line reads as "wrapped twice", which a flat band doesn't.
  ctx.beginPath();
  ctx.ellipse(x, y - 0.5, 9.2, 2.8, 0, 0.1 * Math.PI, 0.9 * Math.PI);
  ctx.strokeStyle = alpha(tone(C.scarf, -0.45), 0.5);
  ctx.lineWidth = 0.8;
  ctx.stroke();
  if (s > -0.3) {
    const k = P(lean * 0.8 + 1.5, side * 0.8 + 6.2, up(dims.neckU - 0.6));
    ell(ctx, k[0], k[1] + 0.6, 3.1, 2.7, litFill(ctx, k[0], k[1], 3, 3, C.scarf, 0.3, 0.3));
  }
}

function paintHead(ctx, rig, C) {
  const { hx, hy, R, s, c } = rig;
  // Ears peek out in profile; on a front view they would only add noise under the hat.
  if (Math.abs(c) > 0.5) ell(ctx, hx - c * 1.6, hy + 1.5, 2.1, 2.5, tone(C.skin, -0.14));
  ell(ctx, hx, hy, R * 1.05, R, litFill(ctx, hx, hy, R, R, C.skin, 0.22, 0.2));
  if (s < -0.3) {
    ctx.beginPath();
    ctx.ellipse(hx, hy, R * 1.05, R, 0, 0, TAU);
    clipped(ctx, () => ell(ctx, hx, hy + 6, R * 1.15, R * 0.9, C.hair));
  }
}

export function paintFace(ctx, rig, C, eyes = 'open', mouth = 'smile', brow = null) {
  const { hx, hy, R, c, s } = rig;
  if (s < -0.3) return;
  const fx = hx + c * R * 0.46, fy = hy + 2.3 + s * 0.7;
  const sq = 0.56 + 0.44 * Math.abs(s);
  const ex = 4.2 * sq;
  const lx = fx - ex, rx = fx + ex;
  const cheek = C.cheek;
  ell(ctx, lx - 2.4 * sq, fy + 2.9, 2.4 * sq, 1.5, cheek);
  ell(ctx, rx + 2.4 * sq, fy + 2.9, 2.4 * sq, 1.5, cheek);
  const eye = C.eye ?? INK;
  const stroke = (fn) => { ctx.beginPath(); fn(); ctx.strokeStyle = eye; ctx.lineWidth = 1.05; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.stroke(); };
  for (const [x, d] of [[lx, -1], [rx, 1]]) {
    switch (eyes) {
      case 'closed': stroke(() => { ctx.moveTo(x - 1.7, fy - 0.1); ctx.quadraticCurveTo(x, fy + 1.3, x + 1.7, fy - 0.1); }); break;
      case 'happy': stroke(() => { ctx.moveTo(x - 1.7, fy + 0.4); ctx.quadraticCurveTo(x, fy - 1.7, x + 1.7, fy + 0.4); }); break;
      case 'squeeze': stroke(() => { ctx.moveTo(x - d * 1.6, fy - 1.5); ctx.lineTo(x + d * 1.3, fy); ctx.lineTo(x - d * 1.6, fy + 1.5); }); break;
      case 'wide':
        ell(ctx, x, fy, 2.2, 2.5, '#ffffff');
        ell(ctx, x, fy + 0.3, 1.1, 1.3, eye);
        break;
      case 'dizzy':
        ctx.beginPath();
        for (let i = 0; i <= 14; i++) {
          const a = i * 0.8 + d, q = 0.2 + i * 0.13;
          ctx[i ? 'lineTo' : 'moveTo'](x + Math.cos(a) * q, fy + Math.sin(a) * q);
        }
        ctx.strokeStyle = eye; ctx.lineWidth = 0.75; ctx.stroke();
        break;
      case 'focus':
        ell(ctx, x, fy + 0.3, 1.5, 1.7, eye);
        ell(ctx, x - 0.4, fy - 0.2, 0.5, 0.5, '#ffffff');
        line(ctx, x - 2, fy - 1.5, x + 2, fy - 1.5 + d * 0.5, eye, 0.9);
        break;
      default:
        ell(ctx, x, fy, 1.55, 2.2, eye);
        ell(ctx, x - 0.45, fy - 0.8, 0.62, 0.68, '#ffffff');
    }
    if (brow === 'angry') line(ctx, x + d * 2.7, fy - 4.3, x - d * 1.1, fy - 2.4, C.brow ?? eye, 1.3);
    else if (brow === 'sad') line(ctx, x + d * 2.4, fy - 2.5, x - d * 1.3, fy - 4.1, C.brow ?? eye, 1.05);
  }
  const mx = fx, my = fy + 4.5;
  const dark = mix(C.skin, '#7a2b3e', 0.72);
  switch (mouth) {
    case 'grin':
      ctx.beginPath();
      ctx.moveTo(mx - 2.7, my - 0.7);
      ctx.quadraticCurveTo(mx, my + 3.5, mx + 2.7, my - 0.7);
      ctx.closePath();
      ctx.fillStyle = dark; ctx.fill();
      break;
    case 'o': ell(ctx, mx, my + 0.4, 1.7, 2, dark); break;
    case 'flat': line(ctx, mx - 1.6, my + 0.2, mx + 1.6, my + 0.2, dark, 0.9); break;
    case 'grit':
      ell(ctx, mx, my + 0.3, 2.5, 1.35, '#ffffff');
      line(ctx, mx - 2.2, my + 0.3, mx + 2.2, my + 0.3, alpha(INK, 0.5), 0.5);
      break;
    case 'frown': curve(ctx, mx - 2, my + 1, mx, my - 1, mx + 2, my + 1, dark, 0.95); break;
    case 'wobble':
      ctx.beginPath(); ctx.moveTo(mx - 2.4, my);
      ctx.quadraticCurveTo(mx - 1.2, my - 1.5, mx, my);
      ctx.quadraticCurveTo(mx + 1.2, my + 1.5, mx + 2.4, my);
      ctx.strokeStyle = dark; ctx.lineWidth = 0.9; ctx.lineCap = 'round'; ctx.stroke();
      break;
    case 'smirk': curve(ctx, mx - 1.8, my + 0.5, mx + 0.4, my + 1.4, mx + 2.2, my - 0.8, dark, 0.95); break;
    default: curve(ctx, mx - 1.8, my - 0.2, mx, my + 1.6, mx + 1.8, my - 0.2, dark, 0.95);
  }
}

// Paints one complete chibi. Everything that varies between characters arrives through hooks.
export function paintChibi(ctx, C, dims, pose, hooks = {}) {
  const rig = makeRig(dims, pose);
  rig.hooks = hooks;
  const { dep } = rig;
  ctx.save();
  if (pose.tilt) ctx.rotate(pose.tilt);
  const shoulderDep = (sd) => dep(0, (sd === 'L' ? -1 : 1) * dims.shoulderR);
  const armDepth = (sd) => {
    const h = rig.hand[sd];
    return dep(h[0], h[1]) + shoulderDep(sd);
  };
  const behind = ['L', 'R'].filter((sd) => armDepth(sd) < -2);
  const front = ['L', 'R'].filter((sd) => armDepth(sd) >= -2).sort((a, b) => armDepth(a) - armDepth(b));
  hooks.back?.(ctx, rig);
  for (const sd of behind) paintArm(ctx, rig, C, sd);
  const legs = ['L', 'R'].sort((a, b) => dep(rig.foot[a][0], rig.foot[a][1]) - dep(rig.foot[b][0], rig.foot[b][1]));
  for (const sd of legs) paintLeg(ctx, rig, C, sd);
  (hooks.torso ?? paintTorso)(ctx, rig, C);
  hooks.chest?.(ctx, rig);
  if (C.scarf) paintScarfWrap(ctx, rig, C);
  hooks.behindHead?.(ctx, rig);
  (hooks.head ?? paintHead)(ctx, rig, C);
  if (hooks.face) hooks.face(ctx, rig);
  else paintFace(ctx, rig, C, pose.eyes, pose.mouth, pose.brow);
  hooks.hat?.(ctx, rig);
  for (const sd of front) paintArm(ctx, rig, C, sd);
  hooks.over?.(ctx, rig);
  ctx.restore();
  return rig;
}

// ---- generic poses ---------------------------------------------------------------------------------

const STAND_L = [0, -5, 0], STAND_R = [0, 5, 0];

export function poseIdle(frame) {
  return {
    handL: [1.5, -13, 9 + (frame === 1 ? 0.5 : 0)],
    handR: [1.5, 13, 9 + (frame === 1 ? 0.5 : 0)],
    footL: STAND_L, footR: STAND_R,
    bob: frame === 1 ? 0.6 : 0,
    eyes: frame === 2 ? 'closed' : 'open', mouth: 'smile',
  };
}

export function poseWalk(frame, n = 6) {
  const p = (frame / n) * TAU;
  const sw = Math.sin(p), cs = Math.cos(p);
  return {
    footL: [7 * sw, -4.6, Math.max(0, cs) * 3],
    footR: [-7 * sw, 4.6, Math.max(0, -cs) * 3],
    handL: [-6 * sw + 1.5, -13, 10 - sw * 1.2],
    handR: [6 * sw + 1.5, 13, 10 + sw * 1.2],
    bob: Math.abs(cs) * 1.5 - 0.4, lean: 2.4,
    eyes: 'open', mouth: 'smile',
  };
}

export function poseHit() {
  return {
    handL: [-1, -15, 21], handR: [-1, 15, 21],
    footL: [2, -6, 0], footR: [-3, 6, 1],
    lean: -3.6, bob: 0.8,
    eyes: 'squeeze', mouth: 'o',
  };
}

export function poseStun(frame) {
  const d = frame === 0 ? 1 : -1;
  return {
    handL: [1, -14, 8 + d], handR: [1, 14, 8 - d],
    footL: STAND_L, footR: STAND_R,
    side: d * 3.2, crouch: 0.2, tilt: d * 0.05,
    eyes: 'dizzy', mouth: 'wobble',
  };
}

// ---- kid look ---------------------------------------------------------------------------------------

const HAIR_BY_SKIN = ['#9a6a3a', '#6d4427', '#54351f', '#3d2a1f', '#2f2019', '#241814'];
const pick = (arr, i, d) => arr[Number.isInteger(i) && i >= 0 && i < arr.length ? i : d];

// Scarf and bobble take the team colour in Face-Off; the hat body stays the player's, so a kid is still
// recognisably themselves when the teams are colour-coded.
export function kidColors(look, teamColor) {
  const L = look || DEFAULT_LOOK;
  const coat = pick(LOOK.coat, L.coat, DEFAULT_LOOK.coat);
  const scarfLook = pick(LOOK.scarf, L.scarf, DEFAULT_LOOK.scarf);
  const skinIdx = Number.isInteger(L.skin) && L.skin >= 0 && L.skin < LOOK.skin.length ? L.skin : DEFAULT_LOOK.skin;
  const skin = LOOK.skin[skinIdx];
  const accent = teamColor || scarfLook;
  const hat = scarfLook === '#f4f1ea' ? tone(coat, -0.12) : scarfLook;
  return {
    coat, skin, scarf: accent, hat, bobble: teamColor || tone(scarfLook, 0.34),
    hatName: pick(LOOK.hat, L.hat, DEFAULT_LOOK.hat),
    pants: mix(tone(coat, -0.32), '#3b3a6e', 0.62),
    boot: mix(tone(coat, -0.5), '#54402f', 0.65),
    mitt: tone(accent, -0.06),
    hair: HAIR_BY_SKIN[skinIdx],
    cheek: alpha(mix(skin, '#f2566a', 0.7), skinIdx >= 4 ? 0.3 : 0.5),
    eye: skinIdx >= 4 ? '#1f1a30' : INK,
  };
}

export function teamColorOf(team) {
  return team === undefined || team === null ? null : TEAM_STYLE[team]?.color ?? null;
}

export function kidKey(look, teamColor) {
  const L = look || DEFAULT_LOOK;
  return `${L.hat}.${L.coat}.${L.scarf}.${L.skin}.${teamColor || ''}`;
}

function fuzzball(ctx, x, y, r, color) {
  const rnd = seeded(Math.round(r * 37) + 3);
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * TAU + rnd() * 0.3;
    ell(ctx, x + Math.cos(a) * r * 0.78, y + Math.sin(a) * r * 0.78, r * 0.36, r * 0.36, i < 5 ? tone(color, -0.16) : tone(color, 0.1));
  }
  ell(ctx, x, y, r * 0.88, r * 0.88, litFill(ctx, x, y, r, r, color, 0.3, 0.22));
  ell(ctx, x - r * 0.3, y - r * 0.36, r * 0.3, r * 0.22, alpha('#ffffff', 0.5), -0.5);
}

// The dome is cut along the brim. The brim sits higher on the forehead when we see the face and
// drops down the neck from behind, which is most of what sells the turn of the head.
function brimOf(rig) {
  const { hy, s } = rig;
  return hy - 2.9 + (1 - s) * (s < 0 ? 3.1 : 1.45);
}

function domePath(ctx, x, top, hw, brim, sag) {
  ctx.beginPath();
  ctx.moveTo(x - hw, brim);
  ctx.bezierCurveTo(x - hw, top + (brim - top) * 0.1, x - hw * 0.62, top, x, top);
  ctx.bezierCurveTo(x + hw * 0.62, top, x + hw, top + (brim - top) * 0.1, x + hw, brim);
  ctx.quadraticCurveTo(x, brim + sag, x - hw, brim);
  ctx.closePath();
}

function bandPath(ctx, x, hw, y, sag, h) {
  ctx.beginPath();
  ctx.moveTo(x - hw, y);
  ctx.quadraticCurveTo(x, y + sag, x + hw, y);
  ctx.lineTo(x + hw - 0.4, y - h);
  ctx.quadraticCurveTo(x, y - h + sag, x - hw + 0.4, y - h);
  ctx.closePath();
}

function ribs(ctx, x, hw, y, sag, h, color) {
  ctx.strokeStyle = color;
  ctx.lineWidth = 0.65;
  ctx.lineCap = 'round';
  for (let i = -4; i <= 4; i++) {
    const t = i / 4.6;
    const px = x + t * hw;
    const py = y + sag * (1 - t * t) * 0.5;
    ctx.beginPath();
    ctx.moveTo(px, py - 0.7);
    ctx.lineTo(px, py - h + 0.7);
    ctx.stroke();
  }
}

export const HAT_PAINT = {
  bobble(ctx, rig, C) {
    const { hx: x, hy, R, c } = rig;
    const brim = brimOf(rig), top = hy - R - 2.8, hw = R + 1.1;
    domePath(ctx, x, top, hw, brim, 2.4);
    ctx.fillStyle = litFill(ctx, x, (top + brim) / 2, hw, (brim - top) / 2, C.hat, 0.22, 0.26);
    ctx.fill();
    bandPath(ctx, x, hw + 0.5, brim + 2, 2.4, 4.8);
    ctx.fillStyle = tone(C.hat, 0.55);
    ctx.fill();
    ribs(ctx, x, hw, brim + 2, 2.4, 4.8, alpha(tone(C.hat, -0.1), 0.42));
    fuzzball(ctx, x - c * 1.8, top - 3.4, 5.6, C.bobble);
  },
  beanie(ctx, rig, C) {
    const { hx: x, hy, R, c, s } = rig;
    const brim = brimOf(rig) + 0.2, top = hy - R - 1.2, hw = R + 0.9;
    domePath(ctx, x, top, hw, brim, 2.2);
    ctx.fillStyle = litFill(ctx, x, (top + brim) / 2, hw, (brim - top) / 2, C.hat, 0.2, 0.28);
    ctx.fill();
    ctx.strokeStyle = alpha(tone(C.hat, -0.4), 0.3);
    ctx.lineWidth = 0.7;
    for (const k of [-0.5, 0, 0.5]) {
      ctx.beginPath();
      ctx.moveTo(x + k * hw * 0.9, brim - 3);
      ctx.quadraticCurveTo(x + k * hw * 0.8, top + 3, x + k * 2.4, top + 1);
      ctx.stroke();
    }
    bandPath(ctx, x, hw + 0.7, brim + 2.6, 2.2, 6);
    ctx.fillStyle = litFill(ctx, x, brim, hw, 3, C.bobble, 0.12, 0.2);
    ctx.fill();
    ribs(ctx, x, hw, brim + 2.6, 2.2, 6, alpha(tone(C.bobble, -0.5), 0.34));
    if (s > -0.3) ell(ctx, x + hw * 0.56 + c * 3, brim, 1.9, 1.5, CREAM);
  },
  earflap(ctx, rig, C) {
    const { hx: x, hy, R, c, s, back } = rig;
    const brim = brimOf(rig), top = hy - R - 1.6, hw = R + 1.2;
    const fleece = '#f3e7d2';
    // Flaps swing with the head: in profile the near flap sits mid-cheek, the far one hides behind.
    const near = [[-1, -hw + 0.8 - c * 2.4], [1, hw - 0.8 - c * 2.4]];
    for (const [sd, ox] of near) {
      if (Math.abs(c) > 0.85 && sd * c > 0) continue;
      const fx = x + ox;
      ctx.beginPath();
      ctx.moveTo(fx - 3.6, brim - 2);
      ctx.quadraticCurveTo(fx - 4.2, hy + 9, fx, hy + 10);
      ctx.quadraticCurveTo(fx + 4.2, hy + 9, fx + 3.6, brim - 2);
      ctx.closePath();
      ctx.fillStyle = litFill(ctx, fx, hy + 3, 4, 7, C.hat, 0.12, 0.3);
      ctx.fill();
      ell(ctx, fx, hy + 6.8, 2.5, 3, fleece);
      if (!back) { curve(ctx, fx, hy + 9.6, fx - sd * 1, hy + 12, fx + sd * 1.2, hy + 13, C.bobble, 0.8); ell(ctx, fx + sd * 1.2, hy + 13.2, 1.3, 1.3, C.bobble); }
    }
    domePath(ctx, x, top, hw, brim, 2);
    ctx.fillStyle = litFill(ctx, x, (top + brim) / 2, hw, (brim - top) / 2, C.hat, 0.2, 0.26);
    ctx.fill();
    if (s > -0.3) {
      // The fleece front turned up: the shape that makes it a trapper hat and not another beanie.
      ctx.beginPath();
      ctx.moveTo(x - hw + 1 + c * 3, brim + 0.9);
      ctx.quadraticCurveTo(x + c * 3, brim + 3, x + hw - 1 + c * 3, brim + 0.9);
      ctx.quadraticCurveTo(x + hw - 2 + c * 3, brim - 6, x + c * 3, brim - 6.6);
      ctx.quadraticCurveTo(x - hw + 2 + c * 3, brim - 6, x - hw + 1 + c * 3, brim + 0.9);
      ctx.closePath();
      ctx.fillStyle = linGrad(ctx, x, brim - 6, x, brim + 2, ['#fff8ea', fleece, '#dcc8a8']);
      ctx.fill();
      ell(ctx, x + c * 3, brim - 3.2, 1.6, 1.6, C.bobble);
    } else {
      bandPath(ctx, x, hw + 0.3, brim + 2, 2, 3);
      ctx.fillStyle = fleece;
      ctx.fill();
    }
  },
  pompom(ctx, rig, C) {
    const { hx: x, hy, R, c } = rig;
    const brim = brimOf(rig), hw = R + 1;
    const bend = c > 0.3 ? -1 : 1;
    const tipX = x + bend * 14.5, tipY = hy - R + 3.5;
    ctx.beginPath();
    ctx.moveTo(x - hw, brim);
    ctx.bezierCurveTo(x - hw, hy - R - 4, x - 2 + bend * 2, hy - R - 8, x + bend * 7, hy - R - 5.5);
    ctx.quadraticCurveTo(tipX - bend * 1, hy - R - 2.5, tipX, tipY);
    ctx.quadraticCurveTo(tipX - bend * 4.4, hy - R - 0.5, x + bend * 3.5, hy - R + 2);
    ctx.lineTo(x + hw, brim);
    ctx.quadraticCurveTo(x, brim + 2.4, x - hw, brim);
    ctx.closePath();
    ctx.fillStyle = litFill(ctx, x, hy - R, hw + 5, 8, C.hat, 0.2, 0.24);
    ctx.fill();
    clipped(ctx, () => {
      ctx.strokeStyle = alpha(tone(C.hat, 0.6), 0.85);
      ctx.lineWidth = 2.1;
      ctx.lineCap = 'butt';
      for (const k of [0.1, 0.44, 0.76]) {
        const px = x + bend * (k * 17 - 5), py = hy - R - 6 + k * 7;
        ctx.beginPath();
        ctx.moveTo(px - 2, py - 7);
        ctx.quadraticCurveTo(px + bend * 2, py + 2, px - 2, py + 11);
        ctx.stroke();
      }
    });
    bandPath(ctx, x, hw + 0.5, brim + 2, 2.4, 4.4);
    ctx.fillStyle = tone(C.hat, -0.14);
    ctx.fill();
    ribs(ctx, x, hw, brim + 2, 2.4, 4.4, alpha(tone(C.hat, 0.5), 0.4));
    fuzzball(ctx, tipX + bend * 0.6, tipY + 2.6, 5, C.bobble);
  },
  crown(ctx, rig, C) {
    const { hx: x, hy, R, s, c } = rig;
    const y0 = hy - R * 0.5 - (rig.back ? -1 : 0.4), rx = R * 0.98, ry = R * 0.3;
    // Hair fills the top of the head: the crown is a ring, so the head shows through it.
    ctx.beginPath();
    ctx.ellipse(x, hy, R * 1.05, R, 0, Math.PI, 0);
    ctx.lineTo(x + R, y0 + 2);
    ctx.quadraticCurveTo(x, y0 + (s > -0.3 ? -0.5 : 6), x - R, y0 + 2);
    ctx.closePath();
    ctx.fillStyle = litFill(ctx, x, hy - R * 0.6, R, 5, C.hair, 0.16, 0.14);
    ctx.fill();
    const points = (y, far, h, base) => {
      ctx.beginPath();
      const n = 4;
      const px = (i) => x + (i / n * 2 - 1) * rx;
      const edge = (t) => ry * Math.sqrt(Math.max(0, 1 - t * t)) * (far ? -1 : 1);
      ctx.moveTo(px(0), y + edge(-1));
      for (let i = 0; i <= n; i++) {
        ctx.lineTo(px(i), y + edge(i / n * 2 - 1) - h);
        if (i < n) {
          const t2 = (i + 0.5) / n * 2 - 1;
          ctx.lineTo(x + t2 * rx, y + edge(t2) - h * 0.42);
        }
      }
      ctx.lineTo(px(n), y + edge(1) + 3);
      ctx.quadraticCurveTo(x, y + 3 + (far ? -ry : ry) * 1.7, px(0), y + edge(-1) + 3);
      ctx.closePath();
      ctx.fillStyle = base;
      ctx.fill();
    };
    points(y0, true, 7, GOLD_LO);
    ctx.beginPath();
    ctx.ellipse(x, y0 + 1, rx * 0.9, ry * 0.8, 0, 0, TAU);
    ctx.fillStyle = alpha(C.hair, 0.8);
    ctx.fill();
    points(y0, false, 7.6, linGrad(ctx, x - rx, y0 - 6, x + rx, y0 + 4, ['#ffe48a', GOLD, GOLD_LO]));
    for (const k of [-0.62, 0, 0.62]) ell(ctx, x + k * rx + c * 1.5, y0 + 1 + ry * (1 - k * k) * 0.8, 1.5, 1.5, C.bobble);
    for (const k of [-1, -0.5, 0, 0.5, 1]) ell(ctx, x + k * rx, y0 + ry * Math.sqrt(1 - k * k) - 7.6, 1, 1, '#fff6c9');
  },
  toque(ctx, rig, C) {
    const { hx: x, hy, R, c } = rig;
    const brim = brimOf(rig), top = hy - R - 6.2, hw = R + 0.9;
    domePath(ctx, x, top, hw, brim, 2.2);
    ctx.fillStyle = C.hat;
    ctx.fill();
    clipped(ctx, () => {
      const cream = tone(C.hat, 0.72);
      for (let i = 0; i < 3; i++) {
        const y = brim - 6.2 - i * 4.8;
        ctx.beginPath();
        ctx.moveTo(x - hw - 1, y);
        ctx.quadraticCurveTo(x, y + 2.4, x + hw + 1, y);
        ctx.lineTo(x + hw + 1, y - 2.2);
        ctx.quadraticCurveTo(x, y + 0.2, x - hw - 1, y - 2.2);
        ctx.closePath();
        ctx.fillStyle = i === 1 ? C.bobble : cream;
        ctx.fill();
      }
      ctx.fillStyle = linGrad(ctx, x - hw, top, x + hw, brim, [alpha('#ffffff', 0.22), alpha('#ffffff', 0), alpha('#3f3572', 0.24)]);
      ctx.fillRect(x - hw - 1, top - 1, hw * 2 + 2, brim - top + 5);
    });
    bandPath(ctx, x, hw + 0.6, brim + 2.2, 2.2, 4.8);
    ctx.fillStyle = litFill(ctx, x, brim, hw, 3, C.hat, 0.1, 0.24);
    ctx.fill();
    ribs(ctx, x, hw, brim + 2.2, 2.2, 4.8, alpha(tone(C.hat, -0.5), 0.3));
    for (const a of [-0.5, 0, 0.5]) line(ctx, x - c, top + 0.6, x - c + a * 4.5, top - 3.2, C.bobble, 1.2);
  },
};

function kidHooks(C) {
  return { hat: (ctx, rig) => HAT_PAINT[C.hatName](ctx, rig, C) };
}

export const KID_FRAMES = Object.freeze({
  idle: 3, walk: 6, charge: 4, lobaim: 3, throw: 3, lob: 3, pack: 3, hit: 1, stun: 2, ride: 2, frozen: 4, slide: 2, cheer: 2,
});

function poseKid(name, frame) {
  switch (name) {
    case 'idle': return poseIdle(frame);
    case 'walk': return poseWalk(frame, 6);
    case 'charge': {
      const L = frame / 3;
      return {
        handR: [-2 - 8 * L, 12.5, 17 + 15 * L], handL: [8 + 2 * L, -9, 16 + 2 * L],
        footL: [5, -5, 0], footR: [-5, 5, 0],
        lean: -1 - 2.4 * L, crouch: 0.2 * L,
        ball: { side: 'R', r: 3.2 + 2 * L },
        eyes: L > 0.6 ? 'focus' : 'open', mouth: L > 0.6 ? 'grit' : 'flat',
      };
    }
    case 'lobaim': {
      const L = frame / 2;
      return {
        handR: [-5 - 4 * L, 8, 7 + 5 * L], handL: [-3 - 4 * L, -3, 7 + 5 * L],
        footL: [4, -5.5, 0], footR: [-4, 5.5, 0],
        lean: 1 - 2 * L, crouch: 0.35 - 0.1 * L,
        ball: { side: 'L', r: 5.4 }, eyes: 'open', mouth: 'flat',
      };
    }
    case 'throw': {
      const hand = [[7, 11, 31], [15, 7, 23], [13, 5, 11]][frame];
      return {
        handR: hand, handL: [[-3, -11, 14], [-6, -12, 12], [-4, -13, 10]][frame],
        footL: [5, -5, frame === 1 ? 0.4 : 0], footR: [-6, 5, frame === 1 ? 2.6 : 1],
        lean: [1.6, 4.8, 3][frame],
        eyes: 'focus', mouth: frame < 2 ? 'o' : 'smile',
      };
    }
    case 'lob': {
      const hand = [[3, 7, 13], [9, 5, 27], [8, 6, 36]][frame];
      return {
        handR: hand, handL: [hand[0] - 1, -5, hand[2] - 1],
        footL: [3, -5.5, frame ? 1 : 0], footR: [-3, 5.5, frame ? 1 : 0],
        lean: [0, -1.6, -2.6][frame], bob: frame ? 1 : 0,
        eyes: 'open', mouth: 'o',
      };
    }
    case 'pack': {
      const hy = [14, 8, 7.4][frame], hr = [5.5, 4.4, 6.4][frame];
      return {
        handL: [10, -hr, hy], handR: [10, hr, hy],
        footL: [-1, -7.5, 0], footR: [-1, 7.5, 0],
        crouch: 1, lean: 3,
        eyes: frame === 1 ? 'happy' : 'open', mouth: frame === 1 ? 'grin' : 'smile',
      };
    }
    case 'hit': return poseHit();
    case 'stun': return poseStun(frame);
    case 'ride': {
      const d = frame === 0 ? 1 : -1;
      return {
        handL: [5, -15, 18 + d], handR: [-5, 15, 20 - d],
        footL: [7, -2.5, 2], footR: [-7, 2.5, 2],
        crouch: 0.42, lean: 1.5, side: d * 0.7,
        eyes: 'happy', mouth: 'grin',
      };
    }
    case 'frozen':
      return {
        handL: [3, -10, 14], handR: [3, 10, 14],
        footL: STAND_L, footR: STAND_R,
        crouch: 0.1, eyes: 'wide', mouth: 'o',
      };
    case 'cheer': {
      const d = frame === 0 ? 0 : 2.2;
      return {
        handL: [1, -12, 37 + d], handR: [1, 12, 37 - d + 2],
        footL: STAND_L, footR: STAND_R, bob: d,
        eyes: 'happy', mouth: 'grin',
      };
    }
    default: return poseIdle(0);
  }
}

// Belly slide: head first, arms out, boots kicked up, one very pleased face.
function paintSlide(ctx, C, th, frame) {
  const c = Math.cos(th), s = Math.sin(th);
  const P = (f, r, u) => [f * c - r * s, (f * s + r * c) * 0.66 - u];
  const wig = frame ? 1 : -1;
  const legs = [[-17, -4.4, 7 + wig], [-17, 4.4, 7 - wig]];
  const arms = [[20, -6.5, 5], [20, 6.5, 5]];
  const hiddenFirst = s > 0.2;
  const body = () => {
    const a = P(-10, 0, 7), b = P(7, 0, 7.5);
    capsule(ctx, a[0], a[1], 8.2, b[0], b[1], 9.2, litFill(ctx, (a[0] + b[0]) / 2, (a[1] + b[1]) / 2, 16, 10, C.coat, 0.22, 0.24));
    const m = P(-3, 0, 7);
    ctx.save();
    ctx.translate(m[0], m[1]);
    ctx.rotate(Math.atan2(b[1] - a[1], b[0] - a[0]));
    ctx.strokeStyle = alpha(tone(C.coat, -0.42), 0.34);
    ctx.lineWidth = 0.8;
    for (const k of [-5, 3]) {
      ctx.beginPath();
      ctx.moveTo(k, -7.4);
      ctx.quadraticCurveTo(k + 2.4, 0, k, 7.4);
      ctx.stroke();
    }
    ctx.restore();
  };
  const boots = () => {
    for (const l of legs) {
      const h = P(-9, l[1] * 0.8, 6), e = P(l[0], l[1], l[2]);
      capsule(ctx, h[0], h[1], 3.8, e[0], e[1], 3.2, C.pants);
      ell(ctx, e[0], e[1], 3.9, 3.3, litFill(ctx, e[0], e[1], 4, 3.2, C.boot, 0.2, 0.24));
    }
  };
  const hands = () => {
    for (const a of arms) {
      const h = P(7, a[1] * 1.3, 8), e = P(a[0], a[1], a[2]);
      capsule(ctx, h[0], h[1], 3.7, e[0], e[1], 3, litFill(ctx, h[0], h[1], 6, 6, C.coat, 0.2, 0.24));
      ell(ctx, e[0], e[1], 3.6, 3.4, litFill(ctx, e[0], e[1], 3.5, 3.5, C.mitt, 0.24, 0.24));
    }
  };
  const head = () => {
    const h = P(14, 0, 10);
    const rig = { hx: h[0], hy: h[1], R: 10, s, c, th, back: s < -0.3 };
    paintHead(ctx, rig, C);
    paintFace(ctx, rig, C, 'happy', 'grin');
    HAT_PAINT[C.hatName](ctx, { ...rig, hy: h[1] - (s > 0.3 ? 1.6 : 0) }, C);
  };
  const scarf = () => {
    const n = P(9, 0, 8);
    ell(ctx, n[0], n[1], 8.6, 6.4, litFill(ctx, n[0], n[1], 8, 6, C.scarf, 0.24, 0.3));
  };
  if (hiddenFirst) { boots(); body(); scarf(); hands(); head(); } else { head(); scarf(); hands(); body(); boots(); }
}

function paintIceBlock(ctx, stage, drawInside) {
  const w = 21, top = -48 + stage * 1.6, bot = 4;
  const backTop = top - 7;
  ell(ctx, 0, bot - 1, w + 3, 7, alpha(ICE_DEEP, 0.3));
  // Back wall and lid first, so the kid reads as sitting inside rather than behind a pane.
  ctx.beginPath();
  ctx.moveTo(-w + 3, top + 3);
  ctx.quadraticCurveTo(-w + 4, backTop, -w + 9, backTop);
  ctx.lineTo(w - 9, backTop);
  ctx.quadraticCurveTo(w - 4, backTop, w - 3, top + 3);
  ctx.lineTo(w - 3, bot - 8);
  ctx.lineTo(-w + 3, bot - 8);
  ctx.closePath();
  ctx.fillStyle = alpha(ICE, 0.42);
  ctx.fill();
  drawInside();
  // Front face.
  ctx.beginPath();
  ctx.moveTo(-w + 6, top);
  ctx.lineTo(w - 6, top);
  ctx.quadraticCurveTo(w, top, w, top + 6);
  ctx.lineTo(w, bot - 6);
  ctx.quadraticCurveTo(w, bot, w - 6, bot);
  ctx.lineTo(-w + 6, bot);
  ctx.quadraticCurveTo(-w, bot, -w, bot - 6);
  ctx.lineTo(-w, top + 6);
  ctx.quadraticCurveTo(-w, top, -w + 6, top);
  ctx.closePath();
  ctx.fillStyle = linGrad(ctx, -w, top, w, bot, [alpha(ICE_HI, 0.62), alpha(ICE, 0.36), alpha(ICE_DEEP, 0.46)]);
  ctx.fill();
  // Lid.
  ctx.beginPath();
  ctx.moveTo(-w + 6, top);
  ctx.lineTo(w - 6, top);
  ctx.quadraticCurveTo(w - 4, backTop, w - 9, backTop);
  ctx.lineTo(-w + 9, backTop);
  ctx.quadraticCurveTo(-w + 4, backTop, -w + 6, top);
  ctx.closePath();
  ctx.fillStyle = alpha(ICE_HI, 0.74);
  ctx.fill();
  // Specular streaks are the cue for "ice"; a tinted box alone looks like glass.
  ctx.beginPath();
  ctx.moveTo(-w + 5.5, top + 7);
  ctx.lineTo(-w + 10.5, top + 7);
  ctx.lineTo(-w + 6.5, bot - 13);
  ctx.lineTo(-w + 5.5, bot - 16);
  ctx.closePath();
  ctx.fillStyle = alpha('#ffffff', 0.72);
  ctx.fill();
  poly(ctx, [[-w + 12.5, top + 7], [-w + 14.2, top + 7], [-w + 9, bot - 22], [-w + 8.2, bot - 26]], alpha('#ffffff', 0.5));
  ctx.strokeStyle = alpha('#ffffff', 0.85);
  ctx.lineWidth = 0.9;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(-w + 6, top + 0.4);
  ctx.lineTo(w - 6, top + 0.4);
  ctx.stroke();
  if (stage >= 1) {
    ctx.strokeStyle = alpha('#ffffff', 0.9);
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    ctx.moveTo(w - 2, top + 14);
    ctx.lineTo(w - 8, top + 19);
    ctx.lineTo(w - 6, top + 25);
    ctx.lineTo(w - 12, top + 29);
    if (stage >= 2) {
      ctx.moveTo(-w + 2, bot - 12);
      ctx.lineTo(-w + 8, bot - 16);
      ctx.lineTo(-w + 7, bot - 22);
      ctx.moveTo(w - 8, top + 19);
      ctx.lineTo(w - 15, top + 16);
    }
    if (stage >= 3) {
      ctx.moveTo(-4, top + 2);
      ctx.lineTo(-2, top + 9);
      ctx.lineTo(-7, top + 15);
      ctx.moveTo(4, bot - 2);
      ctx.lineTo(7, bot - 9);
      ctx.lineTo(3, bot - 14);
    }
    ctx.stroke();
  }
  if (stage >= 2) {
    for (const [x, l] of [[-w + 7, 3], [w - 10, 4.6], [3, 2.8]]) {
      capsule(ctx, x, bot - 1, 0.9, x, bot + l - 1, 1.3, alpha(ICE_DEEP, 0.7));
    }
  }
}

// A frozen kid is recoloured rather than overlaid, so this also works on opaque preview canvases.
function frostColors(C) {
  const f = (c) => mix(c, '#a6e0f4', 0.42);
  return {
    ...C, coat: f(C.coat), skin: f(C.skin), scarf: f(C.scarf), hat: f(C.hat), bobble: f(C.bobble),
    pants: f(C.pants), boot: f(C.boot), mitt: f(C.mitt), hair: f(C.hair),
    cheek: alpha('#7fb8e8', 0.5), eye: '#4a5f8f',
  };
}

export function paintKid(ctx, look, teamColor, name, frame, dirIdx) {
  const C = kidColors(look, teamColor);
  const th = DIR_ANGLE[dirIdx];
  if (name === 'slide') {
    paintSlide(ctx, C, th, frame);
    return;
  }
  const pose = poseKid(name, frame);
  pose.th = th;
  if (name === 'frozen') {
    const F = frostColors(C);
    paintIceBlock(ctx, frame, () => paintChibi(ctx, F, KID_DIMS, pose, kidHooks(F)));
    return;
  }
  const rig = paintChibi(ctx, C, KID_DIMS, pose, kidHooks(C));
  if (name === 'charge' && frame === 3) {
    const h = rig.P(pose.handR[0], pose.handR[1], pose.handR[2]);
    const x = h[0] + 3.6, y = h[1] - 9.4;
    ctx.beginPath();
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * TAU;
      const q = i % 2 ? 1 : 4.4;
      ctx[i ? 'lineTo' : 'moveTo'](x + Math.cos(a) * q, y + Math.sin(a) * q);
    }
    ctx.closePath();
    ctx.fillStyle = GOLD;
    ctx.fill();
  }
  if (name === 'pack') {
    const [x, y] = rig.P(10, 0, 2.6);
    const r = [3, 3.8, 4.6][frame];
    snowball(ctx, x, y + 1, r);
  }
}

// Where the live scarf tail hangs from in the unflipped sprite: the knot in paintScarfWrap, or from
// behind, a point on the back of the neck.
// Fills `out` because it runs for every kid on every frame.
export function tailAnchor(out, dirIdx, crouch, lean) {
  const th = DIR_ANGLE[dirIdx];
  const c = Math.cos(th), s = Math.sin(th);
  const u = KID_DIMS.neckU - 0.6 - crouch * KID_DIMS.crouch;
  const f = s > -0.3 ? lean * 0.8 + 1.5 : lean * 0.8 - 4;
  const r = s > -0.3 ? 6.2 : 3;
  out.x = f * c - r * s;
  out.y = (f * s + r * c) * DEPTH - u;
}

export function poseCrouch(name) {
  switch (name) {
    case 'pack': return 1;
    case 'ride': return 0.42;
    case 'charge': return 0.15;
    case 'lobaim': return 0.3;
    default: return 0;
  }
}

export function poseLean(name) {
  switch (name) {
    case 'walk': return 2.4;
    case 'pack': return 3;
    case 'throw': return 3;
    case 'hit': return -3.6;
    default: return 0;
  }
}

export function paintBoard(ctx, th, C) {
  const c = Math.cos(th), s = Math.sin(th);
  const P = (f, r) => [f * c - r * s, (f * s + r * c) * 0.62];
  const L = 24, W = 6.6;
  const pts = [];
  for (let i = 0; i <= 14; i++) {
    const a = (i / 14) * Math.PI - Math.PI / 2;
    pts.push(P(L - W + Math.cos(a) * W, Math.sin(a) * W));
  }
  for (let i = 0; i <= 14; i++) {
    const a = (i / 14) * Math.PI + Math.PI / 2;
    pts.push(P(-L + W + Math.cos(a) * W, Math.sin(a) * W));
  }
  // The thickness of the plank: the same outline nudged down, so it sits on the snow.
  ctx.save();
  ctx.translate(0, 2);
  poly(ctx, pts, tone(C.board, -0.4));
  ctx.restore();
  poly(ctx, pts, linGrad(ctx, -L, -6, L, 6, [tone(C.board, 0.2), C.board, tone(C.board, -0.14)]));
  const a = P(L * 0.72, 0), b = P(-L * 0.72, 0);
  line(ctx, a[0], a[1], b[0], b[1], CREAM, 2.4);
  const m = P(0, 0);
  ell(ctx, m[0], m[1], 2.6, 2.1, C.boardMark);
}

export function boardColors(look, teamColor) {
  const C = kidColors(look, teamColor);
  return { board: tone(C.scarf, -0.08), boardMark: tone(C.coat, -0.05) };
}

