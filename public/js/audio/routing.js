// Fort Flurry — turns simulation events into sounds. The simulation only names eight
// sounds itself (SFX in schema.js); everything else is decided here from what happened.
//
// Deliberately silent: `banner` (the wave horn comes from the phase change in
// engine.update()), `deny` (the HUD calls ui('deny') when it shows the message), `bark`
// (the speech bubble is the whole joke) and `throw` (every throw also has a `ball` event,
// which knows the ball's kind and speed, so that is where the whoosh comes from).

import { ACTOR, BALL, EV, PICKUP, SFX, STRUCT } from '../../shared/schema.js';
import { CELL, THROW } from '../../shared/constants.js';
import { jitter } from './sfx.js';

const SFX_NAMES = new Set(Object.values(SFX));

const PLACED = {
  [STRUCT.WALL]: 'buildPop', [STRUCT.ICEWALL]: 'icePop', [STRUCT.DECOY]: 'coatFlop',
  [STRUCT.PULT]: 'pultBuild', [STRUCT.SLICK]: 'slickPop', [STRUCT.COCOA]: 'cocoaBuild',
};
const DESTROYED = {
  [STRUCT.WALL]: 'wallCrumble', [STRUCT.ICEWALL]: 'iceShatter', [STRUCT.DECOY]: 'coatPoof', [STRUCT.PULT]: 'woodBreak',
  [STRUCT.SLICK]: 'slickFade', [STRUCT.COCOA]: 'cocoaBreak', [STRUCT.COLONEL]: 'colonelFall',
};
const STRUCK = { [STRUCT.ICEWALL]: 'iceThunk', [STRUCT.PULT]: 'obstacleThud', [STRUCT.COCOA]: 'obstacleThud' };
const ARRIVAL = { [ACTOR.SLEDDER]: 'sledBells', [ACTOR.SNEAK]: 'sneakSteps', [ACTOR.BRUISER]: 'bigBoots' };
const TOSS = {
  [BALL.LOB]: 'lobToss', [BALL.ICE]: 'iceToss', [BALL.SLUSH]: 'slushToss', [BALL.GIANT]: 'giantRoll',
  [BALL.CONE]: 'coneVolley', [BALL.BOULDER]: 'boulderRoll',
};
const PICKED = {
  [PICKUP.ICE]: ['pickup', 'ice'], [PICKUP.SLUSH]: ['pickup', 'slush'], [PICKUP.TRIPLE]: ['pickup', 'triple'],
  [PICKUP.GIANT]: ['pickup', 'giant'], [PICKUP.COCOA]: ['cocoaSip', null], [PICKUP.BOARD]: ['boardZip', null],
};

// How long a multi-ball throw counts as one gesture, and how long a run of Flakes keeps
// climbing the ladder instead of starting over.
const THROW_WINDOW = 0.06;
const FLAKE_RUN = 1.1;

// Ids are remembered only between a ball's birth and its end, so this is a safety
// valve against ends that never arrive (a dropped connection), not a working size.
const MEMORY_CAP = 512;
const OWN_BALL_CAP = 32;

function remember(map, key, value) {
  if (map.size >= MEMORY_CAP) map.delete(map.keys().next().value);
  map.set(key, value);
}

function cellCentre(cx, cy) {
  return { x: (cx + 0.5) * CELL, y: (cy + 0.5) * CELL };
}

function findActor(view, id) {
  const actors = view?.actors;
  if (!actors) return null;
  for (const actor of actors) if (actor.id === id) return actor;
  return null;
}

function findStruct(view, id) {
  const structs = view?.structs;
  if (!structs) return null;
  for (const struct of structs) if (struct.id === id) return struct;
  return null;
}

export class FxRouter {
  constructor(engine) {
    this.engine = engine;
    this.balls = new Map();
    this.ownBalls = [];
    this.structs = new Map();
    this.throws = new Map();
    this.flakeStep = 0;
    this.flakeAt = -Infinity;
    this.poundAt = -Infinity;
  }

  /** Forgets everything tied to one match, so a rematch can't inherit stale ids. */
  reset() {
    this.balls.clear();
    this.ownBalls.length = 0;
    this.structs.clear();
    this.throws.clear();
  }

  route(ev, view) {
    const me = view?.me?.id ?? null;
    switch (ev.e) {
      case EV.BALL: this._ball(ev, me); break;
      case EV.BALL_END: this._ballEnd(ev, view); break;
      case EV.SPLASH: this._splash(ev); break;
      case EV.HIT: this._hit(ev, me, view); break;
      case EV.FREEZE: this._personal('freeze', ev, me, view, 3); break;
      case EV.THAW: this._personal('thaw', ev, me, view, 2); break;
      case EV.RESPAWN: this._respawn(ev, me); break;
      case EV.FLEE: this.engine.at('flee', ev.x, ev.y, { rate: jitter(0.12), gain: 0.8 }); break;
      case EV.SPAWN: this._spawn(ev); break;
      case EV.S_ADD: this._structAdded(ev, me); break;
      case EV.S_HP: this._structHp(ev, view); break;
      case EV.S_DEL: this._structGone(ev); break;
      case EV.P_ADD: this.engine.at('pickupDrop', ev.x, ev.y); break;
      case EV.P_DEL: this._pickup(ev, me); break;
      case EV.FLAKES: this._flakes(ev, me, view); break;
      case EV.PULT: this._pult(ev, view); break;
      case EV.CARD: if (ev.id === me) this.engine.play('cardFlip'); break;
      case EV.PICK_OFFER: this.engine.play('cardDeal'); break;
      case EV.EMOTE: this._personal('emote', ev, me, view, 1); break;
      case EV.QUAKE: this._quake(ev); break;
      case EV.SFX: this._named(ev); break;
      case EV.SLIDE: this._personal('slide', ev, me, view, 2); break;
      default: break;
    }
  }

  // Sounds that belong to one kid: centred and full when it's yours, placed otherwise.
  _personal(name, ev, me, view, pri) {
    if (ev.id === me) {
      this.engine.play(name, { pri });
      return;
    }
    const actor = findActor(view, ev.id);
    this.engine.at(name, actor?.x, actor?.y, { rate: jitter(0.05) });
  }

  // True if this thrower already made a sound this instant. Triple Toss and the Truck's
  // volley put several balls in the air on one tick, and that is one gesture.
  _thrownJustNow(by) {
    const now = this.engine.now;
    const last = this.throws.get(by);
    if (last !== undefined && now - last < THROW_WINDOW) return true;
    remember(this.throws, by, now);
    return false;
  }

  _ball(ev, me) {
    // Session predicts your throws under negative ids, and the server's id for that ball
    // only ever reaches us on its `ballEnd`. Balls land about in the order thrown, so a
    // queue is enough to give each its proper impact, and a rare swap costs one wrong splat.
    if (ev.id < 0) {
      if (this.ownBalls.length < OWN_BALL_CAP) this.ownBalls.push(ev.k);
    } else {
      remember(this.balls, ev.id, ev.k);
    }
    if (this._thrownJustNow(ev.by)) return;
    const mine = ev.by === me;
    const name = TOSS[ev.k] ?? 'whoosh';
    const o = { rate: jitter(mine ? 0.05 : 0.09), gain: mine ? 1 : 0.8, pri: mine ? 2 : undefined };
    if (name === 'whoosh') {
      const speed = Math.hypot(ev.vx || 0, ev.vy || 0);
      const span = THROW.power.speed - THROW.quick.speed;
      o.power = ev.k === BALL.POWER ? 1 : Math.min(1, Math.max(0, (speed - THROW.quick.speed) / span));
    }
    if (mine) this.engine.play(name, o);
    else this.engine.at(name, ev.x, ev.y, o);
  }

  _ballEnd(ev, view) {
    const kind = this.balls.get(ev.id) ?? this.ownBalls.shift() ?? BALL.QUICK;
    this.balls.delete(ev.id);
    const { engine } = this;
    const rate = jitter();
    switch (ev.why) {
      case 'ground':
        // Lobs and slushballs land with a `splash` event, which gets the bigger sound.
        if (kind === BALL.ICE) engine.at('iceCrack', ev.x, ev.y, { rate });
        else if (kind !== BALL.LOB && kind !== BALL.SLUSH) engine.at('splat', ev.x, ev.y, { rate, gain: 0.6 });
        break;
      case 'struct': {
        const struct = this._struct(ev.hit, view);
        engine.at(kind === BALL.ICE ? 'iceCrack' : STRUCK[struct?.k] ?? 'wallThunk', ev.x, ev.y, { rate });
        break;
      }
      case 'obstacle':
        engine.at('obstacleThud', ev.x, ev.y, { rate, gain: 0.8 });
        break;
      case 'shield':
        engine.at('lidClang', ev.x, ev.y, { rate: jitter(0.04) });
        break;
      case 'expire':
        if (kind === BALL.GIANT) engine.at('splatHeavy', ev.x, ev.y, { rate, size: 1.5 });
        else if (kind === BALL.BOULDER) engine.at('wallCrumble', ev.x, ev.y, { rate: 0.7 });
        break;
      default:
        // 'actor' is covered by the `hit` event, and 'out' left the map.
        break;
    }
  }

  _splash(ev) {
    const size = Math.max(0.6, (ev.r || 46) / 46);
    this.engine.at(ev.k === BALL.SLUSH ? 'slushSplat' : 'splatHeavy', ev.x, ev.y, { size, rate: jitter() });
  }

  _hit(ev, me, view) {
    const { engine } = this;
    if (ev.id === me) {
      engine.play('ouch', { rate: jitter(0.06) });
      return;
    }
    const kind = findActor(view, ev.id)?.kind;
    const mine = ev.by === me;
    let name = 'splat';
    if (ev.k === -1) name = 'shove';
    else if (ev.k === BALL.ICE) name = 'iceCrack';
    else if (kind === ACTOR.TRUCK) name = 'metalPing';
    else if (kind === ACTOR.STEVE) name = 'furThud';
    engine.at(name, ev.x, ev.y, { rate: jitter(), gain: mine ? 1 : 0.75 });
    if (mine) engine.play('hitTick', { rate: 1 + Math.min(ev.amt || 0, 30) / 80 });
  }

  _respawn(ev, me) {
    if (ev.id === me) this.engine.play('respawn');
    else this.engine.at('respawn', ev.x, ev.y, { gain: 0.5 });
  }

  _spawn(ev) {
    // Bosses announce themselves with their own horn and roar.
    if (ev.k === ACTOR.TRUCK || ev.k === ACTOR.STEVE) return;
    this.engine.at(ARRIVAL[ev.k] ?? 'foeArrive', ev.x, ev.y, { rate: jitter(0.1) });
  }

  _struct(id, view) {
    return this.structs.get(id) ?? this._adopt(findStruct(view, id));
  }

  // Structures from a FULL snapshot never had an sAdd, so the first sight of one fills
  // in the record from the view.
  _adopt(struct) {
    if (!struct) return null;
    const known = { k: struct.kind, hp: struct.hp, ...cellCentre(struct.cx, struct.cy) };
    remember(this.structs, struct.id, known);
    return known;
  }

  _structAdded(ev, me) {
    const { x, y } = cellCentre(ev.cx, ev.cy);
    remember(this.structs, ev.id, { k: ev.k, hp: ev.hp, x, y });
    const name = PLACED[ev.k];
    if (name) this.engine.at(name, x, y, { rate: jitter(0.1), gain: ev.by === me ? 1 : 0.8 });
  }

  _structHp(ev, view) {
    const struct = this._struct(ev.id, view);
    if (!struct) return;
    // hp only goes up through a repair, a patch or the between-waves heal.
    if (ev.hp > struct.hp) this.engine.at('repair', struct.x, struct.y, { rate: jitter(0.05) });
    struct.hp = ev.hp;
  }

  _structGone(ev) {
    this.structs.delete(ev.id);
    if (ev.why === 'reset') return;
    const { x, y } = cellCentre(ev.cx, ev.cy);
    const name = ev.why === 'demolished' ? 'demolish' : DESTROYED[ev.k];
    if (name) this.engine.at(name, x, y, { rate: jitter(0.06) });
  }

  _pickup(ev, me) {
    if (!ev.by) return; // expired, not taken
    const [name, kind] = PICKED[ev.k] ?? PICKED[PICKUP.TRIPLE];
    if (ev.by === me) this.engine.play(name, { kind });
    else this.engine.at(name, ev.x, ev.y, { kind, gain: 0.5 });
  }

  _flakes(ev, me, view) {
    // Only your own team's income. In a crowded fight anything else is just tinsel.
    const team = view?.me?.team ?? view?.players?.get?.(me)?.team;
    if (team !== undefined && ev.tm !== team) return;
    const { engine } = this;
    if (ev.amt >= 10) {
      engine.at('flakeBurst', ev.x, ev.y);
      return;
    }
    const now = engine.now;
    this.flakeStep = now - this.flakeAt < FLAKE_RUN ? this.flakeStep + 1 : 0;
    this.flakeAt = now;
    engine.at('flake', ev.x, ev.y, { step: this.flakeStep });
  }

  _pult(ev, view) {
    const struct = this._struct(ev.id, view);
    this.engine.at('pult', struct?.x, struct?.y, { rate: jitter(0.06) });
  }

  // Steve's pound is announced twice (a `quake` of amt 1 and the named sound) and the
  // two can arrive in either order, so the first in wins.
  _pound(x, y) {
    const now = this.engine.now;
    if (now - this.poundAt < 0.15) return;
    this.poundAt = now;
    this.engine.at('stevePound', x, y, { floor: 0.45 });
    this.engine.duck(0.45, 0.35);
  }

  _quake(ev) {
    const amt = Math.min(1, Math.max(0, ev.amt || 0));
    if (amt >= 1) this._pound(ev.x, ev.y);
    else if (amt > 0) this.engine.at('rumble', ev.x, ev.y, { amt });
  }

  _named(ev) {
    if (!SFX_NAMES.has(ev.name)) return;
    const { engine } = this;
    if (ev.name === SFX.STEVE_POUND) {
      this._pound(ev.x, ev.y);
      return;
    }
    // Story beats stay audible from anywhere on the map.
    engine.at(ev.name, ev.x, ev.y, { floor: 0.45 });
    if (ev.name === SFX.STEVE_ROAR) engine.duck(0.5, 1.2);
    else if (ev.name === SFX.TRUCK_HORN) engine.duck(0.35, 0.5);
    else if (ev.name === SFX.CHEER) engine.duck(0.3, 1.2);
  }
}
