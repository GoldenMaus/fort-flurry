// Classic's retro look (SPEC 2.4). The world is painted as crisp pixel art into a small canvas, one
// pixel per two world units, then scaled up with smoothing off. Every sprite here is original and
// drawn in code; the aiming aids, build preview and HUD stay sharp on top of it.
import { ACTOR, AFLAG, BALL, STRUCT, TEAM } from '../../shared/schema.js';
import { BUILD, CELL, CLASSIC, LOOK } from '../../shared/constants.js';
import { Z_LIFT } from './world.js';

const PX = 2;                 // world units per retro pixel
const HIT_FLASH = 0.12;       // seconds a hit kid shows white
const FLAKES = 90;

const C = Object.freeze({
  ink: '#1c1c34', snow: '#f2f4fa', snowLo: '#e1e7f3', snowHi: '#ffffff', shade: '#c6d0e5', deep: '#9fadcb',
  ice: '#b4ddf6', iceHi: '#effbff', iceLo: '#7cb3dc',
  wood: '#b0703c', woodLo: '#6e3e1c', pine: '#2f9b55', pineLo: '#1b653a',
  rock: '#8b93a7', rockLo: '#5d6479', metal: '#7d879a', metalLo: '#4f576b', lamp: '#3a3a52',
  boot: '#4b2f22', pants: '#2f3253', mitten: '#f8f8f8', gold: '#ffd84a',
  heart: '#e8304c', heartLo: '#5a2a3c', rope: '#e04848', sled: '#d83838',
});
const TEAM_PX = Object.freeze({
  [TEAM.A]: { coat: '#d6404e', dark: '#8c2232' },
  [TEAM.B]: { coat: '#3a78d6', dark: '#1d4a8c' },
});
const teamPx = (team) => TEAM_PX[team] ?? TEAM_PX[TEAM.A];

// 3x5 pixel font, upper case only: names, KO and short labels.
const FONT = {
  A: ['.#.', '#.#', '###', '#.#', '#.#'], B: ['##.', '#.#', '##.', '#.#', '##.'], C: ['.##', '#..', '#..', '#..', '.##'],
  D: ['##.', '#.#', '#.#', '#.#', '##.'], E: ['###', '#..', '##.', '#..', '###'], F: ['###', '#..', '##.', '#..', '#..'],
  G: ['.##', '#..', '#.#', '#.#', '.##'], H: ['#.#', '#.#', '###', '#.#', '#.#'], I: ['###', '.#.', '.#.', '.#.', '###'],
  J: ['..#', '..#', '..#', '#.#', '.#.'], K: ['#.#', '#.#', '##.', '#.#', '#.#'], L: ['#..', '#..', '#..', '#..', '###'],
  M: ['#.#', '###', '###', '#.#', '#.#'], N: ['##.', '#.#', '#.#', '#.#', '#.#'], O: ['.#.', '#.#', '#.#', '#.#', '.#.'],
  P: ['##.', '#.#', '##.', '#..', '#..'], Q: ['.#.', '#.#', '#.#', '##.', '.##'], R: ['##.', '#.#', '##.', '#.#', '#.#'],
  S: ['.##', '#..', '.#.', '..#', '##.'], T: ['###', '.#.', '.#.', '.#.', '.#.'], U: ['#.#', '#.#', '#.#', '#.#', '###'],
  V: ['#.#', '#.#', '#.#', '#.#', '.#.'], W: ['#.#', '#.#', '###', '###', '#.#'], X: ['#.#', '#.#', '.#.', '#.#', '#.#'],
  Y: ['#.#', '#.#', '.#.', '.#.', '.#.'], Z: ['###', '..#', '.#.', '#..', '###'],
  0: ['###', '#.#', '#.#', '#.#', '###'], 1: ['.#.', '##.', '.#.', '.#.', '###'], 2: ['##.', '..#', '.#.', '#..', '###'],
  3: ['##.', '..#', '.#.', '..#', '##.'], 4: ['#.#', '#.#', '###', '..#', '..#'], 5: ['###', '#..', '##.', '..#', '##.'],
  6: ['.##', '#..', '###', '#.#', '###'], 7: ['###', '..#', '.#.', '.#.', '.#.'], 8: ['###', '#.#', '###', '#.#', '###'],
  9: ['###', '#.#', '###', '..#', '##.'], ' ': ['...', '...', '...', '...', '...'], '-': ['...', '...', '###', '...', '...'],
  '!': ['.#.', '.#.', '.#.', '...', '.#.'], '.': ['...', '...', '...', '...', '.#.'], '?': ['##.', '..#', '.#.', '...', '.#.'],
  "'": ['.#.', '.#.', '...', '...', '...'],
};
const GLYPHS = Object.fromEntries(Object.entries(FONT).map(([k, rows]) => [k, rows.join('')]));

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, w);
  c.height = Math.max(1, h);
  c.getContext('2d').imageSmoothingEnabled = false;
  return c;
}

const px = (g, x, y, w, h, color) => {
  g.fillStyle = color;
  g.fillRect(x, y, w, h);
};

// A filled ellipse made of whole pixels, so its edge stays crisp after scaling.
function blob(g, cx, cy, rx, ry, color) {
  const x0 = Math.round(cx);
  const y0 = Math.round(cy);
  g.fillStyle = color;
  for (let y = -ry; y <= ry; y++) {
    const half = Math.round(rx * Math.sqrt(Math.max(0, 1 - (y * y) / (ry * ry || 1))));
    if (half > 0) g.fillRect(x0 - half, y0 + y, half * 2 + 1, 1);
  }
}

function silhouette(src, color) {
  const out = makeCanvas(src.width, src.height);
  const g = out.getContext('2d');
  g.drawImage(src, 0, 0);
  g.globalCompositeOperation = 'source-in';
  px(g, 0, 0, out.width, out.height, color);
  return out;
}

// Adds the dark 1-pixel outline every sprite wears. The result is 2 px larger each way.
function outlined(src) {
  const out = makeCanvas(src.width + 2, src.height + 2);
  const g = out.getContext('2d');
  const ink = silhouette(src, C.ink);
  for (const [dx, dy] of [[0, 1], [2, 1], [1, 0], [1, 2]]) g.drawImage(ink, dx, dy);
  g.drawImage(src, 1, 1);
  return out;
}

// ---- sprites ----------------------------------------------------------------------------------

// A kid, 14 x 22 before the outline, feet at (7, 21).
function paintKid(team, look, facing, frame, pose) {
  const c = makeCanvas(14, 22);
  const g = c.getContext('2d');
  const t = teamPx(team);
  const skin = LOOK.skin[look?.skin ?? 1] ?? LOOK.skin[1];
  const scarf = LOOK.scarf[look?.scarf ?? 7] ?? LOOK.scarf[7];
  const dy = pose === 'pack' ? 2 : 0;
  // boots and legs
  const lUp = frame === 1 ? 1 : 0;
  const rUp = frame === 2 ? 1 : 0;
  px(g, 3, 20 - lUp, 3, 2, C.boot);
  px(g, 8, 20 - rUp, 3, 2, C.boot);
  px(g, 4, 18 + dy, 6, 2 - Math.min(dy, 1), C.pants);
  // coat
  px(g, 3, 12 + dy, 8, 6, t.coat);
  px(g, 3, 17 + dy, 8, 1, t.dark);
  if (facing === 'down') px(g, 7, 13 + dy, 1, 4, t.dark);
  // arms and mittens
  if (pose === 'throw') {
    px(g, 2, 13, 1, 4, t.dark);
    px(g, 2, 17, 1, 1, C.mitten);
    px(g, 11, 9, 1, 4, t.dark);
    px(g, 11, 8, 2, 2, C.snowHi);
  } else if (pose === 'pack') {
    px(g, 4, 17 + dy, 1, 1, C.mitten);
    px(g, 9, 17 + dy, 1, 1, C.mitten);
    px(g, 5, 18 + dy, 4, 1, C.snowHi);
  } else {
    px(g, 2, 13 + dy, 1, 4, t.dark);
    px(g, 11, 13 + dy, 1, 4, t.dark);
    px(g, 2, 17 + dy, 1, 1, C.mitten);
    px(g, 11, 17 + dy, 1, 1, C.mitten);
  }
  // scarf
  px(g, 4, 11 + dy, 6, 1, scarf);
  if (facing === 'down') px(g, 8, 12 + dy, 1, 2, scarf);
  else if (facing === 'side') px(g, 4, 12 + dy, 1, 2, scarf);
  // head
  px(g, 4, 6 + dy, 6, 5, skin);
  if (facing === 'up') {
    px(g, 4, 6 + dy, 6, 3, t.dark);
  } else if (facing === 'side') {
    px(g, 8, 8 + dy, 1, 1, C.ink);
  } else {
    px(g, 5, 8 + dy, 1, 1, C.ink);
    px(g, 8, 8 + dy, 1, 1, C.ink);
  }
  // hat
  px(g, 4, 3 + dy, 6, 2, t.coat);
  px(g, 3, 5 + dy, 8, 1, t.dark);
  px(g, 6, 1 + dy, 2, 2, C.snowHi);
  return c;
}

function paintIceBlock() {
  const c = makeCanvas(18, 26);
  const g = c.getContext('2d');
  g.globalAlpha = 0.62;
  px(g, 1, 1, 16, 24, C.ice);
  g.globalAlpha = 1;
  px(g, 1, 1, 16, 1, C.iceHi);
  px(g, 1, 1, 1, 24, C.iceHi);
  px(g, 16, 1, 1, 24, C.iceLo);
  px(g, 1, 24, 16, 1, C.iceLo);
  px(g, 4, 4, 1, 4, C.iceHi);
  px(g, 5, 3, 2, 1, C.iceHi);
  px(g, 12, 18, 1, 3, C.iceHi);
  px(g, 0, 0, 18, 1, C.ink);
  px(g, 0, 25, 18, 1, C.ink);
  px(g, 0, 0, 1, 26, C.ink);
  px(g, 17, 0, 1, 26, C.ink);
  return c;
}

// Snow block: top face rows 0-19, front face rows 20-31, so the bottom sits on the cell's edge.
function paintWall(damaged) {
  const c = makeCanvas(20, 32);
  const g = c.getContext('2d');
  px(g, 0, 0, 20, 20, C.snowHi);
  px(g, 0, 18, 20, 2, C.snowLo);
  px(g, 18, 0, 2, 20, C.snowLo);
  px(g, 0, 20, 20, 12, C.shade);
  for (const y of [23, 27]) px(g, 0, y, 20, 1, C.deep);
  for (const [x, y0] of [[6, 20], [14, 20], [3, 24], [11, 24], [17, 24], [7, 28], [15, 28]]) px(g, x, y0, 1, 3, C.deep);
  if (damaged) {
    for (const [x, y] of [[6, 4], [7, 5], [7, 6], [8, 7], [12, 11], [13, 12], [13, 13], [9, 22], [10, 23]]) px(g, x, y, 1, 1, C.deep);
  }
  return outlined(c);
}

function paintDecoy(team) {
  const t = teamPx(team);
  const c = makeCanvas(20, 32);
  const g = c.getContext('2d');
  px(g, 9, 10, 2, 22, C.wood);
  px(g, 3, 13, 14, 2, C.woodLo);
  px(g, 5, 14, 10, 10, t.coat);
  px(g, 3, 15, 2, 6, t.coat);
  px(g, 15, 15, 2, 6, t.coat);
  px(g, 5, 23, 10, 1, t.dark);
  px(g, 9, 15, 1, 8, t.dark);
  px(g, 8, 14, 4, 1, t.dark);
  px(g, 6, 7, 8, 3, t.dark);
  px(g, 5, 9, 10, 1, t.dark);
  px(g, 9, 5, 2, 2, C.snowHi);
  return outlined(c);
}

// Spoon Flinger: a cart with a throwing spoon. Team A faces right; team B is drawn mirrored.
function paintPult(team, fired) {
  const t = teamPx(team);
  const c = makeCanvas(22, 32);
  const g = c.getContext('2d');
  px(g, 2, 22, 17, 5, C.wood);
  px(g, 2, 26, 17, 1, C.woodLo);
  px(g, 3, 27, 4, 4, C.metalLo);
  px(g, 14, 27, 4, 4, C.metalLo);
  px(g, 4, 28, 2, 2, C.metal);
  px(g, 15, 28, 2, 2, C.metal);
  px(g, 9, 15, 3, 8, C.woodLo);
  px(g, 12, 15, 4, 3, t.coat);
  // The arm, from the pivot to the spoon, a pixel at a time.
  const [ex, ey] = fired ? [19, 8] : [3, 11];
  const steps = 10;
  for (let i = 0; i <= steps; i++) {
    const x = Math.round(10 + ((ex - 10) * i) / steps);
    const y = Math.round(17 + ((ey - 17) * i) / steps);
    px(g, x, y, 2, 2, C.wood);
  }
  px(g, ex - 1, ey - 1, 4, 2, C.woodLo);
  if (!fired) px(g, ex, ey - 3, 2, 2, C.snowHi);
  return outlined(c);
}

function paintHeart(full) {
  const rows = ['##.##', '#####', '.###.', '..#..'];
  const c = makeCanvas(5, 4);
  const g = c.getContext('2d');
  rows.forEach((row, y) => {
    for (let x = 0; x < 5; x++) if (row[x] === '#') px(g, x, y, 1, 1, full ? C.heart : C.heartLo);
  });
  return outlined(c);
}

function paintIceball() {
  const c = makeCanvas(7, 7);
  const g = c.getContext('2d');
  blob(g, 3, 3, 3, 3, C.iceLo);
  blob(g, 3, 3, 2, 2, C.ice);
  px(g, 2, 2, 2, 1, C.iceHi);
  return outlined(c);
}

function paintPine() {
  const c = makeCanvas(28, 40);
  const g = c.getContext('2d');
  px(g, 12, 33, 4, 7, C.woodLo);
  const tiers = [[22, 34, 26], [13, 24, 20], [3, 14, 13]];
  for (const [top, bottom, width] of tiers) {
    for (let y = top; y <= bottom; y++) {
      const w = Math.max(2, Math.round((width * (y - top + 1)) / (bottom - top + 1)));
      const x0 = Math.round(14 - w / 2);
      px(g, x0, y, w, 1, C.pine);
      px(g, x0, y, Math.max(1, Math.round(w / 4)), 1, C.pineLo);
      if (y - top < 2) px(g, x0 + 1, y, Math.max(1, w - 2), 1, C.snowHi);
    }
    px(g, 14 - Math.round(width / 2), bottom, width, 1, C.snowHi);
  }
  return outlined(c);
}

function paintRound(w, h, body, low) {
  const c = makeCanvas(w, h);
  const g = c.getContext('2d');
  const cx = Math.floor(w / 2);
  const cy = Math.floor(h / 2);
  blob(g, cx, cy + 1, cx - 1, cy - 1, low);
  blob(g, cx, cy, cx - 1, Math.max(1, cy - 2), body);
  blob(g, cx, Math.round(h / 3), Math.round(w / 3), Math.max(1, Math.round(h / 6)), C.snowHi);
  return outlined(c);
}

function paintBin() {
  const c = makeCanvas(12, 16);
  const g = c.getContext('2d');
  px(g, 1, 4, 10, 12, C.metal);
  for (const x of [3, 6, 9]) px(g, x, 5, 1, 10, C.metalLo);
  px(g, 0, 2, 12, 2, C.metalLo);
  px(g, 1, 0, 10, 2, C.snowHi);
  return outlined(c);
}

function paintLamp() {
  const c = makeCanvas(8, 46);
  const g = c.getContext('2d');
  px(g, 1, 0, 6, 5, C.lamp);
  px(g, 2, 1, 4, 3, C.gold);
  px(g, 3, 5, 2, 39, C.lamp);
  px(g, 2, 43, 4, 3, C.lamp);
  px(g, 1, 0, 6, 1, C.snowHi);
  return outlined(c);
}

function paintBench(w) {
  const c = makeCanvas(w, 14);
  const g = c.getContext('2d');
  px(g, 0, 0, w, 3, C.woodLo);
  px(g, 0, 0, w, 1, C.snowHi);
  px(g, 0, 6, w, 4, C.wood);
  px(g, 0, 6, w, 1, C.snowHi);
  for (let x = 6; x < w - 2; x += 8) px(g, x, 7, 1, 3, C.woodLo);
  for (const x of [2, w - 4]) {
    px(g, x, 3, 2, 3, C.woodLo);
    px(g, x, 10, 2, 4, C.woodLo);
  }
  return outlined(c);
}

function paintBox(w, h, lift) {
  const c = makeCanvas(w, h + lift);
  const g = c.getContext('2d');
  px(g, 0, 0, w, h, C.snowHi);
  px(g, 0, h, w, lift, C.rock);
  px(g, 0, h, w, 1, C.rockLo);
  return outlined(c);
}

// ---- the ground -------------------------------------------------------------------------------

function bakeGround(map) {
  const W = Math.ceil(map.w / PX);
  const H = Math.ceil(map.h / PX);
  const c = makeCanvas(W, H);
  const g = c.getContext('2d');
  let seed = 7;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  px(g, 0, 0, W, H, C.snow);
  for (let i = 0; i < W * H * 0.04; i++) px(g, Math.floor(rnd() * W), Math.floor(rnd() * H), 1, 1, C.snowLo);
  for (let i = 0; i < W * H * 0.006; i++) px(g, Math.floor(rnd() * W), Math.floor(rnd() * H), 1, 1, C.snowHi);

  for (const d of map.decor ?? []) {
    const x = Math.round(d.x / PX);
    const y = Math.round(d.y / PX);
    if (d.type === 'snowpatch') {
      const w = Math.round(d.w / PX);
      const h = Math.round(d.h / PX);
      for (let yy = 0; yy < h; yy++) for (let xx = (yy & 1); xx < w; xx += 2) px(g, x + xx, y + yy, 1, 1, C.snowLo);
    } else if (d.type === 'drift') {
      const s = d.scale ?? 1;
      blob(g, x, y + 1, Math.round(9 * s), 3, C.shade);
      blob(g, x, y, Math.round(8 * s), 2, C.snowHi);
    } else if (d.type === 'sled') {
      px(g, x - 5, y - 2, 10, 3, C.sled);
      px(g, x - 6, y + 1, 12, 1, C.woodLo);
      px(g, x + 5, y - 1, 1, 2, C.woodLo);
    }
  }

  for (const s of map.ice ?? []) {
    if (s.shape !== 'ellipse') continue;
    const cx = Math.round(s.x / PX);
    const cy = Math.round(s.y / PX);
    const rx = Math.round(s.rx / PX);
    const ry = Math.round(s.ry / PX);
    blob(g, cx, cy, rx, ry, C.iceLo);
    blob(g, cx, cy, rx - 1, ry - 1, C.ice);
    px(g, cx - Math.round(rx / 2), cy - Math.round(ry / 3), Math.round(rx / 2), 1, C.iceHi);
    px(g, cx + 2, cy + 2, Math.round(rx / 3), 1, C.iceHi);
  }

  // A picket fence round the lot: rails, pickets and a cap of snow on each.
  const fenceRow = (y) => {
    px(g, 0, y + 2, W, 1, C.woodLo);
    px(g, 0, y + 5, W, 1, C.woodLo);
    for (let x = 1; x < W; x += 4) {
      px(g, x, y, 2, 7, C.wood);
      px(g, x, y, 2, 1, C.snowHi);
    }
  };
  fenceRow(0);
  fenceRow(H - 7);
  for (let y = 0; y < H; y += 4) {
    px(g, 0, y, 2, 3, C.wood);
    px(g, W - 2, y, 2, 3, C.wood);
  }
  return c;
}

// ---- the painter -------------------------------------------------------------------------------

export class RetroPainter {
  constructor() {
    this.canvas = makeCanvas(1, 1);
    this.g = this.canvas.getContext('2d');
    this.sprites = new Map();
    this.texts = new Map();
    this.hitAt = new Map();
    this.bits = [];
    this.flakes = [];
    this.groundMap = null;
    this.ground = null;
    this.obstacles = [];
    this.items = [];
    this.time = 0;
  }

  sprite(key, make) {
    let s = this.sprites.get(key);
    if (!s) {
      s = make();
      this.sprites.set(key, s);
    }
    return s;
  }

  text(str, color) {
    const key = `${color}|${str}`;
    let t = this.texts.get(key);
    if (!t) {
      const chars = [...str.toUpperCase()].map((ch) => GLYPHS[ch] ?? GLYPHS['?']);
      // A drop shadow rather than a full outline: an outline fills the gaps and letters run together.
      t = makeCanvas(Math.max(1, chars.length * 4), 6);
      const g = t.getContext('2d');
      for (const [ink, off] of [[C.ink, 1], [color, 0]]) {
        chars.forEach((glyph, i) => {
          for (let n = 0; n < 15; n++) if (glyph[n] === '#') px(g, i * 4 + (n % 3) + off, Math.floor(n / 3) + off, 1, 1, ink);
        });
      }
      if (this.texts.size > 300) this.texts.clear();
      this.texts.set(key, t);
    }
    return t;
  }

  flash(id, time) {
    this.hitAt.set(id, time);
  }

  burst(x, y, ice) {
    for (let i = 0; i < 9; i++) {
      const ang = (i / 9) * Math.PI * 2 + Math.random() * 0.4;
      const speed = 24 + Math.random() * 36;
      this.bits.push({
        x: x / PX, y: y / PX, vx: Math.cos(ang) * speed, vy: Math.sin(ang) * speed * 0.6 - 18,
        life: 0.28 + Math.random() * 0.2, color: ice && i % 2 ? C.ice : C.snowHi,
      });
    }
    if (this.bits.length > 240) this.bits.splice(0, this.bits.length - 240);
  }

  setMap(map) {
    this.groundMap = map;
    this.ground = bakeGround(map);
    this.obstacles = (map.obstacles ?? []).map((o) => ({ key: o.shape === 'rect' ? o.y + o.h : o.y, o }));
  }

  obstacleSprite(o) {
    if (o.shape === 'rect') {
      const w = Math.round(o.w / PX);
      const h = Math.round(o.h / PX);
      if (o.type === 'bench') return { sp: this.sprite(`bench|${w}`, () => paintBench(w)), dx: -1, dy: h - 15 };
      return { sp: this.sprite(`box|${w}|${h}`, () => paintBox(w, h, 8)), dx: -1, dy: -9 };
    }
    const r = Math.round(o.r / PX);
    switch (o.type) {
      case 'pine': return { sp: this.sprite('pine', paintPine), dx: -15, dy: -40 };
      case 'bush': return { sp: this.sprite(`bush|${r}`, () => paintRound(r * 2, Math.round(r * 1.2), C.pine, C.pineLo)), dx: -r - 1, dy: -Math.round(r * 1.2) };
      case 'rock': return { sp: this.sprite(`rock|${r}`, () => paintRound(r * 2, Math.round(r * 1.3), C.rock, C.rockLo)), dx: -r - 1, dy: -Math.round(r * 1.3) };
      case 'bin': return { sp: this.sprite('bin', paintBin), dx: -7, dy: -16 };
      case 'lamp': return { sp: this.sprite('lamp', paintLamp), dx: -5, dy: -46 };
      default: return { sp: this.sprite(`dot|${r}`, () => paintRound(r * 2, Math.round(r * 1.3), C.rock, C.rockLo)), dx: -r - 1, dy: -Math.round(r * 1.3) };
    }
  }

  kidSprite(a, player, time) {
    const sin = Math.sin(a.aim);
    const facing = sin > 0.38 ? 'down' : sin < -0.38 ? 'up' : 'side';
    const moving = Math.hypot(a.vx || 0, a.vy || 0) > 25;
    const frame = moving ? 1 + (Math.floor(time * 8 + a.id) % 2) : 0;
    let pose = 'stand';
    if (a.flags & AFLAG.CHARGING) pose = 'throw';
    else if (a.flags & (AFLAG.PACKING | AFLAG.SLIDING)) pose = 'pack';
    const flashing = time - (this.hitAt.get(a.id) ?? -9) < HIT_FLASH;
    const look = player?.look ?? null;
    const key = `kid|${a.team}|${look?.skin ?? 1}|${look?.scarf ?? 7}|${facing}|${frame}|${pose}|${flashing ? 1 : 0}`;
    const sp = this.sprite(key, () => {
      const base = outlined(paintKid(a.team, look, facing, frame, pose));
      return flashing ? silhouette(base, C.snowHi) : base;
    });
    return { sp, flip: facing === 'side' && Math.cos(a.aim) < 0 };
  }

  paint(ctx, view, ui, r, dt) {
    this.time += dt;
    const time = this.time;
    if (this.groundMap !== r.map) this.setMap(r.map);
    const viewW = r.cssW / r.zoom;
    const viewH = r.cssH / r.zoom;
    const bw = Math.ceil(viewW / PX) + 2;
    const bh = Math.ceil(viewH / PX) + 2;
    if (this.canvas.width !== bw || this.canvas.height !== bh) {
      this.canvas.width = bw;
      this.canvas.height = bh;
      this.g = this.canvas.getContext('2d');
      this.flakes = Array.from({ length: FLAKES }, (_, i) => ({ x: (i * 97) % bw, y: (i * 53) % bh, s: 6 + (i % 7) * 2, big: i % 5 === 0 }));
    }
    const g = this.g;
    g.imageSmoothingEnabled = false;
    g.setTransform(1, 0, 0, 1, 0, 0);
    const camX = Math.floor(r.cam.x / PX);
    const camY = Math.floor(r.cam.y / PX);
    const sx = (wx) => Math.round(wx / PX) - camX;
    const sy = (wy) => Math.round(wy / PX) - camY;

    px(g, 0, 0, bw, bh, C.snowLo);
    g.drawImage(this.ground, -camX, -camY);

    // The truce rope, while BUILD lasts.
    const truce = r.map.truce;
    if (view.meta?.truce && truce?.axis === 'x') {
      const x = sx(truce.at);
      for (let y = 0; y < bh; y++) px(g, x, y, 1, 1, ((y + camY) >> 2) & 1 ? C.rope : C.snowHi);
      for (let wy = 0; wy < r.map.h; wy += 64) {
        const y = sy(wy);
        if (y < -8 || y > bh + 8) continue;
        px(g, x - 1, y - 5, 3, 6, C.woodLo);
        px(g, x - 1, y - 5, 3, 1, C.snowHi);
      }
    }

    // Shadows first, flat on the snow.
    for (const a of view.actors ?? []) {
      if (a.kind !== ACTOR.KID) continue;
      px(g, sx(a.x) - 5, sy(a.y) - 1, 10, 2, C.shade);
    }
    for (const b of view.balls ?? []) px(g, sx(b.x) - 1, sy(b.y), 3, 1, C.shade);

    // Everything that stands up, back to front.
    const items = this.items;
    items.length = 0;
    for (const ob of this.obstacles) items.push({ key: ob.key, t: 0, ref: ob.o });
    for (const s of view.structs ?? []) items.push({ key: (s.cy + 1) * CELL, t: 1, ref: s });
    for (const p of view.pickups ?? []) items.push({ key: p.y, t: 2, ref: p });
    for (const a of view.actors ?? []) items.push({ key: a.y, t: 3, ref: a });
    items.sort((p, q) => p.key - q.key);
    const players = view.players;
    for (const it of items) {
      if (it.t === 0) {
        const o = it.ref;
        const { sp, dx, dy } = this.obstacleSprite(o);
        const ox = o.shape === 'rect' ? sx(o.x) : sx(o.x);
        const oy = o.shape === 'rect' ? sy(o.y) : sy(o.y);
        g.drawImage(sp, ox + dx, oy + dy);
      } else if (it.t === 1) {
        this.drawStruct(g, it.ref, sx, sy, r);
      } else if (it.t === 2) {
        const p = it.ref;
        const bob = Math.round(Math.sin(time * 3 + p.id) * 1.5);
        g.drawImage(this.sprite('iceball', paintIceball), sx(p.x) - 4, sy(p.y) - 12 + bob);
        if (Math.floor(time * 4 + p.id) % 3 === 0) px(g, sx(p.x) + 3, sy(p.y) - 14 + bob, 1, 1, C.snowHi);
      } else {
        this.drawKid(g, it.ref, players?.get(it.ref.id) ?? null, sx, sy, time);
      }
    }

    // Snowballs, lifted by their height.
    for (const b of view.balls ?? []) {
      const x = sx(b.x);
      const y = sy(b.y - b.z * Z_LIFT);
      const fill = b.kind === BALL.ICE ? C.ice : C.snowHi;
      px(g, x - 2, y - 1, 5, 3, C.ink);
      px(g, x - 1, y - 2, 3, 5, C.ink);
      px(g, x - 1, y - 1, 3, 3, fill);
      if (b.kind === BALL.POWER) px(g, x - 2, y - 1, 1, 2, fill);
    }

    // Impact bits.
    const bits = this.bits;
    for (let i = bits.length - 1; i >= 0; i--) {
      const bit = bits[i];
      bit.life -= dt;
      if (bit.life <= 0) {
        bits.splice(i, 1);
        continue;
      }
      bit.vy += 90 * dt;
      bit.x += bit.vx * dt;
      bit.y += bit.vy * dt;
      px(g, Math.round(bit.x) - camX, Math.round(bit.y) - camY, 1, 1, bit.color);
    }

    // Names and hearts over every kid, on top of everything.
    const me = view.me?.id;
    for (const a of view.actors ?? []) {
      if (a.kind !== ACTOR.KID) continue;
      const x = sx(a.x);
      const y = sy(a.y);
      if (a.flags & AFLAG.FROZEN) {
        const ko = this.text('KO', C.heart);
        g.drawImage(ko, x - Math.floor(ko.width / 2), y - 31);
      } else {
        const hearts = Math.max(0, Math.min(CLASSIC.hits, Math.round((a.hp ?? 1) * CLASSIC.hits)));
        for (let i = 0; i < CLASSIC.hits; i++) {
          const heart = this.sprite(i < hearts ? 'heart1' : 'heart0', () => paintHeart(i < hearts));
          g.drawImage(heart, x - 11 + i * 7, y - 31);
        }
      }
      if (a.id === me) {
        const ay = y - 50 + Math.round(Math.sin(time * 5));
        px(g, x - 2, ay, 5, 1, C.gold);
        px(g, x - 1, ay + 1, 3, 1, C.gold);
        px(g, x, ay + 2, 1, 1, C.gold);
      }
    }

    // A little falling snow, in screen space.
    for (const f of this.flakes) {
      f.y += f.s * dt;
      f.x += Math.sin(time * 1.3 + f.s) * 4 * dt;
      if (f.y > bh) {
        f.y = -2;
        f.x = Math.random() * bw;
      }
      px(g, Math.round(f.x), Math.round(f.y), f.big ? 2 : 1, f.big ? 2 : 1, C.snowHi);
    }

    // Up to full size with no smoothing: every retro pixel becomes a crisp block.
    const scale = r.zoom * r.pixelRatio * PX;
    const offX = -((r.cam.x + r.shakeX) / PX - camX) * scale;
    const offY = -((r.cam.y + r.shakeY) / PX - camY) * scale;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.canvas, 0, 0, bw, bh, Math.round(offX), Math.round(offY), Math.ceil(bw * scale), Math.ceil(bh * scale));
    ctx.imageSmoothingEnabled = true;

    // Names go on the sharp layer: a 3x5 pixel font is too small to read at this scale. Blocky
    // capitals with a hard shadow keep them in the same style as the retro HUD.
    const pr = r.pixelRatio;
    ctx.setTransform(pr, 0, 0, pr, 0, 0);
    ctx.font = 'bold 11px ui-monospace, Menlo, Consolas, "Courier New", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    for (const a of view.actors ?? []) {
      if (a.kind !== ACTOR.KID) continue;
      const name = (players?.get(a.id)?.name ?? '').toUpperCase().slice(0, 12);
      if (!name) continue;
      const nx = Math.round((a.x - r.cam.x - r.shakeX) * r.zoom);
      const ny = Math.round((a.y - 66 - r.cam.y - r.shakeY) * r.zoom);
      ctx.fillStyle = C.ink;
      ctx.fillText(name, nx + 1, ny + 1);
      ctx.fillStyle = a.id === me ? C.gold : C.snowHi;
      ctx.fillText(name, nx, ny);
    }
    ctx.textAlign = 'start';
  }

  drawStruct(g, s, sx, sy, r) {
    const x = sx(s.cx * CELL);
    const bottom = sy((s.cy + 1) * CELL);
    if (s.kind === STRUCT.WALL || s.kind === STRUCT.ICEWALL) {
      const max = s.maxHp || BUILD[s.kind]?.hp || 1;
      const damaged = s.hp / max < 0.5;
      g.drawImage(this.sprite(`wall|${damaged ? 1 : 0}`, () => paintWall(damaged)), x - 1, bottom - 33);
    } else if (s.kind === STRUCT.DECOY) {
      g.drawImage(this.sprite(`decoy|${s.team}`, () => paintDecoy(s.team)), x - 1, bottom - 33);
    } else if (s.kind === STRUCT.PULT) {
      const fired = r.pultFired.get(s.id);
      const recent = fired && r.time - fired.t < 0.5;
      const sp = this.sprite(`pult|${s.team}|${recent ? 1 : 0}`, () => paintPult(s.team, recent));
      if (s.team === TEAM.B) {
        g.save();
        g.translate(2 * x + 22, 0);
        g.scale(-1, 1);
        g.drawImage(sp, x - 1, bottom - 33);
        g.restore();
      } else {
        g.drawImage(sp, x - 1, bottom - 33);
      }
    } else {
      g.drawImage(this.sprite('wall|0', () => paintWall(false)), x - 1, bottom - 33);
    }
  }

  drawKid(g, a, player, sx, sy, time) {
    const x = sx(a.x);
    const y = sy(a.y);
    const frozen = (a.flags & AFLAG.FROZEN) !== 0;
    // Just thawed or new in: blink, the old way of saying "can't touch me".
    if (!frozen && (a.flags & AFLAG.GRACE) && Math.floor(time * 10) % 2 === 0) return;
    const { sp, flip } = this.kidSprite(a, player, time);
    if (flip) {
      g.save();
      g.translate(x * 2, 0);
      g.scale(-1, 1);
      g.drawImage(sp, x - 8, y - 23);
      g.restore();
    } else {
      g.drawImage(sp, x - 8, y - 23);
    }
    if (frozen) g.drawImage(this.sprite('ice', paintIceBlock), x - 9, y - 24);
  }
}
