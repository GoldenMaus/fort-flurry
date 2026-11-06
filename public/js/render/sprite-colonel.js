// Fort Flurry — Colonel Carrot, the only snowman in the game.
// Three stout balls, bucket helmet with stars, arm locked in a salute and absolutely no sense of humour
// about any of this. The body is one cached sprite per damage tier; the eyes, nose, mouth, arms and
// bucket are separate so he can watch threats, flinch and lose his hat while the snow stays cached.

import { TEAM_STYLE } from '../../shared/constants.js';
import {
  TAU, SNOW, SNOW_HI, SNOW_LOW, SNOW_MID, LILAC, LILAC_DEEP, GOLD, GOLD_LO, METAL, METAL_HI, METAL_LO, WOOD, WOOD_HI, WOOD_LO,
  ell, line, linGrad, alpha, clipped, tone, star5, seeded, capsule, paintCarrot,
} from './sprite-paint.js';

export const COLONEL_BOX = Object.freeze({ w: 116, h: 128, ax: 58, ay: 110 });
export const BUCKET_BOX = Object.freeze({ w: 62, h: 50, ax: 31, ay: 38 });

// Ground contact sits forward of his footprint's centre so the 3/4 view reads him as standing on it.
export const COLONEL_FOOT_Y = 66;

export const HEAD_Y = -71;
export const HEAD_R = 16.4;
const MID_Y = -48;
const MID_R = 21.6;
const BASE_Y = -23;

// Each threshold takes one more thing away. hp fraction in, tier number out.
const TIER_AT = [0.88, 0.74, 0.6, 0.46, 0.32, 0.18];
export function tierOf(f) {
  let t = 0;
  while (t < TIER_AT.length && f < TIER_AT[t]) t++;
  return t;
}

function snowBall(ctx, x, y, rx, ry, tierBites, seed) {
  ctx.beginPath();
  ctx.ellipse(x, y, rx, ry, 0, 0, TAU);
  ctx.fillStyle = linGrad(ctx, x - rx * 0.7, y - ry, x + rx * 0.6, y + ry, [SNOW_HI, SNOW, SNOW_MID, SNOW_LOW]);
  ctx.fill();
  clipped(ctx, () => {
    // Bounce light under the ball is what gives white-on-white its volume.
    ell(ctx, x + rx * 0.3, y + ry * 0.95, rx * 0.95, ry * 0.5, alpha(LILAC, 0.42));
    ell(ctx, x - rx * 0.3, y - ry * 0.4, rx * 0.5, ry * 0.36, alpha('#ffffff', 0.85), -0.4);
  });
  // Bites come out of the silhouette at the flanks, where nothing else stands behind him. The lilac
  // lip left around each hole is the inside of the snow showing.
  const rnd = seeded(seed);
  for (let i = 0; i < tierBites; i++) {
    const left = (i + seed) % 2 === 0;
    const a = (left ? Math.PI : 0) + (rnd() - 0.5) * 1.2;
    const bx = x + Math.cos(a) * rx, by = y + Math.sin(a) * ry, r = rx * (0.26 + rnd() * 0.14);
    ctx.beginPath();
    ctx.ellipse(x, y, rx, ry, 0, 0, TAU);
    clipped(ctx, () => ell(ctx, bx, by, r + 1.8, r + 1.5, alpha(LILAC, 0.6)));
    ctx.save();
    ctx.globalCompositeOperation = 'destination-out';
    ell(ctx, bx, by, r, r * 0.92, '#000000');
    ctx.restore();
  }
}

function crack(ctx, pts, w = 1) {
  ctx.beginPath();
  pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
  ctx.strokeStyle = alpha(LILAC_DEEP, 0.8);
  ctx.lineWidth = w;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.stroke();
}

function coal(ctx, x, y, r, tilt = 0) {
  ctx.beginPath();
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * TAU + tilt;
    const q = r * (0.86 + ((i * 37) % 5) * 0.06);
    ctx[i ? 'lineTo' : 'moveTo'](x + Math.cos(a) * q, y + Math.sin(a) * q);
  }
  ctx.closePath();
  ctx.fillStyle = '#3a3350';
  ctx.fill();
  ell(ctx, x - r * 0.28, y - r * 0.32, r * 0.26, r * 0.2, 'rgba(255,255,255,0.5)');
}

export function paintColonelBody(ctx, tier, team) {
  const sash = TEAM_STYLE[team]?.color ?? TEAM_STYLE[0].color;
  snowBall(ctx, 0, BASE_Y, 31, 26.5, tier >= 4 ? 3 : tier >= 2 ? 1 : 0, 11);
  snowBall(ctx, 0, MID_Y, MID_R + 1, MID_R - 2, tier >= 3 ? 2 : 0, 22);
  // Dress sash, shoulder to hip. It carries the team colour, so a Colonel is obvious at any distance.
  ctx.beginPath();
  ctx.ellipse(0, MID_Y, MID_R + 1, MID_R - 2, 0, 0, TAU);
  clipped(ctx, () => {
    ctx.beginPath();
    ctx.moveTo(-26, MID_Y - 21);
    ctx.lineTo(-13, MID_Y - 24);
    ctx.lineTo(26, MID_Y + 14);
    ctx.lineTo(13, MID_Y + 20);
    ctx.closePath();
    ctx.fillStyle = linGrad(ctx, -20, MID_Y - 20, 20, MID_Y + 14, [tone(sash, 0.22), sash, tone(sash, -0.2)]);
    ctx.fill();
    line(ctx, -13, MID_Y - 24, 26, MID_Y + 14, alpha('#ffffff', 0.5), 0.9);
  });
  // Buttons and the medal are the first things to go.
  const buttons = [[3.5, MID_Y + 2, 2], [4, MID_Y + 12, 3], [4, BASE_Y - 8, 5], [4, BASE_Y + 4, 5]];
  for (const [x, y, gone] of buttons) if (tier < gone) coal(ctx, x, y, 2.8, x + y);
  if (tier < 4) {
    ell(ctx, -9.5, MID_Y + 5.4, 4.6, 4.6, GOLD_LO);
    star5(ctx, -9.5, MID_Y + 5.2, 4.3, GOLD);
  }
  snowBall(ctx, 0, HEAD_Y, HEAD_R + 1, HEAD_R, tier >= 5 ? 1 : 0, 33);
  if (tier >= 3) crack(ctx, [[-27, BASE_Y - 8], [-18, BASE_Y - 3], [-20, BASE_Y + 4], [-11, BASE_Y + 9]]);
  if (tier >= 4) crack(ctx, [[19, MID_Y - 8], [12, MID_Y - 3], [14, MID_Y + 3], [8, MID_Y + 8]]);
  if (tier >= 5) {
    crack(ctx, [[20, BASE_Y - 16], [12, BASE_Y - 10], [15, BASE_Y - 4], [8, BASE_Y + 1], [10, BASE_Y + 8]], 1.1);
    crack(ctx, [[-13, HEAD_Y - 6], [-9, HEAD_Y - 2], [-11, HEAD_Y + 3]]);
  }
  if (tier >= 6) {
    crack(ctx, [[-22, MID_Y + 2], [-14, MID_Y + 6], [-15, MID_Y + 12]], 1.2);
    // Chunks of himself at his feet.
    ell(ctx, -33, -5, 7, 5, SNOW_MID);
    ell(ctx, 30, -3, 6, 4.2, SNOW);
    ell(ctx, 36, -8, 3.4, 2.6, SNOW_LOW);
  }
  // The drift he stands in fills his 2x2 footprint, so he never looks smaller than his cells. It goes
  // on last and underneath, because the bites above must not punch through the ground he stands on.
  ctx.save();
  ctx.globalCompositeOperation = 'destination-over';
  ell(ctx, -12, -8, 20, 6, 'rgba(255,255,255,0.8)');
  ell(ctx, 0, -4, 46, 16, linGrad(ctx, -40, -18, 40, 10, [SNOW_HI, SNOW_MID, SNOW_LOW]));
  ctx.restore();
}

export function paintBucket(ctx, tier) {
  // The rim sits at the origin. Bucket helmet: it is a pail, and he wears it like a general.
  const dent = tier >= 3;
  const top = -25, hwTop = 16.4, hwBot = 20.6;
  ctx.beginPath();
  ctx.moveTo(-hwBot, 0);
  ctx.lineTo(-hwTop, top);
  ctx.quadraticCurveTo(0, top - 5, hwTop, top);
  ctx.lineTo(hwBot, 0);
  ctx.quadraticCurveTo(0, 7, -hwBot, 0);
  ctx.closePath();
  ctx.fillStyle = linGrad(ctx, -hwBot, 0, hwBot, 0, ['#c3cedd', METAL_HI, METAL, METAL_LO]);
  ctx.fill();
  clipped(ctx, () => {
    ell(ctx, -8.5, -11, 3, 15, alpha('#ffffff', 0.55), 0.1);
    if (dent) {
      ell(ctx, 10, -10, 7, 5.4, alpha(METAL_LO, 0.9), 0.5);
      ell(ctx, 10.8, -9, 5.2, 3.5, alpha(METAL_HI, 0.8), 0.5);
    }
  });
  ell(ctx, 0, top, hwTop, 3.6, linGrad(ctx, -hwTop, 0, hwTop, 0, [METAL_LO, METAL, METAL_HI]));
  ell(ctx, 0, top + 0.4, hwTop - 2.2, 2.4, tone(METAL_LO, -0.28));
  ctx.beginPath();
  ctx.moveTo(-hwBot - 1, 0);
  ctx.quadraticCurveTo(0, 7, hwBot + 1, 0);
  ctx.strokeStyle = METAL_LO;
  ctx.lineWidth = 2.2;
  ctx.lineCap = 'round';
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(-hwBot - 1, -1);
  ctx.quadraticCurveTo(0, 6, hwBot + 1, -1);
  ctx.strokeStyle = METAL_HI;
  ctx.lineWidth = 0.9;
  ctx.stroke();
  // Handle hanging down the side, loose, like a chinstrap he refuses to fasten.
  ctx.beginPath();
  ctx.moveTo(-hwTop - 1, top + 4);
  ctx.quadraticCurveTo(-hwBot - 6, -6, -hwBot - 3, 2);
  ctx.strokeStyle = METAL_LO;
  ctx.lineWidth = 1.4;
  ctx.stroke();
  // Rank stars. He has four and he will tell you how he earned them.
  const stars = [[-8.5, -8, 4.8, 3], [0, -14, 5.4, 6], [8.5, -8, 4.8, 1], [0, -3.6, 3.8, 5]];
  for (const [x, y, r, gone] of stars) {
    if (tier >= gone) continue;
    star5(ctx, x + 0.4, y + 0.6, r, alpha(GOLD_LO, 0.9));
    star5(ctx, x, y, r, GOLD);
  }
}

function twig(ctx, x0, y0, x1, y1, a) {
  line(ctx, x0, y0, x1, y1, a, 1.5);
}

export function paintArm(ctx, sx, sy, ex, ey, hx, hy, broken) {
  line(ctx, sx, sy, ex, ey, WOOD_LO, 3.5);
  line(ctx, sx, sy - 0.5, ex, ey - 0.5, WOOD, 2.3);
  if (broken) {
    // A snapped end: pale splinters where the rest of the arm used to be.
    const a = Math.atan2(ey - sy, ex - sx);
    for (let k = -1; k <= 1; k++) line(ctx, ex, ey, ex + Math.cos(a + k * 0.55) * 4.2, ey + Math.sin(a + k * 0.55) * 4.2, WOOD_HI, 1.1);
    return;
  }
  line(ctx, ex, ey, hx, hy, WOOD_LO, 3);
  line(ctx, ex, ey - 0.4, hx, hy - 0.4, WOOD, 1.9);
  const a = Math.atan2(hy - ey, hx - ex);
  for (let k = -1; k <= 1; k++) twig(ctx, hx, hy, hx + Math.cos(a + k * 0.64) * 7, hy + Math.sin(a + k * 0.64) * 7, WOOD_LO);
}

export function paintFaceLive(ctx, x, y, lookX, lookY, opts) {
  const { squint, shock, noNose, worry, aimNose } = opts;
  const fx = x + lookX * 5.4, fy = y + 2.2 + lookY * 2.2;
  const ex = 6.4;
  for (const d of [-1, 1]) {
    const px = fx + d * ex, py = fy - 3.4;
    if (squint) {
      ctx.beginPath();
      ctx.moveTo(px - d * 3, py - 2.4);
      ctx.lineTo(px + d * 2.4, py);
      ctx.lineTo(px - d * 3, py + 2.4);
      ctx.strokeStyle = '#3a3350';
      ctx.lineWidth = 1.7;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.stroke();
    } else {
      coal(ctx, px, py, shock ? 4 : 3.3, d);
      if (!shock) {
        // Heavy coal brows: stern at full health, worried by the time his bits fall off.
        const tilt = worry ? -0.3 : 0.26;
        const bx = px + d * 0.4, by = py - 4.4;
        line(ctx, bx - 3, by + d * -tilt * 3, bx + 3, by + d * tilt * 3, '#3a3350', 1.4);
      }
    }
  }
  const my = fy + 7.6;
  if (shock) {
    ell(ctx, fx, my + 1, 3.4, 4, '#3a3350');
  } else {
    const k = worry ? -1.8 : squint ? -2.4 : 0.9;
    for (let i = -2; i <= 2; i++) {
      const px = fx + i * 3;
      ell(ctx, px, my + (1 - (i * i) / 4) * k, 1.15, 1.15, '#3a3350');
    }
  }
  if (noNose) {
    // A hollow where the carrot belongs, and the expression above it.
    ell(ctx, fx, fy + 1.4, 3.4, 2.7, alpha(LILAC_DEEP, 0.75));
    ell(ctx, fx + 0.4, fy + 2, 2.4, 1.7, alpha(SNOW_LOW, 0.9));
    return;
  }
  const nx = lookX * 17, ny = 3 + lookY * 6;
  const len = Math.max(8, Math.hypot(nx, ny));
  ctx.save();
  ctx.translate(fx, fy + 1);
  ctx.rotate(aimNose ?? Math.atan2(ny, nx));
  paintCarrot(ctx, len + 3, 3.6, false);
  ctx.restore();
}

export function paintFallingBit(ctx, x, y, kind, rot) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rot);
  switch (kind) {
    case 'star': star5(ctx, 0, 0, 4.6, GOLD); break;
    case 'coal': ell(ctx, 0, 0, 2.8, 2.5, '#3a3350'); break;
    case 'stick': capsule(ctx, -5, 0, 1.2, 5, 0, 1, WOOD); break;
    default: ell(ctx, 0, 0, 4.2, 3.4, SNOW_MID);
  }
  ctx.restore();
}

export const TIER_LOSS = ['star', 'coal', 'stick', 'star', 'coal', 'chunk', 'chunk'];

