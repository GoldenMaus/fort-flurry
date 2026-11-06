// The lobby. One screen serves solo, host and guest, and the host can change hands while it is open,
// so every control is derived from the latest LOBBY_STATE rather than from how the player arrived.
import {
  DIFFICULTY, LOBBY_OP, MODE, MODE_NAME, TEAM, TEAM_NAME,
} from '../../shared/schema.js';
import { LOOK, MAX_PLAYERS, NAME_MAX, ROOM_CODE_LEN, SIEGE, TEAM_STYLE } from '../../shared/constants.js';
import { MAPS, getMap } from '../../shared/maps.js';
import { clear, el } from './dom.js';
import { ICON } from './art.js';
import { DIFFICULTY_NAME, LENGTH_NAME, MODE_BLURB } from './copy.js';
import { kidCanvas, paintKid, paintMap } from './kidview.js';
import { ChatPanel } from './chat.js';
import { menuButton } from './title.js';
import { cleanName } from './store.js';

const LOOK_PARTS = [['hat', 'Hat'], ['coat', 'Coat'], ['scarf', 'Scarf'], ['skin', 'Skin']];

const isCoarse = () => matchMedia('(pointer: coarse)').matches;

function segment(label, options, onPick) {
  const buttons = new Map();
  const row = el('div', { class: 'seg', role: 'radiogroup', 'aria-label': label });
  for (const [value, text] of options) {
    const btn = el('button', {
      type: 'button',
      class: 'seg-btn',
      role: 'radio',
      'aria-checked': 'false',
      text,
      dataset: { value: String(value) },
      on: { click: () => onPick(value) },
    });
    buttons.set(String(value), btn);
    row.append(btn);
  }
  return {
    root: row,
    set(value, disabled) {
      for (const [v, btn] of buttons) {
        const on = v === String(value);
        btn.classList.toggle('on', on);
        btn.setAttribute('aria-checked', String(on));
        btn.disabled = !!disabled;
      }
    },
  };
}

const field = (label, control, extra) => el('div', { class: 'setup-field' },
  el('span', { class: 'setup-label', text: label }), control, extra ?? null);

export class LobbyScreen {
  constructor(ui) {
    this.ui = ui;
    this.state = null;
    this.look = ui.prefs.look;
    this.copyTimer = 0;
    this.cards = new Map();

    this.buildHead();
    this.buildEditor();
    this.buildCrew();
    this.buildSetup();
    this.chat = new ChatPanel(ui, ui.chatLog);
    this.buildFoot();

    this.root = el('section', { class: 'screen screen-lobby', dataset: { screen: 'lobby' } },
      this.head,
      el('div', { class: 'lobby-main' },
        this.editor,
        this.crew,
        el('div', { class: 'lobby-side' }, this.setup, this.chat.root)),
      this.foot);
  }

  // ---- head ---------------------------------------------------------------------

  buildHead() {
    const { ui } = this;
    this.codeTiles = el('div', { class: 'room-code', id: 'room-code', 'aria-label': 'Room code' });
    this.linkField = el('input', { class: 'invite-link', id: 'invite-link', type: 'text', readonly: true, 'aria-label': 'Invite link' });
    this.copyBtn = menuButton('Copy Invite Link', { tone: 'mustard', iconName: 'link', id: 'btn-copy-invite', on: () => this.copyInvite() });
    this.inviteNote = el('p', { class: 'invite-note', hidden: true });
    this.roomBlock = el('div', { class: 'room-block' },
      el('div', { class: 'room-label', text: 'Room code' }), this.codeTiles);
    this.inviteBlock = el('div', { class: 'invite-block' },
      el('div', { class: 'invite-row' }, this.copyBtn, this.linkField), this.inviteNote);
    this.soloTitle = el('h2', { class: 'lobby-solo-title', text: 'Pick your game', hidden: true });
    this.head = el('header', { class: 'lobby-head' },
      menuButton('Leave', { tone: 'ghost', iconName: 'back', id: 'btn-lobby-leave', on: () => ui.confirmLeave() }),
      this.soloTitle, this.roomBlock, this.inviteBlock);
  }

  async copyInvite() {
    const link = this.linkField.value;
    if (!link) return;
    if (isCoarse() && navigator.share) {
      try {
        await navigator.share({ title: 'Fort Flurry', text: 'Come defend the fort!', url: link });
        this.flashCopied();
      } catch (err) {
        // Dismissing the share sheet is a normal choice, not a failure to fall back from.
        if (err?.name !== 'AbortError') this.copyFallback(link);
      }
      return;
    }
    this.copyFallback(link);
  }

  async copyFallback(link) {
    if (globalThis.isSecureContext && navigator.clipboard) {
      try {
        await navigator.clipboard.writeText(link);
        this.flashCopied();
        return;
      } catch { /* permission refused, the visible field still works */ }
    }
    this.linkField.focus();
    this.linkField.select();
    let copied = false;
    try { copied = document.execCommand('copy'); } catch { copied = false; }
    if (copied) this.flashCopied();
  }

  flashCopied() {
    const label = this.copyBtn.querySelector('.btn-label');
    label.textContent = 'Copied!';
    this.copyBtn.classList.add('copied');
    clearTimeout(this.copyTimer);
    this.copyTimer = setTimeout(() => {
      label.textContent = 'Copy Invite Link';
      this.copyBtn.classList.remove('copied');
    }, 2000);
  }

  // ---- your kid -------------------------------------------------------------------

  buildEditor() {
    const { ui } = this;
    this.preview = el('canvas', { class: 'kid-preview', 'aria-hidden': 'true' });
    this.nameInput = el('input', {
      class: 'name-input', id: 'lobby-name', type: 'text', maxlength: String(NAME_MAX), autocomplete: 'off', autocorrect: 'off', spellcheck: 'false',
      'aria-label': 'Your name',
    });
    this.nameInput.addEventListener('change', () => this.commitName());
    this.nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) this.nameInput.blur(); });

    this.pickers = {};
    const rows = LOOK_PARTS.map(([part, label]) => {
      const row = el('div', { class: `look-options look-${part}`, role: 'radiogroup', 'aria-label': label });
      this.pickers[part] = LOOK[part].map((value, i) => {
        const btn = el('button', {
          type: 'button',
          class: 'look-opt',
          role: 'radio',
          'aria-checked': 'false',
          'aria-label': `${label} ${i + 1}`,
          on: { click: () => this.setLook(part, i) },
        });
        if (part === 'hat') btn.append(el('canvas', { class: 'hat-canvas', 'aria-hidden': 'true' }));
        else btn.style.setProperty('--swatch', value);
        row.append(btn);
        return btn;
      });
      return el('div', { class: 'look-row' }, el('span', { class: 'look-label', text: label }), row);
    });

    this.teamPick = el('div', { class: 'team-pick', role: 'radiogroup', 'aria-label': 'Team', hidden: true });
    this.teamBtns = [TEAM.A, TEAM.B].map((team) => {
      const btn = el('button', {
        type: 'button',
        class: 'team-btn',
        role: 'radio',
        'aria-checked': 'false',
        text: TEAM_NAME[team],
        style: { '--team': TEAM_STYLE[team].color },
        on: { click: () => ui.session?.lobbyOp(LOBBY_OP.ME, { team }) },
      });
      this.teamPick.append(btn);
      return btn;
    });
    this.readyBtn = el('button', {
      type: 'button',
      class: 'ready-toggle',
      id: 'btn-lobby-ready',
      on: { click: () => this.toggleReady() },
    }, el('span', { class: 'ready-box', trustedHtml: ICON.check }), el('span', { text: "I'm ready" }));

    this.editorBody = el('div', { class: 'editor-body' }, ...rows, this.teamPick, this.readyBtn);
    this.editorToggle = el('button', {
      type: 'button',
      class: 'editor-toggle',
      'aria-expanded': 'false',
      text: 'Dress up',
      on: {
        click: () => {
          const open = this.editor.classList.toggle('open');
          this.editorToggle.setAttribute('aria-expanded', String(open));
        },
      },
    });
    this.editor = el('section', { class: 'panel kid-panel' },
      el('h3', { class: 'panel-title', text: 'Your kid' }),
      el('div', { class: 'kid-stage' }, this.preview),
      this.nameInput,
      this.editorToggle,
      this.editorBody);
  }

  commitName() {
    const name = cleanName(this.nameInput.value);
    if (!name) { this.nameInput.value = this.ui.prefs.name; return; }
    this.nameInput.value = name;
    this.ui.prefs.name = name;
    this.ui.session?.lobbyOp(LOBBY_OP.ME, { name });
  }

  setLook(part, i) {
    this.look = { ...this.look, [part]: i };
    this.ui.prefs.look = this.look;
    this.ui.session?.lobbyOp(LOBBY_OP.ME, { look: this.look });
    this.paintEditor();
  }

  toggleReady() {
    const me = this.mePlayer();
    if (me) this.ui.session?.lobbyOp(LOBBY_OP.ME, { ready: !me.ready });
  }

  mePlayer() {
    const id = this.ui.session?.me;
    return this.state?.players.find((p) => p.id === id) ?? null;
  }

  teamPaint() {
    return this.state?.settings.mode === MODE.FORTWARS ? this.mePlayer()?.team : undefined;
  }

  paintEditor() {
    const team = this.teamPaint();
    paintKid(this.preview, this.look, { w: 236, h: 248, team });
    this.pickers.hat.forEach((btn, i) => {
      paintKid(btn.firstElementChild, { ...this.look, hat: i }, { w: 40, h: 40, team });
    });
    for (const [part] of LOOK_PARTS) {
      this.pickers[part].forEach((btn, i) => {
        const on = this.look[part] === i;
        btn.classList.toggle('on', on);
        btn.setAttribute('aria-checked', String(on));
      });
    }
  }

  // ---- crew -------------------------------------------------------------------------

  buildCrew() {
    this.crewCount = el('span', { class: 'crew-count' });
    this.crewBody = el('div', { class: 'crew-body' });
    this.crew = el('section', { class: 'panel crew-panel' },
      el('h3', { class: 'panel-title' }, 'The crew ', this.crewCount),
      this.crewBody);
  }

  playerCard(p, ctx) {
    const { meId, hostId, canEdit, team } = ctx;
    const isMe = p.id === meId;
    const lookKey = JSON.stringify([p.look, team]);
    let cached = this.cards.get(p.id);
    if (!cached || cached.key !== lookKey) {
      cached = { key: lookKey, canvas: kidCanvas(p.look, { w: 156, h: 166, team }) };
      this.cards.set(p.id, cached);
    }
    const badges = el('div', { class: 'kid-badges' },
      p.id === hostId ? el('span', { class: 'badge badge-host', title: 'Host', trustedHtml: ICON.crown }) : null,
      p.isBot ? el('span', { class: 'badge badge-bot', text: 'Bot' }) : null,
      isMe ? el('span', { class: 'badge badge-me', text: 'You' }) : null,
      !p.connected && !p.isBot ? el('span', { class: 'badge badge-away', text: 'Away' }) : null);
    const remove = canEdit && !isMe
      ? el('button', {
        type: 'button',
        class: 'kid-remove',
        'aria-label': p.isBot ? `Remove ${p.name}` : `Kick ${p.name}`,
        title: p.isBot ? 'Remove bot' : 'Remove from room',
        trustedHtml: ICON.close,
        on: {
          click: () => {
            const op = p.isBot ? LOBBY_OP.DEL_BOT : LOBBY_OP.KICK;
            this.ui.session?.lobbyOp(op, { id: p.id });
          },
        },
      })
      : null;
    return el('article', {
      class: `kid-card${isMe ? ' me' : ''}${p.ready ? ' ready' : ''}${p.isBot ? ' bot' : ''}${!p.connected && !p.isBot ? ' away' : ''}`,
      dataset: { player: String(p.id) },
      style: team === undefined ? undefined : { '--team': TEAM_STYLE[team]?.color ?? 'transparent' },
    },
    el('span', { class: 'kid-clip', 'aria-hidden': 'true' }),
    remove,
    el('div', { class: 'kid-card-art' }, cached.canvas),
    el('p', { class: 'kid-name', text: p.name }),
    badges,
    el('span', { class: 'kid-ready', title: 'Ready', trustedHtml: ICON.check }));
  }

  addBotCard(team) {
    return el('button', {
      type: 'button',
      class: 'kid-card add-card',
      on: { click: () => this.ui.session?.lobbyOp(LOBBY_OP.ADD_BOT, team === undefined ? {} : { team }) },
    },
    el('span', { class: 'add-plus', trustedHtml: ICON.plus }),
    el('span', { class: 'add-label', text: 'Add a bot' }));
  }

  // Empty pegs on the line show how many friends can still join.
  emptyPegs(count) {
    return Array.from({ length: Math.max(0, count) }, () => el('div', { class: 'kid-card empty-card', 'aria-hidden': 'true' },
      el('span', { class: 'kid-clip' })));
  }

  renderCrew() {
    const { state } = this;
    const session = this.ui.session;
    const canEdit = state.hostId === session.me;
    const full = state.players.length >= MAX_PLAYERS;
    this.crewCount.textContent = `${state.players.length}/${MAX_PLAYERS}`;
    const ctx = { meId: session.me, hostId: state.hostId, canEdit };
    clear(this.crewBody);
    if (state.settings.mode === MODE.FORTWARS) {
      this.crewBody.className = 'crew-body crew-teams';
      for (const team of [TEAM.A, TEAM.B]) {
        const grid = el('div', { class: 'crew-grid' },
          state.players.filter((p) => p.team === team).map((p) => this.playerCard(p, { ...ctx, team })));
        if (canEdit && !full) grid.append(this.addBotCard(team));
        this.crewBody.append(el('div', { class: 'team-col', style: { '--team': TEAM_STYLE[team].color } },
          el('h4', { class: 'team-head', text: TEAM_NAME[team] }), grid));
      }
    } else {
      this.crewBody.className = 'crew-body';
      const grid = el('div', { class: 'crew-grid' }, state.players.map((p) => this.playerCard(p, ctx)));
      if (canEdit && !full) grid.append(this.addBotCard());
      grid.append(...this.emptyPegs(MAX_PLAYERS - grid.childElementCount));
      this.crewBody.append(grid);
    }
    const alive = new Set(state.players.map((p) => p.id));
    for (const id of this.cards.keys()) if (!alive.has(id)) this.cards.delete(id);
  }

  // ---- setup ------------------------------------------------------------------------

  buildSetup() {
    const set = (settings) => this.ui.session?.lobbyOp(LOBBY_OP.SET, { settings });
    this.modeSeg = segment('Mode', Object.values(MODE).map((m) => [m, MODE_NAME[m]]), (mode) => set({ mode }));
    this.modeBlurb = el('p', { class: 'setup-blurb' });
    this.mapRow = el('div', { class: 'map-row', role: 'radiogroup', 'aria-label': 'Map' });
    this.mapBtns = new Map();
    for (const map of MAPS) {
      const thumb = el('canvas', { class: 'map-thumb', 'aria-hidden': 'true' });
      paintMap(thumb, map, 104, 70);
      const btn = el('button', {
        type: 'button',
        class: 'map-btn',
        role: 'radio',
        'aria-checked': 'false',
        dataset: { map: map.id },
        on: { click: () => set({ mapId: map.id }) },
      }, thumb, el('span', { class: 'map-name', text: map.name }));
      this.mapBtns.set(map.id, btn);
      this.mapRow.append(btn);
    }
    this.mapBlurb = el('p', { class: 'setup-blurb' });
    this.diffSeg = segment('Difficulty', Object.values(DIFFICULTY).map((d) => [d, DIFFICULTY_NAME[d]]), (difficulty) => set({ difficulty }));
    this.lengthSeg = segment('Length', SIEGE.waveCounts.map((n) => [n, LENGTH_NAME[n]]), (waveCount) => set({ waveCount }));
    this.lengthField = field('Length', this.lengthSeg.root);
    this.diffField = field('Difficulty', this.diffSeg.root);
    this.setup = el('section', { class: 'panel setup-panel' },
      el('h3', { class: 'panel-title', text: 'The game' }),
      field('Mode', this.modeSeg.root, this.modeBlurb),
      field('Map', this.mapRow, this.mapBlurb),
      this.diffField,
      this.lengthField);
  }

  renderSetup() {
    const { settings, hostId } = this.state;
    const locked = hostId !== this.ui.session.me;
    this.setup.classList.toggle('locked', locked);
    this.modeSeg.set(settings.mode, locked);
    this.modeBlurb.textContent = MODE_BLURB[settings.mode] ?? '';
    for (const [id, btn] of this.mapBtns) {
      const on = id === settings.mapId;
      btn.classList.toggle('on', on);
      btn.setAttribute('aria-checked', String(on));
      btn.disabled = locked;
    }
    this.mapBlurb.textContent = getMap(settings.mapId).blurb ?? '';
    this.diffSeg.set(settings.difficulty, locked);
    this.lengthSeg.set(settings.waveCount, locked);
    const siege = settings.mode === MODE.SIEGE;
    // Outside Siege it only sets how sharp the bots are, so it shows when there are some.
    this.diffField.hidden = !siege && !this.state.players.some((p) => p.isBot);
    this.lengthField.hidden = !siege;
  }

  // ---- foot -------------------------------------------------------------------------

  buildFoot() {
    this.status = el('p', { class: 'lobby-status', id: 'lobby-status' });
    this.startBtn = menuButton('Start', { tone: 'red', size: 'btn-xl', id: 'btn-start', on: () => this.ui.session?.lobbyOp(LOBBY_OP.START) });
    this.foot = el('footer', { class: 'lobby-foot' }, this.status, this.startBtn);
  }

  // Why Start is greyed out, or null if it isn't. Room checks the same rules (SPEC 8.3).
  startBlocker() {
    const { settings, players } = this.state;
    if (settings.mode === MODE.FORTWARS) {
      const has = (team) => players.some((p) => p.team === team);
      if (!has(TEAM.A) || !has(TEAM.B)) return `${MODE_NAME.fortwars} needs a kid on each team.`;
    }
    if (settings.mode === MODE.FFA && players.length < 2) return `${MODE_NAME.ffa} needs at least 2 kids.`;
    return null;
  }

  renderFoot() {
    const { state } = this;
    const isHost = state.hostId === this.ui.session.me;
    const blocker = isHost ? this.startBlocker() : null;
    this.startBtn.hidden = !isHost;
    this.startBtn.disabled = !!blocker;
    const host = state.players.find((p) => p.id === state.hostId);
    this.status.classList.toggle('blocked', !!blocker);
    const plan = `${MODE_NAME[state.settings.mode]} on ${getMap(state.settings.mapId).name}`;
    if (isHost) this.status.textContent = blocker ?? plan;
    else this.status.textContent = `Waiting for ${host?.name ?? 'the host'} to start`;
  }

  // ---- lifecycle --------------------------------------------------------------------

  enter() {
    const state = this.ui.session?.lobby;
    this.look = this.ui.prefs.look;
    this.nameInput.value = this.ui.prefs.name;
    if (state) this.setLobby(state);
    this.paintEditor();
  }

  setLobby(state) {
    this.state = state;
    const { ui } = this;
    const { solo } = ui.roomInfo;
    this.root.classList.toggle('solo', !!solo);

    const me = this.mePlayer();
    if (me) {
      // The host may have clamped what we sent, so the room is the source of truth for our own kid.
      if (JSON.stringify(me.look) !== JSON.stringify(this.look)) this.look = { ...me.look };
      if (document.activeElement !== this.nameInput) this.nameInput.value = me.name;
    }

    const code = state.code ?? '';
    if (this.codeTiles.dataset.code !== code) {
      this.codeTiles.dataset.code = code;
      this.codeTiles.setAttribute('aria-label', `Room code ${code}`);
      this.codeTiles.replaceChildren(...[...code.padEnd(ROOM_CODE_LEN).slice(0, ROOM_CODE_LEN)].map((ch, i) => el('span', {
        class: 'room-letter', text: ch, style: { '--i': String(i) },
      })));
    }
    this.linkField.value = ui.inviteLink(code);
    this.soloTitle.hidden = !solo;
    this.roomBlock.hidden = !!solo;
    this.inviteBlock.hidden = !!solo;
    this.chat.root.hidden = !!solo;
    this.readyBtn.hidden = !!solo;

    const fortwars = state.settings.mode === MODE.FORTWARS;
    this.teamPick.hidden = !fortwars;
    if (fortwars && me) {
      this.teamBtns.forEach((btn, i) => {
        const on = me.team === (i === 0 ? TEAM.A : TEAM.B);
        btn.classList.toggle('on', on);
        btn.setAttribute('aria-checked', String(on));
      });
    }
    this.readyBtn.classList.toggle('on', !!me?.ready);

    this.renderCrew();
    this.renderSetup();
    this.renderFoot();
    this.renderNote();
    this.paintEditor();
  }

  // Polled because session.netStatus changes without an event of its own.
  renderNote() {
    const { ui } = this;
    const { p2pHost } = ui.roomInfo;
    let note = '';
    if (ui.session?.netStatus === 'invitesPaused') note = 'Invites paused, reconnecting...';
    else if (p2pHost && isCoarse()) note = 'Keep this tab open and your screen on.';
    if (this.inviteNote.textContent !== note) {
      this.inviteNote.textContent = note;
      this.inviteNote.hidden = !note;
    }
  }

  tick() { if (this.state) this.renderNote(); }
}
