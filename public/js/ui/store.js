// Everything the browser remembers between visits. Storage can throw (private mode, disabled
// cookies, full quota), so every touch is guarded: the game must still run with no persistence.
import { LOOK, DEFAULT_LOOK, NAME_MAX } from '../../shared/constants.js';

const KEY = {
  name: 'ff.name', look: 'ff.look', volumes: 'ff.volumes', muted: 'ff.muted',
  quality: 'ff.quality', reduceMotion: 'ff.reduceMotion', tips: 'ff.tips', packs: 'ff.packs',
};

const FIRST = ['Snowy', 'Mighty', 'Cozy', 'Fuzzy', 'Woolly', 'Jolly', 'Sneaky', 'Speedy', 'Toasty', 'Wobbly', 'Brave', 'Sleepy'];
const LAST = ['Otter', 'Penguin', 'Walrus', 'Badger', 'Moose', 'Puffin', 'Yak', 'Seal', 'Hare', 'Fox', 'Owl', 'Goose'];

const pick = (list) => list[Math.floor(Math.random() * list.length)];
export const randomName = () => `${pick(FIRST)} ${pick(LAST)}`;

function read(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function write(key, value) {
  try { localStorage.setItem(key, value); } catch { /* the setting simply won't survive a reload */ }
}
function readJson(key, fallback) {
  try {
    const raw = read(key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch { return fallback; }
}

export function cleanLook(raw) {
  const look = { ...DEFAULT_LOOK };
  if (!raw || typeof raw !== 'object') return look;
  for (const part of Object.keys(DEFAULT_LOOK)) {
    const n = raw[part];
    if (Number.isInteger(n) && n >= 0 && n < LOOK[part].length) look[part] = n;
  }
  return look;
}

export function cleanName(raw) {
  return String(raw ?? '').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);
}

const QUALITIES = ['auto', 'high', 'low'];

export class Prefs {
  constructor() {
    this._name = cleanName(read(KEY.name));
    this._look = cleanLook(readJson(KEY.look, null));
    const vol = readJson(KEY.volumes, null);
    this._volumes = { master: 0.8, music: 0.6, sfx: 0.9 };
    if (vol && typeof vol === 'object') {
      for (const k of Object.keys(this._volumes)) {
        if (Number.isFinite(vol[k])) this._volumes[k] = Math.max(0, Math.min(1, vol[k]));
      }
    }
    this._muted = read(KEY.muted) === '1';
    const quality = read(KEY.quality);
    this._quality = QUALITIES.includes(quality) ? quality : 'auto';
    const rm = read(KEY.reduceMotion);
    this._reduceMotion = rm === null
      ? !!globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches
      : rm === '1';
    const tips = readJson(KEY.tips, []);
    this._tips = new Set(Array.isArray(tips) ? tips.filter((t) => typeof t === 'string') : []);
    const packs = Number(read(KEY.packs));
    this._packs = Number.isFinite(packs) ? packs : 0;
  }

  // The name a player will actually use. An empty field must never reach the host.
  get name() {
    if (!this._name) { this._name = randomName(); write(KEY.name, this._name); }
    return this._name;
  }
  set name(value) {
    this._name = cleanName(value);
    if (this._name) write(KEY.name, this._name);
  }

  get look() { return { ...this._look }; }
  set look(value) { this._look = cleanLook(value); write(KEY.look, JSON.stringify(this._look)); }

  get volumes() { return { ...this._volumes }; }
  set volumes(value) { this._volumes = { ...this._volumes, ...value }; write(KEY.volumes, JSON.stringify(this._volumes)); }

  get muted() { return this._muted; }
  set muted(on) { this._muted = !!on; write(KEY.muted, on ? '1' : '0'); }

  // What the audio engine should play at: mute is kept apart from the sliders so unmuting restores them.
  get audioLevels() {
    const v = this._volumes;
    return { master: this._muted ? 0 : v.master, music: v.music, sfx: v.sfx };
  }

  get quality() { return this._quality; }
  set quality(value) {
    if (!QUALITIES.includes(value)) return;
    this._quality = value;
    write(KEY.quality, value);
  }

  get reduceMotion() { return this._reduceMotion; }
  set reduceMotion(on) { this._reduceMotion = !!on; write(KEY.reduceMotion, on ? '1' : '0'); }

  tipSeen(id) { return this._tips.has(id); }
  markTip(id) {
    if (this._tips.has(id)) return;
    this._tips.add(id);
    write(KEY.tips, JSON.stringify([...this._tips]));
  }

  get packs() { return this._packs; }
  addPack() { this._packs += 1; write(KEY.packs, String(this._packs)); }
}
