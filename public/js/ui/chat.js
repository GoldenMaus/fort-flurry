// One chat history per room, shown in the lobby, on the results screen and over the match.
// Message text and names only ever reach the page through textContent (via el()).
import { CHAT_MAX } from '../../shared/constants.js';
import { el } from './dom.js';
import { ICON } from './art.js';

const KEEP = 60;

export class ChatLog {
  constructor() {
    this.lines = [];
    this.views = new Set();
  }
  add(msg) {
    const line = { id: msg.id, name: String(msg.name ?? ''), text: String(msg.text ?? '') };
    this.lines.push(line);
    if (this.lines.length > KEEP) this.lines.shift();
    for (const view of this.views) view.onLine(line);
  }
  reset() {
    this.lines = [];
    for (const view of this.views) view.rebuild();
  }
}

function lineNode(line) {
  return el('p', { class: 'chat-line' },
    el('span', { class: 'chat-name', text: line.name }),
    el('span', { class: 'chat-text', text: line.text }));
}

export class ChatPanel {
  constructor(ui, log, { title = 'Chat', collapsible = true } = {}) {
    this.ui = ui;
    this.log = log;
    log.views.add(this);
    this.unread = 0;
    this.list = el('div', { class: 'chat-list', role: 'log', 'aria-live': 'polite' });
    this.input = el('input', {
      class: 'chat-input',
      type: 'text',
      maxlength: String(CHAT_MAX),
      placeholder: 'Say something nice',
      autocomplete: 'off',
      enterkeyhint: 'send',
      'aria-label': 'Chat message',
    });
    this.sendBtn = el('button', { type: 'button', class: 'chat-send', text: 'Send', on: { click: () => this.send() } });
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); this.send(); }
    });
    this.badge = el('span', { class: 'chat-badge', hidden: true });
    this.toggleBtn = el('button', {
      type: 'button',
      class: 'chat-toggle',
      'aria-label': 'Show chat',
      on: { click: () => this.setOpen(!this.root.classList.contains('open')) },
    }, el('span', { class: 'btn-ico', trustedHtml: ICON.chat }), el('span', { text: title }), this.badge);
    this.root = el('section', { class: `panel chat-panel${collapsible ? ' collapsible' : ''}` },
      this.toggleBtn,
      el('div', { class: 'chat-body' },
        el('h3', { class: 'panel-title', text: title }),
        this.list,
        el('div', { class: 'chat-row' }, this.input, this.sendBtn)));
    this.rebuild();
  }

  rebuild() {
    this.list.replaceChildren(...this.log.lines.map(lineNode));
    this.list.scrollTop = this.list.scrollHeight;
  }

  onLine(line) {
    const stick = this.list.scrollHeight - this.list.scrollTop - this.list.clientHeight < 40;
    this.list.append(lineNode(line));
    while (this.list.childElementCount > KEEP) this.list.firstElementChild.remove();
    if (stick) this.list.scrollTop = this.list.scrollHeight;
    if (!this.root.classList.contains('open') && this.root.classList.contains('collapsible')) {
      this.unread += 1;
      this.badge.textContent = String(this.unread);
      this.badge.hidden = false;
    }
  }

  setOpen(on) {
    this.root.classList.toggle('open', on);
    if (on) {
      this.unread = 0;
      this.badge.hidden = true;
      this.list.scrollTop = this.list.scrollHeight;
    }
  }

  send() {
    const text = this.input.value.trim();
    if (!text) return;
    this.ui.session?.chat(text);
    this.input.value = '';
  }

  focus() { this.setOpen(true); this.input.focus(); }
}
