// Bake-time art for the ungraded screen pass: text sprites, edge arrows, lens splats, frost.
// Text is measured and rasterized once per distinct string; the frame only ever blits it.
import { FONT_STACK, P } from './palette.js';
import {
  TAU, between, clamp, makeCanvas, makeRng, withAlpha, mix, shadeOf, linear, radial, roundedRect, closedCurve,
  softEllipse, orb,
} from './paint.js';

const LIMIT = 220;

export class TextBank {
  constructor() {
    this.pr = 1;
    this.items = new Map();
    this.probe = makeCanvas(4, 4).getContext('2d');
  }

  setPixelRatio(pr) {
    if (pr === this.pr) return;
    this.pr = pr;
    this.items.clear();
  }

  through(key, build) {
    let sp = this.items.get(key);
    if (sp) return sp;
    if (this.items.size >= LIMIT) {
      // Map keeps insertion order, so the head holds the longest-unmade strings.
      let drop = 48;
      for (const k of this.items.keys()) {
        this.items.delete(k);
        if (--drop <= 0) break;
      }
    }
    sp = build();
    this.items.set(key, sp);
    return sp;
  }

  surface(w, h) {
    const c = makeCanvas(w * this.pr, h * this.pr);
    const g = c.getContext('2d');
    g.scale(this.pr, this.pr);
    return { c, g };
  }

  // Name pill with a coloured pip. Team and scarf colour live in the pip so the name stays legible.
  nameTag(name, color) {
    return this.through(`n|${name}|${color}`, () => {
      const font = `700 12px ${FONT_STACK}`;
      this.probe.font = font;
      const tw = Math.ceil(this.probe.measureText(name).width);
      const w = tw + 24;
      const h = 19;
      const { c, g } = this.surface(w, h);
      g.beginPath();
      roundedRect(g, 0.5, 0.5, w - 1, h - 1, 9);
      g.fillStyle = 'rgba(44,46,96,0.68)';
      g.fill();
      g.fillStyle = color;
      g.beginPath();
      g.arc(10, h / 2, 4, 0, TAU);
      g.fill();
      g.strokeStyle = 'rgba(255,255,255,0.85)';
      g.lineWidth = 1;
      g.stroke();
      g.font = font;
      g.textBaseline = 'middle';
      g.fillStyle = '#ffffff';
      g.fillText(name, 18, h / 2 + 0.5);
      return { canvas: c, w, h };
    });
  }

  // A speech bubble, tail included. `style`: bark, emote or loud (the Colonel is never quiet).
  bubble(text, style) {
    return this.through(`b|${style}|${text}`, () => {
      const loud = style === 'loud';
      const size = loud ? 15 : 13;
      const font = `${loud ? 800 : 700} ${size}px ${FONT_STACK}`;
      const maxW = loud ? 210 : 170;
      this.probe.font = font;
      const lines = wrapText(this.probe, text, maxW);
      let tw = 0;
      for (const l of lines) tw = Math.max(tw, this.probe.measureText(l).width);
      const padX = 11;
      const padY = 7;
      const lineH = size + 4;
      const bodyW = Math.ceil(tw) + padX * 2;
      const bodyH = lines.length * lineH + padY * 2;
      const tail = 9;
      const w = bodyW + 8;
      const h = bodyH + tail + 8;
      const { c, g } = this.surface(w, h);
      const x = 4;
      const y = 3;
      const path = () => {
        g.beginPath();
        roundedRect(g, x, y, bodyW, bodyH, 11);
        const cx = x + bodyW / 2;
        g.moveTo(cx - 7, y + bodyH - 1);
        g.quadraticCurveTo(cx + 1, y + bodyH + tail * 0.4, cx - 2, y + bodyH + tail);
        g.quadraticCurveTo(cx + 7, y + bodyH + tail * 0.5, cx + 9, y + bodyH - 1);
        g.closePath();
      };
      g.save();
      g.translate(0, 2.4);
      path();
      g.fillStyle = 'rgba(70,66,140,0.32)';
      g.fill();
      g.restore();
      path();
      g.fillStyle = style === 'emote' ? '#fff5c9' : loud ? '#fff3e0' : '#ffffff';
      g.fill();
      if (style === 'emote' || loud) {
        g.strokeStyle = style === 'emote' ? P.gold : P.carrot;
        g.lineWidth = 2;
        g.stroke();
      }
      g.font = font;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillStyle = P.ink;
      lines.forEach((l, i) => g.fillText(l, x + bodyW / 2, y + padY + lineH * (i + 0.5)));
      return { canvas: c, w, h };
    });
  }

  // Floating number. Heavy outline, because it has to read over white snow and dark night alike.
  label(text, style) {
    return this.through(`l|${style}|${text}`, () => {
      const cfg = LABELS[style] || LABELS.hit;
      const font = `800 ${cfg.size}px ${FONT_STACK}`;
      this.probe.font = font;
      const tw = Math.ceil(this.probe.measureText(text).width);
      const pad = 6;
      const w = tw + pad * 2;
      const h = cfg.size + pad * 2;
      const { c, g } = this.surface(w, h);
      g.font = font;
      g.textBaseline = 'middle';
      g.lineJoin = 'round';
      g.lineWidth = cfg.size * 0.26;
      g.strokeStyle = cfg.line;
      g.strokeText(text, pad, h / 2 + 1);
      g.fillStyle = cfg.fill;
      g.fillText(text, pad, h / 2 + 1);
      return { canvas: c, w, h };
    });
  }
}

const LABELS = {
  hit: { size: 16, fill: '#ffffff', line: '#4c4c92' },
  big: { size: 22, fill: '#ffe48c', line: '#a14d24' },
  hurt: { size: 18, fill: '#ffd0cc', line: '#b02a44' },
  flake: { size: 15, fill: '#e4f6ff', line: '#3b73b4' },
  warm: { size: 15, fill: '#fff0d0', line: '#c05a2c' },
};

function wrapText(g, text, maxW) {
  const words = String(text).split(/\s+/);
  const lines = [];
  let line = '';
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (line && g.measureText(next).width > maxW) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines.slice(0, 4);
}

// Pointer pinned to the screen edge. Drawn pointing right; rotated at use.
export function bakeEdgeArrow(color) {
  const size = 72;
  const c = makeCanvas(size, size);
  const g = c.getContext('2d');
  g.translate(size / 2, size / 2);
  const path = () => {
    g.beginPath();
    g.moveTo(32, 0);
    g.quadraticCurveTo(21, -9, 13, -17);
    g.arc(0, 0, 21.5, -0.92, 0.92, true);
    g.quadraticCurveTo(21, 9, 32, 0);
    g.closePath();
  };
  g.save();
  g.translate(0, 2);
  path();
  g.fillStyle = 'rgba(46,44,104,0.34)';
  g.fill();
  g.restore();
  path();
  g.fillStyle = orb(g, 0, 0, 28, [mix(color, '#ffffff', 0.32), color, shadeOf(color, 0.2)]);
  g.fill();
  g.beginPath();
  g.arc(0, 0, 16, 0, TAU);
  g.fillStyle = '#ffffff';
  g.fill();
  return c;
}

// Simple pictograms for what an arrow points at, in the same pale circle.
export function bakeEdgeGlyph(kind) {
  const size = 48;
  const c = makeCanvas(size, size);
  const g = c.getContext('2d');
  g.translate(size / 2, size / 2);
  if (kind === 'ice') {
    g.fillStyle = linear(g, -14, -14, 14, 14, ['#d8f6ff', '#6fc6ea']);
    g.beginPath();
    roundedRect(g, -13, -13, 26, 26, 6);
    g.fill();
    g.strokeStyle = '#ffffff';
    g.lineWidth = 3;
    g.lineCap = 'round';
    g.beginPath();
    g.moveTo(-7, 1);
    g.lineTo(1, -7);
    g.moveTo(-2, 7);
    g.lineTo(7, -2);
    g.stroke();
  } else if (kind === 'carrot') {
    g.rotate(0.6);
    g.beginPath();
    g.moveTo(-5, -12);
    g.quadraticCurveTo(0, -15, 5, -12);
    g.lineTo(1, 15);
    g.lineTo(-1, 15);
    g.closePath();
    g.fillStyle = P.carrot;
    g.fill();
    g.fillStyle = '#4c9c6c';
    g.beginPath();
    g.ellipse(-3, -16, 2.2, 5, -0.5, 0, TAU);
    g.ellipse(3, -16, 2.2, 5, 0.5, 0, TAU);
    g.fill();
  } else {
    // A foe marker: a plain mitten-red dot. Boss arrows swap in the sprite icon when one is available.
    g.fillStyle = orb(g, 0, 0, 13, ['#ff9a9a', '#e0505c', '#b03048']);
    g.beginPath();
    g.arc(0, 0, 12.5, 0, TAU);
    g.fill();
  }
  return c;
}

// Snow smacked onto the camera: a packed core thrown out into radial spikes, like a real splat on
// glass, with flecks beyond it and a couple of short runs of melt. The centre stays thin enough to
// read as stuck to the lens rather than a solid thing in the world.
export function bakeLensSplat(seed) {
  const size = 320;
  const c = makeCanvas(size, size);
  const g = c.getContext('2d');
  const rng = makeRng(seed);
  g.translate(size / 2, size / 2);
  const pts = [];
  const spikes = 11;
  for (let i = 0; i < spikes; i++) {
    const a = (i / spikes) * TAU + between(rng, -0.1, 0.1);
    const reach = between(rng, 92, 146);
    const valley = between(rng, 46, 62);
    const b = a + TAU / spikes / 2;
    // Each spike is a neck and a rounded head, so the outline flares instead of ending in a point.
    pts.push([Math.cos(a - 0.09) * reach * 0.76, Math.sin(a - 0.09) * reach * 0.76]);
    pts.push([Math.cos(a - 0.1) * reach, Math.sin(a - 0.1) * reach]);
    pts.push([Math.cos(a + 0.1) * reach, Math.sin(a + 0.1) * reach]);
    pts.push([Math.cos(a + 0.09) * reach * 0.76, Math.sin(a + 0.09) * reach * 0.76]);
    pts.push([Math.cos(b) * valley, Math.sin(b) * valley]);
  }
  g.save();
  g.translate(2, 5);
  g.beginPath();
  closedCurve(g, pts);
  g.fillStyle = 'rgba(104,104,190,0.3)';
  g.fill();
  g.restore();
  g.beginPath();
  closedCurve(g, pts);
  g.fillStyle = radial(g, -14, -18, 6, 150, [[0, '#ffffff'], [0.5, '#f8faff'], [1, '#d6dcf4']]);
  g.fill();
  g.save();
  g.clip();
  for (let i = 0; i < 7; i++) {
    softEllipse(g, between(rng, -60, 60), between(rng, -50, 60), between(rng, 14, 34), between(rng, 7, 16), '#c4cbee', 0.34, rng() * TAU);
  }
  softEllipse(g, -26, -30, 40, 20, '#ffffff', 1, -0.6);
  g.restore();
  for (let i = 0; i < 18; i++) {
    const a = rng() * TAU;
    const d = between(rng, 118, 154);
    const r = between(rng, 2.5, 8.5);
    const x = Math.cos(a) * d;
    const y = Math.sin(a) * d;
    g.beginPath();
    g.ellipse(x, y, r * 1.5, r, a, 0, TAU);
    g.fillStyle = radial(g, x - r * 0.3, y - r * 0.3, 0, r * 1.6, ['#ffffff', '#d7ddf5']);
    g.fill();
  }
  return c;
}

// Frost creeping in from the frame while frozen. Stretched to any screen, so it has no fine geometry
// that would visibly distort.
export function bakeFrost() {
  const w = 640;
  const h = 360;
  const c = makeCanvas(w, h);
  const g = c.getContext('2d');
  const rng = makeRng(901);
  const edge = (x, y) => {
    const rx = between(rng, 40, 120);
    const ry = between(rng, 30, 80);
    softEllipse(g, x, y, rx, ry, '#dff6ff', between(rng, 0.5, 0.85));
  };
  for (let i = 0; i < 44; i++) {
    edge(rng() * w, rng() < 0.5 ? 0 : h);
    edge(rng() < 0.5 ? 0 : w, rng() * h);
  }
  g.lineCap = 'round';
  const fern = (x, y, a, len, depth) => {
    if (depth <= 0 || len < 4) return;
    const ex = x + Math.cos(a) * len;
    const ey = y + Math.sin(a) * len;
    g.strokeStyle = withAlpha('#ffffff', clamp(0.3 + depth * 0.14, 0, 0.9));
    g.lineWidth = depth * 0.55;
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(ex, ey);
    g.stroke();
    const n = 3;
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      const px = x + (ex - x) * t;
      const py = y + (ey - y) * t;
      fern(px, py, a + 0.72, len * 0.42, depth - 1);
      fern(px, py, a - 0.72, len * 0.42, depth - 1);
    }
  };
  for (let i = 0; i < 26; i++) {
    const t = rng();
    const side = i % 4;
    const x = side === 0 ? t * w : side === 1 ? t * w : side === 2 ? 0 : w;
    const y = side === 0 ? 0 : side === 1 ? h : t * h;
    const inward = Math.atan2(h / 2 - y, w / 2 - x) + between(rng, -0.7, 0.7);
    fern(x, y, inward, between(rng, 44, 90), 3);
  }
  // Clear the centre so the frozen view is still playable to watch.
  g.globalCompositeOperation = 'destination-out';
  g.save();
  g.translate(w / 2, h / 2);
  g.scale(w / h, 1);
  g.fillStyle = radial(g, 0, 0, h * 0.22, h * 0.56, [[0, 'rgba(0,0,0,1)'], [1, 'rgba(0,0,0,0)']]);
  g.fillRect(-w, -h, w * 2, h * 2);
  g.restore();
  return c;
}
