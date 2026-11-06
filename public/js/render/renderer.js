// The world renderer. One canvas, one frame order (SPEC 12):
//   1 ground  2 trails  3 flat pass  4 y-sorted pass  5 x-ray  6 high pass  7 grade  8 screen pass
//
// This file and the other per-frame modules (fx, trails, atmosphere, overlay) only ever blit,
// translate and fill. Anything that needs a gradient, a blur or text metrics happens in a bake module
// when a map loads or a size changes, so nothing in the frame path can stall.
import { ACTOR, AFLAG, AUX, BALL, EMOTES, EV, MODE, PHASE, SFX, STRUCT, TEAM } from '../../shared/schema.js';
import { BOSS, BUILD, CELL, FOES, KID, SIM_HZ, THROW } from '../../shared/constants.js';
import { raycastFlat } from '../../shared/physics.js';
import { ActorArt } from './sprites.js';
import { SpriteBank, blit } from './bank.js';
import { bakeGround, downsample, insideIce } from './ground.js';
import { obstacleBounds, obstacleDepth, obstacleExtras, obstacleSprite } from './obstacles.js';
import { NB, PULT_ARM, PULT_PIVOT, prewarmStructs, pultArmSprite, structLevel, structSprite } from './structures.js';
import {
  ballSprite, blockShadowSprite, chevronSprite, crownSprite, haloSprite, meRingSprite, pickupGlow, pickupSprite, ropeSpanSprite,
  ropeSpanVerticalSprite, shadowSprite, streakSprite, toolMarkSprite,
} from './props.js';
import { bakeFxAtlas, FX } from './fxart.js';
import { Particles } from './fx.js';
import { Trails } from './trails.js';
import { Atmosphere } from './atmosphere.js';
import { Overlay, headHeight } from './overlay.js';
import { P } from './palette.js';
import { HIGH_Z, MAX_PIXELS_HIGH, MAX_PIXELS_LOW, VIEW_AREA, VIEW_AREA_TOUCH, Z_LIFT } from './world.js';

export { Z_LIFT, VIEW_AREA };

const T_OBSTACLE = 0;
const T_STRUCT = 1;
const T_PICKUP = 2;
const T_ACTOR = 3;
const T_BALL = 4;
const T_ROPE = 5;

const CAM_SETTLE_S = 0.25;  // the camera finishes catching up over this long
const CAM_TAU = CAM_SETTLE_S / 3;
const SLOW_FRAME_MS = 24;
const SLOW_WINDOW_MS = 3000;
const FRAME_GAP_MS = 250;   // a gap this long is a stall or a hidden tab, not a slow frame
const ROPE_SPAN = 120;
const RETICLE_FOE = '#f0606e';
const RETICLE_MINE = '#6d7be0';
const TOOL_TINT = {
  ok: '#7ee0b0', repair: '#f7cf5e', patch: '#f7cf5e', demolish: '#f0707a',
  noFlakes: '#f0707a', badCell: '#f0707a', tooFar: '#f0707a', limit: '#f0707a',
};

const EMPTY_UI = Object.freeze({
  tool: null, toolCell: null, toolState: null, toolValid: false, buildRange: 0, aimX: 0, aimY: 0, lobbing: false, charge: 0, sticks: [], reduceMotion: false,
});

const byDepth = (a, b) => (a.key - b.key) || (a.id - b.id);
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const coarsePointer = () => typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;

export class Renderer {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.quality = opts.quality || 'auto';
    this.autoLow = false;
    this.low = this.quality === 'low';

    this.bank = new SpriteBank();
    this.art = new ActorArt();
    this.atlas = bakeFxAtlas();
    this.fx = new Particles();
    this.fx.density = this.low ? 0.55 : 1;
    this.trails = new Trails();
    this.atmos = new Atmosphere();
    this.overlay = new Overlay();

    this.map = null;
    this.bakedMap = null;
    this.ground = null;
    this.groundFull = null;
    this.groundLow = null;
    this.obstacles = [];
    this.lights = [];
    this.smokeVents = [];
    this.panes = [];
    this.iceShapes = [];

    this.cssW = 1;
    this.cssH = 1;
    this.zoom = 1;
    this.pixelRatio = 1;
    this.spriteScale = 1;
    this.cam = { x: 0, y: 0 };
    this.camFresh = true;
    this.shakeX = 0;
    this.shakeY = 0;
    this.trauma = 0;
    this.time = 0;
    this.dt = 0;
    this.frame = 0;
    this.gradeFresh = true;
    this.reduceMotion = false;

    // Per-frame scratch, reused so a steady frame allocates almost nothing.
    this.pool = [];
    this.list = [];
    this.actorById = new Map();
    this.info = { time: 0, dt: 0, player: null, me: false, view: null };
    this.nightLights = [];
    this.nightPanes = [];
    this.structKeys = new Map();
    this.ballSprites = [];
    this.pickupSprites = [];
    this.pickupHalos = [];
    this.cells = new Int32Array(0);
    this.cols = 0;
    this.rows = 0;
    this.cellStamp = 0;

    // Short-lived per-id facts for animation, keyed by actor or struct id.
    this.structHitAt = new Map();
    this.structHp = new Map();
    this.pultFired = new Map();
    this.ballKinds = new Map();
    this.ballTeams = new Map();
    this.ballStart = new Map();
    this.colonelHitAt = new Map();
    this.edgeInsets = { top: 0, bottom: 0 };
    this.colonelLast = new Map();
    this.poundSince = new Map();
    this.knownActors = new Map(); // id -> kind
    this.colonelLastId = new Set();
    this.ropeFade = 0;
    this.ropeSpans = [];

    this.perf = { ring: new Float32Array(1024), head: 0, tail: 0, sum: 0, last: 0 };
    this.stats = { frameMs: 0, drawMs: 0, particles: 0, items: 0 };
    this.steamClock = 0;
    this.smokeClock = 0;

    this.resize();
  }

  // ---- public API -----------------------------------------------------------

  setMap(map) {
    // Quality is settled first: each new match starts over at the chosen setting, and the bake below
    // must happen once, for the resolution that will really be used.
    this.autoLow = false;
    this.map = null;
    this.applyLow(this.quality === 'low');

    // A rematch on the same map keeps its ground: the bake is the slowest thing the renderer ever does.
    if (map !== this.bakedMap) {
      this.groundFull = bakeGround(map);
      this.groundLow = null;
      this.bakedMap = map;
      this.bank.drop('ob|');
    }
    this.map = map;
    this.ground = this.low ? this.lowGround() : this.fullGround();
    this.iceShapes = map.ice || [];
    this.trails.setMap(map, this.low ? 0.25 : 0.5, (x, y) => this.onIce(x, y));

    this.obstacles = (map.obstacles || []).map((o, i) => {
      const b = obstacleBounds(o);
      return { t: T_OBSTACLE, id: i, key: obstacleDepth(o), ref: o, sp: null, ax: b.ax, ay: b.ay, x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1 };
    });
    this.buildLights(map);

    this.cols = Math.ceil(map.w / CELL) + 2;
    this.rows = Math.ceil(map.h / CELL) + 2;
    this.cells = new Int32Array(this.cols * this.rows);
    this.cellStamp = 0;
    this.buildRope(map);

    // Ids restart with every match, so a rematch would otherwise hand a new foe the old one's art state.
    for (const id of this.knownActors.keys()) this.art.forget(id);
    this.knownActors.clear();
    for (const id of this.colonelLastId) this.art.forget(id);
    this.colonelLastId.clear();

    this.fx.clear();
    this.overlay.clear();
    this.structHitAt.clear();
    this.structHp.clear();
    this.pultFired.clear();
    this.ballKinds.clear();
    this.ballTeams.clear();
    this.ballStart.clear();
    this.colonelHitAt.clear();
    this.colonelLast.clear();
    this.poundSince.clear();
    this.camFresh = true;
    this.gradeFresh = true;
    this.perf.head = 0;
    this.perf.tail = 0;
    this.perf.sum = 0;
    this.warmSprites();
  }

  // Sizing is the one place the expensive-to-change numbers are allowed to change.
  resize() {
    const canvas = this.canvas;
    const rect = canvas.getBoundingClientRect();
    const cssW = Math.max(1, rect.width || canvas.clientWidth || window.innerWidth || 1);
    const cssH = Math.max(1, rect.height || canvas.clientHeight || window.innerHeight || 1);
    const area = coarsePointer() ? VIEW_AREA_TOUCH : VIEW_AREA;
    const maxPixels = this.low ? MAX_PIXELS_LOW : MAX_PIXELS_HIGH;
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(maxPixels / (cssW * cssH)));
    // Touching canvas.width wipes the frame and reallocates it, and phones fire resize constantly.
    if (cssW === this.cssW && cssH === this.cssH && pixelRatio === this.pixelRatio && this.shadow) return;
    this.cssW = cssW;
    this.cssH = cssH;
    this.zoom = clamp(Math.sqrt((cssW * cssH) / area), 0.6, 4);
    this.pixelRatio = pixelRatio;
    canvas.width = Math.round(cssW * pixelRatio);
    canvas.height = Math.round(cssH * pixelRatio);
    this.ctx.imageSmoothingEnabled = true;
    this.ctx.imageSmoothingQuality = 'medium';

    const raster = Math.min(3, Math.ceil(this.zoom * this.pixelRatio * 2) / 2);
    if (raster !== this.spriteScale || !this.shadow) {
      this.spriteScale = raster;
      this.bank.setScale(raster);
      this.art.setScale(raster);
      this.warmSprites();
    }
    this.overlay.text.setPixelRatio(this.pixelRatio);
    this.atmos.resize(canvas.width, canvas.height);
    this.camFresh = true;
  }

  setQuality(q) {
    this.quality = q;
    this.applyLow(q === 'low' || (q === 'auto' && this.autoLow));
  }

  // How much of the top and bottom of the canvas the HUD covers, in CSS px. Edge arrows stay clear.
  setEdgeInsets(top, bottom) {
    this.edgeInsets.top = top;
    this.edgeInsets.bottom = bottom;
  }

  screenToWorld(px, py) {
    return { x: px / this.zoom + this.cam.x, y: py / this.zoom + this.cam.y };
  }

  worldToScreen(x, y, z = 0) {
    return { x: (x - this.cam.x) * this.zoom, y: (y - this.cam.y - z * Z_LIFT) * this.zoom };
  }

  // Draw keys only ever increase toward the viewer, so the winner is simply the highest key under the
  // point, which is the same answer as walking the list from the front.
  pickStruct(px, py, view) {
    const structs = view && view.structs;
    if (!structs) return null;
    const w = this.screenToWorld(px, py);
    let best = null;
    let bestKey = -Infinity;
    for (let i = 0; i < structs.length; i++) {
      const s = structs[i];
      const b = BUILD[s.kind];
      const size = (b && b.size) || 1;
      const rise = (b ? b.height : 0) * Z_LIFT;
      const x0 = s.cx * CELL;
      const x1 = x0 + size * CELL;
      const y1 = (s.cy + size) * CELL;
      const y0 = s.cy * CELL - rise;
      if (w.x < x0 || w.x >= x1 || w.y < y0 || w.y >= y1) continue;
      if (y1 > bestKey || (y1 === bestKey && s.id > best.id)) {
        best = s;
        bestKey = y1;
      }
    }
    return best;
  }

  onFx(ev, view) {
    if (!ev || !this.map) return;
    const fx = this.fx;
    switch (ev.e) {
      case EV.BALL:
        this.ballKinds.set(ev.id, ev.k);
        this.ballTeams.set(ev.id, ev.tm);
        break;
      case EV.BALL_END:
        this.ballImpact(ev);
        break;
      case EV.SPLASH:
        if (ev.k === BALL.SLUSH) fx.slushImpact(ev.x, ev.y, 4);
        fx.splash(ev.x, ev.y, ev.r);
        this.stampSplat(ev.x, ev.y, ev.r * 0.4);
        break;
      case EV.HIT:
        this.actorHit(ev, view);
        break;
      case EV.FREEZE: {
        const a = this.actorById.get(ev.id);
        if (a) fx.freeze(a.x, a.y);
        break;
      }
      case EV.THAW: {
        const a = this.actorById.get(ev.id);
        if (a) fx.thaw(a.x, a.y);
        break;
      }
      case EV.RESPAWN:
        fx.spawnPoof(ev.x, ev.y);
        break;
      case EV.FLEE:
        fx.flee(ev.x, ev.y);
        break;
      case EV.SPAWN:
        fx.spawnPoof(ev.x, ev.y);
        break;
      case EV.S_ADD:
        this.structHp.set(ev.id, ev.hp);
        fx.buildPop((ev.cx + 0.5) * CELL, (ev.cy + 0.5) * CELL, ev.k === STRUCT.ICEWALL);
        // FFA team colours are not prewarmed. Painting them here keeps that work out of the frame.
        if (ev.k !== STRUCT.COLONEL) {
          for (let level = 0; level < 3; level++) this.spriteForStruct({ kind: ev.k, team: ev.tm }, 0, level, 0);
        }
        break;
      case EV.S_HP:
        this.structHpChanged(ev, view);
        break;
      case EV.S_DEL:
        this.structGone(ev);
        break;
      case EV.P_ADD:
        fx.pickupAppear(ev.x, ev.y);
        break;
      case EV.P_DEL:
        if (ev.by) fx.pickupTaken(ev.x, ev.y);
        else fx.puffs(ev.x, ev.y, 6, 3, 40, 7, 0.32);
        break;
      case EV.FLAKES:
        this.flakeFloat(ev, view);
        break;
      case EV.PULT:
        this.pultFired.set(ev.id, { t: this.time, ang: ev.ang });
        break;
      case EV.BARK:
        this.speak(ev.id, ev.text, view, false);
        break;
      case EV.EMOTE:
        this.speak(ev.id, EMOTES[ev.n] ?? '...', view, true);
        break;
      case EV.QUAKE:
        this.quake(ev);
        break;
      case EV.SLIDE: {
        const a = this.actorById.get(ev.id);
        if (a) fx.puffs(a.x, a.y, 3, 6, 110, 10, 0.4);
        break;
      }
      case EV.SFX:
        if (ev.name === SFX.CHEER) fx.confetti(ev.x ?? this.cam.x + this.cssW / this.zoom / 2, ev.y ?? this.cam.y + this.cssH / this.zoom / 2, 40, 70);
        break;
      default:
        break; // banner and deny are HUD DOM; everything else has no world art.
    }
  }

  // ---- fx routing -----------------------------------------------------------

  ballImpact(ev) {
    const kind = this.ballKinds.get(ev.id);
    this.ballKinds.delete(ev.id);
    this.ballTeams.delete(ev.id);
    this.ballStart.delete(ev.id);
    const fx = this.fx;
    const z = ev.z > 0 ? ev.z : 4;
    switch (ev.why) {
      case 'shield':
        fx.shieldClang(ev.x, ev.y, z);
        return;
      case 'out':
      case 'expire':
        if (kind === BALL.GIANT || kind === BALL.BOULDER) fx.breakBlock(ev.x, ev.y, false);
        return;
      default:
        break;
    }
    if (kind === BALL.ICE) fx.iceImpact(ev.x, ev.y, z);
    else if (kind === BALL.SLUSH) fx.slushImpact(ev.x, ev.y, z);
    else if (kind === BALL.CONE) fx.coneImpact(ev.x, ev.y, z);
    else if (kind === BALL.GIANT || kind === BALL.BOULDER) fx.breakBlock(ev.x, ev.y, false);
    else fx.snowImpact(ev.x, ev.y, z, kind === BALL.POWER ? 1.6 : 1);
    if (ev.why === 'ground') this.stampSplat(ev.x, ev.y, kind === BALL.POWER ? 7 : 5);
  }

  stampSplat(x, y, r) {
    if (!this.onIce(x, y)) this.trails.splat(x, y, r);
  }

  actorHit(ev, view) {
    const me = view && view.me;
    const mine = me && ev.id === me.id;
    const a = this.actorById.get(ev.id);
    const big = ev.amt >= THROW.power.dmg;
    const y = a ? a.y - headHeight(a.kind) * 0.6 : ev.y - 30;
    const x = a ? a.x : ev.x;
    const value = Math.max(1, Math.round(ev.amt));
    this.overlay.addNumber(x, y, String(value), mine ? 'hurt' : big ? 'big' : 'hit', ev.id, value);
    if (mine) {
      this.overlay.addSplat(this.cssW, this.cssH);
      this.addTrauma(ev.k === -1 ? 0.42 : 0.22);
    }
  }

  structHpChanged(ev, view) {
    const was = this.structHp.get(ev.id);
    this.structHp.set(ev.id, ev.hp);
    const s = this.findStruct(view, ev.id);
    const fx = this.fx;
    if (was !== undefined && ev.hp > was) {
      if (s) fx.stars((s.cx + 0.5) * CELL, (s.cy + 0.5) * CELL, 14, 5, 18, FX.GOLD, 8, 0.6);
      return;
    }
    this.structHitAt.set(ev.id, this.time);
    if (!s) return;
    const b = BUILD[s.kind];
    const size = (b && b.size) || 1;
    const x = (s.cx + size / 2) * CELL;
    const y = (s.cy + size) * CELL - 4;
    const z = b ? b.height * 0.6 : 14;
    if (s.kind === STRUCT.COLONEL) {
      this.colonelHitAt.set(s.team, this.time);
      fx.wallChip(x, y, z, false);
    } else if (s.kind === STRUCT.ICEWALL) fx.wallChip(x, y, z, true);
    else if (s.kind === STRUCT.PULT || s.kind === STRUCT.COCOA) fx.woodChip(x, y, z);
    else if (s.kind !== STRUCT.SLICK) fx.wallChip(x, y, z, false);
  }

  structGone(ev) {
    this.structHitAt.delete(ev.id);
    this.structHp.delete(ev.id);
    this.pultFired.delete(ev.id);
    this.art.forget(ev.id);
    if (ev.why === 'reset') return;
    const x = (ev.cx + 0.5) * CELL;
    const y = (ev.cy + 0.5) * CELL;
    if (ev.k === STRUCT.PULT || ev.k === STRUCT.COCOA) this.fx.breakWood(x, y);
    else if (ev.k === STRUCT.DECOY) this.fx.puffs(x, y, 14, 12, 110, 13, 0.6);
    else if (ev.k === STRUCT.SLICK) this.fx.chunks(x, y, 3, 7, 80, 5, FX.SHARD, 0.45);
    else this.fx.breakBlock(x, y, ev.k === STRUCT.ICEWALL);
  }

  flakeFloat(ev, view) {
    const myTeam = this.myTeam(view);
    if (myTeam !== null && ev.tm !== undefined && ev.tm !== myTeam) return;
    if (ev.x === undefined) return;
    // Lands to one side of the hit number that nearly always shares its spot.
    this.overlay.addNumber(ev.x + 28, ev.y - 14, `+${Math.max(1, Math.round(ev.amt))} ❄`, 'flake');
  }

  speak(id, text, view, emote) {
    const a = this.actorById.get(id);
    let x = this.cam.x + this.cssW / this.zoom / 2;
    let y = this.cam.y + this.cssH / this.zoom / 2;
    let style = emote ? 'emote' : 'bark';
    if (a) {
      x = a.x;
      y = a.y - headHeight(a.kind);
    } else {
      const s = this.findStruct(view, id);
      if (s) {
        const b = BUILD[s.kind];
        const size = (b && b.size) || 1;
        x = (s.cx + size / 2) * CELL;
        y = s.cy * CELL - (b ? b.height : 40) * Z_LIFT - 4;
        if (s.kind === STRUCT.COLONEL) style = 'loud';
      }
    }
    const life = clamp(1.7 + String(text).length * 0.055, 2, 5);
    this.overlay.addBubble(id, text, style, x, y, life);
  }

  quake(ev) {
    this.addTrauma(ev.amt);
    if (ev.amt >= 0.8 && ev.x !== undefined) {
      this.fx.shockwave(ev.x, ev.y, BOSS.steve.poundRadius * 0.6);
      if (!this.onIce(ev.x, ev.y)) this.trails.crater(ev.x, ev.y, BOSS.steve.poundRadius * 0.46);
    }
  }

  addTrauma(amt) {
    if (!this.reduceMotion) this.trauma = Math.min(1, this.trauma + amt);
  }

  findStruct(view, id) {
    const list = view && view.structs;
    if (!list) return null;
    for (let i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  myTeam(view) {
    return view && view.me ? view.me.team : null;
  }

  onIce(x, y) {
    const shapes = this.iceShapes;
    for (let i = 0; i < shapes.length; i++) if (insideIce(shapes[i], x, y)) return true;
    return false;
  }

  // ---- quality --------------------------------------------------------------

  // A low machine is the one that can least afford the full bake sitting idle, so it is released once
  // the small copy exists and only comes back if the player turns quality up again.
  lowGround() {
    if (!this.groundLow) this.groundLow = downsample(this.groundFull, 0.5);
    this.groundFull = null;
    return this.groundLow;
  }

  fullGround() {
    if (!this.groundFull) this.groundFull = bakeGround(this.map);
    this.groundLow = null;
    return this.groundFull;
  }

  applyLow(low) {
    if (low === this.low) return;
    this.low = low;
    this.fx.density = low ? 0.55 : 1;
    this.resize();
    if (this.map) {
      this.ground = low ? this.lowGround() : this.fullGround();
      this.trails.setScale(low ? 0.25 : 0.5);
    }
  }

  // A true sliding 3-second window of whole frames. Only auto mode reacts, and only downward: bouncing
  // between qualities mid-fight would cost more than either setting.
  trackQuality(now) {
    const p = this.perf;
    const gap = now - p.last;
    p.last = now;
    if (gap <= 0 || gap > FRAME_GAP_MS) {
      p.head = 0;
      p.tail = 0;
      p.sum = 0;
      return;
    }
    this.stats.frameMs = gap;
    const ring = p.ring;
    ring[p.head] = gap;
    p.head = (p.head + 1) % ring.length;
    p.sum += gap;
    // Drop the oldest frames while the rest still cover the whole window.
    while (p.sum - ring[p.tail] >= SLOW_WINDOW_MS) {
      p.sum -= ring[p.tail];
      p.tail = (p.tail + 1) % ring.length;
    }
    if (this.quality !== 'auto' || this.autoLow || p.sum < SLOW_WINDOW_MS) return;
    const frames = (p.head - p.tail + ring.length) % ring.length;
    if (p.sum / frames > SLOW_FRAME_MS) {
      this.autoLow = true;
      this.applyLow(true);
    }
  }

  // ---- caches ---------------------------------------------------------------

  warmSprites() {
    const bank = this.bank;
    this.shadow = shadowSprite(bank);
    this.blockShadows = [];
    for (let m = 0; m < 16; m++) this.blockShadows[m] = blockShadowSprite(bank, m);
    this.meRing = meRingSprite(bank);
    this.crown = crownSprite(bank);
    this.chevron = chevronSprite(bank);
    this.markX = toolMarkSprite(bank, 'x');
    this.markPlus = toolMarkSprite(bank, 'plus');
    this.structKeys.clear();
    for (const kind of Object.values(BALL)) this.ballSprites[kind] = ballSprite(bank, kind);
    this.streaks = [streakSprite(bank, BALL.QUICK), streakSprite(bank, BALL.POWER), streakSprite(bank, BALL.ICE)];
    for (let k = 0; k < 6; k++) {
      this.pickupSprites[k] = pickupSprite(bank, k);
      this.pickupHalos[k] = haloSprite(bank, pickupGlow(k));
    }
    this.armLoaded = pultArmSprite(bank, true);
    this.armEmpty = pultArmSprite(bank, false);
    if (!this.map) return;
    for (const ob of this.obstacles) ob.sp = obstacleSprite(bank, ob.ref);
    prewarmStructs(bank, [TEAM.A, TEAM.B]);
    if (this.ropeSpans.length) this.buildRope(this.map);
  }

  // Numeric key: string concatenation per struct per frame would be the single largest source of
  // garbage in the frame.
  spriteForStruct(s, mask, level, variant) {
    const key = s.kind + (mask << 4) + (level << 8) + (variant << 10) + ((s.team + 1) << 11);
    let sp = this.structKeys.get(key);
    if (!sp) {
      sp = structSprite(this.bank, s.kind, s.team, mask, level, variant);
      this.structKeys.set(key, sp);
    }
    return sp;
  }

  buildLights(map) {
    const lights = (map.lights || []).map((l) => ({ x: l.x, y: l.y, r: l.r || 150, color: l.color || '#ffd98a', power: 1 }));
    this.smokeVents = [];
    this.panes = [];
    for (const o of map.obstacles || []) {
      const extras = obstacleExtras(o);
      for (const v of extras.smoke) this.smokeVents.push(v);
      for (const p of extras.panes) this.panes.push(p);
      for (const l of extras.lights) {
        const anchor = l.ground ?? l;
        const near = lights.find((m) => Math.hypot(m.x - anchor.x, m.y - anchor.y) < (l.ground ? 110 : 90));
        if (near) {
          if (l.ground) {
            near.gx = near.gx ?? anchor.x;
            near.gy = near.gy ?? anchor.y;
            near.x = l.x;
            near.y = l.y;
          }
          continue;
        }
        lights.push({ x: l.x, y: l.y, r: l.r, color: l.color, power: l.ground ? 1 : 0.8, gx: l.ground?.x, gy: l.ground?.y });
      }
    }
    this.lights = lights;
  }

  buildRope(map) {
    this.ropeSpans = [];
    const t = map.truce;
    if (!t) return;
    const items = [];
    if (t.axis === 'x') {
      // Runs up the screen: each span is drawn from its near post, so spans y-sort with passing kids.
      for (let y = map.h - 6; y > 0; y -= ROPE_SPAN) {
        const len = Math.min(ROPE_SPAN, y);
        items.push({ t: T_ROPE, id: 200000 + items.length, key: y, sp: ropeSpanVerticalSprite(this.bank, Math.round(len)), ax: t.at, ay: y, x0: t.at - 14, y0: y - len - 48, x1: t.at + 30, y1: y + 14 });
      }
    } else {
      for (let x = 6; x < map.w; x += ROPE_SPAN) {
        const len = Math.min(ROPE_SPAN, map.w - x);
        items.push({ t: T_ROPE, id: 200000 + items.length, key: t.at, sp: ropeSpanSprite(this.bank, Math.round(len)), ax: x, ay: t.at, x0: x - 10, y0: t.at - 48, x1: x + len + 10, y1: t.at + 14 });
      }
    }
    this.ropeSpans = items;
  }

  // ---- frame ----------------------------------------------------------------

  render(view, ui, dtSeconds) {
    const started = performance.now();
    this.trackQuality(started);
    const ctx = this.ctx;
    if (view && view.map && view.map !== this.map) this.setMap(view.map);
    if (!view || !this.map) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = '#e4eaf8';
      ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
      return;
    }
    const u = ui || EMPTY_UI;
    const dt = clamp(dtSeconds || 0, 0, 0.1);
    this.dt = dt;
    this.time += dt;
    this.frame++;
    this.reduceMotion = !!u.reduceMotion;

    this.indexActors(view);
    this.updateCamera(view, u, dt);
    this.atmos.update(dt, view.dayT ?? 0.33, !!view.blizzard, this.gradeFresh);
    this.gradeFresh = false;
    this.trails.update(dt);
    this.trails.sense(view.actors || [], this.fx);
    this.fx.update(dt);
    this.overlay.update(dt, this.reduceMotion);
    this.ambientEmitters(view, dt);
    this.trackColonels(view);

    const S = this.zoom * this.pixelRatio;
    const tx = Math.round(-(this.cam.x + this.shakeX) * S);
    const ty = Math.round(-(this.cam.y + this.shakeY) * S);
    this.S = S;
    this.tx = tx;
    this.ty = ty;

    // 1. Ground. Letterbox colour only matters on displays wider than the map.
    const map = this.map;
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    const viewW = this.cssW / this.zoom;
    const viewH = this.cssH / this.zoom;
    if (viewW > map.w || viewH > map.h) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = '#dfe6f6';
      ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    }
    ctx.setTransform(S, 0, 0, S, tx, ty);
    ctx.drawImage(this.ground, 0, 0, map.w, map.h);

    // 2. Trails.
    this.trails.draw(ctx);
    this.drawGlints(ctx);

    // 3. Flat pass.
    this.stampCells(view);
    this.drawFlat(ctx, view, u);

    // 4. Y-sorted pass.
    const n = this.collect(view);
    const list = this.list;
    for (let i = 0; i < n; i++) this.drawItem(ctx, list[i], view, dt);

    // 5. X-ray pass.
    this.drawXray(ctx, view, n);

    // 6. High pass.
    this.drawHigh(ctx, view);

    // 7. Grade.
    const atm = this.atmos;
    const pr = this.pixelRatio;
    atm.drawGrade(ctx, this.low, pr);
    if (!this.low && atm.night > 0.01) {
      const count = this.collectLights(view);
      const glass = this.collectPanes();
      atm.drawNight(ctx, S, tx, ty, this.nightLights, count, this.nightPanes, glass);
    }
    atm.drawWeather(ctx, this.time, this.cam.x, this.cam.y, this.zoom, pr, this.low);

    // 8. Screen pass.
    this.overlay.draw(ctx, view, u, this, dt);

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    this.stats.drawMs = performance.now() - started;
    this.stats.particles = this.fx.count;
    this.stats.items = n;
  }

  indexActors(view) {
    const byId = this.actorById;
    byId.clear();
    const actors = view.actors || [];
    for (let i = 0; i < actors.length; i++) byId.set(actors[i].id, actors[i]);
    const known = this.knownActors;
    for (const [id, kind] of known) {
      const a = byId.get(id);
      if (!a || a.kind !== kind) {
        known.delete(id);
        this.art.forget(id);
        this.poundSince.delete(id);
      }
    }
    for (let i = 0; i < actors.length; i++) known.set(actors[i].id, actors[i].kind);
    const balls = view.balls;
    if (balls) {
      for (let i = 0; i < balls.length; i++) this.ballKinds.set(balls[i].id, balls[i].kind);
      // Balls that left the world without an event would otherwise pile up here forever.
      if (this.ballKinds.size > 512) this.ballKinds.clear();
    }
  }

  // ---- camera ---------------------------------------------------------------

  updateCamera(view, ui, dt) {
    const me = view.me;
    const map = this.map;
    let fx;
    let fy;
    if (me) {
      fx = me.x;
      fy = me.y;
      const lead = ui.lobbing ? 0.5 : ui.charge > 0 ? 0.2 : 0;
      if (lead) {
        fx += (ui.aimX - me.x) * lead;
        fy += (ui.aimY - me.y) * lead;
      }
    } else {
      const c = this.ownColonel(view);
      fx = c ? (c.cx + 1) * CELL : map.w / 2;
      fy = c ? (c.cy + 1) * CELL : map.h / 2;
    }
    const vw = this.cssW / this.zoom;
    const vh = this.cssH / this.zoom;
    const gx = vw >= map.w ? (map.w - vw) / 2 : clamp(fx - vw / 2, 0, map.w - vw);
    const gy = vh >= map.h ? (map.h - vh) / 2 : clamp(fy - vh / 2, 0, map.h - vh);
    if (this.camFresh) {
      this.cam.x = gx;
      this.cam.y = gy;
      this.camFresh = false;
    } else {
      const k = 1 - Math.exp(-dt / CAM_TAU);
      this.cam.x += (gx - this.cam.x) * k;
      this.cam.y += (gy - this.cam.y) * k;
    }

    // Shake uses squared trauma, so light taps barely move the picture and Steve's pound really lands.
    this.trauma = Math.max(0, this.trauma - dt * 1.7);
    if (this.trauma > 0 && !this.reduceMotion) {
      const a = this.trauma * this.trauma * 15;
      const t = this.time;
      this.shakeX = a * (Math.sin(t * 47.3) + Math.sin(t * 31.7 + 1.3)) * 0.5;
      this.shakeY = a * (Math.sin(t * 41.9 + 2.1) + Math.sin(t * 29.1 + 0.7)) * 0.5;
    } else {
      this.shakeX = 0;
      this.shakeY = 0;
    }
  }

  ownColonel(view) {
    const list = view.structs;
    if (!list) return null;
    const team = this.myTeam(view);
    let any = null;
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      if (s.kind !== STRUCT.COLONEL) continue;
      if (team === null || s.team === team) return s;
      any = s;
    }
    return any;
  }

  trackColonels(view) {
    const cs = view.meta && view.meta.colonels;
    if (!cs) return;
    for (let i = 0; i < cs.length; i++) {
      const c = cs[i];
      const last = this.colonelLast.get(c.team);
      if (last !== undefined && c.hp < last) this.colonelHitAt.set(c.team, this.time);
      this.colonelLast.set(c.team, c.hp);
    }
  }

  // ---- ambient life ---------------------------------------------------------

  visible(x, y, margin) {
    const vw = this.cssW / this.zoom;
    const vh = this.cssH / this.zoom;
    return x > this.cam.x - margin && y > this.cam.y - margin && x < this.cam.x + vw + margin && y < this.cam.y + vh + margin;
  }

  ambientEmitters(view, dt) {
    const fx = this.fx;
    this.smokeClock += dt;
    if (this.smokeClock > 0.42) {
      this.smokeClock = 0;
      const vents = this.smokeVents;
      for (let i = 0; i < vents.length; i++) {
        const v = vents[i];
        if (this.visible(v.x, v.y, 120)) fx.smoke(v.x, v.y, 0);
      }
    }
    this.steamClock += dt;
    if (this.steamClock > 0.3) {
      this.steamClock = 0;
      const list = view.structs;
      if (list) {
        for (let i = 0; i < list.length; i++) {
          const s = list[i];
          if (s.kind === STRUCT.COCOA && this.visible(s.cx * CELL, s.cy * CELL, 60)) fx.steam(s.cx * CELL + 18.5, s.cy * CELL - 2, 2);
        }
      }
    }
    const actors = view.actors;
    if (!actors) return;
    for (let i = 0; i < actors.length; i++) {
      const a = actors[i];
      if (a.flags & AFLAG.PACKING) {
        if (Math.random() < dt * 14) fx.packBits(a.x, a.y);
      } else if (a.flags & (AFLAG.SLIDING | AFLAG.SLEDDING)) {
        if (this.visible(a.x, a.y, 40)) fx.slideSpray(a.x, a.y, a.vx || 0, a.vy || 0);
      } else if (a.kind === ACTOR.KID && !(a.flags & AFLAG.FROZEN) && Math.random() < dt * 0.55 && this.visible(a.x, a.y, 20)) {
        fx.breath(a.x, a.y - 22, 8, Math.cos(a.aim || 0) >= 0 ? 1 : -1);
      }
    }
    const balls = view.balls;
    if (balls) {
      for (let i = 0; i < balls.length; i++) {
        const b = balls[i];
        if (b.kind === BALL.ICE && Math.random() < dt * 40) fx.sparkleTrail(b.x, b.y, b.z);
      }
    }
  }

  // Snow crystals catching the sun as the camera moves past. Positions come from a hash of a fixed
  // world grid, so a glint stays put on the ground rather than sliding with the view.
  drawGlints(ctx) {
    const strength = 1 - this.atmos.night;
    if (strength < 0.1 || this.low) return;
    const a = this.atlas;
    const k = FX.STAR * 2;
    const step = 120;
    const x0 = Math.floor(this.cam.x / step);
    const y0 = Math.floor(this.cam.y / step);
    const x1 = x0 + Math.ceil(this.cssW / this.zoom / step) + 1;
    const y1 = y0 + Math.ceil(this.cssH / this.zoom / step) + 1;
    const t = this.time;
    for (let gy = y0; gy <= y1; gy++) {
      for (let gx = x0; gx <= x1; gx++) {
        const h = Math.imul(gx * 73856093 ^ gy * 19349663, 83492791) >>> 0;
        const phase = (h & 1023) / 163;
        const speed = 0.55 + ((h >>> 10) & 255) / 340;
        const pulse = Math.sin(t * speed + phase);
        if (pulse < 0.86) continue;
        const px = gx * step + ((h >>> 3) % step);
        const py = gy * step + ((h >>> 13) % step);
        if (this.onIce(px, py)) continue;
        const s = 5 + ((pulse - 0.86) / 0.14) * 9;
        ctx.globalAlpha = ((pulse - 0.86) / 0.14) * strength;
        ctx.drawImage(a.canvas, a.cells[k], a.cells[k + 1], a.size, a.size, px - s / 2, py - s / 2, s, s);
      }
    }
    ctx.globalAlpha = 1;
  }

  // ---- 3. flat pass ---------------------------------------------------------

  // A cell grid rebuilt from the live struct list. Stamping with a rising frame id means no clearing.
  stampCells(view) {
    const list = view.structs;
    if (!list || !this.cols) return;
    const stamp = (++this.cellStamp) << 3;
    const cols = this.cols;
    const cells = this.cells;
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      if (s.kind === STRUCT.WALL || s.kind === STRUCT.ICEWALL) {
        const c = (s.cy + 1) * cols + s.cx + 1;
        if (c >= 0 && c < cells.length) cells[c] = stamp | (s.kind + 1);
      }
    }
  }

  neighbourMask(s) {
    const cols = this.cols;
    const cells = this.cells;
    const c = (s.cy + 1) * cols + s.cx + 1;
    const want = (this.cellStamp << 3) | (s.kind + 1);
    let m = 0;
    if (cells[c - 1] === want) m |= NB.L;
    if (cells[c + 1] === want) m |= NB.R;
    if (cells[c - cols] === want) m |= NB.U;
    if (cells[c + cols] === want) m |= NB.D;
    return m;
  }

  drawFlat(ctx, view, ui) {
    const structs = view.structs;
    const margin = 90;
    const vx0 = this.cam.x - margin;
    const vy0 = this.cam.y - margin;
    const vx1 = this.cam.x + this.cssW / this.zoom + margin;
    const vy1 = this.cam.y + this.cssH / this.zoom + margin;

    if (structs) {
      for (let i = 0; i < structs.length; i++) {
        const s = structs[i];
        const x = s.cx * CELL;
        const y = s.cy * CELL;
        if (x < vx0 || y < vy0 || x > vx1 || y > vy1) continue;
        if (s.kind === STRUCT.SLICK) {
          this.drawSlick(ctx, s, x, y);
          continue;
        }
        if (s.kind === STRUCT.COLONEL || s.kind === STRUCT.DECOY || s.kind === STRUCT.PULT) {
          // Round things and open frames get a soft pool; a square one reads as a stuck-on box.
          const big = s.kind === STRUCT.COLONEL;
          const rx = big ? 58 : 25;
          const ry = big ? 28 : 12;
          ctx.drawImage(this.shadow.canvas, x + (big ? 40 : 20) - rx + 7, y + (big ? 70 : 34) - ry + 2, rx * 2, ry * 2);
          continue;
        }
        const joins = s.kind === STRUCT.WALL || s.kind === STRUCT.ICEWALL;
        const b = this.blockShadows[joins ? this.neighbourMask(s) : 0];
        ctx.drawImage(b.canvas, x + 11 + b.x, y + 6 + b.y, b.w, b.h);
      }
    }

    const sh = this.shadow.canvas;
    const pickups = view.pickups;
    if (pickups) {
      for (let i = 0; i < pickups.length; i++) {
        const p = pickups[i];
        if (p.x < vx0 || p.y < vy0 || p.x > vx1 || p.y > vy1) continue;
        ctx.globalAlpha = 0.55 + 0.25 * Math.sin(this.time * 3 + p.id);
        const h = this.pickupHalos[p.kind] ?? this.pickupHalos[0];
        ctx.drawImage(h.canvas, p.x - 30, p.y - 22, 60, 44);
        ctx.globalAlpha = 0.8;
        ctx.drawImage(sh, p.x - 15, p.y - 6, 30, 12);
      }
    }

    const actors = view.actors;
    const long = this.atmos.longShadow;
    if (actors) {
      for (let i = 0; i < actors.length; i++) {
        const a = actors[i];
        if (a.x < vx0 || a.y < vy0 || a.x > vx1 || a.y > vy1) continue;
        const r = a.kind === ACTOR.KID ? KID.radius : (FOES[a.kind] ? FOES[a.kind].r : 14);
        const wide = a.kind === ACTOR.TRUCK ? 1.5 : (a.flags & (AFLAG.SLIDING | AFLAG.SLEDDING)) ? 1.45 : 1.18;
        // A low sun drags every shadow out to the side, the single cheapest way to sell golden hour.
        const rx = r * wide * (1 + long * 1.1);
        const ry = r * (a.kind === ACTOR.TRUCK ? 0.78 : 0.6);
        ctx.globalAlpha = 0.9 - long * 0.2;
        ctx.drawImage(sh, a.x - r * wide + r * 0.16 + (rx - r * wide) * 0.2, a.y - ry + r * 0.1 + long * r * 0.22, rx * 2, ry * 2);
      }
    }

    const me = view.me;
    if (me) this.drawMeRing(ctx, me, ui);

    const balls = view.balls;
    if (balls) {
      for (let i = 0; i < balls.length; i++) {
        const b = balls[i];
        if (b.x < vx0 || b.y < vy0 || b.x > vx1 || b.y > vy1) continue;
        // The shadow stays on the ground as the ball climbs: the gap between them is how height reads.
        const r = (b.r || 6) * (1 + b.z * 0.006);
        ctx.globalAlpha = clamp(0.95 - b.z * 0.004, 0.32, 0.95);
        ctx.drawImage(sh, b.x - r * 1.2, b.y - r * 0.72, r * 2.4, r * 1.44);
      }
    }
    ctx.globalAlpha = 1;

    this.drawRopeShadow(ctx, view);
    this.drawReticles(ctx, view, ui);
    this.drawTelegraphs(ctx, view);
    if (me) this.drawTrajectory(ctx, view, me, ui);
    this.drawBuildAid(ctx, view, ui);
    this.drawWaveArrows(ctx, view);
  }

  drawSlick(ctx, s, x, y) {
    const level = structLevel(s);
    const sp = this.spriteForStruct(s, 0, level, (s.cx + s.cy) & 1);
    blit(ctx, sp, x, y);
    // A glint sweeps across every few seconds, so a Slick cell reads as polished from any angle.
    const phase = (this.time * 0.55 + (s.cx * 7 + s.cy * 13) * 0.17) % 3;
    if (phase < 0.55) {
      const t = phase / 0.55;
      const a = this.atlas;
      const k = FX.STAR * 2;
      ctx.globalAlpha = Math.sin(t * Math.PI) * 0.9;
      const px = x + 8 + t * 24;
      const py = y + 30 - t * 20;
      ctx.drawImage(a.canvas, a.cells[k], a.cells[k + 1], a.size, a.size, px - 7, py - 7, 14, 14);
      ctx.globalAlpha = 1;
    }
  }

  drawMeRing(ctx, me, ui) {
    const sp = this.meRing;
    const pulse = 1 + Math.sin(this.time * 2.4) * 0.03;
    const w = 58 * pulse;
    const h = 34 * pulse;
    ctx.globalAlpha = 0.95;
    ctx.drawImage(sp.canvas, me.x - w / 2, me.y - h / 2 + 1, w, h);
    ctx.globalAlpha = 1;
    if (ui.charge > 0 && !ui.lobbing) {
      // Charge fills a ring on the ground, in the same place the eye already watches for the kid.
      const full = ui.charge >= 0.98;
      ctx.strokeStyle = full ? P.gold : '#ffffff';
      ctx.lineWidth = full ? 4 : 3;
      ctx.save();
      ctx.translate(me.x, me.y + 1);
      ctx.scale(1, 0.58);
      ctx.beginPath();
      ctx.arc(0, 0, 24, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.min(1, ui.charge));
      ctx.restore();
      ctx.stroke();
    }
  }

  drawRopeShadow(ctx, view) {
    const want = view.meta && view.meta.truce ? 1 : 0;
    this.ropeFade += (want - this.ropeFade) * (1 - Math.exp(-this.dt / 0.1));
    if (this.ropeFade < 0.02 || !this.map.truce) return;
    const t = this.map.truce;
    ctx.globalAlpha = 0.16 * this.ropeFade;
    ctx.strokeStyle = '#5a56a8';
    ctx.lineWidth = 5;
    ctx.beginPath();
    if (t.axis === 'x') {
      ctx.moveTo(t.at + 20, 0);
      ctx.lineTo(t.at + 20, this.map.h);
    } else {
      ctx.moveTo(0, t.at + 8);
      ctx.lineTo(this.map.w, t.at + 8);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  reticle(ctx, x, y, r, color, closing) {
    const t = this.time;
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(1, 0.76);
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.14;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 0.9;
    ctx.strokeStyle = color;
    ctx.lineWidth = 3;
    ctx.setLineDash([r * 0.34, r * 0.18]);
    ctx.lineDashOffset = -t * 30;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    if (closing >= 0) {
      ctx.globalAlpha = 0.85;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(0, 0, Math.max(2, r * closing), 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.globalAlpha = 0.95;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(0, 0, 2.4, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  drawReticles(ctx, view, ui) {
    const balls = view.balls;
    if (balls) {
      const myTeam = this.myTeam(view);
      for (let i = 0; i < balls.length; i++) {
        const b = balls[i];
        if (!(b.ft > 0) || b.lx === undefined) continue;
        if (b.kind !== BALL.LOB && !(b.vz > 1)) continue;
        // ft is the flight at launch, so progress is measured against the ball's first-seen distance.
        let start = this.ballStart.get(b.id);
        if (start === undefined) {
          start = Math.hypot(b.lx - b.x, b.ly - b.y) || 1;
          this.ballStart.set(b.id, start);
        }
        const left = Math.hypot(b.lx - b.x, b.ly - b.y) / start;
        const team = b.team ?? b.tm ?? this.ballTeams.get(b.id);
        const friendly = b.mine || (team !== undefined && myTeam !== null && team === myTeam);
        let r = FOES[ACTOR.LOBBER].splash;
        if (friendly) r = THROW.lob.splash * (b.mine && view.you && view.you.mods ? view.you.mods.lobSplashMul : 1);
        this.reticle(ctx, b.lx, b.ly, r, friendly ? RETICLE_MINE : RETICLE_FOE, left);
      }
      if (this.ballStart.size > 256) this.ballStart.clear();
    }
    const me = view.me;
    if (me && ui.lobbing) {
      const mul = view.you && view.you.mods ? view.you.mods.lobSplashMul : 1;
      const dx = ui.aimX - me.x;
      const dy = ui.aimY - me.y;
      const d = Math.hypot(dx, dy) || 1;
      const k = Math.min(1, THROW.lob.maxRange / d);
      const tx = me.x + dx * k;
      const ty = me.y + dy * k;
      this.reticle(ctx, tx, ty, THROW.lob.splash * mul, P.gold, -1);
      this.lobArc(ctx, me, tx, ty, d * k);
    }
  }

  // Preview of the real flight (SPEC 7): same height as the ball will reach at each fraction.
  lobArc(ctx, me, tx, ty, dist) {
    const T = THROW.lob.minFlight + dist * THROW.lob.flightPerUnit;
    const g = THROW.lob.gravity;
    const z0 = THROW.z0;
    const n = 14;
    for (let i = 1; i < n; i++) {
      const u = i / n;
      const z = z0 * (1 - u) + 0.5 * g * T * T * u * (1 - u);
      const x = me.x + (tx - me.x) * u;
      const y = me.y + (ty - me.y) * u - z * Z_LIFT;
      const phase = (u * 3 - this.time * 1.4) % 1;
      this.hintDot(ctx, x, y, 3, P.gold, 0.55 + 0.4 * Math.abs(phase));
    }
    ctx.globalAlpha = 1;
  }

  // Every aid drawn over snow must survive on white, on ice and in the dark, so each is a coloured
  // shape on a white halo rather than a white shape.
  hintDot(ctx, x, y, r, color, alpha) {
    ctx.globalAlpha = alpha;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(x, y, r + 1.3, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  drawTelegraphs(ctx, view) {
    const actors = view.actors;
    if (!actors) return;
    for (let i = 0; i < actors.length; i++) {
      const a = actors[i];
      if (a.kind === ACTOR.STEVE) {
        if (a.aux & AUX.POUND) {
          if (!this.poundSince.has(a.id)) this.poundSince.set(a.id, this.time);
          const t = clamp((this.time - this.poundSince.get(a.id)) / BOSS.steve.poundTelegraph, 0, 1);
          const R = BOSS.steve.poundRadius;
          ctx.save();
          ctx.translate(a.x, a.y);
          ctx.scale(1, 0.76);
          ctx.globalAlpha = 0.1 + 0.16 * t;
          ctx.fillStyle = RETICLE_FOE;
          ctx.beginPath();
          ctx.arc(0, 0, R * t, 0, Math.PI * 2);
          ctx.fill();
          ctx.globalAlpha = 0.95;
          ctx.strokeStyle = RETICLE_FOE;
          ctx.lineWidth = 3.4;
          ctx.setLineDash([16, 10]);
          ctx.lineDashOffset = -this.time * 60;
          ctx.beginPath();
          ctx.arc(0, 0, R, 0, Math.PI * 2);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.restore();
          ctx.globalAlpha = 1;
        } else {
          this.poundSince.delete(a.id);
        }
      } else if (a.kind === ACTOR.SLEDDER && (a.flags & AFLAG.SLEDDING)) {
        // A sled at full tilt is the fastest thing in the game; give it a warning on the snow ahead.
        const v = Math.hypot(a.vx || 0, a.vy || 0);
        if (v > 40) {
          const ux = a.vx / v;
          const uy = a.vy / v;
          ctx.strokeStyle = RETICLE_FOE;
          ctx.lineWidth = 3;
          ctx.setLineDash([10, 13]);
          ctx.lineDashOffset = -this.time * 90;
          ctx.globalAlpha = 0.42;
          ctx.beginPath();
          ctx.moveTo(a.x + ux * 30, a.y + uy * 30);
          ctx.lineTo(a.x + ux * 230, a.y + uy * 230);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.globalAlpha = 1;
        }
      }
    }
  }

  drawTrajectory(ctx, view, me, ui) {
    if (!(ui.charge > 0) || ui.lobbing) return;
    const c = Math.min(1, ui.charge);
    const mods = view.you && view.you.mods;
    const speed = (THROW.quick.speed + (THROW.power.speed - THROW.quick.speed) * c) * (mods ? mods.throwSpeedMul : 1);
    const flight = THROW.quick.flight + (THROW.power.flight - THROW.quick.flight) * c;
    let reach = speed * flight;
    const ang = Math.atan2(ui.aimY - me.y, ui.aimX - me.x);
    const ux = Math.cos(ang);
    const uy = Math.sin(ang);
    if (view.cw) {
      const hit = raycastFlat(view.cw, me.x, me.y, me.x + ux * reach, me.y + uy * reach, THROW.z0 * 0.6);
      if (hit) reach = Math.hypot(hit.x - me.x, hit.y - me.y);
    }
    const color = c >= 0.98 ? P.gold : '#6d7be0';
    const step = 26;
    const count = Math.floor(reach / step);
    for (let i = 1; i <= count; i++) {
      const d = i * step;
      const u = d / reach;
      this.hintDot(ctx, me.x + ux * d, me.y + uy * d - THROW.z0 * Z_LIFT * (1 - u), 3 - u * 1.2, color, 0.9 * (1 - u * 0.8));
    }
    ctx.globalAlpha = 1;
  }

  drawBuildAid(ctx, view, ui) {
    if (ui.tool === null || ui.tool === undefined) return;
    const me = view.me;
    if (me && ui.buildRange > 0) {
      ctx.save();
      ctx.translate(me.x, me.y);
      ctx.beginPath();
      ctx.arc(0, 0, ui.buildRange, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(120,134,232,0.07)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.85)';
      ctx.lineWidth = 5;
      ctx.stroke();
      ctx.strokeStyle = 'rgba(100,116,226,0.85)';
      ctx.lineWidth = 2.6;
      ctx.setLineDash([16, 12]);
      ctx.lineDashOffset = -this.time * 16;
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
    }
    const cell = ui.toolCell;
    if (!cell) return;
    const x = cell.cx * CELL;
    const y = cell.cy * CELL;
    const state = ui.toolState;
    const tint = TOOL_TINT[state] ?? '#ffffff';
    const pulse = 0.72 + 0.16 * Math.sin(this.time * 6);

    const tool = ui.tool;
    const colonelCell = state === 'patch';
    const size = colonelCell ? 2 : 1;
    ctx.globalAlpha = 0.34;
    ctx.fillStyle = tint;
    ctx.fillRect(x + 2, y + 2, CELL * size - 4, CELL * size - 4);
    ctx.globalAlpha = 0.95;
    ctx.strokeStyle = tint;
    ctx.lineWidth = 3;
    ctx.strokeRect(x + 1.5, y + 1.5, CELL * size - 3, CELL * size - 3);
    ctx.globalAlpha = 1;

    if (tool === 'demolish') {
      blit(ctx, this.markX, x + CELL / 2, y + CELL / 2);
      return;
    }
    if (state === 'repair' || state === 'patch') {
      blit(ctx, this.markPlus, x + (CELL * size) / 2, y + (CELL * size) / 2);
      return;
    }
    const team = me ? me.team : TEAM.A;
    const fake = this.ghost || (this.ghost = { kind: 0, team: 0 });
    fake.kind = tool;
    fake.team = team;
    const sp = this.spriteForStruct(fake, 0, 0, 0);
    ctx.globalAlpha = (ui.toolValid ? 0.82 : 0.42) * pulse + 0.1;
    blit(ctx, sp, x, y);
    ctx.globalAlpha = 1;
    const b = BUILD[tool];
    if (b && (tool === STRUCT.COCOA || tool === STRUCT.PULT)) {
      const R = tool === STRUCT.COCOA ? b.radius : b.range;
      ctx.strokeStyle = tool === STRUCT.COCOA ? 'rgba(255,190,120,0.75)' : 'rgba(255,255,255,0.5)';
      ctx.lineWidth = 2;
      ctx.setLineDash([9, 9]);
      ctx.beginPath();
      ctx.arc(x + CELL / 2, y + CELL / 2, R, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  drawWaveArrows(ctx, view) {
    const next = view.meta && view.meta.next;
    if (view.phase !== PHASE.BUILD || !next || !next.from) return;
    const ents = this.map.entrances;
    if (!ents) return;
    const goal = this.map.fort || { x: this.map.w / 2, y: this.map.h / 2 };
    const sp = this.chevron.canvas;
    const c = this.chevron;
    for (let i = 0; i < next.from.length; i++) {
      const e = ents[next.from[i]];
      if (!e) continue;
      const ang = Math.atan2(goal.y - e.y, goal.x - e.x);
      const ux = Math.cos(ang);
      const uy = Math.sin(ang);
      ctx.save();
      for (let k = 0; k < 3; k++) {
        const flow = (this.time * 0.9 + k / 3) % 1;
        const d = 70 + flow * 170;
        const fade = Math.sin(flow * Math.PI);
        ctx.setTransform(this.S * ux, this.S * uy, -this.S * uy, this.S * ux, (e.x + ux * d) * this.S + this.tx, (e.y + uy * d) * this.S + this.ty);
        ctx.globalAlpha = fade * 0.92;
        ctx.drawImage(sp, c.x * 1.2, c.y * 1.2, c.w * 1.2, c.h * 1.2);
      }
      ctx.restore();
    }
    ctx.globalAlpha = 1;
  }

  // ---- 4. y-sorted pass -----------------------------------------------------

  slot(i) {
    let it = this.pool[i];
    if (!it) {
      it = { t: 0, id: 0, key: 0, ref: null, sp: null, ax: 0, ay: 0, x0: 0, y0: 0, x1: 0, y1: 0 };
      this.pool[i] = it;
    }
    return it;
  }

  collect(view) {
    const list = this.list;
    let n = 0;
    let p = 0;
    const margin = 40;
    const vx0 = this.cam.x - margin;
    const vy0 = this.cam.y - margin;
    const vx1 = this.cam.x + this.cssW / this.zoom + margin;
    const vy1 = this.cam.y + this.cssH / this.zoom + margin;

    const obs = this.obstacles;
    for (let i = 0; i < obs.length; i++) {
      const o = obs[i];
      if (o.x1 < vx0 || o.y1 < vy0 || o.x0 > vx1 || o.y0 > vy1) continue;
      list[n++] = o;
    }

    if (this.ropeFade > 0.02) {
      const spans = this.ropeSpans;
      for (let i = 0; i < spans.length; i++) {
        const o = spans[i];
        if (o.x1 < vx0 || o.y1 < vy0 || o.x0 > vx1 || o.y0 > vy1) continue;
        list[n++] = o;
      }
    }

    const structs = view.structs;
    if (structs) {
      for (let i = 0; i < structs.length; i++) {
        const s = structs[i];
        if (s.kind === STRUCT.SLICK) continue;
        const b = BUILD[s.kind];
        const size = (b && b.size) || 1;
        const x0 = s.cx * CELL - 12;
        const x1 = (s.cx + size) * CELL + 12;
        const y1 = (s.cy + size) * CELL + 10;
        const y0 = s.cy * CELL - (b ? b.height : 40) * Z_LIFT - 28;
        if (x1 < vx0 || y1 < vy0 || x0 > vx1 || y0 > vy1) continue;
        const it = this.slot(p++);
        it.t = T_STRUCT;
        it.id = s.id;
        it.key = (s.cy + size) * CELL;
        it.ref = s;
        it.x0 = x0;
        it.y0 = y0;
        it.x1 = x1;
        it.y1 = y1;
        list[n++] = it;
      }
    }

    const pickups = view.pickups;
    if (pickups) {
      for (let i = 0; i < pickups.length; i++) {
        const q = pickups[i];
        if (q.x < vx0 || q.y < vy0 - 30 || q.x > vx1 || q.y > vy1 + 30) continue;
        const it = this.slot(p++);
        it.t = T_PICKUP;
        it.id = q.id;
        it.key = q.y;
        it.ref = q;
        list[n++] = it;
      }
    }

    const actors = view.actors;
    if (actors) {
      for (let i = 0; i < actors.length; i++) {
        const a = actors[i];
        const reach = a.kind === ACTOR.TRUCK || a.kind === ACTOR.STEVE ? 150 : 60;
        if (a.x < vx0 - reach || a.y < vy0 - reach || a.x > vx1 + reach || a.y > vy1 + reach) continue;
        const it = this.slot(p++);
        it.t = T_ACTOR;
        it.id = a.id;
        it.key = a.y;
        it.ref = a;
        it.x0 = a.x - 18;
        it.y0 = a.y - headHeight(a.kind);
        it.x1 = a.x + 18;
        it.y1 = a.y + 8;
        list[n++] = it;
      }
    }

    const balls = view.balls;
    if (balls) {
      for (let i = 0; i < balls.length; i++) {
        const b = balls[i];
        if (b.z > HIGH_Z) continue;
        if (b.x < vx0 || b.y < vy0 || b.x > vx1 || b.y > vy1 + b.z) continue;
        const it = this.slot(p++);
        it.t = T_BALL;
        it.id = b.id;
        it.key = b.y;
        it.ref = b;
        list[n++] = it;
      }
    }

    // Stale tail entries from a busier frame must not reach the sort.
    list.length = n;
    list.sort(byDepth);
    return n;
  }

  drawItem(ctx, it, view, dt) {
    switch (it.t) {
      case T_OBSTACLE:
        blit(ctx, it.sp, it.ax, it.ay);
        break;
      case T_ROPE:
        ctx.globalAlpha = this.ropeFade;
        blit(ctx, it.sp, it.ax, it.ay);
        ctx.globalAlpha = 1;
        break;
      case T_STRUCT:
        this.drawStruct(ctx, it.ref, view, dt);
        break;
      case T_PICKUP:
        this.drawPickup(ctx, it.ref);
        break;
      case T_ACTOR:
        this.drawActor(ctx, it.ref, view, dt, false);
        break;
      case T_BALL:
        this.drawBall(ctx, it.ref);
        break;
      default:
        break;
    }
  }

  drawStruct(ctx, s, view, dt) {
    if (s.kind === STRUCT.COLONEL) {
      this.colonelLastId.add(s.id);
      const info = this.info;
      info.time = this.time;
      info.dt = dt;
      info.player = null;
      info.me = false;
      info.view = view;
      ctx.save();
      this.art.drawColonel(ctx, s, info);
      ctx.restore();
      return;
    }
    const x = s.cx * CELL;
    const y = s.cy * CELL;
    const level = structLevel(s);
    const joins = s.kind === STRUCT.WALL || s.kind === STRUCT.ICEWALL;
    const sp = this.spriteForStruct(s, joins ? this.neighbourMask(s) : 0, level, (s.cx + s.cy) & 1);

    // Pop-in on placement; bornAt is 0 for structures that came in a full-state sync.
    let scale = 1;
    if (s.bornAt > 0 && view.renderTick !== undefined) {
      const age = (view.renderTick - s.bornAt) / SIM_HZ;
      if (age >= 0 && age < 0.26) {
        const t = age / 0.26;
        const u = t - 1;
        scale = 1 + 2.7 * u * u * u + 1.7 * u * u;
      }
    }
    let wobble = 0;
    const hitT = this.structHitAt.get(s.id);
    if (hitT !== undefined) {
      const age = this.time - hitT;
      if (age < 0.2) wobble = Math.sin(age * 70) * 2.2 * (1 - age / 0.2);
      else this.structHitAt.delete(s.id);
    }

    if (scale !== 1) {
      const px = x + CELL / 2;
      const py = y + CELL;
      ctx.save();
      ctx.translate(px, py);
      ctx.scale(scale, scale);
      ctx.translate(-px, -py);
      this.drawStructArt(ctx, s, sp, x, y);
      ctx.restore();
    } else {
      this.drawStructArt(ctx, s, sp, x + wobble, y);
    }
  }

  drawStructArt(ctx, s, sp, x, y) {
    if (s.kind !== STRUCT.PULT) {
      blit(ctx, sp, x, y);
      return;
    }
    const fired = this.pultFired.get(s.id);
    const age = fired ? this.time - fired.t : 99;
    const flip = fired && Math.cos(fired.ang) < 0;
    let ang = PULT_ARM.cocked;
    if (age < 0.09) ang = PULT_ARM.cocked + (PULT_ARM.fired - PULT_ARM.cocked) * (age / 0.09);
    else if (age < 0.36) ang = PULT_ARM.fired + Math.sin((age - 0.09) * 34) * 0.1 * (1 - (age - 0.09) / 0.27);
    else if (age < 1.9) ang = PULT_ARM.fired + (PULT_ARM.cocked - PULT_ARM.fired) * (1 - Math.pow(1 - (age - 0.36) / 1.54, 2));
    const arm = age > 1.5 ? this.armLoaded : this.armEmpty;
    ctx.save();
    if (flip) {
      ctx.translate(x * 2 + CELL, 0);
      ctx.scale(-1, 1);
    }
    ctx.save();
    ctx.translate(x + PULT_PIVOT.x, y + PULT_PIVOT.y);
    ctx.rotate(ang);
    ctx.drawImage(arm.canvas, arm.x, arm.y, arm.w, arm.h);
    ctx.restore();
    blit(ctx, sp, x, y);
    ctx.restore();
  }

  drawPickup(ctx, p) {
    const sp = this.pickupSprites[p.kind] ?? this.pickupSprites[0];
    const bob = 7 + Math.sin(this.time * 2.6 + p.id * 1.7) * 3;
    blit(ctx, sp, p.x, p.y - bob - 8);
    // A spark now and then keeps the eye coming back to it.
    const phase = (this.time * 0.8 + p.id * 0.37) % 1.6;
    if (phase < 0.3) {
      const a = this.atlas;
      const k = FX.STAR * 2;
      ctx.globalAlpha = Math.sin((phase / 0.3) * Math.PI);
      ctx.drawImage(a.canvas, a.cells[k], a.cells[k + 1], a.size, a.size, p.x + 7, p.y - bob - 24, 13, 13);
      ctx.globalAlpha = 1;
    }
  }

  drawActor(ctx, a, view, dt, xray) {
    const info = this.info;
    const players = view.players;
    info.time = this.time;
    info.dt = xray ? 0 : dt;
    info.player = players ? players.get(a.id) ?? null : null;
    info.me = view.me ? a.id === view.me.id : false;
    info.view = view;
    ctx.save();
    this.art.draw(ctx, a, info);
    ctx.restore();
    if (xray) return;
    const meta = view.meta;
    if (meta && meta.leaderId === a.id && view.mode === MODE.FFA) {
      const bob = Math.sin(this.time * 3) * 1.2;
      blit(ctx, this.crown, a.x, a.y - 45 + bob);
    }
  }

  drawBall(ctx, b) {
    const sp = this.ballSprites[b.kind] ?? this.ballSprites[0];
    const r = b.r || 6;
    const k = r / sp.r;
    const rolls = b.kind === BALL.GIANT || b.kind === BALL.BOULDER;
    const x = b.x;
    const y = b.y - b.z * Z_LIFT - (rolls ? r * 0.72 : 0);
    const speed = Math.hypot(b.vx || 0, b.vy || 0);

    if (rolls) {
      // Spin comes from position along the travel axis, so it needs no per-ball state.
      const spin = speed > 1 ? (b.x * b.vx + b.y * b.vy) / speed / r : 0;
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(b.vx < 0 ? -spin : spin);
      ctx.drawImage(sp.canvas, sp.x * k, sp.y * k, sp.w * k, sp.h * k);
      ctx.restore();
      return;
    }
    if (speed > 300 && b.kind !== BALL.LOB) {
      const streak = b.kind === BALL.POWER ? this.streaks[1] : b.kind === BALL.ICE ? this.streaks[2] : this.streaks[0];
      const ang = Math.atan2(b.vy, b.vx);
      const len = Math.min(1.3, speed / 620);
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(ang);
      ctx.scale(len, r / 6.5);
      ctx.globalAlpha = 0.85;
      ctx.drawImage(streak.canvas, streak.x, streak.y, streak.w, streak.h);
      ctx.restore();
      ctx.globalAlpha = 1;
    }
    // Lobs swell toward the camera at the top of the arc.
    const grow = 1 + b.z * 0.0026;
    const w = sp.w * k * grow;
    const h = sp.h * k * grow;
    if (b.kind === BALL.CONE) {
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(Math.atan2(b.vy, b.vx) + Math.PI / 2 + Math.PI);
      ctx.drawImage(sp.canvas, -w / 2, -h / 2, w, h);
      ctx.restore();
    } else {
      ctx.drawImage(sp.canvas, x - w / 2, y - h / 2, w, h);
    }
  }

  // ---- 5. x-ray pass --------------------------------------------------------

  drawXray(ctx, view, n) {
    const me = view.me;
    if (!me) return;
    const list = this.list;
    const myTeam = me.team;
    for (let i = 0; i < n; i++) {
      const it = list[i];
      if (it.t !== T_ACTOR) continue;
      const a = it.ref;
      if (a.kind !== ACTOR.KID || a.team !== myTeam) continue;
      let hidden = false;
      for (let j = i + 1; j < n; j++) {
        const o = list[j];
        if (o.key <= it.key) continue;
        if (o.t !== T_OBSTACLE && o.t !== T_STRUCT && !(o.t === T_ACTOR && (o.ref.kind === ACTOR.TRUCK || o.ref.kind === ACTOR.STEVE))) continue;
        if (o.x0 < it.x1 && o.x1 > it.x0 && o.y0 < it.y1 && o.y1 > it.y0) {
          hidden = true;
          break;
        }
      }
      if (!hidden) continue;
      ctx.save();
      ctx.globalAlpha = 0.3;
      this.drawActor(ctx, a, view, 0, true);
      ctx.restore();
    }
    ctx.globalAlpha = 1;
  }

  // ---- 6. high pass ---------------------------------------------------------

  drawHigh(ctx, view) {
    const balls = view.balls;
    if (balls) {
      for (let i = 0; i < balls.length; i++) {
        const b = balls[i];
        if (b.z > HIGH_Z) this.drawBall(ctx, b);
      }
    }
    const pad = 60;
    this.fx.draw(ctx, this.atlas, this.S, this.tx, this.ty, this.cam.x - pad, this.cam.y - pad, this.cam.x + this.cssW / this.zoom + pad, this.cam.y + this.cssH / this.zoom + pad);
  }

  // ---- 7. lights ------------------------------------------------------------

  collectPanes() {
    const out = this.nightPanes;
    const panes = this.panes;
    let n = 0;
    for (let i = 0; i < panes.length; i++) {
      const p = panes[i];
      if (this.visible(p.x, p.y, 40)) out[n++] = p;
    }
    return n;
  }

  collectLights(view) {
    const out = this.nightLights;
    let n = 0;
    const lights = this.lights;
    for (let i = 0; i < lights.length; i++) {
      const L = lights[i];
      if (this.visible(L.gx ?? L.x, L.gy ?? L.y, L.r)) out[n++] = L;
    }
    // Your kid carries a little glow so night stays readable anywhere on the map.
    const me = view.me;
    if (me) {
      const own = this.ownLight || (this.ownLight = { x: 0, y: 0, r: 190, color: '#d6dcff', power: 0.34 });
      own.x = me.x;
      own.y = me.y;
      out[n++] = own;
    }
    const structs = view.structs;
    if (structs) {
      let pool = 0;
      const stands = this.standLights || (this.standLights = []);
      for (let i = 0; i < structs.length; i++) {
        const s = structs[i];
        if (s.kind !== STRUCT.COCOA) continue;
        let L = stands[pool];
        if (!L) {
          L = { x: 0, y: 0, r: 130, color: '#ffbf7a', power: 0.9 };
          stands[pool] = L;
        }
        pool++;
        L.x = (s.cx + 0.5) * CELL;
        L.y = (s.cy + 0.5) * CELL;
        if (this.visible(L.x, L.y, L.r)) out[n++] = L;
      }
    }
    // The truck brings its own pool of light, thrown ahead of it along the road.
    const actors = view.actors;
    if (actors) {
      for (let i = 0; i < actors.length; i++) {
        const a = actors[i];
        if (a.kind !== ACTOR.TRUCK) continue;
        const L = this.truckLight || (this.truckLight = { x: 0, y: 0, r: 150, color: '#ffe2a8', power: 0.42 });
        const speed = Math.hypot(a.vx || 0, a.vy || 0);
        const ux = speed > 1 ? a.vx / speed : Math.cos(a.aim || 0);
        const uy = speed > 1 ? a.vy / speed : Math.sin(a.aim || 0);
        L.x = a.x + ux * 90;
        L.y = a.y + uy * 90;
        if (this.visible(L.x, L.y, L.r)) out[n++] = L;
      }
    }
    return n;
  }
}
