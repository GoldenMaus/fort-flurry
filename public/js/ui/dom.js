// Small DOM helpers shared by every screen. Strings handed to el() always become text nodes, so
// player-supplied text can never be parsed as markup. The only markup path is trustedHtml, which
// takes the constant art strings from art.js and nothing else.

export class Emitter {
  constructor() { this.handlers = new Map(); }
  on(name, fn) {
    if (!this.handlers.has(name)) this.handlers.set(name, new Set());
    this.handlers.get(name).add(fn);
    return this;
  }
  off(name, fn) { this.handlers.get(name)?.delete(fn); return this; }
  emit(name, ...args) {
    const set = this.handlers.get(name);
    if (!set) return;
    for (const fn of [...set]) fn(...args);
  }
}

function applyAttrs(node, attrs) {
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.setAttribute('class', value);
    else if (key === 'text') node.textContent = value;
    else if (key === 'trustedHtml') node.innerHTML = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key === 'on') for (const [ev, fn] of Object.entries(value)) node.addEventListener(ev, fn);
    else if (key === 'style' && typeof value === 'object') {
      for (const [prop, val] of Object.entries(value)) node.style.setProperty(prop, val);
    } else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, value);
  }
}

export function el(tag, attrs, ...kids) {
  const node = document.createElement(tag);
  if (attrs) applyAttrs(node, attrs);
  for (const kid of kids.flat(Infinity)) {
    if (kid === null || kid === undefined || kid === false) continue;
    node.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return node;
}

export function clear(node) { node.replaceChildren(); return node; }

// In-match buttons must never take keyboard focus: a focused button would swallow Space and Enter,
// and on touch a focused element makes iOS scroll the page to reveal it.
export function hudBtn(attrs, ...kids) {
  const btn = el('button', { type: 'button', tabindex: '-1', ...attrs }, ...kids);
  btn.addEventListener('pointerdown', (e) => e.preventDefault());
  return btn;
}

// Writes only when the value changed. The HUD updates every frame, and an unconditional DOM write
// would invalidate style or layout sixty times a second for nothing.
export class Memo {
  constructor() {
    this.scalars = new Map();
    this.perNode = new WeakMap();
  }
  changed(key, value) {
    if (this.scalars.get(key) === value) return false;
    this.scalars.set(key, value);
    return true;
  }
  slot(node, key, value) {
    let slots = this.perNode.get(node);
    if (!slots) { slots = new Map(); this.perNode.set(node, slots); }
    if (slots.get(key) === value) return false;
    slots.set(key, value);
    return true;
  }
  text(node, value) { if (this.slot(node, 'text', value)) node.textContent = value; }
  toggle(node, cls, on) { if (this.slot(node, `class:${cls}`, on)) node.classList.toggle(cls, on); }
  show(node, on) { if (this.slot(node, 'hidden', on)) node.hidden = !on; }
  style(node, prop, value) { if (this.slot(node, `style:${prop}`, value)) node.style.setProperty(prop, value); }
  attr(node, name, value) { if (this.slot(node, `attr:${name}`, value)) node.setAttribute(name, value); }
  clear() { this.scalars.clear(); this.perNode = new WeakMap(); }
}

export const clamp01 = (v) => Math.max(0, Math.min(1, v));

export function fmtClock(seconds) {
  const s = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
