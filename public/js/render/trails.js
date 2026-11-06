// Marks left in the snow. Two low-resolution layers: stamps go to the newer one, the older fades out
// over FADE_S and is then wiped and reused, so every mark lives for 60 to 120 seconds and the cost is
// always two blits however long the match runs.
import { ACTOR, AFLAG } from '../../shared/schema.js';

const FADE_S = 60;
const TAU = Math.PI * 2;
const DENT = 'rgba(164,164,222,0.5)';
const DENT_DEEP = 'rgba(138,138,208,0.34)';
const RIM = 'rgba(255,255,255,0.75)';
const SKATE = 'rgba(255,255,255,0.7)';

function makeLayer(w, h) {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext('2d');
  g.lineCap = 'round';
  g.lineJoin = 'round';
  return { canvas, g };
}

export class Trails {
  constructor() {
    this.map = null;
    this.older = null;
    this.newer = null;
    this.age = 0;
    this.scale = 0.5;
    this.track = new Map(); // actor id -> last stamp, for stride spacing
    this.gen = 0;
    this.isIce = () => false;
  }

  setMap(map, scale, isIce) {
    this.map = map;
    this.scale = scale;
    this.isIce = isIce;
    this.age = 0;
    this.track.clear();
    const w = Math.ceil(map.w * scale);
    const h = Math.ceil(map.h * scale);
    this.older = makeLayer(w, h);
    this.newer = makeLayer(w, h);
    this.prepare(this.newer);
  }

  // Quality changes must not erase what is already in the snow, so the layers are resampled.
  setScale(scale) {
    if (!this.map || scale === this.scale) return;
    const w = Math.ceil(this.map.w * scale);
    const h = Math.ceil(this.map.h * scale);
    for (const name of ['older', 'newer']) {
      const next = makeLayer(w, h);
      next.g.drawImage(this[name].canvas, 0, 0, w, h);
      this[name] = next;
    }
    this.scale = scale;
    this.prepare(this.newer);
  }

  prepare(layer) {
    layer.g.setTransform(this.scale, 0, 0, this.scale, 0, 0);
  }

  update(dt) {
    this.age += dt;
    if (this.age >= FADE_S) {
      this.age = 0;
      const wiped = this.older;
      wiped.g.setTransform(1, 0, 0, 1, 0, 0);
      wiped.g.clearRect(0, 0, wiped.canvas.width, wiped.canvas.height);
      this.older = this.newer;
      this.newer = wiped;
      this.prepare(this.newer);
    }
  }

  draw(ctx) {
    const { map } = this;
    if (!map) return;
    const fade = 1 - this.age / FADE_S;
    if (fade > 0.002) {
      ctx.globalAlpha = fade;
      ctx.drawImage(this.older.canvas, 0, 0, map.w, map.h);
    }
    ctx.globalAlpha = 1;
    ctx.drawImage(this.newer.canvas, 0, 0, map.w, map.h);
  }

  // ---- stamps ---------------------------------------------------------------

  boot(x, y, ang, size) {
    const g = this.newer.g;
    const c = Math.cos(ang);
    const s = Math.sin(ang);
    const dent = () => {
      g.beginPath();
      g.ellipse(x, y, size * 1.25, size * 0.72, ang, 0, TAU);
      g.fill();
    };
    g.fillStyle = DENT;
    dent();
    // Pressed snow heaps up on the side away from the light.
    g.strokeStyle = RIM;
    g.lineWidth = size * 0.3;
    g.beginPath();
    g.ellipse(x + 0.4, y + size * 0.4, size * 1.2, size * 0.7, ang, 0.2, 2.6);
    g.stroke();
    g.fillStyle = DENT_DEEP;
    g.beginPath();
    g.ellipse(x + c * size * 0.3, y + s * size * 0.3, size * 0.6, size * 0.36, ang, 0, TAU);
    g.fill();
  }

  band(x0, y0, x1, y1, width, color) {
    const g = this.newer.g;
    g.strokeStyle = color;
    g.lineWidth = width;
    g.beginPath();
    g.moveTo(x0, y0);
    g.lineTo(x1, y1);
    g.stroke();
  }

  slide(x0, y0, x1, y1, width = 20) {
    this.band(x0, y0, x1, y1, width, 'rgba(178,178,230,0.2)');
    const dx = x1 - x0;
    const dy = y1 - y0;
    const d = Math.hypot(dx, dy) || 1;
    const nx = (-dy / d) * width * 0.5;
    const ny = (dx / d) * width * 0.5;
    this.band(x0 + nx, y0 + ny, x1 + nx, y1 + ny, 2.2, RIM);
    this.band(x0 - nx, y0 - ny, x1 - nx, y1 - ny, 2.2, RIM);
  }

  runners(x0, y0, x1, y1, gauge, width, color) {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const d = Math.hypot(dx, dy) || 1;
    const nx = (-dy / d) * gauge;
    const ny = (dx / d) * gauge;
    this.band(x0 + nx, y0 + ny, x1 + nx, y1 + ny, width, color);
    this.band(x0 - nx, y0 - ny, x1 - nx, y1 - ny, width, color);
  }

  // Thrown snow: a small bright core and droplets flung radially. Everything is low-alpha and
  // irregular, because a clean disc reads as a coin dropped on the ground.
  splat(x, y, r) {
    const g = this.newer.g;
    const n = 9;
    g.fillStyle = 'rgba(170,170,226,0.22)';
    g.beginPath();
    g.ellipse(x + 0.8, y + 1.2, r * 1.2, r * 0.9, 0, 0, TAU);
    g.fill();
    g.fillStyle = 'rgba(255,255,255,0.82)';
    for (let i = 0; i < 4; i++) {
      const a = Math.random() * TAU;
      const d = r * 0.34;
      g.beginPath();
      g.ellipse(x + Math.cos(a) * d, y + Math.sin(a) * d * 0.76, r * (0.42 + Math.random() * 0.26), r * (0.3 + Math.random() * 0.2), a, 0, TAU);
      g.fill();
    }
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU + Math.random() * 0.5;
      const d = r * (0.95 + Math.random() * 1.1);
      const s = r * (0.09 + Math.random() * 0.17);
      g.beginPath();
      g.ellipse(x + Math.cos(a) * d, y + Math.sin(a) * d * 0.76, s * 1.9, s, a, 0, TAU);
      g.fill();
    }
  }

  crater(x, y, r) {
    const g = this.newer.g;
    g.fillStyle = 'rgba(150,150,214,0.34)';
    g.beginPath();
    g.ellipse(x, y, r, r * 0.76, 0, 0, TAU);
    g.fill();
    g.strokeStyle = RIM;
    g.lineWidth = r * 0.12;
    g.beginPath();
    g.ellipse(x, y, r * 1.02, r * 0.78, 0, 0, TAU);
    g.stroke();
  }

  // ---- automatic marks from moving actors -----------------------------------

  sense(actors, fx) {
    this.gen++;
    const gen = this.gen;
    for (let i = 0; i < actors.length; i++) {
      const a = actors[i];
      let st = this.track.get(a.id);
      if (!st) {
        st = { x: a.x, y: a.y, side: 1, gen };
        this.track.set(a.id, st);
        continue;
      }
      st.gen = gen;
      this.mark(a, st, fx);
    }
    // Sweep rarely: stale entries cost nothing but memory, and the whole set is at most ~100.
    if ((gen & 63) === 0) {
      for (const [id, st] of this.track) if (st.gen !== gen) this.track.delete(id);
    }
  }

  mark(a, st, fx) {
    const dx = a.x - st.x;
    const dy = a.y - st.y;
    const d2 = dx * dx + dy * dy;
    const kind = a.kind;
    const flags = a.flags | 0;
    let stride = 15;
    if (kind === ACTOR.TRUCK) stride = 26;
    else if (kind === ACTOR.STEVE) stride = 46;
    else if (kind === ACTOR.BRUISER) stride = 22;
    else if (flags & (AFLAG.SLIDING | AFLAG.SLEDDING | AFLAG.BOARDING)) stride = 9;
    if (d2 < stride * stride) return;
    // A jump this big is a teleport or a respawn, not a footstep.
    if (d2 > 160 * 160) {
      st.x = a.x;
      st.y = a.y;
      return;
    }
    const onIce = this.isIce(a.x, a.y);
    const ang = Math.atan2(dy, dx);
    if (flags & AFLAG.SLEDDING) {
      if (!onIce) this.runners(st.x, st.y, a.x, a.y, 8, 3, 'rgba(164,164,222,0.42)');
      else this.runners(st.x, st.y, a.x, a.y, 8, 1.3, SKATE);
    } else if (flags & AFLAG.BOARDING) {
      this.band(st.x, st.y, a.x, a.y, onIce ? 1.6 : 6, onIce ? SKATE : 'rgba(168,168,224,0.3)');
    } else if (flags & AFLAG.SLIDING) {
      if (onIce) this.band(st.x, st.y, a.x, a.y, 1.8, SKATE);
      else this.slide(st.x, st.y, a.x, a.y, 20);
    } else if (kind === ACTOR.TRUCK) {
      if (!onIce) this.runners(st.x, st.y, a.x, a.y, 26, 10, 'rgba(164,164,222,0.34)');
    } else if (onIce) {
      // Boots leave only faint scuffs on ice.
      const off = st.side * 4;
      const nx = -Math.sin(ang) * off;
      const ny = Math.cos(ang) * off;
      this.band(a.x + nx - Math.cos(ang) * 4, a.y + ny - Math.sin(ang) * 4, a.x + nx, a.y + ny, 1, 'rgba(255,255,255,0.4)');
    } else {
      const big = kind === ACTOR.STEVE ? 3.2 : kind === ACTOR.BRUISER ? 1.7 : 1;
      const off = st.side * 5.2 * big;
      this.boot(a.x - Math.sin(ang) * off, a.y + Math.cos(ang) * off, ang, 4 * big);
      if (fx && (big > 1.5 || Math.random() < 0.3)) fx.footPuff(a.x, a.y);
    }
    st.side = -st.side;
    st.x = a.x;
    st.y = a.y;
  }
}
