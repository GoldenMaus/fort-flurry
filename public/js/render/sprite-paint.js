// Fort Flurry — shared palette and brushes for the character art.
// Everything here runs when a sprite is rasterized, never once per frame, so it can afford gradients
// and layered fills. The look is gouache on paper: no outlines, form comes from a light side and a
// lilac shadow side. Shadows lean towards plum instead of grey so characters sit in the same cold air
// as the snow, and the darkest value in the game is plum ink, never black.

export const TAU = Math.PI * 2;

export const INK = '#352e52';
export const SNOW_HI = '#ffffff';
export const SNOW = '#f1f5fc';
export const SNOW_MID = '#dbe3f4';
export const SNOW_LOW = '#b9bfe4';
export const LILAC = '#a9a2d6';
export const LILAC_DEEP = '#7f77b2';
export const ICE_HI = '#e9fbff';
export const ICE = '#a8e6f5';
export const ICE_DEEP = '#5fb9dc';
export const CARROT = '#f08a24';
export const CARROT_HI = '#ffb35c';
export const CARROT_LO = '#c9601a';
export const LEAF = '#5fae5b';
export const WOOD = '#a9774a';
export const WOOD_HI = '#cf9d68';
export const WOOD_LO = '#7a5238';
export const COCOA = '#7a4a2e';
export const CREAM = '#fbf1dc';
export const GOLD = '#f2c84b';
export const GOLD_LO = '#c9922c';
export const METAL = '#a9b6c8';
export const METAL_HI = '#dbe5ef';
export const METAL_LO = '#6f7f96';

const SHADOW_HUE = '#3f3572';
const LIGHT_HUE = '#fff8ec';

const rgbMemo = new Map();

export function rgbOf(hex) {
  let v = rgbMemo.get(hex);
  if (!v) {
    const n = parseInt(hex.slice(1), 16);
    v = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    rgbMemo.set(hex, v);
  }
  return v;
}

const hex2 = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');

export function mix(a, b, t) {
  const p = rgbOf(a), q = rgbOf(b);
  return `#${hex2(p[0] + (q[0] - p[0]) * t)}${hex2(p[1] + (q[1] - p[1]) * t)}${hex2(p[2] + (q[2] - p[2]) * t)}`;
}

// Positive lifts towards warm light, negative sinks towards lilac shadow.
export const tone = (c, t) => (t >= 0 ? mix(c, LIGHT_HUE, t) : mix(c, SHADOW_HUE, -t));

export function alpha(c, a) {
  const p = rgbOf(c);
  return `rgba(${p[0]},${p[1]},${p[2]},${a})`;
}

// Small deterministic generator: art must not shimmer between rebuilds, so tufts and dents are seeded.
export function seeded(seed) {
  let s = (seed * 2654435761) >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
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

export function ell(ctx, x, y, rx, ry, fill, rot = 0) {
  ctx.beginPath();
  ctx.ellipse(x, y, rx, ry, rot, 0, TAU);
  ctx.fillStyle = fill;
  ctx.fill();
}

export function poly(ctx, pts, fill) {
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.closePath();
  if (fill) { ctx.fillStyle = fill; ctx.fill(); }
}

export function line(ctx, x0, y0, x1, y1, color, w, cap = 'round') {
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.strokeStyle = color;
  ctx.lineWidth = w;
  ctx.lineCap = cap;
  ctx.stroke();
}

export function curve(ctx, x0, y0, cx, cy, x1, y1, color, w) {
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.quadraticCurveTo(cx, cy, x1, y1);
  ctx.strokeStyle = color;
  ctx.lineWidth = w;
  ctx.lineCap = 'round';
  ctx.stroke();
}

export function linGrad(ctx, x0, y0, x1, y1, stops) {
  const g = ctx.createLinearGradient(x0, y0, x1, y1);
  const n = stops.length - 1;
  for (let i = 0; i <= n; i++) {
    const s = stops[i];
    if (Array.isArray(s)) g.addColorStop(s[0], s[1]);
    else g.addColorStop(n ? i / n : 0, s);
  }
  return g;
}

// Light always falls from the upper left, so one diagonal ramp gives any form its shape.
export function litFill(ctx, x, y, rx, ry, base, hi = 0.2, lo = 0.26) {
  return linGrad(ctx, x - rx * 0.7, y - ry * 0.85, x + rx * 0.55, y + ry * 0.95,
    [tone(base, hi), base, tone(base, -lo)]);
}

export function capsulePath(ctx, x0, y0, r0, x1, y1, r1) {
  const a = Math.atan2(y1 - y0, x1 - x0);
  ctx.beginPath();
  ctx.arc(x0, y0, r0, a + Math.PI / 2, a - Math.PI / 2);
  ctx.arc(x1, y1, r1, a - Math.PI / 2, a + Math.PI / 2);
  ctx.closePath();
}

export function capsule(ctx, x0, y0, r0, x1, y1, r1, fill) {
  capsulePath(ctx, x0, y0, r0, x1, y1, r1);
  ctx.fillStyle = fill;
  ctx.fill();
}

export function roundRect(ctx, x, y, w, h, r) {
  const q = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + q, y);
  ctx.arcTo(x + w, y, x + w, y + h, q);
  ctx.arcTo(x + w, y + h, x, y + h, q);
  ctx.arcTo(x, y + h, x, y, q);
  ctx.arcTo(x, y, x + w, y, q);
  ctx.closePath();
}

// Catmull-Rom through the points: hand-placed silhouettes stay soft with no corner bookkeeping.
export function smoothPath(ctx, pts, closed = true, tension = 0.5) {
  const n = pts.length;
  const at = (i) => (closed ? pts[(i + n) % n] : pts[Math.max(0, Math.min(n - 1, i))]);
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  const last = closed ? n : n - 1;
  for (let i = 0; i < last; i++) {
    const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2);
    const k = tension / 3 * 2;
    ctx.bezierCurveTo(
      p1[0] + (p2[0] - p0[0]) * k / 2, p1[1] + (p2[1] - p0[1]) * k / 2,
      p2[0] - (p3[0] - p1[0]) * k / 2, p2[1] - (p3[1] - p1[1]) * k / 2,
      p2[0], p2[1]);
  }
  if (closed) ctx.closePath();
}

// A sphere without radial gradients: a lit ramp, then a soft crescent of bounced lilac and a highlight.
export function orb(ctx, x, y, r, base, opts = {}) {
  const { hi = 0.3, lo = 0.3, gloss = 0.5 } = opts;
  ell(ctx, x, y, r, r, litFill(ctx, x, y, r, r, base, hi, lo));
  if (gloss > 0) ell(ctx, x - r * 0.34, y - r * 0.38, r * 0.34, r * 0.24, alpha('#ffffff', gloss), -0.5);
}

export function snowball(ctx, x, y, r, opts = {}) {
  const { shade = SNOW_LOW } = opts;
  ell(ctx, x, y, r, r, linGrad(ctx, x - r * 0.7, y - r * 0.8, x + r * 0.6, y + r, [SNOW_HI, SNOW, shade]));
  ell(ctx, x - r * 0.3, y - r * 0.34, r * 0.32, r * 0.22, 'rgba(255,255,255,0.9)', -0.5);
}

// Clips to whatever path was just built, runs fn, then lets go. Shading stays inside its form.
export function clipped(ctx, fn) {
  ctx.save();
  ctx.clip();
  fn();
  ctx.restore();
}

export function star5(ctx, x, y, r, fill, rot = -Math.PI / 2, inner = 0.46) {
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const a = rot + (i * Math.PI) / 5;
    const q = i % 2 ? r * inner : r;
    if (i === 0) ctx.moveTo(x + Math.cos(a) * q, y + Math.sin(a) * q);
    else ctx.lineTo(x + Math.cos(a) * q, y + Math.sin(a) * q);
  }
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
}

// A carrot pointing along +x from (0,0), length len. The shared prop of Colonel, Thief and the card art.
export function paintCarrot(ctx, len, w, leaves = true) {
  if (leaves) {
    for (const [a, l] of [[2.7, 0.42], [3.14, 0.5], [3.58, 0.42]]) {
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.quadraticCurveTo(Math.cos(a) * l * len * 0.5 - 1, Math.sin(a) * l * len * 0.5 - w * 0.5,
        Math.cos(a) * l * len, Math.sin(a) * l * len);
      ctx.quadraticCurveTo(Math.cos(a) * l * len * 0.5 + 1, Math.sin(a) * l * len * 0.5 + w * 0.5, 0, 0);
      ctx.fillStyle = LEAF;
      ctx.fill();
    }
  }
  ctx.beginPath();
  ctx.moveTo(0, -w);
  ctx.quadraticCurveTo(len * 0.35, -w * 0.95, len, -w * 0.08);
  ctx.quadraticCurveTo(len + w * 0.2, 0, len, w * 0.08);
  ctx.quadraticCurveTo(len * 0.35, w * 0.95, 0, w);
  ctx.quadraticCurveTo(-w * 0.6, 0, 0, -w);
  ctx.fillStyle = linGrad(ctx, 0, -w, 0, w, [CARROT_HI, CARROT, CARROT_LO]);
  ctx.fill();
  ctx.lineCap = 'round';
  ctx.strokeStyle = alpha(CARROT_LO, 0.7);
  ctx.lineWidth = Math.max(0.5, w * 0.16);
  for (const [t, up] of [[0.22, 1], [0.42, -1], [0.62, 1]]) {
    ctx.beginPath();
    ctx.moveTo(len * t, up * w * (1 - t) * 0.86);
    ctx.lineTo(len * t + w * 0.4, up * w * (1 - t) * 0.1);
    ctx.stroke();
  }
}
