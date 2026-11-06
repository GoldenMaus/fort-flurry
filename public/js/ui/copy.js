// Every player-facing sentence the spec fixes word for word, kept in one place so wording can be
// checked against docs/SPEC.md section 11 at a glance.
import { ERR, CLOSE, MODE, DIFFICULTY } from '../../shared/schema.js';

export const ERROR_COPY = Object.freeze({
  [ERR.NO_ROOM]: (code) => `Can't find room ${code}. Check the code with your friend.`,
  [ERR.ROOM_FULL]: (code) => `Room ${code} is full.`,
  [ERR.BAD_VERSION]: () => 'Fort Flurry was updated. Reload to join.',
  [ERR.SERVER_FULL]: () => 'The server is packed. Try again soon.',
  [ERR.TIMEOUT]: (code) => `Couldn't reach room ${code}. The host may be offline, or this network blocks direct connections.`,
  [ERR.NET]: () => "Can't reach the online service. Play Solo still works.",
  [CLOSE.KICKED]: () => 'The host removed you from the room.',
  [CLOSE.HOST_LEFT]: () => 'The host left. Thanks for playing!',
  [CLOSE.NET_LOST]: () => 'Connection lost.',
  [CLOSE.REPLACED]: () => 'You joined from another tab.',
  [ERR.RATE]: () => 'Disconnected for sending too much.',
});

export const ERROR_ACTION = Object.freeze({
  [ERR.NO_ROOM]: 'Try another code',
  [ERR.BAD_VERSION]: 'Reload',
  [ERR.TIMEOUT]: 'Retry',
});

export const DENY_COPY = Object.freeze({
  noFlakes: 'Not enough Flakes',
  badCell: "Can't build there",
  tooFar: 'Too far away',
  limit: 'Build limit reached',
  noBalls: 'Out of snow! Stand still to pack.',
});

export const TAGLINE = "It's the first big snowfall of winter, and whichever fort is still standing at nightfall rules the block until spring.";

export const PREMISE = [
  "It's the first big snowfall of winter, and the town has one tradition: whichever fort is still standing at nightfall rules the block until spring.",
  'Your crew has built yours around Colonel Carrot, a giant snowman in a bucket helmet, and rival crews from across town are marching in to knock him down.',
];

export const ROUND_STEPS = [
  { title: 'Build', text: 'Spend Flakes on snow walls, spare coats, spoon flingers and cocoa stands.' },
  { title: 'Fight', text: 'Throw, lob, dodge, pack more snow, and thaw frozen friends.' },
  { title: 'Upgrade', text: 'Between waves everyone picks a card.' },
  { title: 'Hold the block', text: "Beat wave 5's Sno-Cone Truck and wave 10's Abominable Steve." },
];

export const MODE_BLURB = Object.freeze({
  [MODE.SIEGE]: 'Everyone together. Keep Colonel Carrot standing through every wave.',
  [MODE.FORTWARS]: 'Two teams, two Colonels. Knock down theirs before they knock down yours.',
  [MODE.FFA]: 'Every kid for themselves. Most freezes wins.',
});

export const DIFFICULTY_NAME = Object.freeze({
  [DIFFICULTY.COZY]: 'Cozy', [DIFFICULTY.NORMAL]: 'Normal', [DIFFICULTY.BLIZZARD]: 'Blizzard',
});

export const LENGTH_NAME = Object.freeze({ 5: 'Quick', 10: 'Full', 0: 'Endless' });

export const AWARD_COPY = Object.freeze({
  mitten: { name: 'Golden Mitten', why: 'Most hits' },
  foreman: { name: 'Foreman', why: 'Most built' },
  cocoa: { name: 'Hot Cocoa', why: 'Most thaws' },
  iceberg: { name: 'Iceberg', why: 'Most freezes' },
});

// One row per control. Touch and pad words are what the tips swap in, so they stay in step here.
export const CONTROLS = [
  ['Move', 'W A S D or arrows', 'Left stick', 'Left stick'],
  ['Aim', 'Mouse', 'Right stick', 'Right stick'],
  ['Throw', 'Hold and release left click', 'RT', 'Press and release the right stick'],
  ['Lob', 'Hold right click or Q, release', 'LT', 'Lob on, then the right stick'],
  ['Cancel throw', 'Esc', 'B', 'Slide back to the middle, then let go'],
  ['Belly slide', 'Space', 'A', 'Slide button'],
  ['Pick a tool', '1 to 6, or the tray', 'LB and RB', 'The tray'],
  ['Place', 'Left click', 'X', 'Touch the ground'],
  ['Demolish', 'X under the cursor', 'Demolish tool, then X', 'Seventh tray button, then touch'],
  ['Drop tool', 'Esc, right click, or the same key', 'B', 'Tap the same tool'],
  ['Ready', 'R', 'Y', 'Ready button'],
  ['Shout', 'V, then 1 to 6', 'D-pad down, up and down, A', 'Shout button'],
  ['Pick a card', 'Click', 'D-pad left, up, right', 'Tap'],
  ['Scores', 'Hold Tab', 'Hold View', 'Tap the timer'],
  ['Menu', 'Esc', 'Start', 'Menu button'],
  ['Chat', 'Enter', 'None', 'Lobby and results only'],
  ['Mute', 'M', 'Menu', 'Menu'],
];
