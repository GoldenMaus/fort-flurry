// Fort Flurry — the seven regular foes.
// Each one owns a shape you can name from across the map before you can make out its colour: a
// pointy hood, an amber-goggled beanpole, a ball overhead, a wall of a kid, a red sled, a dented lid,
// a white shadow. All of them share plum trousers, so a crowd reads as one rival crew against the
// kids' matching coat-and-trousers.

import { ACTOR } from '../../shared/schema.js';
import {
  TAU, INK, CREAM, METAL, METAL_HI, METAL_LO, WOOD, WOOD_HI, WOOD_LO,
  ell, line, curve, capsule, litFill, linGrad, tone, alpha, clipped, snowball, seeded, paintCarrot, smoothPath,
} from './sprite-paint.js';
import { DIR_ANGLE, KID_DIMS, paintChibi, paintFace, poseIdle, poseWalk, poseHit, poseStun } from './sprite-chibi.js';

const CREW_PANTS = '#574a78';
const CREW_BOOT = '#3f3558';
const SKIN = '#f2c6a0';
const THIEF_BAND = '#3e3560';

const colors = (coat, mitt, skin = SKIN, extra = {}) => ({
  coat, mitt, skin, pants: CREW_PANTS, boot: CREW_BOOT, scarf: null,
  hair: '#6f4c34', cheek: 'rgba(233,96,110,0.5)', eye: INK, brow: INK, ...extra,
});

const PIP_DIMS = {
  ...KID_DIMS, R: 10.2, headU: 25.6, neckU: 18, shoulderU: 15.5, shoulderR: 9.4, hipU: 5.4,
  torso: [[12.6, 7, 5.2], [11.6, 12, 4.8], [9.8, 16, 4]], arm: [3.5, 2.9], mitt: 3.2, leg: [3.4, 3], crouch: 4,
};
const SLING_DIMS = {
  ...KID_DIMS, R: 9.2, headU: 37, neckU: 29.4, shoulderU: 26.5, shoulderR: 8.4, hipU: 13, hipR: 3.8, footR: 4,
  torso: [[9.2, 14, 5], [9.4, 20, 5.4], [8.6, 26, 4.4]], arm: [3, 2.5], mitt: 2.9, leg: [3, 2.6], crouch: 8,
};
const LOB_DIMS = {
  ...KID_DIMS, R: 10.2, headU: 27.4, neckU: 20.4, shoulderU: 18, shoulderR: 11.8,
  torso: [[14, 8, 5.8], [14.2, 13.6, 5.6], [11.6, 18.4, 4.8]], arm: [3.9, 3.4], mitt: 3.8, leg: [4, 3.4], crouch: 5,
};
const BIG_DIMS = {
  ...KID_DIMS, R: 8.4, headU: 30.2, neckU: 25, shoulderU: 22.5, shoulderR: 14.6, hipU: 7.6, hipR: 6.4, footR: 7,
  torso: [[13.8, 8.6, 5.4], [15.6, 14.4, 6.4], [16.2, 21, 5.8]], arm: [5.4, 4.6], mitt: 5.6, leg: [5, 4.4], crouch: 5,
};
const THIEF_DIMS = {
  ...KID_DIMS, R: 9.8, headU: 27.4, neckU: 20.4, shoulderU: 17.4, shoulderR: 8.8,
  torso: [[9.4, 8, 5], [9.8, 13, 5], [9.2, 17.6, 4.4]], arm: [3, 2.6], mitt: 2.9, leg: [3.1, 2.7], crouch: 5,
};

const SIZE = {
  [ACTOR.PIPSQUEAK]: 0.86, [ACTOR.SLINGER]: 1, [ACTOR.LOBBER]: 0.98, [ACTOR.BRUISER]: 1.82,
  [ACTOR.SLEDDER]: 1, [ACTOR.LIDKID]: 1, [ACTOR.SNEAK]: 0.92,
};

// Sized for the widest pose of each foe, so no frame clips.
function makeBox(kind) {
  const k = SIZE[kind] ?? 1;
  const extraTop = kind === ACTOR.LOBBER ? 26 : kind === ACTOR.SLINGER ? 12 : 0;
  const w = Math.ceil(76 * k), h = Math.ceil((80 + extraTop) * k);
  return Object.freeze({ w, h, ax: w / 2, ay: Math.ceil((66 + extraTop) * k) });
}

export const FOE_BOX = Object.freeze(Object.fromEntries(Object.keys(SIZE).map((k) => [k, makeBox(Number(k))])));
export const SLED_BOX = Object.freeze({ w: 92, h: 92, ax: 46, ay: 62 });

// ---- props -----------------------------------------------------------------------------------------

function paintFlag(ctx, x, y, frame, size = 1) {
  const top = y - 24 * size;
  line(ctx, x, y + 5 * size, x, top, WOOD, 1.7 * size);
  ell(ctx, x, top - 0.8 * size, 1.5 * size, 1.5 * size, WOOD_HI);
  const w = 17 * size, h = 11 * size, wave = (frame % 2 ? 1 : -1) * 2.4 * size;
  ctx.beginPath();
  ctx.moveTo(x, top + 0.5 * size);
  ctx.quadraticCurveTo(x + w * 0.4, top + 0.5 * size + wave, x + w * 0.62, top + 1.5 * size);
  ctx.quadraticCurveTo(x + w * 0.82, top + 2 * size - wave, x + w, top + 1 * size);
  ctx.lineTo(x + w, top + h);
  ctx.quadraticCurveTo(x + w * 0.82, top + h + 1 * size - wave, x + w * 0.62, top + h + 0.4 * size);
  ctx.quadraticCurveTo(x + w * 0.4, top + h + wave, x, top + h);
  ctx.closePath();
  ctx.fillStyle = linGrad(ctx, x, top, x + w, top + h, ['#ffffff', '#f3f4fb', '#c6c6e6']);
  ctx.fill();
  // White on white snow needs a lilac edge; this is the only reason the flag is legible.
  ctx.strokeStyle = alpha('#7f77b2', 0.55);
  ctx.lineWidth = 0.7 * size;
  ctx.stroke();
}

// The flag on its own, planted at the origin, for anyone who has no hand to hold it with.
export function paintFleeFlag(ctx, frame) {
  paintFlag(ctx, 0, -4, frame);
}

function paintSlingshot(ctx, x, y, th, pulled, pullX, pullY) {
  const c = Math.cos(th);
  const fx = x + c * 3, fork = y - 5, top = y - 14;
  line(ctx, x, y + 3, fx, fork, WOOD_LO, 2.8);
  curve(ctx, fx, fork, fx - 6.2, y - 8.5, fx - 5.4, top, WOOD, 2.6);
  curve(ctx, fx, fork, fx + 6.2, y - 8.5, fx + 5.4, top, WOOD_HI, 2.6);
  const bandX = pulled ? pullX : fx, bandY = pulled ? pullY : y - 6;
  ctx.strokeStyle = '#e0486a';
  ctx.lineWidth = 1.3;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(fx - 5.4, top);
  ctx.lineTo(bandX, bandY);
  ctx.lineTo(fx + 5.4, top);
  ctx.stroke();
}

// What is left of the sled after the crash. He will not let go of it, and it is what stops an on-foot
// Sledder sharing a silhouette with a player's kid.
function paintBrokenPlank(ctx, x, y, c) {
  const red = '#d6344a';
  ctx.save();
  ctx.translate(x, y + 1);
  ctx.rotate(c >= -0.1 ? 0.42 : -0.42);
  ctx.beginPath();
  ctx.moveTo(-3, 4);
  ctx.lineTo(3, 4);
  ctx.lineTo(3.2, -17);
  ctx.lineTo(1.4, -21);
  ctx.lineTo(0, -17.4);
  ctx.lineTo(-1.6, -22);
  ctx.lineTo(-3, -17);
  ctx.closePath();
  ctx.fillStyle = linGrad(ctx, -3, 0, 3, 0, [tone(red, 0.26), red, tone(red, -0.2)]);
  ctx.fill();
  // Bare wood at the break, so it reads as snapped and not simply cut short.
  ctx.beginPath();
  ctx.moveTo(-3, -16.4);
  ctx.lineTo(-1.6, -22);
  ctx.lineTo(0, -17.4);
  ctx.lineTo(1.4, -21);
  ctx.lineTo(3.2, -16.4);
  ctx.lineTo(0, -14.8);
  ctx.closePath();
  ctx.fillStyle = WOOD_HI;
  ctx.fill();
  ctx.restore();
}

// ---- headgear --------------------------------------------------------------------------------------

function pipHead(ctx, rig, C) {
  const { hx: x, hy, R, c, s, back } = rig;
  const hood = C.coat;
  const tipX = x - c * 6, tipY = hy - R - 13.5;
  ctx.beginPath();
  ctx.moveTo(x - R - 3, hy + 3);
  ctx.bezierCurveTo(x - R - 3.4, hy - R * 0.9, x - 5.6 + (tipX - x) * 0.5, hy - R - 2, tipX, tipY);
  ctx.bezierCurveTo(x + 5.6 + (tipX - x) * 0.5, hy - R - 2, x + R + 3.4, hy - R * 0.9, x + R + 3, hy + 3);
  ctx.bezierCurveTo(x + R + 3, hy + R + 2.6, x - R - 3, hy + R + 2.6, x - R - 3, hy + 3);
  ctx.closePath();
  ctx.fillStyle = litFill(ctx, x, hy - 4, R + 3, R + 7, hood, 0.2, 0.3);
  ctx.fill();
  ell(ctx, tipX, tipY - 0.4, 2.7, 2.7, '#f6c744');
  if (back) {
    ctx.beginPath();
    ctx.moveTo(x, hy - R - 2);
    ctx.quadraticCurveTo(x + 1.3, hy, x, hy + R);
    ctx.strokeStyle = alpha(tone(hood, -0.45), 0.5);
    ctx.lineWidth = 1;
    ctx.stroke();
    return;
  }
  // The fur ring frames the face; it stays readable when the features themselves do not.
  const fx = x + c * 4.2, fy = hy + 1.8 + s * 0.5;
  const rxF = (R - 0.4) * (0.72 + 0.28 * Math.abs(s)), ryF = R - 1.4;
  const rnd = seeded(5);
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * TAU;
    ell(ctx, fx + Math.cos(a) * (rxF + 0.7), fy + Math.sin(a) * (ryF + 0.7), 2.3 + rnd() * 0.7, 2.3 + rnd() * 0.7, i > 8 ? '#e7d6b6' : '#fbf1dc');
  }
  ell(ctx, fx, fy, rxF, ryF, litFill(ctx, fx, fy, rxF, ryF, C.skin, 0.12, 0.22));
}

function pipFace(ctx, rig, C) {
  if (rig.back) return;
  const { pose, hy } = rig;
  const face = { ...rig, hx: rig.hx - rig.c * 0.8, hy: hy - 0.6 };
  paintFace(ctx, face, C, pose.eyes, pose.mouth, pose.brow ?? 'angry');
}

function slingHat(ctx, rig, C) {
  const { hx: x, hy, R, c, s, back } = rig;
  const cap = '#8a5a34';
  ctx.beginPath();
  ctx.moveTo(x - R - 1.4, hy + 1.5);
  ctx.bezierCurveTo(x - R - 1.8, hy - R - 2, x + R + 1.8, hy - R - 2, x + R + 1.4, hy + 1.5);
  ctx.quadraticCurveTo(x, hy - 2.4, x - R - 1.4, hy + 1.5);
  ctx.closePath();
  ctx.fillStyle = litFill(ctx, x, hy - 4, R, 7, cap, 0.22, 0.28);
  ctx.fill();
  // Leather ear flaps, strapped down.
  for (const sd of [-1, 1]) {
    if (Math.abs(c) > 0.85 && sd * c > 0) continue;
    const fx = x + sd * (R - 0.6) - c * 2.6;
    ell(ctx, fx, hy + 4.6, 3, 5.4, litFill(ctx, fx, hy + 4.6, 3, 5.4, tone(cap, -0.08), 0.15, 0.25));
  }
  if (back) {
    // Goggle strap across the back of the head keeps him recognisable walking away.
    ctx.beginPath();
    ctx.moveTo(x - R - 0.6, hy - 3);
    ctx.quadraticCurveTo(x, hy - 0.4, x + R + 0.6, hy - 3);
    ctx.strokeStyle = '#d9862a';
    ctx.lineWidth = 2.2;
    ctx.stroke();
    return;
  }
  const fx = x + c * R * 0.46, fy = hy - 1.4 + s * 0.5;
  const sq = 0.62 + 0.38 * Math.abs(s);
  const gap = 4.6 * sq, rad = 4.5;
  ctx.beginPath();
  ctx.moveTo(fx - gap - rad, fy);
  ctx.lineTo(x - R - 0.8, fy - 0.4);
  ctx.moveTo(fx + gap + rad, fy);
  ctx.lineTo(x + R + 0.8, fy - 0.4);
  ctx.strokeStyle = '#d9862a';
  ctx.lineWidth = 2.2;
  ctx.lineCap = 'butt';
  ctx.stroke();
  for (const d of [-1, 1]) {
    const gx = fx + d * gap;
    const wide = rig.pose.eyes === 'squeeze' || rig.pose.eyes === 'dizzy';
    ell(ctx, gx, fy, rad + 1, rad + 0.9, '#b8551c');
    ell(ctx, gx, fy, rad, rad - 0.1, linGrad(ctx, gx - rad, fy - rad, gx + rad, fy + rad, ['#fff0a8', '#ffc640', '#f08a24']));
    ell(ctx, gx - 1.5, fy - 1.6, 1.4, 1, 'rgba(255,255,255,0.9)', -0.5);
    if (wide) line(ctx, gx - 2.2, fy - 1.5, gx + 2.2, fy + 1.5, INK, 0.9);
    if (wide) line(ctx, gx - 2.2, fy + 1.5, gx + 2.2, fy - 1.5, INK, 0.9);
    else ell(ctx, gx + c * 1.2, fy + 0.8, 1.15, 1.25, INK);
  }
}

function slingFace(ctx, rig, C) {
  if (rig.back) return;
  const { hx, hy, c, s } = rig;
  const fx = hx + c * rig.R * 0.46, fy = hy + 6 + s * 0.7;
  ell(ctx, fx - 5.4, fy - 1.4, 1.8, 1.1, C.cheek);
  ell(ctx, fx + 5.4, fy - 1.4, 1.8, 1.1, C.cheek);
  const dark = '#8a3a4a';
  switch (rig.pose.mouth) {
    case 'o': ell(ctx, fx, fy, 1.4, 1.7, dark); break;
    case 'wobble': curve(ctx, fx - 2, fy, fx, fy + 1.6, fx + 2, fy - 0.6, dark, 0.95); break;
    default: curve(ctx, fx - 2.2, fy - 0.6, fx + 0.6, fy + 1.3, fx + 2.6, fy - 1.1, dark, 1);
  }
}

function lobHat(ctx, rig) {
  const { hx: x, hy, R, c, back } = rig;
  const hair = '#5e3b2a';
  // Tufts of hair over a knotted headband: nothing that fights the ball above.
  const rnd = seeded(9);
  for (let i = 0; i < 9; i++) {
    const a = Math.PI + (i / 8) * Math.PI;
    const px = x + Math.cos(a) * R * 0.9, py = hy - 2 + Math.sin(a) * R * 0.92;
    ell(ctx, px, py, 3.4, 4, i % 2 ? hair : tone(hair, 0.12), a + Math.PI / 2 + rnd() * 0.4);
  }
  ctx.beginPath();
  ctx.moveTo(x - R - 0.4, hy - 2.6);
  ctx.quadraticCurveTo(x, hy + (back ? 1.5 : -0.2), x + R + 0.4, hy - 2.6);
  ctx.lineTo(x + R + 0.2, hy - 6.4);
  ctx.quadraticCurveTo(x, hy + (back ? -2.2 : -4), x - R - 0.2, hy - 6.4);
  ctx.closePath();
  ctx.fillStyle = litFill(ctx, x, hy - 4, R, 3, '#f2c031', 0.2, 0.2);
  ctx.fill();
  const kx = x - c * R * 0.9;
  ell(ctx, kx, hy - 4, 2, 2, '#d99c1e');
  curve(ctx, kx, hy - 4, kx - 3, hy - 2, kx - 3.4, hy + 1, '#f2c031', 1.5);
}

function bigHat(ctx, rig) {
  const { hx: x, hy, R, s } = rig;
  const col = '#2f4a78';
  const top = hy - R - 2.2, brim = hy - 3.6 + (1 - s) * 1.2;
  ctx.beginPath();
  ctx.moveTo(x - R * 0.82, brim);
  ctx.bezierCurveTo(x - R * 0.8, top, x + R * 0.8, top, x + R * 0.82, brim);
  ctx.quadraticCurveTo(x, brim + 1.6, x - R * 0.82, brim);
  ctx.closePath();
  ctx.fillStyle = litFill(ctx, x, (top + brim) / 2, R, 5, col, 0.2, 0.25);
  ctx.fill();
  ell(ctx, x, brim + 0.4, R * 0.9, 1.9, tone(col, 0.3));
}

function lidHat(ctx, rig) {
  const { hx: x, hy, R, c, s, back } = rig;
  // A saucepan worn as a helmet, handle out the back: the Lid Kid raids the same kitchen as the lid.
  const hb = c > 0.3 ? -1 : c < -0.3 ? 1 : (back ? 0.4 : -0.4);
  const brim = hy - 2.4 + (1 - s) * (s < 0 ? 3 : 1.1), top = hy - R - 3.8;
  const hw = R + 0.8;
  line(ctx, x + hb * (hw - 1), brim - 3.6 + (back ? 0 : 0.4), x + hb * (hw + 10.5), brim - 7 - Math.abs(hb) * 0, METAL_LO, 3.4);
  line(ctx, x + hb * (hw - 1), brim - 4, x + hb * (hw + 10.5), brim - 7.4, METAL, 2);
  ctx.beginPath();
  ctx.moveTo(x - hw, brim);
  ctx.lineTo(x - hw + 0.7, top + 2);
  ctx.quadraticCurveTo(x, top - 2, x + hw - 0.7, top + 2);
  ctx.lineTo(x + hw, brim);
  ctx.quadraticCurveTo(x, brim + 2.4, x - hw, brim);
  ctx.closePath();
  ctx.fillStyle = linGrad(ctx, x - hw, top, x + hw, brim, [METAL_HI, METAL, METAL_LO]);
  ctx.fill();
  ell(ctx, x - 4, top + 3.2, 3.2, 1.8, 'rgba(255,255,255,0.75)', -0.2);
  ell(ctx, x + 4.5, brim - 3.2, 2.5, 1.6, alpha(METAL_LO, 0.7));
  ctx.beginPath();
  ctx.moveTo(x - hw, brim);
  ctx.quadraticCurveTo(x, brim + 2.4, x + hw, brim);
  ctx.strokeStyle = METAL_HI;
  ctx.lineWidth = 1.3;
  ctx.stroke();
}

function helmetHat(ctx, rig) {
  const { hx: x, hy, R, c, s } = rig;
  const red = '#d6344a';
  const brim = hy - 0.4 + (1 - s) * 0.8, top = hy - R - 2.8, hw = R + 1.7;
  ctx.beginPath();
  ctx.moveTo(x - hw, brim + 2.5);
  ctx.bezierCurveTo(x - hw - 0.4, top - 0.4, x + hw + 0.4, top - 0.4, x + hw, brim + 2.5);
  ctx.quadraticCurveTo(x, brim - 1.5, x - hw, brim + 2.5);
  ctx.closePath();
  ctx.fillStyle = litFill(ctx, x, (top + brim) / 2, hw, 8, red, 0.3, 0.24);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(x - 2.3 - c * 2, top + 0.3);
  ctx.quadraticCurveTo(x - 2.6 - c * 3, (top + brim) / 2, x - 3 - c * 2, brim);
  ctx.lineTo(x + 3 - c * 2, brim);
  ctx.quadraticCurveTo(x + 2.6 - c * 3, (top + brim) / 2, x + 2.3 - c * 2, top + 0.3);
  ctx.closePath();
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  ell(ctx, x - 5.4, top + 4, 2.6, 1.6, 'rgba(255,255,255,0.65)', -0.5);
}

function thiefHead(ctx, rig) {
  const { hx: x, hy, R, c, s, back } = rig;
  // A snow-white balaclava. All of the character sits in the dark band across the eyes.
  ell(ctx, x, hy, R * 1.05, R, linGrad(ctx, x - R, hy - R, x + R, hy + R, ['#ffffff', '#e8ebf6', '#a9a9d4']));
  const band = THIEF_BAND;
  const y = hy + (back ? -2 : -0.3 + s * 0.3);
  ctx.beginPath();
  ctx.moveTo(x - R * 1.06, y - 2.3);
  ctx.quadraticCurveTo(x, y - 4.2 + (back ? 4 : 0), x + R * 1.06, y - 2.3);
  ctx.lineTo(x + R * 1.04, y + 3);
  ctx.quadraticCurveTo(x, y + 4.8 + (back ? 3 : 0), x - R * 1.04, y + 3);
  ctx.closePath();
  ctx.fillStyle = band;
  ctx.fill();
  // Knot tails trail behind the head, the one flourish he allows himself.
  const kx = c > 0.3 ? x - R : c < -0.3 ? x + R : x + R * 0.7;
  const dir = c > 0.3 ? -1 : 1;
  curve(ctx, kx, y + 0.4, kx + dir * 5, y - 1, kx + dir * 9, y + 2.4, band, 1.8);
  curve(ctx, kx, y + 0.8, kx + dir * 4, y + 3, kx + dir * 7, y + 6.4, band, 1.6);
}

function thiefFace(ctx, rig) {
  if (rig.back) return;
  const { hx, hy, c, s, pose } = rig;
  const fx = hx + c * rig.R * 0.46, fy = hy + 0.2 + s * 0.3;
  const sq = 0.6 + 0.4 * Math.abs(s);
  for (const d of [-1, 1]) {
    const x = fx + d * 4.1 * sq;
    if (pose.eyes === 'squeeze') {
      line(ctx, x - 1.6, fy, x + 1.6, fy, '#ffffff', 1.3);
      continue;
    }
    if (pose.eyes === 'dizzy') {
      ell(ctx, x, fy, 1.8, 1.8, '#ffffff');
      ell(ctx, x, fy, 0.8, 0.8, THIEF_BAND);
      continue;
    }
    ctx.beginPath();
    ctx.moveTo(x - 2.6, fy - 0.2 + d * 0.9);
    ctx.quadraticCurveTo(x, fy - 2.2 - d * 0.1, x + 2.6, fy - 0.2 - d * 0.9);
    ctx.quadraticCurveTo(x, fy + 2.2, x - 2.6, fy - 0.2 + d * 0.9);
    ctx.closePath();
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ell(ctx, x + c * 0.7, fy, 1, 1.1, INK);
  }
}

// ---- bespoke torsos --------------------------------------------------------------------------------

function bigChest(ctx, rig) {
  if (rig.back) return;
  const { chest, c } = rig;
  // Two pale chest stripes give the slab of coat a scale reference and a varsity swagger.
  const x = chest[0] + c * 6;
  const y = chest[1] + 2.2;
  ctx.strokeStyle = alpha('#fff0d8', 0.9);
  ctx.lineCap = 'round';
  ctx.lineWidth = 2.6;
  for (const k of [0, 5.4]) {
    ctx.beginPath();
    ctx.moveTo(x - 12, y + k - 0.6);
    ctx.quadraticCurveTo(x, y + k + 2.6, x + 12, y + k - 0.6);
    ctx.stroke();
  }
}

function lidChest(ctx, rig) {
  if (rig.back) return;
  const { chest, c } = rig;
  const x = chest[0] + c * 6, y = chest[1] + 4;
  ell(ctx, x - 3, y, 1.9, 1.4, alpha('#6f4f22', 0.6));
  line(ctx, x + 2.5, y + 3, x + 6, y + 5, alpha('#6f4f22', 0.6), 1.1);
}

function thiefChest(ctx, rig) {
  const { chest, c } = rig;
  const y = chest[1] + 7.2;
  const x = chest[0] + c * 2;
  ctx.beginPath();
  ctx.moveTo(x - 9.6, y - 1);
  ctx.quadraticCurveTo(x, y + 2.6, x + 9.6, y - 1);
  ctx.strokeStyle = '#3e3560';
  ctx.lineWidth = 2.4;
  ctx.lineCap = 'butt';
  ctx.stroke();
}

// ---- poses -----------------------------------------------------------------------------------------

function flagPose(pose) {
  return { ...pose, handR: [2, 10, 31], brow: 'sad', eyes: 'closed', mouth: 'wobble' };
}

function pipPose(name, frame) {
  switch (name) {
    case 'idle': return { ...poseIdle(frame), handL: [1, -12, 8], handR: [1, 12, 8], eyes: 'open', mouth: 'smirk', brow: 'angry' };
    case 'walk': {
      const p = poseWalk(frame, 4);
      return { ...p, tilt: (frame % 2 ? 1 : -1) * 0.075, lean: 1.4, mouth: 'smirk', brow: 'angry',
        footL: [p.footL[0] * 0.72, -4.4, p.footL[2]], footR: [p.footR[0] * 0.72, 4.4, p.footR[2]] };
    }
    case 'throw': return frame === 0
      ? { handR: [-5, 11, 29], handL: [8, -9, 14], footL: [3, -5, 0], footR: [-3, 5, 0], lean: -2, ball: { side: 'R', r: 3.6 }, eyes: 'focus', mouth: 'grit', brow: 'angry' }
      : { handR: [13, 7, 19], handL: [-5, -11, 10], footL: [4, -5, 0], footR: [-4, 5, 1.5], lean: 4, eyes: 'focus', mouth: 'o', brow: 'angry' };
    default: return null;
  }
}

function slingPose(name, frame) {
  const base = { handL: [6, -9, 21], handR: [4, 9, 16] };
  switch (name) {
    case 'idle': return { ...poseIdle(frame), ...base, footL: [0, -4, 0], footR: [0, 4, 0], bob: frame ? 0.5 : 0 };
    case 'walk': {
      const p = poseWalk(frame, 4);
      return { ...p, handL: [7, -8.5, 21 + (frame % 2)], handR: [3 + p.handR[0] * 0.5, 9.5, 15],
        footL: [p.footL[0] * 1.25, -3.8, p.footL[2] * 1.1], footR: [p.footR[0] * 1.25, 3.8, p.footR[2] * 1.1] };
    }
    case 'throw': return frame === 0
      ? { handL: [14, -5, 26], handR: [-3, 8, 26], footL: [5, -4, 0], footR: [-5, 4, 0], lean: -1.6, ball: { side: 'R', r: 2.6 }, pull: true }
      : { handL: [15, -4, 25], handR: [8, 9, 21], footL: [5, -4, 0], footR: [-5, 4, 0], lean: 1.6 };
    default: return null;
  }
}

function lobPose(name, frame) {
  const hold = { handL: [0, -9.5, 42], handR: [0, 9.5, 42], carry: true };
  switch (name) {
    case 'idle': return { ...poseIdle(frame), ...hold, brow: 'angry', mouth: 'grit', handL: [0, -9.5, 42 + (frame ? 0.6 : 0)], handR: [0, 9.5, 42 + (frame ? 0.6 : 0)] };
    case 'walk': {
      const p = poseWalk(frame, 4);
      return { ...p, ...hold, lean: 0.6, tilt: (frame % 2 ? 1 : -1) * 0.05, brow: 'angry', mouth: 'grit' };
    }
    case 'hit': return { ...poseHit(), handL: [-2, -10, 42], handR: [-2, 10, 42], carry: true };
    case 'throw': return frame === 0
      ? { handL: [-7, -9, 40], handR: [-7, 9, 40], footL: [5, -5, 0], footR: [-5, 5, 0], lean: -3.6, carry: true, ballBack: true, eyes: 'focus', mouth: 'grit', brow: 'angry' }
      : { handL: [13, -7, 30], handR: [13, 7, 30], footL: [5, -5, 0], footR: [-5, 5, 1.5], lean: 4, eyes: 'focus', mouth: 'o', brow: 'angry' };
    default: return null;
  }
}

function bigPose(name, frame) {
  switch (name) {
    case 'idle': return { ...poseIdle(frame), handL: [1, -16.6, 7], handR: [1, 16.6, 7], footL: [0, -7, 0], footR: [0, 7, 0], eyes: 'open', mouth: 'flat', brow: 'angry' };
    case 'walk': {
      const p = poseWalk(frame, 4);
      return { ...p, handL: [-p.footL[0] * 0.45 + 2, -16.6, 7.6], handR: [-p.footR[0] * 0.45 + 2, 16.6, 7.6],
        footL: [p.footL[0] * 0.9, -6.8, p.footL[2] * 0.8], footR: [p.footR[0] * 0.9, 6.8, p.footR[2] * 0.8],
        tilt: (frame % 2 ? 1 : -1) * 0.04, lean: 1.2, mouth: 'flat', brow: 'angry' };
    }
    case 'throw': return frame === 0
      ? { handL: [-3, -15, 20], handR: [-3, 15, 20], footL: [5, -7, 0], footR: [-5, 7, 0], lean: -2.4, eyes: 'focus', mouth: 'grit', brow: 'angry' }
      : { handL: [18, -9, 16], handR: [18, 9, 16], footL: [6, -7, 0], footR: [-6, 7, 2], lean: 5, eyes: 'squeeze', mouth: 'grit', brow: 'angry' };
    default: return null;
  }
}

function lidPose(name, frame) {
  const held = { handL: [8, -10, 15] };
  switch (name) {
    case 'idle': return { ...poseIdle(frame), ...held, brow: 'angry', mouth: 'grit' };
    case 'walk': return { ...poseWalk(frame, 4), ...held, brow: 'angry', mouth: 'grit' };
    case 'throw': return frame === 0
      ? { ...held, handR: [-4, 11, 28], footL: [3, -5, 0], footR: [-3, 5, 0], lean: -1.4, ball: { side: 'R', r: 3.6 }, eyes: 'focus', mouth: 'grit', brow: 'angry' }
      : { ...held, handR: [12, 8, 20], footL: [4, -5, 0], footR: [-4, 5, 1.5], lean: 3, eyes: 'focus', mouth: 'o', brow: 'angry' };
    default: return null;
  }
}

function sneakPose(name, frame, carrying) {
  switch (name) {
    case 'idle': return carrying
      ? { ...poseIdle(frame), handL: [0, -8, 37], handR: [0, 8, 37], lean: 1 }
      : { ...poseIdle(frame), crouch: 0.5, lean: 3.5, handL: [5, -10, 15], handR: [5, 10, 15] };
    case 'walk': {
      // The cartoon burglar's run: bent double, arms flung back, feet barely touching the ground.
      const p = poseWalk(frame, 4);
      const stride = { footL: [p.footL[0] * 1.5, -3.8, p.footL[2] * 1.5], footR: [p.footR[0] * 1.5, 3.8, p.footR[2] * 1.5] };
      // With the prize he stops slinking and runs for it, carrot held high: nobody said he was subtle.
      if (carrying) return { ...p, ...stride, handL: [0, -8, 37], handR: [0, 8, 37], crouch: 0.1, lean: 2.4 };
      return { ...p, ...stride, handL: [-12, -9.5, 15], handR: [-12, 9.5, 15], crouch: 0.55, lean: 6.4 };
    }
    default: return null;
  }
}

const POSES = {
  [ACTOR.PIPSQUEAK]: pipPose, [ACTOR.SLINGER]: slingPose, [ACTOR.LOBBER]: lobPose, [ACTOR.BRUISER]: bigPose,
  [ACTOR.SLEDDER]: pipPose, [ACTOR.LIDKID]: lidPose, [ACTOR.SNEAK]: sneakPose,
};

function basePose(kind, name, frame, carrying) {
  const fn = POSES[kind];
  const own = fn?.(name, frame, carrying);
  if (own) return own;
  if (name === 'hit') return poseHit();
  if (name === 'stun') return poseStun(frame);
  return fn?.('idle', frame) ?? poseIdle(frame);
}

function buildPose(kind, name, frame, carrying) {
  if (name === 'flee') {
    const walkFrame = frame;
    const p = basePose(kind, 'walk', walkFrame, false);
    const q = flagPose(p);
    q.carry = false;
    if (kind === ACTOR.LOBBER) { q.handL = [1, -13, 12]; q.handR = [2, 10, 34]; }
    if (kind === ACTOR.BRUISER) q.handR = [2, 13, 37];
    if (kind === ACTOR.LIDKID) q.handL = [1, -13, 9];
    if (kind === ACTOR.SNEAK) { q.handR = [1, 9, 30]; q.handL = [-9, -9, 15]; q.crouch = 0.25; q.lean = 3; }
    if (kind === ACTOR.SLINGER) q.handL = [2, -9.5, 11];
    return q;
  }
  return basePose(kind, name, frame, carrying);
}

// ---- complete foes ---------------------------------------------------------------------------------

function pipsqueak() {
  const C = colors('#7db13a', '#e5752d');
  return { C, dims: PIP_DIMS, hooks: { head: pipHead, face: (ctx, rig) => pipFace(ctx, rig, C) } };
}

function slinger() {
  const C = colors('#1f96a6', '#f0a13a', SKIN, { zip: null });
  return {
    C, dims: SLING_DIMS,
    hooks: {
      hat: (ctx, rig) => slingHat(ctx, rig, C),
      face: (ctx, rig) => slingFace(ctx, rig, C),
      hand(ctx, rig, side, hd) {
        if (side !== 'L' || rig.pose.flee) return;
        const hr = rig.hand.R;
        const hp = rig.P(hr[0], hr[1], hr[2]);
        paintSlingshot(ctx, hd[0], hd[1], rig.th, !!rig.pose.pull, hp[0], hp[1]);
      },
    },
  };
}

function lobber() {
  const C = colors('#b2478f', '#f2c031', '#e9b48c', { zip: null });
  return {
    C, dims: LOB_DIMS,
    hooks: {
      hat: lobHat,
      over(ctx, rig) {
        if (!rig.pose.carry) return;
        const { P, pose } = rig;
        const hl = rig.hand.L, hr = rig.hand.R;
        const [x, y] = P((hl[0] + hr[0]) / 2 + (pose.ballBack ? -2 : 0), (hl[1] + hr[1]) / 2, (hl[2] + hr[2]) / 2 + 8.5);
        snowball(ctx, x, y, 11.4);
        for (const h of [hl, hr]) {
          const q = P(h[0], h[1], h[2]);
          ell(ctx, q[0], q[1], 3.8, 3.5, litFill(ctx, q[0], q[1], 3.8, 3.5, C.mitt, 0.24, 0.24));
        }
      },
    },
  };
}

function bruiser() {
  const C = colors('#d8622a', '#2f4a78', '#e8b48f', { zip: null, hood: false });
  return {
    C, dims: BIG_DIMS,
    hooks: { hat: bigHat, chest: bigChest },
  };
}

function sledder() {
  const C = colors('#efb82c', '#d6344a', SKIN, { zip: null });
  return {
    C, dims: KID_DIMS,
    hooks: {
      hat: helmetHat,
      face: (ctx, rig) => paintFace(ctx, rig, C, rig.pose.eyes, rig.pose.mouth, rig.pose.brow ?? 'angry'),
      hand(ctx, rig, side, hd) { if (side === 'L') paintBrokenPlank(ctx, hd[0], hd[1], rig.c); },
    },
  };
}

function lidKid() {
  const C = colors('#b98b3e', '#6f7f96', SKIN, { zip: null });
  return {
    C, dims: KID_DIMS,
    hooks: { hat: lidHat, chest: lidChest },
  };
}

function thief() {
  // White enough to vanish against a drift, but a shade under the snow so the shading has room to work.
  const C = colors('#e3e6f4', '#3e3560', '#ffffff', { zip: null, pants: '#d3d7ec', boot: '#3e3560', hood: false, cheek: 'rgba(0,0,0,0)' });
  return {
    C, dims: THIEF_DIMS,
    hooks: {
      head: thiefHead,
      face: thiefFace,
      chest: thiefChest,
      over(ctx, rig) {
        if (!rig.pose.haul) return;
        const { P, c } = rig;
        const hl = rig.hand.L, hr = rig.hand.R;
        const [x, y] = P((hl[0] + hr[0]) / 2, (hl[1] + hr[1]) / 2, hl[2] + 3);
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(c >= -0.1 ? -0.16 : Math.PI + 0.16);
        ctx.translate(-15, 0);
        paintCarrot(ctx, 31, 5.4);
        ctx.restore();
        // Mittens go back on top so he is visibly holding it, not wearing it.
        for (const h of [hl, hr]) {
          const q = P(h[0], h[1], h[2]);
          ell(ctx, q[0], q[1] + 1, 2.9, 2.7, C.mitt);
        }
      },
    },
  };
}

const BUILD = {
  [ACTOR.PIPSQUEAK]: pipsqueak, [ACTOR.SLINGER]: slinger, [ACTOR.LOBBER]: lobber, [ACTOR.BRUISER]: bruiser,
  [ACTOR.SLEDDER]: sledder, [ACTOR.LIDKID]: lidKid, [ACTOR.SNEAK]: thief,
};

export function paintSled(ctx, th) {
  const c = Math.cos(th), s = Math.sin(th);
  const D = 0.62;
  const P = (f, r, u) => [f * c - r * s, (f * s + r * c) * D - u];
  const red = '#d6344a';
  const L = 27, W = 11.5;
  // Runners first, out to each side, so they peek under the deck from any heading.
  for (const r of [-W, W]) {
    const pts = [P(-L + 2, r, 1), P(L - 6, r, 1), P(L, r, 4), P(L + 1, r, 8)];
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    ctx.lineTo(pts[1][0], pts[1][1]);
    ctx.quadraticCurveTo(pts[2][0], pts[2][1], pts[3][0], pts[3][1]);
    ctx.strokeStyle = METAL_LO;
    ctx.lineWidth = 2.2;
    ctx.lineCap = 'round';
    ctx.stroke();
    for (const f of [-L + 9, L - 15]) {
      const a = P(f, r, 1), b = P(f, r, 6);
      line(ctx, a[0], a[1], b[0], b[1], tone(red, -0.4), 2.2);
    }
  }
  const deck = [P(-L, -W, 6), P(L - 7, -W, 6), P(L + 1, -W * 0.8, 8), P(L + 1, W * 0.8, 8), P(L - 7, W, 6), P(-L, W, 6)];
  ctx.save();
  ctx.translate(0, 2.3);
  smoothPath(ctx, deck, true, 0.25);
  ctx.fillStyle = tone(red, -0.42);
  ctx.fill();
  ctx.restore();
  smoothPath(ctx, deck, true, 0.25);
  ctx.fillStyle = linGrad(ctx, -L, -W, L, W, [tone(red, 0.26), red, tone(red, -0.16)]);
  ctx.fill();
  clipped(ctx, () => {
    for (const r of [-W * 0.42, W * 0.42]) {
      const a = P(-L, r, 6), b = P(L + 2, r, 7);
      line(ctx, a[0], a[1], b[0], b[1], alpha(tone(red, -0.5), 0.55), 1.1);
    }
  });
}

function paintSledRide(ctx, th, frame, fleeing) {
  const B = sledder();
  const s = Math.sin(th);
  const pose = {
    th, crouch: 1.65, lean: 1.8, bob: 3.5 + (frame ? 0.5 : 0),
    footL: [15, -6, 7], footR: [15, 6, 7],
    handL: [13, -7, 11], handR: [13, 7, 11],
    eyes: fleeing ? 'closed' : 'open', mouth: fleeing ? 'wobble' : 'grin', brow: fleeing ? 'sad' : 'angry',
  };
  if (fleeing) pose.handR = [-3, 9, 33];
  const rope = () => {
    const c = Math.cos(th);
    const P = (f, r, u) => [f * c - r * s, (f * s + r * c) * 0.62 - u];
    const a = P(26, -8, 9), m = P(14, -7, 12), b = P(26, 8, 9), n = P(14, 7, 12);
    curve(ctx, a[0], a[1], (a[0] + m[0]) / 2, (a[1] + m[1]) / 2 + 3, m[0], m[1], CREAM, 1.1);
    curve(ctx, b[0], b[1], (b[0] + n[0]) / 2, (b[1] + n[1]) / 2 + 3, n[0], n[1], CREAM, 1.1);
  };
  paintSled(ctx, th);
  rope();
  const hooks = {
    ...B.hooks,
    hand(ctx2, rig, side, hd) { if (fleeing && side === 'R') paintFlag(ctx2, hd[0], hd[1], frame); },
  };
  paintChibi(ctx, B.C, B.dims, pose, hooks);
}

export function paintFoe(ctx, kind, name, frame, dirIdx, carrying = false) {
  const th = DIR_ANGLE[dirIdx];
  if (name === 'sled' || name === 'sledflee') {
    paintSledRide(ctx, th, frame, name === 'sledflee');
    return;
  }
  const B = BUILD[kind]();
  const pose = buildPose(kind, name, frame, carrying);
  pose.th = th;
  const fleeing = name === 'flee';
  if (fleeing) pose.flee = true;
  if (kind === ACTOR.SNEAK && carrying) pose.haul = true;
  const hooks = { ...B.hooks };
  if (fleeing) {
    const inner = hooks.hand;
    const size = kind === ACTOR.BRUISER ? 0.72 : 1;
    hooks.hand = (c, rig, side, hd) => {
      if (side === 'R') paintFlag(c, hd[0], hd[1], frame, size);
      return inner?.(c, rig, side, hd);
    };
  }
  const k = SIZE[kind] ?? 1;
  ctx.save();
  ctx.scale(k, k);
  paintChibi(ctx, B.C, B.dims, pose, hooks);
  ctx.restore();
}

// The Lid Kid's shield, seen from any angle. The lid swings on its own, independent of the body, and
// in this projection a disc turned side-on would vanish to a line, so a floor on its apparent width
// keeps it a lid.
export function paintLid(ctx, aim) {
  const c = Math.cos(aim), s = Math.sin(aim);
  const R = 14.6;
  const tx = -s, ty = c * 0.5;
  const wide = Math.max(0.42, Math.abs(tx));
  const k = (tx >= 0 ? 1 : -1) * wide;
  // The rim itself is bent in two places: at game size that notch is what says "dented".
  const rim = [];
  for (let i = 0; i < 22; i++) {
    const a = (i / 22) * TAU;
    const hit = Math.exp(-(((a - 5.4) / 0.42) ** 2)) * 0.2 + Math.exp(-(((a - 2.3) / 0.3) ** 2)) * 0.13;
    rim.push([Math.cos(a) * R * (1 - hit), Math.sin(a) * R * (1 - hit)]);
  }
  ctx.save();
  ctx.transform(k, ty, 0, 0.9, 0, 0);
  smoothPath(ctx, rim, true, 0.5);
  ctx.fillStyle = METAL_LO;
  ctx.fill();
  ctx.save();
  ctx.translate(0.2, 0.2);
  ctx.scale(0.9, 0.9);
  smoothPath(ctx, rim, true, 0.5);
  if (s > -0.15) {
    ctx.fillStyle = linGrad(ctx, -R, -R, R, R, [METAL_HI, METAL, METAL_LO]);
    ctx.fill();
    ctx.restore();
    // Radial corrugation, then the two big dents, then the knob the bin men would grab.
    ctx.strokeStyle = alpha(METAL_LO, 0.55);
    ctx.lineWidth = 0.9;
    ctx.lineCap = 'round';
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * TAU + 0.2;
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * 5, Math.sin(a) * 5);
      ctx.lineTo(Math.cos(a) * 10.4, Math.sin(a) * 10.4);
      ctx.stroke();
    }
    for (const [x, y, r, a] of [[6.6, -6.6, 4.6, 0.8], [-6.8, 5.4, 3.6, -0.5]]) {
      ell(ctx, x, y, r, r * 0.72, alpha('#4f5d74', 0.75), a);
      ell(ctx, x + 0.9, y + 1, r * 0.72, r * 0.42, alpha(METAL_HI, 0.9), a);
    }
    ell(ctx, 0.4, 0.8, 3.3, 2.6, '#4f5d74');
    ell(ctx, 0, 0, 3, 2.2, METAL_HI);
    ell(ctx, -6.4, -8, 3.2, 1.4, 'rgba(255,255,255,0.8)', -0.7);
  } else {
    ctx.fillStyle = linGrad(ctx, -R, -R, R, R, ['#8c9ab0', '#74839b', '#5a6880']);
    ctx.fill();
    ctx.restore();
    capsule(ctx, -6, 0, 2.2, 6, 0, 2.2, METAL_HI);
    ell(ctx, 0, 1.6, 3.6, 3, '#b98b3e');
  }
  ctx.restore();
}
