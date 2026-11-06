// Fort Flurry — sprite cache.
// Sprites are rasterized on first use into shared 1024 px pages. Paging gives two guarantees a pile of
// tiny canvases can't: memory is bounded by construction (maxPages x 4 MB, inside the 128 MB budget
// with room for the ground caches), and the frame draws from a handful of textures instead of
// hundreds, which is what keeps phones batching.

const PAGE = 1024;
const PAD = 2; // transparent gutter so bilinear sampling never picks up a neighbour

export const MIN_SCALE = 0.5;
export const MAX_SCALE = 3;

function newCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

class Page {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.keys = [];
    this.x = PAD;
    this.y = PAD;
    this.rowH = 0;
    this.used = 0;
  }

  reset() {
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.clearRect(0, 0, PAGE, PAGE);
    this.keys.length = 0;
    this.x = PAD;
    this.y = PAD;
    this.rowH = 0;
  }

  // Shelf packing: sprites of one family are requested together and share a height, so shelves stay full.
  alloc(w, h) {
    if (this.x + w + PAD > PAGE) {
      this.x = PAD;
      this.y += this.rowH + PAD;
      this.rowH = 0;
    }
    if (this.y + h + PAD > PAGE) return null;
    const slot = { x: this.x, y: this.y };
    this.x += w + PAD;
    if (h > this.rowH) this.rowH = h;
    return slot;
  }
}

export class SpriteAtlas {
  constructor({ scale = 2, maxPages = 16 } = {}) {
    this.scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
    this.maxPages = maxPages;
    this.pages = [];
    this.map = new Map();
    this.clock = 0;
    this.current = null;
    this.built = 0;
  }

  get bytes() {
    return this.pages.length * PAGE * PAGE * 4;
  }

  setScale(s) {
    const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, s || 1));
    if (next === this.scale) return;
    this.scale = next;
    this.clear();
  }

  clear() {
    this.map.clear();
    for (const p of this.pages) p.reset();
    this.current = this.pages[0] || null;
  }

  // Called once per frame by the owner, so page recency means "drawn lately".
  tick() {
    this.clock++;
  }

  // Hot path: a warm sprite comes back with no closure or box built by the caller.
  peek(key) {
    const e = this.map.get(key);
    if (e) e.page.used = this.clock;
    return e;
  }

  // box is {w,h,ax,ay} in world units: ax,ay is where the sprite's origin sits inside the box.
  get(key, box, paint) {
    return this.peek(key) ?? this._build(key, box, paint);
  }

  // A white silhouette of an existing sprite. Hit flash is an alpha blit of this, because per-frame
  // filters are off the table and only a few sprites ever need one. Keys are positive numbers, so the
  // negated key is free to name it.
  flashOf(key, box, paint) {
    let f = this.peek(-key);
    if (f) return f;
    // Slot first: fetching the source can only evict an old page, never the one just written to, so
    // the other order could copy pixels from a page that had already been recycled.
    f = this._alloc(-key, box);
    const src = this.get(key, box, paint);
    const { ctx } = f.page;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.beginPath();
    ctx.rect(f.sx, f.sy, f.sw, f.sh);
    ctx.clip();
    ctx.drawImage(src.page.canvas, src.sx, src.sy, src.sw, src.sh, f.sx, f.sy, f.sw, f.sh);
    ctx.globalCompositeOperation = 'source-atop';
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(f.sx, f.sy, f.sw, f.sh);
    ctx.restore();
    return f;
  }

  _alloc(key, box) {
    const s = this.scale;
    const sw = Math.ceil(box.w * s), sh = Math.ceil(box.h * s);
    let page = this.current;
    let slot = page ? page.alloc(sw, sh) : null;
    if (!slot) {
      page = this._nextPage();
      slot = page.alloc(sw, sh);
    }
    // A box bigger than a whole page can't be stored; it shares the failure path of an impossible size.
    if (!slot) throw new Error(`sprite too large: ${key}`);
    const e = {
      page, canvas: page.canvas, sx: slot.x, sy: slot.y, sw, sh,
      w: sw / s, h: sh / s, ax: box.ax, ay: box.ay,
    };
    page.keys.push(key);
    page.used = this.clock;
    this.map.set(key, e);
    return e;
  }

  _nextPage() {
    const free = this.pages.find((p) => p !== this.current && p.keys.length === 0);
    if (free) {
      this.current = free;
      return free;
    }
    if (this.pages.length < this.maxPages) {
      const p = new Page(newCanvas(PAGE, PAGE));
      this.pages.push(p);
      this.current = p;
      return p;
    }
    let oldest = null;
    for (const p of this.pages) if (p !== this.current && (!oldest || p.used < oldest.used)) oldest = p;
    if (!oldest) oldest = this.current;
    for (const k of oldest.keys) this.map.delete(k);
    oldest.reset();
    this.current = oldest;
    return oldest;
  }

  _build(key, box, paint) {
    const e = this._alloc(key, box);
    const { ctx } = e.page;
    const s = this.scale;
    e.page.used = this.clock;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.beginPath();
    ctx.rect(e.sx, e.sy, e.sw, e.sh);
    ctx.clip();
    ctx.setTransform(s, 0, 0, s, e.sx + box.ax * s, e.sy + box.ay * s);
    paint(ctx);
    ctx.restore();
    this.built++;
    return e;
  }
}

// The one way sprites reach the screen. The unflipped, unscaled path avoids save/restore because crowds
// of foes spend most of their life on it.
export function blit(ctx, e, x, y, flip = false, sx = 1, sy = 1, rot = 0) {
  if (!flip && sx === 1 && sy === 1 && rot === 0) {
    ctx.drawImage(e.canvas, e.sx, e.sy, e.sw, e.sh, x - e.ax, y - e.ay, e.w, e.h);
    return;
  }
  ctx.save();
  ctx.translate(x, y);
  if (rot !== 0) ctx.rotate(rot);
  ctx.scale(flip ? -sx : sx, sy);
  ctx.drawImage(e.canvas, e.sx, e.sy, e.sw, e.sh, -e.ax, -e.ay, e.w, e.h);
  ctx.restore();
}
