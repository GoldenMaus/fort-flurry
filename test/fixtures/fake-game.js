// A small Game that honors SPEC section 7 closely enough to exercise Room and Session
// without the real simulation's foes and phases: the input rule (credit, backlog, neutral
// frames, AFK), id rules, events with `t`, private events, closed-form ball launches and
// call logging so tests can assert order. Kids move with the real stepKidMotion, because
// the point of a netcode test is the same integrator on both ends of the wire.
import { ACTOR, AFLAG, BALL, BTN, CMD, EV, PHASE, STRUCT } from '../../public/shared/schema.js';
import { BUILD, DT, KID, MAX_INPUT_BACKLOG, THROW } from '../../public/shared/constants.js';
import { createCollisionWorld, stepKidMotion } from '../../public/shared/physics.js';
import { defaultMods } from '../../public/shared/cards.js';
import { getMap } from '../../public/shared/maps.js';

export class FakeGame {
  // Tests reach the most recent instance here, because Room constructs it.
  static last = null;

  constructor(opts) {
    FakeGame.last = this;
    this.opts = opts;
    this.tick = 0;
    this.dt = DT;
    this.phase = PHASE.BUILD;
    this.wave = 1;
    this.blizzard = false;
    this.round = 1;
    this.truce = false;
    this.flakes = 24;
    this.calls = [];
    this.events = [];
    this.kids = new Map();
    this.structs = new Map();
    this.balls = new Map();
    this.nextStruct = 1000;
    this.nextBall = 1;
    this.over = false;
    this.pendingOffers = new Map();
    this.throwsEvery = 0;
    this.map = getMap(opts.mapId);
    this.cw = createCollisionWorld(this.map);
    for (const p of opts.players) this._addKid(p);
  }

  _log(name, ...args) {
    this.calls.push([name, ...args]);
  }

  _addKid(p) {
    const spawn = this.map.spawns.siege[this.kids.size % this.map.spawns.siege.length];
    this.kids.set(p.id, {
      id: p.id, kind: ACTOR.KID, team: p.team, name: p.name, isBot: !!p.isBot,
      x: spawn.x, y: spawn.y, vx: 0, vy: 0, r: KID.radius, aim: 0, hp: KID.maxWarmth, maxHp: KID.maxWarmth,
      flags: 0, aux: 0, slideT: 0, slideCd: 0, boardT: 0, slowT: 0, stunT: 0, prevBtn: 0,
      mods: defaultMods(), balls: KID.startBalls, maxBalls: KID.maxBalls, charge: 0, throwCd: 0,
      queue: [], lastQueued: 0, ackSeq: 0, credit: 1, idleTicks: 0, backlogTicks: 0, starvedTicks: 0, tx: 0, ty: 0,
      afk: false,
    });
  }

  queueInput(id, frame) {
    const k = this.kids.get(id);
    if (!k || frame.seq <= k.lastQueued) return;
    k.lastQueued = frame.seq;
    k.queue.push(frame);
  }

  command(id, cmd) {
    this._log('command', id, cmd);
    const k = this.kids.get(id);
    if (!k) return;
    if (cmd.c === CMD.BUILD) {
      if (cmd.k === STRUCT.PULT) {
        this.emit({ e: EV.DENY, to: id, why: 'limit' });
        return;
      }
      const sid = this.nextStruct++;
      const s = { id: sid, kind: cmd.k, cx: cmd.cx, cy: cmd.cy, team: k.team, hp: BUILD[cmd.k].hp, maxHp: BUILD[cmd.k].hp, ownerId: id };
      this.structs.set(sid, s);
      this.emit({ e: EV.S_ADD, id: sid, k: cmd.k, cx: cmd.cx, cy: cmd.cy, tm: k.team, hp: s.hp, mhp: s.maxHp, by: id });
    } else if (cmd.c === CMD.DEMOLISH) {
      for (const s of this.structs.values()) {
        if (s.cx === cmd.cx && s.cy === cmd.cy) {
          this.structs.delete(s.id);
          this.emit({ e: EV.S_DEL, id: s.id, k: s.kind, cx: s.cx, cy: s.cy, why: 'demolished' });
        }
      }
    } else if (cmd.c === CMD.EMOTE) {
      this.emit({ e: EV.EMOTE, id, n: cmd.n });
    } else if (cmd.c === CMD.CARD) {
      this.pendingOffers.delete(id);
      this.emit({ e: EV.CARD, id, card: 'mitten' });
    }
  }

  offer(id, cards) {
    this.pendingOffers.set(id, cards);
    this.emit({ e: EV.PICK_OFFER, to: id, cards });
  }

  emit(ev) {
    this.events.push({ ...ev, t: this.tick });
  }

  step() {
    this.tick += 1;
    for (const k of this.kids.values()) {
      if (k.isBot) continue;
      this._input(k);
    }
    this._advanceBalls();
  }

  _input(k) {
    k.credit = Math.min(k.credit + 1, MAX_INPUT_BACKLOG);
    if (k.queue.length > MAX_INPUT_BACKLOG) {
      while (k.queue.length > 2) this._dropOldest(k);
      k.backlogTicks = 0;
    }
    k.backlogTicks = k.queue.length > 2 ? k.backlogTicks + 1 : 0;
    if (k.backlogTicks >= 30) {
      this._dropOldest(k);
      k.backlogTicks = 0;
    }
    let applied = false;
    while (k.queue.length && k.credit >= 1) {
      const f = k.queue.shift();
      this._apply(k, f);
      k.credit -= 1;
      k.ackSeq = f.seq;
      applied = true;
    }
    if (applied) {
      k.starvedTicks = 0;
      k.idleTicks = 0;
      k.flags &= ~AFLAG.AFK;
      return;
    }
    k.starvedTicks += 1;
    k.idleTicks += 1;
    if (k.starvedTicks > 6) this._apply(k, { mx: 0, my: 0, btn: BTN.CANCEL, aim: k.aim, tx: k.tx, ty: k.ty, seq: 0 });
    if (k.idleTicks > 5 * 30) k.flags |= AFLAG.AFK;
  }

  _dropOldest(k) {
    const f = k.queue.shift();
    if (k.queue.length) k.queue[0] = { ...k.queue[0], btn: k.queue[0].btn | f.btn };
    k.ackSeq = f.seq;
  }

  _apply(k, f) {
    const prev = k.prevBtn;
    k.aim = f.aim;
    k.tx = f.tx;
    k.ty = f.ty;
    stepKidMotion(k, f, this.cw, DT);
    k.throwCd = Math.max(0, k.throwCd - DT);
    if (f.btn & BTN.CANCEL) k.charge = 0;
    else if (f.btn & BTN.THROW) k.charge = Math.min(1, k.charge + DT / THROW.chargeTime);
    const released = (prev & BTN.THROW) && !(f.btn & BTN.THROW) && !(f.btn & BTN.CANCEL);
    if (released && k.balls >= 1 && k.throwCd <= 0) {
      k.balls -= 1;
      k.throwCd = THROW.cooldown;
      this._throwFlat(k, f);
      k.charge = 0;
    }
  }

  _throwFlat(k, f) {
    const c = k.charge;
    const speed = THROW.quick.speed + (THROW.power.speed - THROW.quick.speed) * c;
    const flight = THROW.quick.flight + (THROW.power.flight - THROW.quick.flight) * c;
    const n = Math.max(2, Math.round(flight / DT));
    const g = 2 * THROW.z0 / (DT * DT * n * (n - 1));
    const id = this.nextBall++;
    const ball = {
      id, k: c >= 0.98 ? BALL.POWER : BALL.QUICK, by: k.id, tm: k.team, x: k.x, y: k.y, z: THROW.z0,
      vx: Math.cos(f.aim) * speed, vy: Math.sin(f.aim) * speed, vz: 0, g, r: THROW.radius, grow: 0, rMax: 0,
      seq: f.seq, lx: 0, ly: 0, ft: 0, born: this.tick, lifeTicks: n,
    };
    this.balls.set(id, ball);
    const { born, lifeTicks, ...wire } = ball;
    this.emit({ e: EV.THROW, id: k.id, lob: false });
    this.emit({ e: EV.BALL, ...wire });
  }

  _advanceBalls() {
    for (const b of this.balls.values()) {
      if (this.tick - b.born < b.lifeTicks) continue;
      this.balls.delete(b.id);
      const n = this.tick - b.born;
      this.emit({ e: EV.BALL_END, id: b.id, x: b.x + b.vx * n * DT, y: b.y + b.vy * n * DT, z: 0, why: 'ground', hit: 0 });
    }
  }

  drainEvents() {
    const out = this.events;
    this.events = [];
    return out;
  }

  actorsForSnapshot() {
    return [...this.kids.values()].map((k) => ({
      id: k.id, kind: k.kind, team: k.team, x: k.x, y: k.y, vx: k.vx, vy: k.vy, aim: k.aim,
      hp: k.hp / k.maxHp, flags: k.flags, aux: Math.round(k.charge * 255),
    }));
  }

  privateState(id) {
    const k = this.kids.get(id);
    if (!k) return null;
    return {
      balls: k.balls, maxBalls: k.maxBalls, special: 255, specialN: 0, warmth: k.hp, maxWarmth: k.maxHp,
      throwCd: k.throwCd, slideCd: k.slideCd, slideT: k.slideT, packT: 0, boardT: k.boardT, slowT: k.slowT,
      stunT: k.stunT, prevBtn: k.prevBtn, frozenT: 0, spendLeft: Infinity,
    };
  }

  ackSeq(id) {
    return this.kids.get(id)?.ackSeq ?? 0;
  }

  fullState(id) {
    this._log('fullState', id);
    return {
      tick: this.tick,
      structs: [...this.structs.values()].map((s) => ({ ...s })),
      pickups: [],
      balls: [...this.balls.values()].map(({ born, lifeTicks, ...wire }) => ({ ...wire, t: this.tick })),
      meta: this.meta(),
      offer: this.pendingOffers.get(id) ?? null,
    };
  }

  meta() {
    return {
      phase: this.phase, wave: this.wave, waveCount: this.opts.waveCount, waveName: 'Test Wave', waveSub: '',
      endsAtTick: null, dayT: 0, blizzard: this.blizzard, flakes: { 0: this.flakes }, colonels: [], foesLeft: 0,
      round: this.round, roundWins: {}, boss: null, ready: { have: 0, need: 1, ids: [] }, scores: [],
      truce: this.truce, suddenDeath: false, next: null, cards: {}, leaderId: null, pultLimit: {}, patchesLeft: 0,
    };
  }

  setAfk(id, on) {
    this._log('setAfk', id, on);
    const k = this.kids.get(id);
    if (k) k.afk = on;
  }

  resetInput(id) {
    this._log('resetInput', id);
    const k = this.kids.get(id);
    if (!k) return;
    k.queue = [];
    k.ackSeq = 0;
    k.lastQueued = 0;
    k.credit = 1;
  }

  addPlayer(p) {
    this._log('addPlayer', p);
    this._addKid(p);
  }

  removePlayer(id) {
    this._log('removePlayer', id);
    this.kids.delete(id);
  }

  isOver() {
    return this.over;
  }

  result() {
    return { mode: this.opts.mode, winnerTeam: 0, winners: [...this.kids.keys()], won: true, summary: 'Nice work', players: [] };
  }
}
