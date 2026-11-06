// Small world art: balls, pickups, shadows, ground markers, the paper crown and the Truce Rope.
// Bake-time painters; each returns a bank sprite.
import { BALL, PICKUP, TEAM } from '../../shared/schema.js';
import { TEAM_STYLE } from '../../shared/constants.js';
import { P } from './palette.js';
import {
  TAU, between, makeRng, hashString, withAlpha, shadeOf, lightOf, linear, radial, orb, softEllipse,
  fillRounded, closedCurve, blobPoints, blob, taperedStroke, snowCap,
} from './paint.js';

// ---- shadows and ground light ----------------------------------------------

export function shadowSprite(bank) {
  return bank.get('pr|shadow', { x: -32, y: -32, w: 64, h: 64 }, (g) => {
    g.fillStyle = radial(g, 0, 0, 0, 32, [[0, 'rgba(84,80,160,0.62)'], [0.55, 'rgba(84,80,160,0.42)'], [1, 'rgba(84,80,160,0)']]);
    g.beginPath();
    g.arc(0, 0, 32, 0, TAU);
    g.fill();
  });
}

// Feathered only on open sides. A joined side stops flush at the cell edge, so a line of wall shadows
// butts together into one even band with no beading at the seams.
export function blockShadowSprite(bank, mask = 0) {
  return bank.get(`pr|blockshadow|${mask}`, { x: -16, y: -16, w: 72, h: 72 }, (g) => {
    const steps = 11;
    for (let i = 0; i < steps; i++) {
      const t = i / steps;
      const feather = -15 + t * 26;
      const l = mask & 1 ? 0 : feather;
      const r = mask & 2 ? 0 : feather;
      const u = mask & 4 ? 0 : feather;
      const d = mask & 8 ? 0 : feather;
      g.fillStyle = 'rgba(92,86,176,0.046)';
      g.fillRect(l, u, 40 - l - r, 40 - u - d);
    }
  });
}

export function meRingSprite(bank) {
  return bank.get('pr|mering', { x: -34, y: -34, w: 68, h: 68 }, (g) => {
    g.fillStyle = radial(g, 0, 0, 12, 33, [[0, 'rgba(255,255,255,0)'], [0.45, 'rgba(255,255,255,0.5)'], [0.74, 'rgba(255,250,214,0.92)'], [1, 'rgba(255,240,190,0)']]);
    g.beginPath();
    g.arc(0, 0, 33, 0, TAU);
    g.fill();
  });
}

// Pickup halo: a soft pool of light that finds the eye on a white field at any time of day.
export function haloSprite(bank, color) {
  const key = `pr|halo|${color}`;
  return bank.get(key, { x: -32, y: -32, w: 64, h: 64 }, (g) => {
    g.fillStyle = radial(g, 0, 0, 0, 32, [[0, withAlpha(color, 0.6)], [0.5, withAlpha(color, 0.28)], [1, withAlpha(color, 0)]]);
    g.beginPath();
    g.arc(0, 0, 32, 0, TAU);
    g.fill();
  });
}

// ---- balls ------------------------------------------------------------------

// Painted at these radii (in world units) and scaled to the ball's live radius when drawn.
const BALL_R = { [BALL.QUICK]: 8, [BALL.POWER]: 9, [BALL.LOB]: 9, [BALL.ICE]: 9, [BALL.SLUSH]: 9, [BALL.GIANT]: 34, [BALL.CONE]: 9, [BALL.BOULDER]: 46 };

function paintSnowball(g, r, rng, opts = {}) {
  const pts = blobPoints(0, 0, r * 0.96, r * 0.96, rng, 0.05, 10);
  g.beginPath();
  closedCurve(g, pts);
  g.fillStyle = orb(g, 0, 0, r, opts.stops || ['#ffffff', '#f6f9ff', '#d4dbf6', '#8d90d2']);
  g.fill();
  softEllipse(g, -r * 0.36, -r * 0.4, r * 0.44, r * 0.3, '#ffffff', 0.95, -0.5);
}

function paintIceChunk(g, r, rng) {
  const verts = [];
  const n = 7;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU + 0.3;
    const k = between(rng, 0.84, 1.05);
    verts.push([Math.cos(a) * r * k, Math.sin(a) * r * k]);
  }
  const shades = ['#e4fbff', '#b9eefa', '#8fdcf2', '#62c2e6', '#4aa9da', '#7cd2ee', '#c9f3fb'];
  for (let i = 0; i < n; i++) {
    const a = verts[i];
    const b = verts[(i + 1) % n];
    g.beginPath();
    g.moveTo(-r * 0.14, -r * 0.18);
    g.lineTo(a[0], a[1]);
    g.lineTo(b[0], b[1]);
    g.closePath();
    g.fillStyle = shades[i];
    g.fill();
    g.strokeStyle = shades[i];
    g.lineWidth = 0.4;
    g.stroke();
  }
  g.strokeStyle = withAlpha('#ffffff', 0.92);
  g.lineWidth = r * 0.1;
  g.beginPath();
  g.moveTo(verts[3][0], verts[3][1]);
  g.lineTo(verts[4][0], verts[4][1]);
  g.lineTo(verts[5][0], verts[5][1]);
  g.stroke();
  g.fillStyle = '#ffffff';
  g.beginPath();
  g.moveTo(-r * 0.42, -r * 0.82);
  g.quadraticCurveTo(-r * 0.42, -r * 0.42, 0, -r * 0.42);
  g.quadraticCurveTo(-r * 0.42, -r * 0.42, -r * 0.42, 0);
  g.quadraticCurveTo(-r * 0.42, -r * 0.42, -r * 0.84, -r * 0.42);
  g.quadraticCurveTo(-r * 0.42, -r * 0.42, -r * 0.42, -r * 0.82);
  g.fill();
}

function paintSlushball(g, r, rng) {
  const pts = blobPoints(0, 0, r, r * 0.94, rng, 0.14, 10);
  g.beginPath();
  closedCurve(g, pts);
  g.fillStyle = orb(g, 0, 0, r, ['#e4f0f8', '#a8c9de', '#7fa6c8', '#5b7cae']);
  g.fill();
  for (let i = 0; i < 8; i++) {
    const a = rng() * TAU;
    const d = rng() * r * 0.8;
    g.fillStyle = withAlpha(i % 2 ? '#4c6c9c' : '#f2fbff', 0.7);
    g.beginPath();
    g.arc(Math.cos(a) * d, Math.sin(a) * d, between(rng, r * 0.05, r * 0.14), 0, TAU);
    g.fill();
  }
}

// Syrup-soaked: bright enough that kids learn "pink things from the truck hurt" within one volley.
function paintCone(g, r, rng) {
  g.beginPath();
  g.moveTo(-r * 0.66, r * 0.1);
  g.lineTo(0, r * 1.25);
  g.lineTo(r * 0.66, r * 0.1);
  g.closePath();
  g.fillStyle = linear(g, -r, 0, r, 0, ['#fffaf0', '#f2e6d8', '#d8c4c8']);
  g.fill();
  g.strokeStyle = withAlpha('#3fb49c', 0.7);
  g.lineWidth = r * 0.14;
  g.beginPath();
  g.moveTo(-r * 0.34, r * 0.36);
  g.lineTo(r * 0.46, r * 0.26);
  g.moveTo(-r * 0.12, r * 0.74);
  g.lineTo(r * 0.28, r * 0.68);
  g.stroke();
  g.beginPath();
  closedCurve(g, blobPoints(0, -r * 0.2, r * 0.82, r * 0.68, rng, 0.08, 9));
  g.fillStyle = orb(g, 0, -r * 0.2, r * 0.9, ['#ffd9ec', '#f58ac0', '#d84f9c']);
  g.fill();
  softEllipse(g, r * 0.3, -r * 0.1, r * 0.42, r * 0.34, '#5ad4f0', 0.92);
  softEllipse(g, -r * 0.28, -r * 0.5, r * 0.26, r * 0.15, '#ffffff', 0.95);
}

function paintGiant(g, r, rng) {
  paintSnowball(g, r, rng);
  // Swirl seams: without them a rolling ball shows no rotation at all.
  g.lineCap = 'round';
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * TAU + 0.4;
    g.strokeStyle = withAlpha('#b8bce8', 0.7);
    g.lineWidth = r * 0.07;
    g.beginPath();
    g.arc(Math.cos(a) * r * 0.45, Math.sin(a) * r * 0.45, r * 0.42, a + 1.2, a + 3.5);
    g.stroke();
  }
}

function paintBoulder(g, r, rng) {
  const pts = blobPoints(0, 0, r * 0.96, r * 0.96, rng, 0.08, 13);
  g.beginPath();
  closedCurve(g, pts);
  g.fillStyle = orb(g, 0, 0, r, ['#ffffff', '#eef2fc', '#ccd0f0', '#8f8fca']);
  g.fill();
  g.save();
  g.clip();
  for (let i = 0; i < 14; i++) {
    const a = rng() * TAU;
    const d = rng() * r * 0.85;
    softEllipse(g, Math.cos(a) * d, Math.sin(a) * d, between(rng, r * 0.14, r * 0.34), between(rng, r * 0.08, r * 0.2), rng() < 0.5 ? '#c5c7ee' : '#ffffff', 0.6, rng() * TAU);
  }
  // Things it has rolled over on the way here. Sticks only, all swept the same way: a pair of round
  // stones on a white ball is a face, and Colonel Carrot is the only snowman in the game.
  for (let i = 0; i < 7; i++) {
    const a = rng() * TAU;
    const d = between(rng, r * 0.3, r * 0.86);
    const x = Math.cos(a) * d;
    const y = Math.sin(a) * d;
    const len = between(rng, r * 0.2, r * 0.42);
    taperedStroke(g, x, y, x + len, y + len * 0.5, r * 0.055, r * 0.02, r * 0.04, '#7a5c56');
  }
  g.restore();
}

export function ballSprite(bank, kind) {
  const r = BALL_R[kind] ?? 8;
  const key = `pr|ball|${kind}`;
  const box = { x: -r * 1.4, y: -r * 1.4, w: r * 2.8, h: r * 2.8 };
  const sp = bank.get(key, box, (g) => {
    const rng = makeRng(hashString(key));
    switch (kind) {
      case BALL.POWER:
        paintSnowball(g, r, rng, { stops: ['#ffffff', '#fffdf2', '#ffe9b0', '#f0a94e'] });
        break;
      case BALL.LOB:
        paintSnowball(g, r, rng, { stops: ['#ffffff', '#f2f6ff', '#c8d2f2', '#8089cc'] });
        break;
      case BALL.ICE: paintIceChunk(g, r, rng); break;
      case BALL.SLUSH: paintSlushball(g, r, rng); break;
      case BALL.GIANT: paintGiant(g, r, rng); break;
      case BALL.CONE: paintCone(g, r, rng); break;
      case BALL.BOULDER: paintBoulder(g, r, rng); break;
      default: paintSnowball(g, r, rng); break;
    }
  });
  sp.r = r;
  return sp;
}

// Comet tail for fast balls, drawn stretched along the velocity.
export function streakSprite(bank, kind) {
  const hot = kind === BALL.POWER;
  const ice = kind === BALL.ICE;
  const key = `pr|streak|${hot ? 1 : ice ? 2 : 0}`;
  const col = hot ? '#ffd27a' : ice ? '#a8ecfa' : '#ffffff';
  return bank.get(key, { x: -64, y: -8, w: 64, h: 16 }, (g) => {
    g.fillStyle = linear(g, -64, 0, 0, 0, [withAlpha(col, 0), withAlpha(col, 0.28), withAlpha(col, 0.72)]);
    g.beginPath();
    g.moveTo(-64, 0);
    g.quadraticCurveTo(-20, -7, 0, -6.5);
    g.quadraticCurveTo(4, 0, 0, 6.5);
    g.quadraticCurveTo(-20, 7, -64, 0);
    g.fill();
  });
}

// ---- pickups ----------------------------------------------------------------

const PICKUP_GLOW = {
  [PICKUP.ICE]: '#7fdcf6',
  [PICKUP.SLUSH]: '#8fb4e0',
  [PICKUP.TRIPLE]: '#ffffff',
  [PICKUP.GIANT]: '#c4c8ff',
  [PICKUP.COCOA]: '#ffb46a',
  [PICKUP.BOARD]: '#ff8fb0',
};

export const pickupGlow = (kind) => PICKUP_GLOW[kind] ?? '#ffffff';

function paintPickup(g, kind, rng) {
  switch (kind) {
    case PICKUP.ICE: {
      g.scale(1.25, 1.25);
      paintIceChunk(g, 12, rng);
      break;
    }
    case PICKUP.SLUSH: {
      // A brimming pail of slush.
      g.beginPath();
      g.moveTo(-11, -4);
      g.lineTo(-8, 13);
      g.quadraticCurveTo(0, 16, 8, 13);
      g.lineTo(11, -4);
      g.closePath();
      g.fillStyle = linear(g, -11, 0, 11, 0, ['#8fa8d4', '#5e7cb4', '#465f96']);
      g.fill();
      g.strokeStyle = '#3a4a80';
      g.lineWidth = 1.6;
      g.beginPath();
      g.arc(0, -4, 12, Math.PI, 0);
      g.stroke();
      g.translate(0, -5);
      g.scale(1.2, 0.75);
      paintSlushball(g, 10, rng);
      break;
    }
    case PICKUP.TRIPLE: {
      for (const [x, y] of [[-8, 6], [8, 6], [0, -7]]) {
        g.save();
        g.translate(x, y);
        paintSnowball(g, 9, rng);
        g.restore();
      }
      break;
    }
    case PICKUP.GIANT: {
      g.save();
      g.scale(0.52, 0.52);
      paintGiant(g, 30, rng);
      g.restore();
      g.strokeStyle = P.gold;
      g.lineWidth = 2.4;
      g.beginPath();
      g.arc(0, 0, 19, -2.4, -1);
      g.stroke();
      g.beginPath();
      g.moveTo(11.4, -17);
      g.lineTo(8.8, -11);
      g.lineTo(15.6, -12);
      g.closePath();
      g.fillStyle = P.gold;
      g.fill();
      break;
    }
    case PICKUP.COCOA: {
      fillRounded(g, -11, -9, 19, 20, [2, 2, 7, 7], linear(g, -11, 0, 9, 0, ['#ec6a72', '#d6404e', '#a82f48']));
      g.strokeStyle = '#c23a4a';
      g.lineWidth = 3;
      g.beginPath();
      g.arc(9.4, 1.5, 5.2, -1.3, 1.3);
      g.stroke();
      g.beginPath();
      g.ellipse(-1.5, -9, 9.5, 3.4, 0, 0, TAU);
      g.fillStyle = '#7a4b38';
      g.fill();
      for (const [x, y] of [[-5, -10], [0.4, -10.8], [2.4, -8.7]]) {
        fillRounded(g, x, y, 4, 3.2, 1.2, '#fff8ee');
      }
      fillRounded(g, -7, -3, 8, 8, 1.4, withAlpha('#ffffff', 0.25));
      break;
    }
    case PICKUP.BOARD: {
      g.save();
      g.rotate(0.5);
      fillRounded(g, -7.5, -21, 15, 42, 7, linear(g, -8, 0, 8, 0, ['#ff9ec0', '#e94e8a', '#b83a84']));
      fillRounded(g, -2.5, -19, 5, 38, 2.5, '#fff0b8');
      fillRounded(g, -7.5, -7, 15, 3.6, 1, '#3b3b68');
      fillRounded(g, -7.5, 5, 15, 3.6, 1, '#3b3b68');
      snowCap(g, -7, 7, -14, 3, rng, { droop: 1, lumps: 3 });
      g.restore();
      break;
    }
    default: {
      paintSnowball(g, 12, rng);
    }
  }
}

export function pickupSprite(bank, kind) {
  const key = `pr|pick|${kind}`;
  return bank.get(key, { x: -26, y: -26, w: 52, h: 52 }, (g) => paintPickup(g, kind, makeRng(hashString(key))));
}

// ---- crown, rope, arrows ----------------------------------------------------

// FFA leader's paper crown: folded construction paper, deliberately a bit wonky.
export function crownSprite(bank) {
  return bank.get('pr|crown', { x: -16, y: -16, w: 32, h: 24 }, (g) => {
    g.beginPath();
    g.moveTo(-12, 5);
    g.lineTo(-13.5, -8);
    g.lineTo(-6.5, -2.5);
    g.lineTo(-1, -12.5);
    g.lineTo(5, -3);
    g.lineTo(13, -9);
    g.lineTo(11.5, 5);
    g.closePath();
    g.fillStyle = linear(g, -13, -12, 13, 5, ['#ffe58c', '#f4c34e', '#e09a3a']);
    g.fill();
    g.strokeStyle = withAlpha('#c07a28', 0.8);
    g.lineWidth = 0.9;
    g.stroke();
    g.fillStyle = '#e24a55';
    g.beginPath();
    g.arc(-1, -5.5, 1.9, 0, TAU);
    g.fill();
    g.fillStyle = '#3f8fc4';
    g.beginPath();
    g.arc(-7, 1.2, 1.5, 0, TAU);
    g.arc(6.5, 1, 1.5, 0, TAU);
    g.fill();
  });
}

const ROPE_POST_H = 36;
const ROPE_LEAN = 12; // same sideways cheat as the fences: without it a rope up the screen is a line

function paintPost(g, rng, lean = 0) {
  g.save();
  g.transform(1, 0, -lean / ROPE_POST_H, 1, 0, 0);
  fillRounded(g, -3.4, -ROPE_POST_H, 6.8, ROPE_POST_H + 2, 2, linear(g, -4, 0, 4, 0, [P.woodLight, P.wood, P.woodDark]));
  fillRounded(g, -3.8, -ROPE_POST_H + 9, 7.6, 4, 1, TEAM_STYLE[TEAM.A].color);
  fillRounded(g, -3.8, -ROPE_POST_H + 14, 7.6, 4, 1, TEAM_STYLE[TEAM.B].color);
  snowCap(g, -4.6, 4.6, -ROPE_POST_H + 1, 5.5, rng, { droop: 1.2, lumps: 3 });
  g.restore();
  blob(g, 0, 2, 10, 4, rng, '#ffffff', 0.12, 8);
}

function ropeLine(g, x0, y0, cx, cy, x1, y1) {
  g.lineCap = 'round';
  g.strokeStyle = '#a98a5c';
  g.lineWidth = 3.8;
  g.beginPath();
  g.moveTo(x0, y0);
  g.quadraticCurveTo(cx, cy, x1, y1);
  g.stroke();
  g.strokeStyle = '#f2e6c8';
  g.lineWidth = 1.5;
  g.setLineDash([3.5, 3.5]);
  g.beginPath();
  g.moveTo(x0, y0);
  g.quadraticCurveTo(cx, cy, x1, y1);
  g.stroke();
  g.setLineDash([]);
}

function pennant(g, x, y, color, ang) {
  g.save();
  g.translate(x, y);
  g.rotate(ang);
  g.beginPath();
  g.moveTo(-7.5, 0);
  g.lineTo(7.5, 0);
  g.quadraticCurveTo(1.6, 9, 0, 16);
  g.quadraticCurveTo(-1.6, 9, -7.5, 0);
  g.closePath();
  g.fillStyle = linear(g, -7, 0, 7, 0, [lightOf(color, 0.2), color, shadeOf(color, 0.2)]);
  g.fill();
  g.restore();
}

// One span of rope along the screen, post at its left end. Red and blue pennants alternate:
// the rope belongs to both crews while it is up.
export function ropeSpanSprite(bank, len) {
  const key = `pr|rope|h|${len}`;
  return bank.get(key, { x: -10, y: -48, w: len + 20, h: 62 }, (g) => {
    const rng = makeRng(hashString(key));
    paintPost(g, rng);
    const sag = 10;
    const y0 = -ROPE_POST_H + 6;
    ropeLine(g, 0, y0, len / 2, y0 + sag * 2, len, y0);
    const n = Math.max(3, Math.round(len / 28));
    const colors = [TEAM_STYLE[TEAM.A].color, TEAM_STYLE[TEAM.B].color];
    for (let i = 1; i < n; i++) {
      const t = i / n;
      const y = y0 + 4 * sag * t * (1 - t);
      const slope = (4 * sag * (1 - 2 * t)) / len;
      pennant(g, t * len, y, colors[i % 2], Math.atan(slope));
    }
  });
}

// A span running up the screen, post at its near end. Pennants hang side-on, leaning with the rope.
export function ropeSpanVerticalSprite(bank, len) {
  const key = `pr|rope|v|${len}`;
  return bank.get(key, { x: -14, y: -len - 48, w: 44, h: len + 62 }, (g) => {
    const rng = makeRng(hashString(key));
    const x = ROPE_LEAN;
    const y0 = -ROPE_POST_H + 6;
    const colors = [TEAM_STYLE[TEAM.A].color, TEAM_STYLE[TEAM.B].color];
    const n = Math.max(3, Math.round(len / 28));
    for (let i = n - 1; i >= 1; i--) {
      const t = i / n;
      const y = y0 - len * t + 4 * t * (1 - t) * 8;
      const c = colors[i % 2];
      g.beginPath();
      g.moveTo(x - 1.5, y);
      g.quadraticCurveTo(x - 7, y + 5, x - 5, y + 15);
      g.quadraticCurveTo(x, y + 9, x + 1.5, y + 7);
      g.closePath();
      g.fillStyle = linear(g, x - 7, 0, x + 2, 0, [shadeOf(c, 0.16), lightOf(c, 0.16)]);
      g.fill();
    }
    ropeLine(g, x, y0 - len, x + 2, y0 - len / 2 + 8, x, y0);
    paintPost(g, rng, ROPE_LEAN);
  });
}

// Fat painted arrowhead for wave-preview arrows: points along +x, with a soft notch at its tail.
export function chevronSprite(bank) {
  return bank.get('pr|chevron', { x: -26, y: -24, w: 52, h: 48 }, (g) => {
    const shape = () => {
      g.beginPath();
      closedCurve(g, [[-20, -19], [-14, -20], [21, -2], [23, 0], [21, 2], [-14, 20], [-20, 19], [-20, 16], [-6, 1], [-6, -1], [-20, -16]]);
    };
    g.save();
    g.translate(1.2, 2.2);
    shape();
    g.fillStyle = 'rgba(120,40,80,0.3)';
    g.fill();
    g.restore();
    shape();
    g.fillStyle = linear(g, -20, 0, 22, 0, ['#ffb27a', '#f56a5e', '#e23f5c']);
    g.fill();
  });
}

// Used for the x of the demolish tool and the + of repairs.
export function toolMarkSprite(bank, kind) {
  const key = `pr|mark|${kind}`;
  return bank.get(key, { x: -16, y: -16, w: 32, h: 32 }, (g) => {
    g.lineCap = 'round';
    const color = kind === 'x' ? P.bad : P.repair;
    const path = () => {
      g.beginPath();
      if (kind === 'x') {
        g.moveTo(-9, -9);
        g.lineTo(9, 9);
        g.moveTo(9, -9);
        g.lineTo(-9, 9);
      } else {
        g.moveTo(0, -10);
        g.lineTo(0, 10);
        g.moveTo(-10, 0);
        g.lineTo(10, 0);
      }
    };
    path();
    g.strokeStyle = 'rgba(255,255,255,0.9)';
    g.lineWidth = 8;
    g.stroke();
    path();
    g.strokeStyle = color;
    g.lineWidth = 4.6;
    g.stroke();
  });
}
