// Obstacle art: one painter per map obstacle type, plus the fallback block. Bake-time only.
//
// Painters work in world units with the origin at the footprint's top-left corner. Rect obstacles
// stand on the front edge of their footprint. Circle obstacles stand on the circle's centre, which is
// also their depth key, so trunks and posts line up with where a kid actually collides with them.
import { P } from './palette.js';
import {
  TAU, clamp, lerp, between, makeRng, hashString, mix, withAlpha, shadeOf, lightOf, linear, radial, orb,
  softEllipse, blurredFill, roundedRect, fillRounded, closedCurve, blobPoints, blob, taperedStroke, snowCap,
  snowBank, snowMound, snowRidge,
} from './paint.js';

const isCircle = (o) => o.shape === 'circle' || (o.r != null && o.w == null);

function footprint(o) {
  if (isCircle(o)) return { x: o.x - o.r, y: o.y - o.r, w: o.r * 2, h: o.r * 2, circle: true };
  return { x: o.x, y: o.y, w: o.w, h: o.h, circle: false };
}

export const obstacleDepth = (o) => (isCircle(o) ? o.y : o.y + o.h);

const isVertical = (o, w, h) => o.rot === 90 || h > w * 1.3;

// ---- shared details ---------------------------------------------------------

function icicles(g, x0, x1, y, rng, density = 0.09) {
  const n = Math.floor((x1 - x0) * density);
  for (let i = 0; i < n; i++) {
    const x = between(rng, x0, x1);
    const len = between(rng, 3, 8.5);
    const w = between(rng, 1, 1.9);
    g.beginPath();
    g.moveTo(x - w, y);
    g.quadraticCurveTo(x - w * 0.2, y + len * 0.6, x, y + len);
    g.quadraticCurveTo(x + w * 0.2, y + len * 0.6, x + w, y);
    g.closePath();
    g.fillStyle = linear(g, 0, y, 0, y + len, ['#ffffff', withAlpha('#bfe6f6', 0.75)]);
    g.fill();
  }
}

function paneWindow(g, x, y, w, h, rng, opts = {}) {
  const { frame = '#fff7ea', arch = false, lit = true, sill = true } = opts;
  const r = arch ? [w / 2, w / 2, 1.5, 1.5] : 1.8;
  fillRounded(g, x - 2, y - 2, w + 4, h + 4, Array.isArray(r) ? [w / 2 + 2, w / 2 + 2, 2, 2] : 2.6, frame);
  const glass = lit
    ? linear(g, 0, y, 0, y + h, ['#fff4c4', '#ffd877', '#ffb955'])
    : linear(g, x, y, x + w, y + h, ['#c7e2f4', '#8fb4dc', '#7b92cc']);
  fillRounded(g, x, y, w, h, r, glass);
  if (lit) {
    g.save();
    g.beginPath();
    roundedRect(g, x, y, w, h, r);
    g.clip();
    // Drawn curtains: a domestic detail that makes the house read as lived in from far away.
    g.fillStyle = withAlpha('#e88f6a', 0.55);
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x + w * 0.42, y);
    g.quadraticCurveTo(x + w * 0.2, y + h * 0.4, x, y + h * 0.72);
    g.closePath();
    g.moveTo(x + w, y);
    g.lineTo(x + w * 0.58, y);
    g.quadraticCurveTo(x + w * 0.8, y + h * 0.4, x + w, y + h * 0.72);
    g.closePath();
    g.fill();
    g.restore();
  } else {
    g.strokeStyle = withAlpha('#ffffff', 0.55);
    g.lineWidth = 1.1;
    g.beginPath();
    g.moveTo(x + w * 0.2, y + h * 0.75);
    g.lineTo(x + w * 0.55, y + h * 0.2);
    g.stroke();
  }
  g.strokeStyle = frame;
  g.lineWidth = 1.5;
  g.beginPath();
  g.moveTo(x + w / 2, y);
  g.lineTo(x + w / 2, y + h);
  g.moveTo(x, y + h * 0.5);
  g.lineTo(x + w, y + h * 0.5);
  g.stroke();
  if (sill) snowCap(g, x - 3.5, x + w + 3.5, y + h + 2.6, 3, rng, { droop: 1.5, lumps: 3 });
}

function frontDoor(g, x, y, w, h, color, rng) {
  fillRounded(g, x - 2.4, y - 2.4, w + 4.8, h + 2.4, [w / 2.4, w / 2.4, 0, 0], '#fff7ea');
  fillRounded(g, x, y, w, h, [w / 2.8, w / 2.8, 0, 0], linear(g, x, y, x + w, y + h, [lightOf(color, 0.14), color, shadeOf(color, 0.22)]));
  fillRounded(g, x + w * 0.2, y + h * 0.52, w * 0.6, h * 0.34, 1.4, withAlpha(shadeOf(color, 0.4), 0.45));
  g.fillStyle = P.gold;
  g.beginPath();
  g.arc(x + w * 0.82, y + h * 0.56, 1.1, 0, TAU);
  g.fill();
  // Wreath with a bow: tiny, but saturated, and it pulls the eye to the door.
  const cx = x + w / 2;
  const cy = y + h * 0.3;
  const rr = w * 0.24;
  g.lineWidth = rr * 0.62;
  g.strokeStyle = P.pine;
  g.beginPath();
  g.arc(cx, cy, rr, 0, TAU);
  g.stroke();
  for (let i = 0; i < 6; i++) {
    const a = rng() * TAU;
    g.fillStyle = i % 2 ? '#e24a55' : P.pineLight;
    g.beginPath();
    g.arc(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr, 0.7, 0, TAU);
    g.fill();
  }
  g.fillStyle = '#e24a55';
  g.beginPath();
  g.ellipse(cx, cy + rr, 2, 1.1, 0, 0, TAU);
  g.fill();
}

function chimney(g, x, y, w, h, rng) {
  g.fillStyle = linear(g, x, 0, x + w, 0, [lightOf(P.brick, 0.18), P.brick, shadeOf(P.brick, 0.35)]);
  g.beginPath();
  roundedRect(g, x, y, w, h, 1.5);
  g.fill();
  g.strokeStyle = withAlpha(P.brickDark, 0.5);
  g.lineWidth = 0.8;
  for (let yy = y + 4, row = 0; yy < y + h; yy += 4, row++) {
    g.beginPath();
    g.moveTo(x, yy);
    g.lineTo(x + w, yy);
    for (let xx = x + (row % 2 ? 3 : 6); xx < x + w; xx += 7) {
      g.moveTo(xx, yy);
      g.lineTo(xx, yy + 4);
    }
    g.stroke();
  }
  fillRounded(g, x - 1.6, y - 1, w + 3.2, 3.2, 1.2, mix(P.brick, '#d9c7bb', 0.5));
  snowCap(g, x - 2.5, x + w + 2.5, y - 0.8, 5.5, rng, { droop: 1.5, lumps: 3 });
}

// Scalloped shingle rows. Cheap, and they stop the visible strip of roof looking like a flat band.
function shingles(g, x0, x1, y0, y1, color, step = 6) {
  g.strokeStyle = withAlpha(shadeOf(color, 0.45), 0.5);
  g.lineWidth = 0.9;
  for (let y = y0, row = 0; y < y1; y += step, row++) {
    g.beginPath();
    for (let x = x0 - (row % 2 ? step : 0); x < x1; x += step * 2) {
      g.moveTo(x, y);
      g.quadraticCurveTo(x + step, y + step * 0.9, x + step * 2, y);
    }
    g.stroke();
  }
}

// ---- house ------------------------------------------------------------------

const SIDING = ['#e9b4a2', '#efd199', '#a8cdb6', '#a7c6e6', '#cbb2e2', '#e7a581'];
const ROOF = ['#6d5a98', '#4e7c8e', '#a2534f', '#566ba0', '#7c5f86', '#3f7e78'];
const DOORS = ['#3f7e78', '#b8434e', '#5a62a8', '#a8603d', '#3f7e78', '#6d4c8a'];

function houseMetrics(w, h) {
  const wallH = clamp(h * 0.44, 46, 74);
  return { wallH, eaveY: h - wallH, ridgeY: h - wallH - clamp(h * 0.72, 66, 124) };
}

// Door and window placement, shared by the painter and the night lights so that a glow always lands
// on the glass it belongs to.
function houseFront(w, h, v) {
  const { eaveY } = houseMetrics(w, h);
  const wallTall = h - eaveY;
  const doorH = clamp(wallTall * 0.74, 30, 46);
  const doorW = doorH * 0.56;
  const doorX = w * (v % 3 === 1 ? 0.28 : v % 3 === 2 ? 0.66 : 0.47) - doorW / 2;
  const winH = clamp(wallTall * 0.42, 18, 26);
  const winW = winH * 0.88;
  const winY = eaveY + wallTall * 0.2;
  const panes = windowColumns(w, doorX, doorW, winW).map((cx) => ({ x: cx - winW / 2, y: winY, w: winW, h: winH }));
  return { doorX, doorW, doorH, panes };
}

function dormerSpots(w, v) {
  const n = w >= 260 ? 2 : w >= 200 ? 1 : 0;
  const out = [];
  for (let i = 0; i < n; i++) out.push(n === 1 ? (v % 2 ? 0.66 : 0.34) : (i ? 0.72 : 0.3));
  return out;
}

function houseFacing(g, w, h, o, rng) {
  const v = (o.variant || 0) % SIDING.length;
  const side = SIDING[v];
  const roof = ROOF[v];
  const { eaveY, ridgeY } = houseMetrics(w, h);
  const over = 8;

  // Front wall.
  g.fillStyle = linear(g, 0, eaveY, 0, h, [mix(side, '#6a6aa8', 0.26), lightOf(side, 0.1), side]);
  g.fillRect(0, eaveY, w, h - eaveY);
  g.strokeStyle = withAlpha(shadeOf(side, 0.5), 0.26);
  g.lineWidth = 0.9;
  for (let y = eaveY + 9; y < h; y += 6.5) {
    g.beginPath();
    g.moveTo(0, y);
    g.lineTo(w, y);
    g.stroke();
  }
  const trim = '#fff7ea';
  g.fillStyle = trim;
  g.fillRect(0, eaveY, 3, h - eaveY);
  g.fillRect(w - 3, eaveY, 3, h - eaveY);
  // The right side of the wall falls away from the light.
  g.fillStyle = linear(g, w * 0.55, 0, w, 0, [withAlpha('#5a5aa0', 0), withAlpha('#5a5aa0', 0.2)]);
  g.fillRect(0, eaveY, w, h - eaveY);

  const front = houseFront(w, h, v);
  frontDoor(g, front.doorX, h - front.doorH, front.doorW, front.doorH, DOORS[v], rng);
  for (const p of front.panes) paneWindow(g, p.x, p.y, p.w, p.h, rng);

  // Roof: a coloured trapezoid mostly hidden by its blanket of snow.
  const inset = 10;
  g.beginPath();
  g.moveTo(-over, eaveY + 3);
  g.lineTo(inset, ridgeY);
  g.lineTo(w - inset, ridgeY);
  g.lineTo(w + over, eaveY + 3);
  g.closePath();
  g.fillStyle = linear(g, 0, ridgeY, 0, eaveY, [lightOf(roof, 0.14), roof, shadeOf(roof, 0.2)]);
  g.fill();
  g.save();
  g.clip();
  shingles(g, -over, w + over, eaveY - 26, eaveY + 4, roof);
  g.restore();

  // Fascia board: a warm line under the snow that separates roof from wall in any light.
  fillRounded(g, -over - 1, eaveY + 1.5, w + over * 2 + 2, 4, 1.6, mix(trim, roof, 0.18));
  blanket(g, -over + 3, w + over - 3, inset + 1, w - inset - 1, ridgeY, eaveY, rng);
  icicles(g, -over + 3, w + over - 3, eaveY + 5, rng);

  // Eaves shade the top of the wall.
  g.fillStyle = linear(g, 0, eaveY + 5, 0, eaveY + 14, [withAlpha('#50508e', 0.34), withAlpha('#50508e', 0)]);
  g.fillRect(0, eaveY + 5, w, 9);

  snowCap(g, inset - 6, w - inset + 6, ridgeY + 3, 8.5, rng, { droop: 3 });

  // Roof furniture breaks up the big white plane and gives the building its silhouette.
  for (const t of dormerSpots(w, v)) dormer(g, w * t, lerp(ridgeY, eaveY, 0.58), side, roof, rng);
  const chim = chimneyAt(v, w, ridgeY);
  chimney(g, chim.x, chim.y, 16, 34, rng);
  // Snow drifted up against the chimney's foot.
  blob(g, chim.x + 8, chim.y + 33, 16, 6, rng, '#fbfcff', 0.14, 9);
  snowBank(g, -8, w + 8, h + 2, 11, rng);
}

function chimneyAt(v, w, ridgeY) {
  return { x: w * (v % 2 ? 0.2 : 0.74), y: ridgeY - 14 };
}

function dormer(g, cx, y, side, roof, rng) {
  const w = 34;
  const h = 22;
  const x = cx - w / 2;
  softEllipse(g, cx + 8, y + h + 2, w * 0.8, 9, '#8b8ccc', 0.5);
  fillRounded(g, x, y, w, h, 2, linear(g, 0, y, 0, y + h, [lightOf(side, 0.1), side]));
  paneWindow(g, cx - 9, y + 5, 18, 14, rng, { sill: false });
  g.beginPath();
  g.moveTo(x - 6, y + 3);
  g.lineTo(cx, y - 15);
  g.lineTo(x + w + 6, y + 3);
  g.closePath();
  g.fillStyle = roof;
  g.fill();
  // A little snow roof of its own.
  g.beginPath();
  closedCurve(g, [[x - 7, y + 3.5], [cx - 8, y - 9], [cx, y - 18], [cx + 8, y - 9], [x + w + 7, y + 3.5], [cx + 8, y - 2], [cx, y - 8], [cx - 8, y - 2]]);
  g.fillStyle = linear(g, x, y - 16, x + w, y + 3, ['#ffffff', '#e5e9f8']);
  g.fill();
  blob(g, cx, y + h + 2.5, w * 0.6, 5, rng, '#fbfcff', 0.12, 8);
}

function windowColumns(w, doorX, doorW, winW) {
  const cols = [];
  const gap = winW + 14;
  const left = doorX - 9;
  const right = doorX + doorW + 9;
  for (let x = left - winW / 2 - 4; x > 9 + winW / 2; x -= gap) cols.push(x);
  for (let x = right + winW / 2 + 4; x < w - 9 - winW / 2; x += gap) cols.push(x);
  return cols;
}

// A thick quilt of snow on a sloped plane, with drips at its lower lip and shingles left showing.
function blanket(g, xb0, xb1, xt0, xt1, yt, yb, rng) {
  const pts = [];
  const lip = yb - 7;
  const nTop = Math.max(4, Math.round((xt1 - xt0) / 34));
  for (let i = 0; i <= nTop; i++) pts.push([lerp(xt0, xt1, i / nTop), yt - between(rng, 0, 3)]);
  pts.push([lerp(xt1, xb1, 0.55), lerp(yt, lip, 0.55)]);
  pts.push([xb1 + 1, lip]);
  const nLip = Math.max(6, Math.round((xb1 - xb0) / 13));
  for (let i = nLip; i >= 0; i--) {
    const x = lerp(xb0, xb1, i / nLip);
    const dip = i % 2 ? between(rng, 3.5, 11) : between(rng, -3.5, 2);
    pts.push([x, lip + dip]);
  }
  pts.push([lerp(xt0, xb0, 0.55), lerp(yt, lip, 0.55)]);
  g.save();
  g.translate(0, 2.2);
  g.beginPath();
  closedCurve(g, pts);
  g.fillStyle = withAlpha('#7f7cc0', 0.5);
  g.fill();
  g.restore();
  g.beginPath();
  closedCurve(g, pts);
  g.fillStyle = linear(g, xb0, yt, xb1, yb, [[0, '#ffffff'], [0.5, '#f4f7ff'], [1, '#d7dff4']]);
  g.fill();
  g.save();
  g.clip();
  // Soft pools of lilac where the blanket dips: this is what keeps a big white roof from going flat.
  for (let i = 0; i < 7; i++) {
    softEllipse(g, between(rng, xb0, xb1), between(rng, yt + 8, yb), between(rng, 26, 60), between(rng, 7, 15), '#aeb0e2', 0.3);
  }
  softEllipse(g, lerp(xt0, xb0, 0.3) + 30, lerp(yt, yb, 0.3), 80, 24, '#ffffff', 0.9);
  g.restore();
}

function houseGable(g, w, h, o, rng) {
  const v = (o.variant || 0) % SIDING.length;
  const side = SIDING[v];
  const roof = ROOF[v];
  const wallH = clamp(w * 0.34, 42, 62);
  const eaveY = h - wallH;
  const gableH = clamp(w * 0.34, 34, 62);
  const peakY = eaveY - gableH;
  const back = clamp(h * 0.52, 50, 96);
  const over = 8;
  const mid = w / 2;

  // Far halves of the two roof planes, bright on the sun side and lilac on the shade side.
  const plane = (x0, fill) => {
    g.beginPath();
    g.moveTo(x0, eaveY + 4);
    g.lineTo(mid, peakY);
    g.lineTo(mid, peakY - back);
    g.lineTo(x0, eaveY + 4 - back);
    g.closePath();
    g.fillStyle = fill;
    g.fill();
  };
  plane(-over, linear(g, -over, 0, mid, 0, [roof, lightOf(roof, 0.15)]));
  plane(w + over, linear(g, mid, 0, w + over, 0, [roof, shadeOf(roof, 0.3)]));
  // Snow quilts on each plane, each with a drip line toward the eave.
  const quilt = (x0, top, low) => {
    const pts = [];
    pts.push([mid, peakY - back - 3]);
    pts.push([mid, peakY + 2]);
    const steps = 6;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      pts.push([lerp(mid, x0, t), lerp(peakY + 2, eaveY - 2, t) + (i % 2 ? between(rng, 2, 6) : 0)]);
    }
    pts.push([x0 + (x0 < mid ? 4 : -4), eaveY - back]);
    const up = 4;
    for (let i = 1; i < up; i++) {
      const t = i / up;
      pts.push([lerp(x0, mid, t) + (x0 < mid ? 2 : -2), lerp(eaveY - back - 3, peakY - back - 3, t) - between(rng, 0, 2.5)]);
    }
    g.beginPath();
    closedCurve(g, pts);
    g.fillStyle = linear(g, x0, peakY - back, mid, eaveY, [top, low]);
    g.fill();
  };
  quilt(-over + 3, '#ffffff', '#f2f6fe');
  quilt(w + over - 3, '#dfe3f6', '#c2c6ea');
  g.fillStyle = withAlpha('#ffffff', 0.9);
  g.beginPath();
  g.moveTo(mid - 3, peakY - back - 3);
  g.lineTo(mid + 3, peakY - back - 3);
  g.lineTo(mid + 3, peakY + 3);
  g.lineTo(mid - 3, peakY + 3);
  g.closePath();
  g.fill();
  chimney(g, w * 0.66, peakY - back * 0.72 - 6, 16, 32, rng);
  blob(g, w * 0.66 + 8, peakY - back * 0.72 + 25, 15, 5.5, rng, '#e2e5f7', 0.14, 9);

  // Gable wall.
  g.beginPath();
  g.moveTo(0, h);
  g.lineTo(0, eaveY);
  g.lineTo(mid, peakY + 3);
  g.lineTo(w, eaveY);
  g.lineTo(w, h);
  g.closePath();
  g.fillStyle = linear(g, 0, peakY, 0, h, [mix(side, '#6a6aa8', 0.2), lightOf(side, 0.1), side]);
  g.fill();
  g.save();
  g.clip();
  g.strokeStyle = withAlpha(shadeOf(side, 0.5), 0.26);
  g.lineWidth = 0.9;
  for (let y = peakY + 10; y < h; y += 6.5) {
    g.beginPath();
    g.moveTo(0, y);
    g.lineTo(w, y);
    g.stroke();
  }
  g.fillStyle = linear(g, w * 0.55, 0, w, 0, [withAlpha('#5a5aa0', 0), withAlpha('#5a5aa0', 0.2)]);
  g.fillRect(0, peakY, w, h - peakY);
  g.restore();

  // Rake boards with the snow lip sitting on them.
  g.strokeStyle = mix('#fff7ea', roof, 0.2);
  g.lineWidth = 4;
  g.beginPath();
  g.moveTo(-over, eaveY + 4);
  g.lineTo(mid, peakY + 1);
  g.lineTo(w + over, eaveY + 4);
  g.stroke();
  icicles(g, -over + 2, 6, eaveY + 7, rng, 0.25);
  icicles(g, w - 6, w + over - 2, eaveY + 7, rng, 0.25);

  const doorH = clamp(wallH * 0.76, 30, 44);
  const doorW = doorH * 0.56;
  frontDoor(g, w * 0.5 - doorW / 2, h - doorH, doorW, doorH, DOORS[v], rng);
  const winH = clamp(wallH * 0.42, 16, 24);
  const winW = winH * 0.86;
  paneWindow(g, w * 0.2 - winW / 2, eaveY + 6, winW, winH, rng);
  paneWindow(g, w * 0.8 - winW / 2, eaveY + 6, winW, winH, rng);
  paneWindow(g, mid - 8, peakY + gableH * 0.42, 16, 16, rng, { arch: true, sill: false });
  snowBank(g, -8, w + 8, h + 2, 11, rng);
}

function paintHouse(g, w, h, o, rng) {
  if (o.rot === 90) houseGable(g, w, h, o, rng);
  else houseFacing(g, w, h, o, rng);
}

// ---- trees ------------------------------------------------------------------

function paintPine(g, w, h, o, rng) {
  const r = Math.min(w, h) / 2;
  const cx = w / 2;
  const by = h / 2;
  const tall = r * between(rng, 4.1, 5);
  snowMound(g, cx, by + r * 0.1, r * 0.72, r * 0.3, rng);
  fillRounded(g, cx - r * 0.17, by - r * 0.95, r * 0.34, r * 1, r * 0.1, linear(g, cx - r * 0.17, 0, cx + r * 0.17, 0, ['#8f6650', '#634640']));

  const tiers = 5;
  for (let i = 0; i < tiers; i++) {
    const t = i / (tiers - 1);
    const skirtY = by - r * 0.42 - tall * 0.74 * t;
    const half = r * lerp(1.68, 0.58, Math.pow(t, 0.85)) * between(rng, 0.95, 1.05);
    const tierH = tall * lerp(0.34, 0.27, t);
    const apexY = skirtY - tierH;
    const lean = between(rng, -0.04, 0.04) * r;

    // Boughs.
    const bough = [[cx + lean, apexY]];
    bough.push([cx + half * 0.5, skirtY - tierH * 0.46]);
    bough.push([cx + half * 1.02, skirtY - tierH * 0.02]);
    const scallops = 5 + (i < 2 ? 2 : 0);
    for (let k = 1; k < scallops; k++) {
      const x = lerp(cx + half, cx - half, k / scallops);
      bough.push([x, skirtY + (k % 2 ? tierH * 0.15 : -tierH * 0.03) * between(rng, 0.7, 1.2)]);
    }
    bough.push([cx - half * 1.02, skirtY - tierH * 0.02]);
    bough.push([cx - half * 0.5, skirtY - tierH * 0.46]);
    g.beginPath();
    closedCurve(g, bough);
    g.fillStyle = linear(g, cx - half, apexY, cx + half, skirtY, [P.pineLight, P.pine, P.pineDark]);
    g.fill();

    // Thick dollops of snow along each tier, thin enough to leave a green lip showing.
    const cover = [[cx + lean, apexY - 1.2]];
    cover.push([cx + half * 0.45, skirtY - tierH * 0.56]);
    cover.push([cx + half * 0.86, skirtY - tierH * 0.2]);
    const dips = 5;
    for (let k = 1; k < dips; k++) {
      const x = lerp(cx + half * 0.86, cx - half * 0.86, k / dips);
      const y = skirtY - tierH * (k % 2 ? 0.06 : 0.3) * between(rng, 0.8, 1.2);
      cover.push([x, y]);
    }
    cover.push([cx - half * 0.86, skirtY - tierH * 0.2]);
    cover.push([cx - half * 0.45, skirtY - tierH * 0.56]);
    g.save();
    g.translate(0.6, 1.3);
    g.beginPath();
    closedCurve(g, cover);
    g.fillStyle = withAlpha('#17415a', 0.42);
    g.fill();
    g.restore();
    g.beginPath();
    closedCurve(g, cover);
    g.fillStyle = linear(g, cx - half * 0.7, apexY, cx + half * 0.8, skirtY, [[0, '#ffffff'], [0.55, '#f4f7ff'], [1, '#c8cfee']]);
    g.fill();
  }
  // A last tuft keeps the tip soft instead of a sharp point.
  blob(g, cx, by - r * 0.42 - tall * 0.74 - tall * 0.27, r * 0.28, r * 0.24, rng, '#ffffff', 0.1, 7);
}

function branchOut(g, x, y, ang, len, width, depth, rng, tips) {
  const ex = x + Math.cos(ang) * len;
  const ey = y + Math.sin(ang) * len;
  taperedStroke(g, x, y, ex, ey, width, width * 0.62, between(rng, -2, 2), '#6e5050');
  // Snow lies only on near-horizontal limbs, and that is the detail that says "cold".
  const flatness = Math.abs(Math.cos(ang));
  if (depth > 0 && flatness > 0.35) {
    taperedStroke(g, x, y - width * 0.45, ex, ey - width * 0.32, width * 0.5 * flatness + 0.3, width * 0.5 * flatness, 0, '#ffffff');
  }
  if (depth <= 0) {
    tips.push([ex, ey]);
    return;
  }
  const n = depth > 1 ? 3 : 2;
  for (let i = 0; i < n; i++) {
    const a = ang + (i - (n - 1) / 2) * between(rng, 0.42, 0.72) + between(rng, -0.12, 0.12);
    branchOut(g, ex, ey, a, len * between(rng, 0.62, 0.8), width * 0.62, depth - 1, rng, tips);
  }
}

function paintTree(g, w, h, o, rng) {
  const r = Math.min(w, h) / 2;
  const cx = w / 2;
  const by = h / 2;
  const v = (o.variant || 0) % 3;
  snowMound(g, cx, by + r * 0.1, r * 0.72, r * 0.3, rng);

  const tips = [];
  const trunkH = r * 1.7;
  g.fillStyle = linear(g, cx - r * 0.3, 0, cx + r * 0.3, 0, ['#8a6858', '#6e5050', '#54405a']);
  g.beginPath();
  g.moveTo(cx - r * 0.34, by + r * 0.05);
  g.quadraticCurveTo(cx - r * 0.2, by - trunkH * 0.5, cx - r * 0.17, by - trunkH);
  g.lineTo(cx + r * 0.17, by - trunkH);
  g.quadraticCurveTo(cx + r * 0.2, by - trunkH * 0.5, cx + r * 0.34, by + r * 0.05);
  g.closePath();
  g.fill();

  const spread = 4;
  for (let i = 0; i < spread; i++) {
    const a = -Math.PI / 2 + (i - (spread - 1) / 2) * 0.56 + between(rng, -0.1, 0.1);
    branchOut(g, cx, by - trunkH * 0.92, a, r * between(rng, 0.98, 1.3), r * 0.24, 2, rng, tips);
  }

  if (v === 1) {
    // Heavy-laden crown: clouds of snow caught in the twigs.
    for (const [x, y] of tips) {
      if (rng() < 0.75) blob(g, x, y + 1.2, between(rng, r * 0.34, r * 0.6), between(rng, r * 0.24, r * 0.42), rng, withAlpha('#b4b6e2', 0.65), 0.14, 8);
    }
    for (const [x, y] of tips) {
      if (rng() < 0.82) blob(g, x - 1, y - 1, between(rng, r * 0.3, r * 0.56), between(rng, r * 0.22, r * 0.4), rng, '#fbfdff', 0.14, 8);
    }
  } else {
    for (const [x, y] of tips) {
      if (rng() < 0.5) blob(g, x, y, between(rng, r * 0.14, r * 0.3), between(rng, r * 0.1, r * 0.22), rng, '#ffffff', 0.14, 7);
    }
  }
  if (v === 2) {
    // A late maple still holding some leaves: a rare hit of warm colour in the cool scene.
    const leaf = ['#e8743a', '#d6404e', '#f2b541'];
    for (const [x, y] of tips) {
      for (let i = 0; i < 3; i++) {
        g.fillStyle = leaf[Math.floor(rng() * 3)];
        g.beginPath();
        g.ellipse(x + between(rng, -r * 0.3, r * 0.3), y + between(rng, -r * 0.26, r * 0.26), 2, 1.3, rng() * TAU, 0, TAU);
        g.fill();
      }
    }
  }
}

function paintBush(g, w, h, o, rng) {
  const cx = w / 2;
  const circle = isCircle(o);
  const by = circle ? h * 0.72 : h - 2;
  const rx = w * 0.56;
  const ry = Math.max(rx * 0.72, 13);
  snowBank(g, cx - rx * 1.05, cx + rx * 1.05, by + 2, 6, rng, { step: 9 });
  const lobes = 3 + (w > 54 ? 2 : 0);
  for (let i = 0; i < lobes; i++) {
    const t = lobes === 1 ? 0.5 : i / (lobes - 1);
    const x = lerp(cx - rx * 0.66, cx + rx * 0.66, t);
    const yy = by - ry * 0.5 - Math.sin(t * Math.PI) * ry * 0.34;
    const pts = blobPoints(x, yy, rx * 0.5, ry * 0.62, rng, 0.14, 9);
    g.beginPath();
    closedCurve(g, pts);
    g.fillStyle = orb(g, x, yy, rx * 0.56, [P.pineLight, P.pine, P.pineDark]);
    g.fill();
  }
  for (let i = 0; i < w * 0.34; i++) {
    const x = cx + between(rng, -rx, rx) * 0.9;
    const y = by - between(rng, 1, ry * 0.9);
    g.fillStyle = '#d93a4a';
    g.beginPath();
    g.arc(x, y, between(rng, 1, 1.7), 0, TAU);
    g.fill();
    g.fillStyle = withAlpha('#ffd6d6', 0.8);
    g.beginPath();
    g.arc(x - 0.35, y - 0.35, 0.35, 0, TAU);
    g.fill();
  }
  // Snow blanket, sized so the berries low on the sides stay visible.
  const pts = [];
  const top = by - ry * 1.28;
  const steps = 7;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    pts.push([lerp(cx - rx * 0.96, cx + rx * 0.96, t), top + Math.pow(Math.abs(t * 2 - 1), 2.2) * ry * 0.88 + between(rng, -1.4, 1.4)]);
  }
  for (let i = steps; i >= 0; i--) {
    const t = i / steps;
    pts.push([lerp(cx - rx * 0.92, cx + rx * 0.92, t), by - ry * 0.46 + (i % 2 ? between(rng, 1, 5) : between(rng, -3, 0))]);
  }
  g.save();
  g.translate(0, 1.4);
  g.beginPath();
  closedCurve(g, pts);
  g.fillStyle = withAlpha('#1b4560', 0.34);
  g.fill();
  g.restore();
  g.beginPath();
  closedCurve(g, pts);
  g.fillStyle = linear(g, cx - rx, top, cx + rx * 0.8, by, ['#ffffff', '#f3f6ff', '#cdd4f0']);
  g.fill();
}

// Stone is built from flat planes. A smooth radial shade would turn it into a ball.
function paintRock(g, w, h, o, rng) {
  const cx = w / 2;
  const circle = isCircle(o);
  const rx = w * 0.56;
  const ry = Math.max(h * 0.46, rx * 0.66);
  const by = circle ? h * 0.74 : h - 2;
  const cy = by - ry * 0.74;
  snowBank(g, cx - rx * 1.02, cx + rx * 1.02, by + 2, 5, rng, { step: 9 });
  const n = 7;
  const rim = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU + 0.35;
    const k = between(rng, 0.86, 1.08);
    rim.push([cx + Math.cos(a) * rx * k, cy + Math.sin(a) * ry * k * (Math.sin(a) > 0 ? 0.92 : 1.06)]);
  }
  const core = [cx - rx * 0.16, cy - ry * 0.12];
  const tones = ['#8d8ab6', '#7a78aa', '#6e6ca2', '#8280b0', '#a6a3c8', '#bcb9d6', '#a09dc4'];
  for (let i = 0; i < n; i++) {
    const a = rim[i];
    const b = rim[(i + 1) % n];
    g.beginPath();
    g.moveTo(core[0], core[1]);
    g.lineTo(a[0], a[1]);
    g.lineTo(b[0], b[1]);
    g.closePath();
    g.fillStyle = tones[i];
    g.fill();
    g.strokeStyle = tones[i];
    g.lineWidth = 0.7;
    g.stroke();
  }
  // Round off the outer corners, so the polygon softens into a storybook boulder.
  g.save();
  g.globalCompositeOperation = 'destination-in';
  g.beginPath();
  closedCurve(g, rim.map(([x, y]) => [x + (x - cx) * 0.1, y + (y - cy) * 0.1]));
  g.fillStyle = '#000';
  g.fill();
  g.restore();
  snowCap(g, cx - rx * 0.8, cx + rx * 0.74, cy - ry * 0.34, ry * 0.58, rng, { droop: 3.5 });
  snowBank(g, cx - rx * 1.02, cx + rx * 1.02, by + 2, 3.4, rng, { step: 8 });
}

// ---- street furniture -------------------------------------------------------

function paintLamp(g, w, h, o, rng) {
  const cx = w / 2;
  const circle = isCircle(o);
  const by = circle ? h / 2 + 1 : h - 2;
  const postH = 92;
  const top = by - postH;
  snowMound(g, cx, by + 1, 11, 5, rng);
  g.fillStyle = linear(g, cx - 3, 0, cx + 3, 0, [mix(P.iron, '#fff', 0.2), P.iron, mix(P.iron, '#20204a', 0.5)]);
  g.beginPath();
  g.moveTo(cx - 4.5, by);
  g.quadraticCurveTo(cx - 2, by - 9, cx - 1.8, by - 16);
  g.lineTo(cx - 1.4, top);
  g.lineTo(cx + 1.4, top);
  g.lineTo(cx + 1.8, by - 16);
  g.quadraticCurveTo(cx + 2, by - 9, cx + 4.5, by);
  g.closePath();
  g.fill();
  fillRounded(g, cx - 3, by - 34, 6, 2.4, 1, mix(P.iron, '#fff', 0.3));
  // Lantern: the glass stays lit in every sprite because the grade dims it by day anyway.
  const ly = top - 15;
  g.fillStyle = radial(g, cx, ly + 7, 0, 22, [[0, withAlpha('#ffe7a6', 0.5)], [1, withAlpha('#ffe7a6', 0)]]);
  g.fillRect(cx - 24, ly - 16, 48, 48);
  g.beginPath();
  g.moveTo(cx - 6, ly);
  g.lineTo(cx + 6, ly);
  g.lineTo(cx + 4.4, ly + 15);
  g.lineTo(cx - 4.4, ly + 15);
  g.closePath();
  g.fillStyle = linear(g, 0, ly, 0, ly + 15, ['#fff6cc', '#ffd978', '#ffb95a']);
  g.fill();
  g.strokeStyle = P.iron;
  g.lineWidth = 1.2;
  g.stroke();
  g.lineWidth = 0.8;
  g.beginPath();
  g.moveTo(cx, ly);
  g.lineTo(cx, ly + 15);
  g.stroke();
  fillRounded(g, cx - 5.4, ly + 14.5, 10.8, 2.6, 1, P.iron);
  g.fillStyle = P.iron;
  g.beginPath();
  g.moveTo(cx - 8, ly + 0.5);
  g.quadraticCurveTo(cx, ly - 7, cx + 8, ly + 0.5);
  g.closePath();
  g.fill();
  snowCap(g, cx - 8.5, cx + 8.5, ly - 1, 6, rng, { droop: 1.5, lumps: 3 });
}

function paintMailbox(g, w, h, o, rng) {
  const cx = w / 2;
  const circle = isCircle(o);
  const by = circle ? h / 2 + 2 : h - 2;
  const colors = ['#3f7fc0', '#d6404e', '#4e9c7a', '#e0a13a'];
  const col = colors[(o.variant || 0) % colors.length];
  snowMound(g, cx, by, 8, 3.6, rng);
  fillRounded(g, cx - 1.8, by - 25, 3.6, 26, 1, linear(g, cx - 2, 0, cx + 2, 0, [P.woodLight, P.woodDark]));
  const top = by - 37;
  g.beginPath();
  roundedRect(g, cx - 11, top, 22, 13, [6, 6, 1.5, 1.5]);
  g.fillStyle = linear(g, 0, top, 0, top + 13, [lightOf(col, 0.25), col, shadeOf(col, 0.25)]);
  g.fill();
  fillRounded(g, cx - 11, top + 3.5, 5, 9.5, [2.4, 1, 1, 1], shadeOf(col, 0.35));
  // The flag: left up, because there is always a letter waiting.
  g.fillStyle = '#e24a55';
  g.fillRect(cx + 8.4, top - 3, 1.4, 9);
  g.fillRect(cx + 8.4, top - 3.4, 5.4, 3.6);
  snowCap(g, cx - 11.5, cx + 10, top + 2.5, 6.5, rng, { droop: 1.6, lumps: 3 });
}

function paintHydrant(g, w, h, o, rng) {
  const cx = w / 2;
  const circle = isCircle(o);
  const by = circle ? h / 2 + 2 : h - 2;
  const red = '#d9463f';
  snowMound(g, cx, by, 10, 4, rng);
  const side = [lightOf(red, 0.22), red, shadeOf(red, 0.32)];
  fillRounded(g, cx - 8, by - 4, 16, 4, 1.5, linear(g, cx - 8, 0, cx + 8, 0, side));
  fillRounded(g, cx - 6, by - 21, 12, 18, 2.5, linear(g, cx - 6, 0, cx + 6, 0, side));
  fillRounded(g, cx - 10, by - 16, 20, 6, 2.2, linear(g, cx - 10, 0, cx + 10, 0, side));
  g.fillStyle = '#ffd9c0';
  g.beginPath();
  g.arc(cx - 9.2, by - 13, 1.6, 0, TAU);
  g.arc(cx + 9.2, by - 13, 1.6, 0, TAU);
  g.fill();
  g.beginPath();
  g.moveTo(cx - 7, by - 21);
  g.quadraticCurveTo(cx, by - 30, cx + 7, by - 21);
  g.closePath();
  g.fillStyle = linear(g, cx - 7, 0, cx + 7, 0, side);
  g.fill();
  snowCap(g, cx - 7.5, cx + 7.5, by - 24, 7, rng, { droop: 1.6, lumps: 3 });
}

function paintBin(g, w, h, o, rng) {
  const cx = w / 2;
  const circle = isCircle(o);
  const by = circle ? h / 2 + Math.min(w, h) * 0.3 : h - 2;
  const rw = Math.min(w * 0.44, 15);
  const tall = 28;
  const body = ['#7b8aa8', '#5e6c90', '#465278'];
  snowBank(g, cx - rw - 2, cx + rw + 2, by + 1.5, 4, rng, { step: 8 });
  g.beginPath();
  g.moveTo(cx - rw, by - tall);
  g.lineTo(cx - rw * 0.84, by);
  g.quadraticCurveTo(cx, by + 3, cx + rw * 0.84, by);
  g.lineTo(cx + rw, by - tall);
  g.closePath();
  g.fillStyle = linear(g, cx - rw, 0, cx + rw, 0, body);
  g.fill();
  g.strokeStyle = withAlpha('#2f3862', 0.35);
  g.lineWidth = 1;
  for (let i = -1; i <= 1; i++) {
    g.beginPath();
    g.moveTo(cx + i * rw * 0.5, by - tall + 4);
    g.lineTo(cx + i * rw * 0.44, by - 3);
    g.stroke();
  }
  g.beginPath();
  g.ellipse(cx, by - tall, rw + 1.8, 5, 0, 0, TAU);
  g.fillStyle = '#8c9aba';
  g.fill();
  g.beginPath();
  g.ellipse(cx, by - tall - 1.6, rw + 1.4, 4.6, 0, 0, TAU);
  g.fillStyle = linear(g, cx - rw, 0, cx + rw, 0, ['#c0c9de', '#8f9bbb']);
  g.fill();
  fillRounded(g, cx - 3.4, by - tall - 7, 6.8, 2.2, 1, '#6f7da0');
  snowCap(g, cx - rw - 1, cx + rw + 1, by - tall - 2, 7.5, rng, { droop: 2, lumps: 4 });
}

function paintBench(g, w, h, o, rng) {
  if (isVertical(o, w, h)) {
    // Running up the screen, seen along its length: a raised slatted seat, its near legs in front,
    // and a slim back rail on one side, held clear of the seat so the two read as separate parts.
    const lift = 11;
    const seatW = w - 7;
    g.fillStyle = P.iron;
    g.fillRect(3, h - lift - 3, 2.6, lift + 2);
    g.fillRect(seatW - 3, h - lift - 3, 2.6, lift + 2);
    fillRounded(g, 1, -lift, seatW, h, 2.5, linear(g, 0, 0, seatW, 0, [P.woodLight, P.wood]));
    fillRounded(g, 1, h - lift - 6, seatW, 6, [1, 1, 2.5, 2.5], P.woodDark);
    g.strokeStyle = withAlpha(P.woodDark, 0.55);
    g.lineWidth = 1;
    for (let y = -lift + 8; y < h - lift - 6; y += 8) {
      g.beginPath();
      g.moveTo(1.5, y);
      g.lineTo(seatW + 0.5, y);
      g.stroke();
    }
    const railX = seatW + 5;
    tube(g, railX, -lift - 14, railX, h - lift - 18, 3, P.wood);
    tube(g, seatW + 1, h - lift - 4, railX, h - lift - 18, 2, P.iron);
    tube(g, seatW + 1, -lift + 6, railX, -lift - 10, 2, P.iron);
    // A loaf of snow down the seat, narrow enough to leave the slats showing along both edges.
    const ridge = [];
    const steps = Math.round(h / 15);
    for (let i = 0; i <= steps; i++) ridge.push([seatW * 0.2 + between(rng, -1.4, 1.4), lerp(-lift + 5, h - lift - 12, i / steps)]);
    for (let i = steps; i >= 0; i--) ridge.push([seatW * 0.8 + between(rng, -1.4, 1.4), lerp(-lift + 5, h - lift - 12, i / steps)]);
    g.beginPath();
    closedCurve(g, ridge);
    g.fillStyle = linear(g, 0, 0, seatW, 0, ['#ffffff', '#e6eafa']);
    g.fill();
    snowBank(g, -1, w + 3, h + 1, 3, rng, { step: 7 });
    return;
  }
  const seatY = h - 13;
  const legs = [w * 0.12, w * 0.88];
  g.fillStyle = P.iron;
  for (const x of legs) {
    g.fillRect(x - 1.6, seatY, 3.2, 13);
    g.fillRect(x - 1.6, seatY - 16, 3.2, 17);
  }
  const slat = (y, hh, c) => fillRounded(g, 0, y, w, hh, 1.5, c);
  slat(seatY - 21, 5, linear(g, 0, seatY - 21, 0, seatY - 16, [P.woodLight, P.wood]));
  slat(seatY - 14, 5, linear(g, 0, seatY - 14, 0, seatY - 9, [P.woodLight, P.wood]));
  slat(seatY - 1, 5.5, linear(g, 0, seatY - 1, 0, seatY + 4.5, [P.woodLight, P.woodDark]));
  slat(seatY + 4, 3, P.woodDark);
  snowCap(g, 1, w - 1, seatY - 0.5, 8, rng, { droop: 3 });
  snowCap(g, 2, w - 2, seatY - 20.5, 4, rng, { droop: 1.5 });
  snowBank(g, -2, w + 2, h + 1.5, 4, rng, { step: 10 });
}

// ---- playground -------------------------------------------------------------

const PLAY = ['#e7663f', '#2f9e96', '#e6b23c', '#7a6bd1'];

function tube(g, x0, y0, x1, y1, width, color) {
  g.strokeStyle = shadeOf(color, 0.3);
  g.lineWidth = width;
  g.beginPath();
  g.moveTo(x0, y0);
  g.lineTo(x1, y1);
  g.stroke();
  g.strokeStyle = lightOf(color, 0.12);
  g.lineWidth = width * 0.56;
  g.beginPath();
  g.moveTo(x0 - width * 0.14, y0);
  g.lineTo(x1 - width * 0.14, y1);
  g.stroke();
}

function paintSwing(g, w, h, o, rng) {
  const col = PLAY[(o.variant || 0) % PLAY.length];
  const rise = 62;
  if (isVertical(o, w, h)) {
    // Crossbar runs away from the viewer: the near A-frame stands in front, the far one behind it.
    const near = h - 4;
    const far = 14;
    const barY = (y) => y - rise;
    const frame = (y) => {
      tube(g, 2, y, w / 2, barY(y), 3.6, col);
      tube(g, w - 2, y, w / 2, barY(y), 3.6, col);
    };
    frame(far);
    tube(g, w / 2, barY(far), w / 2, barY(near), 4.2, shadeOf(col, 0.08));
    const seats = 2;
    for (let i = 0; i < seats; i++) {
      const y = lerp(far, near, (i + 0.7) / (seats + 0.4));
      g.strokeStyle = '#8280ac';
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(w / 2 - 1, barY(y));
      g.lineTo(w / 2 - 6, y - 15);
      g.moveTo(w / 2 + 1, barY(y));
      g.lineTo(w / 2 + 6, y - 15);
      g.stroke();
      fillRounded(g, w / 2 - 8, y - 17, 16, 5, 1.6, '#3e3e6e');
      snowCap(g, w / 2 - 8, w / 2 + 8, y - 16.5, 3.5, rng, { droop: 1, lumps: 3 });
    }
    frame(near);
    snowCap(g, w / 2 - 3, w / 2 + 3, barY(near), 3, rng, { droop: 1, lumps: 2 });
    return;
  }
  const by = h - 3;
  const topY = by - rise;
  tube(g, -3, by, 6, topY, 4, col);
  tube(g, 12, by, 6, topY, 4, col);
  tube(g, w + 3, by, w - 6, topY, 4, col);
  tube(g, w - 12, by, w - 6, topY, 4, col);
  tube(g, 4, topY, w - 4, topY, 4.6, shadeOf(col, 0.08));
  const seats = Math.max(2, Math.round(w / 56));
  for (let i = 0; i < seats; i++) {
    const x = lerp(w * 0.2, w * 0.8, seats === 1 ? 0.5 : i / (seats - 1));
    const sway = between(rng, -3, 3);
    g.strokeStyle = '#8280ac';
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(x - 7, topY);
    g.lineTo(x - 7 + sway, by - 15);
    g.moveTo(x + 7, topY);
    g.lineTo(x + 7 + sway, by - 15);
    g.stroke();
    fillRounded(g, x - 8.5 + sway, by - 16, 17, 4.4, 1.6, '#3e3e6e');
    snowCap(g, x - 8.5 + sway, x + 8.5 + sway, by - 15.5, 4, rng, { droop: 1.2, lumps: 3 });
  }
  snowCap(g, 2, w - 2, topY - 1.6, 4.5, rng, { droop: 1.4 });
}

function paintSlide(g, w, h, o, rng) {
  const col = PLAY[((o.variant || 0) + 2) % PLAY.length];
  const rail = PLAY[((o.variant || 0) + 1) % PLAY.length];
  const rise = 56;
  const vert = isVertical(o, w, h);
  // Geometry in "length" space so one painter serves both orientations.
  if (vert) {
    const by = h - 2;
    tube(g, 3, 6, 3, -rise + 14, 3, rail);
    tube(g, w - 3, 6, w - 3, -rise + 14, 3, rail);
    fillRounded(g, 2, -rise + 8, w - 4, 10, 2, shadeOf(rail, 0.15));
    g.beginPath();
    g.moveTo(5, -rise + 14);
    g.lineTo(w - 5, -rise + 14);
    g.quadraticCurveTo(w - 3, h * 0.4, w - 1, by);
    g.lineTo(1, by);
    g.quadraticCurveTo(3, h * 0.4, 5, -rise + 14);
    g.closePath();
    g.fillStyle = linear(g, 0, 0, w, 0, [lightOf(col, 0.2), col, shadeOf(col, 0.26)]);
    g.fill();
    g.beginPath();
    g.moveTo(w * 0.3, -rise + 18);
    g.lineTo(w * 0.7, -rise + 18);
    g.lineTo(w * 0.76, by - 4);
    g.lineTo(w * 0.24, by - 4);
    g.closePath();
    g.fillStyle = withAlpha('#ffffff', 0.92);
    g.fill();
    snowBank(g, -2, w + 2, h + 1, 5, rng, { step: 9 });
    return;
  }
  const flip = (o.variant || 0) % 2 === 1 ? -1 : 1;
  g.save();
  if (flip < 0) {
    g.translate(w, 0);
    g.scale(-1, 1);
  }
  const by = h - 3;
  const towerX = 14;
  const towerTop = by - rise;
  tube(g, towerX - 9, by, towerX - 9, towerTop - 14, 3, rail);
  tube(g, towerX + 9, by, towerX + 9, towerTop - 14, 3, rail);
  for (let y = by - 8; y > towerTop; y -= 9) tube(g, towerX - 9, y, towerX + 9, y, 2.4, P.iron);
  fillRounded(g, towerX - 12, towerTop - 3, 24, 5.5, 1.5, shadeOf(rail, 0.15));
  g.beginPath();
  g.moveTo(towerX + 8, towerTop);
  g.bezierCurveTo(w * 0.42, towerTop + 2, w * 0.5, by - 4, w - 1, by - 3);
  g.lineTo(w, by + 3);
  g.bezierCurveTo(w * 0.46, by + 3, w * 0.4, towerTop + 12, towerX + 8, towerTop + 10);
  g.closePath();
  g.fillStyle = linear(g, 0, towerTop, 0, by, [lightOf(col, 0.2), col, shadeOf(col, 0.2)]);
  g.fill();
  g.lineWidth = 2.6;
  g.strokeStyle = '#ffffff';
  g.beginPath();
  g.moveTo(towerX + 12, towerTop + 0.4);
  g.bezierCurveTo(w * 0.42, towerTop + 3, w * 0.5, by - 4, w - 6, by - 3.4);
  g.stroke();
  snowCap(g, towerX - 12, towerX + 12, towerTop - 2.5, 5.5, rng, { droop: 1.6, lumps: 3 });
  snowBank(g, w * 0.7, w + 3, h + 1.5, 4.5, rng, { step: 9 });
  g.restore();
}

function paintMonkeybars(g, w, h, o, rng) {
  const col = PLAY[((o.variant || 0) + 1) % PLAY.length];
  const leg = PLAY[(o.variant || 0) % PLAY.length];
  const rise = 54;
  const vert = isVertical(o, w, h);
  const by = h - 3;
  if (vert) {
    const top = -rise + 6;
    tube(g, 3, by, 3, top + 20, 3.4, leg);
    tube(g, w - 3, by, w - 3, top + 20, 3.4, leg);
    tube(g, 3, 8, 3, top, 3.4, leg);
    tube(g, w - 3, 8, w - 3, top, 3.4, leg);
    for (let y = top + 6; y < by - rise * 0.7; y += 10) tube(g, 3, y, w - 3, y, 2.4, col);
    tube(g, 3, top, 3, by - rise, 3.2, col);
    tube(g, w - 3, top, w - 3, by - rise, 3.2, col);
    snowCap(g, 1, w - 1, by - rise + 1, 3.4, rng, { droop: 1, lumps: 3 });
    return;
  }
  // Rear ladder lifted by the footprint depth, so the frame reads as a box in 3/4 view.
  const depth = Math.min(h * 0.55, 26);
  const backBy = by - depth;
  const top = by - rise;
  const backTop = backBy - rise;
  const uprights = (yb, yt) => {
    tube(g, 3, yb, 3, yt, 3.2, leg);
    tube(g, w - 3, yb, w - 3, yt, 3.2, leg);
  };
  uprights(backBy, backTop);
  tube(g, 3, backTop, w - 3, backTop, 3, col);
  for (let x = 12; x < w - 8; x += 12) tube(g, x, backTop, x, top, 2.4, col);
  uprights(by, top);
  tube(g, 3, top, w - 3, top, 3, col);
  tube(g, 3, top, 3, backTop, 3, col);
  tube(g, w - 3, top, w - 3, backTop, 3, col);
  for (let x = 12; x < w - 8; x += 24) snowCap(g, x - 3, x + 3, lerp(top, backTop, 0.5), 2.2, rng, { droop: 0.7, lumps: 2 });
  snowCap(g, 1, w - 1, top - 1.3, 3.8, rng, { droop: 1.2 });
  snowBank(g, -3, 9, by + 1.5, 4, rng, { step: 6 });
  snowBank(g, w - 9, w + 3, by + 1.5, 4, rng, { step: 6 });
}

// ---- fences -----------------------------------------------------------------

// A fence running up the screen would collapse to a line in this projection, so its height is skewed
// sideways a little: an honest cheat that keeps long runs visible as walls of wire.
const FENCE_SKEW = 13;

function chainLink(g, w, h, o, rng) {
  const rise = 46;
  const post = (x, y) => tube(g, x, y, x, y - rise, 3, '#8d93b8');
  if (isVertical(o, w, h)) {
    const x = w / 2;
    const sk = FENCE_SKEW;
    const top = (y) => y - rise * 0.84;
    g.save();
    g.beginPath();
    g.moveTo(x, 0);
    g.lineTo(x + sk, top(0));
    g.lineTo(x + sk, top(h));
    g.lineTo(x, h);
    g.closePath();
    g.clip();
    g.strokeStyle = withAlpha('#9ea6cc', 0.85);
    g.lineWidth = 0.65;
    for (let y = -rise; y < h + rise; y += 8) {
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(x + sk, y - rise * 0.5);
      g.moveTo(x, y);
      g.lineTo(x + sk, y - rise * 1.3);
      g.stroke();
    }
    g.restore();
    tube(g, x + sk, top(0), x + sk, top(h), 2.2, '#8d93b8');
    const count = Math.max(1, Math.round(h / 80));
    for (let i = 0; i <= count; i++) {
      const y = lerp(0, h, i / count);
      tube(g, x, y, x + sk, top(y), 3, '#8d93b8');
    }
    snowRidge(g, x + 0.5, -2, h + 3, 4.6, rng);
    return;
  }
  const by = h - 1;
  const top = by - rise;
  g.save();
  g.beginPath();
  g.rect(0, top, w, rise);
  g.clip();
  g.strokeStyle = withAlpha('#9ea6cc', 0.8);
  g.lineWidth = 0.65;
  const c = 8;
  for (let x = -rise; x < w + rise; x += c) {
    g.beginPath();
    g.moveTo(x, top);
    g.lineTo(x + rise, by);
    g.moveTo(x + rise, top);
    g.lineTo(x, by);
    g.stroke();
  }
  g.restore();
  tube(g, 0, top, w, top, 2.2, '#8d93b8');
  const posts = Math.max(1, Math.round(w / 80));
  for (let i = 0; i <= posts; i++) post(lerp(1, w - 1, i / posts), by);
  snowCap(g, 0, w, top - 0.8, 2.6, rng, { droop: 0.8, lumps: Math.round(w / 22) });
  // Snow caught in the mesh along the bottom: the wire otherwise floats on the white ground.
  snowBank(g, -2, w + 2, by + 1, 6, rng, { step: 15 });
}

function picket(g, w, h, o, rng) {
  const rise = 32;
  const tint = (o.variant || 0) % 2 ? '#d4a878' : '#efe2cc';
  const dark = shadeOf(tint, 0.26);
  if (isVertical(o, w, h)) {
    const x = w / 2;
    const sk = 10;
    const top = (y) => y - rise * 0.8;
    const rail = (t) => tube(g, x + sk * t, -rise * 0.8 * t, x + sk * t, h - rise * 0.8 * t, 2.2, dark);
    rail(0.28);
    rail(0.74);
    for (let y = 2; y < h - 1; y += 9.5) {
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(x + sk, top(y));
      g.lineTo(x + sk + 1.6, top(y) + 3);
      g.lineTo(x + sk, top(y) + 6.4);
      g.lineTo(x, y + 6.4);
      g.closePath();
      g.fillStyle = linear(g, x, 0, x + sk, 0, [shadeOf(tint, 0.1), tint]);
      g.fill();
      if (rng() < 0.6) blob(g, x + sk + 0.5, top(y) + 1.5, 3.4, 2.4, rng, '#ffffff', 0.1, 6);
    }
    snowRidge(g, x + 0.5, 0, h + 4, 4.6, rng);
    return;
  }
  const by = h - 1;
  const top = by - rise;
  fillRounded(g, 0, top + 8, w, 3.4, 1, dark);
  fillRounded(g, 0, by - 11, w, 3.4, 1, dark);
  for (let x = 2; x < w - 3; x += 9.5) {
    const hgt = rise + (rng() - 0.5) * 1.6;
    g.beginPath();
    g.moveTo(x, by);
    g.lineTo(x, by - hgt + 3.2);
    g.lineTo(x + 3.2, by - hgt);
    g.lineTo(x + 6.4, by - hgt + 3.2);
    g.lineTo(x + 6.4, by);
    g.closePath();
    g.fillStyle = linear(g, x, 0, x + 6.4, 0, [lightOf(tint, 0.2), tint, dark]);
    g.fill();
    if (rng() < 0.7) blob(g, x + 3.2, by - hgt - 0.2, 4, 2.6, rng, '#ffffff', 0.1, 7);
  }
  snowCap(g, 0, w, top + 8, 2.4, rng, { droop: 0.8, lumps: Math.round(w / 24) });
  snowBank(g, -2, w + 2, by + 1, 7, rng, { step: 12 });
}

function paintFence(g, w, h, o, rng) {
  if (o.blocksBalls === false || (o.variant || 0) >= 2) chainLink(g, w, h, o, rng);
  else picket(g, w, h, o, rng);
}

// ---- cars -------------------------------------------------------------------

const CAR = ['#d9534f', '#2f9e96', '#e6b23c', '#6f62c4', '#3f8fc4', '#e07fa8'];

function paintCar(g, w, h, o, rng) {
  const col = CAR[(o.variant || 0) % CAR.length];
  const tone = [lightOf(col, 0.3), col, shadeOf(col, 0.24)];
  if (isVertical(o, w, h)) {
    // Parked nose-away: we look down over the boot and roof, with the tail end facing us.
    const tail = 17;
    const deck = h - tail;
    for (const y of [h * 0.14, h * 0.6]) {
      fillRounded(g, -2, y, 7, 22, 3, '#34345a');
      fillRounded(g, w - 5, y, 7, 22, 3, '#34345a');
    }
    g.beginPath();
    roundedRect(g, 1, 0, w - 2, deck + 6, [w * 0.36, w * 0.36, 7, 7]);
    g.fillStyle = linear(g, 0, 0, w, 0, tone);
    g.fill();
    fillRounded(g, 8, 3, w - 16, 3.4, 1.6, '#ffe6a0');
    // Glasshouse, then the roof panel on it.
    g.beginPath();
    roundedRect(g, 5, h * 0.2, w - 10, h * 0.52, [11, 11, 7, 7]);
    g.fillStyle = linear(g, 0, h * 0.2, 0, h * 0.72, ['#d6eefa', '#a0bde6', '#8097d6']);
    g.fill();
    fillRounded(g, 8, h * 0.33, w - 16, h * 0.28, 5, linear(g, 0, 0, w, 0, [lightOf(col, 0.25), col]));
    // Rear face.
    fillRounded(g, 1, deck - 2, w - 2, tail, [3, 3, 8, 8], linear(g, 0, deck, 0, h, [col, shadeOf(col, 0.3)]));
    fillRounded(g, 4, deck + 3, 10, 4.6, 1.6, '#ff8a80');
    fillRounded(g, w - 14, deck + 3, 10, 4.6, 1.6, '#ff8a80');
    fillRounded(g, w / 2 - 7, deck + 3.4, 14, 5, 1, '#f4efe2');
    fillRounded(g, -1, h - 6, w + 2, 4.4, 1.8, '#e8ebf6');
    // Snow load: heaped on the roof, thin on bonnet and boot.
    const heap = [];
    for (let i = 0; i <= 5; i++) heap.push([9 + between(rng, -1.4, 1.4), lerp(h * 0.34, h * 0.6, i / 5)]);
    heap.push([w * 0.5, h * 0.62 + between(rng, 0, 2)]);
    for (let i = 5; i >= 0; i--) heap.push([w - 9 + between(rng, -1.4, 1.4), lerp(h * 0.34, h * 0.6, i / 5)]);
    heap.push([w * 0.5, h * 0.32 - between(rng, 0, 2)]);
    g.beginPath();
    closedCurve(g, heap);
    g.fillStyle = linear(g, 0, h * 0.3, w, h * 0.64, ['#ffffff', '#e8ecfa']);
    g.fill();
    fillRounded(g, w * 0.26, h * 0.08, w * 0.48, h * 0.05, 3, '#f5f7fe');
    snowBank(g, -3, w + 3, h + 1.5, 4.5, rng, { step: 9 });
    return;
  }
  const flip = (o.variant || 0) % 2 === 1;
  g.save();
  if (flip) {
    g.translate(w, 0);
    g.scale(-1, 1);
  }
  const by = h - 6;
  const bodyY = by - 19;
  const roofY = Math.min(bodyY - 19, h - 45);
  // Far-side wheels peek out, which is what sells the car as an object rather than a side-on sticker.
  fillRounded(g, w * 0.16, bodyY - 7, 14, 8, 3, shadeOf('#3a3a60', 0.2));
  fillRounded(g, w * 0.72, bodyY - 7, 14, 8, 3, shadeOf('#3a3a60', 0.2));

  // Deck: the top of the bonnet and boot, seen from above.
  g.beginPath();
  g.moveTo(5, bodyY + 3);
  g.quadraticCurveTo(7, bodyY - 11, 22, bodyY - 11);
  g.lineTo(w - 20, bodyY - 11);
  g.quadraticCurveTo(w - 5, bodyY - 11, w - 3, bodyY + 3);
  g.closePath();
  g.fillStyle = linear(g, 0, bodyY - 12, 0, bodyY + 4, [lightOf(col, 0.36), lightOf(col, 0.08)]);
  g.fill();

  // Cabin.
  const c0 = w * 0.26;
  const c1 = w * 0.76;
  g.beginPath();
  g.moveTo(c0 - 7, bodyY - 1);
  g.quadraticCurveTo(c0 + 2, roofY - 1, c0 + 12, roofY);
  g.lineTo(c1 - 10, roofY);
  g.quadraticCurveTo(c1 - 1, roofY, c1 + 7, bodyY - 1);
  g.closePath();
  g.fillStyle = linear(g, 0, roofY, 0, bodyY, [lightOf(col, 0.2), col]);
  g.fill();
  const mid = (c0 + c1) / 2;
  g.beginPath();
  g.moveTo(c0 - 1, bodyY - 2);
  g.quadraticCurveTo(c0 + 4, roofY + 4, c0 + 12, roofY + 4);
  g.lineTo(mid - 1.2, roofY + 4);
  g.lineTo(mid - 1.2, bodyY - 2);
  g.closePath();
  g.moveTo(mid + 1.2, bodyY - 2);
  g.lineTo(mid + 1.2, roofY + 4);
  g.lineTo(c1 - 10, roofY + 4);
  g.quadraticCurveTo(c1 - 3, roofY + 4, c1 + 1, bodyY - 2);
  g.closePath();
  g.fillStyle = linear(g, c0, roofY, c1, bodyY, ['#d6eefa', '#a0bde6', '#8097d6']);
  g.fill();

  // Body side.
  g.beginPath();
  roundedRect(g, 0, bodyY, w, 19, [9, 11, 6, 6]);
  g.fillStyle = linear(g, 0, bodyY, 0, bodyY + 19, tone);
  g.fill();
  g.strokeStyle = withAlpha(shadeOf(col, 0.45), 0.5);
  g.lineWidth = 0.9;
  g.beginPath();
  g.moveTo(mid, bodyY + 2);
  g.lineTo(mid, bodyY + 15);
  g.stroke();
  fillRounded(g, mid - 10, bodyY + 5, 6, 1.5, 0.7, withAlpha('#ffffff', 0.7));
  fillRounded(g, mid + 4, bodyY + 5, 6, 1.5, 0.7, withAlpha('#ffffff', 0.7));
  fillRounded(g, w - 6.5, bodyY + 5, 6, 5, 2, '#ffe6a0');
  fillRounded(g, 0.8, bodyY + 5, 4.5, 5, 1.6, '#ff8a80');
  fillRounded(g, -1.2, bodyY + 14.5, w + 2.4, 3.8, 1.6, '#e8ebf6');

  for (const x of [w * 0.2, w * 0.8]) {
    g.fillStyle = '#34345a';
    g.beginPath();
    g.arc(x, by, 9.2, 0, TAU);
    g.fill();
    g.fillStyle = orb(g, x, by, 4.6, ['#f0f2fa', '#a8aed0']);
    g.beginPath();
    g.arc(x, by, 4.4, 0, TAU);
    g.fill();
  }

  // The snow load: fat on the roof, patchy on bonnet and boot.
  snowCap(g, c0 + 3, c1 - 1, roofY + 1.5, 9.5, rng, { droop: 2.4 });
  snowCap(g, 6, c0 - 5, bodyY - 1, 5, rng, { droop: 1.7, lumps: 3 });
  snowCap(g, c1 + 5, w - 6, bodyY - 1, 6, rng, { droop: 1.7, lumps: 3 });
  g.restore();
  snowBank(g, -3, w + 3, h + 1, 5.5, rng, { step: 11 });
}

// ---- school -----------------------------------------------------------------

const SCHOOL_DOOR_EVERY = 6;

function schoolBays(w, h) {
  const rise = Math.min(92, h * 0.62);
  const gap = 104;
  const count = Math.max(1, Math.floor((w - 40) / gap));
  return { gap, count, start: (w - (count - 1) * gap) / 2, winH: rise * 0.48, winY: h - rise + rise * 0.22 };
}

// The school fills its whole footprint: a long brick front along the near edge and a broad flat roof
// behind it, with the snow lying deep on top. Kids can never get onto that roof, so it is scenery.
function paintSchoolwall(g, w, h, o, rng) {
  if (isVertical(o, w, h)) {
    const rise = Math.min(74, h * 0.4);
    const faceY = h - rise;
    roofSlab(g, 0, -rise * 0.25, w, faceY + rise * 0.25 + 4, rng);
    g.fillStyle = linear(g, 0, faceY, 0, h, [P.brick, shadeOf(P.brick, 0.25)]);
    g.fillRect(0, faceY, w, rise);
    brickwork(g, 0, faceY, w, rise);
    snowCap(g, -2, w + 2, faceY + 1, 8, rng, { droop: 3 });
    snowBank(g, -5, w + 5, h + 1.5, 7, rng);
    return;
  }
  const rise = Math.min(92, h * 0.62);
  const by = h;
  const top = by - rise;
  roofSlab(g, 0, -6, w, top + 8, rng);

  g.fillStyle = linear(g, 0, top, 0, by, [mix(P.brick, '#6a5aa0', 0.3), P.brick, shadeOf(P.brick, 0.12)]);
  g.fillRect(0, top, w, rise);
  brickwork(g, 0, top, w, rise);

  // Tall classroom windows with the class's paper snowflakes taped to the glass.
  const { gap, count, start, winH, winY } = schoolBays(w, h);
  for (let i = 0; i < count; i++) {
    const x = start + i * gap;
    if (i % SCHOOL_DOOR_EVERY === 3) {
      // Double doors under a stone lintel. The awning keeps the snow off the steps.
      const dh = Math.min(58, rise * 0.68);
      fillRounded(g, x - 34, by - dh - 9, 68, dh + 9, [4, 4, 0, 0], '#ded6c8');
      frontDoor(g, x - 27, by - dh, 26, dh, '#3f7e78', rng);
      frontDoor(g, x + 1, by - dh, 26, dh, '#3f7e78', rng);
      snowCap(g, x - 38, x + 38, by - dh - 8, 7, rng, { droop: 2.6 });
      continue;
    }
    paneWindow(g, x - 24, winY, 48, winH, rng, { lit: i % 3 !== 1, frame: '#f4ead6' });
    for (let k = 0; k < 3; k++) {
      const fx = x + between(rng, -18, 18);
      const fy = winY + between(rng, 6, winH - 6);
      g.strokeStyle = withAlpha('#ffffff', 0.92);
      g.lineWidth = 0.9;
      for (let a = 0; a < 3; a++) {
        const ang = (a / 3) * Math.PI;
        g.beginPath();
        g.moveTo(fx - Math.cos(ang) * 3.4, fy - Math.sin(ang) * 3.4);
        g.lineTo(fx + Math.cos(ang) * 3.4, fy + Math.sin(ang) * 3.4);
        g.stroke();
      }
    }
  }
  // Stone coping with a long lip of snow rolling over the edge.
  fillRounded(g, -3, top - 4, w + 6, 7.5, 2, linear(g, 0, top - 4, 0, top + 4, ['#e6e0ea', P.stone]));
  snowCap(g, -3, w + 3, top - 2.5, 7, rng, { droop: 5 });
  icicles(g, 0, w, top + 3, rng, 0.05);
  snowBank(g, -5, w + 5, h + 1.5, 10, rng);
}

// A wide flat roof under deep snow: soft lilac dips and a few vents poking through.
function roofSlab(g, x, y, w, h, rng) {
  g.fillStyle = linear(g, 0, y, 0, y + h, ['#fbfdff', '#eef2fc', '#dfe5f8']);
  g.beginPath();
  roundedRect(g, x, y, w, h, 6);
  g.fill();
  g.save();
  g.clip();
  const pools = Math.round((w * h) / 9000) + 3;
  for (let i = 0; i < pools; i++) {
    softEllipse(g, x + rng() * w, y + rng() * h, between(rng, 50, 170), between(rng, 12, 34), '#b4b6e6', between(rng, 0.14, 0.3), -0.3);
    softEllipse(g, x + rng() * w, y + rng() * h, between(rng, 40, 130), between(rng, 10, 24), '#ffffff', 0.9, -0.3);
  }
  const vents = Math.round(w / 240);
  for (let i = 0; i < vents; i++) {
    const vx = x + (i + 0.5) * (w / vents) + between(rng, -30, 30);
    const vy = y + between(rng, h * 0.3, h * 0.72);
    softEllipse(g, vx + 6, vy + 7, 15, 7, '#8d8cce', 0.45);
    fillRounded(g, vx - 7, vy - 10, 14, 12, 2, linear(g, vx - 7, 0, vx + 7, 0, ['#a4abcc', '#6f76a4']));
    snowCap(g, vx - 8, vx + 8, vy - 9, 5, rng, { droop: 1.2, lumps: 3 });
  }
  g.restore();
}

function brickwork(g, x, y, w, h) {
  g.strokeStyle = withAlpha('#7e3f40', 0.34);
  g.lineWidth = 0.8;
  const bh = 6;
  const bw = 14;
  for (let yy = y + bh, row = 0; yy < y + h; yy += bh, row++) {
    g.beginPath();
    g.moveTo(x, yy);
    g.lineTo(x + w, yy);
    for (let xx = x + (row % 2 ? bw / 2 : bw); xx < x + w; xx += bw) {
      g.moveTo(xx, yy);
      g.lineTo(xx, yy + bh);
    }
    g.stroke();
  }
}

// ---- fallback ---------------------------------------------------------------

// Any type the renderer does not know: a rounded, snow-capped block from the raw shape and height.
function paintFallback(g, w, h, o, rng) {
  const rise = clamp((o.height || 40) * 0.8, 10, 90);
  if (isCircle(o)) {
    const r = w / 2;
    const by = h / 2 + r * 0.7;
    fillRounded(g, 0, by - rise - r * 0.6, w, rise + r * 0.6, r * 0.7, linear(g, 0, 0, w, 0, [P.stone, P.stoneDark]));
    g.beginPath();
    g.ellipse(r, by - rise - r * 0.2, r, r * 0.55, 0, 0, TAU);
    g.fillStyle = '#ffffff';
    g.fill();
    return;
  }
  fillRounded(g, 0, -rise, w, h + rise, 7, linear(g, 0, 0, w, 0, [mix(P.stone, '#fff', 0.2), P.stone, P.stoneDark]));
  fillRounded(g, 0, h - rise, w, rise, [3, 3, 7, 7], linear(g, 0, h - rise, 0, h, [P.stone, P.stoneDark]));
  snowCap(g, -1, w + 1, h - rise + 1, Math.min(9, 4 + h * 0.2), rng, { droop: 3 });
  fillRounded(g, 2, -rise, w - 4, Math.max(2, h - 2), 6, linear(g, 0, -rise, 0, h - rise, ['#ffffff', '#e8eefb']));
}

// ---- registry ---------------------------------------------------------------

// pad = how far the painted art reaches beyond the footprint, in world units. rise is the headroom.
const ART = {
  house: { paint: paintHouse, pad: (w, h, o) => ({ l: 16, r: 16, t: o.rot === 90 ? 90 + h * 0.2 : Math.max(10, 50 - (h - houseMetrics(w, h).wallH - 66)) + 30, b: 12 }), veg: false },
  tree: { paint: paintTree, pad: (w, h) => { const r = Math.min(w, h) / 2; return { l: r * 2.4, r: r * 2.4, t: r * 5, b: r * 0.8 }; }, veg: true },
  pine: { paint: paintPine, pad: (w, h) => { const r = Math.min(w, h) / 2; return { l: r * 1.1, r: r * 1.1, t: r * 5.6, b: r * 0.6 }; }, veg: true },
  bush: { paint: paintBush, pad: (w) => ({ l: w * 0.2, r: w * 0.2, t: w * 0.5, b: 8 }), veg: true },
  rock: { paint: paintRock, pad: (w) => ({ l: 6, r: 6, t: w * 0.5, b: 6 }), veg: true },
  lamp: { paint: paintLamp, pad: () => ({ l: 26, r: 26, t: 124, b: 8 }) },
  mailbox: { paint: paintMailbox, pad: () => ({ l: 14, r: 16, t: 46, b: 6 }) },
  hydrant: { paint: paintHydrant, pad: () => ({ l: 12, r: 12, t: 38, b: 6 }) },
  bin: { paint: paintBin, pad: () => ({ l: 8, r: 8, t: 46, b: 8 }) },
  bench: { paint: paintBench, pad: () => ({ l: 6, r: 14, t: 42, b: 6 }) },
  swing: { paint: paintSwing, pad: () => ({ l: 10, r: 10, t: 74, b: 6 }) },
  slide: { paint: paintSlide, pad: () => ({ l: 10, r: 10, t: 74, b: 8 }) },
  monkeybars: { paint: paintMonkeybars, pad: () => ({ l: 10, r: 10, t: 74, b: 8 }) },
  fence: { paint: paintFence, pad: () => ({ l: 10, r: 10 + FENCE_SKEW, t: 58, b: 8 }) },
  car: { paint: paintCar, pad: () => ({ l: 8, r: 8, t: 34, b: 8 }) },
  schoolwall: { paint: paintSchoolwall, pad: (w, h) => ({ l: 8, r: 8, t: h > w ? 40 : 14, b: 12 }) },
};

const FALLBACK = {
  paint: paintFallback,
  pad: (w, h, o) => ({ l: 6, r: 6, t: clamp((o.height || 40) * 0.8, 10, 90) + 16, b: 6 }),
};

export function obstacleSprite(bank, o) {
  const f = footprint(o);
  const art = ART[o.type] || FALLBACK;
  const known = ART[o.type] ? o.type : 'fallback';
  // Vegetation repeats visibly, so a placement-derived twist gives each map a few distinct shapes.
  const twist = art.veg ? (Math.floor(o.x / 7) + Math.floor(o.y / 11)) % 3 : 0;
  const key = `ob|${known}|${o.variant || 0}|${Math.round(f.w)}|${Math.round(f.h)}|${o.rot || 0}|${o.blocksBalls === false ? 1 : 0}|${twist}|${f.circle ? 1 : 0}`;
  const pad = art.pad(f.w, f.h, o);
  const box = { x: -pad.l, y: -pad.t, w: f.w + pad.l + pad.r, h: f.h + pad.t + pad.b };
  return bank.get(key, box, (g) => {
    const rng = makeRng(hashString(key));
    art.paint(g, f.w, f.h, o, rng);
  }, 2);
}

// World-space anchor and painted bounds for culling and x-ray tests. Computed once per obstacle.
export function obstacleBounds(o) {
  const f = footprint(o);
  const art = ART[o.type] || FALLBACK;
  const pad = art.pad(f.w, f.h, o);
  return { ax: f.x, ay: f.y, x0: f.x - pad.l, y0: f.y - pad.t, x1: f.x + f.w + pad.r, y1: f.y + f.h + pad.b };
}

// Cast shadows are baked into the ground. Sun is up and left, so they fall down and right. Length
// follows the visible height rather than the physics height so a tall pine reads tall.
const CAST = { house: 96, tree: 74, pine: 88, schoolwall: 74, lamp: 64, car: 28, swing: 44, slide: 36, monkeybars: 42, fence: 30 };

export function paintObstacleShadow(g, o) {
  const f = footprint(o);
  const tall = CAST[o.type] ?? clamp((o.height || 30) * 0.8, 12, 60);
  const dx = tall * 0.46;
  const dy = tall * 0.2;
  const shadow = 'rgba(92,88,168,0.42)';
  const contact = 'rgba(78,74,150,0.42)';
  if (f.circle || o.type === 'tree' || o.type === 'pine' || o.type === 'lamp') {
    const r = Math.min(f.w, f.h) / 2;
    const cx = f.x + f.w / 2;
    const cy = f.y + f.h / 2;
    const thin = o.type === 'lamp' ? 0.6 : 1.5;
    const small = o.type === 'bush' || o.type === 'rock' ? 1 : 0.62;
    blurredFill(g, (p) => p.ellipse(cx + dx * 0.72, cy + dy * 0.72 + r * 0.1, r * thin + dx * 0.62, r * 0.6 * thin + dy * 0.3, 0.3, 0, TAU), 'rgba(96,92,176,0.3)', 16);
    blurredFill(g, (p) => p.ellipse(cx + 1, cy + r * 0.16, r * 1.1 * small, r * 0.54 * small, 0, 0, TAU), 'rgba(84,80,160,0.3)', 7);
    return;
  }
  blurredFill(g, (p) => {
    p.moveTo(f.x + 4, f.y + f.h - Math.min(f.h, 26));
    p.lineTo(f.x + f.w, f.y + f.h - Math.min(f.h, 26));
    p.lineTo(f.x + f.w + dx, f.y + f.h - Math.min(f.h, 26) + dy);
    p.lineTo(f.x + f.w + dx, f.y + f.h + dy);
    p.lineTo(f.x + dx * 0.4, f.y + f.h + dy);
    p.lineTo(f.x + 4, f.y + f.h);
    p.closePath();
  }, shadow, 12);
  blurredFill(g, (p) => roundedRect(p, f.x - 2, f.y + f.h - Math.min(f.h, 14), f.w + 4, Math.min(f.h, 14) + 5, 5), contact, 6);
}

// Where a building smokes and glows, in world space. `lights` are pools on the ground; maps may list
// their own, and these fill in whatever they leave out. `panes` are lit glass, which the night pass
// brings back up so windows shine while the wall around them goes dark.
export function obstacleExtras(o) {
  const f = footprint(o);
  const out = { lights: [], smoke: [], panes: [] };
  const pane = (x, y, w, h) => out.panes.push({ x: f.x + x + w / 2, y: f.y + y + h / 2, r: Math.max(w, h) * 1.1 });
  if (o.type === 'lamp') {
    out.lights.push({ x: f.x + f.w / 2, y: f.y + f.h / 2 + 1 - 92 - 8, r: 170, color: '#ffd98a', ground: { x: f.x + f.w / 2, y: f.y + f.h / 2 + 6 } });
  } else if (o.type === 'house') {
    if (o.rot === 90) {
      const wallH = clamp(f.w * 0.34, 42, 62);
      const eaveY = f.h - wallH;
      const peakY = eaveY - clamp(f.w * 0.34, 34, 62);
      const back = clamp(f.h * 0.52, 50, 96);
      const winH = clamp(wallH * 0.42, 16, 24);
      const winW = winH * 0.86;
      out.smoke.push({ x: f.x + f.w * 0.66 + 8, y: f.y + peakY - back * 0.72 - 12 });
      out.lights.push({ x: f.x + f.w * 0.5, y: f.y + f.h - 8, r: 120, color: '#ffc96e' });
      pane(f.w * 0.2 - winW / 2, eaveY + 6, winW, winH);
      pane(f.w * 0.8 - winW / 2, eaveY + 6, winW, winH);
    } else {
      const v = (o.variant || 0) % SIDING.length;
      const { eaveY, ridgeY } = houseMetrics(f.w, f.h);
      const chim = chimneyAt(v, f.w, ridgeY);
      out.smoke.push({ x: f.x + chim.x + 8, y: f.y + chim.y - 4 });
      out.lights.push({ x: f.x + f.w * 0.5, y: f.y + f.h - 8, r: Math.max(120, f.w * 0.72), color: '#ffc96e' });
      for (const p of houseFront(f.w, f.h, v).panes) pane(p.x, p.y, p.w, p.h);
      for (const t of dormerSpots(f.w, v)) pane(f.w * t - 9, lerp(ridgeY, eaveY, 0.58) + 5, 18, 14);
    }
  } else if (o.type === 'schoolwall' && !isVertical(o, f.w, f.h)) {
    const { gap, count, start, winH, winY } = schoolBays(f.w, f.h);
    for (let i = 0; i < count; i++) {
      if (i % SCHOOL_DOOR_EVERY !== 3 && i % 3 !== 1) pane(start + i * gap - 24, winY, 48, winH);
    }
  }
  return out;
}
