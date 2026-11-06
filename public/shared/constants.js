// Fort Flurry — tuning constants.
// CONTRACT FILE. Rebalancing values is fine; renaming keys is not.
import { ACTOR, BALL, STRUCT, PICKUP, DIFFICULTY, TEAM } from './schema.js';

// ---- timing -----------------------------------------------------------------
export const SIM_HZ = 30;
export const DT = 1 / SIM_HZ;
export const SNAP_EVERY = 2;      // one snapshot every 2 ticks = 15 per second
export const INTERP_TICKS = 4;    // default interpolation delay (~133 ms)
export const MAX_INPUT_BACKLOG = 6;
export const MAX_UNACKED = 30;    // client stops predicting/sending beyond this many unacked frames

// ---- world ------------------------------------------------------------------
export const CELL = 40;           // build grid cell size in world units
export const MAX_PLAYERS = 8;     // kids in a room, humans plus bots
export const MAX_ACTORS = 90;     // hard cap; bosses and kids are exempt, the wave spawner queues
export const MAX_STRUCTS_PER_TEAM = 120;
export const ROOM_CODE_LEN = 4;
export const ROOM_CODE_ALPHABET = 'BCDFGHJKMNPQRSTVWXZ'; // no vowels, so codes can't spell words
export const P2P_ID_PREFIX = 'fort-flurry-v1-';
export const NAME_MAX = 14;
export const CHAT_MAX = 120;
export const RECONNECT_GRACE_S = 60;

// ---- network limits ---------------------------------------------------------
export const MAX_INBOUND_BYTES = 4096;
export const SNAP_DROP_BYTES = 32768;   // skip a snapshot if the conn has this much buffered
export const CONN_KILL_BYTES = 524288;  // close a conn with this much buffered
export const CHUNK_BYTES = 13900;       // P2P: larger host->client messages are chunked
export const MAX_ROOMS = 200;
export const MAX_CONNS_PER_IP = 16;
export const MAX_ROOMS_PER_IP = 4;

// ---- kids -------------------------------------------------------------------
export const KID = Object.freeze({
  radius: 14, height: 36, maxWarmth: 100,
  speed: 205, accel: 1900, drag: 11,
  iceAccel: 520, iceDrag: 0.9, iceMaxSpeed: 300,
  chargeSpeedMul: 0.72, boardSpeedMul: 1.65, slowSpeedMul: 0.55,
  slideSpeed: 520, slideTime: 0.32, slideCooldown: 2.2,
  packDelay: 0.18, packTime: 0.32, maxBalls: 10, startBalls: 10,
  regenDelay: 5, regenPerSec: 5,
  thawTime: 1.8, thawRange: 46, thawWarmth: 50,
  frozenAutoThaw: 14, loneAutoThaw: 7, autoThawWarmth: 40, thawGrace: 2,
  knockback: 150, buildRange: 240, buildCooldown: 0.12,
  boardTime: 6, slowTime: 2.5,
});

export const LOOK = Object.freeze({
  hat: ['bobble', 'beanie', 'earflap', 'pompom', 'crown', 'toque'],
  coat: ['#d9534f', '#e8963c', '#e7c64a', '#5fae6b', '#3f8fc4', '#7a6bd1', '#d86fa8', '#6b7a8f'],
  scarf: ['#c8323c', '#f0a030', '#f2d64b', '#3fa66a', '#2d7fd3', '#8a5ad6', '#ef6fa0', '#f4f1ea'],
  skin: ['#fbe0cf', '#f2c6a0', '#d9a273', '#b27a4f', '#8a5a3a', '#5f3f2b'],
});
export const DEFAULT_LOOK = Object.freeze({ hat: 0, coat: 0, scarf: 0, skin: 1 });
export const TEAM_STYLE = Object.freeze({
  [TEAM.A]: { color: '#d6404e' },
  [TEAM.B]: { color: '#3a78d6' },
});
export const BOT_NAMES = Object.freeze(['Bobble', 'Galosh', 'Toboggan', 'Pompom', 'Earflap', 'Snowpants', 'Woolly', 'Toggle']);

// ---- throwing ---------------------------------------------------------------
export const THROW = Object.freeze({
  chargeTime: 0.7, cooldown: 0.24, z0: 20, radius: 6,
  quick: { speed: 540, flight: 0.72, dmg: 10 },
  power: { speed: 860, flight: 0.95, dmg: 22 },
  lob: { cost: 2, maxRange: 560, minFlight: 0.55, flightPerUnit: 1 / 900, gravity: 900, dmg: 20, splash: 46, cooldown: 0.6 },
});

export const SPECIAL = Object.freeze({
  [PICKUP.ICE]:    { name: 'Ice Chunk',  uses: 5, ball: BALL.ICE, dmgMul: 2, pierce: 1, structMul: 2 },
  [PICKUP.SLUSH]:  { name: 'Slushball',  uses: 5, ball: BALL.SLUSH, splash: 60, slow: 2.5 },
  [PICKUP.TRIPLE]: { name: 'Triple Toss', uses: 5, spread: 0.16 },
  [PICKUP.GIANT]:  { name: 'Giant Roller', uses: 1, ball: BALL.GIANT, speed: 300, r0: 14, r1: 34, grow: 6, life: 3.5, dmg: 40, stun: 1 },
  [PICKUP.COCOA]:  { name: 'Hot Cocoa',  heal: 40 },
  [PICKUP.BOARD]:  { name: 'Snowboard',  time: 6 },
});

// ---- structures -------------------------------------------------------------
export const BUILD = Object.freeze({
  [STRUCT.WALL]:    { name: 'Snow Wall', key: '1', cost: 2,  hp: 60,  solid: true,  height: 34, blurb: 'Blocks kids and flat throws.' },
  [STRUCT.ICEWALL]: { name: 'Ice Wall',  key: '2', cost: 5,  hp: 180, solid: true,  height: 40, blurb: 'Three times as tough as snow.' },
  [STRUCT.DECOY]:   { name: 'Spare Coat', key: '3', cost: 4, hp: 50,  solid: true,  height: 36, blurb: 'A stuffed coat on a shovel. Foes fall for it.', aggroRange: 260, aggroChance: 0.7 },
  [STRUCT.PULT]:    { name: 'Spoon Flinger', key: '4', cost: 10, hp: 70, solid: true, height: 30, blurb: 'Flings snow at the nearest foe.', range: 480, cooldown: 2.4, dmg: 16, splash: 48, limit: { base: 2, perPlayer: 2 } },
  [STRUCT.SLICK]:   { name: 'Slick',     key: '5', cost: 3,  hp: 30,  solid: false, height: 0,  blurb: 'Foes skid and slow down.', slow: 1.2 }, // slow = seconds of AFLAG.SLOWED, refreshed on the cell
  [STRUCT.COCOA]:   { name: 'Cocoa Stand', key: '6', cost: 8, hp: 60, solid: true,  height: 34, blurb: 'Warms nearby friends.', radius: 110, healPerSec: 7, thawMul: 2 },
  [STRUCT.COLONEL]: { name: 'Colonel Carrot', cost: 0, hp: 1500, solid: true, height: 90, size: 2 },
});
export const REPAIR_COST_MUL = 0.5;
export const DEMOLISH_REFUND = 0.5;
export const TEAMMATE_DEMOLISH_RANGE = 60;
export const TEAMMATE_DEMOLISH_COOLDOWN = 2;
export const FAIR_SHARE = Object.freeze({ minHumans: 3, minFlakes: 12, poolMul: 2 });

// ---- foes -------------------------------------------------------------------
// range = preferred attack distance. flakes = team reward on defeat.
export const FOES = Object.freeze({
  [ACTOR.PIPSQUEAK]: { name: 'Pipsqueak', hp: 17,  speed: 120, r: 12, range: 300, dmg: 6,  cd: 1.6, flakes: 1, ballSpeed: 360 },
  [ACTOR.SLINGER]:   { name: 'Slinger',   hp: 30,  speed: 105, r: 13, range: 430, dmg: 9,  cd: 1.5, flakes: 2, ballSpeed: 480 },
  [ACTOR.LOBBER]:    { name: 'Lobber',    hp: 30,  speed: 90,  r: 13, range: 520, dmg: 12, cd: 2.6, flakes: 2, splash: 44 },
  [ACTOR.BRUISER]:   { name: 'Big Kid',   hp: 140, speed: 75,  r: 20, range: 44,  dmg: 30, cd: 1.0, flakes: 6 },
  [ACTOR.SLEDDER]:   { name: 'Sledder',   hp: 30,  speed: 340, r: 15, range: 0,   dmg: 60, cd: 0,   flakes: 2, kidDmg: 25, kidStun: 0.8, footSpeed: 120, footRange: 300, footDmg: 6, footCd: 1.6, ballSpeed: 360 },
  [ACTOR.LIDKID]:    { name: 'Lid Kid',   hp: 50,  speed: 100, r: 14, range: 280, dmg: 7,  cd: 1.8, flakes: 3, ballSpeed: 340, turnRate: 1.0, shieldArc: 2.094 },
  [ACTOR.SNEAK]:     { name: 'Carrot Thief', hp: 25, speed: 175, r: 12, range: 30, dmg: 0, cd: 0,  flakes: 3, stealPct: 0.08 },
  [ACTOR.TRUCK]:     { name: 'The Sno-Cone Truck', hp: 1500, speed: 95, r: 46, range: 520, dmg: 10, cd: 1.5, flakes: 40, boss: true },
  [ACTOR.STEVE]:     { name: 'Abominable Steve', hp: 3200, speed: 70, r: 40, range: 620, dmg: 24, cd: 2.2, flakes: 0, boss: true },
});

export const BOSS = Object.freeze({
  truck: { parkEvery: 12, parkTime: 5, parkDmgMul: 2, doorSquad: 3, coneSpread: 0.2, ballSpeed: 420 },
  steve: { stopDist: 130, poundRadius: 170, poundTelegraph: 0.8, boulderSpeed: 190, boulderR0: 18, boulderR1: 46,
           boulderLife: 4, boulderStructMul: 5, enrageAt: 0.5, enrageSpeedMul: 1.35, enrageCdMul: 0.75, escortEvery: 25 },
});

// ---- modes ------------------------------------------------------------------
export const SIEGE = Object.freeze({
  startFlakes: 24, waveBonusBase: 12, waveBonusPerWave: 2,
  firstBuildTime: 35, buildTime: 25, colonelRegenBetweenWaves: 0.15,
  waveCounts: [5, 10, 0], // 0 = endless
  perExtraPlayerCount: 0.55, perExtraPlayerHp: 0.12, perExtraPlayerBossHp: 0.75, botPlayerWeight: 0.5,
  colonelHpPerExtraPlayer: 0.35,
  entranceNoBuild: 120, foeSpawnGrace: 1, waveOvertime: 90, readyBonusPerSec: 1 / 3,
  colonelPatch: { pct: 0.05, cost: 8, perBuild: 3 },
});

export const FORTWARS = Object.freeze({
  startFlakes: 40, buildTime: 40, roundTime: 240, suddenDeathAt: 180, suddenDeathPerSec: 15,
  roundEndTime: 6, roundsToWin: 2, colonelHp: 800, colonelHpPerExtraKid: 480,
  flakePerSec: 1 / 3, flakesPerFreeze: 6, respawnTime: 5, pickupEvery: 20,
});

export const FFA = Object.freeze({
  startFlakes: 12, buildTime: 12, matchTime: 180, freezesToWin: 15, flakesPerFreeze: 4,
  respawnTime: 3, pickupEvery: 12, leaderBonusLead: 3,
});

export const DIFF = Object.freeze({
  [DIFFICULTY.COZY]:     { hp: 0.75, dmg: 0.7,  count: 0.85 },
  [DIFFICULTY.NORMAL]:   { hp: 1,    dmg: 1,    count: 1 },
  [DIFFICULTY.BLIZZARD]: { hp: 1.2,  dmg: 1.2,  count: 1.15 },
});

export const PICKUP_DROP_CHANCE = 0.08;

// Base wave table: 1 player, Normal. win = seconds the squads are spread over.
export const WAVES = Object.freeze([
  null,
  { win: 30, foes: { [ACTOR.PIPSQUEAK]: 8 } },
  { win: 35, foes: { [ACTOR.PIPSQUEAK]: 10, [ACTOR.SLINGER]: 4 } },
  { win: 40, foes: { [ACTOR.PIPSQUEAK]: 10, [ACTOR.SLINGER]: 4, [ACTOR.SLEDDER]: 5 } },
  { win: 45, foes: { [ACTOR.PIPSQUEAK]: 10, [ACTOR.SLINGER]: 4, [ACTOR.LOBBER]: 4, [ACTOR.SLEDDER]: 3 } },
  { boss: ACTOR.TRUCK },
  { win: 50, foes: { [ACTOR.PIPSQUEAK]: 9, [ACTOR.SLINGER]: 4, [ACTOR.LOBBER]: 4, [ACTOR.LIDKID]: 5 } },
  { win: 50, foes: { [ACTOR.PIPSQUEAK]: 9, [ACTOR.SLINGER]: 4, [ACTOR.LIDKID]: 4, [ACTOR.SNEAK]: 5, [ACTOR.SLEDDER]: 3 } },
  { win: 55, foes: { [ACTOR.PIPSQUEAK]: 8, [ACTOR.SLINGER]: 4, [ACTOR.LOBBER]: 4, [ACTOR.LIDKID]: 4, [ACTOR.BRUISER]: 3 } },
  { win: 60, foes: { [ACTOR.PIPSQUEAK]: 10, [ACTOR.SLINGER]: 5, [ACTOR.LOBBER]: 4, [ACTOR.LIDKID]: 4, [ACTOR.SLEDDER]: 4, [ACTOR.SNEAK]: 3, [ACTOR.BRUISER]: 3 } },
  { boss: ACTOR.STEVE },
]);
export const WAVE_NAMES = Object.freeze([null, 'Morning Skirmish', 'Recess Rush', 'The Sled Brigade', 'Lobs Away',
  'The Sno-Cone Truck', 'Trash Talk', 'Nose Goes', 'Big Kids on the Block', 'Every Crew in Town', 'Abominable Steve']);
