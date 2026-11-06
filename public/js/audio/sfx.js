// Fort Flurry — every sound effect, as a recipe over a Patch. No samples: snow is noise
// and filters, voices are buzz and resonance, bells are decaying sines.
//
// `pri` decides who survives when the voice cap is reached: 0 ambient texture, 1 other
// people's business, 2 things you did, 3 things you must not miss.
//
// Recipes read options from `o`, all optional: `rate` (pitch multiplier, used for
// variation), `power`, `size`, `step`, `amt`, `last`, and the kind-specific `kind`.

import { Patch } from './patch.js';

// The mix sheet, in dB against each recipe's natural level. Recipes are written for
// shape and this table is written for balance, against peaks measured through the full
// chain, so loudness is judged in one place instead of across seventy-odd recipes.
// Rough targets: ticks and tinkles -20 dB, your own actions -13 dB, big moments -8 dB.
const BALANCE = {
  whoosh: 3.5, lobToss: 2.5, iceToss: 2, slushToss: 2.5, giantRoll: -8.5, boulderRoll: -9.5,
  coneVolley: -1.5, splat: 1.5, splatHeavy: -0.5, slushSplat: 4, iceCrack: 3.5, wallThunk: 1.5,
  iceThunk: 2.5, lidClang: 5, obstacleThud: 2, metalPing: 5, furThud: 1, shove: 1, ouch: 3.5,
  hitTick: 5.5, thaw: 2.5, respawn: 4.5, flee: -1, sledBells: 3, sneakSteps: -1, bigBoots: -5.5,
  slide: 1, packPat: 4, step: 4, emote: 5, buildPop: 3, icePop: 4.5, pultBuild: -1,
  slickPop: 6.5, cocoaBuild: 2.5, repair: 2.5, wallCrumble: -1.5, iceShatter: 3.5, woodBreak: 4,
  coatPoof: 2, cocoaBreak: 5.5, slickFade: 3.5, demolish: -0.5, colonelFall: -5.5, pult: 2,
  pickupDrop: 2.5, pickup: 3, cocoaSip: 3.5, boardZip: 4.5, flake: 8, flakeBurst: 4.5,
  cardFlip: 3, cardDeal: 3.5, rumble: 2.5, poundWindup: -6, waveHorn: 3, bossHorn: 3,
  waveClear: 3, countTick: 3.5, harrumph: -2, noseGrab: 3.5, sledCrash: 2, truckDoors: 2,
  truckHorn: -4, steveRoar: -2.5, stevePound: 1, cheer: -0.5, uiClick: 4, uiHover: 7.5,
  uiDeny: -1.5,
};

const rateOf = (o) => o.rate ?? 1;

// Little sounds repeat constantly, and identical repeats are what make a game sound
// cheap. A few percent of random pitch per trigger is the cheapest fix there is.
export function jitter(spread = 0.08) {
  return 1 + (Math.random() * 2 - 1) * spread;
}

function clap(s, at, g) {
  s.noise({ color: 'pink', bp: 1500 + Math.random() * 500, q: 1.1, at, d: 0.05, g });
}

function pop(s, r, g) {
  s.tone({ f: 250 * r, to: 620 * r, a: 0.004, d: 0.085, g });
  s.noise({ color: 'pink', lp: 1500, a: 0.001, d: 0.05, g: g * 0.5 });
}

// The kazoo: a hummed note through a small resonant tube. Only the formants and the
// fast flutter separate it from any other saw wave.
function kazoo(s, at, f, seconds, g) {
  s.throat({
    f: f * 0.96, path: [[0, f * 0.94], [0.04, f]], at, a: 0.012, hold: seconds, d: 0.05, g,
    formants: [[720, 4, 1], [1450, 5, 0.75], [2500, 6, 0.3]],
    vib: { rate: 7.5, cents: 13 },
  });
}

const RECIPES = {
  // ---- Throws --------------------------------------------------------------------
  whoosh: {
    pri: 1,
    make(s, o) {
      const p = o.power ?? 0;
      const r = rateOf(o);
      const len = 0.13 + 0.1 * p;
      // Barely any extra gain for power: a constant-Q band gets louder by itself as it
      // sweeps higher, and throws are too frequent to be allowed to shout.
      s.noise({
        kind: 'bandpass', q: 1.2, a: len * 0.4, d: len * 0.62, g: 0.62 + 0.04 * p,
        path: [[0, (480 + 240 * p) * r], [len * 0.45, (1100 + 900 * p) * r], [len, (520 + 260 * p) * r]],
      });
      // Only a nearly full charge gets the low body: any earlier and it drags the sound
      // down just as the pitch is meant to be climbing.
      if (p > 0.75) s.tone({ f: 190, to: 95, a: 0.015, d: len, g: 0.14 * p });
    },
  },
  lobToss: {
    pri: 1,
    make(s, o) {
      const r = rateOf(o);
      s.noise({ kind: 'bandpass', q: 1, a: 0.1, d: 0.2, g: 0.5, path: [[0, 400 * r], [0.26, 1300 * r]] });
      s.tone({ f: 260 * r, to: 560 * r, a: 0.05, d: 0.22, g: 0.1 });
    },
  },
  iceToss: {
    pri: 1,
    make(s, o) {
      const r = rateOf(o);
      s.noise({ kind: 'bandpass', q: 1.2, a: 0.05, d: 0.11, g: 0.6, path: [[0, 700 * r], [0.07, 1900 * r], [0.16, 800 * r]] });
      s.tone({ f: 2100 * r, to: 1500 * r, a: 0.006, d: 0.2, g: 0.045 });
      s.tone({ f: 3150 * r, to: 2300 * r, a: 0.006, d: 0.13, g: 0.022 });
    },
  },
  slushToss: {
    pri: 1,
    make(s, o) {
      const r = rateOf(o);
      s.noise({ kind: 'lowpass', q: 2, a: 0.05, d: 0.13, g: 0.5, path: [[0, 500 * r], [0.08, 1500 * r], [0.18, 500 * r]] });
      s.tone({ f: 320 * r, to: 170 * r, a: 0.01, d: 0.13, g: 0.1 });
    },
  },
  giantRoll: {
    pri: 2,
    make(s) {
      const body = s.noise({ color: 'brown', lp: 480, a: 0.1, hold: 0.8, d: 0.6, g: 0.8 });
      s.wobble(body.gain, 8.5, 0.28, s.t + 0.1, s.t + 1.45);
      s.tone({ f: 62, to: 76, a: 0.1, hold: 0.7, d: 0.6, g: 0.22 });
    },
  },
  boulderRoll: {
    pri: 3,
    make(s) {
      const body = s.noise({ color: 'brown', lp: 300, a: 0.2, hold: 1.5, d: 0.9, g: 1 });
      s.wobble(body.gain, 5.5, 0.34, s.t + 0.2, s.t + 2.5);
      s.tone({ f: 44, to: 58, a: 0.2, hold: 1.4, d: 0.9, g: 0.34 });
    },
  },
  coneVolley: {
    pri: 1,
    make(s, o) {
      const r = rateOf(o);
      for (const at of [0, 0.075, 0.15]) {
        s.tone({ f: 430 * r, to: 200 * r, at, a: 0.002, d: 0.06, g: 0.24 });
        s.noise({ color: 'pink', bp: 950 * r, q: 1.6, at, d: 0.05, g: 0.42 });
      }
    },
  },

  // ---- Impacts -------------------------------------------------------------------
  splat: {
    pri: 1,
    make(s, o) {
      const r = rateOf(o);
      s.noise({ color: 'pink', lp: 1900 * r, a: 0.001, d: 0.1, g: 0.72 });
      s.noise({ bp: 2500 * r, q: 1.1, a: 0.001, d: 0.035, g: 0.17 });
      s.tone({ f: 165 * r, to: 72 * r, a: 0.002, d: 0.075, g: 0.32 });
    },
  },
  splatHeavy: {
    pri: 1,
    make(s, o) {
      const size = o.size ?? 1;
      const r = rateOf(o) / Math.sqrt(size);
      s.noise({ color: 'pink', kind: 'lowpass', q: 0.8, a: 0.002, d: 0.2, g: 0.85, path: [[0, 2200 * r], [0.2, 500 * r]] });
      s.tone({ f: 130 * r, to: 52 * r, a: 0.003, d: 0.16, g: 0.45 });
      s.noise({ bp: 1700 * r, q: 1.3, at: 0.03, d: 0.07, g: 0.14 });
    },
  },
  slushSplat: {
    pri: 1,
    make(s, o) {
      const r = rateOf(o);
      s.noise({ color: 'pink', kind: 'lowpass', q: 3, a: 0.002, d: 0.24, g: 0.6, path: [[0, 1800 * r], [0.24, 420 * r]] });
      s.tone({ f: 560 * r, to: 240 * r, a: 0.003, d: 0.11, g: 0.16 });
      s.tone({ f: 420 * r, to: 620 * r, at: 0.09, a: 0.003, d: 0.06, g: 0.09 });
    },
  },
  iceCrack: {
    pri: 1,
    make(s, o) {
      const r = rateOf(o);
      s.noise({ bp: 3000 * r, q: 1.6, a: 0.001, d: 0.028, g: 0.5 });
      for (const [f, d, g] of [[1830, 0.09, 0.07], [2610, 0.07, 0.05], [3370, 0.05, 0.03]]) s.tone({ f: f * r, a: 0.001, d, g });
      s.tone({ f: 240 * r, to: 120 * r, a: 0.001, d: 0.04, g: 0.22 });
    },
  },
  wallThunk: {
    pri: 1,
    make(s, o) {
      const r = rateOf(o);
      s.tone({ f: 150 * r, to: 62 * r, a: 0.002, d: 0.11, g: 0.5 });
      s.noise({ color: 'pink', lp: 800 * r, a: 0.001, d: 0.07, g: 0.5 });
    },
  },
  iceThunk: {
    pri: 1,
    make(s, o) {
      const r = rateOf(o);
      s.tone({ f: 300 * r, to: 170 * r, a: 0.002, d: 0.07, g: 0.34 });
      s.tone({ f: 1420 * r, a: 0.001, d: 0.11, g: 0.07 });
      s.tone({ f: 2290 * r, a: 0.001, d: 0.08, g: 0.04 });
      s.noise({ color: 'pink', bp: 1800 * r, q: 1, a: 0.001, d: 0.03, g: 0.3 });
    },
  },
  lidClang: {
    pri: 1,
    make(s, o) {
      const r = rateOf(o);
      // Inharmonic on purpose: a dented lid has no business being in tune.
      for (const [f, d, g] of [[431, 0.26, 0.13], [1187, 0.2, 0.09], [1771, 0.14, 0.06], [2523, 0.09, 0.03]]) s.tone({ f: f * r, a: 0.001, d, g });
      s.noise({ color: 'pink', bp: 1500, q: 0.8, a: 0.001, d: 0.02, g: 0.3 });
    },
  },
  obstacleThud: {
    pri: 1,
    make(s, o) {
      const r = rateOf(o);
      s.tone({ f: 210 * r, to: 105 * r, a: 0.002, d: 0.07, g: 0.32 });
      s.noise({ color: 'pink', lp: 1300 * r, a: 0.001, d: 0.045, g: 0.42 });
    },
  },
  metalPing: {
    pri: 1,
    make(s, o) {
      const r = rateOf(o);
      s.tone({ f: 618 * r, a: 0.001, d: 0.15, g: 0.12 });
      s.tone({ f: 1533 * r, a: 0.001, d: 0.09, g: 0.05 });
      s.noise({ color: 'pink', lp: 1800, a: 0.001, d: 0.06, g: 0.42 });
    },
  },
  furThud: {
    pri: 1,
    make(s, o) {
      const r = rateOf(o);
      s.tone({ f: 120 * r, to: 66 * r, a: 0.003, d: 0.1, g: 0.42 });
      s.noise({ color: 'pink', lp: 620 * r, a: 0.002, d: 0.09, g: 0.5 });
    },
  },
  shove: {
    pri: 2,
    make(s, o) {
      const r = rateOf(o);
      s.tone({ f: 112 * r, to: 55 * r, a: 0.003, d: 0.14, g: 0.55 });
      s.noise({ color: 'brown', lp: 500, a: 0.002, d: 0.11, g: 0.8 });
    },
  },
  // You got hit. Must read over everything, without ever being unpleasant to hear
  // fifty times a match: a soft cartoon "oof" rather than a pain noise.
  ouch: {
    pri: 3,
    make(s, o) {
      const r = rateOf(o);
      s.throat({ f: 232 * r, to: 150 * r, a: 0.01, d: 0.15, g: 0.85, formants: [[520, 4, 1], [1150, 6, 0.4]] });
      s.noise({ color: 'pink', lp: 1700, a: 0.001, d: 0.1, g: 0.62 });
      s.tone({ f: 130, to: 62, a: 0.002, d: 0.1, g: 0.32 });
    },
  },
  // Your throw landed. Tiny, and bright enough to pick out of a crowded fight.
  hitTick: {
    pri: 2,
    make(s, o) {
      const r = rateOf(o);
      s.tone({ f: 1320 * r, a: 0.001, d: 0.055, g: 0.14 });
      s.tone({ f: 2640 * r, a: 0.001, d: 0.025, g: 0.045 });
    },
  },

  // ---- Kids ----------------------------------------------------------------------
  freeze: {
    pri: 3,
    make(s) {
      // E minor falling: the temperature dropping in four notes.
      [[1319, 0], [988, 0.055], [784, 0.11], [659, 0.17]].forEach(([f, at], i) => s.ding(f, { at, d: 0.62 - i * 0.05, g: 0.17, shine: 0.3 }));
      s.noise({ hp: 3000, a: 0.01, d: 0.3, g: 0.09 });
      s.tone({ f: 160, to: 90, a: 0.002, d: 0.1, g: 0.22 });
    },
  },
  thaw: {
    pri: 2,
    make(s) {
      // The same notes rising and turned major: the freeze undone.
      [[659, 0], [831, 0.07], [988, 0.14], [1319, 0.22]].forEach(([f, at]) => {
        s.ding(f, { at, d: 0.42, g: 0.14 });
        s.tone({ f: f * 1.006, at, a: 0.02, d: 0.3, g: 0.05 });
      });
      s.noise({ kind: 'bandpass', q: 0.7, a: 0.2, d: 0.34, g: 0.08, path: [[0, 900], [0.5, 2800]] });
    },
  },
  respawn: {
    pri: 2,
    make(s) {
      s.tone({ f: 392, to: 784, a: 0.02, d: 0.2, g: 0.16 });
      s.noise({ color: 'pink', lp: 1400, a: 0.01, d: 0.12, g: 0.2 });
      s.ding(1175, { at: 0.12, d: 0.3, g: 0.11 });
    },
  },
  // A foe gives up: a little slide whistle down, so a wave collapsing sounds funny
  // rather than violent.
  flee: {
    pri: 0,
    make(s, o) {
      const r = rateOf(o);
      s.tone({ path: [[0, 840 * r], [0.07, 900 * r], [0.34, 340 * r]], a: 0.02, hold: 0.14, d: 0.2, g: 0.13, vib: { rate: 9, cents: 22 } });
    },
  },
  foeArrive: {
    pri: 0,
    make(s, o) {
      const r = rateOf(o);
      s.noise({ color: 'pink', lp: 1000, a: 0.008, d: 0.12, g: 0.36 });
      s.tone({ f: 330 * r, to: 240 * r, a: 0.004, d: 0.07, g: 0.1 });
    },
  },
  sledBells: {
    pri: 1,
    make(s) {
      [0, 0.07, 0.14, 0.21, 0.28].forEach((at, i) => s.ding(i % 2 ? 2349 : 2093, { at, d: 0.1, g: 0.06, shine: 0 }));
      s.noise({ kind: 'bandpass', q: 0.7, a: 0.05, d: 0.32, g: 0.26, path: [[0, 1400], [0.36, 700]] });
    },
  },
  sneakSteps: {
    pri: 1,
    make(s) {
      // Pizzicato tiptoes: the universal sound of someone who shouldn't be here.
      [[392, 0], [349, 0.13], [392, 0.26], [466, 0.39]].forEach(([f, at]) => s.tone({ type: 'triangle', f, at, a: 0.002, d: 0.06, g: 0.2 }));
    },
  },
  bigBoots: {
    pri: 1,
    make(s) {
      for (const at of [0, 0.3]) {
        s.tone({ f: 96, to: 52, at, a: 0.003, d: 0.13, g: 0.42 });
        s.noise({ color: 'pink', lp: 620, at, a: 0.002, d: 0.07, g: 0.42 });
      }
    },
  },
  slide: {
    pri: 2,
    make(s) {
      s.noise({ kind: 'bandpass', q: 0.9, a: 0.015, d: 0.32, g: 0.85, path: [[0, 1700], [0.33, 460]] });
      s.noise({ color: 'pink', lp: 700, a: 0.03, d: 0.26, g: 0.32 });
    },
  },
  packPat: {
    pri: 0,
    make(s) {
      s.noise({ color: 'pink', lp: 1900, a: 0.001, d: 0.045, g: 0.42 });
      s.noise({ color: 'pink', bp: 950, q: 1, at: 0.055, a: 0.001, d: 0.04, g: 0.34 });
    },
  },
  step: {
    pri: 0,
    make(s, o) {
      const r = rateOf(o);
      s.noise({ color: 'pink', bp: 900 * r, q: 0.7, a: 0.004, d: 0.05, g: 0.2 });
    },
  },
  emote: {
    pri: 1,
    make(s, o) {
      const r = rateOf(o);
      s.throat({ f: 400 * r, to: 540 * r, a: 0.012, d: 0.1, g: 0.5, formants: [[820, 5, 1], [1850, 7, 0.5]] });
    },
  },

  // ---- Building ------------------------------------------------------------------
  buildPop: { pri: 1, make(s, o) { pop(s, rateOf(o), 0.3); } },
  icePop: {
    pri: 1,
    make(s, o) {
      const r = rateOf(o);
      pop(s, r * 1.5, 0.22);
      s.ding(2093 * r, { at: 0.02, d: 0.16, g: 0.06, shine: 0 });
    },
  },
  coatFlop: {
    pri: 1,
    make(s, o) {
      const r = rateOf(o);
      s.noise({ color: 'pink', lp: 900, a: 0.012, d: 0.14, g: 0.6 });
      s.tone({ f: 165 * r, to: 100 * r, a: 0.006, d: 0.1, g: 0.24 });
    },
  },
  pultBuild: {
    pri: 1,
    make(s, o) {
      const r = rateOf(o);
      s.tone({ type: 'triangle', f: 520 * r, a: 0.001, d: 0.04, g: 0.26 });
      s.tone({ type: 'triangle', f: 390 * r, at: 0.075, a: 0.001, d: 0.05, g: 0.26 });
      s.noise({ color: 'pink', bp: 1200, q: 2, a: 0.001, d: 0.02, g: 0.26 });
    },
  },
  slickPop: {
    pri: 1,
    make(s, o) {
      const r = rateOf(o);
      s.noise({ kind: 'bandpass', q: 1, a: 0.03, d: 0.14, g: 0.3, path: [[0, 800 * r], [0.17, 2200 * r]] });
      s.tone({ f: 500 * r, to: 900 * r, a: 0.01, d: 0.12, g: 0.08 });
    },
  },
  cocoaBuild: {
    pri: 1,
    make(s, o) {
      const r = rateOf(o);
      s.tone({ type: 'triangle', f: 470 * r, a: 0.001, d: 0.045, g: 0.26 });
      s.tone({ f: 620 * r, to: 900 * r, at: 0.07, a: 0.003, d: 0.05, g: 0.15 });
      s.tone({ f: 720 * r, to: 1080 * r, at: 0.13, a: 0.003, d: 0.05, g: 0.12 });
    },
  },
  repair: {
    pri: 1,
    make(s, o) {
      const r = rateOf(o);
      pop(s, r, 0.2);
      s.tone({ f: 590 * r, to: 1180 * r, at: 0.075, a: 0.003, d: 0.09, g: 0.15 });
    },
  },
  wallCrumble: {
    pri: 2,
    make(s, o) {
      const r = rateOf(o);
      s.noise({ color: 'pink', kind: 'lowpass', q: 0.7, a: 0.003, d: 0.34, g: 1, path: [[0, 1700 * r], [0.34, 300 * r]] });
      s.tone({ f: 128 * r, to: 48 * r, a: 0.003, d: 0.24, g: 0.42 });
      for (const at of [0.05, 0.11, 0.18]) s.noise({ color: 'pink', bp: 1300 * r, q: 2.2, at, a: 0.001, d: 0.03, g: 0.3 });
    },
  },
  iceShatter: {
    pri: 2,
    make(s, o) {
      const r = rateOf(o);
      s.noise({ hp: 2200, a: 0.001, d: 0.14, g: 0.2 });
      s.tone({ f: 190, to: 90, a: 0.002, d: 0.09, g: 0.32 });
      for (let i = 0; i < 7; i++) {
        s.ding((1500 + Math.random() * 1900) * r, { at: Math.random() * 0.13, d: 0.11 + Math.random() * 0.14, g: 0.055, shine: 0 });
      }
    },
  },
  woodBreak: {
    pri: 2,
    make(s, o) {
      const r = rateOf(o);
      s.noise({ color: 'pink', bp: 1300 * r, q: 1.4, a: 0.001, d: 0.05, g: 0.8 });
      s.tone({ type: 'triangle', f: 300 * r, to: 110 * r, a: 0.001, d: 0.08, g: 0.32 });
      s.tone({ type: 'triangle', f: 460 * r, to: 230 * r, at: 0.07, a: 0.001, d: 0.05, g: 0.2 });
      s.tone({ type: 'triangle', f: 340 * r, to: 170 * r, at: 0.14, a: 0.001, d: 0.04, g: 0.15 });
    },
  },
  coatPoof: {
    pri: 1,
    make(s) {
      s.noise({ color: 'pink', lp: 1100, a: 0.012, d: 0.2, g: 0.62 });
      s.tone({ f: 300, to: 130, a: 0.01, d: 0.14, g: 0.08 });
    },
  },
  cocoaBreak: {
    pri: 2,
    make(s, o) {
      const r = rateOf(o);
      s.ding(1760 * r, { d: 0.14, g: 0.1, shine: 0.4 });
      s.ding(2489 * r, { at: 0.03, d: 0.1, g: 0.07, shine: 0 });
      s.noise({ color: 'pink', bp: 1100, q: 1.3, a: 0.001, d: 0.06, g: 0.5 });
      s.tone({ f: 260, to: 120, a: 0.002, d: 0.08, g: 0.2 });
    },
  },
  slickFade: {
    pri: 0,
    make(s) {
      s.noise({ bp: 1400, q: 0.8, a: 0.02, d: 0.12, g: 0.18 });
    },
  },
  demolish: {
    pri: 1,
    make(s) {
      s.noise({ color: 'pink', kind: 'lowpass', q: 0.7, a: 0.012, d: 0.22, g: 0.7, path: [[0, 1200], [0.22, 320]] });
      s.tone({ f: 300, to: 140, a: 0.008, d: 0.15, g: 0.15 });
    },
  },
  // The Colonel coming down is the end of the run, so it gets the longest fall in the
  // game: a slow crumble under a sliding sigh.
  colonelFall: {
    pri: 3,
    make(s) {
      s.noise({ color: 'brown', lp: 800, a: 0.02, hold: 0.25, d: 1, g: 1 });
      s.noise({ color: 'pink', kind: 'lowpass', q: 0.7, a: 0.01, d: 0.62, g: 0.8, path: [[0, 2000], [0.6, 300]] });
      s.tone({ f: 112, to: 40, a: 0.01, hold: 0.1, d: 0.8, g: 0.5 });
      s.throat({ path: [[0, 150], [1, 74]], at: 0.12, a: 0.06, hold: 0.3, d: 0.65, g: 0.36, formants: [[500, 5, 1], [900, 6, 0.4]] });
    },
  },
  pult: {
    pri: 1,
    make(s, o) {
      const r = rateOf(o);
      s.noise({ color: 'pink', bp: 620, q: 1.4, a: 0.002, d: 0.05, g: 0.6 });
      s.tone({ type: 'triangle', path: [[0, 188 * r], [0.03, 150 * r], [0.25, 124 * r]], a: 0.002, d: 0.24, g: 0.34, vib: { rate: 19, cents: 34 } });
      s.tone({ type: 'triangle', f: 760 * r, a: 0.001, d: 0.03, g: 0.14 });
    },
  },

  // ---- Pickups and rewards -------------------------------------------------------
  pickupDrop: {
    pri: 0,
    make(s) {
      s.ding(1319, { d: 0.22, g: 0.08, shine: 0 });
      s.ding(1760, { at: 0.07, d: 0.3, g: 0.08, shine: 0 });
    },
  },
  pickup: {
    pri: 2,
    make(s, o) {
      // Each special has its own rising figure, so you can tell what you grabbed by ear.
      const figures = {
        ice: [988, 1319, 1976], slush: [523, 659, 880], triple: [784, 784, 1175], giant: [392, 523, 784],
      };
      const notes = figures[o.kind] ?? figures.triple;
      notes.forEach((f, i) => s.ding(f, { at: i * 0.06, d: 0.26, g: 0.15 }));
    },
  },
  cocoaSip: {
    pri: 2,
    make(s) {
      const sip = s.tone({ f: 290, to: 620, a: 0.04, d: 0.2, g: 0.14 });
      s.wobble(sip.gain, 24, 0.08, s.t, s.t + 0.24);
      s.noise({ color: 'pink', bp: 900, q: 1, a: 0.04, d: 0.18, g: 0.14 });
      s.ding(784, { at: 0.2, d: 0.36, g: 0.11, shine: 0.1 });
      s.ding(988, { at: 0.27, d: 0.36, g: 0.1, shine: 0.1 });
    },
  },
  boardZip: {
    pri: 2,
    make(s) {
      s.noise({ kind: 'bandpass', q: 1.2, a: 0.03, d: 0.3, g: 0.62, path: [[0, 600], [0.32, 2200]] });
      s.tone({ f: 340, to: 930, a: 0.02, d: 0.28, g: 0.12 });
    },
  },
  flake: {
    pri: 1,
    make(s, o) {
      // Rapid defeats climb a pentatonic ladder, so a good streak sounds like a run up a
      // music box. Pentatonic so that any two rungs sound fine together.
      const ladder = [1568, 1760, 1976, 2349, 2637, 3136];
      const f = ladder[Math.min(ladder.length - 1, o.step ?? 0)];
      s.ding(f, { d: 0.22, g: 0.095, shine: 0 });
      s.ding(f * 1.5, { at: 0.035, d: 0.13, g: 0.035, shine: 0 });
    },
  },
  flakeBurst: {
    pri: 2,
    make(s) {
      [1175, 1319, 1568, 1976, 2349].forEach((f, i) => s.ding(f, { at: i * 0.05, d: 0.3, g: 0.09, shine: 0 }));
    },
  },
  cardFlip: {
    pri: 2,
    make(s) {
      s.noise({ color: 'pink', bp: 2600, q: 1, a: 0.002, d: 0.025, g: 0.75 });
      s.noise({ color: 'pink', bp: 1700, q: 1, at: 0.05, a: 0.002, d: 0.035, g: 0.62 });
    },
  },
  cardDeal: {
    pri: 2,
    make(s) {
      for (const at of [0, 0.09, 0.18]) s.noise({ color: 'pink', bp: 2300, q: 1, at, a: 0.002, d: 0.03, g: 0.6 });
      s.ding(1319, { at: 0.26, d: 0.34, g: 0.1 });
      s.ding(1976, { at: 0.33, d: 0.34, g: 0.08 });
    },
  },

  // ---- World ---------------------------------------------------------------------
  rumble: {
    pri: 2,
    make(s, o) {
      const amt = o.amt ?? 0.5;
      s.tone({ f: 62, to: 36, a: 0.01, d: 0.25 + 0.3 * amt, g: 0.5 * amt });
      s.noise({ color: 'brown', lp: 260, a: 0.01, d: 0.3 + 0.35 * amt, g: 0.8 * amt });
    },
  },
  // Your cue to get out of Steve's way. Rising, because the danger is rising.
  poundWindup: {
    pri: 3,
    make(s) {
      s.tone({ f: 70, to: 150, a: 0.6, d: 0.2, g: 0.22 });
      s.noise({ color: 'brown', kind: 'lowpass', q: 1, a: 0.68, d: 0.12, g: 0.8, path: [[0, 180], [0.8, 700]] });
    },
  },
  waveHorn: {
    pri: 3,
    make(s) {
      kazoo(s, 0, 392, 0.075, 0.5);
      kazoo(s, 0.155, 392, 0.075, 0.5);
      kazoo(s, 0.31, 523, 0.34, 0.6);
    },
  },
  bossHorn: {
    pri: 3,
    make(s) {
      kazoo(s, 0, 262, 0.16, 0.55);
      kazoo(s, 0.27, 311, 0.16, 0.55);
      kazoo(s, 0.54, 262, 0.46, 0.62);
    },
  },
  waveClear: {
    pri: 2,
    make(s) {
      [[784, 0], [988, 0.09], [1175, 0.18], [1568, 0.3]].forEach(([f, at]) => s.ding(f, { at, d: 0.5, g: 0.13 }));
    },
  },
  countTick: {
    pri: 2,
    make(s, o) {
      const f = o.last ? 1320 : 990;
      s.tone({ f, a: 0.001, d: 0.06, g: 0.2 });
      s.tone({ f: f * 2.3, a: 0.001, d: 0.025, g: 0.06 });
    },
  },

  // ---- Named by the simulation (SFX in schema.js) ---------------------------------
  harrumph: {
    pri: 3,
    make(s) {
      // Two syllables, and the second one shuts the mouth: the vowel filter closes as the
      // pitch sinks, which is what turns a buzz into a disgruntled officer.
      s.throat({ path: [[0, 102], [0.08, 128], [0.21, 96]], a: 0.022, hold: 0.09, d: 0.1, g: 1.1, formants: [[[[0, 480], [0.21, 620]], 4, 1]], vib: { rate: 26, cents: 18 } });
      s.throat({ path: [[0, 96], [0.2, 66]], at: 0.24, a: 0.02, hold: 0.06, d: 0.15, g: 1.05, formants: [[[[0, 620], [0.2, 240]], 3, 1]], vib: { rate: 22, cents: 14 } });
      s.noise({ color: 'pink', lp: 420, at: 0.25, a: 0.01, d: 0.11, g: 0.16 });
    },
  },
  noseGrab: {
    pri: 3,
    make(s) {
      s.tone({ f: 300, to: 1500, a: 0.004, d: 0.085, g: 0.18 });
      s.noise({ color: 'pink', bp: 1900, q: 1.6, at: 0.09, a: 0.001, d: 0.02, g: 0.6 });
      [[784, 0.14], [622, 0.26], [466, 0.38]].forEach(([f, at]) => s.tone({ type: 'triangle', f, at, a: 0.002, d: 0.08, g: 0.2 }));
    },
  },
  sledCrash: {
    pri: 3,
    make(s) {
      s.noise({ color: 'pink', bp: 1100, q: 1.2, a: 0.001, d: 0.07, g: 0.9 });
      s.noise({ color: 'pink', kind: 'lowpass', q: 0.7, a: 0.002, d: 0.3, g: 0.75, path: [[0, 1900], [0.3, 340]] });
      s.tone({ f: 140, to: 52, a: 0.002, d: 0.17, g: 0.5 });
      [[2093, 0.06], [2349, 0.13], [1760, 0.2], [2093, 0.3]].forEach(([f, at]) => s.ding(f, { at, d: 0.1, g: 0.05, shine: 0 }));
    },
  },
  truckDoors: {
    pri: 3,
    make(s) {
      s.tone({ f: 185, to: 118, a: 0.002, d: 0.07, g: 0.4 });
      s.noise({ color: 'pink', bp: 1700, q: 1.4, a: 0.001, d: 0.025, g: 0.6 });
      s.noise({ hp: 2200, at: 0.1, a: 0.06, d: 0.42, g: 0.09 });
      const creak = s.throat({ path: [[0, 300], [0.42, 248]], at: 0.08, a: 0.03, hold: 0.22, d: 0.14, g: 0.34, formants: [[880, 8, 1], [1500, 9, 0.5]] });
      s.wobble(creak.gain, 31, 0.1, s.t + 0.08, s.t + 0.47);
      s.tone({ f: 150, to: 92, at: 0.54, a: 0.002, d: 0.07, g: 0.32 });
    },
  },
  truckHorn: {
    pri: 3,
    make(s) {
      // A flat, unmusical pair of notes on purpose: this is a van, not a fanfare.
      for (const [at, hold, droop] of [[0, 0.1, 1], [0.21, 0.26, 0.93]]) {
        for (const f of [311, 392]) {
          s.throat({ path: [[0, f], [hold + 0.06, f * droop]], at, a: 0.012, hold, d: 0.07, g: 0.6, formants: [[640, 2.5, 1], [1250, 3.5, 0.55]] });
        }
      }
    },
  },
  steveRoar: {
    pri: 3,
    make(s) {
      // More tired groan than threat: the pitch rises like a roar, then sags into a long
      // sigh. Keeps Steve a sad big fellow, not a monster.
      const vowel = [[[0, 400], [0.25, 780], [1.3, 330]], 3.5, 1];
      const upper = [[[0, 900], [0.25, 1300], [1.3, 700]], 5, 0.42];
      for (const cents of [1, 1.012]) {
        s.throat({ path: [[0, 84 * cents], [0.2, 126 * cents], [0.75, 106 * cents], [1.35, 58 * cents]], a: 0.09, hold: 0.55, d: 0.76, g: 0.68, formants: [vowel, upper], vib: { rate: 8, cents: 26 } });
      }
      s.noise({ color: 'brown', lp: 520, a: 0.1, hold: 0.4, d: 0.8, g: 0.62 });
      s.noise({ color: 'pink', kind: 'bandpass', q: 0.8, at: 1.15, a: 0.14, d: 0.62, g: 0.22, path: [[0, 950], [0.75, 420]] });
    },
  },
  stevePound: {
    pri: 3,
    make(s) {
      s.tone({ f: 92, to: 30, a: 0.003, d: 0.5, g: 1 });
      s.noise({ color: 'brown', lp: 340, a: 0.002, d: 0.55, g: 1 });
      s.noise({ color: 'pink', kind: 'lowpass', q: 0.7, a: 0.002, d: 0.22, g: 0.7, path: [[0, 1400], [0.22, 280]] });
      // Snow pattering down afterward is what sells how hard he hit.
      for (let i = 0; i < 6; i++) s.noise({ color: 'pink', bp: 1500 + Math.random() * 900, q: 1.5, at: 0.2 + i * 0.075 + Math.random() * 0.04, a: 0.001, d: 0.03, g: 0.15 });
    },
  },
  cheer: {
    pri: 3,
    make(s) {
      // A crowd of kids is a handful of voices that never quite agree, over a wash of
      // breath and hands. The disagreement is the whole trick.
      for (let i = 0; i < 6; i++) {
        const f = 270 + Math.random() * 230;
        const at = Math.random() * 0.14;
        s.throat({
          path: [[0, f * 0.86], [0.24, f * 1.22], [1.3, f * 1.04]], at, a: 0.1, hold: 0.55, d: 0.65, g: 0.3,
          formants: [[820 + Math.random() * 320, 5, 1], [1750 + Math.random() * 300, 7, 0.42]],
          vib: { rate: 5 + Math.random() * 2.5, cents: 28 },
        });
      }
      s.noise({ color: 'pink', bp: 1250, q: 0.5, a: 0.2, hold: 0.5, d: 0.7, g: 0.3 });
      for (let i = 0; i < 12; i++) clap(s, 0.18 + Math.random() * 1.15, 0.2);
    },
  },

  // ---- Interface -----------------------------------------------------------------
  uiClick: {
    pri: 2,
    make(s) {
      s.tone({ f: 880, to: 640, a: 0.001, d: 0.032, g: 0.16 });
      s.tone({ f: 1760, a: 0.001, d: 0.014, g: 0.035 });
    },
  },
  uiHover: {
    pri: 0,
    make(s) {
      s.tone({ f: 1320, a: 0.002, d: 0.022, g: 0.038 });
    },
  },
  uiJoin: {
    pri: 2,
    make(s) {
      [[784, 0], [1175, 0.09], [1568, 0.18]].forEach(([f, at]) => s.ding(f, { at, d: 0.55, g: 0.15, shine: 0.25 }));
    },
  },
  // Soft and low: being told no should never sound like being told off.
  uiDeny: {
    pri: 2,
    make(s) {
      s.tone({ type: 'triangle', f: 196, a: 0.004, d: 0.075, g: 0.24 });
      s.tone({ type: 'triangle', f: 175, at: 0.105, a: 0.004, d: 0.11, g: 0.24 });
    },
  },
};

export const SOUNDS = Object.freeze(RECIPES);
export const SOUND_NAMES = Object.freeze(Object.keys(RECIPES));

/**
 * Builds one voice on the mixer's sfx bus and returns its record. Spatial options:
 * `gain`, `pan` (-1..1), `muffle` (low-pass Hz, distance loses the top end first) and
 * `wet` (reverb send, which rises with distance).
 */
export function startVoice(mix, name, o, when) {
  const { ctx, kit } = mix;
  const recipe = SOUNDS[name];
  const input = ctx.createGain();
  input.gain.value = (o.gain ?? 1) * 10 ** ((BALANCE[name] ?? 0) / 20);
  const chain = [input];
  let tail = input;
  if (o.muffle) {
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = o.muffle;
    filter.Q.value = 0.5;
    tail.connect(filter);
    tail = filter;
    chain.push(filter);
  }
  if (o.pan) {
    const panner = ctx.createStereoPanner();
    panner.pan.value = o.pan;
    tail.connect(panner);
    tail = panner;
    chain.push(panner);
  }
  tail.connect(mix.sfx);
  if (o.wet) {
    const send = ctx.createGain();
    send.gain.value = o.wet;
    tail.connect(send).connect(mix.sfxWet);
    chain.push(send);
  }
  const patch = new Patch(ctx, kit, input, when);
  recipe.make(patch, o);
  return { name, pri: recipe.pri, born: when, end: patch.end, chain, sources: patch.sources };
}

/** Lets go of a finished voice's strip so nothing keeps it reachable. */
export function releaseVoice(voice) {
  for (const node of voice.chain) node.disconnect();
}

/** Cuts a live voice short with a fast fade, so stealing it doesn't click. */
export function silenceVoice(voice, now) {
  voice.chain[0].gain.setTargetAtTime(0, now, 0.006);
  for (const source of voice.sources) {
    try {
      source.stop(now + 0.03);
    } catch {
      // Already ended between the sweep and here: nothing left to stop.
    }
  }
}
