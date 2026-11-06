// Canvas previews: kids drawn through sprites.js, and little storybook maps drawn from map data.
import { drawKid, iconCanvas } from '../render/sprites.js';
import { el } from './dom.js';

const dpr = () => Math.min(globalThis.devicePixelRatio || 1, 2);

function fit(canvas, w, h) {
  const r = dpr();
  const pw = Math.round(w * r);
  const ph = Math.round(h * r);
  if (canvas.width !== pw) canvas.width = pw;
  if (canvas.height !== ph) canvas.height = ph;
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(r, 0, 0, r, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return ctx;
}

// drawKid anchors at the feet of a roughly 55-unit-tall kid, so scale and baseline come from the box.
export function paintKid(canvas, look, { w = 96, h = 104, team, pose = 'idle', dir, frame } = {}) {
  const ctx = fit(canvas, w, h);
  const scale = (h * 0.8) / 56;
  drawKid(ctx, look, w / 2, h * 0.9, scale, { team, pose, dir, frame });
}

export function kidCanvas(look, opts = {}) {
  const canvas = el('canvas', { class: 'kid-canvas', 'aria-hidden': 'true' });
  paintKid(canvas, look, opts);
  return canvas;
}

// Copied, because sprites may hand back a shared cached canvas, and one node can only sit in one
// place in the DOM.
export function iconNode(name, px, cls = '') {
  const c = el('canvas', { class: `icon ${cls}`, 'aria-hidden': 'true' });
  const r = dpr();
  c.width = Math.round(px * r);
  c.height = Math.round(px * r);
  c.style.width = `${px}px`;
  c.style.height = `${px}px`;
  try {
    const src = iconCanvas(name, px);
    if (src?.width) c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
  } catch (err) {
    console.warn('icon failed', name, err);
  }
  return c;
}

const THEME = {
  court: { ground: '#f4f6fd', block: '#b7bde6', road: '#d7dcf2' },
  pond: { ground: '#eaf3f4', block: '#8fa8c9', road: '#ffffff' },
  yard: { ground: '#f6f2fa', block: '#bfa9d8', road: '#e4dbf0' },
};

export function paintMap(canvas, map, w, h) {
  const ctx = fit(canvas, w, h);
  const theme = THEME[map.theme] ?? THEME.court;
  const s = Math.min(w / map.w, h / map.h);
  const ox = (w - map.w * s) / 2;
  const oy = (h - map.h * s) / 2;
  ctx.fillStyle = theme.ground;
  ctx.fillRect(0, 0, w, h);
  ctx.save();
  ctx.translate(ox, oy);
  ctx.scale(s, s);

  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const d of map.decor ?? []) {
    if ((d.type === 'road' || d.type === 'path') && d.points?.length) {
      ctx.strokeStyle = theme.road;
      ctx.lineWidth = d.width ?? 60;
      ctx.beginPath();
      d.points.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.stroke();
    }
  }

  ctx.fillStyle = '#bfe3ef';
  for (const ice of map.ice ?? []) {
    ctx.beginPath();
    if (ice.shape === 'ellipse') ctx.ellipse(ice.x, ice.y, ice.rx, ice.ry, 0, 0, Math.PI * 2);
    else ctx.roundRect(ice.x, ice.y, ice.w, ice.h, 20);
    ctx.fill();
  }

  for (const o of map.obstacles ?? []) {
    ctx.fillStyle = o.type === 'pine' || o.type === 'tree' || o.type === 'bush' ? '#7fa8a0' : theme.block;
    ctx.beginPath();
    const circle = o.r !== undefined && o.w === undefined;
    if (circle) ctx.arc(o.x, o.y, Math.max(o.r, 18), 0, Math.PI * 2);
    else ctx.roundRect(o.x, o.y, o.w ?? 40, o.h ?? 40, 10);
    ctx.fill();
  }

  ctx.fillStyle = '#d6404e';
  ctx.beginPath();
  ctx.arc(map.fort.x, map.fort.y, 58, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.beginPath();
  ctx.arc(map.fort.x, map.fort.y, 26, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}
