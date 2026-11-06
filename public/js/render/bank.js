// The sprite bank: every static thing in the world is painted once into a canvas at the current
// raster scale and then blitted. Sprites are defined in world units so that a resize only changes
// how many pixels back them, never where they sit.
import { makeCanvas } from './paint.js';

const MAX_DIM = 4096;

export class SpriteBank {
  // The 128 MB budget is shared: ActorArt may hold 64 MB and the ground, trails and weather tiles about
  // 19 MB, which leaves this. A busy map at raster 2 sits near 35 MB.
  constructor(budgetBytes = 44 * 1024 * 1024) {
    this.budget = budgetBytes;
    this.scale = 1;
    this.bytes = 0;
    this.clock = 0;
    this.items = new Map();
  }

  // Sprites are keyed without their scale, so a change of scale throws away the old pixels.
  setScale(scale) {
    if (scale === this.scale) return false;
    this.scale = scale;
    this.clear();
    return true;
  }

  clear() {
    this.items.clear();
    this.bytes = 0;
  }

  // Frees everything under a key prefix. Obstacles are per-map, so a new match releases the last one's.
  drop(prefix) {
    for (const [key, sp] of this.items) {
      if (key.startsWith(prefix)) {
        this.items.delete(key);
        this.bytes -= sp.bytes;
      }
    }
  }

  // box is {x, y, w, h}: the painted extent in world units, relative to the sprite's anchor.
  // maxScale caps very large art, which gains little from the last half step of resolution.
  get(key, box, paint, maxScale = Infinity) {
    let sp = this.items.get(key);
    if (sp) {
      sp.used = ++this.clock;
      return sp;
    }
    const s = Math.min(this.scale, maxScale, MAX_DIM / box.w, MAX_DIM / box.h);
    const canvas = makeCanvas(box.w * s, box.h * s);
    const g = canvas.getContext('2d');
    g.scale(canvas.width / box.w, canvas.height / box.h);
    g.translate(-box.x, -box.y);
    g.lineCap = 'round';
    g.lineJoin = 'round';
    paint(g);
    sp = { canvas, x: box.x, y: box.y, w: box.w, h: box.h, used: ++this.clock, bytes: canvas.width * canvas.height * 4 };
    this.items.set(key, sp);
    this.bytes += sp.bytes;
    if (this.bytes > this.budget) this.evict(sp);
    return sp;
  }

  // Least-recently-used, never the sprite being returned. Maps stay comfortably inside the budget
  // on any real scene, so this only guards against a pathological map.
  evict(keep) {
    const byAge = [...this.items.entries()].sort((a, b) => a[1].used - b[1].used);
    for (const [key, sp] of byAge) {
      if (this.bytes <= this.budget * 0.85) break;
      if (sp === keep) continue;
      this.items.delete(key);
      this.bytes -= sp.bytes;
    }
  }
}

export function blit(ctx, sp, x, y) {
  ctx.drawImage(sp.canvas, x + sp.x, y + sp.y, sp.w, sp.h);
}
