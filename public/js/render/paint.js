// Painting toolbox for everything that is rasterized once and then blitted.
// Bake-time code lives here and in the other bake modules (ground, obstacles, structures, props,
// fxart, textart), because gradients and blurs are too slow for a frame. Modules that run every
// frame (renderer, fx, trails, atmosphere, overlay) must never reach for these directly.

export const TAU = Math.PI * 2;
export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

// mulberry32: bake output must be identical on every client and every rebuild, so sprites do not
// change shape when a resize re-rasterizes them.
export function makeRng(seed) {
  let s = (seed >>> 0) || 1;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashString(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export const between = (rng, a, b) => a + (b - a) * rng();
export const pick = (rng, list) => list[Math.floor(rng() * list.length) % list.length];

// ---- colour -----------------------------------------------------------------

export function parseColor(c) {
  if (Array.isArray(c)) return c;
  let h = c.startsWith('#') ? c.slice(1) : c;
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const toHex = (v) => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, '0');

export function mix(a, b, t) {
  const A = parseColor(a);
  const B = parseColor(b);
  return `#${toHex(lerp(A[0], B[0], t))}${toHex(lerp(A[1], B[1], t))}${toHex(lerp(A[2], B[2], t))}`;
}

export function withAlpha(c, a) {
  const [r, g, b] = parseColor(c);
  return `rgba(${r},${g},${b},${a})`;
}

// Painted shadows go toward lilac and highlights toward warm cream rather than black and white,
// which is most of what makes a flat fill read as gouache instead of vector clip art.
export const shadeOf = (c, t = 0.3) => mix(c, '#4b4a8c', t);
export const lightOf = (c, t = 0.3) => mix(c, '#fff6e6', t);

// ---- canvases ---------------------------------------------------------------

export function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.ceil(w));
  c.height = Math.max(1, Math.ceil(h));
  return c;
}

// ---- gradients --------------------------------------------------------------

function addStops(grad, stops) {
  for (let i = 0; i < stops.length; i++) {
    const s = stops[i];
    if (Array.isArray(s)) grad.addColorStop(s[0], s[1]);
    else grad.addColorStop(stops.length === 1 ? 0 : i / (stops.length - 1), s);
  }
  return grad;
}

export const linear = (g, x0, y0, x1, y1, stops) => addStops(g.createLinearGradient(x0, y0, x1, y1), stops);
export const radial = (g, x, y, r0, r1, stops) => addStops(g.createRadialGradient(x, y, r0, x, y, r1), stops);

// Off-centre highlight used for every rounded form, so all objects agree the sun is up and left.
export const orb = (g, x, y, r, stops) =>
  addStops(g.createRadialGradient(x - r * 0.35, y - r * 0.4, r * 0.05, x, y, r * 1.05), stops);

// A soft elliptical stain with a radial falloff.
export function softEllipse(g, x, y, rx, ry, color, a = 1, rot = 0, core = 0) {
  g.save();
  g.translate(x, y);
  if (rot) g.rotate(rot);
  g.scale(rx, ry);
  g.fillStyle = radial(g, 0, 0, 0, 1, [[0, withAlpha(color, a)], [core, withAlpha(color, a)], [1, withAlpha(color, 0)]]);
  g.beginPath();
  g.arc(0, 0, 1, 0, TAU);
  g.fill();
  g.restore();
}

// Blurs any shape without ctx.filter (absent on Safari 16): the shape is drawn far off-canvas and
// only its shadow, which is unaffected by the transform, lands on the bitmap.
export function blurredFill(g, path, color, blur) {
  const far = 30000;
  g.save();
  g.shadowColor = color;
  g.shadowBlur = blur;
  g.shadowOffsetX = far;
  g.shadowOffsetY = 0;
  g.fillStyle = '#000';
  g.translate(-far, 0);
  g.beginPath();
  path(g);
  g.fill();
  g.restore();
}

// ---- paths ------------------------------------------------------------------

export function roundedRect(g, x, y, w, h, r) {
  const [tl, tr, br, bl] = Array.isArray(r) ? r : [r, r, r, r];
  g.moveTo(x + tl, y);
  g.lineTo(x + w - tr, y);
  g.quadraticCurveTo(x + w, y, x + w, y + tr);
  g.lineTo(x + w, y + h - br);
  g.quadraticCurveTo(x + w, y + h, x + w - br, y + h);
  g.lineTo(x + bl, y + h);
  g.quadraticCurveTo(x, y + h, x, y + h - bl);
  g.lineTo(x, y + tl);
  g.quadraticCurveTo(x, y, x + tl, y);
  g.closePath();
}

export function fillRounded(g, x, y, w, h, r, fill) {
  g.beginPath();
  roundedRect(g, x, y, w, h, r);
  g.fillStyle = fill;
  g.fill();
}

// Smooth closed outline through a point list. Everything organic in the game is built from this,
// because a hard corner anywhere breaks the storybook softness.
export function closedCurve(g, pts) {
  const n = pts.length;
  const a0 = pts[n - 1];
  const b0 = pts[0];
  g.moveTo((a0[0] + b0[0]) / 2, (a0[1] + b0[1]) / 2);
  for (let i = 0; i < n; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    g.quadraticCurveTo(a[0], a[1], (a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
  }
  g.closePath();
}

export function blobPoints(cx, cy, rx, ry, rng, wobble = 0.12, n = 10) {
  const pts = [];
  const start = rng() * TAU;
  for (let i = 0; i < n; i++) {
    const a = start + (i / n) * TAU;
    const k = 1 + (rng() * 2 - 1) * wobble;
    pts.push([cx + Math.cos(a) * rx * k, cy + Math.sin(a) * ry * k]);
  }
  return pts;
}

export function blob(g, cx, cy, rx, ry, rng, fill, wobble = 0.12, n = 10) {
  g.beginPath();
  closedCurve(g, blobPoints(cx, cy, rx, ry, rng, wobble, n));
  if (fill) {
    g.fillStyle = fill;
    g.fill();
  }
}

// A tapered, slightly bent stroke: the unit of branches, chalk and hand-drawn cracks.
export function taperedStroke(g, x0, y0, x1, y1, w0, w1, bend, color) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len;
  const ny = dx / len;
  const mx = (x0 + x1) / 2 + nx * bend;
  const my = (y0 + y1) / 2 + ny * bend;
  g.beginPath();
  g.moveTo(x0 + nx * w0 * 0.5, y0 + ny * w0 * 0.5);
  g.quadraticCurveTo(mx + nx * (w0 + w1) * 0.25, my + ny * (w0 + w1) * 0.25, x1 + nx * w1 * 0.5, y1 + ny * w1 * 0.5);
  g.lineTo(x1 - nx * w1 * 0.5, y1 - ny * w1 * 0.5);
  g.quadraticCurveTo(mx - nx * (w0 + w1) * 0.25, my - ny * (w0 + w1) * 0.25, x0 - nx * w0 * 0.5, y0 - ny * w0 * 0.5);
  g.closePath();
  g.fillStyle = color;
  g.fill();
}

// ---- snow -------------------------------------------------------------------

const SNOW_TOP = '#ffffff';
const SNOW_LOW = '#e4ebfa';
const SNOW_UNDER = '#b4b6e2';

// A pillow of snow resting on a surface from x0 to x1 with its underside at y. Domed top, drooping
// scalloped lip, lilac contact shadow beneath. Used on every roof, branch and post in the game so
// that all of it feels like it fell in the same storm.
export function snowCap(g, x0, x1, y, thick, rng, opts = {}) {
  const { droop = 3, lumps = 0, under = SNOW_UNDER, dome = 0.55 } = opts;
  const width = x1 - x0;
  const n = lumps || clamp(Math.round(width / 16), 2, 12);
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const curve = Math.pow(Math.sin(Math.PI * t), dome);
    pts.push([lerp(x0, x1, t), y - thick * curve * between(rng, 0.84, 1.1)]);
  }
  const m = n + 1;
  for (let i = m; i >= 0; i--) {
    const t = i / m;
    const scallop = i % 2 ? between(rng, 0.8, 1.35) : between(rng, 0.05, 0.4);
    pts.push([lerp(x0 - 0.5, x1 + 0.5, t), y + droop * scallop]);
  }
  g.save();
  g.translate(0.5, droop * 0.45 + 0.7);
  g.beginPath();
  closedCurve(g, pts);
  g.fillStyle = withAlpha(under, 0.75);
  g.fill();
  g.restore();
  g.beginPath();
  closedCurve(g, pts);
  g.fillStyle = linear(g, 0, y - thick, 0, y + droop, [[0, SNOW_TOP], [0.62, '#f6f9ff'], [1, SNOW_LOW]]);
  g.fill();
}

// A lumpy snow skirt along the foot of something, so nothing sits on the ground like a sticker.
export function snowBank(g, x0, x1, y, height, rng, opts = {}) {
  const { step = 13, under = SNOW_UNDER } = opts;
  const pts = [[x0 - 4, y + height * 0.5]];
  for (let x = x0; x <= x1 + 0.01; x += step) {
    pts.push([x, y - height * between(rng, 0.45, 1.05)]);
    pts.push([x + step * 0.5, y - height * between(rng, 0.2, 0.6)]);
  }
  pts.push([x1 + 4, y + height * 0.5]);
  pts.push([x1 - (x1 - x0) * 0.25, y + height * 0.9]);
  pts.push([x0 + (x1 - x0) * 0.25, y + height * 0.9]);
  g.save();
  g.translate(0, -1.1);
  g.beginPath();
  closedCurve(g, pts);
  g.fillStyle = withAlpha(under, 0.55);
  g.fill();
  g.restore();
  g.beginPath();
  closedCurve(g, pts);
  g.fillStyle = linear(g, 0, y - height, 0, y + height, [[0, '#ffffff'], [0.7, '#f1f5fd'], [1, withAlpha('#e6ecfa', 0.2)]]);
  g.fill();
}

// A narrow ridge of snow running up the screen, for the feet of things seen edge-on. One continuous
// shape: a row of separate lumps reads as a string of pearls.
export function snowRidge(g, x, y0, y1, half, rng) {
  const pts = [];
  const steps = Math.max(2, Math.round((y1 - y0) / 11));
  for (let i = 0; i <= steps; i++) pts.push([x - half * between(rng, 0.6, 1.15), lerp(y0, y1, i / steps)]);
  for (let i = steps; i >= 0; i--) pts.push([x + half * between(rng, 0.6, 1.15), lerp(y0, y1, i / steps)]);
  g.save();
  g.translate(1.2, 1.5);
  g.beginPath();
  closedCurve(g, pts);
  g.fillStyle = withAlpha(SNOW_UNDER, 0.5);
  g.fill();
  g.restore();
  g.beginPath();
  closedCurve(g, pts);
  g.fillStyle = linear(g, x - half, 0, x + half, 0, ['#ffffff', '#f6f8fe', '#e0e5f6']);
  g.fill();
}

// A small snow mound for round things (trunks, posts).
export function snowMound(g, cx, cy, rx, ry, rng) {
  g.beginPath();
  closedCurve(g, blobPoints(cx, cy, rx, ry, rng, 0.1, 9));
  g.fillStyle = radial(g, cx - rx * 0.2, cy - ry * 0.5, 0, Math.max(rx, ry) * 1.1, [[0, '#ffffff'], [0.65, '#f2f6fe'], [1, withAlpha('#dfe6f8', 0.15)]]);
  g.fill();
}

// ---- noise ------------------------------------------------------------------

export function makeNoise(seed) {
  const rng = makeRng(seed);
  const table = new Float32Array(1024);
  for (let i = 0; i < 1024; i++) table[i] = rng();
  const at = (ix, iy) => table[((ix * 73 + iy * 179 + ((ix * iy) & 31) * 31) & 1023)];
  return (x, y) => {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    let fx = x - ix;
    let fy = y - iy;
    fx = fx * fx * (3 - 2 * fx);
    fy = fy * fy * (3 - 2 * fy);
    const a = lerp(at(ix, iy), at(ix + 1, iy), fx);
    const b = lerp(at(ix, iy + 1), at(ix + 1, iy + 1), fx);
    return lerp(a, b, fy);
  };
}

export function fbm(noise, x, y, octaves = 4, gain = 0.5) {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let f = 1;
  for (let i = 0; i < octaves; i++) {
    sum += noise(x * f + i * 17.3, y * f - i * 9.1) * amp;
    norm += amp;
    amp *= gain;
    f *= 2.03;
  }
  return sum / norm;
}

// ---- splines ----------------------------------------------------------------

// Catmull-Rom resample of an authored polyline, carrying normals, so a road with four points can
// still have soft bends and banks that follow it. A polyline whose ends coincide is treated as a loop.
export function sampleSpline(points, step = 10) {
  const out = [];
  if (!points || points.length < 2) return out;
  const first = points[0];
  const last = points[points.length - 1];
  const loop = points.length > 3 && first.x === last.x && first.y === last.y;
  const P = loop ? points.slice(0, -1) : points;
  const n = P.length;
  const get = (i) => (loop ? P[((i % n) + n) % n] : P[clamp(i, 0, n - 1)]);
  const spans = loop ? n : n - 1;
  for (let i = 0; i < spans; i++) {
    const p0 = get(i - 1);
    const p1 = get(i);
    const p2 = get(i + 1);
    const p3 = get(i + 2);
    const seg = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    const steps = Math.max(2, Math.ceil(seg / step));
    for (let k = 0; k < steps; k++) {
      const t = k / steps;
      const t2 = t * t;
      const t3 = t2 * t;
      const x = 0.5 * (2 * p1.x + (p2.x - p0.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (3 * p1.x - p0.x - 3 * p2.x + p3.x) * t3);
      const y = 0.5 * (2 * p1.y + (p2.y - p0.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (3 * p1.y - p0.y - 3 * p2.y + p3.y) * t3);
      out.push({ x, y, nx: 0, ny: 0 });
    }
  }
  const end = loop ? out[0] : last;
  out.push({ x: end.x, y: end.y, nx: 0, ny: 0 });
  for (let i = 0; i < out.length; i++) {
    const a = out[Math.max(0, i - 1)];
    const b = out[Math.min(out.length - 1, i + 1)];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const d = Math.hypot(dx, dy) || 1;
    out[i].nx = -dy / d;
    out[i].ny = dx / d;
  }
  return out;
}
