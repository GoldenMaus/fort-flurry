// Fort Flurry — dev gallery for the character art. Not linked from the game.
// Everything goes through the same ActorArt.draw and drawColonel calls the renderer makes, with scripted
// actor records, so a state shown here is a state the game can reach. Two ActorArt instances run
// side by side because the sprite scale is per instance: one at game scale and one at 3x.
//   ?s=kids|looks|faceoff|foes|foes2|shapes|truck|steve|colonel|icons|scene|cost   one section
//   ?t=2.5                                                   step to that time, then hold still
//   ?game=2                                                  sprite scale for the game-size column

import { ActorArt, drawKid, iconCanvas } from '../js/render/sprites.js';
import { ACTOR, AFLAG, AUX, BALL, MODE, PICKUP, STRUCT, TEAM } from '../shared/schema.js';
import { CELL, FOES, LOOK } from '../shared/constants.js';
import { CARDS } from '../shared/cards.js';

const params = new URLSearchParams(location.search);
const only = params.get('s');
const holdAt = params.has('t') ? Number(params.get('t')) : null;
const dpr = window.devicePixelRatio || 1;
const gameScale = Number(params.get('game')) || Math.min(3, Math.ceil(dpr * 2) / 2);

const FOE_KINDS = [ACTOR.PIPSQUEAK, ACTOR.SLINGER, ACTOR.LOBBER, ACTOR.BRUISER, ACTOR.SLEDDER, ACTOR.LIDKID, ACTOR.SNEAK];

let nextId = 2000;

function actor(kind, over = {}) {
  const id = nextId++;
  return {
    id, kind, team: kind === ACTOR.KID ? TEAM.A : TEAM.FOES, x: id * 300, y: 0, vx: 0, vy: 0, aim: Math.PI / 2, hp: 1, flags: 0, aux: 0, ...over,
  };
}

// Pulses true for `on` seconds of every `period`.
const pulse = (t, period, on, phase = 0) => ((t + phase) % period) < on;

function snow(ctx, w, h) {
  ctx.fillStyle = '#f2f6fc';
  ctx.fillRect(0, 0, w, h);
  let s = 7;
  const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  for (let i = 0; i < w * h / 12000; i++) {
    ctx.beginPath();
    ctx.ellipse(rnd() * w, rnd() * h, 60 + rnd() * 120, 22 + rnd() * 40, rnd() * 0.5 - 0.25, 0, 6.3);
    ctx.fillStyle = `rgba(190,190,230,${0.05 + rnd() * 0.07})`;
    ctx.fill();
  }
}

function shadow(ctx, x, y, r) {
  ctx.beginPath();
  ctx.ellipse(x, y + 2, r, r * 0.5, 0, 0, 6.3);
  ctx.fillStyle = 'rgba(112,100,170,0.26)';
  ctx.fill();
}

const footR = (a) => {
  if (a.kind === ACTOR.KID) return 13;
  if (a.kind === ACTOR.TRUCK) return 56;
  return FOES[a.kind]?.r ?? 13;
};

// One sheet is one canvas of tiles. A tile knows how to update its actor for time t, then is drawn twice.
class Sheet {
  constructor(id, title, note, width, height) {
    this.id = id;
    this.width = width;
    this.height = height;
    this.tiles = [];
    this.view = { mode: MODE.SIEGE, actors: [], balls: [], meta: {} };
    this.game = new ActorArt({ scale: gameScale });
    this.big = new ActorArt({ scale: 3 });
    const sec = document.createElement('section');
    sec.id = id;
    const h2 = document.createElement('h2');
    h2.textContent = title;
    const p = document.createElement('p');
    p.textContent = note;
    this.canvas = document.createElement('canvas');
    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(height * dpr);
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
    this.ctx = this.canvas.getContext('2d', { alpha: false });
    sec.append(h2, p, this.canvas);
    document.getElementById('main').append(sec);
    this.ground = document.createElement('canvas');
    this.ground.width = width;
    this.ground.height = height;
    snow(this.ground.getContext('2d'), width, height);
  }

  tile(col, row, label, a, opts = {}) {
    const t = { col, row, label, a, ...opts };
    this.tiles.push(t);
    this.view.actors.push(a);
    return t;
  }

  render(t, dt) {
    const { ctx } = this;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalAlpha = 1;
    ctx.drawImage(this.ground, 0, 0, this.width, this.height);
    this.view.balls.length = 0;
    for (const tl of this.tiles) tl.update?.(tl.a, t, this.view);
    for (const tl of this.tiles) {
      const x = tl.col, y = tl.row;
      const a = tl.a;
      // Game size on the left of the tile, 3x on the right.
      ctx.save();
      ctx.translate(x + (tl.small ?? 30) - a.x, y + (tl.foot ?? 112) - a.y);
      shadow(ctx, a.x, a.y, footR(a));
      this.game.draw(ctx, a, { time: t, dt, player: tl.player, me: false, view: this.view });
      ctx.restore();
      if (!tl.noBig) {
        ctx.save();
        ctx.translate(x + (tl.bigX ?? 118), y + (tl.foot ?? 112));
        ctx.scale(3, 3);
        ctx.translate(-a.x, -a.y);
        shadow(ctx, a.x, a.y, footR(a));
        this.big.draw(ctx, a, { time: t, dt, player: tl.player, me: false, view: this.view });
        ctx.restore();
      }
      ctx.font = '12px -apple-system, Segoe UI, Roboto, sans-serif';
      ctx.fillStyle = '#564c7c';
      ctx.fillText(tl.label, x + 4, y + 13);
    }
    this.extra?.(ctx, t, dt);
  }
}

// ---- kids ------------------------------------------------------------------------------------------

function kidSheet() {
  const sh = new Sheet('kids', 'Kids: every pose', 'Left of each tile is true game size, right is 3x. Scarf tails are live, squash is a drawImage transform.', 1500, 880);
  const W = 214, H = 170;
  const player = { look: { hat: 0, coat: 0, scarf: 4, skin: 1 } };
  const cases = [
    ['idle', {}, null],
    ['walking', { vx: 205 * 0.7, vy: 205 * 0.7, aim: 0.8 }, null],
    ['walk away', { vy: -205, aim: -Math.PI / 2 }, null],
    ['charging', { aim: 0.5 }, (a, t) => {
      const c = (t % 1.3) / 0.9;
      if (c < 1) { a.flags = AFLAG.CHARGING; a.aux = Math.floor(c * 255); } else a.flags = 0;
    }],
    ['lob aim then lob', { aim: 1.2 }, (a, t) => { a.flags = pulse(t, 1.5, 1) ? AFLAG.LOBAIM : 0; }],
    ['packing', { flags: AFLAG.PACKING, aim: 1.2 }, null],
    ['sliding', { flags: AFLAG.SLIDING }, (a, t) => {
      const q = Math.floor(t / 0.8) * (Math.PI / 4);
      a.vx = Math.cos(q) * 520;
      a.vy = Math.sin(q) * 520;
    }],
    ['snowboarding', { flags: AFLAG.BOARDING, vx: 300, vy: 90, aim: 0.3 }, null],
    ['frozen', { flags: AFLAG.FROZEN }, (a, t) => { a.aux = Math.floor((t % 4) / 4 * 255); }],
    ['hit', { aim: 1 }, (a, t) => { a.hp = 1 - (Math.floor(t / 1.1) % 8) * 0.1; }],
    ['stunned', { flags: AFLAG.STUNNED }, null],
    ['slowed', { flags: AFLAG.SLOWED, vx: 110 }, null],
    ['AFK', { flags: AFLAG.AFK }, null],
    ['grace', { flags: AFLAG.GRACE }, null],
    ['board + charge', { flags: AFLAG.BOARDING | AFLAG.CHARGING, aux: 200, vx: 300, aim: 0.2 }, null],
    ['charge on the run', { flags: AFLAG.CHARGING, aux: 255, vx: 140, aim: Math.PI }, null],
    ['won: cheering', { flags: AFLAG.LOCKED }, null],
    ['thrown, at 3/4', { aim: 2.4 }, (a, t) => { a.flags = pulse(t, 0.9, 0.5) ? AFLAG.CHARGING : 0; a.aux = 255; }],
  ];
  cases.forEach(([label, over, update], i) => {
    const a = actor(ACTOR.KID, over);
    sh.tile(10 + (i % 7) * W, 8 + Math.floor(i / 7) * H, label, a, { player, update, foot: 140 });
  });
  sh.view.meta = { colonels: [{ team: TEAM.A, hp: 900, mhp: 1500 }], leaderId: null };
  const dirs = [2, 1, 0, 7, 6, 5, 4, 3];
  dirs.forEach((d, i) => {
    const a = actor(ACTOR.KID, { aim: d * (Math.PI / 4) });
    sh.tile(10 + i * 182, 8 + 3 * H, `aim ${d}`, a, { player: { look: { hat: 3, coat: 4, scarf: 1, skin: 3 } }, foot: 140, bigX: 100 });
  });
  dirs.forEach((d, i) => {
    const a = actor(ACTOR.KID, { aim: d * (Math.PI / 4), vx: Math.cos(d * Math.PI / 4) * 205, vy: Math.sin(d * Math.PI / 4) * 205 });
    sh.tile(10 + i * 182, 8 + 4 * H, `run ${d}`, a, { player: { look: { hat: 2, coat: 5, scarf: 2, skin: 5 } }, foot: 140, bigX: 100 });
  });
  return sh;
}

function looksSheet() {
  const sh = new Sheet('looks', 'Kids: every hat, coat, scarf and skin', 'Game size, plus Face-Off team colours on the last two rows: the scarf and bobble change, the rest of the look stays.', 1500, 690);
  sh.extra = (ctx) => {
    let y = 86;
    for (let h = 0; h < LOOK.hat.length; h++) {
      LOOK.coat.forEach((c, i) => {
        drawKid(ctx, { hat: h, coat: i, scarf: (i * 3 + h) % 8, skin: (i + h) % 6 }, 40 + i * 44, y, 1, { frame: 0 });
      });
      for (let d = 0; d < 8; d++) {
        drawKid(ctx, { hat: h, coat: (h + 2) % 8, scarf: (h * 3 + 1) % 8, skin: h }, 420 + d * 44, y, 1, { dir: d, frame: 0 });
      }
      drawKid(ctx, { hat: h, coat: (h + 5) % 8, scarf: (h * 5 + 3) % 8, skin: (h + 3) % 6 }, 860 + h * 110, y + 24, 2.2, { frame: 0, dir: 1 });
      y += 76;
    }
    for (const [row, team] of [[0, TEAM.A], [1, TEAM.B]]) {
      for (let i = 0; i < 8; i++) {
        const yy = 560 + row * 60;
        drawKid(ctx, { hat: i % 6, coat: i, scarf: (i * 3) % 8, skin: i % 6 }, 40 + i * 44, yy, 1, { team, frame: 0 });
      }
    }
    LOOK.skin.forEach((s, i) => drawKid(ctx, { hat: 1, coat: i, scarf: i, skin: i }, 460 + i * 120, 640, 2.4, { frame: 0 }));
  };
  return sh;
}

// ---- foes ------------------------------------------------------------------------------------------

function foeSheet() {
  const names = { [ACTOR.PIPSQUEAK]: 'Pipsqueak', [ACTOR.SLINGER]: 'Slinger', [ACTOR.LOBBER]: 'Lobber', [ACTOR.BRUISER]: 'Big Kid', [ACTOR.SLEDDER]: 'Sledder', [ACTOR.LIDKID]: 'Lid Kid', [ACTOR.SNEAK]: 'Carrot Thief' };
  const sh = new Sheet('foes', 'Foes: every state', 'Each row one foe: idle, walking, throwing, hit, stunned, fleeing. Throws are driven by fake balls in view.balls, the way the game triggers them.', 1500, 1640);
  const W = 244, H = 232;
  FOE_KINDS.forEach((kind, r) => {
    const big = kind === ACTOR.BRUISER;
    const y = 8 + r * H;
    const foot = big ? 214 : 194;
    const opts = { foot, small: 36, bigX: 150 };
    const cells = [
      ['idle', {}, null],
      ['walk', { vx: 90, vy: 50 }, null],
      ['throw', { aim: 0.6 }, (a, t, view) => {
        if (pulse(t, 1.2, 0.03)) view.balls.push({ id: a.id * 100 + Math.floor(t / 1.2), kind: BALL.QUICK, x: a.x + 6, y: a.y + 3, z: 20 });
      }],
      ['hit', { aim: 1.4 }, (a, t) => { a.hp = 1 - (Math.floor(t / 1.1) % 8) * 0.1; }],
      ['stunned', { flags: AFLAG.STUNNED }, null],
      ['fleeing', { flags: AFLAG.FLEEING, vx: -105, vy: 40 }, null],
    ];
    cells.forEach(([label, over, update], i) => {
      sh.tile(10 + i * W, y, `${names[kind]}: ${label}`, actor(kind, over), { ...opts, update });
    });
  });
  return sh;
}

// The squint test. Each actor is flattened to one colour at game size: if two foes can't be told apart
// here, colour is doing all the work and a colour-blind player or a blizzard will lose them.
function silhouetteSheet() {
  const sh = new Sheet('shapes', 'Silhouette test', 'Every foe at game size as a flat shape, walking and at rest, next to a kid. No colour to lean on.', 1500, 330);
  sh.tiles = [];
  const art = new ActorArt({ scale: gameScale });
  const cell = document.createElement('canvas');
  cell.width = cell.height = 150 * Math.ceil(dpr);
  const cx = cell.getContext('2d');
  const rows = [
    [0, ACTOR.KID, {}], [1, ACTOR.PIPSQUEAK, {}], [2, ACTOR.SLINGER, {}], [3, ACTOR.LOBBER, {}], [4, ACTOR.BRUISER, {}],
    [5, ACTOR.SLEDDER, { flags: AFLAG.SLEDDING, vx: 340, vy: 90 }], [6, ACTOR.SLEDDER, {}], [7, ACTOR.LIDKID, { aim: 0.5 }], [8, ACTOR.SNEAK, { vx: 160, vy: 40 }], [9, ACTOR.SNEAK, { vx: 160, vy: 40, aux: AUX.NOSE }],
  ];
  const stamp = (a, ctx, x, y, t, dt) => {
    const k = cell.width / 150;
    cx.setTransform(1, 0, 0, 1, 0, 0);
    cx.globalCompositeOperation = 'source-over';
    cx.clearRect(0, 0, cell.width, cell.height);
    cx.setTransform(k, 0, 0, k, (75 - a.x) * k, (120 - a.y) * k);
    art.draw(cx, a, { time: t, dt, view: sh.view });
    cx.setTransform(1, 0, 0, 1, 0, 0);
    cx.globalCompositeOperation = 'source-in';
    cx.fillStyle = '#352e52';
    cx.fillRect(0, 0, cell.width, cell.height);
    ctx.drawImage(cell, x - 75, y - 120, 150, 150);
  };
  const walkers = rows.map(([i, kind, o]) => ({ i, a: actor(kind, { aim: 0.5, ...o }), b: actor(kind, { aim: Math.PI / 2, vx: 0, vy: 0, flags: o.flags ?? 0, aux: o.aux ?? 0 }) }));
  sh.extra = (ctx, t, dt) => {
    for (const w of walkers) {
      stamp(w.a, ctx, 80 + w.i * 145, 130, t, dt);
      stamp(w.b, ctx, 80 + w.i * 145, 280, t, dt);
    }
  };
  return sh;
}

function foeExtrasSheet() {
  const sh = new Sheet('foes2', 'Sledder, Lid Kid, Thief specials', 'The Sledder on the sled at all headings and after the crash; the lid swinging on its own while the kid walks; the Thief with and without his prize.', 1500, 830);
  const W = 244;
  for (let i = 0; i < 6; i++) {
    const q = i * (Math.PI / 3) + 0.2;
    sh.tile(10 + i * W, 8, 'sledding', actor(ACTOR.SLEDDER, { flags: AFLAG.SLEDDING, vx: Math.cos(q) * 340, vy: Math.sin(q) * 340 }), { foot: 150, small: 46, bigX: 160 });
  }
  sh.tile(10, 200, 'sled, fleeing', actor(ACTOR.SLEDDER, { flags: AFLAG.SLEDDING | AFLAG.FLEEING, vx: 200, vy: 80 }), { foot: 150, small: 46, bigX: 160 });
  sh.tile(10 + W, 200, 'crash, climbs off', actor(ACTOR.SLEDDER, {}), {
    foot: 150, small: 36, bigX: 160,
    update: (a, t) => {
      const on = (t % 5) < 1;
      a.flags = on ? AFLAG.SLEDDING : 0;
      a.vx = on ? 340 : 0;
    },
  });
  sh.tile(10 + W * 2, 200, 'just spawned, grace', actor(ACTOR.SLEDDER, { flags: AFLAG.GRACE | AFLAG.SLEDDING, aim: 0.3 }), { foot: 150, small: 46, bigX: 160 });
  sh.tile(10 + W * 3, 200, 'Thief running', actor(ACTOR.SNEAK, { vx: 160, vy: 60 }), { foot: 150, small: 36, bigX: 160 });
  sh.tile(10 + W * 4, 200, 'Thief with carrot', actor(ACTOR.SNEAK, { vx: 160, vy: 60, aux: AUX.NOSE }), { foot: 150, small: 36, bigX: 160 });
  sh.tile(10 + W * 5, 200, 'carrot, going up', actor(ACTOR.SNEAK, { vx: 20, vy: -170, aux: AUX.NOSE }), { foot: 150, small: 36, bigX: 160 });
  for (let i = 0; i < 6; i++) {
    const body = [0, 0.8, 1.6, -0.8, -1.6, 3.1][i];
    sh.tile(10 + i * W, 400, 'lid swings, body walks', actor(ACTOR.LIDKID, { flags: AFLAG.SHIELDED, vx: Math.cos(body) * 80, vy: Math.sin(body) * 80 }), {
      foot: 160, small: 36, bigX: 160, update: (a, t) => { a.aim = t * 1 + i; },
    });
  }
  for (let i = 0; i < 6; i++) {
    const aim = i * (Math.PI / 3) + 0.26;
    sh.tile(10 + i * W, 610, `lid held at ${aim.toFixed(1)}`, actor(ACTOR.LIDKID, { flags: AFLAG.SHIELDED, aim }), { foot: 160, small: 36, bigX: 160 });
  }
  return sh;
}

function faceOffSheet() {
  const sh = new Sheet('faceoff', 'Face-Off: team colours through ActorArt', 'Same looks on both teams. Scarf, bobble and tails take the team colour; hat body, coat and skin stay the player\'s own.', 1500, 300);
  sh.view.mode = MODE.FORTWARS;
  for (let i = 0; i < 6; i++) {
    const a = actor(ACTOR.KID, { team: i % 2 ? TEAM.B : TEAM.A, aim: 0.5, vx: 120 });
    sh.tile(10 + i * 244, 8, i % 2 ? 'Scarf Squad' : 'Mitten Brigade', a, { foot: 150, small: 36, bigX: 150, player: { look: { hat: Math.floor(i / 2) * 2, coat: i + 1, scarf: 3, skin: i } } });
  }
  return sh;
}

// ---- bosses ----------------------------------------------------------------------------------------

function truckSheet() {
  const sh = new Sheet('truck', 'The Sno-Cone Truck', 'Eight headings at game size, then 3x: driving with the turret tracking and doors cycling, parked with doors open, and driving off defeated.', 1500, 1780);
  const headings = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => i * (Math.PI / 4));
  headings.forEach((h, i) => {
    const a = actor(ACTOR.TRUCK, { vx: Math.cos(h) * 95, vy: Math.sin(h) * 95, aim: h + 0.8 });
    sh.tile(i * 186, 8, `heading ${i * 45}`, a, { foot: 150, small: 92, noBig: true });
  });
  const parked = (h, doors, extra = {}) => (ac, t) => {
    ac.aim = 1.6 + t;
    ac.aux = doors(t) ? AUX.DOORS : 0;
    ac.vx = t < 0.2 ? Math.cos(h) * 95 : 0;
    ac.vy = t < 0.2 ? Math.sin(h) * 95 : 0;
    ac.hp = 1 - (Math.floor(t / 1.7) % 6) * 0.05;
    Object.assign(ac, extra);
  };
  [[0, 0.1], [1, 2.9], [2, -0.75]].forEach(([i, h]) => {
    const a = actor(ACTOR.TRUCK, { aim: h + 1 });
    sh.tile(i * 500 + 6, 196, `driving, heading ${h}`, a, {
      foot: 400, small: 70, bigX: 300,
      update: (ac, t) => { ac.aim = h + 1 + t * 0.7; ac.vx = Math.cos(h) * 95; ac.vy = Math.sin(h) * 95; },
    });
  });
  [[0, -1.57], [1, 1.57], [2, -0.4]].forEach(([i, h]) => {
    sh.tile(i * 500 + 6, 690, `parked, doors open, heading ${h}`, actor(ACTOR.TRUCK, {}), { foot: 460, small: 70, bigX: 300, update: parked(h, () => true) });
  });
  [[0, 0.5], [1, 2.5], [2, -2.2]].forEach(([i, h]) => {
    sh.tile(i * 500 + 6, 1240, i === 2 ? 'driving off, beaten' : `doors cycling, heading ${h}`, actor(ACTOR.TRUCK, {}), {
      foot: 440, small: 70, bigX: 300, update: parked(h, (t) => pulse(t, 3, 1.5, 0.4), i === 2 ? { flags: AFLAG.FLEEING } : {}),
    });
  });
  return sh;
}

function steveSheet() {
  const sh = new Sheet('steve', 'Abominable Steve', 'Walk, idle, wind-up, pound, enraged, sitting with cocoa, and the facings. Cut-out puppet: parts are cached, the pose is live. Game size left, 3x right.', 1500, 1760);
  const W = 500, H = 436;
  const opts = { foot: 410, small: 76, bigX: 320 };
  const add = (i, label, over, update) => sh.tile((i % 3) * W, 8 + Math.floor(i / 3) * H, label, actor(ACTOR.STEVE, over), { ...opts, update });
  add(0, 'idle', {});
  add(1, 'walking towards us', { vy: 70, vx: 10 });
  add(2, 'wind-up then pound', {}, (a, t) => { a.aux = pulse(t, 2.2, 0.8) ? AUX.POUND : 0; });
  add(3, 'enraged', { flags: AFLAG.ENRAGED });
  add(4, 'sitting with cocoa', {}, (a, t) => { a.flags = (t % 6) > 1 ? AFLAG.FLEEING : 0; });
  add(5, 'walks right', { vx: 70 });
  add(6, 'walks away', { vy: -70 });
  add(7, 'walks left, 3/4 towards us', { vx: -60, vy: 50 });
  add(8, 'enraged walk', { vy: 94, flags: AFLAG.ENRAGED });
  add(9, 'boulder heave', {}, (a, t, view) => {
    if (pulse(t, 2, 0.03)) view.balls.push({ id: a.id * 100 + Math.floor(t / 2), kind: BALL.BOULDER, x: a.x, y: a.y + 20, z: 0 });
  });
  add(10, 'taking hits', {}, (a, t) => { a.hp = 1 - (Math.floor(t / 1.2) % 9) * 0.1; });
  add(11, 'walks away, glancing back', { vx: 50, vy: -50 });
  return sh;
}

function colonelSheet() {
  const sh = new Sheet('colonel', 'Colonel Carrot', 'Tiers of damage, eyes tracking a foe circling him, hit reaction, and the missing nose. Game size left, 3x right.', 1500, 1320);
  const tiles = [];
  const W = 370, H = 430;
  const fracs = [1, 0.8, 0.66, 0.52, 0.38, 0.24, 0.1];
  const add = (i, label, fn) => {
    const col = (i % 4) * W, row = 8 + Math.floor(i / 4) * H;
    const s = { id: 8000 + i, kind: STRUCT.COLONEL, cx: 40 + i * 20, cy: 40, team: TEAM.A, hp: 1500, maxHp: 1500, ownerId: 0, bornAt: 0 };
    tiles.push({ col, row, label, s, fn });
  };
  fracs.forEach((f, i) => add(i, `hp ${Math.round(f * 100)}%`, (s) => { s.hp = f * s.maxHp; }));
  add(7, 'being hit', (s, t) => { s.hp = s.maxHp * (0.9 - (Math.floor(t / 0.9) % 16) * 0.05); });
  add(8, 'nose stolen', () => {});
  add(9, 'Face-Off blue', (s) => { s.team = TEAM.B; });
  add(10, 'idle, nothing to see', () => {});
  const circler = actor(ACTOR.PIPSQUEAK, { x: 0, y: 0 });
  const thief = actor(ACTOR.SNEAK, { x: 0, y: 0, aux: AUX.NOSE });
  sh.extra = (ctx, t, dt) => {
    for (const tl of tiles) {
      const { s, col, row } = tl;
      tl.fn(s, t);
      const wx = (s.cx + 1) * CELL, wy = (s.cy + 1) * CELL;
      const view = { mode: MODE.SIEGE, actors: [], balls: [], meta: {} };
      if (tl.label === 'nose stolen') {
        thief.x = wx + Math.cos(t * 0.8) * 150;
        thief.y = wy + Math.sin(t * 0.8) * 100;
        view.actors = [thief];
      } else if (!tl.label.startsWith('idle')) {
        circler.x = wx + Math.cos(t * 0.9 + s.id) * 170;
        circler.y = wy + Math.sin(t * 0.9 + s.id) * 130;
        view.actors = [circler];
      }
      const place = (dx, dy, scale, art) => {
        ctx.save();
        ctx.translate(col + dx, row + dy);
        ctx.scale(scale, scale);
        ctx.translate(-wx, -wy);
        ctx.beginPath();
        ctx.ellipse(wx, wy + 22, 42, 16, 0, 0, 6.3);
        ctx.fillStyle = 'rgba(112,100,170,0.26)';
        ctx.fill();
        art.drawColonel(ctx, s, { time: t, dt, view });
        if (view.actors[0]) {
          const a = view.actors[0];
          const dxA = a.x - wx, dyA = a.y - wy;
          ctx.translate(wx + dxA * 0.45, wy + dyA * 0.45);
          ctx.translate(-a.x, -a.y);
          art.draw(ctx, a, { time: t, dt, view });
        }
        ctx.restore();
      };
      place(70, 210, 1, sh.game);
      place(236, 300, 3, sh.big);
      ctx.font = '12px -apple-system, Segoe UI, Roboto, sans-serif';
      ctx.fillStyle = '#564c7c';
      ctx.fillText(tl.label, col + 6, row + 13);
    }
  };
  return sh;
}

// ---- icons -----------------------------------------------------------------------------------------

function iconSheet() {
  const sec = document.createElement('section');
  sec.id = 'icons';
  const h2 = document.createElement('h2');
  h2.textContent = 'Icons';
  const note = document.createElement('p');
  note.textContent = 'Every icon name in the spec at 24, 32, 48 and 64 px, on light and dark. Unknown ids use the art-by-effect path or the generic medal.';
  sec.append(h2, note);
  const names = [
    'flake', 'ball',
    ...Object.values(STRUCT).map((v) => `tool:${v}`), 'tool:demolish',
    ...Object.values(PICKUP).map((v) => `special:${v}`),
    ...Object.values(ACTOR).map((v) => `foe:${v}`),
    ...CARDS.map((c) => `card:${c.id}`),
    'card:mystery-one', 'card:hot-hands-2', 'card:zz', 'nonsense',
  ];
  const grid = document.createElement('div');
  grid.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fill,minmax(232px,1fr));gap:6px';
  for (const n of names) {
    const cell = document.createElement('div');
    cell.style.cssText = 'display:flex;align-items:center;gap:6px;padding:4px 6px;border-radius:8px;background:#f2f6fc';
    for (const px of [24, 32, 48]) cell.append(iconCanvas(n, px));
    const dark = document.createElement('span');
    dark.style.cssText = 'background:#352e52;border-radius:6px;padding:3px;display:flex';
    dark.append(iconCanvas(n, 32));
    cell.append(dark);
    const big = document.createElement('span');
    big.style.cssText = 'display:flex;flex-direction:column;gap:2px;font-size:10px;color:#564c7c;word-break:break-all';
    big.append(iconCanvas(n, 64));
    const lab = document.createElement('span');
    lab.textContent = n;
    big.append(lab);
    cell.append(big);
    grid.append(cell);
  }
  sec.append(grid);
  document.getElementById('main').append(sec);
  return null;
}

// ---- a pretend battle ------------------------------------------------------------------------------

function sceneSheet() {
  const sh = new Sheet('scene', 'Mock battlefield at game size', 'One unit is one CSS pixel. This is the honest test: everybody at once, y-sorted, on snow, at the size players see.', 1500, 900);
  sh.tiles = [];
  const view = sh.view;
  const col = { id: 9000, kind: STRUCT.COLONEL, cx: 17, cy: 9, team: TEAM.A, hp: 1200, maxHp: 1500, ownerId: 0, bornAt: 0 };
  const walkers = [];
  const kidLooks = [[0, 0, 4, 1], [1, 3, 1, 4], [2, 5, 2, 0], [3, 4, 0, 2], [4, 6, 5, 3], [5, 1, 7, 5]];
  const players = new Map();
  kidLooks.forEach(([hat, coat, scarf, skin], i) => {
    const a = actor(ACTOR.KID, { x: 560 + i * 72, y: 330 + (i % 2) * 190 });
    players.set(a.id, { look: { hat, coat, scarf, skin } });
    walkers.push({ a, ox: a.x, oy: a.y, r: 50 + i * 9, sp: 1.6 + i * 0.2, ph: i });
  });
  const spawn = (kind, x, y, tx, ty, flags = 0) => {
    const a = actor(kind, { x, y, flags });
    walkers.push({ a, sx: x, sy: y, tx, ty, march: 1 });
  };
  for (let i = 0; i < 9; i++) spawn(ACTOR.PIPSQUEAK, 60 + (i % 3) * 44, 130 + Math.floor(i / 3) * 46 + i * 7, 720, 440);
  for (let i = 0; i < 4; i++) spawn(ACTOR.SLINGER, 1380 - i * 16, 120 + i * 60, 800, 430);
  for (let i = 0; i < 3; i++) spawn(ACTOR.LOBBER, 1320 + i * 40, 560 + i * 50, 800, 470);
  for (let i = 0; i < 2; i++) spawn(ACTOR.BRUISER, 200 + i * 90, 700 + i * 30, 720, 510);
  for (let i = 0; i < 2; i++) spawn(ACTOR.LIDKID, 900 + i * 60, 40 + i * 40, 760, 420, AFLAG.SHIELDED);
  spawn(ACTOR.SNEAK, 700, 820, 740, 500);
  spawn(ACTOR.SLEDDER, 1460, 300, 400, 340, AFLAG.SLEDDING);
  spawn(ACTOR.PIPSQUEAK, 420, 300, 40, 60, AFLAG.FLEEING);
  const steve = actor(ACTOR.STEVE, { x: 1060, y: 730 });
  const truck = actor(ACTOR.TRUCK, { x: 300, y: 500 });
  view.actors.push(...walkers.map((w) => w.a), steve, truck);
  sh.extra = (ctx, t, dt) => {
    for (const w of walkers) {
      const a = w.a;
      if (w.march) {
        const dx = w.tx - w.sx, dy = w.ty - w.sy;
        const d = Math.hypot(dx, dy) || 1;
        const sp = a.kind === ACTOR.SLEDDER ? 340 : (FOES[a.kind]?.speed ?? 100);
        const lim = (t * sp) % d;
        a.x = w.sx + (dx / d) * lim;
        a.y = w.sy + (dy / d) * lim;
        a.vx = (dx / d) * sp;
        a.vy = (dy / d) * sp;
        a.aim = Math.atan2(dy, dx);
      } else {
        const q = t * w.sp + w.ph;
        a.x = w.ox + Math.cos(q) * w.r;
        a.y = w.oy + Math.sin(q) * w.r * 0.7;
        a.vx = -Math.sin(q) * w.r * w.sp;
        a.vy = Math.cos(q) * w.r * 0.7 * w.sp;
        a.aim = Math.atan2(a.y - 300, a.x - 60);
        a.flags = pulse(t, 2.4, 1, w.ph) ? AFLAG.CHARGING : 0;
        a.aux = Math.floor(((t + w.ph) % 2.4) * 255) & 255;
      }
    }
    steve.vy = -40;
    steve.vx = -40;
    steve.x = 1060 - (t * 40) % 180;
    steve.y = 730 - (t * 40) % 180;
    truck.vx = 95;
    truck.x = 220 + (t * 95) % 300;
    truck.aim = 0.6 + Math.sin(t) * 0.5;
    const items = [...view.actors, { col }].sort((p, q) => ((p.col ? (p.col.cy + 2) * CELL : p.y) - (q.col ? (q.col.cy + 2) * CELL : q.y)));
    for (const it of items) if (!it.col) shadow(ctx, it.x, it.y, footR(it));
    for (const it of items) {
      if (it.col) sh.game.drawColonel(ctx, it.col, { time: t, dt, view });
      else sh.game.draw(ctx, it, { time: t, dt, player: players.get(it.id), me: false, view });
    }
  };
  return sh;
}

// ---- draw cost -------------------------------------------------------------------------------------

function costSheet() {
  const sec = document.createElement('section');
  sec.id = 'cost';
  const h2 = document.createElement('h2');
  h2.textContent = 'Draw cost per actor';
  const note = document.createElement('p');
  note.textContent = 'Microseconds per draw call into a 1280x720 canvas at sprite scale 2, warm cache, including rasterization flush.';
  const out = document.createElement('table');
  out.className = 'cost';
  out.id = 'cost-table';
  sec.append(h2, note, out);
  document.getElementById('main').append(sec);

  const bench = () => {
    const c = document.createElement('canvas');
    c.width = 1280;
    c.height = 720;
    const ctx = c.getContext('2d', { alpha: false });
    const art = new ActorArt({ scale: 2 });
    const view = { mode: MODE.SIEGE, actors: [], balls: [], meta: {} };
    const player = { look: { hat: 0, coat: 0, scarf: 4, skin: 1 } };
    const run = (label, a, drawFn, n = 3000) => {
      // First pass fills the atlas, then the timed pass measures the warm path players live on.
      let t = 0;
      for (let i = 0; i < 180; i++) { t += 1 / 60; drawFn(t, 1 / 60); }
      ctx.getImageData(0, 0, 1, 1);
      const t0 = performance.now();
      for (let i = 0; i < n; i++) { t += 1 / 60; drawFn(t, 1 / 60); }
      const submit = performance.now() - t0;
      ctx.getImageData(0, 0, 1, 1);
      const total = performance.now() - t0;
      return { label, submit: (submit / n) * 1000, total: (total / n) * 1000 };
    };
    const rows = [];
    const add = (label, kind, over = {}, pl = null) => {
      const a = actor(kind, { x: 640, y: 400, ...over });
      rows.push(run(label, a, (t, dt) => art.draw(ctx, a, { time: t, dt, player: pl, me: false, view })));
    };
    add('Kid walking', ACTOR.KID, { vx: 200, aim: 0.3 }, player);
    add('Kid idle', ACTOR.KID, {}, player);
    add('Kid charging', ACTOR.KID, { flags: AFLAG.CHARGING, aux: 200 }, player);
    add('Kid frozen', ACTOR.KID, { flags: AFLAG.FROZEN }, player);
    add('Pipsqueak walking', ACTOR.PIPSQUEAK, { vx: 100, vy: 40 });
    add('Slinger walking', ACTOR.SLINGER, { vx: 100, vy: 40 });
    add('Lobber walking', ACTOR.LOBBER, { vx: 80, vy: 40 });
    add('Big Kid walking', ACTOR.BRUISER, { vx: 70, vy: 20 });
    add('Sledder on sled', ACTOR.SLEDDER, { flags: AFLAG.SLEDDING, vx: 340 });
    add('Lid Kid (live arm + lid)', ACTOR.LIDKID, { flags: AFLAG.SHIELDED, vx: 80, vy: 40, aim: 1 });
    add('Thief carrying', ACTOR.SNEAK, { vx: 160, aux: AUX.NOSE });
    add('Truck driving', ACTOR.TRUCK, { vx: 95, aim: 1 });
    add('Truck parked, doors open', ACTOR.TRUCK, { aux: AUX.DOORS, aim: 2 });
    add('Steve walking', ACTOR.STEVE, { vx: 60, vy: 30 });
    add('Steve enraged', ACTOR.STEVE, { vx: 60, vy: 30, flags: AFLAG.ENRAGED });
    add('Steve sitting', ACTOR.STEVE, { flags: AFLAG.FLEEING });
    const s = { id: 9100, kind: STRUCT.COLONEL, cx: 12, cy: 6, team: TEAM.A, hp: 900, maxHp: 1500, ownerId: 0, bornAt: 0 };
    const foe = actor(ACTOR.PIPSQUEAK, { x: 300, y: 200 });
    rows.push(run('Colonel Carrot', s, (t, dt) => art.drawColonel(ctx, s, { time: t, dt, view: { actors: [foe] } })));
    // A crowd is the case that matters: 90 foes at once, mixed poses.
    const crowd = [];
    for (let i = 0; i < 90; i++) crowd.push(actor(FOE_KINDS[i % 7], { x: 40 + (i * 53) % 1200, y: 60 + (i * 37) % 620, vx: 60 + (i % 5) * 10, vy: 30 - (i % 7) * 10, aim: i }));
    const fullFrame = run('Full frame: 90 foes', crowd[0], (t, dt) => { for (const a of crowd) art.draw(ctx, a, { time: t, dt, view }); }, 400);
    // First sight: what one actor costs on the frame its sprites are rasterized.
    const cold = (label, kind, over, pl = null) => {
      const fresh = new ActorArt({ scale: 2 });
      const a = actor(kind, { x: 640, y: 400, ...over });
      fresh.draw(ctx, actor(ACTOR.PIPSQUEAK, { x: 40, y: 40 }), { time: 0, dt: 0, view });
      ctx.getImageData(0, 0, 1, 1);
      const t0 = performance.now();
      fresh.draw(ctx, a, { time: 1, dt: 1 / 60, player: pl, view });
      ctx.getImageData(0, 0, 1, 1);
      return [`First sight: ${label}`, '', ((performance.now() - t0) * 1000).toFixed(0)];
    };
    const firsts = [cold('kid', ACTOR.KID, { vx: 200 }, player), cold('Pipsqueak', ACTOR.PIPSQUEAK, { vx: 100 }), cold('Big Kid', ACTOR.BRUISER, { vx: 70 }),
      cold('Truck', ACTOR.TRUCK, { vx: 95 }), cold('Steve', ACTOR.STEVE, { vy: 60 })];
    const table = [['Actor', 'Submit µs', 'With raster µs'], ...rows.map((r) => [r.label, r.submit.toFixed(1), r.total.toFixed(1)]),
      [fullFrame.label, fullFrame.submit.toFixed(0), fullFrame.total.toFixed(0)], ...firsts,
      ['Atlas pages', art.atlas.pages.length, `${(art.atlas.bytes / 1048576).toFixed(0)} MB`], ['Sprites built', art.atlas.built, '']];
    out.replaceChildren(...table.map((r, i) => {
      const tr = document.createElement('tr');
      for (const v of r) {
        const td = document.createElement(i ? 'td' : 'th');
        td.textContent = v;
        tr.append(td);
      }
      return tr;
    }));
    window.__cost = table;
    window.__ready = true;
  };
  setTimeout(bench, 50);
  return null;
}

// ---- wiring ----------------------------------------------------------------------------------------

const BUILDERS = {
  kids: kidSheet, looks: looksSheet, faceoff: faceOffSheet, foes: foeSheet, foes2: foeExtrasSheet, shapes: silhouetteSheet, truck: truckSheet, steve: steveSheet, colonel: colonelSheet,
  icons: iconSheet, scene: sceneSheet, cost: costSheet,
};

const nav = document.getElementById('nav');
for (const k of Object.keys(BUILDERS)) {
  const a = document.createElement('a');
  a.href = `?s=${k}`;
  a.textContent = k;
  if (k === only) a.className = 'on';
  nav.append(a, ' ');
}

const names = only ? [only] : Object.keys(BUILDERS).filter((k) => k !== 'cost');
const sheets = names.map((n) => BUILDERS[n]?.()).filter(Boolean);

function renderAll(t, dt) {
  for (const s of sheets) s.render(t, dt);
}

if (holdAt !== null) {
  for (let t = 0; t <= holdAt; t += 1 / 60) renderAll(t, 1 / 60);
  if (only !== 'cost') window.__ready = true;
} else {
  let last = performance.now(), t = 0;
  const loop = (now) => {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    t += dt;
    renderAll(t, dt);
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  if (only !== 'cost') window.__ready = true;
}

window.__gallery = { sheets };
