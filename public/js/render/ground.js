// The painted ground: soft snow, lilac drifts, roads, ice and all flat decor, baked once at setMap.
import { P, FONT_STACK } from './palette.js';
import {
  TAU, clamp, lerp, smoothstep, between, makeRng, hashString, mix, withAlpha, parseColor, makeCanvas, linear,
  softEllipse, blurredFill, roundedRect, fillRounded, closedCurve, taperedStroke, makeNoise, fbm, sampleSpline,
} from './paint.js';
import { paintObstacleShadow } from './obstacles.js';

const WIND = -0.34; // radians. Every drift and brush stroke leans the same way, as one storm left them.

// Each map gets its own light: the court is warm, the pond cold, the yard in between.
const THEMES = {
  court: { hi: '#fdfeff', mid: '#f4f6fd', low: '#e4e6f8', warm: '#fef8f3', rim: '#c9c8ea' },
  pond: { hi: '#fcfeff', mid: '#f0f5fd', low: '#dfe6f7', warm: '#f8f9fe', rim: '#bcc6ea' },
  yard: { hi: '#fefeff', mid: '#f5f6fd', low: '#e6e6f7', warm: '#fef7f5', rim: '#cccaea' },
};

function rampColor(stops, t) {
  const n = stops.length - 1;
  const f = clamp(t, 0, 0.9999) * n;
  const i = Math.floor(f);
  const k = f - i;
  const a = stops[i];
  const b = stops[i + 1];
  return [lerp(a[0], b[0], k), lerp(a[1], b[1], k), lerp(a[2], b[2], k)];
}

// Low-frequency colour is written as pixels at quarter size and upscaled, which is both fast and
// exactly the soft wash wanted here. Noise is stretched along the wind so it reads as drifts, not clouds.
function paintWash(g, map, theme, seed) {
  const qw = Math.ceil(map.w / 4);
  const qh = Math.ceil(map.h / 4);
  const small = makeCanvas(qw, qh);
  const sg = small.getContext('2d');
  const img = sg.createImageData(qw, qh);
  const noise = makeNoise(seed);
  const hue = makeNoise(seed ^ 0x9e3779b9);
  const ca = Math.cos(WIND);
  const sa = Math.sin(WIND);
  const stops = [theme.low, theme.mid, theme.hi].map(parseColor);
  const warm = parseColor(theme.warm);
  const data = img.data;
  for (let y = 0, p = 0; y < qh; y++) {
    for (let x = 0; x < qw; x++, p += 4) {
      const wx = x * 4;
      const wy = y * 4;
      const u = wx * ca + wy * sa;
      const v = -wx * sa + wy * ca;
      let t = fbm(noise, u * 0.0034, v * 0.0102, 4, 0.52);
      t = smoothstep(0.26, 0.74, t);
      const c = rampColor(stops, t);
      const w = smoothstep(0.45, 0.8, hue(u * 0.0016 + 3, v * 0.003)) * 0.55 * t;
      data[p] = lerp(c[0], warm[0], w);
      data[p + 1] = lerp(c[1], warm[1], w);
      data[p + 2] = lerp(c[2], warm[2], w);
      data[p + 3] = 255;
    }
  }
  sg.putImageData(img, 0, 0);
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';
  g.drawImage(small, 0, 0, map.w, map.h);
}

// A drift is a soft crest: bright where it faces the sun, lilac where it falls away.
function drift(g, x, y, len, thick, rot, strength = 1) {
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  const ox = -s * thick * 0.5;
  const oy = c * thick * 0.5;
  softEllipse(g, x + ox * 0.9, y + oy * 0.9, len, thick * 0.8, '#aeaee2', 0.2 * strength, rot);
  softEllipse(g, x - ox * 0.45, y - oy * 0.45, len * 0.92, thick * 0.74, '#ffffff', 0.7 * strength, rot, 0.25);
}

function paintDrifts(g, map, rng) {
  const area = map.w * map.h;
  const count = Math.round(area / 30000);
  for (let i = 0; i < count; i++) {
    const big = rng() < 0.45;
    const len = big ? between(rng, 170, 380) : between(rng, 50, 130);
    const thick = big ? between(rng, 34, 70) : between(rng, 12, 26);
    drift(g, rng() * map.w, rng() * map.h, len, thick, WIND + between(rng, -0.3, 0.3), big ? 0.9 : 0.6);
  }
}

// Long, thin, faint strokes that follow the wind: the visible hand in a painted background.
function paintBrushwork(g, map, rng) {
  const n = Math.round((map.w * map.h) / 2600);
  g.lineCap = 'round';
  for (let i = 0; i < n; i++) {
    const x = rng() * map.w;
    const y = rng() * map.h;
    const len = between(rng, 14, 70);
    const a = WIND + between(rng, -0.2, 0.2);
    const bend = between(rng, -7, 7);
    const dark = rng() < 0.36;
    g.strokeStyle = dark ? withAlpha('#b6b5e4', between(rng, 0.03, 0.08)) : withAlpha('#ffffff', between(rng, 0.14, 0.4));
    g.lineWidth = between(rng, 1.2, 4.6);
    g.beginPath();
    g.moveTo(x, y);
    g.quadraticCurveTo(x + Math.cos(a) * len * 0.5 - Math.sin(a) * bend, y + Math.sin(a) * len * 0.5 + Math.cos(a) * bend, x + Math.cos(a) * len, y + Math.sin(a) * len);
    g.stroke();
  }
}

function paintSparkles(g, map, rng) {
  const n = Math.round((map.w * map.h) / 520);
  for (let i = 0; i < n; i++) {
    const x = rng() * map.w;
    const y = rng() * map.h;
    const tint = rng();
    g.fillStyle = tint < 0.72 ? withAlpha('#ffffff', between(rng, 0.65, 1)) : tint < 0.9 ? withAlpha('#bfe2ff', between(rng, 0.5, 0.9)) : withAlpha('#f7dcf0', between(rng, 0.5, 0.9));
    const r = between(rng, 0.35, 0.95);
    g.beginPath();
    g.arc(x, y, r, 0, TAU);
    g.fill();
  }
  // A scatter of proper four-point glints for the crisp-noon look.
  const m = Math.round((map.w * map.h) / 9000);
  for (let i = 0; i < m; i++) {
    const x = rng() * map.w;
    const y = rng() * map.h;
    const r = between(rng, 1.6, 3.4);
    g.fillStyle = withAlpha('#ffffff', 0.95);
    g.beginPath();
    g.moveTo(x, y - r);
    g.quadraticCurveTo(x, y, x + r, y);
    g.quadraticCurveTo(x, y, x, y + r);
    g.quadraticCurveTo(x, y, x - r, y);
    g.quadraticCurveTo(x, y, x, y - r);
    g.fill();
  }
}

// ---- streets ----------------------------------------------------------------

function strokeLine(g, samples, width, color, offset = 0) {
  g.strokeStyle = color;
  g.lineWidth = width;
  g.beginPath();
  for (let i = 0; i < samples.length; i++) {
    const p = samples[i];
    const x = p.x + p.nx * offset;
    const y = p.y + p.ny * offset;
    if (i === 0) g.moveTo(x, y);
    else g.lineTo(x, y);
  }
  g.stroke();
}

// Every road is painted in shared layers (halo, surface, markings, kerbs) rather than one road at a
// time. Junctions then merge into a single street, where drawing them in turn would leave one road's
// snowbank lying across another's surface.
function paintRoads(g, roads, rng) {
  const lines = roads
    .map((d) => ({ width: d.width || 96, s: sampleSpline(d.points, 14) }))
    .filter((r) => r.s.length >= 2);
  if (!lines.length) return;
  g.lineCap = 'round';
  g.lineJoin = 'round';
  for (const r of lines) strokeLine(g, r.s, r.width + 70, withAlpha('#b8b6e4', 0.1));
  for (const r of lines) strokeLine(g, r.s, r.width + 16, '#fafbff');
  for (const r of lines) strokeLine(g, r.s, r.width + 5, '#c6c8ea');
  for (const r of lines) strokeLine(g, r.s, r.width, '#dcdff3');

  // Wheel ruts: thin, doubled and broken, so the street stays pale and never reads as a dark band.
  g.setLineDash([170, 60, 90, 44]);
  for (const r of lines) {
    for (const side of [-1, 1]) strokeLine(g, r.s, 7, withAlpha('#bcbee6', 0.42), side * r.width * 0.2);
  }
  g.setLineDash([]);

  // A dashed mustard line, half buried, gives the street some colour.
  g.setLineDash([26, 30]);
  g.lineCap = 'butt';
  for (const r of lines) strokeLine(g, r.s, 3.4, withAlpha('#ecc765', 0.75));
  g.setLineDash([]);
  g.lineCap = 'round';

  // Blown snow streaks crossing the surface.
  for (const { s, width } of lines) {
    for (let i = 0; i < s.length; i += 2) {
      const p = s[i];
      if (rng() < 0.55) {
        const off = between(rng, -0.5, 0.5) * width;
        const len = between(rng, 22, 70);
        softEllipse(g, p.x + p.nx * off, p.y + p.ny * off, len, between(rng, 4, 11), '#f6f8fe', between(rng, 0.4, 0.85), Math.atan2(p.nx, -p.ny) + between(rng, -0.2, 0.2));
      }
    }
  }

  // Kerbs: heaped lumps, so a road edge is never a clean vector line. A lump that would land on any
  // street's surface is dropped, which is what opens the mouth of every junction.
  const onSurface = (x, y) => {
    for (const r of lines) {
      const lim = r.width / 2 + 1;
      const lim2 = lim * lim;
      for (let i = 0; i < r.s.length; i += 2) {
        const dx = r.s[i].x - x;
        const dy = r.s[i].y - y;
        if (dx * dx + dy * dy < lim2) return true;
      }
    }
    return false;
  };
  const lumps = [];
  const runs = [];
  for (const { s, width } of lines) {
    for (const side of [-1, 1]) {
      let run = [];
      for (let i = 0; i < s.length; i++) {
        const p = s[i];
        const off = side * (width / 2 + 9);
        const pt = { x: p.x + p.nx * off, y: p.y + p.ny * off, nx: p.nx, ny: p.ny };
        if (onSurface(pt.x, pt.y)) {
          if (run.length > 1) runs.push(run);
          run = [];
          continue;
        }
        run.push(pt);
        const wob = side * between(rng, -4, 5);
        lumps.push([pt.x + p.nx * wob, pt.y + p.ny * wob, between(rng, 10, 17)]);
      }
      if (run.length > 1) runs.push(run);
    }
  }
  // Bank, then lumps: a solid ridge gives the kerb its body and the lumps only break up its outline.
  // All the shade goes down before any white, or each lump's shadow would land on its neighbour and
  // the bank would turn into a string of separate snowballs.
  for (const run of runs) {
    g.save();
    g.translate(2, 4.5);
    strokeLine(g, run, 22, withAlpha('#a8a8de', 0.36));
    g.restore();
  }
  for (const [x, y, r] of lumps) softEllipse(g, x + 2, y + 4.4, r * 1.25, r * 0.86, '#a4a4dc', 0.2);
  for (const run of runs) strokeLine(g, run, 21, '#ffffff');
  for (const [x, y, r] of lumps) softEllipse(g, x, y, r * 1.14, r * 0.84, '#ffffff', 1, 0, 0.7);
}

// A walked-in path is only slightly darker than the snow around it. It has to fade at both ends,
// because most paths in the maps stop dead in open ground and a hard end reads as a capsule.
function paintPath(g, d, rng) {
  const width = d.width || 40;
  const s = sampleSpline(d.points, 10);
  if (s.length < 2) return;
  g.lineCap = 'round';
  g.lineJoin = 'round';
  strokeLine(g, s, width + 22, withAlpha('#ffffff', 0.55));
  strokeLine(g, s, width + 7, withAlpha('#d6d8f0', 0.5));
  strokeLine(g, s, width, '#eceef9');
  for (let i = 0; i < s.length; i++) {
    const p = s[i];
    if (rng() < 0.4) softEllipse(g, p.x + between(rng, -width, width) * 0.34, p.y + between(rng, -width, width) * 0.34, between(rng, 5, 13), between(rng, 3, 6), '#d3d6ee', 0.42, rng() * TAU);
    // Snow pushed aside by boots: broad, soft and overlapping, so the edge reads as one low ridge.
    for (const side of [-1, 1]) {
      if (rng() < 0.7) {
        const off = side * (width / 2 + between(rng, 2, 7));
        softEllipse(g, p.x + p.nx * off, p.y + p.ny * off, between(rng, 10, 20), between(rng, 6, 10), '#ffffff', 0.8, Math.atan2(p.nx, -p.ny));
      }
    }
  }
  for (const end of [s[0], s[s.length - 1]]) softEllipse(g, end.x, end.y, width * 1.05, width * 1.05, '#f6f8fe', 1, 0, 0.45);
}

// ---- ice --------------------------------------------------------------------

function icePath(g, shape, grow = 0) {
  g.beginPath();
  if (shape.shape === 'ellipse') {
    g.ellipse(shape.x, shape.y, shape.rx + grow, shape.ry + grow, 0, 0, TAU);
  } else {
    roundedRect(g, shape.x - grow, shape.y - grow, shape.w + grow * 2, shape.h + grow * 2, 26 + grow);
  }
}

function iceBounds(s) {
  if (s.shape === 'ellipse') return { x: s.x - s.rx, y: s.y - s.ry, w: s.rx * 2, h: s.ry * 2 };
  return { x: s.x, y: s.y, w: s.w, h: s.h };
}

// All ice shapes share one rim pass and one surface pass, so where two shapes overlap the bank
// between them disappears and the pond reads as a single body of water.
function paintIce(g, map, rng) {
  const shapes = map.ice || [];
  if (!shapes.length) return;
  const unionPath = (grow) => {
    g.beginPath();
    for (const s of shapes) {
      if (s.shape === 'ellipse') {
        g.moveTo(s.x + s.rx + grow, s.y);
        g.ellipse(s.x, s.y, s.rx + grow, s.ry + grow, 0, 0, TAU);
      } else {
        roundedRect(g, s.x - grow, s.y - grow, s.w + grow * 2, s.h + grow * 2, 26 + grow);
      }
    }
  };

  // Outer lip of the bank: lilac shade falling toward the water, then a white crest.
  blurredFill(g, (p) => {
    for (const s of shapes) {
      if (s.shape === 'ellipse') {
        p.moveTo(s.x + s.rx + 26, s.y);
        p.ellipse(s.x, s.y, s.rx + 26, s.ry + 26, 0, 0, TAU);
      } else {
        roundedRect(p, s.x - 26, s.y - 26, s.w + 52, s.h + 52, 40);
      }
    }
  }, 'rgba(255,255,255,0.95)', 22);

  // Surface: one flat colour for the whole union, then a pale glow coming in from the true shoreline.
  // Per-shape gradients would leave a visible seam wherever two lobes overlap.
  g.save();
  unionPath(0);
  g.clip();
  g.fillStyle = '#8fd0ea';
  g.fillRect(0, 0, map.w, map.h);
  g.drawImage(shoreGlow(map, shapes), 0, 0, map.w, map.h);
  // Detail is scattered over the union by rejection sampling. Going shape by shape would pile it up
  // wherever lobes overlap, and the real pond is 34 overlapping lobes.
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const s of shapes) {
    const b = iceBounds(s);
    x0 = Math.min(x0, b.x);
    y0 = Math.min(y0, b.y);
    x1 = Math.max(x1, b.x + b.w);
    y1 = Math.max(y1, b.y + b.h);
  }
  const inUnion = (x, y) => shapes.some((s) => insideIce(s, x, y));
  const spot = () => {
    for (let tries = 0; tries < 24; tries++) {
      const x = between(rng, x0, x1);
      const y = between(rng, y0, y1);
      if (inUnion(x, y)) return [x, y];
    }
    return [x0, y0];
  };
  let hits = 0;
  for (let i = 0; i < 400; i++) if (inUnion(between(rng, x0, x1), between(rng, y0, y1))) hits++;
  const area = ((x1 - x0) * (y1 - y0) * hits) / 400;

  // Deep blue pools under clear black ice.
  for (let i = 0; i < area / 26000; i++) {
    const [x, y] = spot();
    softEllipse(g, x, y, between(rng, 60, 180), between(rng, 22, 60), '#6db8e0', between(rng, 0.14, 0.3), WIND + between(rng, -0.4, 0.4));
  }
  // Milky frost clouds.
  for (let i = 0; i < area / 24000; i++) {
    const [x, y] = spot();
    softEllipse(g, x, y, between(rng, 34, 120), between(rng, 12, 34), '#f4fcff', between(rng, 0.25, 0.55), WIND + between(rng, -0.5, 0.5));
  }
  // Wind-blown powder crossing the ice in wisps.
  g.lineCap = 'round';
  for (let i = 0; i < area / 22000; i++) {
    const [x, y] = spot();
    const len = between(rng, 40, 150);
    g.strokeStyle = withAlpha('#ffffff', between(rng, 0.25, 0.55));
    g.lineWidth = between(rng, 1.5, 6);
    g.beginPath();
    g.moveTo(x, y);
    g.quadraticCurveTo(x + len * 0.5, y + between(rng, -20, 2), x + len, y + len * Math.tan(WIND) * 0.4);
    g.stroke();
  }
  // Skate marks: short lazy arcs scratched into the surface, always in loose pairs.
  g.lineWidth = 0.8;
  for (let i = 0; i < area / 15000; i++) {
    const [x, y] = spot();
    const rx = between(rng, 26, 70);
    const start = rng() * TAU;
    const end = start + between(rng, 0.9, 2);
    const rot = rng() * TAU;
    g.strokeStyle = withAlpha('#ffffff', between(rng, 0.28, 0.55));
    for (const k of [1, 0.9]) {
      g.beginPath();
      g.ellipse(x, y, rx * k, rx * 0.46 * k, rot, start, end);
      g.stroke();
    }
  }
  // Pressure cracks: pale lightning that gives the eye something crisp to hold on to.
  for (let i = 0; i < area / 95000; i++) {
    const [x, y] = spot();
    crack(g, x, y, rng() * TAU, between(rng, 60, 170), 3, rng);
  }
  // Bubbles frozen on their way up.
  for (let i = 0; i < area / 2600; i++) {
    const [x, y] = spot();
    g.fillStyle = withAlpha('#ffffff', between(rng, 0.25, 0.65));
    g.beginPath();
    g.arc(x, y, between(rng, 0.6, 2), 0, TAU);
    g.fill();
  }
  // Sheen: broad diagonal bands, the strongest single cue that this surface is wet and hard.
  for (let i = 0; i < area / 60000 + 1; i++) {
    const [x, y] = spot();
    softEllipse(g, x, y, between(rng, 120, 280), between(rng, 8, 20), '#ffffff', 0.5, -0.72);
  }
  g.restore();

  for (const s of shapes) {
    const b = iceBounds(s);
    const per = Math.round((b.w + b.h) / 6);
    for (let i = 0; i < per; i++) {
      const p = edgePoint(s, rng());
      if (shapes.some((o) => o !== s && insideIce(o, p.x, p.y, -2))) continue;
      const r = between(rng, 7, 20);
      softEllipse(g, p.x + p.nx * r * 0.2 + 1.6, p.y + p.ny * r * 0.2 + 2.2, r * 1.1, r * 0.7, '#9fa2da', 0.22);
      softEllipse(g, p.x + p.nx * r * 0.4, p.y + p.ny * r * 0.4, r * 1.06, r * 0.74, '#ffffff', 0.95, 0, 0.5);
    }
  }
}

// Blurred inverse of the ice: strong at the bank, fading toward open water. Quarter size, because it
// has no detail and the blur is far cheaper there.
function shoreGlow(map, shapes) {
  const k = 0.25;
  const w = Math.ceil(map.w * k);
  const h = Math.ceil(map.h * k);
  const land = makeCanvas(w, h);
  const lg = land.getContext('2d');
  lg.fillStyle = '#fff';
  lg.fillRect(0, 0, w, h);
  lg.globalCompositeOperation = 'destination-out';
  lg.scale(k, k);
  lg.fillStyle = '#000';
  for (const s of shapes) {
    icePath(lg, s, 0);
    lg.fill();
  }
  const out = makeCanvas(w, h);
  const og = out.getContext('2d');
  const far = w * 3;
  og.shadowOffsetX = far;
  og.shadowBlur = 30;
  og.shadowColor = 'rgba(226,247,252,0.62)';
  og.drawImage(land, -far, 0);
  og.shadowBlur = 7;
  og.shadowColor = 'rgba(244,253,255,0.72)';
  og.drawImage(land, -far, 0);
  return out;
}

function edgePoint(s, t) {
  if (s.shape === 'ellipse') {
    const a = t * TAU;
    const x = Math.cos(a);
    const y = Math.sin(a);
    return { x: s.x + x * s.rx, y: s.y + y * s.ry, nx: x, ny: y };
  }
  const per = (s.w + s.h) * 2;
  let d = t * per;
  if (d < s.w) return { x: s.x + d, y: s.y, nx: 0, ny: -1 };
  d -= s.w;
  if (d < s.h) return { x: s.x + s.w, y: s.y + d, nx: 1, ny: 0 };
  d -= s.h;
  if (d < s.w) return { x: s.x + s.w - d, y: s.y + s.h, nx: 0, ny: 1 };
  d -= s.w;
  return { x: s.x, y: s.y + s.h - d, nx: -1, ny: 0 };
}

export function insideIce(s, x, y, grow = 0) {
  if (s.shape === 'ellipse') {
    const dx = (x - s.x) / (s.rx + grow);
    const dy = (y - s.y) / (s.ry + grow);
    return dx * dx + dy * dy <= 1;
  }
  return x >= s.x - grow && x <= s.x + s.w + grow && y >= s.y - grow && y <= s.y + s.h + grow;
}

function crack(g, x, y, ang, len, depth, rng) {
  let px = x;
  let py = y;
  g.strokeStyle = withAlpha('#ffffff', 0.8);
  g.lineWidth = 0.5 + depth * 0.32;
  g.beginPath();
  g.moveTo(px, py);
  const steps = Math.max(3, Math.round(len / 18));
  const branches = [];
  for (let i = 0; i < steps; i++) {
    ang += between(rng, -0.5, 0.5);
    px += Math.cos(ang) * (len / steps);
    py += Math.sin(ang) * (len / steps);
    g.lineTo(px, py);
    if (depth > 1 && rng() < 0.36) branches.push([px, py, ang + between(rng, -1, 1)]);
  }
  g.stroke();
  for (const [bx, by, ba] of branches) crack(g, bx, by, ba, len * 0.42, depth - 1, rng);
}

// ---- flat decor -------------------------------------------------------------

function paintSnowpatch(g, d, rng) {
  const n = Math.round((d.w * d.h) / 800) + 6;
  const cx = d.x + d.w / 2;
  const cy = d.y + d.h / 2;
  softEllipse(g, cx + 3, cy + 5, d.w * 0.6, d.h * 0.6, '#a9b4e0', 0.2);
  softEllipse(g, cx, cy, d.w * 0.58, d.h * 0.58, '#ffffff', 0.92, 0, 0.6);
  for (let i = 0; i < n; i++) {
    softEllipse(g, between(rng, d.x, d.x + d.w), between(rng, d.y, d.y + d.h), between(rng, 12, 36), between(rng, 5, 12), rng() < 0.3 ? '#cdd4f2' : '#ffffff', 0.5, WIND);
  }
}

function paintBridge(g, d, rng) {
  const along = d.w >= d.h; // planks lie across the direction of travel
  const cx = d.x + d.w / 2;
  const cy = d.y + d.h / 2;
  softEllipse(g, cx + 6, cy + 9, d.w * 0.6, d.h * 0.6, '#5f8fc4', 0.4);
  fillRounded(g, d.x, d.y, d.w, d.h, 6, '#a97c58');
  const n = Math.round((along ? d.w : d.h) / 15);
  for (let i = 0; i < n; i++) {
    const t = i / n;
    const col = mix(P.wood, P.woodLight, rng());
    if (along) {
      const x = d.x + t * d.w;
      fillRounded(g, x + 1, d.y - between(rng, 0, 2.5), d.w / n - 2, d.h + between(rng, 0, 5), 2, col);
    } else {
      const y = d.y + t * d.h;
      fillRounded(g, d.x - between(rng, 0, 2.5), y + 1, d.w + between(rng, 0, 5), d.h / n - 2, 2, col);
    }
  }
  // One thick strip of snow down the middle, with planks showing only along the rails. This is why
  // kids can pack snowballs here, and it has to look like a walkway, not scattered patches.
  const inset = (along ? d.h : d.w) * 0.14;
  const sx = d.x + (along ? -4 : inset);
  const sy = d.y + (along ? inset : -4);
  const sw = d.w - (along ? -8 : inset * 2);
  const sh = d.h - (along ? inset * 2 : -8);
  const edge = [];
  const stepsLong = Math.round((along ? sw : sh) / 22);
  for (let i = 0; i <= stepsLong; i++) {
    const t = i / stepsLong;
    edge.push(along ? [sx + sw * t, sy + between(rng, -5, 3)] : [sx + sw + between(rng, -3, 5), sy + sh * t]);
  }
  for (let i = stepsLong; i >= 0; i--) {
    const t = i / stepsLong;
    edge.push(along ? [sx + sw * t, sy + sh + between(rng, -3, 5)] : [sx + between(rng, -5, 3), sy + sh * t]);
  }
  g.save();
  g.translate(0, 3);
  g.beginPath();
  closedCurve(g, edge);
  g.fillStyle = 'rgba(86,64,92,0.34)';
  g.fill();
  g.restore();
  g.beginPath();
  closedCurve(g, edge);
  g.fillStyle = linear(g, d.x, d.y, d.x + d.w, d.y + d.h, ['#ffffff', '#f2f5fd', '#e4e9f8']);
  g.fill();
  g.save();
  g.clip();
  for (let i = 0; i < (d.w * d.h) / 2400; i++) {
    softEllipse(g, between(rng, d.x, d.x + d.w), between(rng, d.y, d.y + d.h), between(rng, 18, 46), between(rng, 6, 13), rng() < 0.5 ? '#d3d8f2' : '#ffffff', 0.55, along ? 0 : Math.PI / 2);
  }
  g.restore();
  // Rope edges.
  g.strokeStyle = '#7f5a44';
  g.lineWidth = 2.4;
  g.beginPath();
  if (along) {
    g.moveTo(d.x, d.y + 2);
    g.lineTo(d.x + d.w, d.y + 2);
    g.moveTo(d.x, d.y + d.h - 2);
    g.lineTo(d.x + d.w, d.y + d.h - 2);
  } else {
    g.moveTo(d.x + 2, d.y);
    g.lineTo(d.x + 2, d.y + d.h);
    g.moveTo(d.x + d.w - 2, d.y);
    g.lineTo(d.x + d.w - 2, d.y + d.h);
  }
  g.stroke();
}

function paintSled(g, x, y, s, rng) {
  g.save();
  g.translate(x, y);
  g.rotate(between(rng, -0.5, 0.5));
  g.scale(s, s);
  softEllipse(g, 3, 5, 34, 15, '#8f8fce', 0.4);
  fillRounded(g, -26, -9, 52, 18, 7, linear(g, 0, -9, 0, 9, ['#e5575c', '#b73a4c']));
  for (let i = -2; i <= 2; i++) fillRounded(g, i * 9 - 1, -8, 2, 16, 1, withAlpha('#7c2a3a', 0.4));
  g.strokeStyle = '#7d8ab0';
  g.lineWidth = 2;
  g.beginPath();
  g.moveTo(-28, -11);
  g.lineTo(26, -11);
  g.quadraticCurveTo(36, -11, 32, -3);
  g.moveTo(-28, 11);
  g.lineTo(26, 11);
  g.quadraticCurveTo(36, 11, 32, 3);
  g.stroke();
  softEllipse(g, -8, -2, 19, 7, '#ffffff', 0.92, 0, 0.4);
  g.restore();
}

function paintShovel(g, x, y, s, rng) {
  g.save();
  g.translate(x, y);
  g.rotate(between(rng, -1.1, 1.1));
  g.scale(s, s);
  softEllipse(g, 2, 4, 30, 8, '#8f8fce', 0.36);
  fillRounded(g, -26, -1.5, 34, 3, 1.5, P.woodLight);
  fillRounded(g, -30, -4, 8, 8, 3, P.woodDark);
  g.beginPath();
  g.moveTo(8, -9);
  g.lineTo(26, -11);
  g.quadraticCurveTo(31, 0, 26, 11);
  g.lineTo(8, 9);
  g.closePath();
  g.fillStyle = linear(g, 8, -10, 28, 10, ['#6ca0d4', '#3f6fae']);
  g.fill();
  softEllipse(g, 20, 2, 10, 8, '#ffffff', 0.9, 0, 0.3);
  g.restore();
}

function paintReeds(g, x, y, s, rng) {
  const n = Math.round(between(rng, 7, 12));
  softEllipse(g, x + 6, y + 6, 24 * s, 9 * s, '#8c8ccf', 0.25);
  for (let i = 0; i < n; i++) {
    const bx = x + between(rng, -18, 18) * s;
    const h = between(rng, 22, 42) * s;
    const lean = between(rng, -7, 7) * s;
    taperedStroke(g, bx, y + between(rng, -2, 5), bx + lean, y - h, 1.5 * s, 0.5 * s, lean * 0.3, mix('#b58a52', '#e0bf7a', rng()));
    if (rng() < 0.45) {
      g.fillStyle = '#6f4b3e';
      g.beginPath();
      g.ellipse(bx + lean, y - h, 1.8 * s, 4.6 * s, lean * 0.03, 0, TAU);
      g.fill();
      softEllipse(g, bx + lean - 0.3, y - h - 3 * s, 2.2 * s, 1.5 * s, '#ffffff', 0.95, 0, 0.6);
    }
  }
  softEllipse(g, x, y + 3, 24 * s, 7 * s, '#ffffff', 0.9, 0, 0.4);
}

function paintHopscotch(g, x, y, s) {
  // Chalk squares still showing where the snow has been scuffed away. Rows run away from the viewer.
  const layout = [[0, 0], [0, 1], [-0.5, 2], [0.5, 2], [0, 3], [-0.5, 4], [0.5, 4], [0, 5]];
  const cell = 26 * s;
  const chalk = ['#ee8aa8', '#7fb7ea', '#f2c14e', '#8fd6a8'];
  softEllipse(g, x, y - cell * 2.5, cell * 2, cell * 3.8, '#dfe3f4', 0.8);
  layout.forEach(([cx, row], i) => {
    const px = x + cx * cell - cell / 2;
    const py = y - (row + 1) * cell;
    g.lineWidth = 2.2 * s;
    g.strokeStyle = withAlpha(chalk[i % 4], 0.85);
    g.beginPath();
    roundedRect(g, px, py, cell, cell, 2);
    g.stroke();
    g.fillStyle = withAlpha(chalk[i % 4], 0.85);
    g.font = `700 ${Math.round(13 * s)}px ${FONT_STACK}`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(String(i + 1), px + cell / 2, py + cell / 2 + 0.5);
  });
}

function paintTiretracks(g, x, y, s, rng) {
  const len = 130 * s;
  const a = between(rng, -0.4, 0.4);
  g.save();
  g.translate(x, y);
  g.rotate(a);
  g.lineCap = 'round';
  for (const off of [-11 * s, 11 * s]) {
    const path = () => {
      g.beginPath();
      g.moveTo(-len, off);
      g.quadraticCurveTo(0, off + 12 * s, len, off - 4 * s);
    };
    g.strokeStyle = withAlpha('#bcbee6', 0.34);
    g.lineWidth = 6.5 * s;
    path();
    g.stroke();
    g.strokeStyle = withAlpha('#ffffff', 0.4);
    g.lineWidth = 1.3 * s;
    g.setLineDash([4 * s, 8 * s]);
    path();
    g.stroke();
    g.setLineDash([]);
  }
  g.restore();
}

function paintDecor(g, map, rng) {
  const list = map.decor || [];
  // Streets go down first so that later decor can sit on them.
  paintRoads(g, list.filter((d) => d.type === 'road'), rng);
  for (const d of list) if (d.type === 'path') paintPath(g, d, rng);
}

function paintDecorOverIce(g, map, rng) {
  for (const d of map.decor || []) {
    const s = d.scale || 1;
    switch (d.type) {
      case 'snowpatch': paintSnowpatch(g, d, rng); break;
      case 'bridge': paintBridge(g, d, rng); break;
      case 'sled': paintSled(g, d.x, d.y, s, rng); break;
      case 'shovel': paintShovel(g, d.x, d.y, s, rng); break;
      case 'reeds': paintReeds(g, d.x, d.y, s, rng); break;
      case 'drift': drift(g, d.x, d.y, 150 * s, 38 * s, WIND, 1); break;
      case 'hopscotch': paintHopscotch(g, d.x, d.y, s); break;
      case 'tiretracks': paintTiretracks(g, d.x, d.y, s, rng); break;
      default: break; // Unknown decor is skipped by contract: maps can run ahead of the art.
    }
  }
}

// Small stories in the snow: a sparrow hopped through here, a rabbit crossed there. Nobody needs
// them, and they are exactly what makes the ground feel like a place.
function paintAnimalTracks(g, map, rng) {
  const onIce = (x, y) => (map.ice || []).some((s) => insideIce(s, x, y, 30));
  const trails = Math.round((map.w * map.h) / 420000) + 2;
  for (let i = 0; i < trails; i++) {
    let x = rng() * map.w;
    let y = rng() * map.h;
    let a = rng() * TAU;
    const rabbit = rng() < 0.5;
    const steps = Math.round(between(rng, 12, 26));
    g.fillStyle = withAlpha('#a6a7da', 0.5);
    for (let k = 0; k < steps; k++) {
      a += between(rng, -0.3, 0.3);
      x += Math.cos(a) * (rabbit ? 26 : 11);
      y += Math.sin(a) * (rabbit ? 26 : 11);
      if (onIce(x, y)) continue;
      g.save();
      g.translate(x, y);
      g.rotate(a);
      if (rabbit) {
        for (const [px, py, rx, ry] of [[5, -4, 3.4, 1.7], [5, 4, 3.4, 1.7], [-3, 0, 1.8, 1.5], [-8, 0.8, 1.8, 1.5]]) {
          g.beginPath();
          g.ellipse(px, py, rx, ry, 0, 0, TAU);
          g.fill();
        }
      } else {
        g.lineWidth = 0.8;
        g.strokeStyle = withAlpha('#a6a7da', 0.55);
        const side = k % 2 ? 2 : -2;
        g.beginPath();
        g.moveTo(-2, side);
        g.lineTo(2.4, side);
        g.moveTo(0, side);
        g.lineTo(2, side + 1.6);
        g.moveTo(0, side);
        g.lineTo(2, side - 1.6);
        g.stroke();
      }
      g.restore();
    }
  }
}

// The map's outer limit reads as a heaped bank, not a hard stop at the canvas edge.
function paintBorder(g, map, theme, rng) {
  const band = 46;
  const lump = (x, y) => {
    const r = between(rng, 18, 44);
    softEllipse(g, x + 3, y + 5, r * 1.3, r, theme.rim, 0.42);
    softEllipse(g, x, y, r * 1.2, r * 0.92, '#ffffff', 0.92, 0, 0.42);
  };
  for (let x = -20; x < map.w + 20; x += 26) {
    lump(x, between(rng, -6, band * 0.3));
    lump(x, map.h - between(rng, -6, band * 0.3));
  }
  for (let y = -20; y < map.h + 20; y += 26) {
    lump(between(rng, -6, band * 0.3), y);
    lump(map.w - between(rng, -6, band * 0.3), y);
  }
}

// Baked at 1 px per world unit whatever the quality; low quality derives its copy by downsampling,
// so a mid-match drop to low costs one drawImage instead of a repaint.
export function bakeGround(map) {
  const seed = hashString(`ground|${map.id}|${map.w}x${map.h}`);
  const rng = makeRng(seed);
  const theme = THEMES[map.theme] || THEMES.court;
  // A cache never exceeds 4096 px a side; painters keep working in world units under this scale.
  const fit = Math.min(1, 4096 / Math.max(map.w, map.h));
  const c = makeCanvas(map.w * fit, map.h * fit);
  const g = c.getContext('2d', { alpha: false });
  g.scale(fit, fit);
  paintWash(g, map, theme, seed);
  paintDrifts(g, map, rng);
  paintBrushwork(g, map, rng);
  paintDecor(g, map, rng);
  paintAnimalTracks(g, map, rng);
  paintBorder(g, map, theme, rng);
  paintIce(g, map, rng);
  paintDecorOverIce(g, map, rng);
  for (const o of map.obstacles || []) paintObstacleShadow(g, o);
  paintSparkles(g, map, rng);
  return c;
}

// Shrinks a baked ground for low quality.
export function downsample(src, scale) {
  const c = makeCanvas(src.width * scale, src.height * scale);
  const g = c.getContext('2d', { alpha: false });
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';
  g.drawImage(src, 0, 0, c.width, c.height);
  return c;
}
