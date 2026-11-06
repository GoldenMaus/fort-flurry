// App shell: the state machine, the rAF loop and all the wiring between Session, Renderer, Audio,
// Input and UI. `App` takes its collaborators as an option so public/dev/ui-harness.js can run this
// exact flow against a mock session.
import { Session } from './net/session.js';
import { detectMode, hostConnect, joinConnect, soloConnect } from './net/hosting.js';
import { Renderer } from './render/renderer.js';
import { AudioEngine } from './audio/audio.js';
import { Input } from './input.js';
import { UI } from './ui/ui.js';
import { Prefs } from './ui/store.js';
import { ACTOR, CLOSE, ERR, LOBBY_OP, PHASE } from '../shared/schema.js';
import { isValidCode } from '../shared/protocol.js';

const SAVE_KEY = 'ff.session';
const UNLOCK_EVENTS = ['pointerup', 'touchend', 'click', 'keydown'];
const BACKGROUND_TICK_MS = 250;
const FIRST_DT = 1 / 60;
const MAX_DT = 0.1;
// The last splat and the win banner should land before the results slide in.
const RESULTS_DELAY_MS = 2400;
// Play Again goes through the lobby. Wait this long for START so the lobby doesn't flash up, but
// still land there if the room refuses to start (say a friend left an FFA with too few kids).
const AGAIN_GRACE_MS = 700;

function readSaved() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(SAVE_KEY));
    if (saved && typeof saved.code === 'string' && typeof saved.token === 'string') return saved;
  } catch { /* unreadable storage is the same as nothing saved */ }
  return null;
}

function writeSaved(value) {
  try { sessionStorage.setItem(SAVE_KEY, JSON.stringify(value)); } catch { /* a reload just won't reconnect */ }
}

function clearSaved() {
  try { sessionStorage.removeItem(SAVE_KEY); } catch { /* nothing to clear */ }
}

const cleanCode = (raw) => String(raw ?? '').toUpperCase().replace(/[^A-Z]/g, '');

export class App {
  constructor(deps = {}) {
    this.deps = { Session, Renderer, AudioEngine, detectMode, soloConnect, hostConnect, joinConnect, ...deps };
    const d = this.deps;
    this.rootEl = document.getElementById('app');
    this.canvas = document.getElementById('game');
    this.prefs = new Prefs();
    this.renderer = new d.Renderer(this.canvas, { quality: this.prefs.quality });
    this.audio = new d.AudioEngine();
    this.input = new Input(this.canvas, this.renderer, { reduceMotion: this.prefs.reduceMotion });
    this.ui = new UI(this.rootEl, { input: this.input, renderer: this.renderer, audio: this.audio, prefs: this.prefs });

    this.session = null;
    this.state = 'boot';        // boot | front | connecting | lobby | match | results
    this.plan = null;           // how the current session was reached, kept for Retry
    this.front = { name: 'title', data: {} };
    this.connectSeq = 0;
    this.inRoom = false;
    this.historyPushed = false;
    this.welcomed = false;
    this.matchLive = false;
    this.pendingAgain = false;
    this.againTimer = 0;
    this.resultsTimer = 0;
    this.soloTransport = null;
    this.netMode = null;
    this.modeReady = null;
    this.handlers = null;
    this.wakeLock = null;
    this.backgroundTimer = 0;
    this.lastFrame = 0;
    this.lanBase = null;
    this.unlockArmed = false;

    this.frame = this.frame.bind(this);
    this.tryUnlockAudio = this.tryUnlockAudio.bind(this);
  }

  start() {
    this.audio.setVolumes(this.prefs.audioLevels);
    this.audio.setMusic('menu');
    this.bindUi();
    this.bindPage();
    this.armAudioUnlock();
    this.modeReady = Promise.resolve()
      .then(() => this.deps.detectMode())
      .catch(() => 'p2p')
      .then((mode) => {
        this.netMode = mode;
        this.ui.setNetReady(true);
        this.fetchLanBase(mode);
        return mode;
      });
    this.routeBoot();
    document.getElementById('boot')?.remove();
    requestAnimationFrame(this.frame);
  }

  // ---- boot ------------------------------------------------------------------------

  routeBoot() {
    const params = new URLSearchParams(location.search);
    const hasJoin = params.has('join');
    const code = hasJoin ? cleanCode(params.get('join')) : null;
    const saved = readSaved();

    if (saved && (!hasJoin || saved.code === code)) {
      this.front = hasJoin ? { name: 'invite', data: { code } } : { name: 'title', data: {} };
      this.connect({ role: 'join', code: saved.code, token: saved.token, mode: saved.mode, resume: true });
      return;
    }
    if (hasJoin && isValidCode(code)) {
      this.showFront({ name: 'invite', data: { code } });
      return;
    }
    this.showFront({ name: 'title', data: {} });
    if (hasJoin) this.ui.showError(ERR.NO_ROOM, code, { primary: () => this.showFront({ name: 'join', data: {} }) });
  }

  showFront(front) {
    this.front = front;
    this.state = 'front';
    this.ui.show(front.name, front.data);
  }

  // A page on localhost can't be reached by friends, so server mode invites use the LAN address.
  async fetchLanBase(mode) {
    if (mode !== 'server' || !['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)) return;
    try {
      const info = await (await fetch('api/info')).json();
      if (typeof info.lanUrl === 'string' && info.lanUrl) this.ui.inviteBase = info.lanUrl;
    } catch { /* the page's own address still works on this machine */ }
  }

  // ---- connecting ---------------------------------------------------------------------

  connectingText({ role, code }) {
    if (role === 'solo') return 'Packing snow...';
    if (role === 'host') return 'Clearing a spot for your fort...';
    return `Finding room ${code}...`;
  }

  async connect(plan) {
    const seq = ++this.connectSeq;
    this.plan = plan;
    this.state = 'connecting';
    this.welcomed = false;
    this.ui.show('connecting', { text: this.connectingText(plan) });

    let mode = plan.mode ?? null;
    if (plan.role !== 'solo' && !mode) mode = await this.modeReady;
    if (seq !== this.connectSeq) return;

    const d = this.deps;
    let connectFn;
    if (plan.role === 'solo') {
      const base = d.soloConnect();
      connectFn = () => {
        this.soloTransport = base();
        return this.soloTransport;
      };
    } else if (plan.role === 'host') {
      connectFn = d.hostConnect(mode);
    } else {
      connectFn = d.joinConnect(mode, plan.code);
    }

    const session = new d.Session(connectFn, { name: this.prefs.name, look: this.prefs.look, token: plan.token });
    this.session = session;
    this.plan = { ...plan, mode };
    this.attach(session);
    this.ui.setSession(session, { solo: plan.role === 'solo', p2pHost: plan.role === 'host' && mode === 'p2p' });

    try {
      await session.start();
    } catch (err) {
      if (seq !== this.connectSeq) return;
      this.dropSession();
      this.onConnectFailed(this.plan, err);
      return;
    }
    if (seq !== this.connectSeq) {
      session.leave();
      return;
    }
    this.onWelcome(session);
  }

  onConnectFailed(plan, err) {
    const code = err?.code ?? ERR.NET;
    if (plan.resume) clearSaved();
    this.showFront(this.front);
    this.ui.showError(code, plan.code, {
      primary: () => {
        if (code === ERR.NO_ROOM) this.showFront({ name: 'join', data: {} });
        else if (code === ERR.BAD_VERSION) location.reload();
        else if (code === ERR.TIMEOUT) this.connect({ ...plan, resume: false });
      },
    });
  }

  cancelConnect() {
    this.connectSeq += 1;
    // Past WELCOME this is an ordinary leave, with history and the saved session to tidy up.
    if (this.inRoom) { this.leave(); return; }
    // Backing out of a resume means not wanting that room, so a reload must not retry it.
    if (this.plan?.resume) clearSaved();
    const { session } = this;
    if (session) {
      this.dropSession();
      try { session.leave(); } catch { /* it never fully connected */ }
    }
    this.showFront(this.front);
  }

  onWelcome(session) {
    const { role, mode } = this.plan;
    this.welcomed = true;
    this.inRoom = true;
    if (!this.historyPushed) {
      history.pushState({ ff: 'room' }, '');
      this.historyPushed = true;
    }
    this.requestWakeLock();
    if (role !== 'solo') this.audio.ui('join');
    // Solo has no room to come back to, and a P2P host IS the room, so a reload can't rejoin it.
    if (role === 'join' || (role === 'host' && mode === 'server')) {
      writeSaved({ code: session.roomCode, token: session.token, mode });
    }
    if (session.lobby) this.routeLobby(session.lobby);
  }

  // ---- session events -------------------------------------------------------------------

  attach(session) {
    this.handlers = {
      lobby: (state) => { if (this.welcomed) this.routeLobby(state); },
      start: () => this.onStart(),
      meta: (meta) => this.updateMusic(meta),
      result: (result) => this.onResult(result),
      closed: (e) => this.onClosed(session, e),
      fx: (ev) => this.onFx(ev),
    };
    for (const [name, fn] of Object.entries(this.handlers)) session.on(name, fn);
  }

  detach(session) {
    if (!this.handlers) return;
    for (const [name, fn] of Object.entries(this.handlers)) session.off(name, fn);
    this.handlers = null;
  }

  dropSession() {
    const { session } = this;
    if (!session) return;
    this.detach(session);
    this.session = null;
    this.soloTransport = null;
    this.ui.setSession(null);
  }

  routeLobby(state) {
    if (state.state === 'lobby') {
      if (this.pendingAgain) {
        this.pendingAgain = false;
        this.session.lobbyOp(LOBBY_OP.START);
        this.againTimer = setTimeout(() => this.toLobby(), AGAIN_GRACE_MS);
        return;
      }
      if (!this.againTimer && this.state !== 'lobby') this.toLobby();
    } else if (this.state === 'connecting') {
      // A match is running: START and FULL are on their way right behind this message.
      this.ui.show('connecting', { text: 'Hopping into the match...' });
    }
  }

  toLobby() {
    clearTimeout(this.againTimer);
    this.againTimer = 0;
    clearTimeout(this.resultsTimer);
    this.resultsTimer = 0;
    this.state = 'lobby';
    this.matchLive = false;
    this.input.setInMatch(false);
    this.audio.setMusic('menu');
    this.ui.show('lobby');
  }

  onStart() {
    clearTimeout(this.againTimer);
    this.againTimer = 0;
    clearTimeout(this.resultsTimer);
    this.resultsTimer = 0;
    this.state = 'match';
    const { view } = this.session;
    this.renderer.setMap(view.map);
    this.input.setInMatch(true);
    this.matchLive = true;
    document.activeElement?.blur?.();
    this.ui.show('match');
    if (view.meta) this.updateMusic(view.meta);
  }

  updateMusic(meta) {
    if (this.state !== 'match') return;
    if (meta.phase === PHASE.BUILD) this.audio.setMusic('build');
    else if (meta.phase === PHASE.FIGHT) {
      if (meta.boss?.kind === ACTOR.TRUCK) this.audio.setMusic('truck');
      else if (meta.boss?.kind === ACTOR.STEVE) this.audio.setMusic('steve');
      else this.audio.setMusic('fight');
    }
  }

  onResult(result) {
    const won = result.winners.includes(this.session.me);
    this.state = 'results';
    this.input.setInMatch(false);
    this.audio.setMusic(won ? 'win' : 'lose');
    clearTimeout(this.resultsTimer);
    this.resultsTimer = setTimeout(() => {
      this.resultsTimer = 0;
      this.ui.show('results', { result });
    }, RESULTS_DELAY_MS);
  }

  onFx(ev) {
    const view = this.session?.view;
    this.renderer.onFx(ev, view);
    this.audio.onFx(ev, view);
    this.ui.onFx(ev, view);
  }

  onClosed(session, { reason }) {
    if (session !== this.session) return;
    const code = this.plan?.code ?? session.roomCode;
    this.teardownRoom();
    this.showFront({ name: 'title', data: {} });
    if (reason !== CLOSE.LEFT) this.ui.showError(reason, code);
  }

  // ---- leaving --------------------------------------------------------------------------

  leave() {
    const { session } = this;
    if (!session) return;
    this.teardownRoom();
    session.leave();
    this.showFront({ name: 'title', data: {} });
  }

  teardownRoom() {
    clearTimeout(this.againTimer);
    clearTimeout(this.resultsTimer);
    this.againTimer = 0;
    this.resultsTimer = 0;
    this.pendingAgain = false;
    this.inRoom = false;
    this.historyPushed = false;
    this.welcomed = false;
    this.matchLive = false;
    clearSaved();
    this.stripJoin();
    this.input.setInMatch(false);
    this.dropSession();
    this.wakeLock?.release?.().catch?.(() => {});
    this.wakeLock = null;
    this.audio.setMusic('menu');
  }

  stripJoin() {
    const url = new URL(location.href);
    if (!url.searchParams.has('join')) return;
    url.searchParams.delete('join');
    history.replaceState(null, '', url);
  }

  // ---- page and system events --------------------------------------------------------------

  bindUi() {
    const { ui } = this;
    ui.on('solo', () => { this.front = { name: 'title', data: {} }; this.connect({ role: 'solo' }); });
    ui.on('host', () => { this.front = { name: 'title', data: {} }; this.connect({ role: 'host' }); });
    ui.on('join', (code) => {
      if (ui.current === 'join') this.front = { name: 'join', data: { code } };
      else if (ui.current === 'invite') this.front = { name: 'invite', data: { code } };
      this.connect({ role: 'join', code });
    });
    ui.on('cancelConnect', () => this.cancelConnect());
    ui.on('leave', () => this.leave());
    ui.on('menu', () => this.applyPause());
    ui.on('fullscreen', () => this.toggleFullscreen());
    ui.on('playAgain', () => {
      this.pendingAgain = true;
      this.session?.lobbyOp(LOBBY_OP.RETURN);
    });
    ui.on('toLobby', () => this.session?.lobbyOp(LOBBY_OP.RETURN));
  }

  bindPage() {
    const resize = () => this.renderer.resize();
    new ResizeObserver(resize).observe(this.rootEl);
    globalThis.visualViewport?.addEventListener('resize', resize);

    document.addEventListener('gesturestart', (e) => e.preventDefault());
    document.addEventListener('visibilitychange', () => this.onVisibility());
    window.addEventListener('popstate', () => this.onPopState());
    window.addEventListener('beforeunload', (e) => this.onBeforeUnload(e));
    window.addEventListener('pageshow', (e) => { if (e.persisted) location.reload(); });
  }

  onVisibility() {
    const hidden = document.hidden;
    this.session?.setBackground(hidden);
    this.input.clearHeld();
    this.audio.setHidden(hidden);
    this.applyPause();
    clearInterval(this.backgroundTimer);
    this.backgroundTimer = 0;
    if (hidden) {
      // rAF stops in a hidden tab, but the session still has to answer pings and hold its place.
      this.backgroundTimer = setInterval(() => this.session?.update(BACKGROUND_TICK_MS / 1000), BACKGROUND_TICK_MS);
    } else {
      this.lastFrame = 0;
      this.requestWakeLock();
      this.armAudioUnlock();
    }
  }

  applyPause() {
    this.soloTransport?.setPaused?.(document.hidden || !!this.ui.menuEntry);
  }

  onPopState() {
    if (!this.inRoom) return;
    history.pushState({ ff: 'room' }, '');
    this.ui.askLeave();
  }

  onBeforeUnload(e) {
    const p2pHost = this.inRoom && this.ui.roomInfo.p2pHost;
    if (!p2pHost && this.state !== 'match') return;
    e.preventDefault();
    e.returnValue = '';
  }

  async requestWakeLock() {
    if (!this.inRoom) return;
    try {
      this.wakeLock = await navigator.wakeLock?.request('screen');
    } catch {
      // Refused in the background and on low battery. The screen may dim, nothing more.
      this.wakeLock = null;
    }
  }

  async toggleFullscreen() {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
        return;
      }
      await document.documentElement.requestFullscreen();
    } catch {
      return;
    }
    try {
      await screen.orientation?.lock?.('landscape');
    } catch { /* desktops and some phones can't lock, and the game still plays */ }
  }

  armAudioUnlock() {
    if (this.unlockArmed) return;
    this.unlockArmed = true;
    for (const name of UNLOCK_EVENTS) window.addEventListener(name, this.tryUnlockAudio, true);
  }

  // Stays armed until the context really runs: iOS can refuse a resume and needs another gesture.
  tryUnlockAudio() {
    this.audio.unlock();
    if (this.audio.ctx?.state !== 'running') return;
    this.unlockArmed = false;
    for (const name of UNLOCK_EVENTS) window.removeEventListener(name, this.tryUnlockAudio, true);
  }

  // ---- the loop ---------------------------------------------------------------------------

  frame(now) {
    requestAnimationFrame(this.frame);
    const dt = this.lastFrame ? Math.min((now - this.lastFrame) / 1000, MAX_DT) : FIRST_DT;
    this.lastFrame = now;
    const { session } = this;
    if (!session) {
      this.ui.update(null, dt);
      return;
    }
    const { view } = session;
    if (this.matchLive) session.setFrameInput(this.input.sample(view));
    session.update(dt);
    if (this.matchLive && view?.map) {
      this.renderer.render(view, this.input.uiState(view), dt);
      this.audio.update(view);
      this.ui.update(view, dt);
    } else {
      this.ui.update(null, dt);
    }
  }
}

export function boot(deps) {
  const app = new App(deps);
  const { renderer, input, ui, audio } = app;
  globalThis.__ff = {
    get session() { return app.session; },
    renderer, input, ui, audio, app,
  };
  app.start();
  return app;
}

// The harness sets this first so it can boot the same App with mock parts.
if (!globalThis.__ffHarness) boot();
