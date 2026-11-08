// The in-match HUD. Runs every frame, so all writes go through Memo and the heavier widgets refresh
// a few times a second. One DOM serves both the full and the compact layout; CSS rearranges it.
import {
  ACTOR, AFLAG, EMOTES, EV, MODE, PHASE, PICKUP, STRUCT, TEAM, TEAM_NAME,
} from '../../shared/schema.js';
import { BUILD, CLASSIC, FFA, FOES, KID, SPECIAL, TEAM_STYLE } from '../../shared/constants.js';
import { Memo, clamp01, el, fmtClock, hudBtn } from './dom.js';
import { ICON } from './art.js';
import { iconNode } from './kidview.js';
import { DENY_COPY } from './copy.js';
import { Scoreboard } from './scoreboard.js';
import { CardPanel } from './cardpanel.js';
import { TipEngine } from './tips.js';

const TOOLS = [STRUCT.WALL, STRUCT.ICEWALL, STRUCT.DECOY, STRUCT.PULT, STRUCT.SLICK, STRUCT.COCOA, 'demolish'];
const UNLIMITED_SHARE = 65535;
const NO_SPECIAL = 255;
const SLOW_TICK_MS = 200;
const BANNER_MS = 2800;
const DENY_MS = 1500;
const CHAT_LINE_MS = 9000;
const ARROW_CLEARANCE = 30;

const hasFlag = (actor, flag) => !!actor && (actor.flags & flag) !== 0;

export class Hud {
  constructor(root, ui) {
    this.root = root;
    this.ui = ui;
    this.memo = new Memo();
    this.slowAt = 0;
    this.bannerQueue = [];
    this.bannerUntil = 0;
    this.denyUntil = 0;
    this.tipUntil = 0;
    this.pipNodes = [];
    this.colonelNodes = new Map();
    this.previewKey = '';
    this.matesKey = '';
    this.mateNodes = new Map();
    this.specialIcons = new Map();
    this.flakesShown = null;
    this.trayOpen = false;
    this.tips = new TipEngine(ui.prefs, (id, text, ms) => this.showTip(id, text, ms));
    this.build();
  }

  // ---- construction ---------------------------------------------------------------

  build() {
    const { ui } = this;
    const { input } = ui;

    this.warmthFill = el('span', { class: 'warmth-fill' });
    this.warmthNum = el('span', { class: 'warmth-num' });
    this.warmth = el('div', { class: 'warmth', role: 'img', 'aria-label': 'Warmth' },
      el('span', { class: 'warmth-track' }, this.warmthFill), this.warmthNum);
    this.pips = el('div', { class: 'pips', role: 'img', 'aria-label': 'Snowballs' });
    this.specialBox = el('div', { class: 'special', hidden: true });
    this.specialCount = el('span', { class: 'special-count' });
    this.slideRing = el('div', { class: 'slide-cd', title: 'Belly slide' },
      el('span', { class: 'slide-ico', trustedHtml: ICON.bolt }));
    this.whoRow = el('div', { class: 'who-row' }, this.specialBox, this.slideRing);
    this.who = el('div', { class: 'hud-who patch' }, this.warmth, this.pips, this.whoRow);

    this.phaseLabel = el('span', { class: 'phase-label' });
    this.phaseTime = el('span', { class: 'phase-time' });
    this.phaseBtn = hudBtn({
      class: 'phase patch',
      id: 'hud-timer',
      'aria-label': 'Show scores',
      on: { click: () => this.scores.toggle() },
    }, this.phaseLabel, this.phaseTime);
    this.waveName = el('div', { class: 'wave-name' });
    this.colonels = el('div', { class: 'colonels' });
    this.bossName = el('span', { class: 'boss-name' });
    this.bossFill = el('span', { class: 'boss-fill' });
    this.boss = el('div', { class: 'boss', hidden: true },
      this.bossName, el('span', { class: 'boss-track' }, this.bossFill));
    this.previewRow = el('div', { class: 'preview-row' });
    this.preview = el('div', { class: 'preview patch', hidden: true },
      el('span', { class: 'preview-label', text: 'Coming next' }), this.previewRow);
    this.center = el('div', { class: 'hud-center' },
      this.phaseBtn, this.waveName, this.colonels, this.boss, this.preview);

    this.flakesNum = el('span', { class: 'flakes-num' });
    this.flakes = el('div', { class: 'flakes patch', title: 'Flakes' }, iconNode('flake', 22), this.flakesNum);
    this.menuBtn = hudBtn({
      class: 'hud-menu patch',
      id: 'hud-menu',
      'aria-label': 'Menu',
      trustedHtml: ICON.menu,
      on: { click: () => ui.toggleMenu() },
    });
    this.ping = el('div', { class: 'ping', hidden: true });
    this.mates = el('div', { class: 'mates' });
    this.rightCol = el('div', { class: 'hud-right' },
      el('div', { class: 'hud-right-row' }, this.flakes, this.menuBtn), this.ping, this.mates);

    this.bannerText = el('div', { class: 'banner-text' });
    this.bannerSub = el('div', { class: 'banner-sub' });
    this.banner = el('div', { class: 'banner', hidden: true, role: 'status' }, this.bannerText, this.bannerSub);
    this.frozenMsg = el('div', { class: 'frozen-msg', hidden: true, role: 'status' });
    this.hopIn = el('div', { class: 'hop-in', id: 'hop-in', hidden: true, text: "You'll hop in at the next build phase." });
    this.deny = el('div', { class: 'deny', hidden: true, role: 'alert' });
    this.tip = el('div', { class: 'tip', hidden: true, role: 'status' });

    this.trayInfoName = el('span', { class: 'tray-info-name' });
    this.trayInfoBlurb = el('span', { class: 'tray-info-blurb' });
    this.trayInfo = el('div', { class: 'tray-info', hidden: true }, this.trayInfoName, this.trayInfoBlurb);
    this.share = el('div', { class: 'share', hidden: true });
    this.tools = new Map();
    this.tray = el('div', { class: 'tray', role: 'toolbar', 'aria-label': 'Build tools' });
    for (const k of TOOLS) this.tray.append(this.toolButton(k));
    this.hammer = hudBtn({
      class: 'hammer patch',
      id: 'hud-hammer',
      'aria-label': 'Open the build tray',
      trustedHtml: ICON.hammer,
      on: { click: () => this.setTrayOpen(!this.trayOpen) },
    });
    this.readyCount = el('span', { class: 'ready-count' });
    this.readyKey = el('kbd', { class: 'ready-key', text: 'R' });
    this.readyBtn = hudBtn({
      class: 'ready-btn',
      id: 'hud-ready',
      hidden: true,
      on: { click: () => ui.sendReady() },
    }, this.readyKey, el('span', { class: 'ready-word', text: 'Ready' }), this.readyCount);
    // Ready hangs off the tray instead of sharing its row, so the tray doesn't jump when it goes.
    this.trayWrap = el('div', { class: 'tray-wrap' }, this.trayInfo, this.share, this.tray, this.hammer, this.readyBtn);

    this.slideBtn = this.holdButton('slide', 'Slide', ICON.bolt);
    this.lobBtn = this.holdButton('lob', 'Lob', ICON.arc);
    this.shoutBtn = hudBtn({
      class: 'action action-shout',
      id: 'hud-shout',
      'aria-label': 'Shout',
      trustedHtml: ICON.shout,
      on: { click: () => input.setShout(!input.shoutOpen) },
    });
    this.actions = el('div', { class: 'actions' }, this.shoutBtn, this.lobBtn, this.slideBtn);

    this.shoutItems = EMOTES.map((text, n) => hudBtn({
      class: 'shout-item',
      dataset: { n: String(n) },
      on: { click: () => { ui.sendEmote(n); input.setShout(false); } },
    }, el('kbd', { class: 'shout-key', text: String(n + 1) }), el('span', { text })));
    this.shout = el('div', { class: 'shout patch', id: 'shout-menu', hidden: true, role: 'menu' },
      el('div', { class: 'shout-title', text: 'Shout' }), this.shoutItems);

    this.scores = new Scoreboard(ui);
    this.cards = new CardPanel(ui);

    this.chatLog = el('div', { class: 'match-chat-log' });
    this.chatInput = el('input', {
      class: 'match-chat-input',
      id: 'match-chat-input',
      type: 'text',
      maxlength: '120',
      placeholder: 'Press Enter to send',
      autocomplete: 'off',
      enterkeyhint: 'send',
      'aria-label': 'Chat message',
    });
    this.chatBox = el('div', { class: 'match-chat', hidden: true }, this.chatLog, this.chatInput);
    this.chatInput.addEventListener('keydown', (e) => this.onChatKey(e));

    this.hiccup = el('div', { class: 'hiccup', id: 'hiccup', hidden: true, role: 'status', text: 'Connection hiccup...' });
    this.notice = el('div', { class: 'notice', hidden: true, role: 'status' });
    // Dismissible: some players will stay upright on purpose, and it sits over the playfield.
    this.rotateDismissed = false;
    this.rotate = hudBtn({
      class: 'rotate-hint',
      id: 'rotate-hint',
      hidden: true,
      on: { click: () => { this.rotateDismissed = true; } },
    },
    el('span', { class: 'rotate-phone', trustedHtml: ICON.phone }),
    el('span', { text: 'Turn your phone sideways for a better view.' }));

    const safe = el('div', { class: 'hud-safe' },
      el('div', { class: 'hud-top' }, this.who, this.center, this.rightCol),
      el('div', { class: 'hud-mid' }, this.banner, this.hopIn, this.frozenMsg),
      el('div', { class: 'hud-low' }, this.deny, this.tip),
      el('div', { class: 'hud-bottom' }, this.trayWrap),
      this.actions,
      this.cards.root,
      this.shout,
      this.scores.root,
      this.chatBox,
      this.hiccup,
      this.notice,
      this.rotate);
    this.root.replaceChildren(safe);
    this.root.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  toolButton(k) {
    const { input } = this.ui;
    const demolish = k === 'demolish';
    const info = demolish ? { name: 'Demolish', blurb: 'Take down your own builds for a partial refund.', cost: null, key: 'X' } : BUILD[k];
    const count = el('span', { class: 'tool-count', hidden: true });
    const cost = el('span', { class: 'tool-cost' }, demolish ? '' : String(info.cost));
    const btn = hudBtn({
      class: `tool${demolish ? ' tool-demolish' : ''}`,
      dataset: { tool: String(k) },
      'aria-label': info.name,
      on: {
        click: () => input.setTool(input.tool === k ? null : k),
        pointerenter: (e) => { if (e.pointerType === 'mouse') this.showToolInfo(k); },
        pointerleave: () => this.showToolInfo(null),
      },
    },
    el('kbd', { class: 'tool-key', text: info.key }),
    el('span', { class: 'tool-art' }, iconNode(`tool:${k === 'demolish' ? 'demolish' : k}`, 34)),
    cost, count);
    this.tools.set(k, { btn, cost, count, info });
    return btn;
  }

  // A held button keeps its pointer, so a thumb sliding off it can't leave the kid sliding forever.
  holdButton(name, label, art) {
    const { input } = this.ui;
    const btn = hudBtn({
      class: `action action-${name}`,
      id: `hud-${name}`,
      'aria-label': label,
    }, el('span', { class: 'action-ico', trustedHtml: art }), el('span', { class: 'action-label', text: label }));
    btn.addEventListener('pointerdown', (e) => {
      try { btn.setPointerCapture(e.pointerId); } catch { /* already gone */ }
      input.press(name, true);
      btn.classList.add('down');
    });
    const up = () => { input.press(name, false); btn.classList.remove('down'); };
    btn.addEventListener('pointerup', up);
    btn.addEventListener('pointercancel', up);
    btn.addEventListener('lostpointercapture', up);
    return btn;
  }

  // ---- lifecycle ---------------------------------------------------------------------

  enter() {
    this.memo.clear();
    this.tips.reset();
    this.lastPhase = null;
    this.bannerQueue.length = 0;
    this.banner.hidden = true;
    this.deny.hidden = true;
    this.tip.hidden = true;
    this.previewKey = '';
    this.matesKey = '';
    this.flakesShown = null;
    this.colonelNodes.clear();
    this.colonels.replaceChildren();
    this.scores.setOpen(false);
    this.setTrayOpen(false);
    this.closeChat();
    this.chatLog.replaceChildren();
    this.root.hidden = false;
    this.setMode(this.ui.input.mode);
  }

  exit() {
    this.root.hidden = true;
    this.closeChat();
    this.scores.setOpen(false);
  }

  setMode(mode) {
    this.root.dataset.input = mode;
    this.readyKey.textContent = mode === 'pad' ? 'Y' : 'R';
    for (const t of this.tools.values()) {
      t.btn.querySelector('.tool-key').textContent = mode === 'pad' ? '' : t.info.key;
    }
  }

  setTrayOpen(on) {
    this.trayOpen = on;
    this.trayWrap.classList.toggle('open', on);
  }

  onToolChange(k) {
    for (const [tool, t] of this.tools) t.btn.classList.toggle('on', tool === k);
    this.showToolInfo(null);
    // In compact FIGHT the tray stays open while a tool is out, then tucks itself away again.
    if (k === null && this.trayOpen) this.setTrayOpen(false);
  }

  showToolInfo(hovered) {
    const k = hovered ?? this.ui.input.tool;
    if (k === null) { this.trayInfo.hidden = true; return; }
    const { info } = this.tools.get(k);
    this.trayInfoName.textContent = info.name;
    this.trayInfoBlurb.textContent = info.blurb ?? '';
    this.trayInfo.hidden = false;
  }

  // ---- per-frame update ----------------------------------------------------------------

  update(view) {
    const session = this.ui.session;
    if (!view?.meta || !session) return;
    const now = performance.now();
    const m = this.memo;
    const { me, you, meta } = view;
    const team = view.players?.get(session.me)?.team ?? me?.team ?? TEAM.A;

    this.updateWho(view, you, me);
    this.updatePhase(view, meta);
    this.updateBars(view, meta, team);

    const flakes = meta.flakes?.[team] ?? 0;
    if (this.flakesShown !== null && flakes > this.flakesShown) this.pulse(this.flakes, 'bump');
    this.flakesShown = flakes;
    m.text(this.flakesNum, String(flakes));
    m.show(this.flakes, view.mode !== MODE.CLASSIC);

    const frozen = hasFlag(me, AFLAG.FROZEN);
    m.show(this.frozenMsg, frozen);
    if (frozen) {
      const secs = you?.frozenT ?? 0;
      let msg = view.mode === MODE.SIEGE ? `You're frozen! Thawing in ${secs}` : `Back in ${secs}`;
      if (view.mode === MODE.CLASSIC) msg = 'Knocked out! Back next round';
      m.text(this.frozenMsg, msg);
    }
    m.show(this.hopIn, !me);

    const canBuild = view.phase === PHASE.BUILD || (view.phase === PHASE.FIGHT && view.mode !== MODE.CLASSIC);
    m.toggle(this.root, 'phase-build', view.phase === PHASE.BUILD);
    m.toggle(this.root, 'phase-fight', view.phase === PHASE.FIGHT);
    m.toggle(this.root, 'retro', view.mode === MODE.CLASSIC);
    if (view.phase !== this.lastPhase) {
      // On touch a tool hides the throw stick, and in compact FIGHT the tray too, so a tool still
      // out from BUILD would leave a phone player unable to throw. Put it away as the fight starts.
      if (view.phase === PHASE.FIGHT && this.ui.input.mode === 'touch') this.ui.input.setTool(null);
      this.lastPhase = view.phase;
    }
    m.show(this.trayWrap, canBuild && !!me);
    const ready = meta.ready;
    m.show(this.readyBtn, view.phase === PHASE.BUILD && !!me);
    if (ready) {
      m.text(this.readyCount, ready.need > 1 ? `${ready.have}/${ready.need}` : '');
      m.toggle(this.readyBtn, 'on', ready.ids?.includes(session.me) ?? false);
    }

    m.toggle(this.lobBtn, 'armed', this.ui.input.lobArmed);
    this.updateCooldownButton(view, you);

    const hiccup = session.connected === false && !session.reconnecting;
    m.show(this.hiccup, hiccup);
    const rotate = this.ui.input.mode === 'touch' && window.innerHeight > window.innerWidth;
    m.show(this.rotate, rotate && !this.rotateDismissed);

    if (now >= this.slowAt) {
      this.slowAt = now + SLOW_TICK_MS;
      this.updateSlow(view, session, team, now);
    }
    this.scores.update(view, now);
    this.tickTimers(now);
  }

  updateWho(view, you, me) {
    const m = this.memo;
    // A late joiner has no kid yet, so there is nothing true to show here.
    m.toggle(this.who, 'empty', !you);
    if (!you) return;
    const max = Math.max(1, you.maxWarmth);
    const frac = clamp01(you.warmth / max);
    m.style(this.warmthFill, 'transform', `scaleX(${frac.toFixed(3)})`);
    if (view.mode === MODE.CLASSIC) {
      const hearts = Math.round(frac * CLASSIC.hits);
      m.text(this.warmthNum, '♥'.repeat(hearts) + '♡'.repeat(CLASSIC.hits - hearts));
    } else {
      m.text(this.warmthNum, String(Math.ceil(you.warmth)));
    }
    m.toggle(this.warmth, 'low', frac < 0.3);

    if (this.pipNodes.length !== you.maxBalls) {
      this.pipNodes = Array.from({ length: you.maxBalls }, () => el('span', { class: 'pip' }));
      this.pips.replaceChildren(...this.pipNodes);
      m.changed('pipsFilled', -1);
    }
    if (m.changed('pipsFilled', you.balls)) {
      this.pipNodes.forEach((pip, i) => pip.classList.toggle('full', i < you.balls));
    }
    m.toggle(this.pips, 'pulsing', this.tips.pulsePips);
    m.toggle(this.pips, 'packing', hasFlag(me, AFLAG.PACKING));

    const has = you.special !== NO_SPECIAL && you.special !== undefined && you.special !== null;
    m.show(this.specialBox, has);
    m.toggle(this.whoRow, 'bare', !has);
    if (has && m.changed('specialId', you.special)) {
      let node = this.specialIcons.get(you.special);
      if (!node) {
        node = iconNode(`special:${you.special}`, 30);
        this.specialIcons.set(you.special, node);
      }
      this.specialBox.replaceChildren(node, this.specialCount);
      this.specialBox.title = SPECIAL[you.special]?.name ?? '';
    }
    if (has) m.text(this.specialCount, you.special === PICKUP.BOARD ? `${Math.ceil(you.boardT ?? 0)}s` : `x${you.specialN}`);
  }

  updateCooldownButton(view, you) {
    const m = this.memo;
    if (!you) return;
    const total = KID.slideCooldown * (you.mods?.slideCdMul ?? 1);
    const left = clamp01((you.slideCd ?? 0) / total);
    const p = `${Math.round((1 - left) * 100)}%`;
    m.style(this.slideRing, '--p', p);
    m.toggle(this.slideRing, 'ready', left <= 0);
    m.style(this.slideBtn, '--p', p);
    m.toggle(this.slideBtn, 'cooling', left > 0);
  }

  updatePhase(view, meta) {
    const m = this.memo;
    const { phase, mode } = view;
    let label;
    if (phase === PHASE.BUILD) label = mode === MODE.FFA ? 'Scatter!' : 'Build';
    else if (phase === PHASE.ROUND_END) label = 'Round over';
    else if (phase === PHASE.OVER) label = 'Match over';
    else if (meta.suddenDeath) label = 'Meltdown!';
    else label = 'Fight';
    m.text(this.phaseLabel, label);

    const secs = view.secondsLeft;
    const hasClock = secs !== null && secs !== undefined;
    const foes = meta.foesLeft ?? 0;
    m.text(this.phaseTime, hasClock ? fmtClock(secs) : `${foes} ${foes === 1 ? 'foe' : 'foes'}`);
    m.toggle(this.phaseBtn, 'hurry', hasClock && secs <= 10 && phase !== PHASE.ROUND_END);
    m.toggle(this.phaseBtn, 'fight', phase === PHASE.FIGHT);

    let line = '';
    if (mode === MODE.SIEGE) {
      const of = view.waveCount ? ` of ${view.waveCount}` : '';
      line = `Wave ${view.wave}${of}: ${view.waveName ?? ''}`;
    } else if (mode === MODE.FORTWARS || mode === MODE.CLASSIC) {
      const a = meta.roundWins?.[TEAM.A] ?? 0;
      const b = meta.roundWins?.[TEAM.B] ?? 0;
      line = `Round ${meta.round ?? 1} · ${a} to ${b}`;
    } else {
      const lead = view.players?.get(meta.leaderId)?.name;
      line = lead ? `${lead} leads · first to ${FFA.freezesToWin}` : `First to ${FFA.freezesToWin} freezes`;
    }
    m.text(this.waveName, line);
  }

  updateBars(view, meta, team) {
    const m = this.memo;
    const list = meta.colonels ?? [];
    m.toggle(this.center, 'duel', list.length > 1);
    for (const c of list) {
      let node = this.colonelNodes.get(c.team);
      if (!node) {
        const fill = el('span', { class: 'colonel-fill' });
        const num = el('span', { class: 'colonel-num' });
        const label = list.length > 1 ? TEAM_NAME[c.team] : 'Colonel Carrot';
        const root = el('div', { class: 'colonel-bar', style: { '--team': TEAM_STYLE[c.team]?.color ?? '#d6404e' } },
          el('span', { class: 'colonel-label', text: label }),
          el('span', { class: 'colonel-track' }, fill), num);
        this.colonels.append(root);
        node = { root, fill, num, last: c.hp };
        this.colonelNodes.set(c.team, node);
      }
      const frac = clamp01(c.hp / Math.max(1, c.mhp));
      m.style(node.fill, 'transform', `scaleX(${frac.toFixed(3)})`);
      m.text(node.num, String(Math.ceil(c.hp)));
      if (c.hp < node.last) this.pulse(node.root, 'hit');
      node.last = c.hp;
      m.toggle(node.root, 'mine', c.team === team);
      m.toggle(node.root, 'low', frac < 0.25);
    }

    const { boss } = meta;
    m.show(this.boss, !!boss);
    m.toggle(this.center, 'has-boss', !!boss);
    if (boss) {
      m.text(this.bossName, boss.name);
      m.style(this.bossFill, 'transform', `scaleX(${clamp01(boss.hp / Math.max(1, boss.mhp)).toFixed(3)})`);
    }
  }

  updateSlow(view, session, team, now) {
    const m = this.memo;
    const { meta, you } = view;

    const next = view.phase === PHASE.BUILD ? meta.next : null;
    const key = next ? JSON.stringify(next.foes) : '';
    if (key !== this.previewKey) {
      this.previewKey = key;
      this.previewRow.replaceChildren(...(next?.foes ?? []).map(({ k, n }) => el('span', {
        class: 'preview-foe', title: FOES[k]?.name ?? '',
      }, iconNode(`foe:${k}`, 30), el('span', { class: 'preview-n', text: String(n) }))));
    }
    m.show(this.preview, !!next?.foes?.length);

    const flakes = meta.flakes?.[team] ?? 0;
    let pults = 0;
    for (const s of view.structs ?? []) if (s.kind === STRUCT.PULT && s.team === team) pults += 1;
    const classic = view.mode === MODE.CLASSIC;
    for (const [k, t] of this.tools) {
      // Classic offers three tools, free, and counts what each kid has placed instead.
      m.show(t.btn, !classic || k === 'demolish' || CLASSIC.tools.includes(k));
      if (k === 'demolish') continue;
      m.text(t.cost, classic ? 'free' : String(t.info.cost));
      m.toggle(t.btn, 'poor', !classic && flakes < t.info.cost);
      if (k === STRUCT.PULT) {
        const limit = classic ? undefined : meta.pultLimit?.[team];
        m.show(t.count, limit !== undefined);
        if (limit !== undefined) m.text(t.count, `${pults}/${limit}`);
      }
    }
    const share = you?.spendLeft;
    const fair = !classic && share !== undefined && share !== UNLIMITED_SHARE;
    if (classic) {
      let mine = 0;
      for (const s of view.structs ?? []) if (s.ownerId === session.me) mine += 1;
      const left = Math.max(0, CLASSIC.itemsPerKid - mine);
      m.show(this.share, view.phase === PHASE.BUILD);
      m.text(this.share, left === 1 ? '1 thing left to place' : `${left} things left to place`);
    } else {
      m.show(this.share, fair);
      if (fair) m.text(this.share, `Your share: ${share}`);
    }

    const solo = this.ui.roomInfo.solo;
    const ping = Math.round(session.ping ?? 0);
    m.show(this.ping, !solo && ping > 0);
    if (!solo) {
      m.text(this.ping, `${ping} ms`);
      m.toggle(this.ping, 'slow', ping > 200);
    }

    this.updateMates(view, session, team);
    this.cards.update(session, view);
    // However long the teammate list is, the cards start below it.
    m.style(this.cards.root, '--below-mates', `${this.rightCol.offsetHeight + 18}px`);
    this.reportHudSpace();
    this.tips.update(view, session, this.ui.input.mode, now);
  }

  // Edge arrows are drawn on the canvas under this DOM, so the renderer keeps them out of here.
  reportHudSpace() {
    const top = this.center.getBoundingClientRect().bottom;
    const tray = this.trayWrap.getBoundingClientRect();
    const bottom = tray.height > 0 ? window.innerHeight - tray.top : 0;
    this.ui.renderer.setEdgeInsets?.(top + ARROW_CLEARANCE, bottom + ARROW_CLEARANCE);
  }

  updateMates(view, session, team) {
    const m = this.memo;
    const players = view.players;
    if (!players) return;
    const mates = view.mode === MODE.FFA ? [] : [...players.values()].filter((p) => p.team === team && p.id !== session.me);
    const key = mates.map((p) => `${p.id}:${p.name}`).join('|');
    if (key !== this.matesKey) {
      this.matesKey = key;
      this.mateNodes.clear();
      this.mates.replaceChildren(...mates.map((p) => {
        const fill = el('span', { class: 'mate-fill' });
        const root = el('div', { class: 'mate', title: p.name },
          el('span', { class: 'mate-dot' }),
          el('span', { class: 'mate-name', text: p.name }),
          el('span', { class: 'mate-track' }, fill));
        this.mateNodes.set(p.id, { root, fill });
        return root;
      }));
    }
    if (!this.mateNodes.size) return;
    const byId = new Map();
    for (const a of view.actors ?? []) if (a.kind === ACTOR.KID) byId.set(a.id, a);
    for (const [id, node] of this.mateNodes) {
      const actor = byId.get(id);
      const player = players.get(id);
      m.toggle(node.root, 'frozen', hasFlag(actor, AFLAG.FROZEN));
      m.toggle(node.root, 'away', !!player && !player.isBot && !player.connected);
      m.style(node.fill, 'transform', `scaleX(${clamp01(actor?.hp ?? 0).toFixed(2)})`);
    }
  }

  tickTimers(now) {
    if (!this.banner.hidden && now >= this.bannerUntil) {
      this.banner.hidden = true;
      this.nextBanner(now);
    }
    if (!this.deny.hidden && now >= this.denyUntil) this.deny.hidden = true;
    if (!this.tip.hidden && now >= this.tipUntil) this.tip.hidden = true;
    for (const line of this.chatLog.children) {
      if (now >= Number(line.dataset.until)) line.classList.add('faded');
    }
  }

  pulse(node, cls) {
    node.classList.remove(cls);
    void node.offsetWidth;
    node.classList.add(cls);
  }

  // ---- things that arrive as events ---------------------------------------------------

  onFx(ev) {
    if (ev.e === EV.BANNER) this.pushBanner(ev);
    else if (ev.e === EV.DENY) this.showDeny(ev.why);
    else if (ev.e === EV.HIT && ev.id === this.ui.session?.me) this.pulse(this.warmth, 'hurt');
  }

  pushBanner({ text, sub, kind }) {
    const item = { text: String(text ?? ''), sub: String(sub ?? ''), kind: kind ?? 'info' };
    const urgent = item.kind === 'win' || item.kind === 'lose' || item.kind === 'boss';
    const now = performance.now();
    if (urgent) { this.bannerQueue.length = 0; this.playBanner(item, now); return; }
    if (this.banner.hidden) { this.playBanner(item, now); return; }
    if (this.bannerQueue.length < 3) this.bannerQueue.push(item);
  }

  nextBanner(now) {
    const item = this.bannerQueue.shift();
    if (item) this.playBanner(item, now);
  }

  playBanner(item, now) {
    this.bannerText.textContent = item.text;
    this.bannerSub.textContent = item.sub;
    this.bannerSub.hidden = !item.sub;
    this.banner.className = `banner banner-${item.kind}`;
    this.banner.hidden = false;
    void this.banner.offsetWidth;
    this.banner.classList.add('in');
    this.bannerUntil = now + BANNER_MS;
  }

  showDeny(why) {
    const text = DENY_COPY[why];
    if (!text) return;
    this.deny.textContent = text;
    this.deny.hidden = false;
    this.pulse(this.deny, 'shake');
    this.denyUntil = performance.now() + DENY_MS;
    this.ui.audio.ui('deny');
  }

  showTip(id, text, ms) {
    this.tip.textContent = text;
    this.tip.dataset.tip = id;
    this.tip.hidden = false;
    this.pulse(this.tip, 'in');
    this.tipUntil = performance.now() + ms;
  }

  showNotice(text, ms = 3200) {
    this.notice.textContent = text;
    this.notice.hidden = false;
    clearTimeout(this.noticeTimer);
    this.noticeTimer = setTimeout(() => { this.notice.hidden = true; }, ms);
  }

  setShoutMenu(open) {
    this.shout.hidden = !open;
    if (open) this.setShoutSelection(0);
  }

  setShoutSelection(i) {
    this.shoutItems.forEach((item, n) => item.classList.toggle('sel', n === i));
  }

  // ---- in-match chat -----------------------------------------------------------------

  addChatLine(line) {
    const node = el('p', { class: 'match-chat-line', dataset: { until: String(performance.now() + CHAT_LINE_MS) } },
      el('span', { class: 'chat-name', text: line.name }),
      el('span', { class: 'chat-text', text: line.text }));
    this.chatLog.append(node);
    while (this.chatLog.childElementCount > 6) this.chatLog.firstElementChild.remove();
    this.chatBox.hidden = false;
  }

  openChat() {
    const { input } = this.ui;
    input.clearHeld();
    this.chatOpen = true;
    this.chatBox.hidden = false;
    this.chatBox.classList.add('open');
    this.ui.refreshInput();
    this.chatInput.value = '';
    this.chatInput.focus();
  }

  closeChat() {
    if (!this.chatOpen) return;
    this.chatOpen = false;
    this.chatBox.classList.remove('open');
    this.chatInput.blur();
    this.chatInput.value = '';
    this.ui.refreshInput();
  }

  onChatKey(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      this.closeChat();
    } else if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      const text = this.chatInput.value.trim();
      if (text) this.ui.session?.chat(text);
      this.closeChat();
    }
  }
}
