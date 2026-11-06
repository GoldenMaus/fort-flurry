// Development harness: boots the real App, Input and UI against a mock session, so every screen and
// state can be reached on demand without a host. Open ui-harness.html?scene=<name>, or use the
// dropdown. `window.__h` exposes the session and the recorded frames and commands for test scripts.
import {
  ACTOR, AFLAG, CLOSE, CMD, ERR, EV, LOBBY_OP, MODE, PHASE, PICKUP, STRUCT, TEAM,
} from '../shared/schema.js';
import { BOT_NAMES, CELL, DEFAULT_LOOK, KID, LOOK, WAVE_NAMES } from '../shared/constants.js';
import { getMap } from '../shared/maps.js';
import { CARDS, modsFromCards } from '../shared/cards.js';
import { createCollisionWorld } from '../shared/physics.js';
import { Renderer as RealRenderer } from '../js/render/renderer.js';
import { App } from '../js/main.js';
import { Emitter } from '../js/ui/dom.js';

const params = new URLSearchParams(location.search);
const pendingScene = params.get('scene') ?? 'title';

const colonelCells = (fort) => ({ cx: Math.floor(fort.x / CELL) - 1, cy: Math.floor(fort.y / CELL) - 1 });

// A plain stand-in for the renderer: enough ground and blobs to judge the HUD against, with the same
// coordinate contract as the real one.
class MockRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.cam = { x: 0, y: 0 };
    this.zoom = 1;
    this.lastUi = null;
    this.fx = [];
    this.resize();
  }
  resize() {
    const { canvas } = this;
    this.w = canvas.clientWidth || innerWidth;
    this.h = canvas.clientHeight || innerHeight;
    canvas.width = this.w;
    canvas.height = this.h;
  }
  setMap(map) { this.map = map; }
  setQuality() {}
  onFx(ev) { this.fx.push(ev); }
  screenToWorld(px, py) { return { x: px / this.zoom + this.cam.x, y: py / this.zoom + this.cam.y }; }
  worldToScreen(x, y) { return { x: (x - this.cam.x) * this.zoom, y: (y - this.cam.y) * this.zoom }; }
  pickStruct(px, py, view) {
    const w = this.screenToWorld(px, py);
    for (const s of view.structs) {
      const size = s.kind === STRUCT.COLONEL ? 2 : 1;
      if (w.x >= s.cx * CELL && w.x < (s.cx + size) * CELL && w.y >= s.cy * CELL && w.y < (s.cy + size) * CELL) return s;
    }
    return null;
  }
  render(view, ui) {
    this.lastUi = JSON.parse(JSON.stringify(ui));
    const { ctx } = this;
    const focus = view.me ?? { x: view.map.fort.x, y: view.map.fort.y };
    this.cam.x = focus.x - this.w / 2;
    this.cam.y = focus.y - this.h / 2;
    ctx.fillStyle = '#e8eefb';
    ctx.fillRect(0, 0, this.w, this.h);
    ctx.strokeStyle = 'rgba(160,170,220,.28)';
    ctx.beginPath();
    for (let x = -(this.cam.x % CELL); x < this.w; x += CELL) { ctx.moveTo(x, 0); ctx.lineTo(x, this.h); }
    for (let y = -(this.cam.y % CELL); y < this.h; y += CELL) { ctx.moveTo(0, y); ctx.lineTo(this.w, y); }
    ctx.stroke();
    for (const s of view.structs) {
      const size = s.kind === STRUCT.COLONEL ? 2 : 1;
      const p = this.worldToScreen(s.cx * CELL, s.cy * CELL);
      ctx.fillStyle = s.kind === STRUCT.COLONEL ? '#fff' : '#b8c6ec';
      ctx.fillRect(p.x, p.y, size * CELL, size * CELL);
    }
    for (const a of view.actors) {
      const p = this.worldToScreen(a.x, a.y);
      ctx.fillStyle = a.team === TEAM.FOES ? '#7a6bd1' : '#d9534f';
      ctx.beginPath();
      ctx.arc(p.x, p.y, 14, 0, 6.3);
      ctx.fill();
    }
    if (ui.toolCell) {
      const p = this.worldToScreen(ui.toolCell.cx * CELL, ui.toolCell.cy * CELL);
      ctx.fillStyle = ui.toolValid ? 'rgba(80,200,140,.5)' : 'rgba(220,70,80,.5)';
      ctx.fillRect(p.x, p.y, CELL, CELL);
    }
    for (const s of ui.sticks) {
      ctx.strokeStyle = s.kind === 'lob' ? '#f0b23c' : 'rgba(42,44,102,.5)';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, 6.3);
      ctx.stroke();
      ctx.fillStyle = 'rgba(42,44,102,.4)';
      ctx.beginPath();
      ctx.arc(s.kx, s.ky, 22, 0, 6.3);
      ctx.fill();
    }
  }
}

class MockAudio {
  constructor() { this.calls = []; this.ctx = null; this.volumes = null; this.music = null; }
  unlock() { this.calls.push('unlock'); this.ctx ??= { state: 'running' }; }
  onFx() {}
  setMusic(track) { this.music = track; this.calls.push(`music:${track}`); }
  setVolumes(v) { this.volumes = v; }
  ui(name) { this.calls.push(`ui:${name}`); }
  update() {}
  setHidden(on) { this.calls.push(`hidden:${on}`); }
}

const playerRow = (id, name, over = {}) => ({
  id, name, look: { ...DEFAULT_LOOK, hat: id % LOOK.hat.length, coat: (id * 3) % LOOK.coat.length, scarf: (id * 5) % LOOK.scarf.length, skin: id % LOOK.skin.length },
  team: TEAM.A, ready: false, isBot: false, connected: true, ...over,
});

const CREW = [
  playerRow(1, 'Snowy Otter', { ready: true }),
  playerRow(2, 'Toasty Fox'),
  playerRow(3, 'Maya'),
  playerRow(4, BOT_NAMES[0], { isBot: true, ready: true }),
  playerRow(5, BOT_NAMES[1], { isBot: true, ready: true }),
];

function baseLobby(over = {}) {
  return {
    code: 'BCDF',
    hostId: 1,
    state: 'lobby',
    settings: { mode: MODE.SIEGE, mapId: 'court', difficulty: 'normal', waveCount: 10 },
    players: CREW.map((p) => ({ ...p })),
    ...over,
  };
}

function baseMeta(view, over = {}) {
  const { team } = view;
  return {
    phase: view.phase,
    wave: view.wave,
    waveCount: view.waveCount,
    waveName: view.waveName,
    waveSub: 'Hold the line',
    endsAtTick: null,
    dayT: 0.3,
    blizzard: false,
    flakes: { [team]: 37, [TEAM.B]: 18 },
    colonels: [{ team: TEAM.A, id: 1000, hp: 1240, mhp: 1500, nose: true }],
    foesLeft: 14,
    round: 1,
    roundWins: { [TEAM.A]: 0, [TEAM.B]: 0 },
    boss: null,
    ready: { have: 1, need: 3, ids: [] },
    scores: CREW.map((p, i) => ({ id: p.id, hits: 42 - i * 7, freezes: 12 - i * 2, thaws: i, built: 6 + i * 3, flakes: 20 - i })),
    truce: false,
    suddenDeath: false,
    next: null,
    cards: { 1: [] },
    leaderId: null,
    pultLimit: { [team]: 6 },
    patchesLeft: 3,
    ...over,
  };
}

class MockSession extends Emitter {
  constructor(connect, opts) {
    super();
    this.connectFn = connect;
    this.opts = opts;
    this.me = harness.meId;
    this.token = 'mock-token';
    this.roomCode = harness.lobby.code;
    this.lobby = null;
    this.inMatch = false;
    this.ping = 48;
    this.connected = true;
    this.reconnecting = false;
    this.netStatus = 'ok';
    this.result = null;
    this.offer = null;
    this.view = { players: new Map() };
    this.frames = [];
    this.cmds = [];
    this.ops = [];
    this.chats = [];
    this.background = [];
    this.closed = false;
    harness.session = this;
  }

  get isHost() { return this.lobby?.hostId === this.me; }

  start() {
    this.transport = this.connectFn();
    if (harness.startHang) return new Promise(() => {});
    if (harness.startError) return Promise.reject(harness.startError);
    return Promise.resolve().then(() => {
      this.lobby = harness.lobby;
      this.emit('lobby', this.lobby);
    });
  }

  lobbyOp(op, data = {}) {
    this.ops.push({ op, ...data });
    const lobby = this.lobby;
    const me = lobby.players.find((p) => p.id === this.me);
    if (op === LOBBY_OP.SET) Object.assign(lobby.settings, data.settings);
    else if (op === LOBBY_OP.ME) Object.assign(me, data);
    else if (op === LOBBY_OP.ADD_BOT) {
      const id = Math.max(...lobby.players.map((p) => p.id)) + 1;
      lobby.players.push(playerRow(id, BOT_NAMES[id % BOT_NAMES.length], { isBot: true, ready: true, team: data.team ?? TEAM.A }));
    } else if (op === LOBBY_OP.DEL_BOT || op === LOBBY_OP.KICK) lobby.players = lobby.players.filter((p) => p.id !== data.id);
    else if (op === LOBBY_OP.START) { harness.startMatch(harness.matchConfig); return; } else if (op === LOBBY_OP.RETURN) {
      this.inMatch = false;
      lobby.state = 'lobby';
    }
    this.emit('lobby', { ...lobby });
  }

  chat(text) {
    this.chats.push(text);
    this.emit('chat', { id: this.me, name: this.opts.name, text });
  }

  cmd(c, data = {}) {
    this.cmds.push({ c, ...data });
    const { view } = this;
    if (c === CMD.BUILD) {
      view.structs.push({ id: 2000 + this.cmds.length, kind: data.k, cx: data.cx, cy: data.cy, team: view.team, hp: 60, maxHp: 60, ownerId: this.me, bornAt: 0 });
    } else if (c === CMD.DEMOLISH) {
      view.structs = view.structs.filter((s) => !(s.cx === data.cx && s.cy === data.cy));
    } else if (c === CMD.READY) {
      const ids = view.meta.ready.ids;
      if (ids.includes(this.me)) ids.splice(ids.indexOf(this.me), 1); else ids.push(this.me);
      view.meta.ready.have = ids.length;
    } else if (c === CMD.CARD) {
      this.offer = null;
      this.emit('fx', { e: EV.CARD, id: this.me, card: 'picked' });
    }
  }

  setFrameInput(frame) {
    this.frames.push({ ...frame, at: performance.now() });
    if (this.frames.length > 400) this.frames.shift();
    this.frame = frame;
  }

  update(dt) {
    const { view, frame } = this;
    if (!view.me || !frame) return;
    view.me.x += frame.mx * KID.speed * dt;
    view.me.y += frame.my * KID.speed * dt;
    view.me.aim = frame.aim;
  }

  setBackground(on) { this.background.push(on); }

  leave() {
    if (this.closed) return;
    this.closed = true;
    this.emit('closed', { reason: CLOSE.LEFT });
  }

  // Test hooks that stand in for network events.
  fx(ev) { this.emit('fx', ev); }
  drop(reason) {
    this.closed = true;
    this.emit('closed', { reason });
  }
}

const harness = {
  app: null,
  session: null,
  startError: null,
  startHang: false,
  paused: [],
  meId: 1,
  lobby: baseLobby(),
  matchConfig: {},
  scene: pendingScene,

  frames() { return this.session?.frames ?? []; },

  async enter(role, { lobby, me = 1, solo = false } = {}) {
    this.meId = me;
    this.lobby = lobby ?? baseLobby();
    if (solo) this.lobby = { ...this.lobby, players: this.lobby.players.slice(0, 1) };
    await this.app.connect({ role, code: this.lobby.code, mode: 'server' });
    await new Promise((r) => setTimeout(r, 0));
  },

  startMatch(cfg = {}) {
    const s = this.session;
    const mode = cfg.mode ?? this.lobby.settings.mode;
    const phase = cfg.phase ?? PHASE.BUILD;
    const map = getMap(cfg.mapId ?? this.lobby.settings.mapId);
    const players = new Map(this.lobby.players.map((p) => [p.id, { ...p }]));
    const team = players.get(s.me)?.team ?? TEAM.A;
    const cards = cfg.cards ?? [];
    const spot = map.spawns.siege[0];
    const fortCell = colonelCells(map.fort);
    const meActor = cfg.noMe ? null : {
      id: s.me, kind: ACTOR.KID, team, x: spot.x, y: spot.y, vx: 0, vy: 0, aim: 0, hp: 0.82, flags: cfg.meFlags ?? 0, aux: 0,
    };
    const foes = cfg.foes ?? [
      { id: 1100, kind: ACTOR.PIPSQUEAK, team: TEAM.FOES, x: spot.x + 220, y: spot.y + 40, vx: 0, vy: 0, aim: 0, hp: 1, flags: 0, aux: 0 },
      { id: 1101, kind: ACTOR.SLINGER, team: TEAM.FOES, x: spot.x - 280, y: spot.y - 90, vx: 0, vy: 0, aim: 0, hp: 1, flags: 0, aux: 0 },
    ];
    const mates = [...players.values()].filter((p) => p.id !== s.me).map((p, i) => ({
      id: p.id, kind: ACTOR.KID, team: p.team, x: spot.x - 60 + i * 44, y: spot.y + 90, vx: 0, vy: 0, aim: 0, hp: 0.4 + (i % 3) * 0.3, flags: i === 1 ? AFLAG.FROZEN : 0, aux: 0,
    }));
    const view = {
      map,
      mapId: map.id,
      mode,
      phase,
      team,
      wave: cfg.wave ?? 3,
      waveCount: cfg.waveCount ?? 10,
      waveName: WAVE_NAMES[cfg.wave ?? 3],
      dayT: 0.3,
      blizzard: false,
      renderTick: 100,
      secondsLeft: cfg.secondsLeft === undefined ? (phase === PHASE.BUILD ? 23 : null) : cfg.secondsLeft,
      me: meActor,
      you: cfg.noMe ? null : {
        balls: cfg.balls ?? 7, maxBalls: 10, special: cfg.special ?? 255, specialN: cfg.special === undefined ? 0 : 4, warmth: 82, maxWarmth: 100,
        throwCd: 0, slideCd: cfg.slideCd ?? 0, slideT: 0, packT: 0, boardT: 0, slowT: 0, stunT: 0, prevBtn: 0, frozenT: cfg.frozenT ?? 0,
        spendLeft: cfg.share ?? 65535, mods: modsFromCards(cards),
      },
      actors: [...(meActor ? [meActor] : []), ...mates, ...foes],
      balls: [],
      structs: [{ id: 1000, kind: STRUCT.COLONEL, cx: fortCell.cx, cy: fortCell.cy, team: TEAM.A, hp: 1240, maxHp: 1500, ownerId: 0, bornAt: 0 }],
      pickups: [],
      players,
      cw: createCollisionWorld(map),
    };
    view.meta = baseMeta(view, cfg.meta);
    if (cfg.me0) Object.assign(view, cfg.me0);
    s.view = view;
    s.inMatch = true;
    s.offer = cfg.offer ?? null;
    this.lobby.state = 'playing';
    s.emit('start');
  },

  result(cfg = {}) {
    const s = this.session;
    const result = {
      mode: s.view.mode,
      winnerTeam: TEAM.A,
      winners: [1, 2, 3, 4, 5],
      won: true,
      summary: 'Colonel Carrot stood tall through all 10 waves.',
      players: CREW.map((p, i) => ({
        id: p.id,
        stats: { hits: 88 - i * 11, freezes: 21 - i * 3, thaws: 4 + i, built: 12 + (5 - i) * 4, flakes: 60 - i * 8 },
        award: ['mitten', 'foreman', 'cocoa', 'iceberg', null][i],
      })),
      ...cfg,
    };
    s.result = result;
    s.emit('result', result);
  },
};

const offer = () => CARDS.slice(0, 3).map((c) => c.id);
const fortwarsLobby = (over = {}) => baseLobby({
  settings: { mode: MODE.FORTWARS, mapId: 'yard', difficulty: 'normal', waveCount: 10 },
  players: CREW.map((p, i) => ({ ...p, team: i % 2 ? TEAM.B : TEAM.A })),
  ...over,
});
const ffaLobby = () => baseLobby({
  settings: { mode: MODE.FFA, mapId: 'pond', difficulty: 'normal', waveCount: 10 },
  players: CREW.map((p, i) => ({ ...p, team: TEAM.FFA_BASE + i })),
});

const fightAt = async (cfg, enter = {}) => {
  await harness.enter('host', enter);
  harness.startMatch({ phase: PHASE.FIGHT, ...cfg });
};

const SCENES = {
  title: async () => {},
  'title-busy': async () => {},
  invite: async () => {},
  'invite-bad': async () => {},
  join: async () => { harness.app.ui.show('join'); },
  connecting: async () => {
    harness.startHang = true;
    harness.app.front = { name: 'join', data: {} };
    harness.app.connect({ role: 'join', code: 'BCDF', mode: 'server' });
  },
  'lobby-host': async () => harness.enter('host'),
  'lobby-solo': async () => harness.enter('solo', { solo: true }),
  'lobby-guest': async () => harness.enter('join', { me: 3 }),
  'lobby-fortwars': async () => harness.enter('host', { lobby: fortwarsLobby() }),
  'lobby-fortwars-blocked': async () => harness.enter('host', { lobby: fortwarsLobby({ players: [{ ...CREW[0], team: TEAM.A }] }) }),
  'lobby-ffa': async () => harness.enter('host', { lobby: ffaLobby() }),
  'lobby-ffa-blocked': async () => harness.enter('solo', { solo: true, lobby: ffaLobby() }),
  'lobby-full': async () => harness.enter('host', {
    lobby: baseLobby({
      players: [...CREW.map((p) => ({ ...p })), playerRow(6, 'Bartholomew Pi', { connected: false }), playerRow(7, BOT_NAMES[2], { isBot: true }), playerRow(8, BOT_NAMES[3], { isBot: true })],
    }),
  }),
  'match-build': async () => {
    await harness.enter('host');
    harness.startMatch({
      phase: PHASE.BUILD,
      meta: { next: { foes: [{ k: ACTOR.PIPSQUEAK, n: 12 }, { k: ACTOR.SLINGER, n: 6 }, { k: ACTOR.SLEDDER, n: 5 }], from: [0, 2] } },
    });
  },
  'match-fairshare': async () => {
    await harness.enter('host');
    harness.startMatch({ phase: PHASE.BUILD, share: 12 });
  },
  'match-fight': async () => fightAt({ balls: 5, special: PICKUP.ICE, slideCd: 1.1 }),
  'match-lowsnow': async () => fightAt({ balls: 1 }),
  'match-boss': async () => fightAt({
    wave: 5,
    meta: { boss: { kind: ACTOR.TRUCK, name: 'The Sno-Cone Truck', hp: 930, mhp: 1500 }, foesLeft: 4 },
    foes: [{ id: 1200, kind: ACTOR.TRUCK, team: TEAM.FOES, x: 900, y: 700, vx: 0, vy: 0, aim: 0, hp: 0.62, flags: 0, aux: 0 }],
  }),
  'match-fortwars': async () => fightAt({
    secondsLeft: 134,
    meta: {
      colonels: [{ team: TEAM.A, id: 1000, hp: 620, mhp: 1280, nose: true }, { team: TEAM.B, id: 1001, hp: 900, mhp: 1280, nose: true }],
      round: 2, roundWins: { [TEAM.A]: 1, [TEAM.B]: 0 }, foesLeft: 0,
    },
  }, { lobby: fortwarsLobby() }),
  'match-suddendeath': async () => fightAt({
    secondsLeft: 41,
    meta: { colonels: [{ team: TEAM.A, id: 1000, hp: 240, mhp: 1280, nose: true }, { team: TEAM.B, id: 1001, hp: 300, mhp: 1280, nose: true }], suddenDeath: true, round: 3, roundWins: { [TEAM.A]: 1, [TEAM.B]: 1 }, foesLeft: 0 },
  }, { lobby: fortwarsLobby() }),
  'match-roundend': async () => {
    await harness.enter('host', { lobby: fortwarsLobby() });
    harness.startMatch({ phase: PHASE.ROUND_END, secondsLeft: 5, meta: { colonels: [{ team: TEAM.A, id: 1000, hp: 300, mhp: 1280, nose: true }, { team: TEAM.B, id: 1001, hp: 0, mhp: 1280, nose: true }], round: 1 } });
    harness.session.fx({ e: EV.BANNER, text: 'Mitten Brigade take the round!', sub: 'First to 2', kind: 'info' });
  },
  'match-ffa': async () => fightAt({ secondsLeft: 97, meta: { colonels: [], leaderId: 2, foesLeft: 0 } }, { lobby: ffaLobby() }),
  'match-frozen': async () => fightAt({ meFlags: AFLAG.FROZEN, frozenT: 9 }),
  'match-frozen-ffa': async () => fightAt({ meFlags: AFLAG.FROZEN, frozenT: 3, secondsLeft: 90, meta: { colonels: [], foesLeft: 0 } }, { lobby: ffaLobby() }),
  'match-late': async () => fightAt({ noMe: true }),
  cards: async () => {
    await harness.enter('host');
    harness.startMatch({ phase: PHASE.BUILD, offer: offer() });
  },
  'cards-sheet': async () => {
    await SCENES.cards();
    await new Promise((r) => setTimeout(r, 400));
    harness.app.ui.hud.cards.setSheet(true);
  },
  scoreboard: async () => {
    await fightAt({});
    harness.app.input.emit('scoreboard', true);
  },
  'scoreboard-fortwars': async () => {
    await SCENES['match-fortwars']();
    harness.app.input.emit('scoreboard', true);
  },
  menu: async () => { await fightAt({}); harness.app.ui.toggleMenu(); },
  'menu-solo': async () => { await harness.enter('solo', { solo: true }); harness.startMatch({ phase: PHASE.FIGHT }); harness.app.ui.toggleMenu(); },
  settings: async () => { harness.app.ui.openSettings(); },
  howto: async () => { harness.app.ui.openHowTo(); },
  'howto-controls': async () => {
    harness.app.ui.openHowTo();
    document.querySelectorAll('.howto-tabs .seg-btn')[1].click();
  },
  shout: async () => { await fightAt({}); harness.app.input.setShout(true); },
  chat: async () => {
    await fightAt({});
    for (const [id, name, text] of [[2, 'Toasty Fox', 'Build by the mailbox!'], [3, 'Maya', 'on it']]) harness.session.emit('chat', { id, name, text });
    harness.app.input.emit('chatOpen');
  },
  deny: async () => { await fightAt({}); harness.session.fx({ e: EV.DENY, to: 1, why: 'noFlakes' }); },
  banner: async () => { await fightAt({}); harness.session.fx({ e: EV.BANNER, text: 'Wave 3', sub: 'The Sled Brigade', kind: 'wave' }); },
  'banner-boss': async () => { await fightAt({}); harness.session.fx({ e: EV.BANNER, text: 'The Sno-Cone Truck!', sub: 'Hear that chime?', kind: 'boss' }); },
  tip: async () => { await fightAt({}); harness.app.ui.hud.showTip('throw', 'Click to throw. Hold longer to throw harder and farther.', 60000); },
  hiccup: async () => { await fightAt({}); harness.session.connected = false; harness.session.netStatus = 'hiccup'; },
  reconnecting: async () => {
    await fightAt({});
    harness.session.connected = false;
    harness.session.reconnecting = true;
    harness.session.emit('reconnecting', { attempt: 1, until: Date.now() + 50000 });
  },
  'leave-confirm': async () => { await fightAt({}); harness.app.ui.askLeave(); },
  'leave-confirm-host': async () => {
    await harness.app.connect({ role: 'host', code: 'BCDF', mode: 'p2p' });
    await new Promise((r) => setTimeout(r, 0));
    harness.app.ui.askLeave();
  },
  'results-win': async () => { await fightAt({}); harness.result(); harness.app.ui.show('results', { result: harness.session.result }); },
  'results-lose': async () => {
    await fightAt({});
    harness.result({ winners: [], won: false, winnerTeam: null, summary: 'The rival crew knocked the Colonel over on wave 7.' });
    harness.app.ui.show('results', { result: harness.session.result });
  },
  'results-guest': async () => {
    await harness.enter('join', { me: 3 });
    harness.startMatch({ phase: PHASE.FIGHT });
    harness.result();
    harness.app.ui.show('results', { result: harness.session.result });
  },
  'results-fortwars': async () => {
    await harness.enter('host', { lobby: fortwarsLobby() });
    harness.startMatch({ phase: PHASE.OVER });
    harness.result({ mode: MODE.FORTWARS, winnerTeam: TEAM.B, winners: [2, 4], won: false, summary: 'Scarf Squad won 2 rounds to 1.' });
    harness.app.ui.show('results', { result: harness.session.result });
  },
  'results-ffa': async () => {
    await harness.enter('host', { lobby: ffaLobby() });
    harness.startMatch({ phase: PHASE.OVER, secondsLeft: 0, meta: { colonels: [] } });
    harness.result({ mode: MODE.FFA, winnerTeam: null, winners: [2], won: false, summary: 'Toasty Fox got to 15 freezes first.' });
    harness.app.ui.show('results', { result: harness.session.result });
  },
};

for (const code of [ERR.NO_ROOM, ERR.ROOM_FULL, ERR.BAD_VERSION, ERR.SERVER_FULL, ERR.TIMEOUT, ERR.NET, ERR.RATE, CLOSE.KICKED, CLOSE.HOST_LEFT, CLOSE.NET_LOST, CLOSE.REPLACED]) {
  SCENES[`error-${code}`] = async () => { harness.app.ui.showError(code, 'BCDF', {}); };
}

function panel() {
  const select = document.createElement('select');
  for (const name of Object.keys(SCENES)) select.add(new Option(name, name, false, name === pendingScene));
  select.addEventListener('change', () => {
    const url = new URL(location.href);
    url.searchParams.set('scene', select.value);
    location.href = url.href;
  });
  const box = document.createElement('div');
  box.id = 'harness-panel';
  box.append('Scene ', select);
  document.body.append(box);
}

async function main() {
  // The invite scenes exercise the real boot routing, which reads ?join.
  if (pendingScene === 'invite' || pendingScene === 'invite-bad') {
    const url = new URL(location.href);
    url.searchParams.set('join', pendingScene === 'invite' ? 'bcdf' : '12');
    history.replaceState(null, '', url);
  }
  const useReal = params.get('renderer') === 'real';
  const app = new App({
    Session: MockSession,
    Renderer: useReal ? RealRenderer : MockRenderer,
    AudioEngine: MockAudio,
    detectMode: () => (pendingScene === 'title-busy' ? new Promise(() => {}) : Promise.resolve(params.get('net') ?? 'p2p')),
    soloConnect: () => () => ({ setPaused: (on) => harness.paused.push(on) }),
    hostConnect: () => () => ({}),
    joinConnect: () => () => ({}),
  });
  harness.app = app;
  const { renderer, input, ui, audio } = app;
  window.__ff = {
    get session() { return app.session; },
    renderer, input, ui, audio, app,
  };
  window.__h = harness;
  app.start();
  await SCENES[pendingScene]?.();
  if (params.get('panel') === '1' || !params.has('scene')) panel();
  document.documentElement.dataset.sceneReady = pendingScene;
}

main();
