// Fort Flurry — shared enums and wire vocabulary.
// CONTRACT FILE. Every module imports names from here. Additive edits only:
// never renumber or rename an existing entry.
// NOTE: 0 is a valid value of TEAM, ACTOR, BALL, STRUCT and PICKUP. Never truth-test them.

export const GAME_NAME = 'Fort Flurry';
export const PROTOCOL_VERSION = 1;

export const MODE = Object.freeze({ SIEGE: 'siege', FORTWARS: 'fortwars', FFA: 'ffa' });
// Display labels. UI must use these, never hardcode.
export const MODE_NAME = Object.freeze({ siege: 'Siege', fortwars: 'Fort Face-Off', ffa: 'Free-for-All' });
export const DIFFICULTY = Object.freeze({ COZY: 'cozy', NORMAL: 'normal', BLIZZARD: 'blizzard' });

// Game phases (inside a running match). The lobby is a Room state, not a phase.
export const PHASE = Object.freeze({
  BUILD: 'build',        // countdown; cards are offered here
  FIGHT: 'fight',        // foes are attacking (siege) or teams are fighting (fortwars/ffa)
  ROUND_END: 'roundEnd', // fortwars only: short pause between rounds
  OVER: 'over',          // match finished; result available
});

// Team ids. Siege: all kids are TEAM.A. Fortwars: TEAM.A vs TEAM.B.
// FFA: each kid gets TEAM.FFA_BASE + slot (slot 0..7). Foes are always TEAM.FOES.
export const TEAM = Object.freeze({ A: 0, B: 1, FOES: 99, FFA_BASE: 100 });
export const TEAM_NAME = Object.freeze({ [TEAM.A]: 'Mitten Brigade', [TEAM.B]: 'Scarf Squad' });

// Actor kinds. KID covers both humans and bots.
export const ACTOR = Object.freeze({
  KID: 0, PIPSQUEAK: 1, SLINGER: 2, LOBBER: 3, BRUISER: 4, SLEDDER: 5,
  LIDKID: 6, SNEAK: 7, TRUCK: 8, STEVE: 9,
});

export const BALL = Object.freeze({
  QUICK: 0,   // ordinary flat throw
  POWER: 1,   // fully charged flat throw
  LOB: 2,     // arcs over walls, splash on landing
  ICE: 3,     // special: pierces one target, double damage
  SLUSH: 4,   // special: splash + slow
  GIANT: 5,   // special: rolls along the ground, grows, bowls through foes
  CONE: 6,    // truck turret volley
  BOULDER: 7, // Steve's huge rolling snowball
});

export const STRUCT = Object.freeze({
  WALL: 0, ICEWALL: 1, DECOY: 2, PULT: 3, SLICK: 4, COCOA: 5, COLONEL: 6,
});

export const PICKUP = Object.freeze({ ICE: 0, SLUSH: 1, TRIPLE: 2, GIANT: 3, COCOA: 4, BOARD: 5 });

// Bit flags on actor.flags (u16 on the wire).
export const AFLAG = Object.freeze({
  FROZEN: 1, PACKING: 2, CHARGING: 4, SLIDING: 8, BOARDING: 16, SLOWED: 32,
  AFK: 64, STUNNED: 128, SHIELDED: 256, FLEEING: 512, SLEDDING: 1024, ENRAGED: 2048,
  LOBAIM: 4096,
  LOCKED: 8192,  // set on every kid during ROUND_END and OVER; no control
  GRACE: 16384,  // kid just thawed/respawned, or foe just spawned: balls pass through, foes ignore
});

// Meaning of actor.aux bits for special foes. Kids use aux as a 0..255 progress value.
export const AUX = Object.freeze({ DOORS: 1, NOSE: 1, POUND: 1 }); // TRUCK / SNEAK / STEVE

// Input button bits (held state, sent every input frame).
export const BTN = Object.freeze({ THROW: 1, LOB: 2, SLIDE: 4, CANCEL: 8 });

// Event kinds (field `e`). See docs/SPEC.md section 7 for the fields of each.
export const EV = Object.freeze({
  BALL: 'ball', BALL_END: 'ballEnd', SPLASH: 'splash',
  HIT: 'hit', FREEZE: 'freeze', THAW: 'thaw', RESPAWN: 'respawn', FLEE: 'flee', SPAWN: 'spawn',
  S_ADD: 'sAdd', S_HP: 'sHp', S_DEL: 'sDel',
  P_ADD: 'pAdd', P_DEL: 'pDel',
  FLAKES: 'flakes', PULT: 'pult', CARD: 'card', BARK: 'bark', BANNER: 'banner',
  EMOTE: 'emote', QUAKE: 'quake', SFX: 'sfx', THROW: 'throw', SLIDE: 'slide',
  PICK_OFFER: 'offer', DENY: 'deny',
});

// The only names g.sfx() accepts. Everything else is derived by audio.js from events.
export const SFX = Object.freeze({
  HARRUMPH: 'harrumph', NOSE_GRAB: 'noseGrab', SLED_CRASH: 'sledCrash', TRUCK_DOORS: 'truckDoors',
  TRUCK_HORN: 'truckHorn', STEVE_ROAR: 'steveRoar', STEVE_POUND: 'stevePound', CHEER: 'cheer',
});

// Message `t` values for JSON messages. Binary frames start with a BIN byte.
export const MSG = Object.freeze({
  // client -> host
  HELLO: 'hello', LOBBY: 'lobby', CMD: 'cmd', CHAT: 'chat', PING: 'ping', LEAVE: 'leave',
  // host -> client
  WELCOME: 'welcome', LOBBY_STATE: 'lobbyState', START: 'start', FULL: 'full',
  META: 'meta', EVENTS: 'ev', CHAT_MSG: 'chatMsg', PONG: 'pong', ERROR: 'err',
  RESULT: 'result', KICKED: 'kicked', CLOSED: 'closed',
});

export const BIN = Object.freeze({ INPUT: 1, SNAPSHOT: 2, CHUNK: 3 });

// Discrete in-match commands: {t:'cmd', c:<CMD>, ...}
export const CMD = Object.freeze({
  BUILD: 'build',       // {k, cx, cy}
  DEMOLISH: 'demolish', // {cx, cy}
  CARD: 'card',         // {i}  index into current offer
  READY: 'ready',       // toggle "skip the build countdown"
  EMOTE: 'emote',       // {n}  index into EMOTES
});

// Lobby operations: {t:'lobby', op:<LOBBY_OP>, ...}
export const LOBBY_OP = Object.freeze({
  SET: 'set',           // host only: {settings:{...partial}}
  ME: 'me',             // {name?, look?, team?, ready?}
  START: 'start',       // host only
  KICK: 'kick',         // host only: {id}
  ADD_BOT: 'addBot',    // host only: {team?}
  DEL_BOT: 'delBot',    // host only: {id}
  RETURN: 'return',     // host only: go back to the lobby after a match
});

export const EMOTES = Object.freeze(['Help!', 'Nice shot!', 'Build here!', 'Over here!', 'Thanks!', 'Ha ha!']);

export const ERR = Object.freeze({
  NO_ROOM: 'noRoom', ROOM_FULL: 'roomFull', BAD_VERSION: 'badVersion', IN_PROGRESS: 'inProgress', // IN_PROGRESS is reserved, never sent
  RATE: 'rate', BAD_MSG: 'badMsg', SERVER_FULL: 'serverFull', TIMEOUT: 'timeout', NET: 'net',
});

// Session 'closed' reasons.
export const CLOSE = Object.freeze({
  LEFT: 'left', KICKED: 'kicked', HOST_LEFT: 'hostLeft', NET_LOST: 'netLost', REPLACED: 'replaced', RATE: 'rate',
});

// Keys of kid.mods. (+) keys add, all *Mul keys multiply. See SPEC section 4.
export const MOD_KEYS = Object.freeze(['speedMul', 'throwDmgMul', 'throwSpeedMul', 'maxBalls', 'packTimeMul',
  'maxWarmth', 'lobSplashMul', 'thawTimeMul', 'slideCdMul', 'buildRangeMul', 'regenMul', 'pultDmgMul',
  'wallHpMul', 'flakeBonus']);
