// Fort Flurry — the authoritative simulation (SPEC sections 2, 3, 4 and 7).
//
// One Game is one match. It knows nothing about sockets: Room feeds it inputs and
// commands, calls step() at SIM_HZ, and ships what drainEvents() and the snapshot
// accessors return. Given the same seed, players and inputs it replays bit for bit,
// so every random choice goes through g.rng() and every collection is walked in
// insertion order.

import {
  ACTOR, AFLAG, AUX, BALL, BTN, CMD, DIFFICULTY, EMOTES, EV, MODE, MODE_NAME, PHASE, PICKUP, SFX, STRUCT, TEAM, TEAM_MODES, TEAM_NAME,
} from './schema.js';
import {
  BOSS, BUILD, CELL, CLASSIC, DEMOLISH_REFUND, DIFF, DT, FAIR_SHARE, FFA, FOES, FORTWARS, KID, MAX_ACTORS, MAX_INPUT_BACKLOG,
  PICKUP_DROP_CHANCE, SIEGE, SIM_HZ, SPECIAL, TEAMMATE_DEMOLISH_COOLDOWN, THROW,
} from './constants.js';
import { createRng } from './rng.js';
import {
  canPlace, collideCircle, createCollisionWorld, demolishState, raycastFlat, repairCost, segmentIntoCircle, stepKidMotion,
} from './physics.js';
import { FlowField } from './flowfield.js';
import { getMap } from './maps.js';
import { modsFromCards, rollCards } from './cards.js';
import { WaveRunner, waveInfo } from './waves.js';
import { updateFoe } from './ai_foes.js';
import { updateSteve, updateTruck } from './ai_bosses.js';
import { botFrame } from './ai_bots.js';

const FIRST_SHARED_ID = 1000;
const LAST_SHARED_ID = 65535;

const AIM_BUTTONS = BTN.THROW | BTN.LOB;
const ANY_BUTTON = BTN.THROW | BTN.LOB | BTN.SLIDE | BTN.CANCEL;
// A backlog means the kid is acting on old intent, so the input rule cuts it to this.
const SETTLE_QUEUE_LENGTH = 2;
const SLOW_DRAIN_TICKS = 30;
const STARVED_TICKS = 6;
const AFK_AFTER_TICKS = 5 * SIM_HZ;
// Any further backlog is dropped on the next step anyway, so holding more buys nothing.
// This only bounds memory while Room is not stepping, such as on the results screen.
const QUEUE_HARD_CAP = 64;

// Balls pass through these and foes look straight past them.
const UNTOUCHABLE = AFLAG.FLEEING | AFLAG.GRACE | AFLAG.FROZEN;
const IDLE_SPEED2 = 20 * 20;
const NO_MOVE_INPUT2 = 0.1 * 0.1;
const FULL_POWER_CHARGE = 0.98;

const VAULT_SPEED_MUL = 0.6;
const BLOCKED_PROGRESS = 0.5;
const SKID_CARRY = 0.35;
const PUSH_DECAY = 0.72;
const PUSH_STOP = 8;
// Knockback falls off with size so that a Big Kid shrugs off what bowls a Pipsqueak over.
const PUSH_FULL_RADIUS = 14;
const SPLASH_KNOCK_MUL = 0.6;

const FLEE_SPEED_MUL = 1.15;
// A fleeing foe is harmless, but one wedged behind a parked car must not linger forever.
const FLEE_MAX_SECONDS = 20;
// Boss AI owns its exit and gives itself 20 s. This only catches an exit that never ends.
const BOSS_EXIT_MAX_SECONDS = 30;

const PICKUP_LIFE_SECONDS = 30;
const PICKUP_REACH = 12;
const MAX_PICKUPS = 12;
const PICKUP_KINDS = [PICKUP.ICE, PICKUP.SLUSH, PICKUP.TRIPLE, PICKUP.GIANT, PICKUP.COCOA, PICKUP.BOARD];

const BOT_REPAIR_SHARE = 0.25;
const HARRUMPH_EVERY_TICKS = 4 * SIM_HZ;

// The day advances a little during BUILD and most of the way through FIGHT. Fights have
// no fixed length, so that part eases towards the end of its slice and never overruns it.
const BUILD_SHARE_OF_DAY = 0.2;
const FIGHT_DAY_HALF_LIFE = 40;
const ENDLESS_DAY_WAVES = 10;
const DAY_SLEW_PER_SECOND = 0.02;
// Coarse on purpose. dayT rides in Meta, and a value that moves every few ticks would
// force a META message every 8 ticks for something nobody can see change.
const DAY_STEPS = 200;

const SFX_NAMES = new Set(Object.values(SFX));

const AWARDS = [['mitten', 'hits'], ['foreman', 'built'], ['cocoa', 'thaws'], ['iceberg', 'freezes']];

// Siege's Colonel is voiced by the WaveRunner. Face-Off has no runner, so he speaks here.
const COLONEL_HURT_LINES = [
  [0.75, 'A scratch! I have had worse from pigeons.'],
  [0.5, 'Reinforce the bucket, troops!'],
  [0.25, 'Tell my carrots I loved them!'],
];

const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const finite = (v, fallback) => (Number.isFinite(v) ? v : fallback);
const ticksOf = (seconds) => Math.round(seconds * SIM_HZ);
const round2 = (v) => Math.round(v * 100) / 100;

// Two decimals is plenty for anything a client draws, and it keeps event JSON short.
function roundNumbers(record) {
  for (const key in record) {
    const v = record[key];
    if (typeof v === 'number' && !Number.isInteger(v)) record[key] = round2(v);
  }
  return record;
}

function angleGap(a, b) {
  const gap = Math.abs(a - b) % (Math.PI * 2);
  return gap > Math.PI ? Math.PI * 2 - gap : gap;
}

export class Game {
  constructor(opts = {}) {
    this.mode = opts.mode ?? MODE.SIEGE;
    this.difficulty = DIFF[opts.difficulty] ? opts.difficulty : DIFFICULTY.NORMAL;
    this.waveCount = opts.waveCount ?? 10;
    this.map = opts.map ?? getMap(opts.mapId);
    this.cw = createCollisionWorld(this.map);
    this.rng = createRng(opts.seed ?? 1);

    this.dt = DT;
    this.tick = 0;
    this.time = 0;
    this.phase = PHASE.BUILD;
    this.phaseStart = 0;
    this.endsAtTick = null;
    this.wave = 0;
    this.round = 0;
    this.roundWins = {};
    this.blizzard = false;
    this.flakes = {};
    this.countMul = 1;
    this.suddenDeath = false;
    this.classic = this.mode === MODE.CLASSIC;
    this.teamMode = TEAM_MODES.includes(this.mode);
    this.speedMul = 1;
    this.roundHits = {};

    this.actors = new Map();
    this.structs = new Map();
    this.balls = new Map();
    this.pickups = new Map();
    this.players = new Map();
    this.inputs = new Map();

    this.nextId = FIRST_SHARED_ID - 1;
    this.nextBallId = 0;
    this.nextPickupId = 0;

    // Bumped on any struct change; FlowField compares it to decide when to rebuild.
    this.structRev = 0;
    this.cellStruct = new Array(this.cw.cols * this.cw.rows).fill(null);
    this.colonels = new Map();
    this.flows = new Map();
    this.exitFlow = null;

    this.events = [];
    this.dirtyStructs = new Set();
    this.inStep = false;
    this.stampAhead = 0;

    this.weight = 1;
    this.runner = null;
    this.waveMeta = null;
    this.doneTick = null;
    this.readyIds = new Set();
    this.patches = {};
    this.botBudget = {};
    this.colonelDealt = {};
    this.teamFreezes = {};
    this.nextDropTick = 0;
    this.lastHarrumphTick = -HARRUMPH_EVERY_TICKS;
    this.dayPos = 0;
    this.finalResult = null;

    // Nothing emitted while setting up is news: FULL carries it, and Session drops
    // events with t <= FULL.tick. The opening banner below is the exception.
    for (const p of opts.players ?? []) {
      this.players.set(p.id, this.playerRecord(p));
      this.spawnKid(this.players.get(p.id));
    }
    this.startMatch();
    this.stampAhead = 1;
    this.announcePhase();
    this.stampAhead = 0;
  }

  // ---- Room-facing API --------------------------------------------------------

  queueInput(playerId, frame) {
    const st = this.inputs.get(playerId);
    if (st === undefined || !(frame.seq > st.lastSeq)) return;
    st.lastSeq = frame.seq;
    if (st.queue.length >= QUEUE_HARD_CAP) this.dropOldestFrame(st);
    st.queue.push({ seq: frame.seq, mx: frame.mx, my: frame.my, aim: frame.aim, btn: frame.btn | 0, tx: frame.tx, ty: frame.ty });
  }

  command(playerId, cmd) {
    const kid = this.actors.get(playerId);
    if (kid === undefined || kid.kind !== ACTOR.KID || !cmd) return;
    // Commands land between ticks, after that tick's flush and any FULL taken from it. A
    // reconnecting client discards events with t <= FULL.tick, so they must carry the
    // tick they will really be delivered with, or it would miss them for good.
    this.stampAhead = this.inStep ? 0 : 1;
    switch (cmd.c) {
      case CMD.BUILD: this.commandBuild(kid, cmd); break;
      case CMD.DEMOLISH: this.commandDemolish(kid, cmd); break;
      case CMD.CARD: this.commandCard(kid, cmd); break;
      case CMD.READY: this.commandReady(kid); break;
      case CMD.EMOTE: this.commandEmote(kid, cmd); break;
      default: break;
    }
    this.stampAhead = 0;
  }

  step() {
    this.inStep = true;
    this.tick += 1;
    this.time += DT;
    this.stepInput();
    this.stepKids();
    this.stepFoes();
    if (this.phase === PHASE.FIGHT && this.runner !== null) this.runner.update();
    this.stepStructs();
    this.stepBalls();
    this.stepPhase();
    this.inStep = false;
  }

  drainEvents() {
    for (const s of this.dirtyStructs) {
      if (this.structs.get(s.id) === s) this.events.push({ e: EV.S_HP, id: s.id, hp: round2(s.hp), t: this.tick });
    }
    this.dirtyStructs.clear();
    const drained = this.events;
    this.events = [];
    return drained;
  }

  actorsForSnapshot() {
    const records = [];
    for (const a of this.actors.values()) {
      records.push({
        id: a.id, kind: a.kind, team: a.team, x: a.x, y: a.y, vx: a.vx, vy: a.vy, aim: a.aim,
        hp: a.maxHp > 0 ? clamp(a.hp / a.maxHp, 0, 1) : 0, flags: a.flags, aux: a.aux,
      });
    }
    return records;
  }

  privateState(playerId) {
    const kid = this.actors.get(playerId);
    if (kid === undefined || kid.kind !== ACTOR.KID) return null;
    return {
      balls: kid.balls, maxBalls: kid.maxBalls,
      special: kid.special === null ? 255 : kid.special, specialN: kid.specialN,
      warmth: kid.hp, maxWarmth: kid.maxHp,
      throwCd: kid.throwCd, slideCd: kid.slideCd, slideT: kid.slideT, packT: kid.packT,
      boardT: kid.boardT, slowT: kid.slowT, stunT: kid.stunT, prevBtn: kid.prevBtn,
      frozenT: (kid.flags & AFLAG.FROZEN) !== 0 ? Math.ceil(Math.max(0, kid.frozenT)) : 0,
      spendLeft: kid.spendLeft === Infinity ? 65535 : kid.spendLeft,
    };
  }

  ackSeq(playerId) {
    return this.inputs.get(playerId)?.ackSeq ?? 0;
  }

  fullState(playerId) {
    const kid = this.actors.get(playerId);
    const structs = [];
    for (const s of this.structs.values()) {
      structs.push({ id: s.id, kind: s.kind, cx: s.cx, cy: s.cy, team: s.team, hp: round2(s.hp), maxHp: round2(s.maxHp), ownerId: s.ownerId });
    }
    const pickups = [];
    for (const p of this.pickups.values()) pickups.push({ id: p.id, kind: p.kind, x: p.x, y: p.y });
    const balls = [];
    for (const b of this.balls.values()) {
      const record = this.ballRecord(b);
      record.t = this.tick;
      balls.push(record);
    }
    return {
      tick: this.tick, structs, pickups, balls, meta: this.meta(),
      offer: kid !== undefined && kid.offer ? [...kid.offer] : null,
    };
  }

  meta() {
    const flakes = {};
    for (const team of Object.keys(this.flakes)) flakes[team] = Math.floor(this.flakes[team]);
    const colonels = [];
    let noseStolen = false;
    let boss = null;
    let liveFoes = 0;
    for (const a of this.actors.values()) {
      if (a.kind === ACTOR.KID) continue;
      if (a.kind === ACTOR.SNEAK && (a.aux & AUX.NOSE) !== 0) noseStolen = true;
      if ((a.flags & AFLAG.FLEEING) !== 0) continue;
      liveFoes += 1;
      if (FOES[a.kind].boss) boss = { kind: a.kind, name: FOES[a.kind].name, hp: Math.round(a.hp), mhp: Math.round(a.maxHp) };
    }
    for (const [team, col] of this.colonels) {
      colonels.push({ team, id: col.id, hp: Math.round(col.hp), mhp: Math.round(col.maxHp), nose: !noseStolen });
    }
    const scores = [];
    const cards = {};
    for (const kid of this.kids()) {
      const s = kid.stats;
      scores.push({ id: kid.id, hits: s.hits, freezes: s.freezes, thaws: s.thaws, built: s.built, flakes: Math.floor(s.flakes) });
      cards[kid.id] = [...kid.cards];
    }
    const need = this.readyNeed();
    const ids = need.filter((id) => this.readyIds.has(id));
    const pultLimit = {};
    for (const team of Object.keys(this.flakes)) pultLimit[team] = this.pultLimit(Number(team));
    const showNext = this.phase === PHASE.BUILD && this.runner !== null;
    return {
      phase: this.phase,
      wave: this.wave,
      waveCount: this.waveCount,
      waveName: this.waveMeta?.name ?? '',
      waveSub: this.waveMeta?.sub ?? '',
      endsAtTick: this.endsAtTick,
      dayT: this.dayT(),
      blizzard: this.blizzard,
      flakes,
      colonels,
      foesLeft: (this.runner?.remaining ?? 0) + liveFoes,
      round: this.round,
      roundWins: { ...this.roundWins },
      boss,
      ready: { have: ids.length, need: need.length, ids },
      scores,
      truce: this.cw.truce !== null && this.cw.truce.active === true,
      suddenDeath: this.suddenDeath,
      next: showNext ? this.runner.preview : null,
      cards,
      leaderId: this.mode === MODE.FFA ? this.leaderId() : null,
      pultLimit,
      patchesLeft: this.patches[TEAM.A] ?? 0,
      speedMul: this.speedMul,
    };
  }

  setAfk(playerId, on) {
    const p = this.players.get(playerId);
    if (p === undefined) return;
    p.afk = Boolean(on);
    const kid = this.actors.get(playerId);
    if (kid !== undefined && kid.kind === ACTOR.KID) this.refreshAfkFlag(kid);
  }

  resetInput(playerId) {
    const st = this.inputs.get(playerId);
    if (st === undefined) return;
    st.queue.length = 0;
    st.ackSeq = 0;
    st.lastSeq = 0;
    st.credit = 1;
    st.backedUpTicks = 0;
  }

  addPlayer(p) {
    if (this.players.has(p.id)) return;
    this.stampAhead = this.inStep ? 0 : 1;
    const record = this.playerRecord(p);
    this.players.set(p.id, record);
    // Siege rescales the Colonel and the wave at BUILD start, so that is when a joiner
    // hops in. Until then they exist only in the head-count.
    if (this.mode !== MODE.SIEGE) {
      this.spawnKid(record);
      if (this.mode === MODE.FFA) this.flakes[record.team] ??= FFA.startFlakes;
      const kid = this.actors.get(record.id);
      this.emit({ e: EV.RESPAWN, id: kid.id, x: kid.x, y: kid.y });
      // A Classic round already under way: the newcomer sits it out and plays from the next.
      if (this.classic && this.phase !== PHASE.BUILD) this.knockOut(kid);
    }
    this.stampAhead = 0;
  }

  removePlayer(id) {
    this.players.delete(id);
    this.inputs.delete(id);
    this.readyIds.delete(id);
    const kid = this.actors.get(id);
    if (kid !== undefined && kid.kind === ACTOR.KID) this.actors.delete(id);
  }

  isOver() {
    return this.phase === PHASE.OVER;
  }

  result() {
    return this.finalResult;
  }

  // ---- internals shared with the AI modules --------------------------------------

  foes() {
    const list = [];
    for (const a of this.actors.values()) if (a.kind !== ACTOR.KID) list.push(a);
    return list;
  }

  kids() {
    const list = [];
    for (const a of this.actors.values()) if (a.kind === ACTOR.KID) list.push(a);
    return list;
  }

  // With no team this is the Siege head-count; with one it is that team's share, which
  // sets its Spoon Flinger limit. Late joiners count: they are about to be in the fight.
  weightedPlayers(team) {
    let humans = 0;
    let bots = 0;
    for (const p of this.players.values()) {
      if (team !== undefined && p.team !== team) continue;
      if (p.isBot) bots += 1;
      else if (this.isAttendingHuman(p)) humans += 1;
    }
    return Math.max(1, humans + bots * SIEGE.botPlayerWeight);
  }

  colonel(team) {
    return this.colonels.get(team) ?? null;
  }

  structAt(cx, cy) {
    if (!this.cw.inBounds(cx, cy)) return null;
    return this.cellStruct[cy * this.cw.cols + cx];
  }

  flow(moverTeam) {
    let goalTeam = null;
    if (this.mode === MODE.SIEGE && moverTeam === TEAM.FOES) goalTeam = TEAM.A;
    else if (this.mode === MODE.FORTWARS && moverTeam === TEAM.A) goalTeam = TEAM.B;
    else if (this.mode === MODE.FORTWARS && moverTeam === TEAM.B) goalTeam = TEAM.A;
    if (goalTeam === null) return null;
    const col = this.colonel(goalTeam);
    if (col === null) return null;
    let field = this.flows.get(goalTeam);
    if (field === undefined) {
      const goals = [];
      for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) goals.push({ cx: col.cx + x, cy: col.cy + y });
      field = new FlowField(this, goals);
      this.flows.set(goalTeam, field);
    }
    return field;
  }

  spawnFoe(kind, x, y, opts = {}) {
    const spec = FOES[kind];
    if (spec === undefined) return null;
    const boss = spec.boss === true;
    if (!boss && this.countFodder() >= MAX_ACTORS) return null;
    const diff = DIFF[this.difficulty];
    const perExtra = boss ? SIEGE.perExtraPlayerBossHp : SIEGE.perExtraPlayerHp;
    const hp = spec.hp * diff.hp * (1 + perExtra * (this.weight - 1)) * (opts.hpMul ?? 1);
    // Squads fan out around an entrance on the very edge of the map, so some land past it.
    const atX = clamp(x, spec.r, this.map.w - spec.r);
    const atY = clamp(y, spec.r, this.map.h - spec.r);
    const foe = {
      id: this.allocId(), kind, team: TEAM.FOES, x: atX, y: atY, vx: 0, vy: 0, r: spec.r, aim: 0,
      hp, maxHp: hp, speed: spec.speed, dmg: spec.dmg * diff.dmg, cd: spec.cd,
      flags: AFLAG.GRACE, aux: 0, stunT: 0, slowT: 0, takeDmgMul: 1, ai: {},
      graceT: SIEGE.foeSpawnGrace, noFlakes: opts.noFlakes === true,
      pushX: 0, pushY: 0, lastVx: 0, lastVy: 0, fleeT: 0, lastHitBy: 0, lastHitAt: 0,
    };
    this.actors.set(foe.id, foe);
    this.emit({ e: EV.SPAWN, id: foe.id, k: kind, x: atX, y: atY });
    return foe;
  }

  throwFlat(actor, angle, opts = {}) {
    const kind = opts.kind ?? BALL.QUICK;
    const roller = kind === BALL.GIANT || kind === BALL.BOULDER;
    const speed = opts.speed ?? THROW.quick.speed;
    const r = opts.r ?? THROW.radius;
    const z0 = roller ? 0 : opts.z0 ?? THROW.z0;
    const flightTicks = Math.max(2, Math.round((opts.flight ?? THROW.quick.flight) / DT));
    const ball = this.spawnBall({
      kind, by: actor.id, team: actor.team, x: actor.x, y: actor.y, z: z0,
      vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed, vz: 0,
      g: roller ? 0 : (2 * z0) / (DT * DT * flightTicks * (flightTicks - 1)),
      r, grow: opts.grow ?? 0, rMax: opts.rMax ?? r, dmg: opts.dmg ?? THROW.quick.dmg, seq: opts.seq ?? 0,
      life: roller ? Math.max(1, ticksOf(opts.life ?? 1)) : flightTicks,
      roller, arc: false, splash: opts.splash ?? 0, slow: opts.slow ?? 0, stun: opts.stun ?? 0,
      pierce: opts.pierce ?? 0, structMul: opts.structMul ?? 1,
    });
    if (opts.quiet !== true) this.emit({ e: EV.THROW, id: actor.id, lob: false });
    return ball;
  }

  throwLob(actor, tx, ty, opts = {}) {
    const ball = this.spawnLob(actor.x, actor.y, actor.id, actor.team, tx, ty, opts);
    this.emit({ e: EV.THROW, id: actor.id, lob: true });
    return ball;
  }

  // Returns the warmth or hp actually taken, so callers can tell a hit from a pass-through.
  damageActor(target, amt, source = null, opts = {}) {
    if (this.actors.get(target.id) !== target || (target.flags & UNTOUCHABLE) !== 0) return 0;
    let dealt = amt * target.takeDmgMul;
    if (this.classic && target.kind === ACTOR.KID) {
      // Classic counts hearts, not warmth: any enemy hit is one, an Iceball two. Warmth only
      // mirrors them, so the warmth bar and the freeze below work unchanged.
      target.hearts = Math.max(0, target.hearts - (opts.kind === BALL.ICE ? CLASSIC.iceHits : 1));
      const left = (target.maxHp * target.hearts) / CLASSIC.hits;
      dealt = target.hp - left;
      target.hp = left;
      if (source !== null) this.roundHits[source.team] = (this.roundHits[source.team] ?? 0) + 1;
    } else {
      target.hp -= dealt;
    }
    const fromKid = source !== null && source.kind === ACTOR.KID;
    if (fromKid) source.stats.hits += 1;
    this.emit({ e: EV.HIT, id: target.id, amt: dealt, x: target.x, y: target.y, by: source?.id ?? 0, k: opts.kind ?? -1 });

    const kx = opts.kx ?? 0;
    const ky = opts.ky ?? 0;
    const bigBody = FOES[target.kind]?.boss === true;
    if (target.kind === ACTOR.KID) {
      target.sinceHit = 0;
      target.vx += kx;
      target.vy += ky;
      if (opts.stun > 0) target.stunT = Math.max(target.stunT, opts.stun);
    } else {
      if (fromKid && opts.noAggro !== true) {
        target.lastHitBy = source.id;
        target.lastHitAt = this.time;
      }
      if (!bigBody) {
        const give = Math.min(1, (PUSH_FULL_RADIUS / target.r) ** 2);
        target.pushX += kx * give;
        target.pushY += ky * give;
        if (opts.stun > 0) target.stunT = Math.max(target.stunT, opts.stun);
      }
    }
    if (opts.slow > 0) target.slowT = Math.max(target.slowT, opts.slow);
    if (target.hp <= 0) this.freezeOrFlee(target, source);
    return dealt;
  }

  damageStruct(struct, amt, source = null) {
    if (this.structs.get(struct.id) !== struct || !(amt > 0)) return;
    if (source !== null && source.team === struct.team) return;
    const before = struct.hp;
    struct.hp = Math.max(0, before - amt);
    this.touchStruct(struct);
    if (struct.kind === STRUCT.COLONEL) {
      if (source !== null) this.colonelDealt[source.team] = (this.colonelDealt[source.team] ?? 0) + (before - struct.hp);
      this.colonelReacts(struct, before);
    } else if (struct.hp <= 0) {
      this.removeStruct(struct, 'destroyed');
    }
  }

  freezeOrFlee(actor, source = null) {
    if (actor.kind === ACTOR.KID) this.freezeKid(actor, source);
    else this.foeGivesUp(actor, source, !actor.noFlakes);
  }

  despawn(actor) {
    if (this.actors.get(actor.id) === actor) this.actors.delete(actor.id);
  }

  nearestEnemy(actor, range = Infinity) {
    const limit = range * range;
    let best = null;
    let bestD = Infinity;
    for (const a of this.actors.values()) {
      if (a.team === actor.team || (a.flags & UNTOUCHABLE) !== 0) continue;
      const dx = a.x - actor.x;
      const dy = a.y - actor.y;
      const d = dx * dx + dy * dy;
      if (d <= limit && d < bestD) {
        bestD = d;
        best = a;
      }
    }
    return best;
  }

  enemiesInRadius(team, x, y, r) {
    const found = [];
    const limit = r * r;
    for (const a of this.actors.values()) {
      if (a.team === team || (a.flags & (AFLAG.FLEEING | AFLAG.GRACE)) !== 0) continue;
      const dx = a.x - x;
      const dy = a.y - y;
      if (dx * dx + dy * dy <= limit) found.push(a);
    }
    return found;
  }

  // A flat throw aimed at a wall is meant to hit that wall, so reaching the struct that
  // stands at the far end counts as a clear line.
  los(x0, y0, x1, y1) {
    const hit = raycastFlat(this.cw, x0, y0, x1, y1, THROW.z0);
    if (hit === null) return true;
    if (hit.structCell === null) return false;
    const target = this.cw.cellOf(x1, y1);
    const end = this.structAt(target.cx, target.cy);
    return end !== null && end === this.structAt(hit.structCell.cx, hit.structCell.cy);
  }

  moveActor(actor, dx, dy, opts) {
    const vault = opts !== undefined && opts.vault === true;
    const fromX = actor.x;
    const fromY = actor.y;
    const here = this.cw.cellOf(fromX, fromY);
    const under = this.structAt(here.cx, here.cy);
    let mul = 1;
    let moveX = dx;
    let moveY = dy;
    if (under !== null && under.kind === STRUCT.SLICK && under.team !== actor.team) {
      actor.slowT = Math.max(actor.slowT, BUILD[STRUCT.SLICK].slow);
      actor.flags |= AFLAG.SLOWED;
      moveX = lerp(dx, (actor.lastVx ?? 0) * DT, SKID_CARRY);
      moveY = lerp(dy, (actor.lastVy ?? 0) * DT, SKID_CARRY);
    }
    if (actor.slowT > 0) mul *= KID.slowSpeedMul;
    if (vault) {
      const ahead = this.cw.cellOf(fromX + dx, fromY + dy);
      if (this.cw.isSolidStructCell(here.cx, here.cy) || this.cw.isSolidStructCell(ahead.cx, ahead.cy)) mul *= VAULT_SPEED_MUL;
    }
    const wantX = moveX * mul;
    const wantY = moveY * mul;
    actor.x = fromX + wantX;
    actor.y = fromY + wantY;
    const touched = collideCircle(this.cw, actor, fromX, fromY, vault ? { ignoreStructs: true } : undefined);
    const movedX = actor.x - fromX;
    const movedY = actor.y - fromY;
    actor.vx = movedX / DT;
    actor.vy = movedY / DT;
    actor.lastVx = actor.vx;
    actor.lastVy = actor.vy;
    // AI stops and attacks whatever this returns, so a foe scraping along a wall on its
    // way past must not be told that wall is in its way. Only a stopped foe is blocked.
    if (touched === null) return null;
    const blocked = movedX * movedX + movedY * movedY < BLOCKED_PROGRESS * BLOCKED_PROGRESS * (wantX * wantX + wantY * wantY);
    return blocked ? this.structAt(touched.cx, touched.cy) : null;
  }

  bark(who, text) {
    this.emit({ e: EV.BARK, id: who.id, text });
  }

  emit(ev) {
    if (ev.t === undefined) ev.t = this.tick + this.stampAhead;
    this.events.push(roundNumbers(ev));
    return ev;
  }

  banner(text, sub = '', kind = 'info') {
    this.emit({ e: EV.BANNER, text, sub, kind });
  }

  sfx(name, x = 0, y = 0) {
    if (SFX_NAMES.has(name)) this.emit({ e: EV.SFX, name, x, y });
  }

  awardFlakes(team, amt, x = 0, y = 0) {
    if (!(amt > 0)) return;
    this.flakes[team] = (this.flakes[team] ?? 0) + amt;
    this.emit({ e: EV.FLAKES, amt, x, y, tm: team });
  }

  // ---- kids and input -----------------------------------------------------------

  playerRecord(p) {
    return { id: p.id, name: p.name ?? '', look: p.look ?? null, team: p.team, isBot: Boolean(p.isBot), afk: false };
  }

  spawnKid(p) {
    const kid = {
      id: p.id, kind: ACTOR.KID, team: p.team, x: 0, y: 0, vx: 0, vy: 0, r: KID.radius, aim: 0,
      hp: KID.maxWarmth, maxHp: KID.maxWarmth, speed: KID.speed, dmg: 0, cd: 0, flags: 0, aux: 0,
      stunT: 0, slowT: 0, takeDmgMul: 1, ai: {},
      isBot: p.isBot, balls: KID.startBalls, maxBalls: KID.maxBalls, special: null, specialN: 0,
      charge: 0, throwCd: 0, slideT: 0, slideCd: 0, boardT: 0, packT: 0, prevBtn: 0,
      cards: [], mods: modsFromCards([]), spendLeft: Infinity,
      stats: { hits: 0, freezes: 0, thaws: 0, built: 0, flakes: 0 },
      // Host-only from here down: none of this crosses the wire.
      slot: this.freeSlot(p.team), tx: 0, ty: 0, armed: 0, cancelHeld: false,
      frozenT: 0, thawProgress: 0, graceT: 0, sinceHit: 0, offer: null, nextTeamDemolish: 0,
      hearts: CLASSIC.hits,
    };
    if (this.classic) kid.mods = this.classicMods();
    this.placeKid(kid, this.homePoint(kid));
    kid.tx = kid.x;
    kid.ty = kid.y;
    this.actors.set(kid.id, kid);
    if (!kid.isBot) {
      this.inputs.set(kid.id, { queue: [], lastSeq: 0, ackSeq: 0, credit: 1, idleTicks: 0, backedUpTicks: 0 });
    }
    return kid;
  }

  freeSlot(team) {
    const used = new Set();
    for (const a of this.actors.values()) if (a.kind === ACTOR.KID && a.team === team) used.add(a.slot);
    let slot = 0;
    while (used.has(slot)) slot += 1;
    return slot;
  }

  homePoint(kid) {
    const { spawns } = this.map;
    if (this.teamMode) {
      const list = spawns.fortwars[kid.team === TEAM.B ? 1 : 0];
      return list[kid.slot % list.length];
    }
    if (this.mode === MODE.FFA) {
      const slot = Math.max(0, kid.team - TEAM.FFA_BASE);
      return spawns.ffa[slot % spawns.ffa.length];
    }
    return spawns.siege[kid.slot % spawns.siege.length];
  }

  isAttendingHuman(p) {
    if (p.isBot || p.afk) return false;
    const kid = this.actors.get(p.id);
    return kid === undefined || (kid.flags & AFLAG.AFK) === 0;
  }

  // "Owner has left or is AFK" in the demolish rule.
  isPresent(id) {
    const kid = this.actors.get(id);
    return kid !== undefined && kid.kind === ACTOR.KID && (kid.flags & AFLAG.AFK) === 0;
  }

  refreshAfkFlag(kid) {
    const st = this.inputs.get(kid.id);
    const away = this.players.get(kid.id)?.afk === true || (st !== undefined && st.idleTicks >= AFK_AFTER_TICKS);
    if (away) kid.flags |= AFLAG.AFK;
    else kid.flags &= ~AFLAG.AFK;
  }

  dropOldestFrame(st) {
    const dropped = st.queue.shift();
    st.queue[0].btn |= dropped.btn;
    st.ackSeq = dropped.seq;
  }

  stepInput() {
    for (const kid of this.kids()) {
      if (kid.isBot) {
        this.applyFrame(kid, botFrame(this, kid));
        continue;
      }
      const st = this.inputs.get(kid.id);
      const { queue } = st;
      st.credit = Math.min(st.credit + 1, MAX_INPUT_BACKLOG);
      if (queue.length > MAX_INPUT_BACKLOG) {
        while (queue.length > SETTLE_QUEUE_LENGTH) this.dropOldestFrame(st);
      }
      if (queue.length > SETTLE_QUEUE_LENGTH) {
        st.backedUpTicks += 1;
        if (st.backedUpTicks >= SLOW_DRAIN_TICKS) {
          this.dropOldestFrame(st);
          st.backedUpTicks = 0;
        }
      } else {
        st.backedUpTicks = 0;
      }
      let applied = false;
      while (queue.length > 0 && st.credit >= 1) {
        const frame = queue.shift();
        this.applyFrame(kid, frame);
        st.credit -= 1;
        st.ackSeq = frame.seq;
        applied = true;
      }
      if (applied) {
        st.idleTicks = 0;
      } else {
        st.idleTicks += 1;
        // CANCEL so a kid whose connection stalled mid-charge doesn't throw on recovery.
        if (st.idleTicks > STARVED_TICKS) this.applyFrame(kid, { mx: 0, my: 0, btn: BTN.CANCEL, aim: kid.aim, tx: kid.tx, ty: kid.ty });
      }
      this.refreshAfkFlag(kid);
    }
  }

  applyFrame(kid, raw) {
    // Bad numbers are stopped here because a single NaN in a position spreads to every
    // ball and foe it touches. Room's sanitizing covers humans; this also covers bots.
    const frame = {
      seq: finite(raw.seq, 0),
      mx: clamp(finite(raw.mx, 0), -1, 1),
      my: clamp(finite(raw.my, 0), -1, 1),
      aim: finite(raw.aim, kid.aim),
      btn: (raw.btn | 0) & ANY_BUTTON,
      tx: finite(raw.tx, kid.tx),
      ty: finite(raw.ty, kid.ty),
    };
    const slideBefore = kid.slideT;
    kid.aim = frame.aim;
    kid.tx = frame.tx;
    kid.ty = frame.ty;
    stepKidMotion(kid, frame, this.cw, DT);
    if (kid.slideT > slideBefore) this.emit({ e: EV.SLIDE, id: kid.id });
    this.stepThrowing(kid, frame);
    this.stepPacking(kid, frame);
  }

  throwsOpen() {
    return this.phase === PHASE.FIGHT || (this.phase === PHASE.BUILD && this.mode === MODE.SIEGE);
  }

  disarm(kid) {
    kid.armed = 0;
    kid.charge = 0;
    kid.flags &= ~(AFLAG.CHARGING | AFLAG.LOBAIM);
  }

  // Press and release are read from the armed state rather than raw button edges: a
  // button already held when a kid thaws, or when Face-Off's truce ends, should begin
  // charging at once, and a cancelled charge must not revive until the button is let go.
  stepThrowing(kid, frame) {
    const { btn } = frame;
    if (kid.throwCd > 0) kid.throwCd = Math.max(0, kid.throwCd - DT);
    if ((btn & AIM_BUTTONS) === 0) kid.cancelHeld = false;
    if ((kid.flags & (AFLAG.FROZEN | AFLAG.LOCKED)) !== 0 || !this.throwsOpen()) {
      this.disarm(kid);
      return;
    }
    if ((btn & BTN.CANCEL) !== 0) {
      this.disarm(kid);
      kid.cancelHeld = (btn & AIM_BUTTONS) !== 0;
      return;
    }

    if (kid.armed === BTN.THROW) {
      if ((btn & BTN.THROW) !== 0) {
        kid.charge = Math.min(1, kid.charge + DT / THROW.chargeTime);
      } else {
        this.releaseThrow(kid, frame);
        this.disarm(kid);
      }
    } else if (kid.armed === BTN.LOB && (btn & BTN.LOB) === 0) {
      this.releaseLob(kid, frame);
      this.disarm(kid);
    }

    if (kid.armed === 0 && (btn & AIM_BUTTONS) !== 0 && !kid.cancelHeld) {
      kid.armed = (btn & BTN.THROW) !== 0 ? BTN.THROW : BTN.LOB;
      kid.charge = 0;
      kid.flags |= kid.armed === BTN.THROW ? AFLAG.CHARGING : AFLAG.LOBAIM;
    }
  }

  deny(kid, why) {
    if (!kid.isBot) this.emit({ e: EV.DENY, to: kid.id, why });
  }

  spendThrow(kid, cost, cooldown) {
    kid.balls -= cost;
    kid.throwCd = cooldown;
    kid.packT = 0;
    kid.flags &= ~AFLAG.PACKING;
    kid.graceT = 0;
    kid.flags &= ~AFLAG.GRACE;
  }

  releaseThrow(kid, frame) {
    if (kid.throwCd > 0) return;
    if (kid.balls < 1) {
      this.deny(kid, 'noBalls');
      return;
    }
    this.spendThrow(kid, 1, THROW.cooldown);
    const seq = kid.isBot ? 0 : frame.seq;
    const { mods, charge } = kid;
    const shot = {
      kind: charge >= FULL_POWER_CHARGE ? BALL.POWER : BALL.QUICK,
      speed: lerp(THROW.quick.speed, THROW.power.speed, charge) * mods.throwSpeedMul,
      flight: lerp(THROW.quick.flight, THROW.power.flight, charge),
      dmg: lerp(THROW.quick.dmg, THROW.power.dmg, charge) * mods.throwDmgMul,
      seq,
      quiet: true,
    };
    const special = kid.special === null ? null : SPECIAL[kid.special];
    let spread = 0;
    if (special !== null) {
      if (kid.special === PICKUP.ICE) {
        shot.kind = special.ball;
        shot.dmg *= special.dmgMul;
        shot.pierce = special.pierce;
        shot.structMul = special.structMul;
      } else if (kid.special === PICKUP.SLUSH) {
        shot.kind = special.ball;
        shot.splash = special.splash;
        shot.slow = special.slow;
      } else if (kid.special === PICKUP.TRIPLE) {
        spread = special.spread;
      } else if (kid.special === PICKUP.GIANT) {
        shot.kind = special.ball;
        shot.speed = special.speed * mods.throwSpeedMul;
        shot.dmg = special.dmg * mods.throwDmgMul;
        shot.r = special.r0;
        shot.rMax = special.r1;
        shot.grow = special.grow;
        shot.life = special.life;
        shot.stun = special.stun;
      }
      kid.specialN -= 1;
      if (kid.specialN <= 0) {
        kid.special = null;
        kid.specialN = 0;
      }
    }
    this.throwFlat(kid, kid.aim, shot);
    if (spread > 0) {
      this.throwFlat(kid, kid.aim - spread, shot);
      this.throwFlat(kid, kid.aim + spread, shot);
    }
    this.emit({ e: EV.THROW, id: kid.id, lob: false });
  }

  releaseLob(kid, frame) {
    if (kid.throwCd > 0) return;
    const { lob } = THROW;
    if (kid.balls < lob.cost) {
      this.deny(kid, 'noBalls');
      return;
    }
    let dx = frame.tx - kid.x;
    let dy = frame.ty - kid.y;
    const distance = Math.sqrt(dx * dx + dy * dy);
    if (distance > lob.maxRange) {
      dx *= lob.maxRange / distance;
      dy *= lob.maxRange / distance;
    }
    const tx = clamp(kid.x + dx, 0, this.map.w);
    const ty = clamp(kid.y + dy, 0, this.map.h);
    this.spendThrow(kid, lob.cost, lob.cooldown);
    this.throwLob(kid, tx, ty, {
      dmg: lob.dmg * kid.mods.throwDmgMul,
      splash: lob.splash * kid.mods.lobSplashMul,
      seq: kid.isBot ? 0 : frame.seq,
    });
  }

  stepPacking(kid, frame) {
    const idle = frame.mx * frame.mx + frame.my * frame.my < NO_MOVE_INPUT2
      && kid.vx * kid.vx + kid.vy * kid.vy < IDLE_SPEED2;
    const able = idle && kid.armed === 0 && kid.balls < kid.maxBalls && kid.slideT <= 0
      && (kid.flags & (AFLAG.FROZEN | AFLAG.LOCKED)) === 0 && !this.cw.isIce(kid.x, kid.y);
    if (!able) {
      kid.packT = 0;
      kid.flags &= ~AFLAG.PACKING;
      return;
    }
    kid.packT += DT;
    if (kid.packT < KID.packDelay) return;
    kid.flags |= AFLAG.PACKING;
    const perBall = KID.packTime * kid.mods.packTimeMul;
    if (kid.packT >= KID.packDelay + perBall) {
      kid.balls += 1;
      kid.packT -= perBall;
      if (kid.balls >= kid.maxBalls) {
        kid.packT = 0;
        kid.flags &= ~AFLAG.PACKING;
      }
    }
  }

  // ---- kid systems ----------------------------------------------------------------

  stepKids() {
    const kids = this.kids();
    const warmTeammates = new Map();
    for (const kid of kids) {
      if ((kid.flags & AFLAG.FROZEN) === 0) warmTeammates.set(kid.team, (warmTeammates.get(kid.team) ?? 0) + 1);
    }
    const stands = [];
    for (const s of this.structs.values()) if (s.kind === STRUCT.COCOA) stands.push(s);

    for (const kid of kids) {
      const cocoa = this.inCocoaRange(stands, kid);
      if ((kid.flags & AFLAG.FROZEN) !== 0) this.stepFrozenKid(kid, kids, warmTeammates, cocoa);
      else this.stepWarmKid(kid, cocoa);
    }
    this.stepPickups(kids);
    for (const kid of kids) this.deriveKidFlags(kid);
  }

  inCocoaRange(stands, kid) {
    const reach = BUILD[STRUCT.COCOA].radius ** 2;
    for (const s of stands) {
      if (s.team !== kid.team) continue;
      const dx = s.x - kid.x;
      const dy = s.y - kid.y;
      if (dx * dx + dy * dy <= reach) return true;
    }
    return false;
  }

  stepFrozenKid(kid, kids, warmTeammates, cocoa) {
    if (this.classic) return; // a Classic knockout lasts the round: no thaw, no respawn
    if ((warmTeammates.get(kid.team) ?? 0) === 0) kid.frozenT = Math.min(kid.frozenT, KID.loneAutoThaw);
    kid.frozenT -= DT;

    let rate = 0;
    let helper = null;
    const reach = KID.thawRange * KID.thawRange;
    for (const friend of kids) {
      if (friend === kid || friend.team !== kid.team || (friend.flags & AFLAG.FROZEN) !== 0) continue;
      const dx = friend.x - kid.x;
      const dy = friend.y - kid.y;
      if (dx * dx + dy * dy > reach) continue;
      const friendRate = 1 / friend.mods.thawTimeMul;
      if (friendRate > rate) {
        rate = friendRate;
        helper = friend;
      }
    }
    if (helper !== null) {
      kid.thawProgress += DT * rate * (cocoa ? BUILD[STRUCT.COCOA].thawMul : 1);
      if (kid.thawProgress >= KID.thawTime) {
        this.thawKid(kid, helper);
        return;
      }
    }
    if (kid.frozenT <= 0) {
      if (this.mode === MODE.SIEGE) this.thawKid(kid, null);
      else this.respawnKid(kid);
    }
  }

  stepWarmKid(kid, cocoa) {
    if (kid.graceT > 0) {
      kid.graceT -= DT;
      if (kid.graceT <= 0) {
        kid.graceT = 0;
        kid.flags &= ~AFLAG.GRACE;
      }
    }
    kid.sinceHit += DT;
    let heat = 0;
    if (!this.classic && kid.sinceHit >= KID.regenDelay) heat += KID.regenPerSec * kid.mods.regenMul;
    if (cocoa) heat += BUILD[STRUCT.COCOA].healPerSec;
    if (heat > 0) kid.hp = Math.min(kid.maxHp, kid.hp + heat * DT);

    // Foes meet a Slick through moveActor, but kids never go through that, so in the
    // player-versus-player modes an enemy Slick needs its own check to do anything at all.
    if (this.mode !== MODE.SIEGE) {
      const cell = this.cw.cellOf(kid.x, kid.y);
      const under = this.structAt(cell.cx, cell.cy);
      if (under !== null && under.kind === STRUCT.SLICK && under.team !== kid.team) {
        kid.slowT = Math.max(kid.slowT, BUILD[STRUCT.SLICK].slow);
      }
    }
  }

  deriveKidFlags(kid) {
    let flags = kid.flags & ~(AFLAG.SLIDING | AFLAG.BOARDING | AFLAG.SLOWED | AFLAG.STUNNED | AFLAG.LOCKED);
    if (kid.slideT > 0) flags |= AFLAG.SLIDING;
    if (kid.boardT > 0) flags |= AFLAG.BOARDING;
    if (kid.slowT > 0) flags |= AFLAG.SLOWED;
    if (kid.stunT > 0) flags |= AFLAG.STUNNED;
    if (this.phase === PHASE.ROUND_END || this.phase === PHASE.OVER) flags |= AFLAG.LOCKED;
    kid.flags = flags;
    if ((flags & AFLAG.FROZEN) !== 0) kid.aux = Math.round(255 * clamp(kid.thawProgress / KID.thawTime, 0, 1));
    else kid.aux = kid.armed === BTN.THROW ? Math.round(255 * kid.charge) : 0;
  }

  grantGrace(kid) {
    kid.graceT = KID.thawGrace;
    kid.flags |= AFLAG.GRACE;
  }

  clearAiming(kid) {
    this.disarm(kid);
    kid.packT = 0;
    kid.flags &= ~AFLAG.PACKING;
  }

  freezeKid(kid, source) {
    if ((kid.flags & AFLAG.FROZEN) !== 0) return;
    this.clearAiming(kid);
    kid.hp = 0;
    kid.vx = 0;
    kid.vy = 0;
    kid.flags |= AFLAG.FROZEN;
    kid.graceT = 0;
    kid.flags &= ~AFLAG.GRACE;
    kid.thawProgress = 0;
    if (this.mode === MODE.SIEGE) kid.frozenT = KID.frozenAutoThaw;
    else if (this.classic) kid.frozenT = 0;
    else kid.frozenT = this.mode === MODE.FORTWARS ? FORTWARS.respawnTime : FFA.respawnTime;
    this.emit({ e: EV.FREEZE, id: kid.id, by: source?.id ?? 0 });
    if (source === null || source.kind !== ACTOR.KID) return;

    // Measured before the point is scored, since it is the lead the victim had going in.
    const worth = this.mode === MODE.FFA && this.leadOf(kid) >= FFA.leaderBonusLead ? 2 : 1;
    source.stats.freezes += worth;
    if (this.mode === MODE.FORTWARS) {
      this.teamFreezes[source.team] = (this.teamFreezes[source.team] ?? 0) + 1;
      this.creditFlakes(source, FORTWARS.flakesPerFreeze, kid.x, kid.y);
    } else if (this.mode === MODE.FFA) {
      this.creditFlakes(source, FFA.flakesPerFreeze, kid.x, kid.y);
    } else if (this.classic) {
      this.teamFreezes[source.team] = (this.teamFreezes[source.team] ?? 0) + 1;
    }
  }

  creditFlakes(kid, amt, x, y) {
    this.awardFlakes(kid.team, amt, x, y);
    kid.stats.flakes += amt;
  }

  thawKid(kid, helper) {
    kid.flags &= ~AFLAG.FROZEN;
    kid.hp = Math.min(kid.maxHp, helper === null ? KID.autoThawWarmth : KID.thawWarmth);
    kid.frozenT = 0;
    kid.thawProgress = 0;
    kid.sinceHit = 0;
    kid.aux = 0;
    this.grantGrace(kid);
    this.emit({ e: EV.THAW, id: kid.id, by: helper?.id ?? 0 });
    if (helper !== null) helper.stats.thaws += 1;
  }

  respawnKid(kid) {
    const point = this.mode === MODE.FFA ? this.safestFfaSpawn(kid) : this.homePoint(kid);
    kid.flags &= ~AFLAG.FROZEN;
    kid.hp = kid.maxHp;
    kid.frozenT = 0;
    kid.thawProgress = 0;
    kid.sinceHit = 0;
    kid.aux = 0;
    kid.balls = Math.max(kid.balls, Math.min(KID.startBalls, kid.maxBalls));
    this.placeKid(kid, point);
    this.grantGrace(kid);
    this.emit({ e: EV.RESPAWN, id: kid.id, x: kid.x, y: kid.y });
  }

  // Pushed clear of anything built or parked on the point, so a kid never starts inside a
  // solid and gets shoved out on their first frame, which a client would see as a jump.
  placeKid(kid, point) {
    kid.x = point.x;
    kid.y = point.y;
    kid.vx = 0;
    kid.vy = 0;
    collideCircle(this.cw, kid, point.x, point.y);
  }

  safestFfaSpawn(kid) {
    let best = null;
    let bestGap = -1;
    for (const point of this.map.spawns.ffa) {
      let nearest = Infinity;
      for (const other of this.actors.values()) {
        if (other === kid || other.team === kid.team) continue;
        const dx = other.x - point.x;
        const dy = other.y - point.y;
        nearest = Math.min(nearest, dx * dx + dy * dy);
      }
      if (nearest > bestGap) {
        bestGap = nearest;
        best = point;
      }
    }
    return best;
  }

  // Full reset for a new Face-Off round. Cards are Siege-only, so nothing persists but stats.
  resetKidForRound(kid) {
    this.clearAiming(kid);
    kid.flags &= AFLAG.AFK;
    if (this.classic) {
      kid.hearts = CLASSIC.hits;
      kid.mods = this.classicMods();
    }
    kid.hp = kid.maxHp;
    kid.balls = Math.min(KID.startBalls, kid.maxBalls);
    kid.special = null;
    kid.specialN = 0;
    kid.throwCd = 0;
    kid.slideT = 0;
    kid.slideCd = 0;
    kid.boardT = 0;
    kid.slowT = 0;
    kid.stunT = 0;
    kid.frozenT = 0;
    kid.thawProgress = 0;
    kid.graceT = 0;
    kid.sinceHit = 0;
    kid.aux = 0;
    this.placeKid(kid, this.homePoint(kid));
    this.emit({ e: EV.RESPAWN, id: kid.id, x: kid.x, y: kid.y });
  }

  stepPickups(kids) {
    for (const p of this.pickups.values()) {
      if (this.tick >= p.expiresAt) {
        this.removePickup(p, 0);
        continue;
      }
      for (const kid of kids) {
        if ((kid.flags & (AFLAG.FROZEN | AFLAG.LOCKED)) !== 0) continue;
        const dx = kid.x - p.x;
        const dy = kid.y - p.y;
        const reach = kid.r + PICKUP_REACH;
        if (dx * dx + dy * dy > reach * reach) continue;
        this.grantPickup(kid, p);
        this.removePickup(p, kid.id);
        break;
      }
    }
  }

  grantPickup(kid, p) {
    if (p.kind === PICKUP.COCOA) {
      kid.hp = Math.min(kid.maxHp, kid.hp + SPECIAL[PICKUP.COCOA].heal);
    } else if (p.kind === PICKUP.BOARD) {
      kid.boardT = KID.boardTime;
    } else {
      kid.special = p.kind;
      kid.specialN = SPECIAL[p.kind].uses;
    }
  }

  removePickup(p, takenBy) {
    this.pickups.delete(p.id);
    this.emit({ e: EV.P_DEL, id: p.id, k: p.kind, x: p.x, y: p.y, by: takenBy });
  }

  dropPickup(x, y, only = null) {
    if (this.pickups.size >= MAX_PICKUPS) return;
    const cell = this.cw.cellOf(x, y);
    if (this.cw.isSolidCell(cell.cx, cell.cy)) return;
    const kind = only ?? PICKUP_KINDS[Math.floor(this.rng() * PICKUP_KINDS.length)];
    this.nextPickupId += 1;
    const p = { id: this.nextPickupId, kind, x, y, expiresAt: this.tick + ticksOf(PICKUP_LIFE_SECONDS) };
    this.pickups.set(p.id, p);
    this.emit({ e: EV.P_ADD, id: p.id, k: kind, x, y });
  }

  // ---- foes ---------------------------------------------------------------------

  allocId() {
    do {
      this.nextId = this.nextId >= LAST_SHARED_ID ? FIRST_SHARED_ID : this.nextId + 1;
    } while (this.actors.has(this.nextId) || this.structs.has(this.nextId));
    return this.nextId;
  }

  countFodder() {
    let count = 0;
    for (const a of this.actors.values()) {
      if (a.kind !== ACTOR.KID && FOES[a.kind].boss !== true) count += 1;
    }
    return count;
  }

  stepFoes() {
    for (const foe of this.foes()) {
      // An earlier foe's update this tick may have despawned this one.
      if (this.actors.get(foe.id) !== foe) continue;
      // Velocity reports this tick's movement. Without clearing, a foe that stopped to
      // throw would keep its old value and Spoon Flingers would lead it into empty snow.
      foe.vx = 0;
      foe.vy = 0;
      this.applyPush(foe);
      if (foe.slowT > 0) foe.slowT = Math.max(0, foe.slowT - DT);
      if (foe.slowT > 0) foe.flags |= AFLAG.SLOWED;
      else foe.flags &= ~AFLAG.SLOWED;
      if (foe.graceT > 0) {
        foe.graceT -= DT;
        if (foe.graceT <= 0) {
          foe.graceT = 0;
          foe.flags &= ~AFLAG.GRACE;
        }
        continue;
      }
      if (foe.stunT > 0) {
        foe.stunT = Math.max(0, foe.stunT - DT);
        foe.flags |= AFLAG.STUNNED;
        if (foe.stunT > 0) continue;
      }
      foe.flags &= ~AFLAG.STUNNED;
      const boss = FOES[foe.kind].boss === true;
      const fleeing = (foe.flags & AFLAG.FLEEING) !== 0;
      if (fleeing && !boss) {
        this.stepFleeing(foe);
        continue;
      }
      if (fleeing) {
        foe.fleeT += DT;
        if (foe.fleeT > BOSS_EXIT_MAX_SECONDS) {
          this.despawn(foe);
          continue;
        }
      } else if (this.phase === PHASE.OVER) {
        continue;
      }
      if (foe.kind === ACTOR.TRUCK) updateTruck(this, foe);
      else if (foe.kind === ACTOR.STEVE) updateSteve(this, foe);
      else updateFoe(this, foe);
    }
  }

  applyPush(foe) {
    if (foe.pushX === 0 && foe.pushY === 0) return;
    const fromX = foe.x;
    const fromY = foe.y;
    foe.x += foe.pushX * DT;
    foe.y += foe.pushY * DT;
    collideCircle(this.cw, foe, fromX, fromY);
    foe.pushX *= PUSH_DECAY;
    foe.pushY *= PUSH_DECAY;
    if (foe.pushX * foe.pushX + foe.pushY * foe.pushY < PUSH_STOP * PUSH_STOP) {
      foe.pushX = 0;
      foe.pushY = 0;
    }
  }

  // Edges are reached along a flow field, not a straight line: most edges in Maple Court
  // are behind houses, and a kid giving up should jog out of a street, not into a wall.
  exitField() {
    if (this.exitFlow === null) {
      const { cols, rows } = this.cw;
      const goals = [];
      for (let cx = 0; cx < cols; cx++) {
        for (const cy of [0, rows - 1]) if (!this.cw.isObstacleCell(cx, cy)) goals.push({ cx, cy });
      }
      for (let cy = 1; cy < rows - 1; cy++) {
        for (const cx of [0, cols - 1]) if (!this.cw.isObstacleCell(cx, cy)) goals.push({ cx, cy });
      }
      this.exitFlow = new FlowField(this, goals);
    }
    return this.exitFlow;
  }

  stepFleeing(foe) {
    foe.fleeT += DT;
    const { w, h } = this.map;
    const toLeft = foe.x;
    const toRight = w - foe.x;
    const toTop = foe.y;
    const toBottom = h - foe.y;
    const nearest = Math.min(toLeft, toRight, toTop, toBottom);
    if (nearest <= foe.r + 2 || foe.fleeT > FLEE_MAX_SECONDS) {
      this.despawn(foe);
      return;
    }
    let { dx, dy } = this.exitField().dirAt(foe.x, foe.y);
    if (dx === 0 && dy === 0) {
      dx = nearest === toLeft ? -1 : nearest === toRight ? 1 : 0;
      dy = nearest === toTop ? -1 : nearest === toBottom ? 1 : 0;
      if (dx !== 0 && dy !== 0) dy = 0;
    }
    foe.aim = Math.atan2(dy, dx);
    const step = foe.speed * FLEE_SPEED_MUL * DT;
    this.moveActor(foe, dx * step, dy * step, { vault: true });
  }

  foeGivesUp(foe, source, award) {
    if ((foe.flags & AFLAG.FLEEING) !== 0) return;
    const boss = FOES[foe.kind].boss === true;
    foe.hp = 0;
    foe.aux = 0;
    foe.stunT = 0;
    foe.graceT = 0;
    foe.pushX = 0;
    foe.pushY = 0;
    foe.flags = AFLAG.FLEEING | (foe.flags & AFLAG.ENRAGED);
    this.emit({ e: EV.FLEE, id: foe.id, x: foe.x, y: foe.y });
    const fromKid = source !== null && source.kind === ACTOR.KID;
    if (fromKid) source.stats.freezes += 1;
    if (award) {
      const scale = this.mode === MODE.SIEGE ? 1 / Math.sqrt(this.countMul) : 1;
      const amt = FOES[foe.kind].flakes * scale + (fromKid ? source.mods.flakeBonus : 0);
      if (fromKid) this.creditFlakes(source, amt, foe.x, foe.y);
      else this.awardFlakes(TEAM.A, amt, foe.x, foe.y);
      if (this.rng() < PICKUP_DROP_CHANCE) this.dropPickup(foe.x, foe.y);
    }
    if (boss) {
      for (const other of this.foes()) {
        if (other !== foe && FOES[other.kind].boss !== true) this.foeGivesUp(other, null, false);
      }
    }
  }

  // ---- structures ---------------------------------------------------------------

  addStruct(kind, cx, cy, team, ownerId, hp) {
    const spec = BUILD[kind];
    const size = spec.size || 1;
    const struct = {
      id: this.allocId(), kind, cx, cy, team, hp, maxHp: hp, ownerId,
      // Centre point, so AI and flingers can treat a struct like anything else with a position.
      x: (cx + size / 2) * CELL, y: (cy + size / 2) * CELL, cd: 0,
    };
    this.structs.set(struct.id, struct);
    this.setCells(struct, struct);
    this.cw.setStruct(cx, cy, spec.solid, size, spec.height);
    this.structRev += 1;
    this.emit({ e: EV.S_ADD, id: struct.id, k: kind, cx, cy, tm: team, hp, mhp: hp, by: ownerId });
    return struct;
  }

  setCells(struct, value) {
    const size = BUILD[struct.kind].size || 1;
    for (let y = struct.cy; y < struct.cy + size; y++) {
      for (let x = struct.cx; x < struct.cx + size; x++) {
        if (this.cw.inBounds(x, y)) this.cellStruct[y * this.cw.cols + x] = value;
      }
    }
  }

  removeStruct(struct, why) {
    this.structs.delete(struct.id);
    this.setCells(struct, null);
    this.cw.clearStruct(struct.cx, struct.cy, BUILD[struct.kind].size || 1);
    this.dirtyStructs.delete(struct);
    this.structRev += 1;
    this.emit({ e: EV.S_DEL, id: struct.id, k: struct.kind, cx: struct.cx, cy: struct.cy, why });
  }

  // Flow costs depend on hp, so an hp change counts as a change to the structures.
  touchStruct(struct) {
    this.dirtyStructs.add(struct);
    this.structRev += 1;
  }

  colonelReacts(col, hpBefore) {
    if (this.tick - this.lastHarrumphTick >= HARRUMPH_EVERY_TICKS) {
      this.lastHarrumphTick = this.tick;
      this.sfx(SFX.HARRUMPH, col.x, col.y);
    }
    if (this.mode !== MODE.FORTWARS) return;
    for (const [fraction, line] of COLONEL_HURT_LINES) {
      const mark = fraction * col.maxHp;
      if (hpBefore > mark && col.hp <= mark) this.bark(col, line);
    }
  }

  stepStructs() {
    if (this.phase !== PHASE.FIGHT) return;
    const spec = BUILD[STRUCT.PULT];
    for (const s of this.structs.values()) {
      if (s.kind !== STRUCT.PULT) continue;
      if (s.cd > 0) {
        s.cd -= DT;
        if (s.cd > 0) continue;
      }
      const target = this.nearestEnemy(s, spec.range);
      if (target === null) continue;
      const { lob } = THROW;
      const dx = target.x - s.x;
      const dy = target.y - s.y;
      const flight = lob.minFlight + Math.sqrt(dx * dx + dy * dy) * lob.flightPerUnit;
      const tx = clamp(target.x + target.vx * flight, 0, this.map.w);
      const ty = clamp(target.y + target.vy * flight, 0, this.map.h);
      s.cd = spec.cooldown;
      this.spawnLob(s.x, s.y, s.ownerId, s.team, tx, ty, {
        dmg: spec.dmg * this.pultDamageMul(s.team), splash: spec.splash, flight, noAggro: true,
      });
      this.emit({ e: EV.PULT, id: s.id, ang: Math.atan2(ty - s.y, tx - s.x) });
    }
  }

  // Strongest single kid, not a product of everyone's: a full team stacking Spring Spoons
  // would otherwise make one flinger out-damage the whole crew.
  pultDamageMul(team) {
    let best = 1;
    for (const a of this.actors.values()) {
      if (a.kind === ACTOR.KID && a.team === team && a.mods.pultDmgMul > best) best = a.mods.pultDmgMul;
    }
    return best;
  }

  pultLimit(team) {
    if (this.mode === MODE.FFA) return 1;
    if (this.classic) return 99; // Classic limits each kid instead, in canPlace
    const { base, perPlayer } = BUILD[STRUCT.PULT].limit;
    return base + perPlayer * Math.ceil(this.weightedPlayers(team));
  }

  // ---- commands -----------------------------------------------------------------

  placementQuery(kid) {
    return {
      structs: this.structs,
      actors: this.actors,
      flakes: this.flakes[kid.team] ?? 0,
      team: kid.team,
      x: kid.x,
      y: kid.y,
      range: KID.buildRange * kid.mods.buildRangeMul,
      phase: this.phase,
      mode: this.mode,
      pultLimit: this.pultLimit(kid.team),
      spendLeft: kid.spendLeft,
      patchesLeft: this.patches[kid.team] ?? 0,
      me: kid.id,
      playersPresent: (id) => this.isPresent(id),
    };
  }

  buildingOpen(kid) {
    const open = this.phase === PHASE.BUILD || (this.phase === PHASE.FIGHT && !this.classic);
    return open && (kid.flags & AFLAG.FROZEN) === 0;
  }

  teamHasHuman(team) {
    for (const a of this.actors.values()) {
      if (a.kind === ACTOR.KID && a.team === team && !a.isBot) return true;
    }
    return false;
  }

  spend(kid, cost) {
    this.flakes[kid.team] -= cost;
    if (kid.spendLeft !== Infinity) kid.spendLeft -= cost;
    if (kid.isBot) this.botBudget[kid.team] = (this.botBudget[kid.team] ?? 0) - cost;
  }

  commandBuild(kid, cmd) {
    const { k, cx, cy } = cmd;
    if (!Number.isInteger(k) || !Number.isInteger(cx) || !Number.isInteger(cy) || !this.buildingOpen(kid)) {
      this.deny(kid, 'badCell');
      return;
    }
    const state = canPlace(this.cw, this.placementQuery(kid), k, cx, cy);
    if (state !== 'ok' && state !== 'repair' && state !== 'patch') {
      this.deny(kid, state);
      return;
    }
    const cost = this.classic ? 0 : state === 'ok' ? BUILD[k].cost : state === 'repair' ? repairCost(k) : SIEGE.colonelPatch.cost;
    // In Classic every kid owns their own three placements, bots included.
    if (kid.isBot && !this.classic && this.teamHasHuman(kid.team)) {
      // Humans decide what the team builds; bots only keep it standing, and only out of a
      // slice of the pool, so a bot can never spend the Flakes someone was saving.
      if (state !== 'repair' || (this.botBudget[kid.team] ?? 0) < cost) {
        this.deny(kid, 'limit');
        return;
      }
    }
    if (state === 'ok') {
      const toughened = k === STRUCT.WALL || k === STRUCT.ICEWALL ? kid.mods.wallHpMul : 1;
      this.spend(kid, cost);
      this.addStruct(k, cx, cy, kid.team, kid.id, BUILD[k].hp * toughened);
      kid.stats.built += 1;
      return;
    }
    const struct = this.structAt(cx, cy);
    if (state === 'repair') {
      this.spend(kid, cost);
      struct.hp = struct.maxHp;
      this.touchStruct(struct);
      return;
    }
    this.spend(kid, cost);
    this.patches[kid.team] -= 1;
    struct.hp = Math.min(struct.maxHp, struct.hp + SIEGE.colonelPatch.pct * struct.maxHp);
    this.touchStruct(struct);
  }

  commandDemolish(kid, cmd) {
    const { cx, cy } = cmd;
    if (!Number.isInteger(cx) || !Number.isInteger(cy) || !this.buildingOpen(kid)) {
      this.deny(kid, 'badCell');
      return;
    }
    const struct = this.structAt(cx, cy);
    const state = demolishState(this.placementQuery(kid), struct, kid.id);
    if (state !== 'ok') {
      this.deny(kid, state);
      return;
    }
    if (this.classic) {
      // Only your own, and the placement itself is the refund: canPlace counts what you own.
      if (struct.ownerId !== kid.id) {
        this.deny(kid, 'badCell');
        return;
      }
    } else if (struct.ownerId === kid.id || !this.isPresent(struct.ownerId)) {
      const refund = Math.floor(DEMOLISH_REFUND * BUILD[struct.kind].cost * (struct.hp / struct.maxHp));
      this.awardFlakes(kid.team, refund, struct.x, struct.y);
    } else {
      if (this.tick < kid.nextTeamDemolish) {
        this.deny(kid, 'limit');
        return;
      }
      kid.nextTeamDemolish = this.tick + ticksOf(TEAMMATE_DEMOLISH_COOLDOWN);
    }
    this.removeStruct(struct, 'demolished');
  }

  commandCard(kid, cmd) {
    if (!kid.offer) return;
    const card = kid.offer[cmd.i];
    if (card !== undefined) this.takeCard(kid, card);
  }

  commandReady(kid) {
    if (this.phase !== PHASE.BUILD || kid.isBot) return;
    if (this.readyIds.has(kid.id)) this.readyIds.delete(kid.id);
    else this.readyIds.add(kid.id);
    this.checkReady();
  }

  commandEmote(kid, cmd) {
    if (Number.isInteger(cmd.n) && cmd.n >= 0 && cmd.n < EMOTES.length) this.emit({ e: EV.EMOTE, id: kid.id, n: cmd.n });
  }

  takeCard(kid, card) {
    kid.offer = null;
    kid.cards.push(card);
    kid.mods = modsFromCards(kid.cards);
    const maxHp = KID.maxWarmth + kid.mods.maxWarmth;
    // Extra capacity arrives filled, or the card would look like it did nothing.
    if ((kid.flags & AFLAG.FROZEN) === 0) kid.hp += Math.max(0, maxHp - kid.maxHp);
    kid.maxHp = maxHp;
    kid.maxBalls = KID.maxBalls + kid.mods.maxBalls;
    this.emit({ e: EV.CARD, id: kid.id, card });
  }

  offerCards() {
    for (const kid of this.kids()) {
      const roll = rollCards(this.rng, kid.cards, 3);
      if (roll.length === 0) continue;
      if (kid.isBot) {
        this.takeCard(kid, roll[Math.floor(this.rng() * roll.length)]);
      } else {
        kid.offer = roll;
        this.emit({ e: EV.PICK_OFFER, to: kid.id, cards: [...roll] });
      }
    }
  }

  autoPickCards() {
    for (const kid of this.kids()) {
      if (kid.offer) this.takeCard(kid, kid.offer[Math.floor(this.rng() * kid.offer.length)]);
    }
  }

  readyNeed() {
    if (this.phase !== PHASE.BUILD) return [];
    const need = [];
    for (const kid of this.kids()) {
      if (!kid.isBot && (kid.flags & AFLAG.AFK) === 0) need.push(kid.id);
    }
    return need;
  }

  checkReady() {
    const need = this.readyNeed();
    if (need.length === 0 || !need.every((id) => this.readyIds.has(id))) return;
    if (this.mode === MODE.SIEGE) {
      const col = this.colonel(TEAM.A);
      const secondsLeft = (this.endsAtTick - this.tick) / SIM_HZ;
      this.awardFlakes(TEAM.A, Math.floor(secondsLeft * SIEGE.readyBonusPerSec), col.x, col.y);
    }
    this.beginFight();
  }

  // Computed at each BUILD and FIGHT start, against the pool as it stands then.
  refreshBudgets() {
    const humansByTeam = new Map();
    for (const kid of this.kids()) {
      kid.spendLeft = Infinity;
      if (kid.isBot) continue;
      if (!humansByTeam.has(kid.team)) humansByTeam.set(kid.team, []);
      humansByTeam.get(kid.team).push(kid);
    }
    for (const [team, humans] of humansByTeam) {
      const pool = this.flakes[team] ?? 0;
      this.botBudget[team] = BOT_REPAIR_SHARE * pool;
      if (humans.length < FAIR_SHARE.minHumans) continue;
      const share = Math.max(FAIR_SHARE.minFlakes, Math.ceil((FAIR_SHARE.poolMul * pool) / humans.length));
      for (const kid of humans) kid.spendLeft = share;
    }
  }

  // ---- balls --------------------------------------------------------------------

  spawnBall(fields) {
    this.nextBallId += 1;
    const ball = {
      id: this.nextBallId, t0: this.tick, n: 0, lx: 0, ly: 0, ft: 0, hitIds: null, r0: fields.r, noAggro: false, ...fields,
    };
    this.balls.set(ball.id, ball);
    // Pinned to t0, because the ball's state is its state at t0 even if it was thrown
    // outside a step; the closed form on the client counts ticks from this number.
    const record = this.ballRecord(ball);
    record.t = ball.t0;
    this.emit(record);
    return ball;
  }

  spawnLob(x, y, by, team, tx, ty, opts) {
    const { lob } = THROW;
    const dx = tx - x;
    const dy = ty - y;
    const flight = opts.flight ?? lob.minFlight + Math.sqrt(dx * dx + dy * dy) * lob.flightPerUnit;
    const ticks = Math.max(2, Math.round(flight / DT));
    const seconds = ticks * DT;
    const g = lob.gravity;
    const z0 = THROW.z0;
    const r = opts.r ?? THROW.radius;
    return this.spawnBall({
      kind: opts.kind ?? BALL.LOB, by, team, x, y, z: z0,
      vx: dx / seconds, vy: dy / seconds, vz: (g * DT * DT * ticks * (ticks - 1) / 2 - z0) / seconds, g,
      r, grow: 0, rMax: r, dmg: opts.dmg ?? lob.dmg, seq: opts.seq ?? 0, lx: tx, ly: ty, ft: ticks,
      life: ticks, roller: false, arc: true, splash: opts.splash ?? lob.splash, slow: opts.slow ?? 0, stun: 0,
      pierce: 0, structMul: 1, noAggro: opts.noAggro === true,
    });
  }

  // One shape for the `ball` event and FULL, so the client has a single code path. For
  // FULL, `ft` is what remains; for a new ball the two are the same number.
  ballRecord(b) {
    return roundNumbers({
      e: EV.BALL, id: b.id, k: b.kind, by: b.by, tm: b.team, x: b.x, y: b.y, z: b.z, vx: b.vx, vy: b.vy, vz: b.vz,
      g: b.g, r: b.r, grow: b.grow, rMax: b.rMax, seq: b.seq, lx: b.lx, ly: b.ly, ft: b.arc ? b.life - b.n : 0,
    });
  }

  stepBalls() {
    for (const b of this.balls.values()) {
      if (b.t0 < this.tick) this.advanceBall(b);
    }
  }

  advanceBall(b) {
    const fromX = b.x;
    const fromY = b.y;
    const fromZ = b.z;
    b.n += 1;
    b.x += b.vx * DT;
    b.y += b.vy * DT;
    b.z += b.vz * DT;
    b.vz -= b.g * DT;

    if (b.arc) {
      if (b.n >= b.life) {
        b.x = b.lx;
        b.y = b.ly;
        b.z = 0;
        this.burst(b, b.x, b.y);
        this.endBall(b, 'ground', 0);
      }
      return;
    }
    if (b.roller) {
      b.z = 0;
      if (b.grow > 0) b.r = Math.min(b.rMax, b.r0 + b.grow * b.n * DT);
    }
    if (this.sweepBall(b, fromX, fromY, fromZ)) return;
    if (b.x < 0 || b.y < 0 || b.x > this.map.w || b.y > this.map.h) {
      this.endBall(b, 'out', 0);
      return;
    }
    if (b.n >= b.life) {
      if (b.roller) {
        this.endBall(b, 'expire', 0);
      } else {
        b.z = 0;
        if (b.splash > 0) this.burst(b, b.x, b.y);
        this.endBall(b, 'ground', 0);
      }
    }
  }

  ballCanHit(b, a) {
    if (a.team === b.team || (a.flags & UNTOUCHABLE) !== 0) return false;
    if (a.kind === ACTOR.KID && a.slideT > 0) return false;
    return b.hitIds === null || !b.hitIds.has(a.id);
  }

  // Everything this tick's segment touches, nearest first, stopping at the first wall.
  // True when the ball is finished.
  sweepBall(b, fromX, fromY, fromZ) {
    const crusher = b.kind === BALL.BOULDER;
    // z = Infinity clears every struct height, leaving only obstacles: a boulder goes
    // through walls, hurting them, and only scenery stops it.
    const wall = raycastFlat(this.cw, fromX, fromY, b.x, b.y, crusher ? Infinity : fromZ);
    const dx = b.x - fromX;
    const dy = b.y - fromY;
    const limit = wall === null ? 1 : wall.t;
    let contacts = null;
    for (const a of this.actors.values()) {
      if (!this.ballCanHit(b, a)) continue;
      const t = segmentIntoCircle(fromX, fromY, dx, dy, a.x, a.y, a.r + b.r);
      if (t <= limit) (contacts ??= []).push({ a, t });
    }
    if (contacts !== null) {
      contacts.sort((p, q) => p.t - q.t || p.a.id - q.a.id);
      for (const { a, t } of contacts) {
        if (this.ballMeetsActor(b, a, fromX + dx * t, fromY + dy * t)) return true;
      }
    }
    if (crusher) this.crushStructs(b);
    if (wall === null) return false;
    b.x = wall.x;
    b.y = wall.y;
    this.ballMeetsWall(b, wall);
    return true;
  }

  ballMeetsActor(b, a, x, y) {
    const source = this.actors.get(b.by) ?? null;
    if (!b.roller && (a.flags & AFLAG.SHIELDED) !== 0) {
      const incoming = Math.atan2(-b.vy, -b.vx);
      if (angleGap(incoming, a.aim) <= FOES[ACTOR.LIDKID].shieldArc / 2) {
        b.x = x;
        b.y = y;
        if (b.splash > 0) this.burst(b, x, y);
        this.endBall(b, 'shield', a.id);
        return true;
      }
    }
    if (b.splash > 0) {
      b.x = x;
      b.y = y;
      this.burst(b, x, y);
      this.endBall(b, 'actor', a.id);
      return true;
    }
    const speed = Math.sqrt(b.vx * b.vx + b.vy * b.vy) || 1;
    const knock = KID.knockback / speed;
    this.damageActor(a, b.dmg, source, { kx: b.vx * knock, ky: b.vy * knock, kind: b.kind, stun: b.stun, slow: b.slow });
    if (b.roller || b.pierce > 0) {
      if (!b.roller) b.pierce -= 1;
      (b.hitIds ??= new Set()).add(a.id);
      return false;
    }
    b.x = x;
    b.y = y;
    this.endBall(b, 'actor', a.id);
    return true;
  }

  ballMeetsWall(b, wall) {
    if (wall.structCell === null) {
      if (b.splash > 0) this.burst(b, b.x, b.y);
      this.endBall(b, 'obstacle', 0);
      return;
    }
    const struct = this.structAt(wall.structCell.cx, wall.structCell.cy);
    if (b.splash > 0) this.burst(b, b.x, b.y);
    else if (struct !== null && struct.team !== b.team) this.damageStruct(struct, b.dmg * b.structMul, this.actors.get(b.by) ?? null);
    this.endBall(b, 'struct', struct?.id ?? 0);
  }

  crushStructs(b) {
    const source = this.actors.get(b.by) ?? null;
    const c0 = Math.floor((b.x - b.r) / CELL);
    const c1 = Math.floor((b.x + b.r) / CELL);
    const r0 = Math.floor((b.y - b.r) / CELL);
    const r1 = Math.floor((b.y + b.r) / CELL);
    for (let cy = r0; cy <= r1; cy++) {
      for (let cx = c0; cx <= c1; cx++) {
        const s = this.structAt(cx, cy);
        if (s === null || s.team === b.team || (b.hitIds !== null && b.hitIds.has(s.id))) continue;
        (b.hitIds ??= new Set()).add(s.id);
        this.damageStruct(s, b.dmg * BOSS.steve.boulderStructMul, source);
      }
    }
  }

  // Splash reaches a target if it touches the body, not only the centre, so a lob at
  // the Truck's bumper counts. Shields and slides are deliberately no defence here.
  burst(b, x, y) {
    this.emit({ e: EV.SPLASH, x, y, r: b.splash, k: b.kind });
    const source = this.actors.get(b.by) ?? null;
    for (const a of this.actors.values()) {
      if (a.team === b.team) continue;
      const dx = a.x - x;
      const dy = a.y - y;
      const distance = Math.sqrt(dx * dx + dy * dy);
      if (distance > b.splash + a.r) continue;
      const knock = (KID.knockback * SPLASH_KNOCK_MUL) / (distance || 1);
      this.damageActor(a, b.dmg, source, { kx: dx * knock, ky: dy * knock, kind: b.kind, slow: b.slow, noAggro: b.noAggro });
    }
    const reach = b.splash * b.splash;
    for (const s of this.structs.values()) {
      if (s.team === b.team) continue;
      const size = (BUILD[s.kind].size || 1) * CELL;
      const left = s.cx * CELL;
      const top = s.cy * CELL;
      const dx = x - clamp(x, left, left + size);
      const dy = y - clamp(y, top, top + size);
      if (dx * dx + dy * dy <= reach) this.damageStruct(s, b.dmg, source);
    }
  }

  endBall(b, why, hit) {
    this.balls.delete(b.id);
    this.emit({ e: EV.BALL_END, id: b.id, x: b.x, y: b.y, z: Math.max(0, b.z), why, hit });
  }

  clearBalls() {
    for (const b of this.balls.values()) this.endBall(b, 'expire', 0);
  }

  // ---- phases -------------------------------------------------------------------

  setPhase(phase, seconds) {
    this.phase = phase;
    this.phaseStart = this.tick;
    this.endsAtTick = seconds === null ? null : this.tick + ticksOf(seconds);
    this.readyIds.clear();
  }

  startMatch() {
    if (this.mode === MODE.SIEGE) {
      this.flakes[TEAM.A] = SIEGE.startFlakes;
      this.wave = 1;
      this.placeColonel(TEAM.A, this.map.fort, BUILD[STRUCT.COLONEL].hp);
      this.openSiegeBuild(true);
    } else if (this.mode === MODE.FORTWARS) {
      this.roundWins = { [TEAM.A]: 0, [TEAM.B]: 0 };
      this.openFortRound();
    } else if (this.classic) {
      this.roundWins = { [TEAM.A]: 0, [TEAM.B]: 0 };
      this.openClassicRound();
    } else {
      for (const p of this.players.values()) this.flakes[p.team] = FFA.startFlakes;
      this.waveMeta = { name: MODE_NAME[MODE.FFA], sub: `First to ${FFA.freezesToWin} freezes`, boss: null };
      this.openBuild(FFA.buildTime);
    }
  }

  placeColonel(team, centre, hp) {
    const col = this.addStruct(STRUCT.COLONEL, Math.round(centre.x / CELL) - 1, Math.round(centre.y / CELL) - 1, team, 0, hp);
    this.colonels.set(team, col);
    return col;
  }

  openBuild(seconds) {
    this.setPhase(PHASE.BUILD, seconds);
    for (const team of this.colonels.keys()) this.patches[team] = SIEGE.colonelPatch.perBuild;
    this.refreshBudgets();
  }

  announcePhase() {
    const info = this.waveMeta;
    if (this.phase === PHASE.BUILD) {
      if (this.mode === MODE.SIEGE && this.wave > 1) this.banner('Wave cleared!', `Next up: ${info.name}`, 'wave');
      else if (this.mode === MODE.SIEGE) this.banner(info.name, 'Build your fort!', 'wave');
      else if (this.mode === MODE.FORTWARS) this.banner(info.name, 'Truce! Build up your side.', 'wave');
      else if (this.classic) this.banner(info.name, `Place your ${CLASSIC.itemsPerKid} things!`, 'wave');
      else this.banner(info.name, 'Scatter and dig in!', 'wave');
    } else if (this.mode === MODE.SIEGE) {
      this.banner(info.name, info.sub, info.boss === null ? 'wave' : 'boss');
    } else if (this.mode === MODE.FORTWARS) {
      this.banner('The truce is over!', 'Knock down their Colonel!', 'wave');
    } else if (this.classic) {
      const sub = this.speedMul > 1 ? `Faster now: ${Math.round(this.speedMul * 100)}% speed!` : `${CLASSIC.hits} hits and you're out!`;
      this.banner('Snowballs up!', sub, 'wave');
    } else {
      this.banner('Snowballs up!', info.sub, 'wave');
    }
  }

  beginFight() {
    if (this.phase !== PHASE.BUILD) return;
    this.autoPickCards();
    if (this.teamMode) this.cw.truce = null;
    let seconds = null;
    if (this.mode === MODE.FORTWARS) seconds = FORTWARS.roundTime;
    else if (this.classic) seconds = CLASSIC.roundTime;
    else if (this.mode === MODE.FFA) seconds = FFA.matchTime;
    this.setPhase(PHASE.FIGHT, seconds);
    for (const kid of this.kids()) kid.balls = kid.maxBalls;
    this.refreshBudgets();
    this.doneTick = null;
    if (this.mode === MODE.FORTWARS) this.nextDropTick = this.tick + ticksOf(FORTWARS.pickupEvery);
    else if (this.mode === MODE.FFA) this.nextDropTick = this.tick + ticksOf(FFA.pickupEvery);
    else if (this.classic) this.nextDropTick = this.tick + ticksOf(CLASSIC.pickupEvery);
    this.announcePhase();
  }

  stepPhase() {
    this.stepDay();
    if (this.phase === PHASE.OVER) return;
    if (this.mode === MODE.SIEGE) this.stepSiege();
    else if (this.mode === MODE.FORTWARS) this.stepFortwars();
    else if (this.classic) this.stepClassic();
    else this.stepFfa();
    for (const kid of this.kids()) this.deriveKidFlags(kid);
  }

  stepBuildClock() {
    this.checkReady();
    if (this.phase === PHASE.BUILD && this.tick >= this.endsAtTick) this.beginFight();
  }

  // -- Siege --

  openSiegeBuild(first) {
    this.spawnWaitingKids();
    this.weight = this.weightedPlayers();
    const col = this.colonel(TEAM.A);
    const fraction = col.hp / col.maxHp;
    const maxHp = BUILD[STRUCT.COLONEL].hp * (1 + SIEGE.colonelHpPerExtraPlayer * (this.weight - 1));
    if (maxHp !== col.maxHp) {
      col.maxHp = maxHp;
      col.hp = fraction * maxHp;
      // sHp has no field for mhp; sAdd is an upsert on the client, so it carries the new cap.
      this.emit({ e: EV.S_ADD, id: col.id, k: col.kind, cx: col.cx, cy: col.cy, tm: col.team, hp: col.hp, mhp: maxHp, by: 0 });
    }
    this.countMul = 1 + SIEGE.perExtraPlayerCount * (this.weight - 1);
    this.waveMeta = waveInfo(this.wave, this.waveCount);
    this.runner = new WaveRunner(this, this.wave);
    this.openBuild(first ? SIEGE.firstBuildTime : SIEGE.buildTime);
    if (!first) {
      this.offerCards();
      this.announcePhase();
    }
  }

  spawnWaitingKids() {
    for (const p of this.players.values()) {
      if (this.actors.has(p.id)) continue;
      const kid = this.spawnKid(p);
      this.emit({ e: EV.RESPAWN, id: kid.id, x: kid.x, y: kid.y });
    }
  }

  stepSiege() {
    const col = this.colonel(TEAM.A);
    if (col.hp <= 0) {
      this.finish({
        title: 'Colonel Carrot is down!', winnerTeam: null, winners: [], won: false,
        summary: `Colonel Carrot toppled on wave ${this.wave}. The block belongs to the rival crews until spring.`,
      });
      return;
    }
    if (this.phase === PHASE.BUILD) {
      this.stepBuildClock();
      return;
    }
    if (!this.runner.done) return;
    this.doneTick ??= this.tick;
    let threats = 0;
    let bossLeaving = false;
    for (const foe of this.foes()) {
      const fleeing = (foe.flags & AFLAG.FLEEING) !== 0;
      if (!fleeing) threats += 1;
      else if (FOES[foe.kind].boss === true) bossLeaving = true;
    }
    if (threats > 0 && this.waveMeta.boss === null && this.tick - this.doneTick >= ticksOf(SIEGE.waveOvertime)) {
      this.banner('Lunchtime!', 'Everybody out there just went home to eat.', 'info');
      for (const foe of this.foes()) this.foeGivesUp(foe, null, false);
      threats = 0;
    }
    // A boss on its way out holds the wave open so its exit plays out in front of everyone.
    if (threats === 0 && !bossLeaving) this.clearWave();
  }

  clearWave() {
    const col = this.colonel(TEAM.A);
    this.awardFlakes(TEAM.A, SIEGE.waveBonusBase + SIEGE.waveBonusPerWave * this.wave, col.x, col.y);
    col.hp = Math.min(col.maxHp, col.hp + SIEGE.colonelRegenBetweenWaves * col.maxHp);
    this.touchStruct(col);
    this.blizzard = false;
    for (const kid of this.kids()) {
      if ((kid.flags & AFLAG.FROZEN) !== 0) this.thawKid(kid, null);
    }
    if (this.waveCount > 0 && this.wave >= this.waveCount) {
      this.finish({
        title: 'The block is yours!', winnerTeam: TEAM.A, winners: this.kids().map((k) => k.id), won: true,
        summary: `All ${this.wave} waves beaten. Colonel Carrot rules the block until spring!`,
      });
      return;
    }
    this.wave += 1;
    this.openSiegeBuild(false);
  }

  // -- Fort Face-Off --

  openFortRound() {
    this.round += 1;
    this.clearBalls();
    for (const p of this.pickups.values()) this.removePickup(p, 0);
    for (const s of this.structs.values()) this.removeStruct(s, 'reset');
    this.colonels.clear();
    let sizeA = 0;
    let sizeB = 0;
    for (const kid of this.kids()) {
      if (kid.team === TEAM.A) sizeA += 1;
      else if (kid.team === TEAM.B) sizeB += 1;
    }
    const hp = FORTWARS.colonelHp + FORTWARS.colonelHpPerExtraKid * (Math.max(sizeA, sizeB, 1) - 1);
    this.placeColonel(TEAM.A, this.map.forts[0], hp);
    this.placeColonel(TEAM.B, this.map.forts[1], hp);
    this.flakes[TEAM.A] = FORTWARS.startFlakes;
    this.flakes[TEAM.B] = FORTWARS.startFlakes;
    this.colonelDealt = { [TEAM.A]: 0, [TEAM.B]: 0 };
    this.teamFreezes = { [TEAM.A]: 0, [TEAM.B]: 0 };
    this.suddenDeath = false;
    this.cw.truce = { ...this.map.truce, active: true };
    for (const kid of this.kids()) this.resetKidForRound(kid);
    this.waveMeta = { name: `Round ${this.round}`, sub: `First to ${FORTWARS.roundsToWin}`, boss: null };
    this.openBuild(FORTWARS.buildTime);
    if (this.round > 1) this.announcePhase();
  }

  stepFortwars() {
    if (this.phase === PHASE.BUILD) {
      this.stepBuildClock();
      return;
    }
    if (this.phase === PHASE.ROUND_END) {
      if (this.tick >= this.endsAtTick) this.openFortRound();
      return;
    }
    if (!this.suddenDeath && this.tick - this.phaseStart >= ticksOf(FORTWARS.suddenDeathAt)) {
      this.suddenDeath = true;
      this.banner('Sudden Thaw!', 'Both Colonels are melting!', 'info');
    }
    const a = this.colonel(TEAM.A);
    const b = this.colonel(TEAM.B);
    if (this.suddenDeath) {
      for (const col of [a, b]) {
        this.damageStruct(col, ((FORTWARS.suddenDeathPerSec * col.maxHp) / FORTWARS.colonelHp) * DT, null);
      }
    }
    this.flakes[TEAM.A] += FORTWARS.flakePerSec * DT;
    this.flakes[TEAM.B] += FORTWARS.flakePerSec * DT;
    if (this.tick >= this.nextDropTick) {
      this.nextDropTick = this.tick + ticksOf(FORTWARS.pickupEvery);
      this.dropCentreLinePickup();
    }
    const aDown = a.hp <= 0;
    const bDown = b.hp <= 0;
    if (aDown !== bDown) {
      this.endRound(aDown ? TEAM.B : TEAM.A);
    } else if (aDown && bDown) {
      this.endRound(this.tieBreak());
    } else if (this.tick >= this.endsAtTick) {
      const fractionA = a.hp / a.maxHp;
      const fractionB = b.hp / b.maxHp;
      if (fractionA === fractionB) this.endRound(this.tieBreak());
      else this.endRound(fractionA > fractionB ? TEAM.A : TEAM.B);
    }
  }

  // -- Classic --

  classicMods() {
    const base = modsFromCards([]);
    return { ...base, speedMul: base.speedMul * this.speedMul, throwSpeedMul: base.throwSpeedMul * this.speedMul };
  }

  knockOut(kid) {
    kid.hearts = 0;
    this.freezeKid(kid, null);
  }

  openClassicRound() {
    this.round += 1;
    this.clearBalls();
    for (const p of this.pickups.values()) this.removePickup(p, 0);
    for (const s of this.structs.values()) this.removeStruct(s, 'reset');
    this.flakes[TEAM.A] = 0;
    this.flakes[TEAM.B] = 0;
    this.teamFreezes = { [TEAM.A]: 0, [TEAM.B]: 0 };
    this.roundHits = { [TEAM.A]: 0, [TEAM.B]: 0 };
    this.speedMul = Math.min(CLASSIC.maxSpeedUp, CLASSIC.speedUpPerRound ** (this.round - 1));
    this.cw.truce = { ...this.map.truce, active: true };
    for (const kid of this.kids()) this.resetKidForRound(kid);
    this.waveMeta = { name: `Round ${this.round}`, sub: `First to ${CLASSIC.roundsToWin}`, boss: null };
    this.openBuild(CLASSIC.buildTime);
    if (this.round > 1) this.announcePhase();
  }

  stepClassic() {
    if (this.phase === PHASE.BUILD) {
      this.stepBuildClock();
      return;
    }
    if (this.phase === PHASE.ROUND_END) {
      if (this.tick >= this.endsAtTick) this.openClassicRound();
      return;
    }
    if (this.tick >= this.nextDropTick) {
      this.nextDropTick = this.tick + ticksOf(CLASSIC.pickupEvery);
      const spot = this.map.pickupSpot ?? { x: this.map.w / 2, y: this.map.h / 2 };
      if (this.pickups.size === 0) this.dropPickup(spot.x, spot.y, PICKUP.ICE);
    }
    const upA = this.standing(TEAM.A);
    const upB = this.standing(TEAM.B);
    if (upA === 0 || upB === 0) {
      this.endRound(upA === upB ? this.classicTieBreak() : upA === 0 ? TEAM.B : TEAM.A);
    } else if (this.tick >= this.endsAtTick) {
      const heartsA = this.heartsLeft(TEAM.A);
      const heartsB = this.heartsLeft(TEAM.B);
      this.endRound(heartsA === heartsB ? this.classicTieBreak() : heartsA > heartsB ? TEAM.A : TEAM.B);
    }
  }

  standing(team) {
    let n = 0;
    for (const kid of this.kids()) if (kid.team === team && (kid.flags & AFLAG.FROZEN) === 0) n += 1;
    return n;
  }

  heartsLeft(team) {
    let n = 0;
    for (const kid of this.kids()) if (kid.team === team && (kid.flags & AFLAG.FROZEN) === 0) n += kid.hearts;
    return n;
  }

  classicTieBreak() {
    const a = this.roundHits[TEAM.A] ?? 0;
    const b = this.roundHits[TEAM.B] ?? 0;
    if (a !== b) return a > b ? TEAM.A : TEAM.B;
    return this.rng() < 0.5 ? TEAM.A : TEAM.B;
  }

  dropCentreLinePickup() {
    const { truce, w, h } = this.map;
    for (let tries = 0; tries < 8; tries++) {
      const along = lerp(0.15, 0.85, this.rng());
      const x = truce.axis === 'x' ? truce.at : along * w;
      const y = truce.axis === 'x' ? along * h : truce.at;
      const cell = this.cw.cellOf(x, y);
      if (!this.cw.isSolidCell(cell.cx, cell.cy)) {
        this.dropPickup(x, y);
        return;
      }
    }
  }

  tieBreak() {
    const dealtA = this.colonelDealt[TEAM.A] ?? 0;
    const dealtB = this.colonelDealt[TEAM.B] ?? 0;
    if (dealtA !== dealtB) return dealtA > dealtB ? TEAM.A : TEAM.B;
    const freezesA = this.teamFreezes[TEAM.A] ?? 0;
    const freezesB = this.teamFreezes[TEAM.B] ?? 0;
    if (freezesA !== freezesB) return freezesA > freezesB ? TEAM.A : TEAM.B;
    return this.rng() < 0.5 ? TEAM.A : TEAM.B;
  }

  endRound(winner) {
    this.roundWins[winner] += 1;
    const rules = this.classic ? CLASSIC : FORTWARS;
    const name = TEAM_NAME[winner];
    const score = `${this.roundWins[TEAM.A]} to ${this.roundWins[TEAM.B]}`;
    if (this.roundWins[winner] >= rules.roundsToWin) {
      this.finish({
        title: `${name} wins!`, winnerTeam: winner, winners: this.kids().filter((k) => k.team === winner).map((k) => k.id), won: true,
        summary: this.classic ? `${name} takes the lot, ${score}!` : `${name} takes the block, ${score}!`,
      });
      return;
    }
    this.setPhase(PHASE.ROUND_END, rules.roundEndTime);
    this.banner(`${name} wins round ${this.round}!`, score, 'info');
  }

  // -- Free-for-All --

  leaderId() {
    let best = null;
    let tied = false;
    for (const kid of this.kids()) {
      if (best === null || kid.stats.freezes > best.stats.freezes) {
        best = kid;
        tied = false;
      } else if (kid.stats.freezes === best.stats.freezes) {
        tied = true;
      }
    }
    return best !== null && !tied && best.stats.freezes > 0 ? best.id : null;
  }

  // How far this kid is ahead of everyone else; zero or less if they aren't ahead.
  leadOf(kid) {
    let nextBest = 0;
    for (const other of this.kids()) {
      if (other !== kid && other.stats.freezes > nextBest) nextBest = other.stats.freezes;
    }
    return kid.stats.freezes - nextBest;
  }

  stepFfa() {
    if (this.phase === PHASE.BUILD) {
      this.stepBuildClock();
      return;
    }
    if (this.tick >= this.nextDropTick) {
      this.nextDropTick = this.tick + ticksOf(FFA.pickupEvery);
      this.dropRandomPickup();
    }
    const kids = this.kids();
    if (this.tick >= this.endsAtTick || kids.some((k) => k.stats.freezes >= FFA.freezesToWin)) this.finishFfa(kids);
  }

  dropRandomPickup() {
    const { w, h } = this.map;
    for (let tries = 0; tries < 8; tries++) {
      const x = lerp(0.12, 0.88, this.rng()) * w;
      const y = lerp(0.12, 0.88, this.rng()) * h;
      const cell = this.cw.cellOf(x, y);
      if (!this.cw.isSolidCell(cell.cx, cell.cy)) {
        this.dropPickup(x, y);
        return;
      }
    }
  }

  finishFfa(kids) {
    let top = [];
    for (const kid of kids) {
      const best = top[0];
      if (best === undefined || kid.stats.freezes > best.stats.freezes
        || (kid.stats.freezes === best.stats.freezes && kid.stats.hits > best.stats.hits)) {
        top = [kid];
      } else if (kid.stats.freezes === best.stats.freezes && kid.stats.hits === best.stats.hits) {
        top.push(kid);
      }
    }
    const names = top.map((k) => this.players.get(k.id)?.name || 'A kid');
    this.finish({
      title: 'Snowballs down!',
      winnerTeam: top.length === 1 ? top[0].team : null,
      winners: top.map((k) => k.id),
      won: true,
      summary: top.length === 1 ? `${names[0]} is the last word in snowballs!` : `A shared win for ${names.join(' and ')}!`,
    });
  }

  // -- shared ending --

  finish(outcome) {
    this.setPhase(PHASE.OVER, null);
    const kids = this.kids();
    const awards = new Map();
    // A kid holds one award, so a kid who tops two categories keeps the first and the
    // second passes to the next best: more kids go home with a mitten.
    for (const [award, stat] of AWARDS) {
      let best = null;
      for (const kid of kids) {
        if (awards.has(kid.id) || kid.stats[stat] <= 0) continue;
        if (best === null || kid.stats[stat] > best.stats[stat]) best = kid;
      }
      if (best !== null) awards.set(best.id, award);
    }
    this.finalResult = {
      mode: this.mode,
      winnerTeam: outcome.winnerTeam,
      winners: outcome.winners,
      won: outcome.won,
      summary: outcome.summary,
      players: kids.map((kid) => ({
        id: kid.id,
        stats: { ...kid.stats, flakes: Math.floor(kid.stats.flakes) },
        award: awards.get(kid.id) ?? null,
      })),
    };
    for (const kid of kids) {
      this.clearAiming(kid);
      this.deriveKidFlags(kid);
    }
    this.banner(outcome.title, outcome.summary, outcome.won ? 'win' : 'lose');
    if (outcome.won) this.sfx(SFX.CHEER);
  }

  // -- time of day --

  dayTarget() {
    const elapsed = (this.tick - this.phaseStart) * DT;
    if (this.mode === MODE.SIEGE) {
      const span = this.waveCount > 0 ? this.waveCount : ENDLESS_DAY_WAVES;
      let within = 1;
      if (this.phase === PHASE.BUILD) {
        const length = Math.max(1, (this.endsAtTick ?? this.tick) - this.phaseStart) * DT;
        within = BUILD_SHARE_OF_DAY * Math.min(1, elapsed / length);
      } else if (this.phase === PHASE.FIGHT) {
        within = BUILD_SHARE_OF_DAY + (1 - BUILD_SHARE_OF_DAY) * (elapsed / (elapsed + FIGHT_DAY_HALF_LIFE));
      }
      return (this.wave - 1 + within) / span;
    }
    if (this.teamMode) {
      const rules = this.classic ? CLASSIC : FORTWARS;
      const rounds = rules.roundsToWin * 2 - 1;
      let within = 0;
      if (this.phase === PHASE.FIGHT) within = Math.min(1, elapsed / rules.roundTime);
      else if (this.phase !== PHASE.BUILD) within = 1;
      return (this.round - 1 + within) / rounds;
    }
    if (this.phase === PHASE.FIGHT) return Math.min(1, elapsed / FFA.matchTime);
    return this.phase === PHASE.BUILD ? 0 : 1;
  }

  // Waves end at unpredictable moments, so the target jumps; slewing hides that from the
  // sky. dayPos keeps climbing in Endless and only wraps when read.
  stepDay() {
    const gap = this.dayTarget() - this.dayPos;
    const reach = DAY_SLEW_PER_SECOND * DT;
    this.dayPos += clamp(gap, -reach, reach);
  }

  dayT() {
    const endless = this.mode === MODE.SIEGE && this.waveCount === 0;
    const position = endless ? this.dayPos % 1 : Math.min(1, this.dayPos);
    return Math.round(position * DAY_STEPS) / DAY_STEPS;
  }
}
