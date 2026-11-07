// All player input: keyboard and mouse, touch twin-stick, and the standard gamepad.
// Input is the only producer of the `ui` object the renderer draws from (SPEC 11.0, 11.1).
import { AFLAG, BTN, EMOTES, PHASE, MODE, STRUCT } from '../shared/schema.js';
import { BUILD, CELL, KID, THROW } from '../shared/constants.js';
import { canPlace, demolishState } from '../shared/physics.js';
import { Emitter } from './ui/dom.js';

const STICK_R = 56;
const DEADZONE = 0.18;
const EDGE_MARGIN = 24;
const TAP_MS = 180;
const TAP_RANGE = 390;
const IDLE_AIM_REACH = 300;
const LOB_MIN = 96;
const PAD_TRIGGER = 0.4;
// A stick has to move this far before it counts as "the player switched to the pad", so a worn
// stick drifting just past the deadzone can't flip the HUD away from the keyboard.
const PAD_MODE_SWITCH = 0.45;
const PAD_CELL_SLACK = CELL * 0.75;

// Session ORs btn between fixed steps and keeps only the latest aim, and rAF runs about twice per
// step. Anything that must be true on the step where a button falls (a CANCEL, the aim of a
// release) therefore has to stay asserted for at least two steps, not one sample.
const HOLD_ACROSS_STEPS_MS = 120;

const SHOT_BITS = BTN.THROW | BTN.LOB;
const TOOLS = Object.freeze([STRUCT.WALL, STRUCT.ICEWALL, STRUCT.DECOY, STRUCT.PULT, STRUCT.SLICK, STRUCT.COCOA, 'demolish']);
const PAINT_TOOLS = new Set([STRUCT.WALL, STRUCT.ICEWALL, STRUCT.SLICK]);
const VALID_STATES = new Set(['ok', 'repair', 'patch', 'demolish']);
const TOOL_BY_DIGIT = new Map(TOOLS.filter((t) => t !== 'demolish').map((k) => [BUILD[k].key, k]));
const GAME_KEYS = new Set(['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab', 'Enter']);
const TEXT_TARGETS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);
const MOVE_KEYS = {
  left: ['KeyA', 'ArrowLeft'], right: ['KeyD', 'ArrowRight'], up: ['KeyW', 'ArrowUp'], down: ['KeyS', 'ArrowDown'],
};
const MOUSE_BUTTON_BIT = { 0: 1, 1: 4, 2: 2 };
const PAD = Object.freeze({
  A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7, VIEW: 8, START: 9, UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15,
});

const IS_MAC = /Mac/.test(globalThis.navigator?.platform ?? '');

export class Input extends Emitter {
  constructor(canvas, renderer, opts = {}) {
    super();
    this.canvas = canvas;
    this.renderer = renderer;
    this.reduceMotion = !!opts.reduceMotion;
    this.enabled = true;
    this.inMatch = false;
    this.view = null;

    this.forced = null;
    this._mode = globalThis.matchMedia?.('(pointer: coarse)').matches ? 'touch' : 'kbm';
    this._tool = null;

    this.keys = new Set();
    this.cursor = { px: globalThis.innerWidth / 2, py: globalThis.innerHeight / 2 };
    this.lmb = null;    // 'throw' | 'build' | null, decided at press time so a tool change can't turn a release into a throw
    this.rmb = null;    // 'lob' | 'dropped' | null
    this.mouseId = null;
    this.slideBtn = false;
    this.lobArmed = false;
    this.shoutOpen = false;
    this.shoutIndex = 0;
    this.scoresHeld = false;

    this.moveStick = null;
    this.aimStick = null;
    this.buildPointer = null;

    this.pad = { connected: false, mx: 0, my: 0, ax: 0, ay: 0, am: 0, prev: [], rt: false, lt: false, a: false, aSpent: false };

    this.aim = 0;
    this.aimReach = 0;       // stick magnitude past the deadzone, the "m" of the lob and tool cursor rules
    this.tx = 0;
    this.ty = 0;
    this.aimHoldUntil = 0;
    this.latch = 0;          // presses since the last sample, so a tap shorter than a frame still arrives
    this.cancelLatch = false;
    this.cancelUntil = 0;
    this.chargeSince = 0;
    this.lastBits = 0;

    this.paint = null;
    this.lastBuildAt = -Infinity;

    this.safe = { top: 0, right: 0, bottom: 0, left: 0 };
    this.safeProbe = null;
    // Cached because reading layout on every pointer event or frame, straight after the HUD has
    // written to the DOM, forces a synchronous layout each time.
    this.rect = { left: 0, top: 0, width: 0, height: 0 };

    this.uiObject = {
      tool: null, toolCell: null, toolState: null, toolValid: false, buildRange: KID.buildRange,
      aimX: 0, aimY: 0, lobbing: false, charge: 0, sticks: [], reduceMotion: this.reduceMotion,
    };

    this.bind();
  }

  get mode() { return this._mode; }
  get tool() { return this._tool; }

  // ---- public API -----------------------------------------------------------

  setInMatch(on) {
    this.inMatch = !!on;
    if (!on) {
      this.clearHeld();
      this.setTool(null);
      this.setShout(false);
      this.lobArmed = false;
    }
  }

  setEnabled(on) {
    const next = !!on;
    if (next === this.enabled) return;
    this.enabled = next;
    if (!next) this.clearHeld();
  }

  setTool(k) {
    const next = k ?? null;
    if (next === this._tool) return;
    this._tool = next;
    this.paint = null;
    this.buildPointer = null;
    // The right stick disappears while a tool is out, so a thumb still on it must not stay "held".
    if (next !== null && this.aimStick) {
      this.aimStick = null;
      this.cancelCharge();
    }
    this.emit('tool', next);
  }

  // From the HUD. Lob is a sticky toggle (SPEC 11.1), so only the press edge matters.
  press(name, down) {
    if (!this.active()) { if (!down) this.slideBtn = false; return; }
    if (name === 'slide') {
      this.slideBtn = !!down;
      if (down) this.latch |= BTN.SLIDE;
    } else if (name === 'lob' && down) {
      this.lobArmed = !this.lobArmed;
      this.emit('lobArmed', this.lobArmed);
    }
  }

  forceFrame(frame) { this.forced = frame ? { ...frame } : null; }

  // Forgets every physical thing currently held. Anything that was charging is cancelled, never
  // thrown, even if the button comes up while the window has no focus.
  clearHeld() {
    const hadShot = (this.heldBits() & SHOT_BITS) !== 0;
    this.keys.clear();
    this.lmb = null;
    this.rmb = null;
    this.mouseId = null;
    this.slideBtn = false;
    this.moveStick = null;
    this.aimStick = null;
    this.buildPointer = null;
    this.paint = null;
    this.latch = 0;
    if (hadShot) this.cancelCharge();
    this.endScores();
  }

  setShout(open) {
    const next = !!open;
    if (next === this.shoutOpen) return;
    this.shoutOpen = next;
    this.shoutIndex = 0;
    this.emit('shoutMenu', next);
  }

  // ---- per-frame --------------------------------------------------------------

  sample(view) {
    this.view = view ?? null;
    const now = performance.now();
    this.pollPad(now);

    if (this.forced) {
      const f = this.forced;
      return { mx: f.mx ?? 0, my: f.my ?? 0, aim: f.aim ?? 0, btn: f.btn ?? 0, tx: f.tx ?? 0, ty: f.ty ?? 0 };
    }

    const cancelling = now < this.cancelUntil;
    if (!this.active()) {
      this.lastBits = 0;
      this.chargeSince = 0;
      this.latch = 0;
      return { mx: 0, my: 0, aim: this.aim, btn: cancelling ? BTN.CANCEL : 0, tx: this.tx, ty: this.ty };
    }

    const [mx, my] = this.moveVector();
    let held = this.heldBits();
    if (this.cancelLatch) {
      // The cancelled button is usually still down. It must not restart a charge until it comes up.
      if (!(held & SHOT_BITS)) this.cancelLatch = false;
      held &= ~SHOT_BITS;
    }
    let btn = held | this.latch;
    this.latch = 0;
    if (cancelling) { btn &= ~SHOT_BITS; btn |= BTN.CANCEL; }

    if (btn & BTN.THROW) { if (!(this.lastBits & BTN.THROW)) this.chargeSince = now; } else this.chargeSince = 0;
    // The camera starts easing home the moment a shot ends, and rAF outruns the fixed step, so
    // without this the release frame reads its target through a camera that has already moved.
    if ((this.lastBits & SHOT_BITS) && !(btn & SHOT_BITS)) this.aimHoldUntil = now + HOLD_ACROSS_STEPS_MS;
    this.lastBits = btn;

    this.updateAim(view, mx, my, btn, now);
    if (this.paint) this.stepPaint(view, now);
    return { mx, my, aim: this.aim, btn, tx: this.tx, ty: this.ty };
  }

  uiState(view) {
    const ui = this.uiObject;
    const me = view?.me ?? null;
    const you = view?.you ?? null;
    ui.tool = this._tool;
    ui.reduceMotion = this.reduceMotion;
    ui.buildRange = KID.buildRange * (you?.mods?.buildRangeMul ?? 1);
    ui.aimX = this.tx;
    ui.aimY = this.ty;
    ui.lobbing = (this.lastBits & BTN.LOB) !== 0;
    ui.charge = this.chargeFraction(view);
    ui.sticks = this.stickState();
    ui.toolCell = null;
    ui.toolState = null;
    ui.toolValid = false;
    if (this._tool !== null && me && view.cw) {
      const target = this.toolTarget(view);
      if (target) {
        ui.toolCell = { cx: target.cx, cy: target.cy };
        ui.toolState = this.judge(view, this._tool, target);
        ui.toolValid = VALID_STATES.has(ui.toolState);
      }
    }
    return ui;
  }

  // ---- internals: state helpers -----------------------------------------------

  active() { return this.enabled && this.inMatch; }

  setMode(m) {
    if (m === this._mode) return;
    this._mode = m;
    this.emit('mode', m);
  }

  heldBits() {
    let bits = 0;
    if (this.lmb === 'throw') bits |= BTN.THROW;
    if (this.rmb === 'lob' || this.keys.has('KeyQ')) bits |= BTN.LOB;
    if (this.keys.has('Space') || this.slideBtn) bits |= BTN.SLIDE;
    if (this.aimStick) bits |= this.aimStick.lob ? BTN.LOB : BTN.THROW;
    if (this.pad.rt) bits |= BTN.THROW;
    if (this.pad.lt) bits |= BTN.LOB;
    if (this.pad.a && !this.shoutOpen) bits |= BTN.SLIDE;
    return bits;
  }

  isCharging() { return !this.cancelLatch && (this.heldBits() & SHOT_BITS) !== 0; }

  cancelCharge() {
    this.cancelLatch = true;
    this.cancelUntil = performance.now() + HOLD_ACROSS_STEPS_MS;
    this.latch &= ~SHOT_BITS;
    this.chargeSince = 0;
  }

  endScores() {
    if (!this.scoresHeld) return;
    this.scoresHeld = false;
    this.emit('scoreboard', false);
  }

  chargeFraction(view) {
    if (!this.chargeSince) return 0;
    const me = view?.me;
    if (!me || (me.flags & (AFLAG.FROZEN | AFLAG.LOCKED))) return 0;
    if ((view.you?.balls ?? 0) < 1) return 0;
    // Throws are ignored during BUILD outside Siege (SPEC 2.2, 2.3), so no charge should show.
    if (view.phase === PHASE.BUILD && view.mode !== MODE.SIEGE) return 0;
    return Math.min(1, (performance.now() - this.chargeSince) / 1000 / THROW.chargeTime);
  }

  moveVector() {
    const held = (list) => list.some((code) => this.keys.has(code));
    let mx = (held(MOVE_KEYS.right) ? 1 : 0) - (held(MOVE_KEYS.left) ? 1 : 0);
    let my = (held(MOVE_KEYS.down) ? 1 : 0) - (held(MOVE_KEYS.up) ? 1 : 0);
    if (this.moveStick) { mx += this.moveStick.vx; my += this.moveStick.vy; }
    mx += this.pad.mx;
    my += this.pad.my;
    const len = Math.hypot(mx, my);
    if (len > 1) { mx /= len; my /= len; }
    return [mx, my];
  }

  updateAim(view, mx, my, btn, now) {
    const me = view?.me ?? null;
    if (now < this.aimHoldUntil) return;
    if (this._mode === 'kbm') {
      const w = this.renderer.screenToWorld(this.cursor.px, this.cursor.py);
      this.tx = w.x;
      this.ty = w.y;
      if (me) this.aim = Math.atan2(this.ty - me.y, this.tx - me.x);
      return;
    }
    const pad = this._mode === 'pad' ? this.pad : null;
    const stick = this.aimStick;
    if (pad && pad.am > 0) {
      this.aim = Math.atan2(pad.ay, pad.ax);
      this.aimReach = pad.am;
    } else if (stick && stick.outside) {
      this.aim = Math.atan2(stick.dy, stick.dx);
      this.aimReach = stick.m;
    } else if (!stick && (mx !== 0 || my !== 0)) {
      this.aim = Math.atan2(my, mx);
      this.aimReach = 0;
    } else if (!stick) {
      this.aimReach = 0;
    }
    if (me) {
      const reach = (btn & BTN.LOB)
        ? LOB_MIN + this.aimReach * (THROW.lob.maxRange - LOB_MIN)
        : IDLE_AIM_REACH;
      this.tx = me.x + Math.cos(this.aim) * reach;
      this.ty = me.y + Math.sin(this.aim) * reach;
    }
  }

  // ---- internals: build tools -----------------------------------------------------

  query(view) {
    const { me, you, meta } = view;
    const team = me.team;
    return {
      structs: view.structs,
      actors: view.actors,
      flakes: meta?.flakes?.[team] ?? 0,
      team,
      x: me.x,
      y: me.y,
      range: KID.buildRange * (you?.mods?.buildRangeMul ?? 1),
      phase: view.phase,
      mode: view.mode,
      pultLimit: meta?.pultLimit?.[team] ?? 0,
      spendLeft: you?.spendLeft ?? 65535,
      patchesLeft: meta?.patchesLeft ?? 0,
      playersPresent: (id) => !!view.players?.get(id)?.connected,
    };
  }

  judge(view, tool, target) {
    const q = this.query(view);
    if (tool === 'demolish') {
      if (!target.struct) return 'badCell';
      const verdict = demolishState(q, target.struct, view.me.id);
      return verdict === 'ok' ? 'demolish' : verdict;
    }
    return canPlace(view.cw, q, tool, target.cx, target.cy);
  }

  structAtCell(view, cx, cy) {
    for (const s of view.structs ?? []) {
      const size = BUILD[s.kind]?.size ?? 1;
      if (cx >= s.cx && cx < s.cx + size && cy >= s.cy && cy < s.cy + size) return s;
    }
    return null;
  }

  // A tall wall's art covers the cell behind it, so what the player points at is the drawn struct,
  // not the ground beneath the cursor (SPEC 11.1).
  targetAtScreen(view, tool, px, py) {
    const picked = this.renderer.pickStruct(px, py, view) ?? null;
    if (picked && this.pickedCounts(view, tool, picked)) return { cx: picked.cx, cy: picked.cy, struct: picked };
    const w = this.renderer.screenToWorld(px, py);
    const cx = Math.floor(w.x / CELL);
    const cy = Math.floor(w.y / CELL);
    return { cx, cy, struct: this.structAtCell(view, cx, cy) };
  }

  pickedCounts(view, tool, s) {
    // The Colonel can't be demolished, so his sprite must not hide what stands behind him.
    if (tool === 'demolish') return s.kind !== STRUCT.COLONEL;
    if (s.team !== view.me?.team) return false;
    if (s.kind === tool && s.hp < s.maxHp) return true;
    // Only a Colonel who can be patched claims the click. His sprite stands over the cells
    // behind him, and a wall aimed at those must reach the ground.
    return tool === STRUCT.WALL && s.kind === STRUCT.COLONEL && s.hp < s.maxHp
      && view.phase === PHASE.BUILD && (view.meta?.patchesLeft ?? 0) > 0;
  }

  toolTarget(view) {
    const tool = this._tool;
    if (this._mode === 'kbm') return this.targetAtScreen(view, tool, this.cursor.px, this.cursor.py);
    if (this._mode === 'touch') {
      const p = this.buildPointer;
      return p ? this.targetAtScreen(view, tool, p.px, p.py) : null;
    }
    const me = view.me;
    const range = KID.buildRange * (view.you?.mods?.buildRangeMul ?? 1);
    // Range is measured to a cell's centre, which can lie half a diagonal past the point aimed at,
    // so full tilt stops that much short. Otherwise most directions answer "Too far away".
    const reach = 2 * CELL + this.aimReach * (range - 2 * CELL - PAD_CELL_SLACK);
    const cx = Math.floor((me.x + Math.cos(this.aim) * reach) / CELL);
    const cy = Math.floor((me.y + Math.sin(this.aim) * reach) / CELL);
    return { cx, cy, struct: this.structAtCell(view, cx, cy) };
  }

  // One attempt to use the tool on a target. Refusals are reported so the HUD can explain them
  // without a round trip to the host.
  useTool(view, target, now) {
    const tool = this._tool;
    const state = this.judge(view, tool, target);
    if (!VALID_STATES.has(state)) {
      this.emit('denied', state);
      return false;
    }
    this.lastBuildAt = now;
    if (tool === 'demolish') this.emit('demolish', { cx: target.cx, cy: target.cy });
    else this.emit('build', { k: tool, cx: target.cx, cy: target.cy });
    return true;
  }

  startPaint(from, placed) {
    if (!PAINT_TOOLS.has(this._tool)) return;
    this.paint = { last: { cx: from.cx, cy: from.cy }, queue: [], placedLast: placed, released: false };
  }

  // Cells crossed between two frames are queued, so a fast drag leaves a solid line instead of
  // gaps, and the queue drains no faster than KID.buildCooldown allows, even after the release.
  stepPaint(view, now) {
    const p = this.paint;
    if (!view?.me || !view.cw) return;
    const target = p.released ? null : this.toolTarget(view);
    if (target && (target.cx !== p.last.cx || target.cy !== p.last.cy)) {
      if (!p.placedLast) p.queue.push({ ...p.last });
      const steps = Math.max(Math.abs(target.cx - p.last.cx), Math.abs(target.cy - p.last.cy));
      // A touch drag places a cell as the finger leaves it, so the one under the finger waits.
      const lastStep = this._mode === 'touch' ? steps - 1 : steps;
      for (let i = 1; i <= lastStep; i += 1) {
        p.queue.push({
          cx: Math.round(p.last.cx + ((target.cx - p.last.cx) * i) / steps),
          cy: Math.round(p.last.cy + ((target.cy - p.last.cy) * i) / steps),
        });
      }
      p.placedLast = this._mode !== 'touch';
      p.last = { cx: target.cx, cy: target.cy };
    }
    while (p.queue.length && now - this.lastBuildAt >= KID.buildCooldown * 1000) {
      const cell = p.queue.shift();
      const struct = this.structAtCell(view, cell.cx, cell.cy);
      const state = this.judge(view, this._tool, { ...cell, struct });
      // A patch spends 8 Flakes on the Colonel, too costly to happen by dragging across him.
      if (state === 'ok' || state === 'repair') {
        this.lastBuildAt = now;
        this.emit('build', { k: this._tool, cx: cell.cx, cy: cell.cy });
      } else if (cell.final) {
        this.emit('denied', state);
      }
    }
    if (p.released && !p.queue.length) this.paint = null;
  }

  demolishUnderCursor() {
    const view = this.view;
    if (!view?.me) return;
    const target = this.targetAtScreen(view, 'demolish', this.cursor.px, this.cursor.py);
    const verdict = this.judge(view, 'demolish', target);
    if (verdict === 'demolish') this.emit('demolish', { cx: target.cx, cy: target.cy });
    else this.emit('denied', verdict);
  }

  cycleTool(dir) {
    const at = TOOLS.indexOf(this._tool);
    const next = at < 0 ? (dir > 0 ? 0 : TOOLS.length - 1) : (at + dir + TOOLS.length) % TOOLS.length;
    this.setTool(TOOLS[next]);
  }

  // ---- internals: keyboard --------------------------------------------------------

  onKeyDown(e) {
    if (!this.active()) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.isComposing || e.keyCode === 229) return;
    if (e.target && TEXT_TARGETS.has(e.target.tagName)) return;

    const code = e.code;
    if (GAME_KEYS.has(code)) e.preventDefault();
    if (code === 'Tab') {
      this.setMode('kbm');
      if (!e.repeat && !this.scoresHeld) { this.scoresHeld = true; this.emit('scoreboard', true); }
      return;
    }
    if (e.repeat) {
      // Auto-repeat keeps a held direction alive after a dialog closes, but must not fire actions.
      if (Object.values(MOVE_KEYS).flat().includes(code)) this.keys.add(code);
      return;
    }
    if (code === 'Escape') { this.onEscape(); return; }

    const digit = /^(?:Digit|Numpad)([1-9])$/.exec(code)?.[1];
    if (digit) {
      this.setMode('kbm');
      if (this.shoutOpen) {
        const n = Number(digit) - 1;
        if (n < EMOTES.length) { this.emit('emote', n); this.setShout(false); }
      } else if (TOOL_BY_DIGIT.has(digit)) {
        const k = TOOL_BY_DIGIT.get(digit);
        this.setTool(this._tool === k ? null : k);
      }
      return;
    }

    switch (code) {
      case 'KeyX': this.setMode('kbm'); this.demolishUnderCursor(); return;
      case 'KeyR': this.setMode('kbm'); this.emit('ready'); return;
      case 'KeyV': this.setMode('kbm'); this.setShout(!this.shoutOpen); return;
      case 'KeyM': this.emit('mute'); return;
      case 'Enter': this.emit('chatOpen'); return;
      case 'KeyQ': this.setMode('kbm'); this.keys.add(code); this.latch |= BTN.LOB; return;
      case 'Space': this.setMode('kbm'); this.keys.add(code); this.latch |= BTN.SLIDE; return;
      default:
        if (Object.values(MOVE_KEYS).flat().includes(code)) { this.setMode('kbm'); this.keys.add(code); }
    }
  }

  onEscape() {
    if (this.shoutOpen) this.setShout(false);
    else if (this.isCharging()) this.cancelCharge();
    else if (this._tool !== null) this.setTool(null);
    else this.emit('menu');
  }

  // Releases skip every guard keydown has. A key let go while Ctrl is down, or while Input is
  // disabled, must still come up, or the kid walks forever.
  onKeyUp(e) {
    this.keys.delete(e.code);
    if (e.code === 'Tab') this.endScores();
    // macOS sends no keyup for other keys while Cmd is down, so anything held through it is unknowable.
    if (e.code === 'MetaLeft' || e.code === 'MetaRight') this.keys.clear();
  }

  // ---- internals: pointers ----------------------------------------------------------

  localPoint(e) { return { px: e.clientX - this.rect.left, py: e.clientY - this.rect.top }; }

  onAnyPointerDown(e) {
    this.setMode(e.pointerType === 'mouse' ? 'kbm' : 'touch');
  }

  onCanvasPointerDown(e) {
    if (!this.active()) return;
    try { this.canvas.setPointerCapture(e.pointerId); } catch { /* the pointer already ended */ }
    if (e.pointerType === 'mouse') {
      const p = this.localPoint(e);
      this.cursor.px = p.px;
      this.cursor.py = p.py;
      this.mouseId = e.pointerId;
      this.mousePress(this.mouseButton(e));
    } else {
      this.touchDown(e);
    }
  }

  // Control-click is how a Mac trackpad right-clicks, and it reaches us as the left button.
  mouseButton(e) { return e.button === 0 && e.ctrlKey && IS_MAC ? 2 : e.button; }

  mousePress(button) {
    if (button === 0) {
      if (this._tool !== null) {
        this.lmb = 'build';
        this.mouseBuild();
      } else {
        this.lmb = 'throw';
        this.latch |= BTN.THROW;
      }
    } else if (button === 2) {
      if (this._tool !== null) {
        this.rmb = 'dropped';
        this.setTool(null);
      } else {
        this.rmb = 'lob';
        this.latch |= BTN.LOB;
      }
    }
  }

  mouseBuild() {
    const view = this.view;
    if (!view?.me || !view.cw) return;
    const target = this.toolTarget(view);
    if (!target) return;
    this.useTool(view, target, performance.now());
    this.startPaint(target, true);
  }

  mouseRelease(button) {
    if (button === 0) {
      if (this.lmb === 'build' && this.paint) this.paint.released = true;
      this.lmb = null;
    } else if (button === 2) {
      this.rmb = null;
    }
  }

  onPointerMove(e) {
    if (e.pointerType === 'mouse') {
      const p = this.localPoint(e);
      this.cursor.px = p.px;
      this.cursor.py = p.py;
      if (e.movementX || e.movementY) this.setMode('kbm');
      // A second mouse button pressed during a drag arrives as a pointermove, not a pointerdown.
      if (this.active() && e.button >= 0 && e.pointerId === this.mouseId) {
        const bit = MOUSE_BUTTON_BIT[e.button];
        if (bit && (e.buttons & bit)) this.mousePress(e.button);
        else if (bit) this.mouseRelease(e.button);
      }
      return;
    }
    this.touchMove(e);
  }

  onPointerUp(e) {
    if (e.pointerType === 'mouse') {
      if (e.pointerId !== this.mouseId) return;
      // pointerup means no button is left down. Releasing both also covers a Mac control-click
      // whose Control key came up first, which would otherwise map to the wrong button here.
      this.mouseRelease(0);
      this.mouseRelease(2);
      this.mouseId = null;
      return;
    }
    this.touchUp(e);
  }

  onPointerCancel(e) {
    if (e.pointerType === 'mouse') { if (e.pointerId === this.mouseId) this.clearHeld(); return; }
    this.resetTouch(e.pointerId);
  }

  // A normal release also ends capture, so this only means "stolen" if we still think it is down.
  onLostCapture(e) {
    if (e.pointerType === 'mouse') {
      if (e.pointerId === this.mouseId) this.clearHeld();
      return;
    }
    this.resetTouch(e.pointerId);
  }

  // ---- internals: touch -------------------------------------------------------------

  measure() {
    const r = this.canvas.getBoundingClientRect();
    this.rect = { left: r.left, top: r.top, width: r.width, height: r.height };
    this.readSafeArea();
  }

  readSafeArea() {
    if (!this.safeProbe) {
      const probe = document.createElement('div');
      probe.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;visibility:hidden;pointer-events:none;'
        + 'padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)';
      document.body.append(probe);
      this.safeProbe = probe;
    }
    const css = getComputedStyle(this.safeProbe);
    this.safe = {
      top: parseFloat(css.paddingTop) || 0,
      right: parseFloat(css.paddingRight) || 0,
      bottom: parseFloat(css.paddingBottom) || 0,
      left: parseFloat(css.paddingLeft) || 0,
    };
  }

  restPosition(side) {
    const { width: W, height: H } = this.rect;
    const inset = EDGE_MARGIN + STICK_R;
    return {
      x: side === 'left' ? this.safe.left + inset : W - this.safe.right - inset,
      y: H - this.safe.bottom - inset,
    };
  }

  clampBase(px, py) {
    const { width: W, height: H } = this.rect;
    const inset = EDGE_MARGIN + STICK_R;
    return {
      x: Math.max(this.safe.left + inset, Math.min(W - this.safe.right - inset, px)),
      y: Math.max(this.safe.top + inset, Math.min(H - this.safe.bottom - inset, py)),
    };
  }

  touchDown(e) {
    const { px, py } = this.localPoint(e);
    const { width: W, height: H } = this.rect;
    if (this._tool !== null) {
      const rest = this.restPosition('left');
      if (!this.moveStick && Math.hypot(px - rest.x, py - rest.y) <= STICK_R) {
        this.moveStick = this.newStick(e.pointerId, rest, px, py);
      } else if (!this.buildPointer) {
        this.buildPointer = { id: e.pointerId, px, py };
        const view = this.view;
        if (view?.me && view.cw) {
          const target = this.toolTarget(view);
          // A press on a hurt Colonel is a patch, which painting never places: release uses the tool.
          if (target && this.judge(view, this._tool, target) !== 'patch') this.startPaint(target, false);
        }
      }
      return;
    }
    if (py <= 0.3 * H) return;
    if (px < 0.4 * W) {
      if (this.moveStick) return;
      this.moveStick = this.newStick(e.pointerId, this.clampBase(px, py), px, py);
    } else if (px > 0.6 * W) {
      if (this.aimStick) return;
      const stick = this.newStick(e.pointerId, this.clampBase(px, py), px, py);
      stick.lob = this.lobArmed;
      stick.everLeft = false;
      stick.outside = false;
      stick.t0 = performance.now();
      this.aimStick = stick;
      this.latch |= stick.lob ? BTN.LOB : BTN.THROW;
    }
  }

  // The vector is measured from the press point, not the base. The base can be pushed inward from
  // the screen edge, and a thumb landing near the edge must still start neutral.
  newStick(id, base, px, py) {
    return { id, x: base.x, y: base.y, sx: px, sy: py, kx: base.x, ky: base.y, vx: 0, vy: 0, dx: 0, dy: 0, m: 0 };
  }

  dragStick(stick, px, py) {
    const dx = px - stick.sx;
    const dy = py - stick.sy;
    const len = Math.hypot(dx, dy);
    const reach = Math.min(len, STICK_R);
    const ux = len > 0 ? dx / len : 0;
    const uy = len > 0 ? dy / len : 0;
    stick.kx = stick.x + ux * reach;
    stick.ky = stick.y + uy * reach;
    const mag = reach / STICK_R;
    if (mag < DEADZONE) {
      stick.vx = 0;
      stick.vy = 0;
      if ('outside' in stick) stick.outside = false;
      return;
    }
    const m = (mag - DEADZONE) / (1 - DEADZONE);
    stick.vx = ux * m;
    stick.vy = uy * m;
    if ('outside' in stick) {
      stick.outside = true;
      stick.everLeft = true;
      stick.dx = ux;
      stick.dy = uy;
      stick.m = m;
    }
  }

  touchMove(e) {
    const { px, py } = this.localPoint(e);
    if (this.moveStick?.id === e.pointerId) this.dragStick(this.moveStick, px, py);
    else if (this.aimStick?.id === e.pointerId) this.dragStick(this.aimStick, px, py);
    else if (this.buildPointer?.id === e.pointerId) { this.buildPointer.px = px; this.buildPointer.py = py; }
  }

  touchUp(e) {
    if (this.moveStick?.id === e.pointerId) { this.moveStick = null; return; }
    if (this.aimStick?.id === e.pointerId) { this.releaseAimStick(); return; }
    if (this.buildPointer?.id === e.pointerId) this.releaseBuildPointer(e);
  }

  releaseAimStick() {
    const stick = this.aimStick;
    this.aimStick = null;
    const now = performance.now();
    if (!stick.everLeft && now - stick.t0 < TAP_MS) {
      this.aimAtNearestEnemy();
    } else if (stick.everLeft && !stick.outside) {
      this.cancelCharge();
      return;
    }
    // The throw leaves on the step where the bit falls, which can be a frame or two from now.
    // Idle aim would swing to the move direction in that gap, so the release aim is held.
    this.aimHoldUntil = now + HOLD_ACROSS_STEPS_MS;
  }

  aimAtNearestEnemy() {
    const view = this.view;
    const me = view?.me;
    if (!me) return;
    const { width: W, height: H } = this.rect;
    let best = null;
    let bestDist = TAP_RANGE;
    for (const a of view.actors ?? []) {
      if (a.team === me.team || (a.flags & (AFLAG.FLEEING | AFLAG.FROZEN | AFLAG.GRACE))) continue;
      const dist = Math.hypot(a.x - me.x, a.y - me.y);
      if (dist > bestDist) continue;
      const s = this.renderer.worldToScreen(a.x, a.y);
      if (s.x < 0 || s.y < 0 || s.x > W || s.y > H) continue;
      best = a;
      bestDist = dist;
    }
    if (!best) return;
    this.aim = Math.atan2(best.y - me.y, best.x - me.x);
    this.tx = best.x;
    this.ty = best.y;
  }

  releaseBuildPointer(e) {
    const p = this.buildPointer;
    const { px, py } = this.localPoint(e);
    p.px = px;
    p.py = py;
    const view = this.view;
    const target = view?.me && view.cw ? this.toolTarget(view) : null;
    if (this.paint) {
      if (target) this.paint.queue.push({ cx: target.cx, cy: target.cy, final: true });
      this.paint.released = true;
    } else if (target) {
      this.useTool(view, target, performance.now());
    }
    this.buildPointer = null;
  }

  resetTouch(id) {
    if (this.moveStick?.id === id) this.moveStick = null;
    else if (this.aimStick?.id === id) {
      this.aimStick = null;
      this.cancelCharge();
    } else if (this.buildPointer?.id === id) {
      this.buildPointer = null;
      this.paint = null;
    }
  }

  stickState() {
    if (this._mode !== 'touch' || !this.inMatch) return [];
    const list = [];
    const move = this.moveStick;
    const restL = this.restPosition('left');
    list.push(move
      ? { x: move.x, y: move.y, kx: move.kx, ky: move.ky, r: STICK_R, kind: 'move', active: true }
      : { x: restL.x, y: restL.y, kx: restL.x, ky: restL.y, r: STICK_R, kind: 'move', active: false });
    if (this._tool === null) {
      const aim = this.aimStick;
      const kind = this.lobArmed ? 'lob' : 'aim';
      const restR = this.restPosition('right');
      list.push(aim
        ? { x: aim.x, y: aim.y, kx: aim.kx, ky: aim.ky, r: STICK_R, kind, active: true }
        : { x: restR.x, y: restR.y, kx: restR.x, ky: restR.y, r: STICK_R, kind, active: false });
    }
    return list;
  }

  // ---- internals: gamepad -------------------------------------------------------------

  // Radial, so a diagonal is as easy to reach as a cardinal direction.
  radial(x, y) {
    const len = Math.hypot(x, y);
    if (len < DEADZONE) return { x: 0, y: 0, m: 0 };
    const clamped = Math.min(1, len);
    const m = (clamped - DEADZONE) / (1 - DEADZONE);
    return { x: (x / len) * m, y: (y / len) * m, m };
  }

  pollPad(now) {
    const pad = this.pad;
    const list = globalThis.navigator?.getGamepads?.() ?? [];
    let gp = null;
    for (const candidate of list) {
      if (candidate?.connected && candidate.mapping === 'standard') { gp = candidate; break; }
    }
    if (!gp) {
      if (pad.connected) {
        if (pad.rt || pad.lt) this.cancelCharge();
        Object.assign(pad, { connected: false, mx: 0, my: 0, ax: 0, ay: 0, am: 0, prev: [], rt: false, lt: false, a: false });
        this.endScores();
      }
      return;
    }
    pad.connected = true;
    const cur = gp.buttons.map((b) => b.pressed || b.value > PAD_TRIGGER);
    const edge = (i) => cur[i] && !pad.prev[i];
    const left = this.radial(gp.axes[0] ?? 0, gp.axes[1] ?? 0);
    const right = this.radial(gp.axes[2] ?? 0, gp.axes[3] ?? 0);

    const used = cur.some(Boolean) || Math.hypot(gp.axes[0] ?? 0, gp.axes[1] ?? 0) > PAD_MODE_SWITCH
      || Math.hypot(gp.axes[2] ?? 0, gp.axes[3] ?? 0) > PAD_MODE_SWITCH;
    if (used && this.inMatch) this.setMode('pad');

    if (this.active()) {
      pad.mx = left.x;
      pad.my = left.y;
      pad.am = right.m;
      if (right.m > 0) { pad.ax = right.x; pad.ay = right.y; }
      pad.rt = !!cur[PAD.RT];
      pad.lt = !!cur[PAD.LT];
      // A press that sent a shout is spent: still held, it must not turn into a belly slide.
      if (!cur[PAD.A]) pad.aSpent = false;
      pad.a = !!cur[PAD.A] && !pad.aSpent;
      if (edge(PAD.RT)) this.latch |= BTN.THROW;
      if (edge(PAD.LT)) this.latch |= BTN.LOB;
      this.padActions(cur, edge, now);
    } else {
      Object.assign(pad, { mx: 0, my: 0, am: 0, rt: false, lt: false, a: false });
      if (this.inMatch) this.padNavigate(edge);
    }
    pad.prev = cur;
  }

  padActions(cur, edge, now) {
    if (edge(PAD.START)) this.emit('menu');
    if (edge(PAD.Y)) this.emit('ready');
    if (edge(PAD.VIEW)) { this.scoresHeld = true; this.emit('scoreboard', true); }
    if (!cur[PAD.VIEW] && this.pad.prev[PAD.VIEW]) this.endScores();
    if (edge(PAD.LB)) this.cycleTool(-1);
    if (edge(PAD.RB)) this.cycleTool(1);

    if (this.shoutOpen) {
      if (edge(PAD.UP)) this.moveShout(-1);
      if (edge(PAD.DOWN)) this.moveShout(1);
      if (edge(PAD.A)) {
        this.emit('emote', this.shoutIndex);
        this.setShout(false);
        this.pad.aSpent = true;
        this.pad.a = false;
      }
      if (edge(PAD.B)) this.setShout(false);
    } else {
      if (edge(PAD.DOWN)) this.setShout(true);
      if (edge(PAD.LEFT)) this.emit('card', 0);
      if (edge(PAD.UP)) this.emit('card', 1);
      if (edge(PAD.RIGHT)) this.emit('card', 2);
      if (edge(PAD.B)) {
        if (this.isCharging()) this.cancelCharge();
        else this.setTool(null);
      }
    }

    if (edge(PAD.X) && this._tool !== null) {
      const view = this.view;
      if (view?.me && view.cw) {
        const target = this.toolTarget(view);
        if (target) {
          const placed = this.useTool(view, target, now);
          this.startPaint(target, placed);
        }
      }
    }
    if (!cur[PAD.X] && this.pad.prev[PAD.X]) this.paint = null;
  }

  moveShout(dir) {
    this.shoutIndex = (this.shoutIndex + dir + EMOTES.length) % EMOTES.length;
    this.emit('shoutSelect', this.shoutIndex);
  }

  // A pad player opens the Menu with Start, so they need a way through it and out again.
  padNavigate(edge) {
    if (edge(PAD.START)) this.emit('menu');
    if (edge(PAD.UP)) this.emit('nav', 'up');
    if (edge(PAD.DOWN)) this.emit('nav', 'down');
    if (edge(PAD.LEFT)) this.emit('nav', 'left');
    if (edge(PAD.RIGHT)) this.emit('nav', 'right');
    if (edge(PAD.A)) this.emit('nav', 'ok');
    if (edge(PAD.B)) this.emit('nav', 'back');
  }

  // ---- wiring -----------------------------------------------------------------------

  bind() {
    const { canvas } = this;
    window.addEventListener('keydown', (e) => this.onKeyDown(e));
    window.addEventListener('keyup', (e) => this.onKeyUp(e));
    window.addEventListener('blur', () => this.clearHeld());
    window.addEventListener('pagehide', () => this.clearHeld());
    document.addEventListener('visibilitychange', () => this.clearHeld());
    window.addEventListener('pointerdown', (e) => this.onAnyPointerDown(e), true);
    canvas.addEventListener('pointerdown', (e) => this.onCanvasPointerDown(e));
    window.addEventListener('pointermove', (e) => this.onPointerMove(e));
    window.addEventListener('pointerup', (e) => this.onPointerUp(e));
    window.addEventListener('pointercancel', (e) => this.onPointerCancel(e));
    canvas.addEventListener('lostpointercapture', (e) => this.onLostCapture(e));
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    new ResizeObserver(() => this.measure()).observe(canvas);
    window.addEventListener('resize', () => this.measure());
    this.measure();
  }
}
