// The interface root. Owns the screens, the dialog stack and the HUD, and turns input events into
// session commands. It decides nothing about the app's flow: main.js listens for what it emits.
import { CMD, PHASE } from '../../shared/schema.js';
import { Emitter, el } from './dom.js';
import { Prefs } from './store.js';
import { SCENE_SVG } from './art.js';
import { ChatLog } from './chat.js';
import { Dialogs, errorDialog, howToDialog, leaveDialog, menuDialog, reconnectDialog, settingsDialog } from './dialogs.js';
import { Hud } from './hud.js';
import { LobbyScreen } from './lobby.js';
import { ResultsScreen } from './results.js';
import { ConnectingScreen, InviteScreen, JoinScreen, TitleScreen, attachSceneToy } from './title.js';

// Which backdrop sits behind each screen. The match has none, the canvas is the backdrop.
const BACKDROP = { title: 'scene', invite: 'scene', join: 'scene', connecting: 'scene', lobby: 'quilt', results: 'dim', match: 'none' };

export class UI extends Emitter {
  constructor(root, { input, renderer, audio, prefs = new Prefs() }) {
    super();
    this.root = root;
    this.input = input;
    this.renderer = renderer;
    this.audio = audio;
    this.prefs = prefs;
    this.hudRoot = root.querySelector('#hud');
    this.screensRoot = root.querySelector('#screens');
    this.dialogsRoot = root.querySelector('#dialogs');
    this.session = null;
    this.roomInfo = {};
    this.current = null;
    this.reconnectEntry = null;
    this.menuEntry = null;
    this.inviteBase = null;
    this.chatLog = new ChatLog();
    this.lowTickAt = 0;
    this.humans = null;
    this.pressedBtn = null;

    this.dialogs = new Dialogs(this.dialogsRoot, this);
    this.hud = new Hud(this.hudRoot, this);
    this.buildScreens();
    this.bindInput();
    this.bindPage();
    this.applyMotion();
    this.onMode(input.mode);

    this.sessionHandlers = {
      lobby: (state) => this.onLobby(state),
      chat: (msg) => this.onChat(msg),
      reconnecting: () => this.onReconnecting(),
      reconnected: () => this.onReconnected(),
      error: (err) => this.onNotice(err),
    };
  }

  buildScreens() {
    this.backdrop = el('div', { class: 'backdrop', 'aria-hidden': 'true' },
      el('div', { class: 'scene', trustedHtml: SCENE_SVG }),
      el('div', { class: 'quilt' }),
      el('div', { class: 'snow snow-far' }), el('div', { class: 'snow snow-mid' }), el('div', { class: 'snow snow-near' }));
    this.screensRoot.append(this.backdrop);
    this.toy = attachSceneToy(this, this.backdrop.querySelector('.scene'));
    this.screens = {
      title: new TitleScreen(this),
      invite: new InviteScreen(this),
      join: new JoinScreen(this),
      connecting: new ConnectingScreen(this),
      lobby: new LobbyScreen(this),
      results: new ResultsScreen(this),
    };
    for (const screen of Object.values(this.screens)) {
      screen.root.hidden = true;
      this.screensRoot.append(screen.root);
    }
  }

  bindInput() {
    const { input } = this;
    input.on('tool', (k) => this.hud.onToolChange(k));
    input.on('build', (data) => this.session?.cmd(CMD.BUILD, data));
    input.on('demolish', (data) => this.session?.cmd(CMD.DEMOLISH, data));
    input.on('denied', (why) => this.hud.showDeny(why));
    input.on('ready', () => this.sendReady());
    input.on('emote', (n) => this.sendEmote(n));
    input.on('card', (i) => this.hud.cards.pick(i));
    input.on('chatOpen', () => this.openChat());
    input.on('scoreboard', (on) => this.hud.scores.setOpen(on));
    input.on('menu', () => this.toggleMenu());
    input.on('mute', () => this.toggleMute());
    input.on('shoutMenu', (open) => this.hud.setShoutMenu(open));
    input.on('shoutSelect', (i) => this.hud.setShoutSelection(i));
    input.on('mode', (m) => this.onMode(m));
    input.on('nav', (dir) => this.dialogs.nav(dir));
  }

  bindPage() {
    const { root, audio } = this;
    // One delegated listener instead of wiring sounds into every button.
    root.addEventListener('click', (e) => {
      if (e.target.closest?.('button:not([disabled])')) audio.ui('click');
    });
    root.addEventListener('pointerdown', (e) => { this.pressedBtn = e.target.closest?.('button') ?? null; }, true);
    root.addEventListener('pointerover', (e) => {
      if (e.pointerType !== 'mouse') return;
      const btn = e.target.closest?.('button:not([disabled])');
      if (btn && !btn.contains(e.relatedTarget)) audio.ui('hover');
    });
    window.addEventListener('keydown', (e) => {
      if (this.dialogs.any) return;
      if (e.key === 'Escape' && this.current === 'join') { this.show('title'); return; }
      // Enter jumps to the chat box on the two screens that have one. Never in a match: Input owns that.
      if (e.key !== 'Enter' || e.isComposing) return;
      if (this.current !== 'lobby' && this.current !== 'results') return;
      if (this.roomInfo.solo) return;
      const tag = e.target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      // A button keeps focus after a click, and Enter must not press it again by surprise. One reached
      // with Tab is different. :focus-visible can't tell them apart: any key press turns it on.
      if (tag === 'BUTTON' && e.target !== this.pressedBtn) return;
      e.preventDefault();
      this.screens[this.current].chat.focus();
    });
  }

  // ---- screens ---------------------------------------------------------------------

  show(name, data = {}) {
    const previous = this.current;
    if (previous && previous !== 'match') this.screens[previous].root.hidden = true;
    if (previous === 'match' && name !== 'match') this.hud.exit();
    this.current = name;
    this.screensRoot.dataset.backdrop = BACKDROP[name] ?? 'quilt';
    this.dialogs.closeAll();
    this.reconnectEntry = null;
    this.menuEntry = null;
    if (name === 'match') {
      this.screensRoot.hidden = true;
      this.hud.enter();
    } else {
      this.screensRoot.hidden = false;
      const screen = this.screens[name];
      screen.root.hidden = false;
      screen.root.classList.remove('entering');
      void screen.root.offsetWidth;
      screen.root.classList.add('entering');
      screen.enter?.(data);
    }
    this.refreshInput();
  }

  setSession(session, info = {}) {
    if (this.session) {
      for (const [name, fn] of Object.entries(this.sessionHandlers)) this.session.off(name, fn);
    }
    this.session = session;
    this.roomInfo = session ? info : {};
    this.humans = null;
    if (session) {
      for (const [name, fn] of Object.entries(this.sessionHandlers)) session.on(name, fn);
    } else {
      this.chatLog.reset();
    }
  }

  update(view, dt) {
    if (this.current === 'match' && view) {
      this.hud.update(view, dt);
      return;
    }
    const now = performance.now();
    if (this.current === 'lobby' && now >= this.lowTickAt) {
      this.lowTickAt = now + 500;
      this.screens.lobby.tick();
    }
  }

  onFx(ev, view) { this.hud.onFx(ev, view); }

  // ---- session events --------------------------------------------------------------

  onLobby(state) {
    const humans = state.players.filter((p) => !p.isBot).length;
    if (this.humans !== null && humans > this.humans) this.audio.ui('join');
    this.humans = humans;
    if (this.current === 'lobby') this.screens.lobby.setLobby(state);
    else if (this.current === 'results') this.screens.results.setLobby(state);
  }

  onChat(msg) {
    this.chatLog.add(msg);
    if (this.current === 'match') this.hud.addChatLine(this.chatLog.lines[this.chatLog.lines.length - 1]);
  }

  onReconnecting() {
    if (this.reconnectEntry) return;
    this.closeMenu();
    this.reconnectEntry = reconnectDialog(this);
    this.refreshInput();
  }

  onReconnected() {
    this.reconnectEntry?.close();
    this.reconnectEntry = null;
    this.refreshInput();
  }

  onNotice(err) {
    if (this.current === 'match' && err?.msg) this.hud.showNotice(String(err.msg));
  }

  // ---- actions -----------------------------------------------------------------------

  // The one place that decides whether game input is live.
  refreshInput() {
    const live = this.current === 'match' && !this.dialogs.any && !this.hud.chatOpen;
    this.input.setEnabled(live);
  }

  sendReady() {
    if (this.session?.view?.phase === PHASE.BUILD) this.session.cmd(CMD.READY);
  }

  sendEmote(n) { this.session?.cmd(CMD.EMOTE, { n }); }

  openChat() {
    // Solo has nobody to talk to, and a touch match has no keyboard to spare (SPEC 11.1).
    if (this.roomInfo.solo || this.current !== 'match' || this.input.mode === 'touch') return;
    this.hud.openChat();
  }

  toggleMenu() {
    if (this.current !== 'match') return;
    if (this.menuEntry) { this.closeMenu(); return; }
    if (this.dialogs.any) return;
    this.menuEntry = menuDialog(this);
    this.emit('menu', true);
  }

  closeMenu() {
    if (!this.menuEntry) return;
    const entry = this.menuEntry;
    this.menuEntry = null;
    // Sub-dialogs opened from the Menu go first, so nothing is left floating over the match.
    while (this.dialogs.top && this.dialogs.top !== entry) this.dialogs.top.close();
    entry.close();
    this.emit('menu', false);
  }

  openSettings() { settingsDialog(this); }
  openHowTo() { howToDialog(this); }

  // Leaving is a one-click affair unless it would cost something: a match in progress, or for a P2P
  // host, the room itself.
  confirmLeave() {
    const quiet = this.current !== 'match' && !this.roomInfo.p2pHost;
    if (quiet) this.emit('leave');
    else leaveDialog(this);
  }

  askLeave() { leaveDialog(this); }

  showError(code, room, handlers) { return errorDialog(this, code, room, handlers); }

  toggleMute() {
    this.prefs.muted = !this.prefs.muted;
    this.applyAudio();
    if (this.current === 'match') this.hud.showNotice(this.prefs.muted ? 'Sound off' : 'Sound on', 1400);
  }

  applyAudio() { this.audio.setVolumes(this.prefs.audioLevels); }

  setReduceMotion(on) {
    this.prefs.reduceMotion = on;
    this.input.reduceMotion = on;
    this.applyMotion();
  }

  applyMotion() { document.documentElement.classList.toggle('reduce-motion', this.prefs.reduceMotion); }

  onMode(mode) {
    document.documentElement.dataset.input = mode;
    this.hud.setMode(mode);
  }

  inviteLink(code) {
    const base = this.inviteBase ?? `${location.origin}${location.pathname}`;
    return `${base}?join=${code}`;
  }

  setNetReady(ready) { this.screens.title.setNetReady(ready); }
}
