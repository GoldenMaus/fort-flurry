// Player-built structures. Bake-time painters; the renderer only ever blits the result.
//
// A struct's origin is the top-left of its cell. Everything that stands rises up the screen from the
// cell's front edge by height x Z_LIFT, so the painted top face sits behind the cell, exactly where
// the sim's "z < height" collision thinks it is. The Colonel is ActorArt's, not ours.
import { STRUCT } from '../../shared/schema.js';
import { CELL, BUILD } from '../../shared/constants.js';
import { P, teamColor } from './palette.js';
import { Z_LIFT } from './world.js';
import {
  TAU, lerp, between, makeRng, hashString, mix, withAlpha, shadeOf, lightOf, linear, orb, softEllipse,
  roundedRect, fillRounded, closedCurve, blobPoints, blob, taperedStroke, snowCap, snowBank, snowMound,
} from './paint.js';

export const NB = Object.freeze({ L: 1, R: 2, U: 4, D: 8 });

export function structLevel(s) {
  const f = s.maxHp > 0 ? s.hp / s.maxHp : 1;
  return f > 0.66 ? 0 : f > 0.33 ? 1 : 2;
}

// Cracks are hand-drawn: a jagged dark stroke with a thin light edge on its lower side, as if the
// block has really split rather than had a line drawn on it.
function crackLine(g, pts, color, light, width) {
  const trace = () => {
    g.beginPath();
    g.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]);
  };
  g.lineJoin = 'miter';
  g.save();
  g.translate(0.5, 0.6);
  trace();
  g.strokeStyle = light;
  g.lineWidth = width * 0.8;
  g.stroke();
  g.restore();
  trace();
  g.strokeStyle = color;
  g.lineWidth = width;
  g.stroke();
  g.lineJoin = 'round';
}

function jagged(x0, y0, x1, y1, rng, steps = 5, wander = 3.4) {
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    pts.push([lerp(x0, x1, t) + (i && i < steps ? between(rng, -wander, wander) : 0), lerp(y0, y1, t) + (i && i < steps ? between(rng, -wander, wander) * 0.6 : 0)]);
  }
  return pts;
}

// Takes a bite out of a block, then rims it with shade so it reads as a missing chunk.
function bite(g, x, y, rx, ry, rng, rim) {
  const pts = blobPoints(x, y, rx, ry, rng, 0.22, 8);
  g.save();
  g.globalCompositeOperation = 'source-atop';
  g.translate(0.4, 1.6);
  g.beginPath();
  closedCurve(g, pts);
  g.fillStyle = rim;
  g.fill();
  g.restore();
  g.save();
  g.globalCompositeOperation = 'destination-out';
  g.beginPath();
  closedCurve(g, pts);
  g.fillStyle = '#000';
  g.fill();
  g.restore();
}

function rubble(g, count, rng, color) {
  for (let i = 0; i < count; i++) {
    const x = between(rng, 2, CELL - 2);
    const y = between(rng, CELL - 3, CELL + 3);
    const r = between(rng, 1.8, 4);
    blob(g, x, y, r, r * 0.72, rng, color, 0.2, 6);
  }
}

// ---- snow wall --------------------------------------------------------------

// Neighbour-aware: joined sides drop their rounded corners and edge shading, so a line of walls
// paints as one continuous rampart with a shared top instead of a row of separate cubes.
function blockFrame(mask, rise) {
  return {
    x0: mask & NB.L ? 0 : 1,
    x1: mask & NB.R ? CELL : CELL - 1,
    yTop: mask & NB.U ? -rise : -rise + 1,
    yEdge: CELL - rise,
    yBase: mask & NB.D ? CELL : CELL - 0.6,
    rTL: mask & (NB.L | NB.U) ? 0 : 7,
    rTR: mask & (NB.R | NB.U) ? 0 : 7,
    rBL: mask & NB.L ? 0 : 7,
    rBR: mask & NB.R ? 0 : 7,
  };
}

function paintWall(g, mask, level, variant, rng) {
  const rise = BUILD[STRUCT.WALL].height * Z_LIFT;
  const f = blockFrame(mask, rise);
  const w = f.x1 - f.x0;

  // Front face: the shaded side, deep enough to separate the block from the snow it stands on.
  g.beginPath();
  roundedRect(g, f.x0, f.yEdge - 4, w, f.yBase - f.yEdge + 4, [0, 0, f.rBR, f.rBL]);
  g.fillStyle = linear(g, 0, f.yEdge, 0, f.yBase, [[0, '#d9dff4'], [0.5, '#bfc4ec'], [1, '#9c9cd8']]);
  g.fill();
  g.save();
  g.clip();

  // Packed bricks, two courses, staggered between neighbours. Seams carry a light lower lip.
  const row = (f.yBase - f.yEdge) / 2;
  const seamY = f.yEdge + row;
  const seam = (x0, y0, x1, y1) => {
    g.strokeStyle = withAlpha('#8384c8', 0.8);
    g.lineWidth = 1.5;
    g.beginPath();
    g.moveTo(x0, y0);
    g.lineTo(x1, y1);
    g.stroke();
    g.strokeStyle = withAlpha('#f0f2fc', 0.75);
    g.lineWidth = 0.9;
    g.beginPath();
    g.moveTo(x0 + 0.5, y0 + 1.1);
    g.lineTo(x1 + 0.5, y1 + 1.1);
    g.stroke();
  };
  seam(f.x0, seamY + between(rng, -0.8, 0.8), f.x1, seamY + between(rng, -0.8, 0.8));
  const offs = variant & 1 ? 12 : 26;
  const low = offs < 20 ? offs + 17 : offs - 15;
  seam(offs, f.yEdge, offs + between(rng, -1, 1), seamY);
  seam(low, seamY, low + between(rng, -1, 1), f.yBase);
  for (let i = 0; i < 6; i++) {
    softEllipse(g, between(rng, f.x0, f.x1), between(rng, f.yEdge + 3, f.yBase - 3), between(rng, 5, 11), between(rng, 2.5, 5), '#eef1fb', between(rng, 0.25, 0.55));
  }
  // Bounce light from the snow at the foot, which keeps the shaded side from going grey.
  g.fillStyle = linear(g, 0, f.yBase - 7, 0, f.yBase, [withAlpha('#d8d4f6', 0), withAlpha('#e6e2fa', 0.42)]);
  g.fillRect(f.x0, f.yBase - 7, w, 7);
  if (!(mask & NB.R)) {
    g.fillStyle = linear(g, f.x1 - 10, 0, f.x1, 0, [withAlpha('#6f6cb8', 0), withAlpha('#6f6cb8', 0.42)]);
    g.fillRect(f.x1 - 10, f.yEdge, 10, f.yBase - f.yEdge);
  }
  g.restore();

  // Top face. A pillow: bright in the middle, falling away toward every exposed edge, so a wall that
  // runs up the screen still has a visible shape against the snow around it.
  g.beginPath();
  roundedRect(g, f.x0, f.yTop, w, f.yEdge - f.yTop + 1.5, [f.rTL, f.rTR, 2, 2]);
  g.fillStyle = linear(g, f.x0, f.yTop, f.x1, f.yEdge, ['#ffffff', '#f8faff', '#eaeffb']);
  g.fill();
  g.save();
  g.clip();
  const bevel = (x0, y0, x1, y1, color, a) => {
    g.fillStyle = linear(g, x0, y0, x1, y1, [withAlpha(color, a), withAlpha(color, 0)]);
    g.fillRect(f.x0, f.yTop, w, f.yEdge - f.yTop + 2);
  };
  if (!(mask & NB.R)) bevel(f.x1, 0, f.x1 - 11, 0, '#8e8ed2', 0.62);
  if (!(mask & NB.L)) bevel(f.x0, 0, f.x0 + 7, 0, '#b4b6e6', 0.5);
  if (!(mask & NB.U)) bevel(0, f.yTop, 0, f.yTop + 7, '#b9bce9', 0.5);

  // Courses on the top surface too: this is what makes a run of walls read as stacked blocks.
  g.strokeStyle = withAlpha('#c3c7ec', 0.75);
  g.lineWidth = 1.2;
  g.beginPath();
  const midY = (f.yTop + f.yEdge) / 2 + (variant & 1 ? 2 : -2);
  g.moveTo(f.x0, midY);
  g.lineTo(f.x1, midY + between(rng, -0.7, 0.7));
  const cutA = variant & 1 ? 25 : 14;
  const cutB = variant & 1 ? 11 : 28;
  g.moveTo(cutA, f.yTop);
  g.lineTo(cutA + between(rng, -1, 1), midY);
  g.moveTo(cutB, midY);
  g.lineTo(cutB + between(rng, -1, 1), f.yEdge);
  g.stroke();
  for (let i = 0; i < 4; i++) {
    const x = between(rng, f.x0, f.x1);
    const y = between(rng, f.yTop, f.yEdge);
    softEllipse(g, x, y, between(rng, 6, 12), between(rng, 3, 6), '#ffffff', 0.8);
  }
  g.restore();

  // The rounded lip where top meets front. Soft and full width, so it reads as an edge catching the
  // light and not as a line drawn across the block.
  g.fillStyle = linear(g, 0, f.yEdge - 2.5, 0, f.yEdge + 3.5, [withAlpha('#ffffff', 0), '#ffffff', withAlpha('#ffffff', 0)]);
  g.fillRect(f.x0 + (mask & NB.L ? 0 : 1.5), f.yEdge - 2.5, w - (mask & NB.L ? 0 : 1.5) - (mask & NB.R ? 0 : 1.5), 6);

  if (level >= 1) {
    const ink = '#6f70b4';
    const lit = 'rgba(255,255,255,0.85)';
    const a = between(rng, 6, 16);
    crackLine(g, jagged(a, f.yEdge + 1, a + between(rng, 4, 10), f.yBase - 3, rng, 4), ink, lit, 1.6);
    crackLine(g, jagged(between(rng, 8, 30), f.yTop + 7, between(rng, 12, 34), f.yEdge, rng, 4, 3), '#9b9ed8', lit, 1.3);
    if (level >= 2) {
      const b = between(rng, 24, 34);
      crackLine(g, jagged(b, f.yEdge - 3, b - between(rng, 5, 12), f.yBase - 2, rng, 5), ink, lit, 2);
      crackLine(g, jagged(3, f.yEdge + row * 0.7, 26, f.yEdge + row * 1.2, rng, 4, 2.4), ink, lit, 1.4);
      crackLine(g, jagged(between(rng, 18, 30), f.yTop + 4, between(rng, 6, 16), f.yEdge + 2, rng, 5), '#8e92d2', lit, 1.6);
      bite(g, between(rng, 28, 36), f.yEdge + 1, 8, 6, rng, '#a0a2dc');
      bite(g, between(rng, 2, 9), f.yBase + 1, 7, 5, rng, '#a0a2dc');
      bite(g, between(rng, 6, 22), f.yTop + 1, 7, 4, rng, '#b4b8e6');
    }
    rubble(g, level * 4, rng, '#f2f5fd');
  }
}

// ---- ice wall ---------------------------------------------------------------

function paintIceWall(g, mask, level, variant, rng) {
  const rise = BUILD[STRUCT.ICEWALL].height * Z_LIFT;
  const f = blockFrame(mask, rise);
  const w = f.x1 - f.x0;

  g.beginPath();
  roundedRect(g, f.x0, f.yEdge - 3, w, f.yBase - f.yEdge + 3, [0, 0, Math.min(f.rBR, 5), Math.min(f.rBL, 5)]);
  g.fillStyle = linear(g, f.x0, f.yEdge, f.x1, f.yBase, [
    [0, 'rgba(176,232,246,0.84)'], [0.55, 'rgba(112,196,232,0.78)'], [1, 'rgba(74,150,212,0.86)'],
  ]);
  g.fill();
  g.save();
  g.clip();
  // Refraction: pale facets inside the block. These are what make it glass, not paint.
  for (let i = 0; i < 4; i++) {
    const x = between(rng, f.x0, f.x1);
    const y = between(rng, f.yEdge, f.yBase);
    g.beginPath();
    g.moveTo(x, y - between(rng, 4, 11));
    g.lineTo(x + between(rng, 7, 15), y + between(rng, -3, 3));
    g.lineTo(x + between(rng, -2, 4), y + between(rng, 5, 12));
    g.lineTo(x - between(rng, 6, 13), y + between(rng, -3, 3));
    g.closePath();
    g.fillStyle = withAlpha(i % 2 ? '#d9f6fc' : '#4e9fda', between(rng, 0.16, 0.34));
    g.fill();
  }
  for (let i = 0; i < 7; i++) {
    g.fillStyle = withAlpha('#ffffff', between(rng, 0.4, 0.8));
    g.beginPath();
    g.arc(between(rng, f.x0, f.x1), between(rng, f.yEdge + 2, f.yBase - 2), between(rng, 0.5, 1.4), 0, TAU);
    g.fill();
  }
  // Specular streak, per the art direction: one confident diagonal slash.
  g.beginPath();
  const sx = variant & 1 ? 9 : 17;
  g.moveTo(sx, f.yEdge - 3);
  g.lineTo(sx + 7, f.yEdge - 3);
  g.lineTo(sx - 5, f.yBase + 2);
  g.lineTo(sx - 12, f.yBase + 2);
  g.closePath();
  g.fillStyle = linear(g, 0, f.yEdge, 0, f.yBase, [withAlpha('#ffffff', 0.92), withAlpha('#ffffff', 0.18)]);
  g.fill();
  g.beginPath();
  g.moveTo(sx + 12, f.yEdge - 3);
  g.lineTo(sx + 14.5, f.yEdge - 3);
  g.lineTo(sx + 2.5, f.yBase + 2);
  g.lineTo(sx, f.yBase + 2);
  g.closePath();
  g.fillStyle = withAlpha('#ffffff', 0.45);
  g.fill();
  g.restore();

  // Top face, paler and more frosted.
  g.beginPath();
  roundedRect(g, f.x0, f.yTop, w, f.yEdge - f.yTop + 1, [Math.min(f.rTL, 5), Math.min(f.rTR, 5), 1, 1]);
  g.fillStyle = linear(g, f.x0, f.yTop, f.x1, f.yEdge, ['rgba(236,251,255,0.96)', 'rgba(192,236,248,0.9)', 'rgba(150,216,240,0.92)']);
  g.fill();
  g.save();
  g.clip();
  for (let i = 0; i < 3; i++) {
    softEllipse(g, between(rng, f.x0, f.x1), between(rng, f.yTop, f.yEdge), between(rng, 7, 16), between(rng, 3, 7), '#ffffff', 0.8);
  }
  g.strokeStyle = withAlpha('#ffffff', 0.7);
  g.lineWidth = 0.8;
  g.beginPath();
  g.moveTo(f.x0 + 6, f.yTop + 6);
  g.lineTo(f.x0 + 20, f.yEdge - 7);
  g.moveTo(f.x0 + 20, f.yTop + 4);
  g.lineTo(f.x0 + 30, f.yEdge - 12);
  g.stroke();
  g.restore();

  g.strokeStyle = withAlpha('#f4feff', 0.95);
  g.lineWidth = 1.4;
  g.beginPath();
  g.moveTo(f.x0 + 2, f.yEdge + 0.2);
  g.lineTo(f.x1 - 2, f.yEdge + 0.2);
  g.stroke();

  if (level >= 1) {
    const ink = 'rgba(255,255,255,0.95)';
    const dark = 'rgba(40,110,180,0.45)';
    crackLine(g, jagged(between(rng, 8, 16), f.yEdge, between(rng, 18, 26), f.yBase - 2, rng, 4), ink, dark, 1.5);
    crackLine(g, jagged(between(rng, 18, 30), f.yTop + 4, between(rng, 8, 16), f.yEdge, rng, 3), ink, dark, 1.2);
    if (level >= 2) {
      crackLine(g, jagged(30, f.yEdge + 2, 10, f.yBase - 6, rng, 5), ink, dark, 1.9);
      crackLine(g, jagged(4, f.yEdge + 8, 24, f.yEdge + 12, rng, 4, 2), ink, dark, 1.3);
      bite(g, between(rng, 26, 36), f.yEdge, 8, 7, rng, 'rgba(70,150,210,0.8)');
      bite(g, between(rng, 3, 10), f.yBase, 6, 5, rng, 'rgba(70,150,210,0.8)');
    }
    for (let i = 0; i < level * 3; i++) {
      const x = between(rng, 3, CELL - 3);
      const y = between(rng, CELL - 2, CELL + 3);
      g.beginPath();
      g.moveTo(x, y - 3);
      g.lineTo(x + 3, y);
      g.lineTo(x, y + 2);
      g.lineTo(x - 2.4, y);
      g.closePath();
      g.fillStyle = withAlpha('#c8eff9', 0.9);
      g.fill();
    }
  }
}

// ---- spare coat -------------------------------------------------------------

function paintDecoy(g, color, level, rng) {
  const cx = CELL / 2;
  const by = CELL - 5;
  const lean = level === 2 ? 0.14 : level === 1 ? 0.06 : 0;
  snowMound(g, cx, by + 1, 15, 6, rng);

  g.save();
  g.translate(cx, by);
  g.rotate(lean);

  // Shovel: blade jammed in the snow, handle up through the coat.
  fillRounded(g, -2, -48, 4, 44, 1.6, linear(g, -2, 0, 2, 0, [P.woodLight, P.woodDark]));
  g.beginPath();
  g.moveTo(-8.5, -8);
  g.lineTo(8.5, -8);
  g.quadraticCurveTo(10, 2, 0, 4);
  g.quadraticCurveTo(-10, 2, -8.5, -8);
  g.closePath();
  g.fillStyle = linear(g, -9, 0, 9, 0, ['#c2cbe2', '#7f8cb4']);
  g.fill();

  const hi = lightOf(color, 0.24);
  const lo = shadeOf(color, 0.3);
  // Stuffed sleeves, drooping with their own weight.
  const sleeve = (dir) => {
    g.beginPath();
    g.moveTo(dir * 9, -35);
    g.quadraticCurveTo(dir * 22, -33, dir * 20.5, -17);
    g.quadraticCurveTo(dir * 15, -13, dir * 11.5, -19);
    g.closePath();
    g.fillStyle = linear(g, -20, 0, 20, 0, [hi, color, lo]);
    g.fill();
    blob(g, dir * 18.5, -14.5, 4.2, 3.8, rng, shadeOf(color, 0.42), 0.08, 7);
  };
  sleeve(-1);
  sleeve(1);

  // Coat body: quilted lobes, so it reads as puffy from the top of the screen.
  g.beginPath();
  closedCurve(g, [[-12, -37], [0, -39.5], [12, -37], [15, -24], [13.5, -9], [0, -6.5], [-13.5, -9], [-15, -24]]);
  g.fillStyle = orb(g, 0, -24, 19, [hi, color, lo]);
  g.fill();
  g.strokeStyle = withAlpha(lo, 0.7);
  g.lineWidth = 1.2;
  for (const y of [-30, -22.5, -15]) {
    g.beginPath();
    g.moveTo(-14, y);
    g.quadraticCurveTo(0, y + 3, 14, y);
    g.stroke();
  }
  g.strokeStyle = withAlpha(shadeOf(color, 0.5), 0.6);
  g.lineWidth = 1.3;
  g.beginPath();
  g.moveTo(0, -38);
  g.lineTo(0, -8);
  g.stroke();
  for (const y of [-32, -25, -18, -11]) {
    g.fillStyle = '#fff4dc';
    g.beginPath();
    g.arc(2.4, y, 0.95, 0, TAU);
    g.fill();
  }
  // Collar and a straw-stuffed neck where a head should be: it is obviously a dummy up close.
  fillRounded(g, -7.5, -41.5, 15, 5.4, 2.6, shadeOf(color, 0.14));

  if (level >= 1) {
    // A stitched patch first, then a tear with stuffing spilling out.
    fillRounded(g, -11, -20, 7, 6.5, 1, mix(color, '#fff0cc', 0.55));
    g.strokeStyle = withAlpha('#ffffff', 0.9);
    g.lineWidth = 0.6;
    g.setLineDash([1.5, 1.2]);
    g.beginPath();
    roundedRect(g, -11, -20, 7, 6.5, 1);
    g.stroke();
    g.setLineDash([]);
  }
  if (level >= 2) {
    blob(g, 6.5, -21, 5.2, 3.6, rng, '#2e2a50', 0.2, 8);
    for (let i = 0; i < 7; i++) {
      blob(g, 6.5 + between(rng, -5, 5), -21 + between(rng, -3.4, 5), between(rng, 1.6, 2.8), between(rng, 1.3, 2.2), rng, i % 3 ? '#fff6e8' : '#e8ddf2', 0.2, 6);
    }
    bite(g, -13, -9, 5, 4, rng, lo);
  }

  // Bobble hat on the handle, tipped jauntily, or badly when knocked about.
  g.save();
  g.translate(0, -44);
  g.rotate(level === 2 ? 0.46 : level === 1 ? 0.24 : 0.1);
  g.beginPath();
  g.moveTo(-9.5, 1);
  g.quadraticCurveTo(-9, -12, 0, -12.5);
  g.quadraticCurveTo(9, -12, 9.5, 1);
  g.closePath();
  g.fillStyle = orb(g, 0, -5, 12, [hi, color, lo]);
  g.fill();
  g.strokeStyle = withAlpha(lo, 0.55);
  g.lineWidth = 1;
  g.beginPath();
  g.moveTo(-4, -11);
  g.quadraticCurveTo(-5.4, -5, -4.6, 0);
  g.moveTo(4, -11);
  g.quadraticCurveTo(5.4, -5, 4.6, 0);
  g.stroke();
  fillRounded(g, -10.5, -1, 21, 5.2, 2.6, linear(g, 0, -1, 0, 4, ['#fffaf0', '#e4dcf0']));
  g.beginPath();
  g.arc(0, -14, 4.2, 0, TAU);
  g.fillStyle = orb(g, 0, -14, 4.4, ['#fffdf6', '#ece5f5', '#c9c2e4']);
  g.fill();
  g.restore();
  g.restore();
  if (level >= 1) rubble(g, level * 2, rng, '#ffffff');
}

// ---- spoon flinger ----------------------------------------------------------

export const PULT_PIVOT = { x: 20, y: 8 };
export const PULT_ARM = { cocked: Math.PI - 0.16, fired: Math.PI * 1.5 + 0.62 };

function paintPultBody(g, color, level, rng) {
  const by = CELL - 3;
  snowBank(g, 0, CELL, by + 2, 4, rng, { step: 10 });

  // Far upright.
  g.strokeStyle = shadeOf(P.wood, 0.3);
  g.lineWidth = 4;
  g.beginPath();
  g.moveTo(11, by - 12);
  g.lineTo(PULT_PIVOT.x - 3, PULT_PIVOT.y - 1);
  g.lineTo(29, by - 12);
  g.stroke();

  // Sled-runner chassis: a good look for something built by kids out of what was in the shed.
  fillRounded(g, 2, by - 15, 36, 9, 3, linear(g, 0, by - 15, 0, by - 6, [P.woodLight, P.wood]));
  g.strokeStyle = withAlpha(P.woodDark, 0.5);
  g.lineWidth = 0.9;
  for (let x = 8; x < 36; x += 7) {
    g.beginPath();
    g.moveTo(x, by - 14);
    g.lineTo(x + between(rng, -0.5, 0.5), by - 7);
    g.stroke();
  }
  g.strokeStyle = '#8590b6';
  g.lineWidth = 2.6;
  g.beginPath();
  g.moveTo(2, by - 2);
  g.lineTo(32, by - 2);
  g.quadraticCurveTo(40, by - 2, 38, by - 9);
  g.stroke();
  for (const x of [9, 28]) {
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(x, by - 7);
    g.lineTo(x, by - 2);
    g.stroke();
  }

  // Near upright in front of the arm's pivot, with team-coloured wrapping.
  g.strokeStyle = P.wood;
  g.lineWidth = 4.4;
  g.beginPath();
  g.moveTo(9, by - 9);
  g.lineTo(PULT_PIVOT.x, PULT_PIVOT.y);
  g.lineTo(31, by - 9);
  g.stroke();
  g.strokeStyle = withAlpha(P.woodLight, 0.8);
  g.lineWidth = 1.4;
  g.beginPath();
  g.moveTo(8, by - 9.5);
  g.lineTo(PULT_PIVOT.x - 1, PULT_PIVOT.y - 1);
  g.stroke();
  fillRounded(g, 13, 19, 14, 4.6, 2, color);
  fillRounded(g, 13, 19, 14, 1.6, 0.8, withAlpha('#ffffff', 0.4));

  // Rubber band of a rope that powers the thing.
  g.strokeStyle = '#e6d6b4';
  g.lineWidth = 1.2;
  g.beginPath();
  g.moveTo(PULT_PIVOT.x - 7, by - 12);
  g.lineTo(PULT_PIVOT.x + 2, PULT_PIVOT.y + 3);
  g.stroke();

  if (level >= 1) {
    crackLine(g, jagged(30, by - 14, 33, by - 7, rng, 3, 1.4), P.woodDark, 'rgba(255,240,210,0.6)', 1.2);
    fillRounded(g, 24, by - 16, 8, 2.2, 1, '#b9a57e');
    if (level >= 2) {
      crackLine(g, jagged(12, by - 13, 21, 15, rng, 4, 1.6), P.woodDark, 'rgba(255,240,210,0.6)', 1.5);
      bite(g, 3, by - 11, 4, 4, rng, P.woodDark);
      for (let i = 0; i < 4; i++) {
        const x = between(rng, 4, 34);
        const y = between(rng, by, by + 4);
        taperedStroke(g, x, y, x + between(rng, 3, 7), y + between(rng, -2, 2), 1.4, 0.6, 0, P.wood);
      }
    }
  }
}

// The arm is its own sprite so it can pivot. Pivot at origin, spoon along +x.
function paintPultArm(g, loaded, rng) {
  taperedStroke(g, -4, 0, 25, 0, 4.4, 3, 0.5, P.woodLight);
  g.fillStyle = linear(g, 0, -2, 0, 2, [withAlpha('#ffffff', 0.45), withAlpha('#ffffff', 0)]);
  g.fillRect(-3, -2, 26, 1.4);
  g.beginPath();
  g.ellipse(31, 0, 9.4, 6.4, 0, 0, TAU);
  g.fillStyle = orb(g, 31, 0, 9.6, [P.woodLight, P.wood, P.woodDark]);
  g.fill();
  g.beginPath();
  g.ellipse(31.6, 0, 6.6, 4, 0, 0, TAU);
  g.fillStyle = shadeOf(P.wood, 0.3);
  g.fill();
  g.fillStyle = P.woodDark;
  g.beginPath();
  g.arc(0, 0, 2.7, 0, TAU);
  g.fill();
  g.fillStyle = P.woodLight;
  g.beginPath();
  g.arc(-0.4, -0.5, 1.1, 0, TAU);
  g.fill();
  if (loaded) {
    g.beginPath();
    closedCurve(g, blobPoints(31.4, -1.5, 5.6, 5.3, rng, 0.06, 9));
    g.fillStyle = orb(g, 31.4, -1.5, 6, ['#ffffff', '#eaeefb', '#a9acdf', '#8588cc']);
    g.fill();
  }
}

// ---- cocoa stand ------------------------------------------------------------

function paintCocoa(g, color, level, rng) {
  const by = CELL - 1;
  const counterY = 12;

  // Warm back wall, seen between the awning posts.
  g.fillStyle = linear(g, 0, -22, 0, counterY, ['#6a3f3c', '#a35f42', '#e9a35a']);
  fillRounded(g, 4, -24, 32, counterY + 26, 2, g.fillStyle);
  for (let i = 0; i < 3; i++) {
    fillRounded(g, 8 + i * 9, -8, 5, 8, 1.4, ['#e8e0ff', '#ffe6c2', '#d0ecf8'][i]);
    g.strokeStyle = withAlpha('#ffffff', 0.5);
    g.lineWidth = 0.7;
    g.beginPath();
    g.arc(13.5 + i * 9, -4.5, 1.6, -1.2, 1.2);
    g.stroke();
  }

  // Counter.
  g.fillStyle = linear(g, 0, counterY, 0, by, [P.woodLight, P.wood, P.woodDark]);
  fillRounded(g, 2, counterY, 36, by - counterY, [1, 1, 3, 3], g.fillStyle);
  g.strokeStyle = withAlpha(P.woodDark, 0.5);
  g.lineWidth = 0.9;
  for (let x = 8; x < 36; x += 6.6) {
    g.beginPath();
    g.moveTo(x, counterY + 3);
    g.lineTo(x + between(rng, -0.4, 0.4), by - 1);
    g.stroke();
  }
  fillRounded(g, 0, counterY - 3, 40, 4.6, 1.6, linear(g, 0, counterY - 3, 0, counterY + 2, ['#e8c090', P.woodLight]));

  // Pot and a stack of cups. The pot's lid is the one thing players should spot from afar.
  g.beginPath();
  g.moveTo(11, counterY - 2.4);
  g.quadraticCurveTo(8.5, counterY - 12, 13.5, counterY - 13.5);
  g.lineTo(23.5, counterY - 13.5);
  g.quadraticCurveTo(28, counterY - 12, 26, counterY - 2.4);
  g.closePath();
  g.fillStyle = linear(g, 8, 0, 28, 0, ['#fff3e4', '#efdcd4', '#c6b0c8']);
  g.fill();
  g.fillStyle = '#7a4b38';
  g.beginPath();
  g.ellipse(18.5, counterY - 13.5, 5.6, 1.9, 0, 0, TAU);
  g.fill();
  fillRounded(g, 30, counterY - 8, 6, 5.6, 1.2, P.red);
  fillRounded(g, 30, counterY - 8.6, 6, 1.6, 0.8, '#7a4b38');

  // Sign on the counter's face: a big mug, the universal language of being warmed up.
  g.beginPath();
  g.arc(20, counterY + 13, 8.4, 0, TAU);
  g.fillStyle = '#fff5e6';
  g.fill();
  fillRounded(g, 15.4, counterY + 8.6, 8.4, 8.6, [1, 1, 2.8, 2.8], color);
  g.strokeStyle = color;
  g.lineWidth = 1.4;
  g.beginPath();
  g.arc(24.4, counterY + 12.4, 2.6, -1.2, 1.3);
  g.stroke();
  fillRounded(g, 16.2, counterY + 8.6, 6.8, 1.8, 0.9, '#7a4b38');

  // Posts and awning.
  for (const x of [3, 37]) fillRounded(g, x - 1.6, -24, 3.2, 38, 1.2, linear(g, x - 2, 0, x + 2, 0, [P.woodLight, P.woodDark]));
  const top = -36;
  const low = -19;
  g.beginPath();
  g.moveTo(5, top);
  g.lineTo(35, top);
  g.lineTo(43, low);
  g.lineTo(-3, low);
  g.closePath();
  g.save();
  g.clip();
  const bands = 7;
  for (let i = 0; i < bands; i++) {
    const a0 = lerp(-3, 43, i / bands);
    const a1 = lerp(-3, 43, (i + 1) / bands);
    const b0 = lerp(5, 35, i / bands);
    const b1 = lerp(5, 35, (i + 1) / bands);
    g.beginPath();
    g.moveTo(b0, top);
    g.lineTo(b1, top);
    g.lineTo(a1, low);
    g.lineTo(a0, low);
    g.closePath();
    g.fillStyle = i % 2 ? '#fff4e0' : color;
    g.fill();
  }
  g.fillStyle = linear(g, 0, top, 0, low, [withAlpha('#ffffff', 0.22), withAlpha('#4a3f90', 0.2)]);
  g.fillRect(-3, top, 46, low - top);
  g.restore();
  // Scalloped valance.
  const n = 7;
  for (let i = 0; i < n; i++) {
    const x = lerp(-3, 43, (i + 0.5) / n);
    g.beginPath();
    g.arc(x, low, 46 / n / 2, 0, Math.PI);
    g.closePath();
    g.fillStyle = i % 2 ? '#f0e2cc' : shadeOf(color, 0.12);
    g.fill();
  }
  snowCap(g, 5, 35, top + 5, 7.5, rng, { droop: 2.6 });

  if (level >= 1) {
    // A torn scallop and a knocked-over cup: damage that still looks kid-friendly.
    bite(g, 40, low + 2, 5, 5, rng, shadeOf(color, 0.35));
    crackLine(g, jagged(30, counterY + 2, 34, by - 2, rng, 4, 1.6), P.woodDark, 'rgba(255,240,210,0.5)', 1.2);
    if (level >= 2) {
      crackLine(g, jagged(6, counterY + 4, 12, by - 1, rng, 5, 1.8), P.woodDark, 'rgba(255,240,210,0.5)', 1.6);
      bite(g, 5, top + 8, 6, 5, rng, shadeOf(color, 0.35));
      bite(g, 2, by - 2, 5, 5, rng, P.woodDark);
      for (let i = 0; i < 4; i++) {
        const x = between(rng, 2, 38);
        taperedStroke(g, x, by + 1, x + between(rng, 3, 7), by + between(rng, 0, 4), 1.5, 0.7, 0, P.wood);
      }
    }
  }
  snowBank(g, -2, CELL + 2, by + 2.5, 4, rng, { step: 9 });
}

// ---- slick ------------------------------------------------------------------

// A polished sheet lying flat on the snow: no highlight on its middle, which would make it a ball.
function paintSlick(g, level, variant, rng) {
  const inset = 1.5 + level * 2.5;
  const n = 14;
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU + 0.2;
    const c = Math.cos(a);
    const sn = Math.sin(a);
    // Superellipse: fills its cell like a spill, so neighbouring Slick cells nearly touch.
    const k = Math.pow(Math.pow(Math.abs(c), 3.2) + Math.pow(Math.abs(sn), 3.2), -1 / 3.2);
    const r = (CELL / 2 - inset) * k * between(rng, 0.94, 1.04);
    pts.push([CELL / 2 + c * r, CELL / 2 + sn * r]);
  }
  g.save();
  g.translate(0.5, 1.8);
  g.beginPath();
  closedCurve(g, pts);
  g.fillStyle = 'rgba(110,120,200,0.4)';
  g.fill();
  g.restore();
  g.beginPath();
  closedCurve(g, pts);
  g.fillStyle = linear(g, 0, 0, CELL, CELL, ['#d6f3fb', '#a4dff2', '#8fd0ec']);
  g.fill();
  g.save();
  g.clip();
  // Reflected sky in long parallel bands, always on the same diagonal: flatness comes from this.
  const off = variant & 1 ? 6 : 0;
  for (const [t, w, a] of [[0.24, 5, 0.75], [0.46, 2, 0.55], [0.72, 7, 0.5]]) {
    const y = CELL * t + off;
    g.strokeStyle = withAlpha('#ffffff', a);
    g.lineWidth = w;
    g.beginPath();
    g.moveTo(-8, y + 16);
    g.lineTo(CELL + 8, y - 16);
    g.stroke();
  }
  softEllipse(g, CELL * 0.74, CELL * 0.78, 16, 9, '#5fb0e0', 0.4, -0.4);
  if (level >= 1) {
    crackLine(g, jagged(6, 12, 30, 28, rng, 4, 3), 'rgba(255,255,255,0.95)', 'rgba(60,120,190,0.35)', 1.2);
    if (level >= 2) {
      crackLine(g, jagged(30, 8, 12, 32, rng, 5, 3), 'rgba(255,255,255,0.95)', 'rgba(60,120,190,0.35)', 1.4);
      crackLine(g, jagged(4, 26, 20, 16, rng, 3, 2.4), 'rgba(255,255,255,0.95)', 'rgba(60,120,190,0.35)', 1);
    }
  }
  g.restore();
  // Frosted rim where it meets the snow.
  g.beginPath();
  closedCurve(g, pts);
  g.strokeStyle = withAlpha('#ffffff', 0.9);
  g.lineWidth = 1.4;
  g.stroke();
}

// ---- registry ---------------------------------------------------------------

const RISE_BOX = 62;

export function structSprite(bank, kind, team, mask, level, variant) {
  const color = teamColor(team);
  switch (kind) {
    case STRUCT.WALL: {
      const key = `st|w|${mask}|${level}|${variant}`;
      return bank.get(key, { x: -1, y: -32, w: CELL + 2, h: CELL + 38 }, (g) => paintWall(g, mask, level, variant, makeRng(hashString(key))));
    }
    case STRUCT.ICEWALL: {
      const key = `st|i|${mask}|${level}|${variant}`;
      return bank.get(key, { x: -1, y: -36, w: CELL + 2, h: CELL + 42 }, (g) => paintIceWall(g, mask, level, variant, makeRng(hashString(key))));
    }
    case STRUCT.DECOY: {
      const key = `st|d|${color}|${level}`;
      return bank.get(key, { x: -10, y: -40, w: CELL + 20, h: CELL + 48 }, (g) => paintDecoy(g, color, level, makeRng(hashString(key))));
    }
    case STRUCT.PULT: {
      const key = `st|p|${color}|${level}`;
      return bank.get(key, { x: -4, y: -6, w: CELL + 8, h: CELL + 14 }, (g) => paintPultBody(g, color, level, makeRng(hashString(key))));
    }
    case STRUCT.COCOA: {
      const key = `st|c|${color}|${level}`;
      return bank.get(key, { x: -6, y: -46, w: CELL + 12, h: CELL + 54 }, (g) => paintCocoa(g, color, level, makeRng(hashString(key))));
    }
    case STRUCT.SLICK: {
      const key = `st|s|${level}|${variant}`;
      return bank.get(key, { x: -3, y: -3, w: CELL + 8, h: CELL + 8 }, (g) => paintSlick(g, level, variant, makeRng(hashString(key))));
    }
    default: {
      // Unknown kinds render as a plain block instead of throwing: the sim may get ahead of the art.
      const key = 'st|unknown';
      return bank.get(key, { x: 0, y: -RISE_BOX / 2, w: CELL, h: CELL + RISE_BOX / 2 }, (g) => fillRounded(g, 2, -24, CELL - 4, CELL + 22, 6, P.stone));
    }
  }
}

export function pultArmSprite(bank, loaded) {
  const key = `st|arm|${loaded ? 1 : 0}`;
  return bank.get(key, { x: -8, y: -10, w: 52, h: 20 }, (g) => paintPultArm(g, loaded, makeRng(hashString(key))));
}

// Everything the renderer might need mid-fight, painted up front so the first time a wall cracks it
// costs one blit rather than a repaint inside a frame.
export function prewarmStructs(bank, teams) {
  for (let mask = 0; mask < 16; mask++) {
    for (let level = 0; level < 3; level++) {
      for (let v = 0; v < 2; v++) {
        structSprite(bank, STRUCT.WALL, 0, mask, level, v);
        structSprite(bank, STRUCT.ICEWALL, 0, mask, level, v);
      }
    }
  }
  for (let level = 0; level < 3; level++) {
    for (let v = 0; v < 2; v++) structSprite(bank, STRUCT.SLICK, 0, 0, level, v);
    for (const team of teams) {
      structSprite(bank, STRUCT.DECOY, team, 0, level, 0);
      structSprite(bank, STRUCT.PULT, team, 0, level, 0);
      structSprite(bank, STRUCT.COCOA, team, 0, level, 0);
    }
  }
  pultArmSprite(bank, true);
  pultArmSprite(bank, false);
}
