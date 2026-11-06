// Fort Flurry — every icon in the game, painted in a 64 x 64 design space.
// Icons are read at 24 to 48 CSS px on HUD glass over a moving scene, so each is one bold object with a
// generous silhouette and its own light edge. Detail that only survives at 64 px is decoration, never
// the thing that identifies the icon.

import { ACTOR, STRUCT, PICKUP } from '../../shared/schema.js';
import { LOOK } from '../../shared/constants.js';
import { CARD_BY_ID, defaultMods } from '../../shared/cards.js';
import {
  TAU, INK, SNOW_HI, SNOW_MID, SNOW_LOW, LILAC, LILAC_DEEP, ICE, ICE_HI, ICE_DEEP, WOOD, WOOD_HI, WOOD_LO, COCOA, CREAM, GOLD,
  METAL, METAL_HI, METAL_LO,
  ell, line, curve, poly, capsule, linGrad, litFill, roundRect, tone, alpha, clipped, star5, seeded, hashString, snowball, smoothPath,
} from './sprite-paint.js';
import { paintKid } from './sprite-chibi.js';
import { paintFoe } from './sprite-foes.js';
import { paintTruck, paintCone, coneSeat } from './sprite-truck.js';
import { paintSteveBody, paintSteveArm } from './sprite-steve.js';
import { paintColonelBody, paintBucket, paintFaceLive, HEAD_Y } from './sprite-colonel.js';

const RED = '#d9534f';
const BLUE = '#3f8fc4';

function paintFlake(ctx, cx = 32, cy = 32, r = 27) {
  // Blue under-stroke first: a white flake must stay readable on snow as well as on dark glass.
  const arm = (color, w) => {
    ctx.lineCap = 'round';
    ctx.strokeStyle = color;
    ctx.lineWidth = w;
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * TAU - Math.PI / 2;
      const c = Math.cos(a), s = Math.sin(a);
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + c * r, cy + s * r);
      for (const k of [0.46, 0.72]) {
        const bx = cx + c * r * k, by = cy + s * r * k, l = r * (k === 0.46 ? 0.32 : 0.24);
        for (const d of [-1, 1]) {
          ctx.moveTo(bx, by);
          ctx.lineTo(bx + Math.cos(a + d * 1.05) * l, by + Math.sin(a + d * 1.05) * l);
        }
      }
      ctx.stroke();
    }
  };
  arm('#4f9bd6', r * 0.26);
  arm('#ffffff', r * 0.13);
  ell(ctx, cx, cy, r * 0.17, r * 0.17, '#ffffff');
}

function paintSnowballIcon(ctx, cx = 32, cy = 32, r = 24) {
  ell(ctx, cx + 1.4, cy + 3.4, r, r, alpha(LILAC_DEEP, 0.8));
  snowball(ctx, cx, cy, r, { shade: LILAC });
  const rnd = seeded(8);
  for (let i = 0; i < 6; i++) {
    const a = rnd() * TAU, q = rnd() * r * 0.74;
    ell(ctx, cx + Math.cos(a) * q, cy + Math.sin(a) * q, 1.8 + rnd() * 1.6, 1.4 + rnd(), alpha(SNOW_LOW, 0.6));
  }
}

function block(ctx, x, y, w, h, d, top, front, side) {
  poly(ctx, [[x, y], [x + w, y], [x + w + d, y - d * 0.62], [x + d, y - d * 0.62]], top);
  poly(ctx, [[x + w, y], [x + w + d, y - d * 0.62], [x + w + d, y + h - d * 0.62], [x + w, y + h]], side);
  ctx.beginPath();
  roundRect(ctx, x, y, w, h, 3);
  ctx.fillStyle = front;
  ctx.fill();
}

function paintWallIcon(ctx) {
  block(ctx, 7, 22, 40, 32, 10, SNOW_HI, linGrad(ctx, 7, 22, 47, 54, [SNOW_HI, SNOW_MID, SNOW_LOW]), LILAC);
  ctx.strokeStyle = alpha(LILAC_DEEP, 0.62);
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(8, 38); ctx.lineTo(46, 38);
  ctx.moveTo(27, 23); ctx.lineTo(27, 37);
  ctx.moveTo(17, 39); ctx.lineTo(17, 53);
  ctx.moveTo(37, 39); ctx.lineTo(37, 53);
  ctx.stroke();
}

function paintIceWallIcon(ctx) {
  block(ctx, 7, 20, 40, 34, 10, ICE_HI, linGrad(ctx, 7, 20, 47, 54, [ICE_HI, ICE, ICE_DEEP]), ICE_DEEP);
  poly(ctx, [[13, 25], [21, 25], [14, 47], [13, 44]], 'rgba(255,255,255,0.85)');
  poly(ctx, [[24, 25], [27, 25], [20, 47], [18, 47]], 'rgba(255,255,255,0.55)');
  ctx.strokeStyle = 'rgba(255,255,255,0.9)';
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.moveTo(47, 34); ctx.lineTo(38, 40); ctx.lineTo(41, 47); ctx.lineTo(33, 53);
  ctx.stroke();
}

function paintCoatIcon(ctx) {
  const coat = RED;
  // Shovel: the post the whole decoy hangs from.
  line(ctx, 32, 12, 32, 54, WOOD_LO, 4.4);
  line(ctx, 31.3, 12, 31.3, 54, WOOD, 2.6);
  poly(ctx, [[23, 52], [41, 52], [39, 62], [25, 62]], METAL);
  poly(ctx, [[23, 52], [32, 52], [31, 62], [25, 62]], METAL_HI);
  // Stuffed coat: three rolls of quilting, arms sticking out because the sleeves are full of snow.
  capsule(ctx, 19, 27, 5.4, 7, 38, 4.4, litFill(ctx, 13, 32, 8, 8, coat, 0.16, 0.24));
  capsule(ctx, 45, 27, 5.4, 57, 38, 4.4, litFill(ctx, 51, 32, 8, 8, coat, 0.1, 0.28));
  ell(ctx, 6, 39.5, 4, 3.6, GOLD);
  ell(ctx, 58, 39.5, 4, 3.6, GOLD);
  ell(ctx, 32, 44, 17, 7.5, litFill(ctx, 32, 44, 17, 8, coat, 0.14, 0.26));
  ell(ctx, 32, 36, 17.5, 7.8, litFill(ctx, 32, 36, 17, 8, coat, 0.16, 0.24));
  ell(ctx, 32, 28, 15.5, 7.4, litFill(ctx, 32, 28, 15, 7, coat, 0.2, 0.2));
  line(ctx, 32, 24, 32, 50, alpha('#fff4ea', 0.55), 1.4);
  // Bobble hat on top, the giveaway that nobody is home.
  ctx.beginPath();
  ctx.moveTo(19, 22);
  ctx.bezierCurveTo(19, 4, 45, 4, 45, 22);
  ctx.quadraticCurveTo(32, 26, 19, 22);
  ctx.closePath();
  ctx.fillStyle = litFill(ctx, 32, 14, 13, 10, BLUE, 0.2, 0.24);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(17.5, 23);
  ctx.quadraticCurveTo(32, 28, 46.5, 23);
  ctx.lineTo(46, 17.5);
  ctx.quadraticCurveTo(32, 22, 18, 17.5);
  ctx.closePath();
  ctx.fillStyle = tone(BLUE, 0.6);
  ctx.fill();
  ell(ctx, 32, 6, 5.6, 5.6, litFill(ctx, 32, 6, 5.6, 5.6, GOLD, 0.2, 0.2));
}

function paintFlingerIcon(ctx) {
  // Base.
  poly(ctx, [[8, 50], [56, 50], [50, 60], [14, 60]], WOOD_LO);
  roundRect(ctx, 7, 44, 50, 9, 3);
  ctx.fillStyle = linGrad(ctx, 7, 44, 57, 53, [WOOD_HI, WOOD, WOOD_LO]);
  ctx.fill();
  poly(ctx, [[22, 45], [28, 28], [33, 28], [37, 45]], WOOD);
  ell(ctx, 30.5, 28, 5, 5, WOOD_LO);
  // Spoon: handle sweeps up to a bowl that holds the ball.
  capsule(ctx, 49, 37, 2.4, 22, 22, 3, linGrad(ctx, 22, 22, 49, 37, [WOOD_HI, WOOD]));
  ell(ctx, 15, 17, 10.6, 8.2, linGrad(ctx, 5, 9, 25, 25, [WOOD_HI, WOOD, WOOD_LO]), 0.5);
  ell(ctx, 14.6, 15.5, 7.2, 5, WOOD_LO, 0.5);
  snowball(ctx, 14.4, 12, 8.2, { shade: LILAC });
  ell(ctx, 30.5, 28, 2.1, 2.1, METAL_HI);
}

function paintSlickIcon(ctx) {
  smoothPath(ctx, [[8, 34], [15, 21], [31, 18], [47, 20], [58, 31], [52, 44], [37, 49], [20, 47]], true, 0.6);
  ctx.fillStyle = linGrad(ctx, 8, 18, 58, 50, [ICE_HI, '#bfeefa', ICE_DEEP]);
  ctx.fill();
  clipped(ctx, () => {
    ell(ctx, 40, 44, 26, 13, alpha(ICE_DEEP, 0.5));
    ell(ctx, 23, 28, 13, 4.6, 'rgba(255,255,255,0.92)', -0.16);
    ell(ctx, 42, 33, 6, 2.2, 'rgba(255,255,255,0.75)', -0.16);
  });
  // A skid line across it says "slippery" in one stroke.
  curve(ctx, 6, 54, 30, 53, 58, 57, alpha(LILAC_DEEP, 0.75), 2.2);
  curve(ctx, 16, 60, 34, 59, 50, 61, alpha(LILAC_DEEP, 0.45), 1.8);
}

export function paintCocoaMug(ctx, cx, cy, s = 1) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(s, s);
  ctx.beginPath();
  ctx.arc(17, 1, 8.6, -1.4, 1.4);
  ctx.strokeStyle = tone(RED, 0.2);
  ctx.lineWidth = 4.2;
  ctx.lineCap = 'round';
  ctx.stroke();
  roundRect(ctx, -17, -13, 34, 31, 7);
  ctx.fillStyle = linGrad(ctx, -17, 0, 17, 0, [tone(RED, 0.3), RED, tone(RED, -0.28)]);
  ctx.fill();
  ell(ctx, 0, -13, 17, 6, tone(RED, 0.45));
  ell(ctx, 0, -12.6, 14.4, 4.4, COCOA);
  ell(ctx, -4.5, -13.4, 5, 2.7, '#fff6ea');
  ell(ctx, 5, -12, 4.2, 2.4, '#fff1e0');
  ctx.fillStyle = '#ffffff';
  roundRect(ctx, -17, 2, 34, 4.2, 0);
  ctx.fill();
  ctx.restore();
}

function steam(ctx, x, y, w = 2.6) {
  ctx.lineCap = 'round';
  ctx.strokeStyle = 'rgba(255,255,255,0.95)';
  ctx.lineWidth = w;
  for (const [dx, h] of [[-8, 14], [0, 18], [8, 13]]) {
    ctx.beginPath();
    ctx.moveTo(x + dx, y);
    ctx.bezierCurveTo(x + dx - 4.5, y - h * 0.3, x + dx + 4.5, y - h * 0.66, x + dx, y - h);
    ctx.stroke();
  }
}

function paintCocoaStandIcon(ctx) {
  // Posts, roof, counter, steam: a booth at thumb size.
  line(ctx, 13, 22, 13, 46, WOOD_LO, 4.2);
  line(ctx, 51, 22, 51, 46, WOOD_LO, 4.2);
  roundRect(ctx, 8, 44, 48, 16, 3);
  ctx.fillStyle = linGrad(ctx, 8, 44, 56, 60, [WOOD_HI, WOOD, WOOD_LO]);
  ctx.fill();
  ctx.strokeStyle = alpha(WOOD_LO, 0.75);
  ctx.lineWidth = 1.4;
  for (const y of [49, 54]) { ctx.beginPath(); ctx.moveTo(9, y); ctx.lineTo(55, y); ctx.stroke(); }
  roundRect(ctx, 5, 40, 54, 6, 2.4);
  ctx.fillStyle = WOOD_HI;
  ctx.fill();
  // Striped awning.
  const stripes = 6;
  for (let i = 0; i < stripes; i++) {
    const x0 = 5 + (i / stripes) * 54, x1 = 5 + ((i + 1) / stripes) * 54;
    const u0 = 12 + (i / stripes) * 40, u1 = 12 + ((i + 1) / stripes) * 40;
    const col = i % 2 ? CREAM : RED;
    poly(ctx, [[u0, 10], [u1, 10], [x1, 23], [x0, 23]], col);
    ctx.beginPath();
    ctx.arc((x0 + x1) / 2, 23, (x1 - x0) / 2, 0, Math.PI);
    ctx.closePath();
    ctx.fillStyle = tone(col, -0.12);
    ctx.fill();
  }
  paintCocoaMug(ctx, 30, 34, 0.5);
  steam(ctx, 30, 26, 1.5);
}

function paintColonelIcon(ctx) {
  // Head and helmet only: the bucket and nose are the Colonel, and they have to fit in 24 px.
  ctx.save();
  ctx.translate(32, 41 - HEAD_Y * 1.34);
  ctx.scale(1.34, 1.34);
  paintColonelBody(ctx, 0, 0);
  paintFaceLive(ctx, 0, HEAD_Y, 0.42, 0.34, {});
  ctx.translate(0, HEAD_Y - 10);
  paintBucket(ctx, 0);
  ctx.restore();
}

function paintDemolishIcon(ctx) {
  block(ctx, 7, 32, 34, 24, 8, SNOW_HI, linGrad(ctx, 7, 32, 41, 56, [SNOW_HI, SNOW_MID, SNOW_LOW]), LILAC);
  ctx.strokeStyle = LILAC_DEEP;
  ctx.lineWidth = 2.4;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(26, 32); ctx.lineTo(21, 40); ctx.lineTo(27, 45); ctx.lineTo(22, 55);
  ctx.stroke();
  for (const [x, y, r] of [[47, 50, 3.2], [53, 42, 2.4], [12, 25, 2.6]]) ell(ctx, x, y, r, r * 0.8, SNOW_MID);
  // The mallet.
  ctx.save();
  ctx.translate(38, 22);
  ctx.rotate(-0.72);
  capsule(ctx, 0, 0, 2.6, 25, 0, 2.6, linGrad(ctx, 0, -3, 0, 3, [WOOD_HI, WOOD]));
  roundRect(ctx, -9, -11, 18, 22, 4);
  ctx.fillStyle = linGrad(ctx, -9, -11, 9, 11, [tone(RED, 0.25), RED, tone(RED, -0.25)]);
  ctx.fill();
  roundRect(ctx, -10.5, -11, 4, 22, 2);
  ctx.fillStyle = METAL_HI;
  ctx.fill();
  roundRect(ctx, 6.5, -11, 4, 22, 2);
  ctx.fillStyle = METAL;
  ctx.fill();
  ctx.restore();
}

function paintIceIcon(ctx) {
  const c = [32, 32];
  const ring = [];
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * TAU - 0.3;
    ring.push([c[0] + Math.cos(a) * 25, c[1] + Math.sin(a) * 25]);
  }
  poly(ctx, ring, ICE_DEEP);
  const inner = ring.map(([x, y]) => [c[0] + (x - c[0]) * 0.5 - 3, c[1] + (y - c[1]) * 0.5 - 3]);
  const shades = [ICE, ICE_HI, '#d3f4fb', ICE_HI, ICE, '#7fd0ea', ICE_DEEP, '#7fd0ea'];
  for (let i = 0; i < 8; i++) {
    const j = (i + 1) % 8;
    poly(ctx, [ring[i], ring[j], inner[j], inner[i]], shades[(i + 5) % 8]);
  }
  poly(ctx, inner, '#f4feff');
  ctx.lineWidth = 0.8;
  ctx.strokeStyle = 'rgba(255,255,255,0.8)';
  for (let i = 0; i < 8; i++) {
    ctx.beginPath();
    ctx.moveTo(ring[i][0], ring[i][1]);
    ctx.lineTo(inner[i][0], inner[i][1]);
    ctx.stroke();
  }
  sparkle(ctx, 50, 14, 8);
  sparkle(ctx, 12, 50, 5);
}

function sparkle(ctx, x, y, r, color = '#ffffff') {
  ctx.beginPath();
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * TAU;
    const q = i % 2 ? r * 0.26 : r;
    ctx[i ? 'lineTo' : 'moveTo'](x + Math.cos(a) * q, y + Math.sin(a) * q);
  }
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
}

function paintSlushIcon(ctx) {
  const slush = '#8fb6d6';
  ell(ctx, 32, 30, 22, 22, linGrad(ctx, 12, 8, 50, 52, ['#e4f0f8', slush, '#5f8db5']));
  const rnd = seeded(14);
  for (let i = 0; i < 11; i++) {
    const a = rnd() * TAU, q = rnd() * 17;
    ell(ctx, 32 + Math.cos(a) * q, 30 + Math.sin(a) * q, 1.8 + rnd() * 2.2, 1.5 + rnd() * 1.6, alpha(i % 2 ? '#ffffff' : '#587fa6', 0.65));
  }
  // Drips: the difference between this and a plain blue snowball.
  for (const [x, l, r] of [[17, 12, 3.2], [28, 20, 3.8], [39, 15, 3.2], [47, 8, 2.6]]) {
    capsule(ctx, x, 42, r, x, 42 + l, r * 0.84, '#7ba5c9');
    ell(ctx, x - 0.9, 42 + l, r * 0.34, r * 0.5, 'rgba(255,255,255,0.75)');
  }
}

function paintTripleIcon(ctx) {
  // A fan of three, each with a short tail: the throw pattern, not just three balls.
  for (const [ang, d, r] of [[-0.52, 38, 9.4], [0, 45, 10.2], [0.52, 38, 9.4]]) {
    const a = ang - 0.78;
    const x = 12 + Math.cos(a) * d, y = 52 + Math.sin(a) * d;
    capsule(ctx, 12 + Math.cos(a) * 12, 52 + Math.sin(a) * 12, 0.7, x, y, r * 0.54, alpha('#4f9bd6', 0.75));
    ell(ctx, x + 0.8, y + 1.8, r, r, alpha(LILAC_DEEP, 0.85));
    snowball(ctx, x, y, r, { shade: LILAC });
  }
}

function paintGiantIcon(ctx) {
  ctx.lineCap = 'round';
  for (const [y, x0, x1] of [[18, 3, 14], [34, 1, 9], [50, 2, 13]]) line(ctx, x0, y, x1, y, alpha(ICE_DEEP, 0.75), 3.4);
  ell(ctx, 38, 34, 24, 24, alpha(LILAC_DEEP, 0.55));
  snowball(ctx, 37, 31, 24, { shade: LILAC });
  // Spiral of rolled-up snow, so it looks like it has been growing.
  ctx.beginPath();
  for (let i = 0; i <= 40; i++) {
    const a = i * 0.34, q = 2 + i * 0.47;
    ctx[i ? 'lineTo' : 'moveTo'](38 + Math.cos(a) * q, 33 + Math.sin(a) * q);
  }
  ctx.strokeStyle = alpha(LILAC, 0.75);
  ctx.lineWidth = 2;
  ctx.stroke();
}

function paintBoardIcon(ctx) {
  ctx.save();
  ctx.translate(32, 32);
  ctx.rotate(-0.72);
  roundRect(ctx, -30, -8, 60, 16, 8);
  ctx.fillStyle = tone('#2d7fd3', -0.4);
  ctx.save();
  ctx.translate(1.8, 2.2);
  ctx.fill();
  ctx.restore();
  roundRect(ctx, -30, -8, 60, 16, 8);
  ctx.fillStyle = linGrad(ctx, 0, -8, 0, 8, [tone('#2d7fd3', 0.3), '#2d7fd3', tone('#2d7fd3', -0.16)]);
  ctx.fill();
  clipped(ctx, () => {
    poly(ctx, [[-12, -9], [-3, -9], [-11, 9], [-20, 9]], '#ffffff');
    poly(ctx, [[3, -9], [12, -9], [4, 9], [-5, 9]], GOLD);
  });
  for (const x of [-19, 19]) {
    roundRect(ctx, x - 3.6, -10, 7.2, 20, 2.6);
    ctx.fillStyle = INK;
    ctx.fill();
  }
  ctx.restore();
}

// ---- cards -----------------------------------------------------------------------------------------

function paintEarmuffs(ctx) {
  ctx.beginPath();
  ctx.arc(32, 36, 22, Math.PI, 0);
  ctx.strokeStyle = tone('#3f8fc4', -0.2);
  ctx.lineWidth = 6;
  ctx.lineCap = 'round';
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(32, 35, 22, Math.PI * 1.08, Math.PI * 1.5);
  ctx.strokeStyle = '#8fc7ea';
  ctx.lineWidth = 2;
  ctx.stroke();
  for (const x of [10, 54]) {
    const rnd = seeded(x);
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * TAU;
      ell(ctx, x + Math.cos(a) * 10, 41 + Math.sin(a) * 12, 3.8, 3.8, i < 6 ? tone('#ef6fa0', -0.14) : '#ef6fa0', rnd());
    }
    ell(ctx, x, 41, 10.5, 12.5, litFill(ctx, x, 41, 11, 13, '#ef6fa0', 0.3, 0.2));
    ell(ctx, x - 3, 37, 3.4, 2.4, 'rgba(255,255,255,0.55)', -0.4);
  }
}

function paintBootIcon(ctx, speed = true) {
  const boot = '#a9704a';
  if (speed) for (const [y, x0, x1] of [[20, 2, 12], [30, 1, 9], [40, 3, 11]]) line(ctx, x0, y, x1, y, alpha(ICE_DEEP, 0.75), 3.2);
  ctx.beginPath();
  ctx.moveTo(19, 9);
  ctx.lineTo(42, 9);
  ctx.quadraticCurveTo(44, 26, 44, 33);
  ctx.quadraticCurveTo(61, 37, 60, 48);
  ctx.lineTo(60, 53);
  ctx.lineTo(18, 53);
  ctx.quadraticCurveTo(21, 31, 19, 9);
  ctx.closePath();
  ctx.fillStyle = linGrad(ctx, 18, 9, 60, 53, [tone(boot, 0.26), boot, tone(boot, -0.3)]);
  ctx.fill();
  roundRect(ctx, 15, 4, 31, 10, 4.6);
  ctx.fillStyle = CREAM;
  ctx.fill();
  roundRect(ctx, 15, 51, 48, 8, 3.4);
  ctx.fillStyle = linGrad(ctx, 15, 51, 63, 59, ['#6d5a80', '#463a62']);
  ctx.fill();
  ctx.strokeStyle = '#fff1dd';
  ctx.lineWidth = 2.2;
  ctx.lineCap = 'round';
  for (const y of [21, 28, 35]) {
    ctx.beginPath();
    ctx.moveTo(33, y);
    ctx.lineTo(43, y + 3);
    ctx.stroke();
  }
}

function paintTongsIcon(ctx) {
  // Scissor-sprung tongs with red grips: a grey tool on a white ball vanishes, a red one doesn't.
  ell(ctx, 23, 42, 17, 17, alpha(LILAC_DEEP, 0.55));
  snowball(ctx, 22, 40, 17, { shade: LILAC });
  const arm = (x0, y0, cx, cy, x1, y1, col) => {
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.quadraticCurveTo(cx, cy, x1, y1);
    ctx.strokeStyle = col;
    ctx.lineWidth = 5;
    ctx.lineCap = 'round';
    ctx.stroke();
  };
  arm(44, 28, 41, 42, 25, 57, METAL_LO);
  arm(44, 28, 28, 25, 7, 26, METAL);
  arm(44, 28, 52, 21, 61, 8, '#d9534f');
  arm(44, 28, 41, 16, 44, 4, '#f07a6e');
  ell(ctx, 44, 28, 3.6, 3.6, METAL_HI);
  ell(ctx, 44, 28, 1.5, 1.5, METAL_LO);
}

function paintMitten(ctx, cx, cy, s, color, thumbSide = 1) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(s * thumbSide, s);
  ctx.beginPath();
  ctx.moveTo(-15, 22);
  ctx.bezierCurveTo(-21, -2, -18, -26, 1, -26);
  ctx.bezierCurveTo(18, -26, 20, -6, 16, 22);
  ctx.closePath();
  ctx.fillStyle = litFill(ctx, 0, 0, 20, 26, color, 0.26, 0.26);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(15, 6);
  ctx.bezierCurveTo(25, 1, 32, -8, 26, -13);
  ctx.bezierCurveTo(21, -17, 15, -8, 13, -3);
  ctx.closePath();
  ctx.fillStyle = litFill(ctx, 22, -4, 9, 10, color, 0.16, 0.3);
  ctx.fill();
  roundRect(ctx, -18, 15, 38, 12, 5);
  ctx.fillStyle = tone(color, 0.62);
  ctx.fill();
  ctx.strokeStyle = alpha(tone(color, -0.2), 0.6);
  ctx.lineWidth = 1.5;
  for (let x = -12; x <= 14; x += 6.5) {
    ctx.beginPath();
    ctx.moveTo(x, 17);
    ctx.lineTo(x, 25);
    ctx.stroke();
  }
  ctx.restore();
}

function paintBigMittensIcon(ctx) {
  paintMitten(ctx, 30, 36, 1.08, '#d9534f');
  snowball(ctx, 49, 15, 8.4, { shade: LILAC });
  snowball(ctx, 37, 8, 6.2, { shade: LILAC });
  snowball(ctx, 58, 30, 5, { shade: LILAC });
}

function paintIceCoreIcon(ctx) {
  snowball(ctx, 32, 32, 26, { shade: LILAC });
  // The ball cut away to the heart: a wedge of snow gone, and a cyan crystal inside.
  ctx.beginPath();
  ctx.moveTo(32, 32);
  ctx.arc(32, 32, 26.5, -1.05, 0.42);
  ctx.closePath();
  ctx.fillStyle = alpha(LILAC_DEEP, 0.9);
  ctx.fill();
  poly(ctx, [[32, 13], [44, 25], [40, 44], [24, 44], [20, 25]], ICE_DEEP);
  poly(ctx, [[32, 13], [44, 25], [32, 30]], ICE_HI);
  poly(ctx, [[32, 13], [20, 25], [32, 30]], ICE);
  poly(ctx, [[20, 25], [32, 30], [24, 44]], '#7fd0ea');
  poly(ctx, [[44, 25], [32, 30], [40, 44]], ICE);
  sparkle(ctx, 45, 15, 6.6);
}

function paintFastballIcon(ctx) {
  ctx.lineCap = 'round';
  for (const [y, x0, w] of [[17, 2, 2.8], [27, 0, 3.4], [37, 2, 3.4], [47, 5, 2.8]]) line(ctx, x0, y, x0 + 21, y, alpha('#4f9bd6', 0.8), w);
  poly(ctx, [[20, 15], [44, 8], [44, 56], [20, 49]], alpha('#bfe6fa', 0.6));
  ell(ctx, 43, 34, 19, 19, alpha(LILAC_DEEP, 0.55));
  snowball(ctx, 42, 32, 19, { shade: LILAC });
}

function paintSplat(ctx, cx, cy, r, color) {
  const rnd = seeded(23);
  const pts = [];
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * TAU;
    const q = r * (i % 2 ? 0.58 + rnd() * 0.12 : 0.9 + rnd() * 0.3);
    pts.push([cx + Math.cos(a) * q, cy + Math.sin(a) * q * 0.86]);
  }
  smoothPath(ctx, pts, true, 0.75);
  ctx.fillStyle = color;
  ctx.fill();
}

function paintBigSplatIcon(ctx) {
  ctx.save();
  ctx.translate(1, 2.4);
  paintSplat(ctx, 32, 33, 25, alpha(LILAC_DEEP, 0.6));
  ctx.restore();
  paintSplat(ctx, 32, 33, 25, SNOW_HI);
  ell(ctx, 32, 34, 13, 11, linGrad(ctx, 18, 22, 44, 46, [SNOW_HI, SNOW_MID, LILAC]));
  for (const [x, y, r] of [[7, 13, 3.4], [56, 15, 2.8], [59, 49, 3.4], [6, 52, 2.6], [32, 4, 2.4]]) ell(ctx, x, y, r, r, SNOW_HI);
}

function paintDryerIcon(ctx) {
  const body = '#ef6fa0';
  // Warm air, then what it is doing to the ice.
  for (const [y, c] of [[11, -5], [22, 5], [33, -5]]) {
    ctx.beginPath();
    ctx.moveTo(32, y);
    ctx.bezierCurveTo(38, y + c, 44, y - c, 49, y);
    ctx.strokeStyle = '#f2a033';
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.stroke();
  }
  roundRect(ctx, 48, 15, 13, 13, 3);
  ctx.fillStyle = linGrad(ctx, 48, 15, 61, 28, [ICE_HI, ICE, ICE_DEEP]);
  ctx.fill();
  capsule(ctx, 52, 28, 1.6, 52, 37, 2, ICE_DEEP);
  capsule(ctx, 57, 28, 1.3, 57, 33, 1.5, ICE_DEEP);
  ctx.beginPath();
  ctx.moveTo(5, 13);
  ctx.quadraticCurveTo(5, 5, 14, 5);
  ctx.lineTo(29, 7);
  ctx.lineTo(29, 28);
  ctx.lineTo(14, 30);
  ctx.quadraticCurveTo(5, 30, 5, 22);
  ctx.closePath();
  ctx.fillStyle = litFill(ctx, 16, 17, 14, 14, body, 0.3, 0.24);
  ctx.fill();
  ell(ctx, 29, 17.5, 3.6, 10.6, tone(body, -0.32));
  ell(ctx, 29, 17.5, 2, 8, '#ffcf8a');
  roundRect(ctx, 10, 28, 12, 27, 4);
  ctx.fillStyle = litFill(ctx, 16, 42, 7, 14, body, 0.2, 0.3);
  ctx.fill();
  ell(ctx, 16, 36, 2.6, 2.6, '#ffffff');
}

function paintBellyIcon(ctx) {
  // A kid mid belly slide, with the shine on the ground doing the talking.
  ell(ctx, 32, 53, 29, 7, alpha(ICE_DEEP, 0.55));
  ell(ctx, 25, 51, 13, 2.6, 'rgba(255,255,255,0.9)');
  ctx.save();
  ctx.translate(32, 46);
  ctx.scale(1.28, 1.28);
  paintKid(ctx, { hat: 0, coat: 2, scarf: 0, skin: 1 }, null, 'slide', 0, 0);
  ctx.restore();
  for (const [y, x] of [[17, 3], [27, 1]]) line(ctx, x, y, x + 11, y, alpha(ICE_DEEP, 0.75), 3);
}

function paintLongArmsIcon(ctx) {
  // A sleeve that goes on far too long, ending in a mitten reaching for a far-off wall block.
  capsule(ctx, 6, 52, 7, 40, 21, 6, linGrad(ctx, 6, 52, 44, 18, [tone('#5fae6b', 0.2), '#5fae6b', tone('#5fae6b', -0.22)]));
  ctx.strokeStyle = alpha(tone('#5fae6b', -0.46), 0.5);
  ctx.lineWidth = 1.8;
  for (const k of [0.2, 0.4, 0.6, 0.8]) {
    const x = 6 + 34 * k, y = 52 - 31 * k;
    ctx.beginPath();
    ctx.moveTo(x - 5, y - 5);
    ctx.lineTo(x + 5, y + 5);
    ctx.stroke();
  }
  ctx.save();
  ctx.translate(46, 15);
  ctx.rotate(0.82);
  ctx.scale(0.46, 0.46);
  paintMitten(ctx, 0, 0, 1, GOLD);
  ctx.restore();
  ctx.lineCap = 'round';
  line(ctx, 16, 12, 34, 7, alpha('#4f9bd6', 0.8), 2.8);
  poly(ctx, [[37, 6], [30, 2.5], [31, 11]], alpha('#4f9bd6', 0.9));
  line(ctx, 54, 34, 58, 52, alpha('#4f9bd6', 0.8), 2.8);
  poly(ctx, [[59, 55], [54, 49], [62, 48]], alpha('#4f9bd6', 0.9));
}

function paintSweater(ctx, cx, cy, s, color) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(s, s);
  ctx.beginPath();
  ctx.moveTo(-9, -21);
  ctx.quadraticCurveTo(0, -15, 9, -21);
  ctx.lineTo(16, -19);
  ctx.lineTo(29, -3);
  ctx.lineTo(21, 4);
  ctx.lineTo(15, -3);
  ctx.lineTo(15, 21);
  ctx.lineTo(-15, 21);
  ctx.lineTo(-15, -3);
  ctx.lineTo(-21, 4);
  ctx.lineTo(-29, -3);
  ctx.lineTo(-16, -19);
  ctx.closePath();
  ctx.fillStyle = litFill(ctx, 0, 0, 26, 21, color, 0.22, 0.26);
  ctx.fill();
  ctx.strokeStyle = alpha(tone(color, 0.6), 0.8);
  ctx.lineWidth = 2.2;
  ctx.lineCap = 'round';
  for (const y of [-6, 3]) {
    ctx.beginPath();
    for (let x = -13; x <= 13; x += 6.5) {
      ctx.lineTo(x, y + (Math.round((x + 13) / 6.5) % 2 ? 3 : 0));
    }
    ctx.stroke();
  }
  roundRect(ctx, -15.6, 15, 31.2, 6.6, 2);
  ctx.fillStyle = tone(color, -0.2);
  ctx.fill();
  ctx.restore();
}

function paintSweaterIcon(ctx) {
  paintSweater(ctx, 39, 28, 0.82, '#3f8fc4');
  paintSweater(ctx, 27, 37, 0.94, '#e8963c');
}

function paintSpringIcon(ctx) {
  // The coil is the card: a spoon on a spring, cocked and ready.
  ctx.strokeStyle = METAL_LO;
  ctx.lineWidth = 3.4;
  ctx.lineCap = 'round';
  ctx.beginPath();
  for (let i = 0; i <= 48; i++) {
    const t = i / 48;
    const x = 40 + Math.sin(t * TAU * 4) * 9, y = 58 - t * 22;
    ctx[i ? 'lineTo' : 'moveTo'](x, y);
  }
  ctx.stroke();
  ctx.strokeStyle = METAL_HI;
  ctx.lineWidth = 1.2;
  ctx.stroke();
  roundRect(ctx, 26, 56, 28, 6, 3);
  ctx.fillStyle = WOOD_LO;
  ctx.fill();
  capsule(ctx, 41, 35, 3, 22, 22, 2.6, linGrad(ctx, 22, 22, 41, 35, [WOOD_HI, WOOD]));
  ell(ctx, 15, 17, 12, 8.8, linGrad(ctx, 4, 8, 26, 26, [WOOD_HI, WOOD, WOOD_LO]), 0.55);
  ell(ctx, 14.4, 15.4, 8.2, 5.4, WOOD_LO, 0.55);
  snowball(ctx, 14, 12, 8.6, { shade: LILAC });
}

function paintPackedIcon(ctx) {
  block(ctx, 16, 19, 28, 30, 8, SNOW_HI, linGrad(ctx, 16, 19, 44, 49, [SNOW_HI, SNOW_MID, LILAC]), LILAC);
  ctx.strokeStyle = alpha(LILAC_DEEP, 0.6);
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(17, 29); ctx.lineTo(43, 29);
  ctx.moveTo(17, 39); ctx.lineTo(43, 39);
  ctx.moveTo(30, 20); ctx.lineTo(30, 28);
  ctx.moveTo(24, 30); ctx.lineTo(24, 38);
  ctx.moveTo(36, 30); ctx.lineTo(36, 38);
  ctx.moveTo(30, 40); ctx.lineTo(30, 48);
  ctx.stroke();
  const col = '#d9534f';
  for (const [x, y, a] of [[4, 34, 0], [60, 34, Math.PI], [30, 62, -Math.PI / 2], [34, 3, Math.PI / 2]]) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(a);
    capsule(ctx, 0, 0, 2.2, 5, 0, 2.2, col);
    poly(ctx, [[12, 0], [4, -6.2], [4, 6.2]], col);
    ctx.restore();
  }
}

function paintLuckyIcon(ctx) {
  paintMitten(ctx, 29, 37, 1.02, '#5fae6b');
  ctx.save();
  ctx.translate(47, 16);
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * TAU + 0.785;
    ell(ctx, Math.cos(a) * 6.4, Math.sin(a) * 6.4, 6.2, 5.2, i % 2 ? '#7fce5e' : '#5fb64c', a);
  }
  ell(ctx, 0, 0, 2, 2, GOLD);
  ctx.restore();
  sparkle(ctx, 14, 9, 7, GOLD);
  sparkle(ctx, 60, 39, 5, GOLD);
}

function paintThermosIcon(ctx) {
  const body = '#3f8fc4';
  steam(ctx, 32, 13, 2.2);
  roundRect(ctx, 17, 22, 30, 37, 7);
  ctx.fillStyle = linGrad(ctx, 17, 0, 47, 0, [tone(body, 0.34), body, tone(body, -0.32)]);
  ctx.fill();
  roundRect(ctx, 21, 13, 22, 10, 3);
  ctx.fillStyle = linGrad(ctx, 21, 0, 43, 0, [METAL_HI, METAL, METAL_LO]);
  ctx.fill();
  roundRect(ctx, 16, 36, 32, 9, 0);
  ctx.fillStyle = CREAM;
  ctx.fill();
  ell(ctx, 32, 40.5, 2.6, 2.6, '#d9534f');
  ctx.beginPath();
  ctx.arc(49, 40, 8, -1.3, 1.3);
  ctx.strokeStyle = tone(body, -0.2);
  ctx.lineWidth = 3.6;
  ctx.lineCap = 'round';
  ctx.stroke();
}

function paintShovelIcon(ctx) {
  ctx.save();
  ctx.translate(32, 32);
  ctx.rotate(0.62);
  capsule(ctx, 0, -27, 2.6, 0, 10, 2.8, linGrad(ctx, -3, 0, 3, 0, [WOOD_HI, WOOD]));
  ctx.beginPath();
  ctx.arc(0, -27, 6.6, 0, TAU);
  ctx.strokeStyle = WOOD_LO;
  ctx.lineWidth = 3.2;
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(-12, 6);
  ctx.quadraticCurveTo(0, 2, 12, 6);
  ctx.lineTo(13, 24);
  ctx.quadraticCurveTo(0, 33, -13, 24);
  ctx.closePath();
  ctx.fillStyle = linGrad(ctx, -13, 0, 13, 0, [tone('#d9534f', 0.3), '#d9534f', tone('#d9534f', -0.28)]);
  ctx.fill();
  ell(ctx, -1, 23, 9, 5.4, SNOW_HI);
  ell(ctx, 3, 19, 5, 3.4, SNOW_HI);
  ctx.restore();
}

function paintSock(ctx, x, y, s, color, stripe) {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(s, s);
  ctx.beginPath();
  ctx.moveTo(-10, -24);
  ctx.lineTo(10, -24);
  ctx.lineTo(10, 4);
  ctx.quadraticCurveTo(26, 8, 26, 17);
  ctx.quadraticCurveTo(25, 24, 15, 24);
  ctx.lineTo(-3, 24);
  ctx.quadraticCurveTo(-12, 22, -10, 8);
  ctx.closePath();
  ctx.fillStyle = litFill(ctx, 6, 0, 22, 24, color, 0.24, 0.26);
  ctx.fill();
  clipped(ctx, () => {
    ctx.fillStyle = stripe;
    ctx.fillRect(-12, -18, 24, 5);
    ctx.fillRect(-12, -9, 24, 5);
    ell(ctx, 22, 18, 9, 9, stripe);
    ell(ctx, -6, 21, 9, 7, stripe);
  });
  ctx.fillStyle = tone(color, 0.6);
  ctx.fillRect(-10.5, -25, 21, 5);
  ctx.restore();
}

function paintSocksIcon(ctx) {
  paintSock(ctx, 37, 26, 0.86, '#e8963c', '#fff1dd');
  paintSock(ctx, 22, 35, 0.96, '#7a6bd1', '#fff1dd');
}

function paintWindupIcon(ctx) {
  // A ball with a big wind-up arrow swung round it, already most of the way to the release.
  ctx.beginPath();
  ctx.arc(32, 34, 25, 0.5, Math.PI * 1.72);
  ctx.strokeStyle = '#d9534f';
  ctx.lineWidth = 6;
  ctx.lineCap = 'round';
  ctx.stroke();
  poly(ctx, [[56, 12], [42, 8], [51, 22]], '#d9534f');
  ell(ctx, 33, 37, 14.5, 14.5, alpha(LILAC_DEEP, 0.8));
  snowball(ctx, 32, 34, 14.5, { shade: LILAC });
}

const CARD_ART = [
  [['thermos'], paintThermosIcon],
  [['shovel'], paintShovelIcon],
  [['sock'], paintSocksIcon],
  [['windup'], paintWindupIcon],
  [['earmuff', 'muff'], paintEarmuffs],
  [['lucky'], paintLuckyIcon],
  [['boot'], paintBootIcon],
  [['tong'], paintTongsIcon],
  [['mitten'], paintBigMittensIcon],
  [['icecore', 'core'], paintIceCoreIcon],
  [['fastball', 'fast'], paintFastballIcon],
  [['splat'], paintBigSplatIcon],
  [['dryer', 'hair'], paintDryerIcon],
  [['belly', 'grease'], paintBellyIcon],
  [['longarm', 'arms', 'reach'], paintLongArmsIcon],
  [['sweater'], paintSweaterIcon],
  [['spring', 'spoon'], paintSpringIcon],
  [['packed', 'tight'], paintPackedIcon],
];

// Card ids belong to cards.js, and a card added later must still get a sensible picture, so art is
// found by name first and then by what the card actually does to the mods.
const ART_BY_MOD = {
  maxWarmth: paintEarmuffs, speedMul: paintBootIcon, packTimeMul: paintTongsIcon, maxBalls: paintBigMittensIcon,
  throwDmgMul: paintIceCoreIcon, throwSpeedMul: paintFastballIcon, lobSplashMul: paintBigSplatIcon,
  thawTimeMul: paintDryerIcon, slideCdMul: paintBellyIcon, buildRangeMul: paintLongArmsIcon, regenMul: paintSweaterIcon,
  pultDmgMul: paintSpringIcon, wallHpMul: paintPackedIcon, flakeBonus: paintLuckyIcon,
};

function artByEffect(card) {
  if (typeof card?.apply !== 'function') return null;
  try {
    const before = defaultMods();
    const after = { ...before };
    card.apply(after);
    for (const k of Object.keys(ART_BY_MOD)) if (after[k] !== before[k]) return ART_BY_MOD[k];
  } catch {
    // A card whose apply() throws is a bug elsewhere; it should not cost the UI its icon.
  }
  return null;
}

export function cardArt(id) {
  const card = CARD_BY_ID?.[id];
  const text = `${id} ${card?.name ?? ''}`.toLowerCase().replace(/[^a-z]/g, '');
  for (const [words, art] of CARD_ART) if (words.some((w) => text.includes(w))) return art;
  return artByEffect(card);
}

// Generic card: a medal in a colour hashed from the id, so two unknown cards still look different.
function paintGenericCard(ctx, id) {
  const h = hashString(String(id));
  const col = LOOK.scarf[h % (LOOK.scarf.length - 1)];
  ell(ctx, 32, 33, 27, 27, alpha(tone(col, -0.5), 0.5));
  star5(ctx, 32, 32, 29, litFill(ctx, 32, 32, 28, 28, col, 0.3, 0.26), -Math.PI / 2, 0.68);
  ell(ctx, 32, 32, 15.4, 15.4, tone(col, 0.72));
  paintFlake(ctx, 32, 32, 13);
  sparkle(ctx, 53, 13, 6);
}

function fit(ctx, cx, cy, s, fn) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(s, s);
  fn();
  ctx.restore();
}

// Foe portraits crop to head and chest: at 24 px a full body is mostly snow pants.
const FOE_FIT = {
  [ACTOR.KID]: (c) => fit(c, 32, 62, 1.44, () => paintKid(c, { hat: 0, coat: 0, scarf: 4, skin: 1 }, null, 'idle', 0, 2)),
  [ACTOR.PIPSQUEAK]: (c) => fit(c, 32, 63, 1.62, () => paintFoe(c, ACTOR.PIPSQUEAK, 'idle', 0, 2)),
  [ACTOR.SLINGER]: (c) => fit(c, 32, 76, 1.5, () => paintFoe(c, ACTOR.SLINGER, 'idle', 0, 2)),
  [ACTOR.LOBBER]: (c) => fit(c, 32, 63, 1, () => paintFoe(c, ACTOR.LOBBER, 'idle', 0, 2)),
  [ACTOR.BRUISER]: (c) => fit(c, 32, 69, 0.92, () => paintFoe(c, ACTOR.BRUISER, 'idle', 0, 2)),
  [ACTOR.SLEDDER]: (c) => fit(c, 34, 45, 0.92, () => paintFoe(c, ACTOR.SLEDDER, 'sled', 0, 1)),
  [ACTOR.LIDKID]: (c) => fit(c, 32, 62, 1.44, () => paintFoe(c, ACTOR.LIDKID, 'idle', 0, 2)),
  [ACTOR.SNEAK]: (c) => fit(c, 32, 62, 1.18, () => paintFoe(c, ACTOR.SNEAK, 'idle', 0, 2, true)),
  [ACTOR.TRUCK]: (c) => fit(c, 32, 49, 0.4, () => {
    const h = 0.42;
    paintTruck(c, h, false);
    const seat = coneSeat(h);
    c.translate(seat.x, seat.y);
    paintCone(c, -1.2);
  }),
  [ACTOR.STEVE]: (c) => fit(c, 32, 74, 0.62, () => {
    paintSteveBody(c, 2, 'tired');
    c.save();
    c.translate(-33, -71);
    c.rotate(0.14);
    paintSteveArm(c);
    c.restore();
    c.save();
    c.translate(33, -71);
    c.rotate(-0.14);
    paintSteveArm(c);
    c.restore();
  }),
};

const ICONS = {
  flake: (c) => paintFlake(c),
  ball: (c) => paintSnowballIcon(c),
  [`tool:${STRUCT.WALL}`]: paintWallIcon,
  [`tool:${STRUCT.ICEWALL}`]: paintIceWallIcon,
  [`tool:${STRUCT.DECOY}`]: paintCoatIcon,
  [`tool:${STRUCT.PULT}`]: paintFlingerIcon,
  [`tool:${STRUCT.SLICK}`]: paintSlickIcon,
  [`tool:${STRUCT.COCOA}`]: paintCocoaStandIcon,
  [`tool:${STRUCT.COLONEL}`]: paintColonelIcon,
  'tool:demolish': paintDemolishIcon,
  [`special:${PICKUP.ICE}`]: paintIceIcon,
  [`special:${PICKUP.SLUSH}`]: paintSlushIcon,
  [`special:${PICKUP.TRIPLE}`]: paintTripleIcon,
  [`special:${PICKUP.GIANT}`]: paintGiantIcon,
  [`special:${PICKUP.COCOA}`]: (c) => { paintCocoaMug(c, 29, 40, 1.14); steam(c, 29, 18); },
  [`special:${PICKUP.BOARD}`]: paintBoardIcon,
};

export function paintIcon(ctx, name) {
  const direct = ICONS[name];
  if (direct) { direct(ctx); return; }
  const sep = name.indexOf(':');
  const family = sep < 0 ? name : name.slice(0, sep);
  const rest = sep < 0 ? '' : name.slice(sep + 1);
  if (family === 'card') {
    const art = cardArt(rest);
    if (art) art(ctx);
    else paintGenericCard(ctx, rest);
    return;
  }
  if (family === 'foe') {
    const f = FOE_FIT[Number(rest)];
    if (f) { f(ctx); return; }
  }
  // An unknown name is a caller bug, but a flake in the HUD beats a hole in the HUD.
  paintFlake(ctx);
}

