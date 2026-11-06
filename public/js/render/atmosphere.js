// Time of day, night lights and weather: pass 7 of the frame.
//
// The expensive looks are all prepared off the frame: the multiply tint is a small tinted paper tile
// repainted only when the sky has visibly moved, the sky and vignette share one tiny canvas that is
// stretched across the screen, and weather is scrolled tiles.
import { sampleDay } from './palette.js';
import {
  TILE, bakeGentleTile, bakeBlizzardTile, bakeFogTile, bakeLightHole, bakeGlow, bakeGrain, bakeVignette, bakeSkyLight,
} from './atmoart.js';

const WIND_ANG = 0.58; // radians from +x. A storm comes in hard from the upper left, low and flat.
const GRADE_EASE_S = 0.7;
const BLIZZARD_EASE_S = 1.3;

const modPositive = (v, m) => ((v % m) + m) % m;

export class Atmosphere {
  constructor() {
    this.mul = [255, 255, 255];
    this.flat = [255, 255, 255, 0];
    this.sun = [255, 255, 255];
    this.sunA = 0;
    this.shade = [0, 0, 0];
    this.shadeA = 0;
    this.night = 0;
    this.longShadow = 0;
    this.blizzard = 0;

    this.gentleFar = bakeGentleTile(11, 130, 1.3);
    this.gentleNear = bakeGentleTile(23, 36, 2.3);
    this.stormFar = bakeBlizzardTile(31, 900, 15, 1.9, WIND_ANG);
    this.stormNear = bakeBlizzardTile(47, 200, 34, 3.8, WIND_ANG);
    this.fog = bakeFogTile(53);
    this.hole = bakeLightHole();
    this.glows = new Map();
    this.grain = bakeGrain();
    this.vignette = bakeVignette();
    this.skySun = bakeSkyLight('sun');
    this.skyShade = bakeSkyLight('shade');

    this.tinted = document.createElement('canvas');
    this.tinted.width = this.grain.width;
    this.tinted.height = this.grain.height;
    this.tintG = this.tinted.getContext('2d');
    this.tintedFor = [-1, -1, -1];
    this.tintPattern = null;

    this.air = document.createElement('canvas');
    this.air.width = this.vignette.width;
    this.air.height = this.vignette.height;
    this.airG = this.air.getContext('2d');
    this.airKey = -1;
    this.airScratch = document.createElement('canvas');
    this.airScratch.width = this.vignette.width;
    this.airScratch.height = this.vignette.height;
    this.airScratchG = this.airScratch.getContext('2d');

    this.mask = document.createElement('canvas');
    this.maskG = this.mask.getContext('2d');

    this.patterns = null;
  }

  resize(W, H) {
    this.W = W;
    this.H = H;
    this.mask.width = Math.max(1, Math.ceil(W / 4));
    this.mask.height = Math.max(1, Math.ceil(H / 4));
  }

  glowSprite(color) {
    let c = this.glows.get(color);
    if (!c) {
      c = bakeGlow(color);
      this.glows.set(color, c);
    }
    return c;
  }

  update(dt, dayT, blizzardOn, snap) {
    // Endless runs past 1 and cycles; a normal run ends at exactly 1, which must stay night.
    const day = dayT > 1 ? dayT - Math.floor(dayT) : dayT;
    const d = sampleDay(day);
    // The ramp jumps when Endless wraps from night to dawn, so the grade eases rather than tracks.
    const k = snap ? 1 : 1 - Math.exp(-dt / GRADE_EASE_S);
    for (let c = 0; c < 3; c++) {
      this.mul[c] += (d.mul[c] - this.mul[c]) * k;
      this.sun[c] += (d.sun[c] - this.sun[c]) * k;
      this.shade[c] += (d.shade[c] - this.shade[c]) * k;
    }
    for (let c = 0; c < 4; c++) this.flat[c] += (d.flat[c] - this.flat[c]) * k;
    this.night += (d.night - this.night) * k;
    // How low the sun sits. High at both ends of the day, gone at noon and after dark.
    const sunLow = day > 0.5 ? Math.max(0, 1 - Math.abs(day - 0.7) / 0.17) : Math.max(0, 1 - Math.abs(day - 0.03) / 0.19);
    this.longShadow += (sunLow - this.longShadow) * k;
    this.sunA += (d.sunA - this.sunA) * k;
    this.shadeA += (d.shadeA - this.shadeA) * k;
    const b = blizzardOn ? 1 : 0;
    this.blizzard = snap ? b : this.blizzard + (b - this.blizzard) * (1 - Math.exp(-dt / BLIZZARD_EASE_S));
    if (this.blizzard < 0.002) this.blizzard = 0;
  }

  // Repainting the tile is cheap but creating a pattern from it is not free, so it waits until the
  // colour has moved by an amount the eye could see.
  retintIfNeeded(ctx) {
    const m = this.mul;
    const f = this.tintedFor;
    if (this.tintPattern && Math.abs(m[0] - f[0]) + Math.abs(m[1] - f[1]) + Math.abs(m[2] - f[2]) < 2.5) return;
    const g = this.tintG;
    g.globalCompositeOperation = 'copy';
    g.fillStyle = `rgb(${m[0] | 0},${m[1] | 0},${m[2] | 0})`;
    g.fillRect(0, 0, this.tinted.width, this.tinted.height);
    g.globalCompositeOperation = 'multiply';
    g.drawImage(this.grain, 0, 0);
    g.globalCompositeOperation = 'source-over';
    this.tintPattern = ctx.createPattern(this.tinted, 'repeat');
    f[0] = m[0];
    f[1] = m[1];
    f[2] = m[2];
  }

  // Warm and cool corner light plus vignette, composed into one tiny canvas that the frame stretches
  // across the screen in a single blit. Quantized key: it rebuilds a few times a minute at most.
  refreshAir() {
    const s = this.sun;
    const h = this.shade;
    const key = ((s[0] + s[1] + s[2]) >> 2) * 131 + ((h[0] + h[1] + h[2]) >> 2) * 17 + Math.round(this.sunA * 120) * 7 + Math.round(this.shadeA * 120);
    if (key === this.airKey) return;
    this.airKey = key;
    const g = this.airG;
    const w = this.air.width;
    const ht = this.air.height;
    g.clearRect(0, 0, w, ht);
    this.tintedLight(g, this.skySun, s, this.sunA);
    this.tintedLight(g, this.skyShade, h, this.shadeA);
    g.drawImage(this.vignette, 0, 0);
  }

  tintedLight(g, sprite, color, alpha) {
    const t = this.airScratchG;
    const w = this.airScratch.width;
    const h = this.airScratch.height;
    t.globalCompositeOperation = 'copy';
    t.drawImage(sprite, 0, 0);
    t.globalCompositeOperation = 'source-in';
    t.fillStyle = `rgb(${color[0] | 0},${color[1] | 0},${color[2] | 0})`;
    t.fillRect(0, 0, w, h);
    g.globalAlpha = Math.min(1, alpha);
    g.drawImage(this.airScratch, 0, 0);
    g.globalAlpha = 1;
  }

  drawGrade(ctx, low, pr) {
    const { W, H } = this;
    if (low) {
      const f = this.flat;
      if (f[3] > 0.004) {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalAlpha = 1;
        ctx.fillStyle = `rgba(${f[0] | 0},${f[1] | 0},${f[2] | 0},${f[3].toFixed(3)})`;
        ctx.fillRect(0, 0, W, H);
      }
      return;
    }
    this.retintIfNeeded(ctx);
    ctx.setTransform(pr, 0, 0, pr, 0, 0);
    ctx.globalCompositeOperation = 'multiply';
    ctx.fillStyle = this.tintPattern;
    ctx.fillRect(0, 0, W / pr, H / pr);
    ctx.globalCompositeOperation = 'source-over';
    this.refreshAir();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'soft-light';
    ctx.drawImage(this.air, 0, 0, W, H);
    ctx.globalCompositeOperation = 'source-over';
  }

  // lights: {x, y, r, color}. Static ones arrive pre-culled from the renderer, with world-to-backing
  // transform S, tx, ty. Only called on high with some night in the sky.
  drawNight(ctx, S, tx, ty, lights, count, panes, paneCount) {
    const n = this.night;
    if (n <= 0.01) return;
    const m = this.maskG;
    const mw = this.mask.width;
    const mh = this.mask.height;
    const sx = mw / this.W;
    const sy = mh / this.H;
    m.globalCompositeOperation = 'copy';
    m.fillStyle = `rgba(62,80,150,${(0.92 * n).toFixed(3)})`;
    m.fillRect(0, 0, mw, mh);
    m.globalCompositeOperation = 'destination-out';
    for (let i = 0; i < count; i++) {
      const L = lights[i];
      const gx = L.gx ?? L.x;
      const gy = L.gy ?? L.y;
      const r = L.r * S * sx * 1.3;
      m.globalAlpha = L.hole ?? 1;
      m.drawImage(this.hole, (gx * S + tx) * sx - r, (gy * S + ty) * sy - r, r * 2, r * 2);
    }
    // Lit glass gets its own small hole, so the window shines while the wall around it goes dark.
    m.globalAlpha = 0.95;
    for (let i = 0; i < paneCount; i++) {
      const p = panes[i];
      const r = p.r * 1.6 * S * sx;
      m.drawImage(this.hole, (p.x * S + tx) * sx - r, (p.y * S + ty) * sy - r, r * 2, r * 2);
    }
    m.globalAlpha = 1;
    // The dark is multiplied rather than painted on: shapes keep their contrast instead of going
    // foggy, and inside a hole the true colours survive, which is what makes lamplight look warm.
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'multiply';
    ctx.drawImage(this.mask, 0, 0, this.W, this.H);

    // Two passes per light. Multiply takes the blue out of the pool, and only then can adding light
    // make it warm: added alone, amber on blue-tinted snow just comes out white.
    ctx.globalCompositeOperation = 'multiply';
    for (let i = 0; i < count; i++) {
      const L = lights[i];
      const r = L.r * S * 0.98;
      ctx.globalAlpha = n * 0.85 * (L.power ?? 1);
      ctx.drawImage(this.glowSprite(L.color), (L.gx ?? L.x) * S + tx - r, (L.gy ?? L.y) * S + ty - r, r * 2, r * 2);
    }
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < count; i++) {
      const L = lights[i];
      const r = L.r * S * 0.86;
      const gx = (L.gx ?? L.x) * S + tx;
      const gy = (L.gy ?? L.y) * S + ty;
      ctx.globalAlpha = n * 0.46 * (L.power ?? 1);
      ctx.drawImage(this.glowSprite(L.color), gx - r, gy - r, r * 2, r * 2);
      if (L.gx !== undefined) {
        // Lamp heads get a tight bloom up at the bulb, apart from the pool on the ground.
        const b = 30 * S;
        const bx = L.x * S + tx;
        const by = L.y * S + ty;
        ctx.globalAlpha = n * 0.55;
        ctx.drawImage(this.glowSprite(L.color), bx - b, by - b, b * 2, b * 2);
      }
    }
    // The night tint still sits on the glass, so each pane is lifted back to a warm glow.
    const paneGlow = this.glowSprite('#ffc46a');
    ctx.globalAlpha = n * 0.62;
    for (let i = 0; i < paneCount; i++) {
      const p = panes[i];
      const r = p.r * 1.5 * S;
      ctx.drawImage(paneGlow, p.x * S + tx - r, p.y * S + ty - r, r * 2, r * 2);
    }
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
  }

  scroll(ctx, pattern, ox, oy, scale, alpha) {
    const period = TILE * scale;
    const x = modPositive(ox, period);
    const y = modPositive(oy, period);
    ctx.globalAlpha = alpha;
    ctx.setTransform(scale, 0, 0, scale, x, y);
    ctx.fillStyle = pattern;
    ctx.fillRect(-x / scale, -y / scale, this.W / scale, this.H / scale);
  }

  drawWeather(ctx, time, camX, camY, zoom, pr, low) {
    if (!this.patterns) {
      this.patterns = {
        far: ctx.createPattern(this.gentleFar, 'repeat'),
        near: ctx.createPattern(this.gentleNear, 'repeat'),
        stormFar: ctx.createPattern(this.stormFar, 'repeat'),
        stormNear: ctx.createPattern(this.stormNear, 'repeat'),
        fog: ctx.createPattern(this.fog, 'repeat'),
      };
    }
    const p = this.patterns;
    const b = this.blizzard;
    const S = zoom * pr;
    // Parallax: the near layer slides faster than the ground, which is all the depth cue snow needs.
    const px = -camX * S;
    const py = -camY * S;
    const sway = Math.sin(time * 0.45) * 34 * pr;
    // Flakes are drawn after the grade, so they must be dimmed by hand or they glare at night.
    const calm = (1 - b) * (1 - this.night * 0.5);
    if (calm > 0.02) {
      if (!low) this.scroll(ctx, p.far, px * 1.05 + time * 14 * pr + sway * 0.5, py * 1.05 + time * 42 * pr, pr * 0.9, 0.7 * calm);
      this.scroll(ctx, p.near, px * 1.4 + time * 22 * pr + sway, py * 1.4 + time * 76 * pr, pr * 1.05, 0.85 * calm);
    }
    if (b > 0.01) {
      ctx.globalAlpha = 1;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      // Pale wash: this is what takes the contrast out of the picture.
      ctx.fillStyle = `rgba(224,232,247,${(0.22 * b * (1 - this.night * 0.6)).toFixed(3)})`;
      ctx.fillRect(0, 0, this.W, this.H);
      const dx = Math.cos(WIND_ANG);
      const dy = Math.sin(WIND_ANG);
      const dim = 1 - this.night * 0.45;
      if (!low) this.scroll(ctx, p.fog, px * 1.1 + time * 240 * dx * pr, py * 1.1 + time * 240 * dy * pr, pr * 1.8, 0.36 * b * dim);
      this.scroll(ctx, p.stormFar, px * 1.2 + time * 460 * dx * pr, py * 1.2 + time * 460 * dy * pr, pr, 0.92 * b * dim);
      this.scroll(ctx, p.stormNear, px * 1.6 + time * 780 * dx * pr, py * 1.6 + time * 780 * dy * pr, pr * 1.25, 0.85 * b * dim);
    }
    ctx.globalAlpha = 1;
  }
}
