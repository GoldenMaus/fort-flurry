// The front door: title, invite card, join with code, and the connecting screen.
import { ROOM_CODE_LEN, NAME_MAX } from '../../shared/constants.js';
import { isValidCode } from '../../shared/protocol.js';
import { el } from './dom.js';
import { ICON, logoSvg } from './art.js';
import { TAGLINE } from './copy.js';
import { randomName } from './store.js';

const icon = (name) => el('span', { class: 'btn-ico', trustedHtml: ICON[name] });

export function menuButton(label, opts = {}) {
  const { tone = 'wool', size = '', iconName, id, on } = opts;
  return el('button', {
    type: 'button',
    id,
    class: `btn btn-${tone} ${size}`.trim(),
    on: on ? { click: on } : undefined,
  }, iconName ? icon(iconName) : null, el('span', { class: 'btn-label', text: label }));
}

function nameField(ui, id) {
  const input = el('input', {
    id,
    class: 'name-input',
    type: 'text',
    maxlength: String(NAME_MAX),
    autocomplete: 'off',
    autocorrect: 'off',
    spellcheck: 'false',
    enterkeyhint: 'done',
    'aria-label': 'Your name',
    placeholder: 'Your name',
  });
  input.value = ui.prefs.name;
  input.addEventListener('input', () => { ui.prefs.name = input.value; });
  // An emptied field falls back to a fresh random name rather than an empty one (SPEC 11.2).
  input.addEventListener('blur', () => {
    if (!input.value.trim()) { input.value = randomName(); ui.prefs.name = input.value; }
  });
  const dice = el('button', {
    type: 'button',
    class: 'name-dice',
    'aria-label': 'Pick a random name',
    title: 'Pick a random name',
    trustedHtml: ICON.dice,
    on: {
      click: () => {
        input.value = randomName();
        ui.prefs.name = input.value;
        dice.classList.remove('rolled');
        void dice.offsetWidth;
        dice.classList.add('rolled');
      },
    },
  });
  const tag = el('div', { class: 'nametag' },
    el('label', { class: 'nametag-head', for: id, text: 'Hello, my name is' }),
    el('span', { class: 'nametag-row' }, input, dice));
  return { tag, input };
}

// Throw a snowball at wherever the player clicks. Hitting the Colonel gets a reaction.
class SceneToy {
  constructor(ui, scene) {
    this.ui = ui;
    this.scene = scene;
    this.svg = scene.querySelector('.scene-svg');
    this.fx = scene.querySelector('#scene-fx');
    this.face = scene.querySelector('#colonel-face');
    this.colonel = scene.querySelector('.colonel-sway');
    this.bubble = el('div', { class: 'scene-bubble', text: 'Harrumph!', hidden: true });
    scene.append(this.bubble);
    this.live = 0;
    scene.addEventListener('pointerdown', (e) => this.onPress(e));
    window.addEventListener('pointermove', (e) => this.onLook(e));
  }

  toScene(clientX, clientY) {
    const m = this.svg.getScreenCTM();
    if (!m) return null;
    const p = new DOMPoint(clientX, clientY).matrixTransform(m.inverse());
    return { x: p.x, y: p.y };
  }

  // The Colonel's eyes are on you. Purely decorative, so it stops whenever the scene is covered.
  onLook(e) {
    if (this.ui.screensRoot.dataset.backdrop !== 'scene' || this.ui.prefs.reduceMotion) return;
    const p = this.toScene(e.clientX, e.clientY);
    if (!p) return;
    const dx = p.x - 1060;
    const dy = p.y - 372;
    const len = Math.hypot(dx, dy) || 1;
    const reach = Math.min(1, len / 240);
    this.face.setAttribute('transform', `translate(${((dx / len) * 7 * reach).toFixed(1)} ${((dy / len) * 5 * reach).toFixed(1)})`);
  }

  onPress(e) {
    if (e.button !== 0 || this.live >= 6) return;
    const target = this.toScene(e.clientX, e.clientY);
    if (!target) return;
    this.ui.audio.ui('click');
    this.throwAt(target);
  }

  throwAt(target) {
    const from = { x: 753, y: 695 };
    const NS = 'http://www.w3.org/2000/svg';
    const ball = document.createElementNS(NS, 'circle');
    ball.setAttribute('r', '15');
    ball.setAttribute('fill', '#fff');
    this.fx.append(ball);
    this.live += 1;
    const dist = Math.hypot(target.x - from.x, target.y - from.y);
    const lift = 60 + dist * 0.32;
    const frames = [];
    for (let i = 0; i <= 14; i += 1) {
      const t = i / 14;
      const x = from.x + (target.x - from.x) * t;
      const y = from.y + (target.y - from.y) * t - Math.sin(t * Math.PI) * lift;
      const s = 1 - t * 0.35;
      frames.push({ transform: `translate(${x}px, ${y}px) scale(${s})` });
    }
    const fly = ball.animate(frames, { duration: 300 + dist * 0.5, easing: 'linear', fill: 'forwards' });
    fly.onfinish = () => {
      ball.remove();
      this.live -= 1;
      this.splat(target);
      if (Math.abs(target.x - 1060) < 96 && target.y > 270 && target.y < 640) this.harrumph();
    };
  }

  splat({ x, y }) {
    const NS = 'http://www.w3.org/2000/svg';
    for (let i = 0; i < 9; i += 1) {
      const dot = document.createElementNS(NS, 'circle');
      dot.setAttribute('r', String(4 + (i % 3) * 3));
      dot.setAttribute('fill', i % 2 ? '#fff' : '#e4eafa');
      this.fx.append(dot);
      const a = (i / 9) * Math.PI * 2 + (i % 2) * 0.4;
      const reach = 34 + (i % 4) * 16;
      const run = dot.animate([
        { transform: `translate(${x}px, ${y}px) scale(1)`, opacity: 1 },
        { transform: `translate(${x + Math.cos(a) * reach}px, ${y + Math.sin(a) * reach * 0.8 + 18}px) scale(.3)`, opacity: 0 },
      ], { duration: 460, easing: 'cubic-bezier(.2,.7,.3,1)', fill: 'forwards' });
      run.onfinish = () => dot.remove();
    }
  }

  harrumph() {
    this.colonel.classList.remove('bonked');
    void this.colonel.getBoundingClientRect();
    this.colonel.classList.add('bonked');
    const r = this.scene.querySelector('#colonel').getBoundingClientRect();
    const host = this.scene.getBoundingClientRect();
    // Client rects include the 4K interface scale, and left and top are measured inside it.
    const k = this.scene.offsetWidth / host.width;
    this.bubble.style.left = `${(r.left - host.left + r.width * 0.72) * k}px`;
    this.bubble.style.top = `${(r.top - host.top + r.height * 0.02) * k}px`;
    this.bubble.hidden = false;
    this.bubble.classList.remove('pop');
    void this.bubble.offsetWidth;
    this.bubble.classList.add('pop');
    clearTimeout(this.bubbleTimer);
    this.bubbleTimer = setTimeout(() => { this.bubble.hidden = true; }, 1500);
  }
}

export function attachSceneToy(ui, scene) { return new SceneToy(ui, scene); }

export class TitleScreen {
  constructor(ui) {
    this.ui = ui;
    const { tag, input } = nameField(ui, 'name-input');
    this.nameInput = input;
    this.hostBtn = menuButton('Host with Friends', { tone: 'blue', iconName: 'friends', id: 'btn-host', on: () => ui.emit('host') });
    this.joinBtn = menuButton('Join with Code', { tone: 'mustard', iconName: 'key', id: 'btn-join', on: () => ui.show('join') });
    this.netHint = el('p', { class: 'net-hint', text: 'Checking the mailbox...' });
    this.setNetReady(false);

    this.root = el('section', { class: 'screen screen-title', dataset: { screen: 'title' } },
      el('div', { class: 'title-col' },
        el('h1', { class: 'logo', trustedHtml: logoSvg('title') }),
        el('p', { class: 'tagline', text: TAGLINE }),
        el('div', { class: 'title-card' },
          tag,
          menuButton('Play Solo', { tone: 'red', size: 'btn-xl', iconName: 'snowball', id: 'btn-solo', on: () => ui.emit('solo') }),
          el('div', { class: 'title-pair' }, this.hostBtn, this.joinBtn),
          this.netHint,
          el('div', { class: 'title-minor' },
            menuButton('How to Play', { tone: 'ghost', iconName: 'book', id: 'btn-howto', on: () => ui.openHowTo() }),
            menuButton('Settings', { tone: 'ghost', iconName: 'gear', id: 'btn-settings', on: () => ui.openSettings() })))));
  }

  // Host and Join need to know which network exists. The Title itself never waits for that (SPEC 8.2).
  setNetReady(ready) {
    this.hostBtn.disabled = !ready;
    this.joinBtn.disabled = !ready;
    if (this.netHint) this.netHint.hidden = ready;
  }

  enter() { this.nameInput.value = this.ui.prefs.name; }
}

export class InviteScreen {
  constructor(ui) {
    this.ui = ui;
    this.code = '';
    const { tag, input } = nameField(ui, 'invite-name');
    this.nameInput = input;
    this.heading = el('h2', { class: 'card-title' });
    this.joinBtn = menuButton('Join', { tone: 'red', size: 'btn-xl', id: 'btn-invite-join', on: () => this.submit() });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) this.submit(); });
    this.root = el('section', { class: 'screen screen-card', dataset: { screen: 'invite' } },
      el('div', { class: 'card-col' },
        el('div', { class: 'logo logo-small', trustedHtml: logoSvg('invite') }),
        el('div', { class: 'panel card-panel' },
          this.heading,
          el('p', { class: 'card-sub', text: 'A friend saved you a spot at the fort.' }),
          tag,
          this.joinBtn)));
  }

  enter({ code }) {
    this.code = code;
    this.heading.textContent = `Join room ${code}`;
    this.nameInput.value = this.ui.prefs.name;
  }

  submit() {
    if (!this.nameInput.value.trim()) { this.nameInput.value = randomName(); }
    this.ui.prefs.name = this.nameInput.value;
    this.ui.emit('join', this.code);
  }
}

export class JoinScreen {
  constructor(ui) {
    this.ui = ui;
    this.input = el('input', {
      id: 'join-code',
      class: 'code-input',
      type: 'text',
      autocapitalize: 'characters',
      autocomplete: 'off',
      autocorrect: 'off',
      spellcheck: 'false',
      enterkeyhint: 'go',
      'aria-label': 'Room code',
      placeholder: '····',
    });
    this.hint = el('p', { class: 'code-hint', text: 'Four letters, no vowels' });
    this.joinBtn = menuButton('Join', { tone: 'red', size: 'btn-xl', id: 'btn-join-go', on: () => this.submit() });
    this.joinBtn.disabled = true;
    this.input.addEventListener('input', (e) => this.onInput(e));
    this.input.addEventListener('compositionend', () => this.normalise());
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); this.submit(); }
    });
    this.root = el('section', { class: 'screen screen-card', dataset: { screen: 'join' } },
      el('div', { class: 'card-col' },
        el('div', { class: 'panel card-panel' },
          el('h2', { class: 'card-title', text: 'Join with Code' }),
          this.input,
          this.hint,
          this.joinBtn,
          menuButton('Back', { tone: 'ghost', iconName: 'back', id: 'btn-join-back', on: () => ui.show('title') }))));
  }

  onInput(e) {
    if (e.isComposing) return;
    this.normalise();
  }

  // Rewriting value moves the caret to the end, so its position is carried across by hand.
  normalise() {
    const raw = this.input.value;
    // A pasted invite link brings its code, not the letters of "https".
    const link = /[?&]join=([a-z]+)/i.exec(raw)?.[1];
    const clean = (link ?? raw).toUpperCase().replace(/[^A-Z]/g, '').slice(0, ROOM_CODE_LEN);
    if (clean !== raw) {
      const caret = this.input.selectionStart ?? clean.length;
      const removed = raw.length - clean.length;
      this.input.value = clean;
      const at = Math.max(0, Math.min(clean.length, caret - Math.max(0, removed)));
      this.input.setSelectionRange(at, at);
    }
    const valid = isValidCode(clean);
    this.joinBtn.disabled = !valid;
    this.hint.classList.toggle('wrong', clean.length === ROOM_CODE_LEN && !valid);
  }

  enter({ code = '' } = {}) {
    this.input.value = code;
    this.normalise();
    if (!matchMedia('(pointer: coarse)').matches) this.input.focus();
  }

  submit() {
    const code = this.input.value;
    if (isValidCode(code)) this.ui.emit('join', code);
  }
}

export class ConnectingScreen {
  constructor(ui) {
    this.ui = ui;
    this.text = el('p', { class: 'connect-text' });
    this.cancelBtn = menuButton('Cancel', { tone: 'ghost', id: 'btn-connect-cancel', on: () => ui.emit('cancelConnect') });
    this.root = el('section', { class: 'screen screen-card screen-connecting', dataset: { screen: 'connecting' } },
      el('div', { class: 'card-col' },
        el('div', { class: 'panel card-panel connect-panel' },
          el('div', { class: 'connect-roll', 'aria-hidden': 'true' }, el('span', { class: 'connect-ball' })),
          this.text,
          this.cancelBtn)));
  }

  enter({ text, cancellable = true }) {
    this.text.textContent = text;
    this.cancelBtn.hidden = !cancellable;
  }
}
