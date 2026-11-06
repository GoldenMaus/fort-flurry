// The world's limited palette and the time-of-day ramp. Powder blues and lilac shadows do most of
// the work; saturated colour is reserved for things the player needs to find at a glance.
import { TEAM } from '../../shared/schema.js';
import { LOOK, TEAM_STYLE } from '../../shared/constants.js';

export const P = Object.freeze({
  snowHi: '#ffffff', snow: '#f7faff', snowMid: '#e8eefb', snowShade: '#cfd7f1', lilac: '#b8b6e4', lilacDeep: '#8f8cc8',
  plum: '#5b5694', ink: '#3b3b68',
  iceHi: '#effbff', ice: '#c4ecf6', iceMid: '#9edaee', iceDeep: '#6db6dc', iceShade: '#4f93c6',
  wood: '#b58258', woodLight: '#d6a877', woodDark: '#7f5a44', bark: '#70524e',
  pine: '#2f7069', pineDark: '#1e4d5b', pineLight: '#56a08c',
  brick: '#bd6350', brickDark: '#8e4744', stone: '#aaa6c8', stoneDark: '#7f7cab', iron: '#46507c',
  carrot: '#ee8a2c', gold: '#f4c34e', red: '#d6404e', blue: '#3a78d6', mint: '#7fd6b8',
  warm: '#ffd98a', windowHi: '#fff0b8', window: '#ffc95e',
  good: '#7ee0b0', bad: '#f0707a', repair: '#f7cf5e',
});

export const FONT_STACK = 'ui-rounded, "SF Pro Rounded", "Arial Rounded MT Bold", "Trebuchet MS", "Segoe UI", system-ui, sans-serif';

// FFA ids are 100+slot and have no TEAM_STYLE entry, so they borrow the scarf palette.
export function teamColor(team) {
  const style = TEAM_STYLE[team];
  if (style) return style.color;
  if (team >= TEAM.FFA_BASE) return LOOK.scarf[(team - TEAM.FFA_BASE) % LOOK.scarf.length];
  return '#7a78c8';
}

// Grade keyframes across the run. `mul` is the multiply tint on high; it stays gentle, because
// multiply tints shadows as hard as highlights and strong values turn the whole picture one colour.
// The colour of the hour comes from `sun`, a warm light from the upper left, set against `shade`, a
// cool light from the lower right. Both are applied with soft-light, which bends colour without
// lifting blacks, so a sunset gets richer rather than hazier.
// `flat` is the plain-alpha tint used on low. `night` drives the light mask.
const DAY_RAMP = Object.freeze([
  { t: 0.00, mul: [255, 222, 224], flat: [255, 150, 170, 0.15], night: 0.10, sun: [255, 128, 138], sunA: 0.95, shade: [140, 96, 200], shadeA: 0.42 },
  { t: 0.10, mul: [255, 238, 234], flat: [255, 190, 180, 0.09], night: 0.00, sun: [255, 176, 158], sunA: 0.62, shade: [150, 120, 216], shadeA: 0.28 },
  { t: 0.22, mul: [255, 252, 248], flat: [255, 232, 215, 0.03], night: 0.00, sun: [255, 232, 200], sunA: 0.26, shade: [160, 160, 232], shadeA: 0.16 },
  { t: 0.33, mul: [255, 255, 255], flat: [255, 255, 255, 0.00], night: 0.00, sun: [255, 250, 236], sunA: 0.12, shade: [170, 180, 240], shadeA: 0.1 },
  { t: 0.50, mul: [255, 250, 240], flat: [255, 224, 180, 0.05], night: 0.00, sun: [255, 225, 170], sunA: 0.36, shade: [150, 140, 226], shadeA: 0.2 },
  { t: 0.62, mul: [255, 236, 205], flat: [255, 186, 106, 0.16], night: 0.00, sun: [255, 172, 78], sunA: 0.85, shade: [100, 80, 200], shadeA: 0.45 },
  { t: 0.72, mul: [255, 212, 166], flat: [240, 130, 96, 0.24], night: 0.16, sun: [255, 138, 46], sunA: 1, shade: [64, 60, 186], shadeA: 0.42 },
  { t: 0.80, mul: [216, 180, 205], flat: [96, 72, 150, 0.34], night: 0.5, sun: [230, 110, 122], sunA: 0.62, shade: [50, 50, 170], shadeA: 0.62 },
  { t: 0.90, mul: [172, 176, 226], flat: [30, 42, 118, 0.44], night: 0.9, sun: [130, 130, 220], sunA: 0.2, shade: [40, 50, 150], shadeA: 0.4 },
  { t: 1.00, mul: [160, 170, 224], flat: [24, 34, 104, 0.48], night: 1.00, sun: [120, 130, 220], sunA: 0.14, shade: [36, 46, 146], shadeA: 0.4 },
]);

// Reused result object: the ramp is sampled every frame and must not allocate.
const scratch = { mul: [255, 255, 255], flat: [255, 255, 255, 0], night: 0, sun: [255, 255, 255], sunA: 0, shade: [0, 0, 0], shadeA: 0 };

export function sampleDay(dayT) {
  const t = dayT < 0 ? 0 : dayT > 1 ? 1 : dayT;
  const ramp = DAY_RAMP;
  let i = 0;
  while (i < ramp.length - 2 && ramp[i + 1].t <= t) i++;
  const a = ramp[i];
  const b = ramp[i + 1];
  const k = b.t > a.t ? Math.min(1, Math.max(0, (t - a.t) / (b.t - a.t))) : 0;
  for (let c = 0; c < 3; c++) {
    scratch.mul[c] = a.mul[c] + (b.mul[c] - a.mul[c]) * k;
    scratch.sun[c] = a.sun[c] + (b.sun[c] - a.sun[c]) * k;
    scratch.shade[c] = a.shade[c] + (b.shade[c] - a.shade[c]) * k;
  }
  for (let c = 0; c < 4; c++) scratch.flat[c] = a.flat[c] + (b.flat[c] - a.flat[c]) * k;
  scratch.night = a.night + (b.night - a.night) * k;
  scratch.sunA = a.sunA + (b.sunA - a.sunA) * k;
  scratch.shadeA = a.shadeA + (b.shadeA - a.shadeA) * k;
  return scratch;
}
