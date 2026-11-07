// Fort Flurry wire format: the binary hot paths, the sanitizers every inbound
// value goes through, and the helpers both hosts share (back-pressure, chunking).
// Imported by the browser, the worker and Node, so it must stay free of platform APIs.
import { BIN, BTN, DIFFICULTY, MODE } from './schema.js';
import {
  CHAT_MAX, CHUNK_BYTES, CONN_KILL_BYTES, DEFAULT_LOOK, LOOK, NAME_MAX, ROOM_CODE_ALPHABET,
  ROOM_CODE_LEN, SIEGE, SNAP_DROP_BYTES,
} from './constants.js';
import { MAPS } from './maps.js';

const TAU = Math.PI * 2;
const INPUT_BYTES = 14;
const SNAP_HEADER_BYTES = 10; // u8 type, u32 tick, u32 ack, u8 hasYou
const YOU_BYTES = 19;
const ACTOR_BYTES = 17;
const BTN_MASK = BTN.THROW | BTN.LOB | BTN.SLIDE | BTN.CANCEL;
const NO_SPECIAL = 255;
const UNLIMITED_SPEND = 65535;

export const CHUNK_HEADER_BYTES = 8;
export const MAX_CHUNKS = 256;
export const DEFAULT_SETTINGS = Object.freeze({
  mode: MODE.SIEGE, mapId: 'court', difficulty: DIFFICULTY.NORMAL, waveCount: 10,
});

// Round, then clamp. NaN collapses to the low end so a bad float can never reach
// DataView, which would otherwise write it modulo the type range (a wrap).
function fit(v, lo, hi) {
  const r = Math.round(v);
  if (r !== r) return lo > 0 ? lo : 0;
  return r < lo ? lo : r > hi ? hi : r;
}

function wrapAngle(a) {
  if (!Number.isFinite(a)) return 0;
  const w = a % TAU;
  return w < 0 ? w + TAU : w;
}

// ---- input ------------------------------------------------------------------

export function encodeInput(frame) {
  const buf = new ArrayBuffer(INPUT_BYTES);
  const d = new DataView(buf);
  d.setUint8(0, BIN.INPUT);
  d.setUint32(1, fit(frame.seq, 0, 0xffffffff), true);
  d.setInt8(5, fit(frame.mx * 127, -127, 127));
  d.setInt8(6, fit(frame.my * 127, -127, 127));
  d.setUint16(7, fit(wrapAngle(frame.aim) / TAU * 65535, 0, 65535), true);
  d.setUint8(9, fit(frame.btn, 0, 255));
  d.setInt16(10, fit(frame.tx, -32768, 32767), true);
  d.setInt16(12, fit(frame.ty, -32768, 32767), true);
  return buf;
}

export function decodeInput(buf) {
  if (!(buf instanceof ArrayBuffer) || buf.byteLength !== INPUT_BYTES) return null;
  const d = new DataView(buf);
  if (d.getUint8(0) !== BIN.INPUT) return null;
  return {
    seq: d.getUint32(1, true),
    // -128 is legal on the wire but only a hostile client sends it.
    mx: Math.max(-1, d.getInt8(5) / 127),
    my: Math.max(-1, d.getInt8(6) / 127),
    aim: d.getUint16(7, true) / 65535 * TAU,
    btn: d.getUint8(9) & BTN_MASK,
    tx: d.getInt16(10, true),
    ty: d.getInt16(12, true),
  };
}

// ---- snapshot ---------------------------------------------------------------

function writeYou(d, o, y) {
  d.setUint8(o, fit(y.balls, 0, 255));
  d.setUint8(o + 1, fit(y.maxBalls, 0, 255));
  const special = y.special === null || y.special === undefined || y.special < 0 ? NO_SPECIAL : y.special;
  d.setUint8(o + 2, fit(special, 0, 255));
  d.setUint8(o + 3, fit(y.specialN, 0, 255));
  d.setUint16(o + 4, fit(y.warmth * 10, 0, 65535), true);
  d.setUint16(o + 6, fit(y.maxWarmth * 10, 0, 65535), true);
  d.setUint8(o + 8, fit(y.throwCd * 30, 0, 255));
  d.setUint8(o + 9, fit(y.slideCd * 30, 0, 255));
  d.setUint8(o + 10, fit(y.slideT * 30, 0, 255));
  d.setUint8(o + 11, fit(y.packT * 30, 0, 255));
  d.setUint8(o + 12, fit(y.boardT * 30, 0, 255));
  d.setUint8(o + 13, fit(y.slowT * 30, 0, 255));
  d.setUint8(o + 14, fit(y.stunT * 30, 0, 255));
  d.setUint8(o + 15, fit(y.prevBtn, 0, 255));
  d.setUint8(o + 16, fit(y.frozenT, 0, 255));
  // The sim may hold "no budget" as null or Infinity; both mean unlimited on the wire.
  const spend = y.spendLeft === null || y.spendLeft === undefined ? UNLIMITED_SPEND : y.spendLeft;
  d.setUint16(o + 17, fit(spend, 0, UNLIMITED_SPEND), true);
}

function readYou(d, o) {
  return {
    balls: d.getUint8(o),
    maxBalls: d.getUint8(o + 1),
    special: d.getUint8(o + 2),
    specialN: d.getUint8(o + 3),
    warmth: d.getUint16(o + 4, true) / 10,
    maxWarmth: d.getUint16(o + 6, true) / 10,
    throwCd: d.getUint8(o + 8) / 30,
    slideCd: d.getUint8(o + 9) / 30,
    slideT: d.getUint8(o + 10) / 30,
    packT: d.getUint8(o + 11) / 30,
    boardT: d.getUint8(o + 12) / 30,
    slowT: d.getUint8(o + 13) / 30,
    stunT: d.getUint8(o + 14) / 30,
    prevBtn: d.getUint8(o + 15),
    frozenT: d.getUint8(o + 16),
    spendLeft: d.getUint16(o + 17, true),
  };
}

function writeActor(d, o, a) {
  d.setUint16(o, fit(a.id, 0, 65535), true);
  d.setUint8(o + 2, fit(a.kind, 0, 255));
  d.setUint8(o + 3, fit(a.team, 0, 255));
  d.setUint16(o + 4, fit(a.x * 4, 0, 65535), true);
  d.setUint16(o + 6, fit(a.y * 4, 0, 65535), true);
  d.setInt16(o + 8, fit(a.vx * 2, -32768, 32767), true);
  d.setInt16(o + 10, fit(a.vy * 2, -32768, 32767), true);
  d.setUint8(o + 12, fit(wrapAngle(a.aim) / TAU * 255, 0, 255));
  d.setUint8(o + 13, fit(a.hp * 255, 0, 255));
  d.setUint16(o + 14, fit(a.flags, 0, 65535), true);
  d.setUint8(o + 16, fit(a.aux, 0, 255));
}

function readActor(d, o) {
  return {
    id: d.getUint16(o, true),
    kind: d.getUint8(o + 2),
    team: d.getUint8(o + 3),
    x: d.getUint16(o + 4, true) / 4,
    y: d.getUint16(o + 6, true) / 4,
    vx: d.getInt16(o + 8, true) / 2,
    vy: d.getInt16(o + 10, true) / 2,
    aim: d.getUint8(o + 12) / 255 * TAU,
    hp: d.getUint8(o + 13) / 255,
    flags: d.getUint16(o + 14, true),
    aux: d.getUint8(o + 16),
  };
}

export function encodeSnapshot({ tick, ack, you, actors }) {
  const hasYou = you !== null && you !== undefined;
  const count = Math.min(actors.length, 255);
  const buf = new ArrayBuffer(SNAP_HEADER_BYTES + (hasYou ? YOU_BYTES : 0) + 1 + count * ACTOR_BYTES);
  const d = new DataView(buf);
  d.setUint8(0, BIN.SNAPSHOT);
  d.setUint32(1, fit(tick, 0, 0xffffffff), true);
  d.setUint32(5, fit(ack, 0, 0xffffffff), true);
  d.setUint8(9, hasYou ? 1 : 0);
  let o = SNAP_HEADER_BYTES;
  if (hasYou) {
    writeYou(d, o, you);
    o += YOU_BYTES;
  }
  d.setUint8(o, count);
  o += 1;
  for (let i = 0; i < count; i++, o += ACTOR_BYTES) writeActor(d, o, actors[i]);
  return buf;
}

export function decodeSnapshot(buf) {
  if (!(buf instanceof ArrayBuffer) || buf.byteLength < SNAP_HEADER_BYTES + 1) return null;
  const d = new DataView(buf);
  if (d.getUint8(0) !== BIN.SNAPSHOT) return null;
  const hasYou = d.getUint8(9);
  if (hasYou > 1) return null;
  let o = SNAP_HEADER_BYTES;
  if (hasYou && buf.byteLength < o + YOU_BYTES + 1) return null;
  const you = hasYou ? readYou(d, o) : null;
  if (hasYou) o += YOU_BYTES;
  const count = d.getUint8(o);
  o += 1;
  if (buf.byteLength !== o + count * ACTOR_BYTES) return null;
  const actors = new Array(count);
  for (let i = 0; i < count; i++, o += ACTOR_BYTES) actors[i] = readActor(d, o);
  return { tick: d.getUint32(1, true), ack: d.getUint32(5, true), you, actors };
}

// ---- sanitizers -------------------------------------------------------------

function cleanText(s, max) {
  if (typeof s !== 'string') return '';
  // Bound the work first; a code point is at most two UTF-16 units.
  const text = s.slice(0, max * 8)
    .replace(/[\t\n\r\f\v\p{Zl}\p{Zp}]/gu, ' ')
    // Control, format (bidi overrides, zero-width) and lone surrogates: none of them
    // belong in a name tag, and they are how text gets to spoof another player.
    .replace(/\p{C}/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  return Array.from(text).slice(0, max).join('').trim();
}

// Empty means "no usable name": the caller owns the fallback, because the host's
// fallback and the UI's random name differ.
export function sanitizeName(name) {
  return cleanText(name, NAME_MAX);
}

export function sanitizeChat(text) {
  return cleanText(text, CHAT_MAX);
}

export function sanitizeLook(look) {
  const out = { ...DEFAULT_LOOK };
  if (look === null || typeof look !== 'object') return out;
  for (const key of Object.keys(DEFAULT_LOOK)) {
    const v = look[key];
    if (typeof v === 'number' && Number.isFinite(v)) {
      out[key] = Math.min(LOOK[key].length - 1, Math.max(0, Math.trunc(v)));
    }
  }
  return out;
}

// Reads only the four known keys, so a hostile partial cannot smuggle anything
// into the settings object that gets rebroadcast to every client.
export function sanitizeSettings(partial, base = DEFAULT_SETTINGS) {
  const out = { mode: base.mode, mapId: base.mapId, difficulty: base.difficulty, waveCount: base.waveCount };
  if (partial === null || typeof partial !== 'object') return out;
  if (Object.values(MODE).includes(partial.mode)) out.mode = partial.mode;
  if (MAPS.some((m) => m.id === partial.mapId)) out.mapId = partial.mapId;
  if (Object.values(DIFFICULTY).includes(partial.difficulty)) out.difficulty = partial.difficulty;
  if (SIEGE.waveCounts.includes(partial.waveCount)) out.waveCount = partial.waveCount;
  return out;
}

export function makeRoomCode(rng) {
  const n = ROOM_CODE_ALPHABET.length;
  let code = '';
  for (let i = 0; i < ROOM_CODE_LEN; i++) code += ROOM_CODE_ALPHABET[Math.min(n - 1, Math.floor(rng() * n))];
  return code;
}

// Siege is won or lost by the whole team, including a friend who joined too late for a kid of
// their own. Elsewhere the winners list decides.
export function viewerWon(result, me) {
  return result.mode === MODE.SIEGE ? !!result.won : result.winners.includes(me);
}

export function isValidCode(code) {
  if (typeof code !== 'string' || code.length !== ROOM_CODE_LEN) return false;
  for (const ch of code) if (!ROOM_CODE_ALPHABET.includes(ch)) return false;
  return true;
}

// ---- back-pressure ----------------------------------------------------------

export const SEND = Object.freeze({ OK: 'ok', SKIP: 'skip', KILL: 'kill' });

// One rule for both hosts. A snapshot can always be skipped because the next one is
// self-contained and ack is cumulative; JSON carries state that exists nowhere else,
// so it is queued or the conn dies, never dropped.
export function sendVerdict(data, buffered) {
  if (buffered > CONN_KILL_BYTES) return SEND.KILL;
  if (buffered > SNAP_DROP_BYTES && data instanceof ArrayBuffer && data.byteLength > 0
    && new Uint8Array(data, 0, 1)[0] === BIN.SNAPSHOT) return SEND.SKIP;
  return SEND.OK;
}

// ---- chunking (P2P host -> client) ------------------------------------------

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

// Returns null when the message fits in one frame, otherwise the frames to send in
// order. Measures encoded bytes: a short string of emoji can still be over the limit.
export function chunkMessage(data, msgId) {
  const isText = typeof data === 'string';
  if (isText ? data.length * 3 <= CHUNK_BYTES : data.byteLength <= CHUNK_BYTES) return null;
  const bytes = isText ? textEncoder.encode(data) : new Uint8Array(data);
  if (bytes.byteLength <= CHUNK_BYTES) return null;
  const room = CHUNK_BYTES - CHUNK_HEADER_BYTES;
  const count = Math.ceil(bytes.byteLength / room);
  if (count > MAX_CHUNKS) throw new RangeError(`message of ${bytes.byteLength} bytes needs ${count} chunks`);
  const frames = new Array(count);
  for (let i = 0; i < count; i++) {
    const part = bytes.subarray(i * room, Math.min(bytes.byteLength, (i + 1) * room));
    const frame = new ArrayBuffer(CHUNK_HEADER_BYTES + part.byteLength);
    const d = new DataView(frame);
    d.setUint8(0, BIN.CHUNK);
    d.setUint8(1, isText ? 1 : 0);
    d.setUint16(2, msgId & 0xffff, true);
    d.setUint16(4, i, true);
    d.setUint16(6, count, true);
    new Uint8Array(frame, CHUNK_HEADER_BYTES).set(part);
    frames[i] = frame;
  }
  return frames;
}

// Frames of one message are sent back-to-back on an ordered channel, so anything
// other than the exact next frame means the stream is broken: drop the partial and
// wait for a frame 0 instead of growing a buffer on a hostile count.
export class ChunkAssembler {
  constructor() {
    this.reset();
  }

  reset() {
    this.parts = null;
    this.msgId = -1;
    this.count = 0;
    this.isText = false;
    this.size = 0;
  }

  // Returns the original string or ArrayBuffer when the last frame lands, else null.
  push(frame) {
    if (!(frame instanceof ArrayBuffer) || frame.byteLength < CHUNK_HEADER_BYTES) {
      this.reset();
      return null;
    }
    const d = new DataView(frame);
    const isText = d.getUint8(1) === 1;
    const msgId = d.getUint16(2, true);
    const index = d.getUint16(4, true);
    const count = d.getUint16(6, true);
    if (d.getUint8(0) !== BIN.CHUNK || count < 1 || count > MAX_CHUNKS || index >= count) {
      this.reset();
      return null;
    }
    if (index === 0) {
      this.reset();
      this.parts = [];
      this.msgId = msgId;
      this.count = count;
      this.isText = isText;
    } else if (this.parts === null || msgId !== this.msgId || count !== this.count
      || index !== this.parts.length || isText !== this.isText) {
      this.reset();
      return null;
    }
    const payload = new Uint8Array(frame, CHUNK_HEADER_BYTES);
    this.parts.push(payload);
    this.size += payload.byteLength;
    if (this.parts.length < this.count) return null;
    const whole = new Uint8Array(this.size);
    let o = 0;
    for (const part of this.parts) {
      whole.set(part, o);
      o += part.byteLength;
    }
    const text = this.isText;
    this.reset();
    return text ? textDecoder.decode(whole) : whole.buffer;
  }
}
