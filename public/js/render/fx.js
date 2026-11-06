// Particles. A flat struct-of-arrays pool: a boss fight spawns thousands of these per minute and
// nothing here may allocate. Purely cosmetic, so Math.random is fine and nothing needs to replay.
import { FX } from './fxart.js';
import { Z_LIFT } from './world.js';

const TAU = Math.PI * 2;
const rand = (a, b) => a + (b - a) * Math.random();

export class Particles {
  constructor(capacity = 1400) {
    this.cap = capacity;
    this.count = 0;
    this.density = 1;
    this.kind = new Uint8Array(capacity);
    this.x = new Float32Array(capacity);
    this.y = new Float32Array(capacity);
    this.z = new Float32Array(capacity);
    this.vx = new Float32Array(capacity);
    this.vy = new Float32Array(capacity);
    this.vz = new Float32Array(capacity);
    this.grav = new Float32Array(capacity);
    this.drag = new Float32Array(capacity);
    this.age = new Float32Array(capacity);
    this.life = new Float32Array(capacity);
    this.s0 = new Float32Array(capacity);
    this.s1 = new Float32Array(capacity);
    this.rot = new Float32Array(capacity);
    this.spin = new Float32Array(capacity);
    this.alpha = new Float32Array(capacity);
    this.fadeIn = new Float32Array(capacity);
    this.add = new Uint8Array(capacity);
  }

  clear() {
    this.count = 0;
  }

  spawn(kind, x, y, z, vx, vy, vz, life, s0, s1, grav = 0, drag = 0, alpha = 1, rot = 0, spin = 0, fadeIn = 0, additive = 0) {
    // Under a hard cap the oldest slots are recycled: losing an old puff is invisible, losing the
    // puff of the hit you just landed is not.
    let i = this.count;
    if (i >= this.cap) i = Math.floor(Math.random() * this.cap);
    else this.count++;
    this.kind[i] = kind;
    this.x[i] = x;
    this.y[i] = y;
    this.z[i] = z;
    this.vx[i] = vx;
    this.vy[i] = vy;
    this.vz[i] = vz;
    this.life[i] = life;
    this.age[i] = 0;
    this.s0[i] = s0;
    this.s1[i] = s1;
    this.grav[i] = grav;
    this.drag[i] = drag;
    this.alpha[i] = alpha;
    this.rot[i] = rot;
    this.spin[i] = spin;
    this.fadeIn[i] = fadeIn;
    this.add[i] = additive;
  }

  update(dt) {
    let n = this.count;
    for (let i = 0; i < n; i++) {
      this.age[i] += dt;
      if (this.age[i] >= this.life[i]) {
        n--;
        this.moveSlot(n, i);
        i--;
        continue;
      }
      const d = this.drag[i];
      if (d > 0) {
        const k = Math.max(0, 1 - d * dt);
        this.vx[i] *= k;
        this.vy[i] *= k;
      }
      this.x[i] += this.vx[i] * dt;
      this.y[i] += this.vy[i] * dt;
      const g = this.grav[i];
      if (g !== 0) {
        this.vz[i] -= g * dt;
        let z = this.z[i] + this.vz[i] * dt;
        if (z <= 0 && g > 0) {
          z = 0;
          this.vz[i] *= -0.28;
          this.vx[i] *= 0.45;
          this.vy[i] *= 0.45;
          this.spin[i] *= 0.4;
        }
        this.z[i] = z;
      } else {
        this.z[i] += this.vz[i] * dt;
      }
      this.rot[i] += this.spin[i] * dt;
    }
    this.count = n;
  }

  moveSlot(from, to) {
    if (from === to) return;
    this.kind[to] = this.kind[from];
    this.x[to] = this.x[from];
    this.y[to] = this.y[from];
    this.z[to] = this.z[from];
    this.vx[to] = this.vx[from];
    this.vy[to] = this.vy[from];
    this.vz[to] = this.vz[from];
    this.grav[to] = this.grav[from];
    this.drag[to] = this.drag[from];
    this.age[to] = this.age[from];
    this.life[to] = this.life[from];
    this.s0[to] = this.s0[from];
    this.s1[to] = this.s1[from];
    this.rot[to] = this.rot[from];
    this.spin[to] = this.spin[from];
    this.alpha[to] = this.alpha[from];
    this.fadeIn[to] = this.fadeIn[from];
    this.add[to] = this.add[from];
  }

  // World transform is passed in rather than read back so spinning sprites can rebuild it cheaply.
  draw(ctx, atlas, S, tx, ty, viewX0, viewY0, viewX1, viewY1) {
    const { canvas, cells, size } = atlas;
    let additive = false;
    for (let i = 0; i < this.count; i++) {
      const x = this.x[i];
      const y = this.y[i] - this.z[i] * Z_LIFT;
      if (x < viewX0 || x > viewX1 || y < viewY0 || y > viewY1) continue;
      const t = this.age[i] / this.life[i];
      const s = this.s0[i] + (this.s1[i] - this.s0[i]) * (1 - (1 - t) * (1 - t));
      const inT = this.fadeIn[i];
      const a = this.alpha[i] * (inT > 0 && t < inT ? t / inT : 1) * (t < 0.55 ? 1 : (1 - t) / 0.45);
      if (a <= 0.01) continue;
      const k = this.kind[i];
      const wantAdd = this.add[i] === 1;
      if (wantAdd !== additive) {
        ctx.globalCompositeOperation = wantAdd ? 'lighter' : 'source-over';
        additive = wantAdd;
      }
      ctx.globalAlpha = a;
      const rot = this.rot[i];
      if (rot !== 0) {
        const c = Math.cos(rot) * S;
        const sn = Math.sin(rot) * S;
        ctx.setTransform(c, sn, -sn, c, x * S + tx, y * S + ty);
        ctx.drawImage(canvas, cells[k * 2], cells[k * 2 + 1], size, size, -s / 2, -s / 2, s, s);
        ctx.setTransform(S, 0, 0, S, tx, ty);
      } else {
        ctx.drawImage(canvas, cells[k * 2], cells[k * 2 + 1], size, size, x - s / 2, y - s / 2, s, s);
      }
    }
    ctx.globalAlpha = 1;
    if (additive) ctx.globalCompositeOperation = 'source-over';
  }

  // ---- recipes --------------------------------------------------------------

  amount(n) {
    return Math.max(1, Math.round(n * this.density));
  }

  puffs(x, y, z, n, speed, size, life = 0.5, kind = FX.PUFF, alpha = 0.95) {
    for (let i = 0, c = this.amount(n); i < c; i++) {
      const a = Math.random() * TAU;
      const v = speed * rand(0.35, 1);
      this.spawn(kind, x + rand(-3, 3), y + rand(-3, 3), z + rand(0, 4), Math.cos(a) * v, Math.sin(a) * v * 0.72, rand(10, 60), life * rand(0.7, 1.25), size * rand(0.5, 0.9), size * rand(1.1, 1.8), 40, 3.4, alpha);
    }
  }

  chunks(x, y, z, n, speed, size, kind = FX.CHUNK, life = 0.75) {
    for (let i = 0, c = this.amount(n); i < c; i++) {
      const a = Math.random() * TAU;
      const v = speed * rand(0.4, 1);
      this.spawn(kind, x, y, z + rand(2, 8), Math.cos(a) * v, Math.sin(a) * v * 0.72, rand(70, 170), life * rand(0.75, 1.25), size * rand(0.6, 1.1), size * rand(0.3, 0.6), 420, 0.8, 1, rand(0.001, TAU), rand(-9, 9));
    }
  }

  ring(x, y, r, life = 0.32, alpha = 0.72) {
    this.spawn(FX.RING, x, y, 1, 0, 0, 0, life, r * 0.5, r * 2.3, 0, 0, alpha);
  }

  stars(x, y, z, n, spread, kind = FX.STAR, size = 11, life = 0.75) {
    for (let i = 0, c = this.amount(n); i < c; i++) {
      this.spawn(kind, x + rand(-spread, spread), y + rand(-spread, spread) * 0.7, z + rand(0, spread * 0.8), rand(-16, 16), rand(-8, 8), rand(14, 52), life * rand(0.6, 1.25), size * rand(0.7, 1.2), 2, 0, 0.6, 1, 0, rand(-2, 2), 0.15);
    }
  }

  snowImpact(x, y, z, heft = 1) {
    this.puffs(x, y, z, 5 * heft, 90 * Math.sqrt(heft), 13 * Math.sqrt(heft));
    this.chunks(x, y, z, 6 * heft, 130 * Math.sqrt(heft), 5.5);
    this.spawn(FX.FLASH, x, y, z + 2, 0, 0, 0, 0.14, 14 * heft, 30 * heft, 0, 0, 0.8);
  }

  iceImpact(x, y, z) {
    this.chunks(x, y, z, 9, 190, 7.5, FX.SHARD, 0.6);
    this.puffs(x, y, z, 3, 70, 10);
    this.stars(x, y, z, 3, 7);
  }

  slushImpact(x, y, z) {
    this.chunks(x, y, z, 9, 150, 6.5, FX.SLUSH, 0.65);
    this.puffs(x, y, z, 3, 60, 13, 0.55, FX.PUFF_SHADE, 0.8);
  }

  coneImpact(x, y, z) {
    this.chunks(x, y, z, 5, 130, 5.5, FX.CONF_R, 0.6);
    this.chunks(x, y, z, 5, 130, 5.5, FX.CONF_B, 0.6);
    this.puffs(x, y, z, 3, 80, 11);
  }

  shieldClang(x, y, z) {
    this.chunks(x, y, z, 8, 170, 5.5, FX.GOLD, 0.45);
    this.spawn(FX.STAR, x, y, z, 0, 0, 0, 0.2, 26, 8, 0, 0, 1);
  }

  splash(x, y, r) {
    this.ring(x, y, r, 0.36, 0.8);
    const n = this.amount(10 + r / 6);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU + rand(-0.1, 0.1);
      this.spawn(FX.PUFF, x + Math.cos(a) * r * 0.42, y + Math.sin(a) * r * 0.3, 3, Math.cos(a) * r * 2.3, Math.sin(a) * r * 1.6, rand(20, 80), rand(0.32, 0.6), r * 0.26, r * 0.5, 80, 3, 0.95);
    }
    this.chunks(x, y, 3, 8, r * 3.4, 6);
  }

  wallChip(x, y, z, ice) {
    this.chunks(x, y, z, 4, 90, 5, ice ? FX.SHARD : FX.CHUNK, 0.5);
  }

  woodChip(x, y, z) {
    this.chunks(x, y, z, 4, 100, 7, FX.WOOD, 0.55);
  }

  breakBlock(x, y, ice) {
    const kind = ice ? FX.SHARD : FX.CHUNK;
    this.chunks(x, y, 14, 16, 170, ice ? 9.5 : 8.5, kind, 0.9);
    this.chunks(x, y, 26, 10, 120, ice ? 8 : 7, kind, 0.8);
    this.puffs(x, y, 16, 11, 110, 19, 0.62, ice ? FX.PUFF_SHADE : FX.PUFF);
    this.ring(x, y, 34, 0.32, 0.5);
  }

  breakWood(x, y) {
    this.chunks(x, y, 14, 14, 170, 9.5, FX.WOOD, 0.9);
    this.puffs(x, y, 12, 7, 100, 17, 0.55, FX.DUST);
  }

  buildPop(x, y, ice) {
    this.ring(x, y, 24, 0.3, 0.75);
    this.puffs(x, y, 2, 7, 95, 11, 0.42);
    this.stars(x, y, 16, 3, 16, ice ? FX.STAR : FX.FLAKE, 8, 0.6);
  }

  freeze(x, y) {
    this.chunks(x, y, 20, 12, 150, 8, FX.SHARD, 0.7);
    this.ring(x, y, 28, 0.36, 0.8);
    this.stars(x, y, 22, 5, 16);
  }

  thaw(x, y) {
    this.stars(x, y, 16, 7, 18, FX.GOLD, 8.5, 0.8);
    this.chunks(x, y, 22, 6, 90, 4.6, FX.DROP, 0.6);
    this.spawn(FX.HEAT, x, y, 20, 0, 0, 12, 0.5, 46, 90, 0, 0, 0.42, 0, 0, 0.2, 1);
  }

  spawnPoof(x, y) {
    this.puffs(x, y, 4, 7, 80, 14, 0.5);
  }

  flee(x, y) {
    this.puffs(x, y, 8, 5, 80, 12, 0.5);
  }

  pickupTaken(x, y) {
    this.stars(x, y, 12, 8, 13, FX.STAR, 11, 0.6);
    this.ring(x, y, 19, 0.3, 0.7);
  }

  pickupAppear(x, y) {
    this.stars(x, y, 10, 5, 12, FX.STAR, 9, 0.55);
  }

  confetti(x, y, z = 30, n = 40) {
    const kinds = [FX.CONF_R, FX.CONF_B, FX.CONF_Y, FX.CONF_G];
    for (let i = 0, c = this.amount(n); i < c; i++) {
      const a = Math.random() * TAU;
      const v = rand(30, 220);
      this.spawn(kinds[i & 3], x, y, z, Math.cos(a) * v, Math.sin(a) * v * 0.6, rand(120, 330), rand(1.1, 2), rand(4, 7), rand(4, 7), 190, 1.2, 1, rand(0.1, TAU), rand(-14, 14));
    }
  }

  slideSpray(x, y, vx, vy) {
    for (let i = 0, c = this.amount(3); i < c; i++) {
      this.spawn(FX.PUFF, x + rand(-5, 5), y + rand(-3, 3), 2, -vx * 0.14 + rand(-34, 34), -vy * 0.14 + rand(-34, 34), rand(16, 60), rand(0.26, 0.48), rand(5, 8), rand(11, 17), 70, 2.4, 0.9);
    }
  }

  packBits(x, y) {
    this.spawn(FX.CHUNK, x + rand(-8, 8), y + rand(-2, 3), 6, rand(-22, 22), rand(-10, 10), rand(40, 86), rand(0.28, 0.42), rand(2.4, 4), 1.2, 260, 0.5, 1, rand(0.1, 3), rand(-6, 6));
  }

  footPuff(x, y) {
    this.spawn(FX.PUFF, x + rand(-2, 2), y + rand(-1, 2), 1, rand(-12, 12), rand(-8, 8), rand(5, 18), rand(0.2, 0.32), rand(3.6, 5), rand(7, 11), 30, 3, 0.62);
  }

  sparkleTrail(x, y, z) {
    this.spawn(FX.STAR, x + rand(-4, 4), y + rand(-3, 3), z + rand(-3, 3), rand(-6, 6), rand(-6, 6), rand(-12, 12), rand(0.26, 0.5), rand(5, 9), 1, 0, 0, 0.92, 0, rand(-3, 3));
  }

  steam(x, y, z) {
    this.spawn(FX.STEAM, x + rand(-2.4, 2.4), y, z, rand(-4, 6), 0, rand(16, 26), rand(1, 1.5), rand(5, 7), rand(15, 22), 0, 0, 0.5, 0, 0, 0.3);
  }

  smoke(x, y, z) {
    this.spawn(FX.SMOKE, x + rand(-2, 2), y, z, rand(6, 15), rand(-1, 1), rand(20, 32), rand(2, 3.1), rand(8, 11), rand(26, 38), 0, 0, 0.62, 0, 0, 0.2);
  }

  // Cold air: a small puff of breath drifting off a kid's face.
  breath(x, y, z, facing) {
    this.spawn(FX.STEAM, x + facing * 6, y, z, facing * rand(12, 22), 0, rand(4, 12), rand(0.6, 0.9), 3, rand(9, 12), 0, 1.5, 0.5, 0, 0, 0.2);
  }

  shockwave(x, y, r) {
    this.spawn(FX.RING, x, y, 1, 0, 0, 0, 0.42, r * 0.4, r * 2.1, 0, 0, 0.9);
    this.spawn(FX.RING, x, y, 1, 0, 0, 0, 0.62, r * 0.2, r * 1.6, 0, 0, 0.6);
    const n = this.amount(26);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU;
      this.spawn(FX.PUFF, x + Math.cos(a) * r * 0.3, y + Math.sin(a) * r * 0.22, 3, Math.cos(a) * r * 2.1, Math.sin(a) * r * 1.6, rand(30, 110), rand(0.42, 0.7), 18, 36, 90, 3.2, 0.95);
    }
    this.chunks(x, y, 4, 18, r * 2.2, 11, FX.CHUNK, 0.8);
  }
}
