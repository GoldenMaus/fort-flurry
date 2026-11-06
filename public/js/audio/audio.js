// Fort Flurry — the audio engine. Synthesis only: there is not one sound file in the
// game. See SPEC 11.0 and 13. `new AudioEngine()` touches nothing, because browsers
// only let audio start from a user gesture; the graph is built on the first unlock().

import { ACTOR, AFLAG, AUX, MODE, PHASE } from '../../shared/schema.js';
import { Conductor, TICK_MS } from './conductor.js';
import { DEFAULT_VOLUMES, createMixer } from './mixer.js';
import { FxRouter } from './routing.js';
import { SOUNDS, jitter, releaseVoice, silenceVoice, startVoice } from './sfx.js';
import { TRACKS } from './tracks.js';

// The caps from SPEC 11.0. The first stops one busy sound machine-gunning, the second
// bounds the graph on a phone in the middle of an eight-player fight.
export const MAX_VOICES = 24;
export const MAX_STARTS = 4;
export const START_WINDOW = 0.1;

// A hair of lead time so each envelope's first automation point is safely in the future.
const START_DELAY = 0.004;
const RESTART_DELAY = 0.1;

const GESTURES = ['pointerup', 'touchend', 'click', 'keydown'];

// World units. Full volume out to NEAR, so anything around your kid is simply loud,
// then a falloff gentler than physics: the far side of the map should stay faintly
// audible, because hearing a distant fight is useful.
const NEAR = 170;
const ROLLOFF = 1.25;
const PAN_SPAN = 620;
const PAN_MAX = 0.85;
const INAUDIBLE = 0.07;

const UI_SOUNDS = { click: 'uiClick', hover: 'uiHover', join: 'uiJoin', deny: 'uiDeny' };
const DENY_GAP = 0.12;

// Foes left in the wave at which the fight's band grows by one level.
const FIGHT_LEVELS = [3, 10, 20];

const STRIDE = 74;
const STEER_GAP = 0.1;
const WIND_LEVEL = 0.16;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** Pan, level, tone and reverb for a sound offset (dx, dy) from the ear. */
export function spatialize(dx, dy) {
  const dist = Math.hypot(dx, dy);
  const fall = dist <= NEAR ? 1 : (NEAR / dist) ** ROLLOFF;
  return {
    fall,
    pan: clamp(dx / PAN_SPAN, -1, 1) * PAN_MAX,
    // Distance takes the top off a sound before it takes the sound away.
    muffle: dist > 320 ? clamp(9000 * (320 / dist) ** 1.5, 700, 9000) : 0,
    wet: clamp(0.04 + dist / 2800, 0.04, 0.42),
  };
}

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.mix = null;
    this.conductor = null;
    this.router = null;

    this._wanted = null;
    this._volumes = { ...DEFAULT_VOLUMES };
    this._hidden = false;
    this._timer = null;
    this._armed = false;
    this._voices = [];
    this._dying = [];
    this._starts = new Map();
    this._denyAt = -Infinity;
    this._ear = null;
    this._wind = null;
    this._counts = { started: 0, rateDropped: 0, capDropped: 0, stolen: 0, peakVoices: 0 };

    this._seenView = null;
    this._phase = null;
    this._secondsShown = null;
    this._ballsHeld = null;
    this._stride = 0;
    this._updateAt = 0;
    this._steerAt = -Infinity;
    this._pounding = false;

    this._onGesture = () => {
      this.unlock();
      if (this.ctx?.state === 'running') this._disarm();
    };
    this._onState = () => {
      const { state } = this.ctx;
      if (state === 'running') this._disarm();
      else if (state !== 'closed' && !this._hidden) this._arm();
    };
  }

  /** Audio clock in seconds, for anything that needs "how long since". */
  get now() {
    return this.ctx ? this.ctx.currentTime : 0;
  }

  get state() {
    return this.ctx ? this.ctx.state : 'locked';
  }

  /** Read-only figures for the soundboard and tests. */
  get stats() {
    return {
      ...this._counts,
      live: this._voices.length,
      dying: this._dying.length,
      track: this.conductor?.current ?? null,
      level: this.conductor?.level ?? 0,
      music: this.conductor ? { ...this.conductor.stats, next: this.conductor.nextNoteTime } : null,
      scheduling: this._timer !== null,
      armed: this._armed,
    };
  }

  unlock() {
    if (!this.ctx) {
      const Context = globalThis.AudioContext ?? globalThis.webkitAudioContext;
      // No Web Audio means a silent game, never a broken one.
      if (!Context) return;
      this.ctx = new Context({ latencyHint: 'interactive' });
      this._boot();
    }
    if (this._hidden) {
      this.ctx.suspend?.().catch(() => {});
      return;
    }
    this._resume();
  }

  _resume() {
    this.ctx.resume?.().catch(() => {});
  }

  _boot() {
    const { ctx } = this;
    this.mix = createMixer(ctx, this._volumes);
    this.conductor = new Conductor(this.mix);
    this.router = new FxRouter(this);
    ctx.addEventListener('statechange', this._onState);

    // iOS only opens the audio path once something has actually played inside the
    // gesture, and one silent sample is enough to count.
    const silence = ctx.createBufferSource();
    silence.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
    silence.connect(ctx.destination);
    silence.start();

    if (!this._hidden) this._begin();
  }

  _begin() {
    this._applyMusic();
    if (this._timer === null) this._timer = setInterval(() => this._tick(), TICK_MS);
    this._tick();
  }

  _tick() {
    const now = this.ctx.currentTime;
    this.conductor.pump(now);
    this._sweep(now);
    this._windTick(now);
  }

  // ---- Gesture listeners --------------------------------------------------------
  // main.js owns the first unlock. These are for the audio dropping out afterward, such
  // as an iOS call or a return from the background, when only a fresh gesture will do.

  _arm() {
    if (this._armed || !globalThis.addEventListener) return;
    this._armed = true;
    for (const type of GESTURES) globalThis.addEventListener(type, this._onGesture, { capture: true, passive: true });
  }

  _disarm() {
    if (!this._armed) return;
    this._armed = false;
    for (const type of GESTURES) globalThis.removeEventListener(type, this._onGesture, { capture: true });
  }

  // ---- Music --------------------------------------------------------------------

  setMusic(name) {
    if (name !== null && !Object.hasOwn(TRACKS, name)) return;
    this._wanted = name;
    if (this.ctx && !this._hidden) this._applyMusic();
  }

  _applyMusic() {
    const { conductor, ctx } = this;
    const want = this._wanted;
    if (want === conductor.current) return;
    const at = ctx.currentTime + RESTART_DELAY;
    // A boss wave's fight begins a couple of seconds before the boss arrives, and until
    // then this is asked for the ordinary fight music. Starting it would mean a blip of
    // swing cut off by the theme, so the music drops out under the horn instead, and the
    // boss enters into the silence.
    if (want === null || (want === 'fight' && this._awaitingBoss())) {
      conductor.stop(at, 0.8);
      return;
    }
    // A stinger is an event and has to land on the moment. Everything else eases in.
    const stinger = !TRACKS[want].loop;
    conductor.play(want, at, stinger ? 0.25 : 0.6);
    conductor.pump(ctx.currentTime);
  }

  _awaitingBoss() {
    const view = this._seenView;
    return !!view && this._isBossWave(view) && !view.meta?.boss;
  }

  setVolumes(volumes) {
    // Kept even before unlock, or the saved volume would be lost and the very first
    // sound would ignore a player who had turned the game down.
    for (const key of Object.keys(this._volumes)) {
      const value = volumes?.[key];
      if (Number.isFinite(value)) this._volumes[key] = clamp(value, 0, 1);
    }
    this.mix?.setVolumes(this._volumes);
  }

  // ---- Voices -------------------------------------------------------------------

  _sweep(now) {
    const voices = this._voices;
    for (let i = voices.length - 1; i >= 0; i--) {
      if (voices[i].end <= now) {
        releaseVoice(voices[i]);
        voices.splice(i, 1);
      }
    }
    const dying = this._dying;
    for (let i = dying.length - 1; i >= 0; i--) {
      if (dying[i].end <= now) {
        releaseVoice(dying[i]);
        dying.splice(i, 1);
      }
    }
  }

  _mayStart(name, now) {
    const times = this._starts.get(name);
    if (!times || times.length < MAX_STARTS) return true;
    return now - times[0] >= START_WINDOW;
  }

  _noteStart(name, now) {
    let times = this._starts.get(name);
    if (!times) {
      times = [];
      this._starts.set(name, times);
    }
    times.push(now);
    if (times.length > MAX_STARTS) times.shift();
  }

  // Makes room by cutting the least important voice, the oldest on a tie, as long as it
  // matters no more than the newcomer. The newcomer loses to anything more important.
  _freeSlot(pri, now) {
    let victim = -1;
    this._voices.forEach((voice, i) => {
      const best = this._voices[victim];
      if (voice.pri <= pri && (!best || voice.pri < best.pri || (voice.pri === best.pri && voice.born < best.born))) victim = i;
    });
    if (victim < 0) return false;
    const [voice] = this._voices.splice(victim, 1);
    silenceVoice(voice, now);
    voice.end = now + 0.05;
    this._dying.push(voice);
    this._counts.stolen++;
    return true;
  }

  /** Starts a named sound right now. Returns its voice, or null if it was refused. */
  play(name, options = {}) {
    const { ctx } = this;
    if (!ctx || this._hidden || ctx.state !== 'running') return null;
    const recipe = Object.hasOwn(SOUNDS, name) ? SOUNDS[name] : null;
    if (!recipe) return null;
    const now = ctx.currentTime;
    this._sweep(now);
    if (!this._mayStart(name, now)) {
      this._counts.rateDropped++;
      return null;
    }
    const pri = options.pri ?? recipe.pri;
    if (this._voices.length >= MAX_VOICES && !this._freeSlot(pri, now)) {
      this._counts.capDropped++;
      return null;
    }
    const voice = startVoice(this.mix, name, options, now + START_DELAY);
    voice.pri = pri;
    this._voices.push(voice);
    this._noteStart(name, now);
    this._counts.started++;
    if (this._voices.length > this._counts.peakVoices) this._counts.peakVoices = this._voices.length;
    return voice;
  }

  /** Starts a sound at a world position, heard from the listener's own kid. */
  at(name, x, y, options = {}) {
    const ear = this._ear;
    if (!ear || !Number.isFinite(x) || !Number.isFinite(y)) return this.play(name, options);
    const { fall, pan, muffle, wet } = spatialize(x - ear.x, y - ear.y);
    const level = Math.max(fall, options.floor ?? 0);
    if (level < INAUDIBLE) return null;
    return this.play(name, { ...options, gain: (options.gain ?? 1) * level, pan, muffle, wet });
  }

  duck(depth, seconds) {
    this.mix?.duck(depth, seconds);
  }

  // ---- Game events --------------------------------------------------------------

  // The listener is your kid. With no kid on the field (a spectator, or a late joiner
  // waiting for the next build) the camera sits on the Colonel, so the ear does too.
  _listen(view) {
    const me = view?.me;
    if (me) this._ear = me;
    else if (view?.map) this._ear = view.map.fort ?? { x: view.map.w / 2, y: view.map.h / 2 };
    else if (view) this._ear = null;
  }

  onFx(ev, view) {
    if (!this.ctx || !ev) return;
    this._listen(view);
    this.router.route(ev, view);
  }

  ui(name) {
    const sound = Object.hasOwn(UI_SOUNDS, name) ? UI_SOUNDS[name] : null;
    if (!sound || !this.ctx) return;
    // A tap fires hover events too, and there is nothing to hover with on a phone.
    if (name === 'hover' && globalThis.matchMedia?.('(hover: none)').matches) return;
    if (name === 'deny') {
      const now = this.ctx.currentTime;
      if (now - this._denyAt < DENY_GAP) return;
      this._denyAt = now;
    }
    this.play(sound);
  }

  // ---- Per-frame ----------------------------------------------------------------

  update(view) {
    if (!this.ctx || this._hidden || !view) return;
    this._listen(view);
    const now = this.ctx.currentTime;
    const dt = clamp(now - this._updateAt, 0, 0.1);
    this._updateAt = now;
    if (view !== this._seenView) this._newMatch(view);
    this._followPhase(view);
    this._followKid(view, dt);
    this._followBoss(view, now);
    this._setWind(view.blizzard ? WIND_LEVEL : 0);
  }

  _newMatch(view) {
    this._seenView = view;
    this._phase = null;
    this._secondsShown = null;
    this._ballsHeld = null;
    this.router.reset();
  }

  _isBossWave(view) {
    return view.mode === MODE.SIEGE && view.wave > 0 && view.wave % 5 === 0;
  }

  _followPhase(view) {
    const { phase } = view;
    if (phase !== this._phase) {
      const was = this._phase;
      this._phase = phase;
      // `was` is null on the first frame of a view, and joining a fight already in
      // progress shouldn't sound its horn.
      if (was !== null) {
        if (phase === PHASE.FIGHT) {
          this.play(this._isBossWave(view) ? 'bossHorn' : 'waveHorn');
          this.duck(0.4, 0.7);
        } else if (phase === PHASE.BUILD && was === PHASE.FIGHT) {
          this.play('waveClear');
        }
      }
    }

    this.conductor.setLevel(this._levelFor(view));

    if (phase === PHASE.BUILD && Number.isFinite(view.secondsLeft)) {
      const shown = Math.ceil(view.secondsLeft);
      if (this._secondsShown !== null && shown < this._secondsShown && shown >= 1 && shown <= 5) {
        this.play('countTick', { last: shown === 1 });
      }
      this._secondsShown = shown;
    } else {
      this._secondsShown = null;
    }
  }

  _levelFor(view) {
    const meta = view.meta;
    if (!meta) return 0;
    if (meta.boss) {
      const share = meta.boss.mhp > 0 ? meta.boss.hp / meta.boss.mhp : 1;
      if (meta.boss.kind === ACTOR.STEVE && (view.blizzard || share <= 0.5)) return 2;
      return share <= 0.33 ? 2 : share <= 0.7 ? 1 : 0;
    }
    if (view.mode === MODE.SIEGE) {
      const foes = meta.foesLeft ?? 0;
      return FIGHT_LEVELS.reduce((level, need) => (foes >= need ? level + 1 : level), 0);
    }
    // No foe count in PvP: the band builds as the clock runs down instead.
    if (meta.suddenDeath) return 3;
    const left = view.secondsLeft;
    if (!Number.isFinite(left)) return 1;
    return left <= 30 ? 3 : left <= 90 ? 2 : 1;
  }

  _followKid(view, dt) {
    const { me, you } = view;
    if (!me || !you) {
      this._ballsHeld = null;
      return;
    }
    const flags = me.flags ?? 0;

    // Packing has no event of its own. A ball appearing while crouched is the moment.
    if (this._ballsHeld !== null && you.balls > this._ballsHeld && flags & AFLAG.PACKING) {
      this.play('packPat', { rate: jitter(0.1) });
    }
    this._ballsHeld = you.balls;

    const speed = Math.hypot(me.vx ?? 0, me.vy ?? 0);
    const offFeet = flags & (AFLAG.FROZEN | AFLAG.SLIDING | AFLAG.BOARDING | AFLAG.PACKING);
    if (speed < 40 || offFeet || view.cw?.isIce?.(me.x, me.y)) return;
    this._stride += speed * dt;
    if (this._stride >= STRIDE) {
      this._stride -= STRIDE;
      this.play('step', { rate: jitter(0.18), gain: 0.7 });
    }
  }

  _followBoss(view, now) {
    const boss = view.meta?.boss?.kind;
    if (boss !== ACTOR.TRUCK && boss !== ACTOR.STEVE) {
      this._pounding = false;
      return;
    }
    let body = null;
    for (const actor of view.actors ?? []) {
      if (actor.kind === boss) {
        body = actor;
        break;
      }
    }
    if (!body) return;
    if (boss === ACTOR.STEVE) {
      const pounding = !!(body.aux & AUX.POUND);
      if (pounding && !this._pounding) this.at('poundWindup', body.x, body.y, { floor: 0.5 });
      this._pounding = pounding;
      return;
    }
    // The chime comes from the van. It never drops below a murmur, because it is also
    // the theme, but across the map you hear it arrive before you see it.
    if (now - this._steerAt < STEER_GAP || !this._ear) return;
    this._steerAt = now;
    const { fall, pan } = spatialize(body.x - this._ear.x, body.y - this._ear.y);
    this.conductor.steer('chime', pan, 0.4 + 0.6 * fall, now);
  }

  // ---- Blizzard wind ------------------------------------------------------------

  _setWind(level) {
    const { ctx } = this;
    if (!this._wind) {
      if (level <= 0) return;
      const source = ctx.createBufferSource();
      source.buffer = this.mix.kit.noise.pink;
      source.loop = true;
      const filter = ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.value = 520;
      filter.Q.value = 0.6;
      const gusts = ctx.createOscillator();
      gusts.frequency.value = 0.17;
      const sweep = ctx.createGain();
      sweep.gain.value = 240;
      const out = ctx.createGain();
      out.gain.value = 0;
      gusts.connect(sweep).connect(filter.frequency);
      source.connect(filter).connect(out).connect(this.mix.sfx);
      source.start();
      gusts.start();
      this._wind = { source, gusts, filter, sweep, out, level: 0, stopAt: Infinity };
    }
    const wind = this._wind;
    if (wind.level === level) return;
    wind.level = level;
    wind.out.gain.setTargetAtTime(level, ctx.currentTime, 1.1);
    wind.stopAt = level > 0 ? Infinity : ctx.currentTime + 5;
  }

  _windTick(now) {
    const wind = this._wind;
    if (!wind || now < wind.stopAt) return;
    wind.source.stop();
    wind.gusts.stop();
    wind.out.disconnect();
    wind.filter.disconnect();
    wind.sweep.disconnect();
    this._wind = null;
  }

  // ---- Page visibility ----------------------------------------------------------

  setHidden(hidden) {
    const next = !!hidden;
    if (next === this._hidden) return;
    this._hidden = next;
    const { ctx } = this;
    if (!ctx) return;
    if (next) {
      if (this._timer !== null) clearInterval(this._timer);
      this._timer = null;
      this.conductor.hold(ctx.currentTime);
      ctx.suspend().catch(() => {});
      return;
    }
    this._resume();
    this.conductor.restart(ctx.currentTime + RESTART_DELAY);
    this._begin();
    // On iOS a resume outside a gesture can quietly do nothing. The listeners come off
    // again at the statechange to 'running'.
    if (ctx.state !== 'running') this._arm();
  }
}
