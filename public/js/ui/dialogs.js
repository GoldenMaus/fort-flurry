// Everything that sits on top of a screen. The stack owns focus: while any dialog is open the
// layers behind it are inert, Tab cycles inside the top dialog, and closing hands focus back.
import { MODE, MODE_NAME } from '../../shared/schema.js';
import { el } from './dom.js';
import { ICON } from './art.js';
import { CONTROLS, ERROR_ACTION, ERROR_COPY, MODE_BLURB, PREMISE, ROUND_STEPS } from './copy.js';
import { menuButton } from './title.js';

const FOCUSABLE = 'button:not([disabled]):not([hidden]),input:not([disabled]),select,textarea,a[href],[tabindex]:not([tabindex="-1"])';

function visibleFocusable(panel) {
  return [...panel.querySelectorAll(FOCUSABLE)].filter((node) => node.offsetParent !== null);
}

export class Dialogs {
  constructor(root, ui) {
    this.root = root;
    this.ui = ui;
    this.stack = [];
    window.addEventListener('keydown', (e) => this.onKey(e), true);
  }

  get any() { return this.stack.length > 0; }
  get top() { return this.stack[this.stack.length - 1] ?? null; }
  has(id) { return this.stack.some((d) => d.id === id); }

  // spec: {id, title, body:[nodes], actions:[nodes], onEsc, wide, band, focus}
  open(spec) {
    const { id, title, body = [], actions = [], onEsc = null, wide = false, tone = '', focus = null } = spec;
    const heading = title ? el('h2', { class: 'dialog-title', id: `dlg-${id}-title`, text: title }) : null;
    const panel = el('div', {
      class: `dialog panel${wide ? ' dialog-wide' : ''}${tone ? ` dialog-${tone}` : ''}`,
      role: 'dialog',
      'aria-modal': 'true',
      'aria-labelledby': title ? `dlg-${id}-title` : null,
      'aria-label': title ? null : id,
      tabindex: '-1',
      dataset: { dialog: id },
    }, el('div', { class: 'dialog-band', 'aria-hidden': 'true' }), heading,
    el('div', { class: 'dialog-body' }, body),
    actions.length ? el('div', { class: 'dialog-actions' }, actions) : null);
    const scrim = el('div', { class: 'scrim' }, panel);
    const entry = { id, panel, scrim, onEsc, returnTo: document.activeElement };
    entry.close = () => this.close(entry);

    this.root.append(scrim);
    this.stack.push(entry);
    this.syncInert();
    // A touch player gets no focus ring on a button they never reached with a keyboard.
    const touch = this.ui.input.mode === 'touch';
    const first = focus?.() ?? (touch ? panel : visibleFocusable(panel)[0] ?? panel);
    first.focus({ preventScroll: true });
    this.ui.refreshInput();
    return entry;
  }

  close(entry) {
    const at = this.stack.indexOf(entry);
    if (at < 0) return;
    this.stack.splice(at, 1);
    entry.scrim.remove();
    this.syncInert();
    const back = entry.returnTo;
    if (back?.isConnected && back !== document.body) back.focus({ preventScroll: true });
    this.ui.refreshInput();
    entry.onClose?.();
  }

  closeAll() {
    for (const entry of [...this.stack].reverse()) {
      entry.returnTo = null;
      this.close(entry);
    }
  }

  syncInert() {
    const blocked = this.any;
    this.ui.screensRoot.inert = blocked;
    this.ui.hudRoot.inert = blocked;
    this.stack.forEach((d, i) => { d.scrim.inert = i !== this.stack.length - 1; });
  }

  onKey(e) {
    const top = this.top;
    if (!top) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (!e.repeat) top.onEsc?.();
      return;
    }
    if (e.key !== 'Tab') return;
    const items = visibleFocusable(top.panel);
    if (!items.length) { e.preventDefault(); top.panel.focus(); return; }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    const outside = !top.panel.contains(active);
    if (e.shiftKey && (active === first || active === top.panel || outside)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (active === last || outside)) {
      e.preventDefault();
      first.focus();
    }
  }

  // Gamepad walking through the top dialog, so Start isn't a one-way door.
  nav(dir) {
    const top = this.top;
    if (!top) return;
    if (dir === 'back') { top.onEsc?.(); return; }
    const items = visibleFocusable(top.panel);
    if (!items.length) return;
    const at = items.indexOf(document.activeElement);
    if (dir === 'ok') { (items[at] ?? items[0]).click(); return; }
    const step = dir === 'up' || dir === 'left' ? -1 : 1;
    items[(at + step + items.length) % items.length].focus();
  }
}

// ---- error dialog ------------------------------------------------------------------

export function errorDialog(ui, code, room, handlers = {}) {
  const text = (ERROR_COPY[code] ?? ERROR_COPY.net)(room || '????');
  const label = ERROR_ACTION[code];
  const primary = handlers.primary ?? (() => {});
  const actions = [];
  let entry;
  const done = (fn) => () => { entry.close(); fn?.(); };
  if (label) actions.push(menuButton(label, { tone: 'red', id: 'btn-error-primary', on: done(primary) }));
  actions.push(menuButton(label ? 'Back' : 'OK', { tone: label ? 'ghost' : 'red', id: 'btn-error-ok', on: done(handlers.dismiss) }));
  entry = ui.dialogs.open({
    id: 'error',
    tone: 'error',
    title: 'Oh, snow!',
    body: [el('p', { class: 'dialog-text', id: 'error-text', text })],
    actions,
    onEsc: done(handlers.dismiss),
  });
  return entry;
}

// ---- leave confirm ------------------------------------------------------------------

export function leaveDialog(ui) {
  if (ui.dialogs.has('leave')) return null;
  const stay = menuButton('Stay', { tone: 'blue', id: 'btn-stay', on: () => entry.close() });
  const leave = menuButton('Leave', { tone: 'red', id: 'btn-leave', on: () => { entry.close(); ui.emit('leave'); } });
  const body = ui.roomInfo.p2pHost ? [el('p', { class: 'dialog-text', text: 'This ends the game for everyone.' })] : [];
  const entry = ui.dialogs.open({ id: 'leave', title: 'Leave the game?', body, actions: [stay, leave], onEsc: () => entry.close() });
  return entry;
}

// ---- reconnecting --------------------------------------------------------------------

export function reconnectDialog(ui) {
  const leave = menuButton('Leave', { tone: 'ghost', id: 'btn-reconnect-leave', on: () => ui.emit('leave') });
  return ui.dialogs.open({
    id: 'reconnect',
    tone: 'nap',
    body: [
      el('div', { class: 'nap-art', 'aria-hidden': 'true' },
        el('span', { class: 'nap-z', text: 'z' }), el('span', { class: 'nap-z', text: 'z' }), el('span', { class: 'nap-z', text: 'z' })),
      el('p', { class: 'dialog-text', id: 'reconnect-text', text: 'Reconnecting... your kid is taking a snow nap.' }),
    ],
    actions: [leave],
  });
}

// ---- menu ------------------------------------------------------------------------------

export function menuDialog(ui) {
  const close = () => ui.closeMenu();
  const items = [
    menuButton('Resume', { tone: 'red', iconName: 'snowball', id: 'btn-resume', on: close }),
    menuButton('Settings', { tone: 'blue', iconName: 'gear', id: 'btn-menu-settings', on: () => ui.openSettings() }),
    menuButton('How to Play', { tone: 'blue', iconName: 'book', id: 'btn-menu-howto', on: () => ui.openHowTo() }),
  ];
  const muteBtn = menuButton(ui.prefs.muted ? 'Sound on' : 'Sound off', {
    tone: 'ghost',
    iconName: ui.prefs.muted ? 'sound' : 'mute',
    id: 'btn-menu-mute',
    on: () => {
      ui.toggleMute();
      muteBtn.querySelector('.btn-label').textContent = ui.prefs.muted ? 'Sound on' : 'Sound off';
      muteBtn.querySelector('.btn-ico').innerHTML = ICON[ui.prefs.muted ? 'sound' : 'mute'];
    },
  });
  items.push(muteBtn);
  if (document.fullscreenEnabled) {
    items.push(menuButton(document.fullscreenElement ? 'Exit Fullscreen' : 'Fullscreen', {
      tone: 'ghost', id: 'btn-fullscreen', on: () => { ui.emit('fullscreen'); close(); },
    }));
  }
  items.push(menuButton('Leave', { tone: 'ghost', iconName: 'back', id: 'btn-menu-leave', on: () => ui.confirmLeave() }));
  const note = ui.roomInfo.solo ? 'The game is paused.' : "The game keeps going while you're here.";
  return ui.dialogs.open({
    id: 'menu',
    title: 'Menu',
    body: [el('p', { class: 'dialog-note', id: 'menu-note', text: note }), el('div', { class: 'menu-list' }, items)],
    onEsc: close,
  });
}

// ---- settings ----------------------------------------------------------------------------

function slider(label, value, onChange) {
  const input = el('input', {
    class: 'range', type: 'range', min: '0', max: '1', step: '0.05', 'aria-label': label,
  });
  input.value = String(value);
  const paint = () => input.style.setProperty('--fill', `${Number(input.value) * 100}%`);
  paint();
  input.addEventListener('input', () => { paint(); onChange(Number(input.value)); });
  return el('label', { class: 'set-row' }, el('span', { class: 'set-label', text: label }), input);
}

function toggle(label, on, onChange, id) {
  const btn = el('button', {
    type: 'button',
    class: `switch${on ? ' on' : ''}`,
    role: 'switch',
    id,
    'aria-checked': String(on),
    'aria-label': label,
    on: {
      click: () => {
        const next = btn.getAttribute('aria-checked') !== 'true';
        btn.setAttribute('aria-checked', String(next));
        btn.classList.toggle('on', next);
        onChange(next);
      },
    },
  }, el('span', { class: 'switch-ball' }));
  return el('div', { class: 'set-row' }, el('span', { class: 'set-label', text: label }), btn);
}

export function settingsDialog(ui) {
  if (ui.dialogs.has('settings')) return null;
  const { prefs } = ui;
  const setVolume = (key) => (v) => { prefs.volumes = { [key]: v }; ui.applyAudio(); };
  const quality = el('div', { class: 'seg', role: 'radiogroup', 'aria-label': 'Graphics' });
  for (const [value, text] of [['auto', 'Auto'], ['high', 'High'], ['low', 'Low']]) {
    quality.append(el('button', {
      type: 'button',
      class: `seg-btn${prefs.quality === value ? ' on' : ''}`,
      role: 'radio',
      'aria-checked': String(prefs.quality === value),
      text,
      on: {
        click: (e) => {
          prefs.quality = value;
          ui.renderer.setQuality(value);
          for (const b of quality.children) {
            const on = b === e.currentTarget;
            b.classList.toggle('on', on);
            b.setAttribute('aria-checked', String(on));
          }
        },
      },
    }));
  }
  const done = menuButton('Done', { tone: 'red', id: 'btn-settings-done', on: () => entry.close() });
  const entry = ui.dialogs.open({
    id: 'settings',
    title: 'Settings',
    body: [
      el('div', { class: 'set-list' },
        slider('Master volume', prefs.volumes.master, setVolume('master')),
        slider('Music', prefs.volumes.music, setVolume('music')),
        slider('Sound effects', prefs.volumes.sfx, setVolume('sfx')),
        toggle('Mute everything', prefs.muted, (on) => { prefs.muted = on; ui.applyAudio(); }, 'set-mute'),
        el('div', { class: 'set-row' }, el('span', { class: 'set-label', text: 'Graphics' }), quality),
        toggle('Reduce motion', prefs.reduceMotion, (on) => ui.setReduceMotion(on), 'set-motion')),
    ],
    actions: [done],
    onEsc: () => entry.close(),
  });
  return entry;
}

// ---- how to play ---------------------------------------------------------------------------

function storyPage() {
  return el('div', { class: 'howto-page' },
    PREMISE.map((text) => el('p', { class: 'howto-lead', text })),
    el('ol', { class: 'howto-steps' }, ROUND_STEPS.map((step, i) => el('li', { class: 'howto-step' },
      el('span', { class: 'howto-num', text: String(i + 1) }),
      el('span', null, el('strong', { text: step.title }), el('span', { text: step.text }))))),
    el('p', { class: 'howto-note', text: 'Kids never get hurt out here. Foes give up, frozen friends thaw, and everyone gets cocoa afterwards.' }));
}

function controlsPage(mode) {
  const column = { kbm: 1, pad: 2, touch: 3 };
  const list = el('dl', { class: 'howto-keys' });
  const render = (device) => {
    list.replaceChildren(...CONTROLS.flatMap((row) => [
      el('dt', { text: row[0] }), el('dd', { text: row[column[device]] }),
    ]));
    for (const b of seg.children) {
      const on = b.dataset.device === device;
      b.classList.toggle('on', on);
      b.setAttribute('aria-checked', String(on));
    }
  };
  const seg = el('div', { class: 'seg', role: 'radiogroup', 'aria-label': 'Device' },
    [['kbm', 'Keyboard'], ['pad', 'Gamepad'], ['touch', 'Touch']].map(([device, text]) => el('button', {
      type: 'button', class: 'seg-btn', role: 'radio', 'aria-checked': 'false', text, dataset: { device }, on: { click: () => render(device) },
    })));
  render(mode);
  const iphone = /iPhone|iPod/.test(navigator.userAgent);
  return el('div', { class: 'howto-page' }, seg, list,
    iphone ? el('p', { class: 'howto-note', id: 'iphone-note', text: 'On iPhone, Add to Home Screen gives full screen.' }) : null);
}

function modesPage() {
  return el('div', { class: 'howto-page' }, Object.values(MODE).map((mode) => el('div', { class: 'howto-mode' },
    el('h3', { text: MODE_NAME[mode] }), el('p', { text: MODE_BLURB[mode] }))));
}

export function howToDialog(ui) {
  if (ui.dialogs.has('howto')) return null;
  const pages = [['Story', () => storyPage()], ['Controls', () => controlsPage(ui.input.mode)], ['Modes', () => modesPage()]];
  const host = el('div', { class: 'howto-host' });
  const tabs = el('div', { class: 'seg howto-tabs', role: 'tablist' });
  const show = (i) => {
    host.replaceChildren(pages[i][1]());
    host.scrollTop = 0;
    [...tabs.children].forEach((b, n) => {
      b.classList.toggle('on', n === i);
      b.setAttribute('aria-selected', String(n === i));
    });
  };
  pages.forEach(([label], i) => tabs.append(el('button', {
    type: 'button', class: 'seg-btn', role: 'tab', 'aria-selected': 'false', text: label, on: { click: () => show(i) },
  })));
  show(0);
  const done = menuButton('Got it', { tone: 'red', id: 'btn-howto-done', on: () => entry.close() });
  const entry = ui.dialogs.open({
    id: 'howto',
    title: 'How to Play',
    wide: true,
    body: [tabs, host],
    actions: [done],
    onEsc: () => entry.close(),
  });
  return entry;
}
