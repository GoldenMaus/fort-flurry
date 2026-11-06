// Fort Flurry — the wave schedule (SPEC section 5).
// A WaveRunner is built when BUILD starts, so every roll happens up front and the preview
// the HUD shows is exactly what will arrive. update() then just plays the schedule back.
import { ACTOR, AFLAG, TEAM } from './schema.js';
import { DIFF, FOES, WAVES, WAVE_NAMES } from './constants.js';
import { COLONEL_LINES, GIVE_UP_LINES, dressFoe, say, shout } from './ai_foes.js';

const SQUAD_MIN = 3;
const SQUAD_MAX = 6;
const FIRST_SQUAD_AT = 2;
const EARLY_WAVE_ENTRANCES = 2;
const LAST_EARLY_WAVE = 4;
const ENDLESS_FROM = 9;          // past the table, waves are wave 9 with the volume turned up
const ENDLESS_COUNT_GROWTH = 1.12;
const ENDLESS_HP_GROWTH = 1.03;
const ENDLESS_BOSS_HP_STEP = 0.3;
const SPAWN_SCATTER = 44;
const SPAWN_EDGE_PAD = 26;

const SUBTITLES = Object.freeze([
  null,
  'Just the little ones. They have been planning this since breakfast.',
  'Slingers have goggles now. Nobody knows who bought the goggles.',
  'Sleds go straight. Walls stay put. You see where this is going.',
  'Look up! Lobbers sail right over your walls.',
  'That chime means trouble. Hit it while the doors are open!',
  'Dented lids block your throws. Go around them, or lob over.',
  'Carrot Thieves are after his nose! Only you can stop them.',
  'They shove walls like doors. Please do not stand behind the door.',
  'They all came. Even the kid with the cold.',
  'He has had a very bad day, and your fort is in his way.',
]);

const ENDLESS_NAMES = Object.freeze([
  'Extra Credit', 'The Long Afternoon', 'Snack Break Is Over', 'Cousins From Out of Town', 'Overtime Mittens',
  'Still Here?', 'The Cocoa Is Getting Cold', 'Detention Squad',
]);
const ENDLESS_SUBS = Object.freeze([
  'Word got around about your fort.',
  'Your mitten strings are holding up nicely.',
  'Nobody remembers who started this.',
  'Somebody should really tell their parents.',
  'The streetlights are not on yet, so it still counts.',
]);

// Wave n as a plain recipe, with the Endless rules folded in so nothing below cares which
// table row, or lack of one, it came from.
function recipeFor(n) {
  if (n <= 10) return { ...WAVES[n], foeHpMul: 1, bossHpMul: 1, foeCountMul: 1 };
  const bossHpMul = 1 + ENDLESS_BOSS_HP_STEP * Math.floor((n - 1) / 10);
  if (n % 10 === 5) return { boss: ACTOR.TRUCK, bossHpMul };
  if (n % 10 === 0) return { boss: ACTOR.STEVE, bossHpMul };
  const past = n - ENDLESS_FROM;
  return {
    ...WAVES[ENDLESS_FROM],
    foeHpMul: ENDLESS_HP_GROWTH ** past,
    foeCountMul: ENDLESS_COUNT_GROWTH ** past,
  };
}

function bossOf(n) {
  return recipeFor(n).boss ?? null;
}

export function waveInfo(n, waveCount) {
  const boss = bossOf(n);
  const finale = waveCount > 0 && n === waveCount;
  if (n <= 10) {
    const sub = finale && n === 5
      ? 'Last wave! Send that truck back to the depot and the block is yours.'
      : SUBTITLES[n] ?? '';
    return { name: WAVE_NAMES[n] ?? `Wave ${n}`, sub, boss };
  }
  if (boss === ACTOR.TRUCK) return { name: 'The Truck Is Back', sub: 'It restocked. It has more syrup than sense.', boss };
  if (boss === ACTOR.STEVE) return { name: 'Steve Again', sub: 'He says today was somehow worse.', boss };
  return { name: ENDLESS_NAMES[n % ENDLESS_NAMES.length], sub: ENDLESS_SUBS[n % ENDLESS_SUBS.length], boss };
}

function shuffle(list, rng) {
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

// Sizes between SQUAD_MIN and SQUAD_MAX adding up to total, never stranding a remainder
// too small to be a squad of its own.
function squadSizes(total, rng) {
  const sizes = [];
  let left = total;
  while (left > SQUAD_MAX) {
    let size = SQUAD_MIN + Math.floor(rng() * (SQUAD_MAX - SQUAD_MIN + 1));
    if (left - size < SQUAD_MIN) size = left - SQUAD_MIN;
    sizes.push(size);
    left -= size;
  }
  if (left > 0) sizes.push(left);
  return sizes;
}

function truckGate(map) {
  const start = map.truckPath[0];
  let best = 0;
  let bestDist = Infinity;
  map.entrances.forEach((e, i) => {
    const dist = Math.hypot(e.x - start.x, e.y - start.y);
    if (dist < bestDist) { bestDist = dist; best = i; }
  });
  return best;
}

export class WaveRunner {
  constructor(g, n) {
    this.g = g;
    this.n = n;
    this.t = 0;
    this.schedule = [];          // ordered {at, entrance, kind}, consumed from `head`
    this.head = 0;
    this.announced = false;

    const recipe = recipeFor(n);
    this.foeHpMul = recipe.foeHpMul ?? 1;
    this.bossHpMul = recipe.bossHpMul ?? 1;
    if (recipe.boss !== undefined) this.#rollBoss(recipe.boss);
    else this.#rollSquads(recipe);

    this.remaining = this.schedule.length;
    this.done = this.remaining === 0;
    this.preview = this.#buildPreview();

    // The runner for wave n is born the moment wave n-1 is won, which is his cue.
    const colonel = n > 1 ? g.colonel(TEAM.A) : null;
    if (colonel) say(g, colonel, COLONEL_LINES.waveClear, 0.8, 3);
  }

  #rollBoss(kind) {
    const { g } = this;
    const entrance = kind === ACTOR.TRUCK ? truckGate(g.map) : Math.floor(g.rng() * g.map.entrances.length);
    this.schedule.push({ at: FIRST_SQUAD_AT, entrance, kind, boss: true });
  }

  #rollSquads(recipe) {
    const { g, n } = this;
    const diff = DIFF[g.difficulty] ?? DIFF.normal;
    const roster = [];
    for (const key of Object.keys(recipe.foes)) {
      const base = recipe.foes[key] * recipe.foeCountMul;
      const count = Math.max(1, Math.round(base * diff.count * g.countMul));
      for (let i = 0; i < count; i++) roster.push(Number(key));
    }
    shuffle(roster, () => g.rng());

    const squads = [];
    let rest = roster;
    if (n === 1) {
      // The very first thing a new player ever fights: two small kids, nothing else.
      const opener = [];
      rest = roster.filter((k) => {
        if (k !== ACTOR.PIPSQUEAK || opener.length === 2) return true;
        opener.push(k);
        return false;
      });
      squads.push(opener);
    }
    let taken = 0;
    for (const size of squadSizes(rest.length, () => g.rng())) {
      squads.push(rest.slice(taken, taken + size));
      taken += size;
    }

    const all = g.map.entrances.map((_, i) => i);
    const wanted = n <= LAST_EARLY_WAVE ? Math.min(EARLY_WAVE_ENTRANCES, all.length) : all.length;
    const open = shuffle(all, () => g.rng()).slice(0, wanted);

    const gap = squads.length > 1 ? (recipe.win - FIRST_SQUAD_AT) / (squads.length - 1) : 0;
    squads.forEach((squad, i) => {
      const entrance = open[i % open.length];
      for (const kind of squad) this.schedule.push({ at: FIRST_SQUAD_AT + i * gap, entrance, kind, boss: false });
    });
  }

  #buildPreview() {
    const counts = new Map();
    const from = new Set();
    for (const item of this.schedule) {
      counts.set(item.kind, (counts.get(item.kind) ?? 0) + 1);
      from.add(item.entrance);
    }
    return {
      foes: [...counts.keys()].sort((a, b) => a - b).map((k) => ({ k, n: counts.get(k) })),
      from: [...from].sort((a, b) => a - b),
    };
  }

  #spawnPoint(entrance, boss) {
    const { g } = this;
    const e = g.map.entrances[entrance];
    if (boss) return e;
    // Scatter along the border, so a squad comes in as a little crowd and not one stack.
    const x = e.x + (g.rng() * 2 - 1) * SPAWN_SCATTER;
    const y = e.y + (g.rng() * 2 - 1) * SPAWN_SCATTER;
    const px = Math.min(g.map.w - SPAWN_EDGE_PAD, Math.max(SPAWN_EDGE_PAD, x));
    const py = Math.min(g.map.h - SPAWN_EDGE_PAD, Math.max(SPAWN_EDGE_PAD, y));
    const { cx, cy } = g.cw.cellOf(px, py);
    return g.cw.isObstacleCell(cx, cy) ? e : { x: px, y: py };
  }

  #spawn(item) {
    const { g } = this;
    const at = this.#spawnPoint(item.entrance, item.boss);
    const hpMul = item.boss ? this.bossHpMul : this.foeHpMul;
    const foe = g.spawnFoe(item.kind, at.x, at.y, { hpMul });
    if (!foe) return false;
    dressFoe(foe);
    return true;
  }

  #colonelChatter() {
    const { g } = this;
    const colonel = g.colonel(TEAM.A);
    if (!colonel || this.announced) return;
    this.announced = true;
    const boss = bossOf(this.n);
    if (boss === ACTOR.STEVE) shout(g, colonel, COLONEL_LINES.steve);
    else if (boss === null) shout(g, colonel, COLONEL_LINES.waveStart);
  }

  // Foes give up inside game.js, which does not call the AI for them, so the last words
  // come from here: the one place in the fight that looks at the whole field every tick.
  #lastWords() {
    const { g } = this;
    for (const foe of g.foes()) {
      if (!(foe.flags & AFLAG.FLEEING) || foe.ai.saidBye) continue;
      foe.ai.saidBye = true;
      if (!FOES[foe.kind].boss) say(g, foe, GIVE_UP_LINES, 0.25, 3);
    }
  }

  update() {
    const { g } = this;
    this.t += g.dt;
    this.#colonelChatter();
    this.#lastWords();
    while (this.head < this.schedule.length && this.schedule[this.head].at <= this.t) {
      // A full field holds the line here and tries again next tick, so MAX_ACTORS delays
      // foes without ever losing one.
      if (!this.#spawn(this.schedule[this.head])) break;
      this.head += 1;
    }
    this.remaining = this.schedule.length - this.head;
    this.done = this.remaining === 0;
  }
}
