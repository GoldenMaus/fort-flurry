// Bake-time art for the weather and light passes: seamless snow tiles, light sprites, paper grain.
import { TAU, between, makeCanvas, makeRng, withAlpha, radial, linear, softEllipse } from './paint.js';

export const TILE = 512;

// Draw f at the point and at each wrap image near an edge, so scrolling never shows a seam.
function wrapped(x, y, reach, f) {
  const xs = [x];
  const ys = [y];
  if (x < reach) xs.push(x + TILE);
  else if (x > TILE - reach) xs.push(x - TILE);
  if (y < reach) ys.push(y + TILE);
  else if (y > TILE - reach) ys.push(y - TILE);
  for (const px of xs) for (const py of ys) f(px, py);
}

// Gentle ambient snowfall. Flakes are round and soft with a few larger near-camera ones.
export function bakeGentleTile(seed, count, big) {
  const c = makeCanvas(TILE, TILE);
  const g = c.getContext('2d');
  const rng = makeRng(seed);
  for (let i = 0; i < count; i++) {
    const x = rng() * TILE;
    const y = rng() * TILE;
    const near = rng() < 0.22;
    const r = near ? between(rng, big * 0.8, big) : between(rng, 0.7, big * 0.55);
    const a = near ? between(rng, 0.55, 0.85) : between(rng, 0.4, 0.82);
    wrapped(x, y, r * 3, (px, py) => {
      g.fillStyle = radial(g, px, py, 0, r * 1.8, [[0, withAlpha('#ffffff', a)], [0.5, withAlpha('#ffffff', a * 0.72)], [1, withAlpha('#ffffff', 0)]]);
      g.beginPath();
      g.arc(px, py, r * 1.8, 0, TAU);
      g.fill();
    });
  }
  return c;
}

// Blizzard: driven snow, not rain. Short soft dashes at a hard wind angle, plus round clumps tumbling
// among them. `ang` matches the direction the tile scrolls.
export function bakeBlizzardTile(seed, count, len, width, ang) {
  const c = makeCanvas(TILE, TILE);
  const g = c.getContext('2d');
  const rng = makeRng(seed);
  g.lineCap = 'round';
  const dx = Math.cos(ang);
  const dy = Math.sin(ang);
  for (let i = 0; i < count; i++) {
    const x = rng() * TILE;
    const y = rng() * TILE;
    const clump = rng() < 0.3;
    const l = clump ? 0 : between(rng, len * 0.45, len);
    const w = between(rng, width * 0.55, width) * (clump ? 1.5 : 1);
    const a = between(rng, 0.35, 0.95);
    const wob = between(rng, -0.16, 0.16);
    const ex = dx + wob * dy;
    const ey = dy - wob * dx;
    wrapped(x, y, l + w + 4, (px, py) => {
      if (clump) {
        g.fillStyle = radial(g, px, py, 0, w, [[0, withAlpha('#ffffff', a)], [0.6, withAlpha('#ffffff', a * 0.7)], [1, withAlpha('#ffffff', 0)]]);
        g.beginPath();
        g.arc(px, py, w, 0, TAU);
        g.fill();
        return;
      }
      g.strokeStyle = linear(g, px - ex * l, py - ey * l, px, py, [withAlpha('#ffffff', 0), withAlpha('#ffffff', a * 0.75), withAlpha('#ffffff', a)]);
      g.lineWidth = w;
      g.beginPath();
      g.moveTo(px - ex * l, py - ey * l);
      g.lineTo(px, py);
      g.stroke();
    });
  }
  return c;
}

// The pale curtain of driven snow. It stops the blizzard looking like lines over a clear picture.
export function bakeFogTile(seed) {
  const c = makeCanvas(TILE, TILE);
  const g = c.getContext('2d');
  const rng = makeRng(seed);
  for (let i = 0; i < 40; i++) {
    const x = rng() * TILE;
    const y = rng() * TILE;
    const rx = between(rng, 60, 170);
    const ry = between(rng, 24, 62);
    const a = between(rng, 0.25, 0.55);
    wrapped(x, y, rx + 4, (px, py) => softEllipse(g, px, py, rx, ry, '#f2f5fd', a, -0.5));
  }
  return c;
}

// A white radial light with a generous shoulder, for destination-out holes in the night mask.
export function bakeLightHole() {
  const c = makeCanvas(128, 128);
  const g = c.getContext('2d');
  g.fillStyle = radial(g, 64, 64, 0, 64, [[0, 'rgba(255,255,255,1)'], [0.3, 'rgba(255,255,255,0.88)'], [0.62, 'rgba(255,255,255,0.4)'], [1, 'rgba(255,255,255,0)']]);
  g.fillRect(0, 0, 128, 128);
  return c;
}

export function bakeGlow(color) {
  const c = makeCanvas(128, 128);
  const g = c.getContext('2d');
  g.fillStyle = radial(g, 64, 64, 0, 64, [[0, withAlpha(color, 0.9)], [0.22, withAlpha(color, 0.5)], [0.55, withAlpha(color, 0.16)], [1, withAlpha(color, 0)]]);
  g.fillRect(0, 0, 128, 128);
  return c;
}

// Watercolour paper. Near-white with a slow mottle and fine tooth; multiplied over the finished frame
// it pulls every object, every sprite and the ground into the same physical picture.
export function bakeGrain() {
  const size = 256;
  const c = makeCanvas(size, size);
  const g = c.getContext('2d');
  const img = g.createImageData(size, size);
  const rng = makeRng(4242);
  const data = img.data;
  // Fine tooth, then blurred into itself with a wrap so the tile has no edges.
  const base = new Float32Array(size * size);
  for (let i = 0; i < base.length; i++) base[i] = rng();
  const at = (x, y) => base[((y + size) % size) * size + ((x + size) % size)];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const soft = (at(x, y) * 2 + at(x + 1, y) + at(x - 1, y) + at(x, y + 1) + at(x, y - 1) + at(x + 2, y + 1) + at(x - 2, y - 1)) / 8;
      const v = 255 - Math.pow(Math.abs(soft - 0.5) * 2, 1.4) * 16;
      const p = (y * size + x) * 4;
      data[p] = v;
      data[p + 1] = v;
      data[p + 2] = Math.min(255, v + 3);
      data[p + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  return c;
}

// Corner darkening, drawn small and stretched: it is all low frequency.
export function bakeVignette() {
  const c = makeCanvas(128, 72);
  const g = c.getContext('2d');
  g.save();
  g.translate(64, 36);
  g.scale(1.78, 1);
  g.fillStyle = radial(g, 0, 0, 24, 66, [[0, 'rgba(58,52,120,0)'], [0.55, 'rgba(58,52,120,0.02)'], [1, 'rgba(50,44,112,0.22)']]);
  g.fillRect(-64, -36, 128, 72);
  g.restore();
  return c;
}

// Directional sky light, white with the shape carried in alpha; tinted when the air canvas is built.
// Sun falls from the top-left corner, matching the baked shadows; shade rises from the bottom right.
export function bakeSkyLight(corner) {
  const c = makeCanvas(128, 72);
  const g = c.getContext('2d');
  const x = corner === 'sun' ? 0 : 128;
  const y = corner === 'sun' ? 0 : 72;
  g.fillStyle = radial(g, x, y, 0, 152, [[0, 'rgba(255,255,255,1)'], [0.42, 'rgba(255,255,255,0.5)'], [1, 'rgba(255,255,255,0)']]);
  g.fillRect(0, 0, 128, 72);
  return c;
}
