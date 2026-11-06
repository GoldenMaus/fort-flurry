// Fort Flurry — upgrade cards (SPEC section 4).
// Only card ids travel on the wire. Host and client each rebuild the same mods
// object from those ids, so everything here has to be a pure function of them.

export const MAX_CARD_COPIES = 3;

// A pile of Tongs must not turn packing into a machine gun, so the three timing
// multipliers bottom out. Applied once, after every card, inside modsFromCards.
const MOD_FLOORS = Object.freeze({ packTimeMul: 0.4, slideCdMul: 0.45, thawTimeMul: 0.3 });

export function defaultMods() {
  return {
    speedMul: 1, throwDmgMul: 1, throwSpeedMul: 1, maxBalls: 0, packTimeMul: 1, maxWarmth: 0,
    lobSplashMul: 1, thawTimeMul: 1, slideCdMul: 1, buildRangeMul: 1, regenMul: 1, pultDmgMul: 1,
    wallHpMul: 1, flakeBonus: 0,
  };
}

const card = (id, name, blurb, apply) => Object.freeze({ id, name, blurb, apply });

export const CARDS = Object.freeze([
  card('earmuffs', 'Fuzzy Earmuffs', '+25 max warmth. Your ears will write you a thank-you note.',
    (m) => { m.maxWarmth += 25; }),
  card('boots', 'Good Boots', '+12% speed. Grippy, waterproof, slightly smug.',
    (m) => { m.speedMul *= 1.12; }),
  card('tongs', 'Snowball Tongs', '-25% pack time. Perfect spheres, zero wet mittens.',
    (m) => { m.packTimeMul *= 0.75; }),
  card('mittens', 'Big Mittens', '+3 ball capacity. Each thumb has its own zip code.',
    (m) => { m.maxBalls += 3; }),
  card('icecore', 'Ice Core', '+20% throw damage. Technically still just snow. Technically.',
    (m) => { m.throwDmgMul *= 1.2; }),
  card('fastball', 'Fastball', '+15% throw speed and range. You saw a video about wrists.',
    (m) => { m.throwSpeedMul *= 1.15; }),
  card('bigsplat', 'Big Splat', '+30% lob splash. Everybody gets a little bit of it.',
    (m) => { m.lobSplashMul *= 1.3; }),
  card('hairdryer', 'Hair Dryer', '-40% thaw time. The cord is very, very long.',
    (m) => { m.thawTimeMul *= 0.6; }),
  card('greased', 'Greased Belly', '-35% slide cooldown. Do not ask what the grease is.',
    (m) => { m.slideCdMul *= 0.65; }),
  card('longarms', 'Long Arms', '+30% build range. Reach the top shelf of winter.',
    (m) => { m.buildRangeMul *= 1.3; }),
  card('sweater', 'Second Sweater', '+60% warmth regen. It itches, and it is worth it.',
    (m) => { m.regenMul *= 1.6; }),
  card('springspoon', 'Spring Spoon', '+30% Spoon Flinger damage for your whole team while you play.',
    (m) => { m.pultDmgMul *= 1.3; }),
  card('packedtight', 'Packed Tight', '+25% wall hp on walls you build. Pat, pat, pat.',
    (m) => { m.wallHpMul *= 1.25; }),
  card('luckymitten', 'Lucky Mitten', '+1 Flake per foe you defeat. Found it in the lost and found.',
    (m) => { m.flakeBonus += 1; }),
  card('thermos', 'Pocket Thermos', '+10 max warmth and +25% warmth regen. Tastes like soup and courage.',
    (m) => { m.maxWarmth += 10; m.regenMul *= 1.25; }),
  card('kidshovel', 'Kid-Sized Shovel', '-10% pack time and +15% build range. It came with a free blister.',
    (m) => { m.packTimeMul *= 0.9; m.buildRangeMul *= 1.15; }),
  card('socks', 'Double Socks', '+5% speed and -15% slide cooldown. Sock on sock on foot.',
    (m) => { m.speedMul *= 1.05; m.slideCdMul *= 0.85; }),
  card('windup', 'Big Windup', '+10% throw damage and +8% throw speed. You practiced on the garage door.',
    (m) => { m.throwDmgMul *= 1.1; m.throwSpeedMul *= 1.08; }),
]);

export const CARD_BY_ID = Object.freeze(Object.fromEntries(CARDS.map((c) => [c.id, c])));

function copiesOf(ids) {
  const held = new Map();
  for (const id of ids ?? []) held.set(id, (held.get(id) ?? 0) + 1);
  return held;
}

// n distinct ids, drawn without replacement, skipping anything already held three
// times. A very long Endless run can exhaust the deck, so this may return fewer than n.
export function rollCards(rng, ownedIds, n = 3) {
  const held = copiesOf(ownedIds);
  const pool = [];
  for (const c of CARDS) {
    if ((held.get(c.id) ?? 0) < MAX_CARD_COPIES) pool.push(c.id);
  }
  const picked = [];
  while (picked.length < n && pool.length > 0) {
    const i = Math.floor(rng() * pool.length);
    picked.push(pool[i]);
    pool[i] = pool[pool.length - 1];
    pool.pop();
  }
  return picked;
}

// Host and client must agree bit for bit, and float multiplication is order
// sensitive, so cards apply in table order no matter what order they were picked in.
export function modsFromCards(ids) {
  const mods = defaultMods();
  const held = copiesOf(ids);
  for (const c of CARDS) {
    const copies = Math.min(held.get(c.id) ?? 0, MAX_CARD_COPIES);
    for (let i = 0; i < copies; i++) c.apply(mods);
  }
  for (const key of Object.keys(MOD_FLOORS)) mods[key] = Math.max(mods[key], MOD_FLOORS[key]);
  return mods;
}
