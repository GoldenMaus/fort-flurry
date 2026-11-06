import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CHUNK_HEADER_BYTES, ChunkAssembler, DEFAULT_SETTINGS, MAX_CHUNKS, SEND, chunkMessage, decodeInput, decodeSnapshot,
  encodeInput, encodeSnapshot, isValidCode, makeRoomCode, sanitizeChat, sanitizeLook, sanitizeName, sanitizeSettings,
  sendVerdict,
} from '../public/shared/protocol.js';
import { AFLAG, BIN, BTN, DIFFICULTY, MODE, TEAM } from '../public/shared/schema.js';
import {
  CHAT_MAX, CHUNK_BYTES, CONN_KILL_BYTES, DEFAULT_LOOK, LOOK, NAME_MAX, ROOM_CODE_ALPHABET, ROOM_CODE_LEN,
  SNAP_DROP_BYTES,
} from '../public/shared/constants.js';

const TAU = Math.PI * 2;
const near = (a, b, eps, label) => assert.ok(Math.abs(a - b) <= eps, `${label}: ${a} vs ${b}`);

// A seeded generator keeps a fuzz failure reproducible from the printed seed.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const baseFrame = { seq: 7, mx: 0.5, my: -0.25, aim: 1.2, btn: BTN.THROW | BTN.SLIDE, tx: 123, ty: -456 };
const baseYou = {
  balls: 7, maxBalls: 13, special: 2, specialN: 4, warmth: 87.3, maxWarmth: 125, throwCd: 0.2, slideCd: 1.5,
  slideT: 0.3, packT: 0.1, boardT: 5.5, slowT: 2.5, stunT: 0.8, prevBtn: 5, frozenT: 9, spendLeft: 40,
};
const baseActor = {
  id: 1234, kind: 3, team: TEAM.FOES, x: 800.25, y: 600.5, vx: -120.5, vy: 75, aim: 2.5, hp: 0.5,
  flags: AFLAG.CHARGING | AFLAG.GRACE, aux: 200,
};

test('input is exactly 14 bytes with the documented layout', () => {
  const buf = encodeInput(baseFrame);
  assert.ok(buf instanceof ArrayBuffer);
  assert.equal(buf.byteLength, 14);
  const d = new DataView(buf);
  assert.equal(d.getUint8(0), BIN.INPUT);
  assert.equal(d.getUint32(1, true), 7);
  assert.equal(d.getInt8(5), 64);
  assert.equal(d.getInt8(6), -32);
  assert.equal(d.getUint8(9), BTN.THROW | BTN.SLIDE);
  assert.equal(d.getInt16(10, true), 123);
  assert.equal(d.getInt16(12, true), -456);
});

test('input round-trips every field', () => {
  const f = decodeInput(encodeInput(baseFrame));
  assert.equal(f.seq, 7);
  near(f.mx, 0.5, 1 / 127, 'mx');
  near(f.my, -0.25, 1 / 127, 'my');
  near(f.aim, 1.2, TAU / 65535, 'aim');
  assert.equal(f.btn, BTN.THROW | BTN.SLIDE);
  assert.equal(f.tx, 123);
  assert.equal(f.ty, -456);
});

test('input decoding is idempotent, so prediction and the sim see identical floats', () => {
  const rng = mulberry32(99);
  for (let i = 0; i < 2000; i++) {
    const once = decodeInput(encodeInput({
      seq: i, mx: rng() * 2 - 1, my: rng() * 2 - 1, aim: (rng() - 0.5) * 40, btn: Math.floor(rng() * 16),
      tx: rng() * 4000 - 2000, ty: rng() * 4000 - 2000,
    }));
    assert.deepEqual(decodeInput(encodeInput(once)), once);
  }
});

test('input clamps out of range values instead of wrapping', () => {
  const f = decodeInput(encodeInput({ seq: -5, mx: 40, my: -40, aim: 0, btn: 999, tx: 1e9, ty: -1e9 }));
  assert.equal(f.seq, 0);
  assert.equal(f.mx, 1);
  assert.equal(f.my, -1);
  assert.equal(f.tx, 32767);
  assert.equal(f.ty, -32768);
  const big = decodeInput(encodeInput({ ...baseFrame, seq: 2 ** 40 }));
  assert.equal(big.seq, 0xffffffff);
});

test('input wraps aim into 0..2pi from any direction', () => {
  for (const [aim, want] of [[-Math.PI / 2, 1.5 * Math.PI], [TAU + 1, 1], [-TAU - 1, TAU - 1], [50 * TAU + 0.5, 0.5]]) {
    near(decodeInput(encodeInput({ ...baseFrame, aim })).aim, want, TAU / 65535 * 2, `aim ${aim}`);
  }
});

test('input turns NaN and Infinity into neutral values', () => {
  const f = decodeInput(encodeInput({ seq: NaN, mx: NaN, my: Infinity, aim: NaN, btn: NaN, tx: NaN, ty: -Infinity }));
  assert.equal(f.seq, 0);
  assert.equal(f.mx, 0);
  assert.equal(f.my, 1);
  assert.equal(f.aim, 0);
  assert.equal(f.btn, 0);
  assert.equal(f.tx, 0);
  assert.equal(f.ty, -32768);
});

test('decodeInput rejects anything but an exact 14 byte input frame', () => {
  for (const len of [0, 1, 13, 15, 16, 64]) assert.equal(decodeInput(new ArrayBuffer(len)), null, `len ${len}`);
  assert.equal(decodeInput(null), null);
  assert.equal(decodeInput('frame'), null);
  assert.equal(decodeInput(new Uint8Array(14)), null);
  const wrongType = encodeInput(baseFrame);
  new DataView(wrongType).setUint8(0, BIN.SNAPSHOT);
  assert.equal(decodeInput(wrongType), null);
});

test('decodeInput neutralizes what a hostile client can put on the wire', () => {
  const buf = encodeInput(baseFrame);
  const d = new DataView(buf);
  d.setInt8(5, -128);
  d.setUint8(9, 0xff);
  const f = decodeInput(buf);
  assert.equal(f.mx, -1);
  assert.equal(f.btn, BTN.THROW | BTN.LOB | BTN.SLIDE | BTN.CANCEL);
});

test('snapshot layout matches the documented sizes', () => {
  const noYou = encodeSnapshot({ tick: 4, ack: 2, you: null, actors: [baseActor, baseActor] });
  assert.equal(noYou.byteLength, 1 + 4 + 4 + 1 + 1 + 2 * 17);
  const withYou = encodeSnapshot({ tick: 4, ack: 2, you: baseYou, actors: [] });
  assert.equal(withYou.byteLength, 1 + 4 + 4 + 1 + 19 + 1);
  assert.equal(new DataView(withYou).getUint8(0), BIN.SNAPSHOT);
  assert.equal(new DataView(withYou).getUint8(9), 1);
});

test('snapshot round-trips every You and Actor field', () => {
  const s = decodeSnapshot(encodeSnapshot({ tick: 123456, ack: 654321, you: baseYou, actors: [baseActor] }));
  assert.equal(s.tick, 123456);
  assert.equal(s.ack, 654321);
  const y = s.you;
  assert.equal(y.balls, 7);
  assert.equal(y.maxBalls, 13);
  assert.equal(y.special, 2);
  assert.equal(y.specialN, 4);
  near(y.warmth, 87.3, 0.05, 'warmth');
  near(y.maxWarmth, 125, 0.05, 'maxWarmth');
  for (const k of ['throwCd', 'slideCd', 'slideT', 'packT', 'boardT', 'slowT', 'stunT']) near(y[k], baseYou[k], 1 / 60, k);
  assert.equal(y.prevBtn, 5);
  assert.equal(y.frozenT, 9);
  assert.equal(y.spendLeft, 40);
  const a = s.actors[0];
  assert.equal(a.id, 1234);
  assert.equal(a.kind, 3);
  assert.equal(a.team, TEAM.FOES);
  assert.equal(a.x, 800.25);
  assert.equal(a.y, 600.5);
  assert.equal(a.vx, -120.5);
  assert.equal(a.vy, 75);
  near(a.aim, 2.5, TAU / 255, 'aim');
  near(a.hp, 0.5, 1 / 255, 'hp');
  assert.equal(a.flags, AFLAG.CHARGING | AFLAG.GRACE);
  assert.equal(a.aux, 200);
});

test('snapshot clamps every field to its type range instead of wrapping', () => {
  const s = decodeSnapshot(encodeSnapshot({
    tick: 2 ** 33,
    ack: -1,
    you: {
      balls: 999, maxBalls: -4, special: 300, specialN: 999, warmth: 1e6, maxWarmth: -5, throwCd: 100, slideCd: -1,
      slideT: 100, packT: 100, boardT: 100, slowT: 100, stunT: 100, prevBtn: 999, frozenT: 999, spendLeft: 1e9,
    },
    actors: [{ id: 70000, kind: 300, team: 300, x: 1e6, y: -10, vx: 1e6, vy: -1e6, aim: 0, hp: 9, flags: 1e6, aux: 300 }],
  }));
  assert.equal(s.tick, 0xffffffff);
  assert.equal(s.ack, 0);
  const y = s.you;
  assert.equal(y.balls, 255);
  assert.equal(y.maxBalls, 0);
  assert.equal(y.special, 255);
  assert.equal(y.specialN, 255);
  assert.equal(y.warmth, 6553.5);
  assert.equal(y.maxWarmth, 0);
  assert.equal(y.throwCd, 8.5);
  assert.equal(y.slideCd, 0);
  assert.equal(y.frozenT, 255);
  assert.equal(y.spendLeft, 65535);
  const a = s.actors[0];
  assert.equal(a.id, 65535);
  assert.equal(a.kind, 255);
  assert.equal(a.team, 255);
  assert.equal(a.x, 65535 / 4);
  assert.equal(a.y, 0);
  assert.equal(a.vx, 32767 / 2);
  assert.equal(a.vy, -32768 / 2);
  assert.equal(a.hp, 1);
  assert.equal(a.flags, 65535);
  assert.equal(a.aux, 255);
});

test('snapshot maps "no special" and "unlimited" sentinels from any sim representation', () => {
  for (const special of [null, undefined, -1, 255]) {
    assert.equal(decodeSnapshot(encodeSnapshot({ tick: 1, ack: 0, you: { ...baseYou, special }, actors: [] })).you.special, 255);
  }
  for (const spendLeft of [Infinity, null, undefined, 70000]) {
    assert.equal(decodeSnapshot(encodeSnapshot({ tick: 1, ack: 0, you: { ...baseYou, spendLeft }, actors: [] })).you.spendLeft, 65535);
  }
});

test('snapshot wraps actor aim and survives NaN', () => {
  const a = decodeSnapshot(encodeSnapshot({ tick: 1, ack: 0, you: null, actors: [{ ...baseActor, aim: -Math.PI / 2 }] })).actors[0];
  near(a.aim, 1.5 * Math.PI, TAU / 255, 'negative aim');
  const nan = decodeSnapshot(encodeSnapshot({
    tick: 1, ack: 0, you: null, actors: [{ ...baseActor, x: NaN, y: NaN, vx: NaN, vy: NaN, aim: NaN, hp: NaN, flags: NaN, aux: NaN }],
  })).actors[0];
  assert.deepEqual([nan.x, nan.y, nan.vx, nan.vy, nan.aim, nan.hp, nan.flags, nan.aux], [0, 0, 0, 0, 0, 0, 0, 0]);
});

test('snapshot caps the actor list at the u8 count and stays decodable', () => {
  const actors = Array.from({ length: 300 }, (_, i) => ({ ...baseActor, id: i + 1 }));
  const s = decodeSnapshot(encodeSnapshot({ tick: 1, ack: 0, you: null, actors }));
  assert.equal(s.actors.length, 255);
  assert.equal(s.actors[254].id, 255);
});

test('encoders return a fresh buffer each call', () => {
  const a = encodeSnapshot({ tick: 1, ack: 0, you: null, actors: [] });
  const b = encodeSnapshot({ tick: 1, ack: 0, you: null, actors: [] });
  assert.notEqual(a, b);
  assert.notEqual(encodeInput(baseFrame), encodeInput(baseFrame));
});

test('decodeSnapshot rejects every wrong length and a bad hasYou byte', () => {
  const good = encodeSnapshot({ tick: 9, ack: 3, you: baseYou, actors: [baseActor, baseActor] });
  for (let len = 0; len < good.byteLength; len++) assert.equal(decodeSnapshot(good.slice(0, len)), null, `truncated to ${len}`);
  const longer = new ArrayBuffer(good.byteLength + 1);
  new Uint8Array(longer).set(new Uint8Array(good));
  assert.equal(decodeSnapshot(longer), null);
  const bad = good.slice(0);
  new DataView(bad).setUint8(9, 2);
  assert.equal(decodeSnapshot(bad), null);
  const wrong = good.slice(0);
  new DataView(wrong).setUint8(0, BIN.INPUT);
  assert.equal(decodeSnapshot(wrong), null);
  assert.equal(decodeSnapshot(null), null);
  assert.equal(decodeSnapshot('snap'), null);
});

test('fuzz: decoders never throw on random bytes and only return plain finite data', () => {
  const seed = 20261106;
  const rng = mulberry32(seed);
  let accepted = 0;
  for (let i = 0; i < 40000; i++) {
    // A third of the cases are pure noise. The rest have a valid shape and random
    // contents, because noise alone almost never gets past the length checks.
    const shape = i % 3;
    const hasYou = Math.floor(rng() * 2);
    const count = Math.floor(rng() * 12);
    const len = shape === 0 ? 14 : shape === 1 ? 11 + hasYou * 19 + count * 17 : Math.floor(rng() * 200);
    const bytes = new Uint8Array(len);
    for (let j = 0; j < len; j++) bytes[j] = Math.floor(rng() * 256);
    if (shape === 0) bytes[0] = BIN.INPUT;
    if (shape === 1) {
      bytes[0] = BIN.SNAPSHOT;
      bytes[9] = hasYou;
      bytes[10 + hasYou * 19] = count;
    }
    const frame = decodeInput(bytes.buffer);
    if (frame) {
      accepted += 1;
      for (const v of Object.values(frame)) assert.ok(Number.isFinite(v), `seed ${seed} iteration ${i}`);
      assert.ok(Math.abs(frame.mx) <= 1 && Math.abs(frame.my) <= 1);
      assert.ok(frame.aim >= 0 && frame.aim <= TAU);
    }
    const snap = decodeSnapshot(bytes.buffer);
    if (snap) {
      accepted += 1;
      assert.ok(Number.isFinite(snap.tick) && Number.isFinite(snap.ack));
      for (const a of snap.actors) for (const v of Object.values(a)) assert.ok(Number.isFinite(v));
    }
  }
  assert.ok(accepted > 1000, `fuzz only reached the decoders ${accepted} times`);
});

test('fuzz: valid snapshots with flipped bytes never throw', () => {
  const rng = mulberry32(5);
  const good = new Uint8Array(encodeSnapshot({ tick: 9, ack: 3, you: baseYou, actors: [baseActor, baseActor, baseActor] }));
  for (let i = 0; i < 20000; i++) {
    const copy = good.slice();
    copy[Math.floor(rng() * copy.length)] = Math.floor(rng() * 256);
    decodeSnapshot(copy.buffer);
  }
});

test('fuzz: chunk assembler never throws on random frames', () => {
  const rng = mulberry32(77);
  const asm = new ChunkAssembler();
  for (let i = 0; i < 20000; i++) {
    const bytes = new Uint8Array(Math.floor(rng() * 40));
    for (let j = 0; j < bytes.length; j++) bytes[j] = Math.floor(rng() * 256);
    if (bytes.length) bytes[0] = BIN.CHUNK;
    asm.push(bytes.buffer);
  }
});

test('sanitizeName trims, strips control and bidi characters, and caps length', () => {
  assert.equal(sanitizeName('  Ada  '), 'Ada');
  assert.equal(sanitizeName('a\tb\nc'), 'a b c');
  assert.equal(sanitizeName('e\u202evil\u200b'), 'evil');
  assert.equal(sanitizeName('x'.repeat(100)).length, NAME_MAX);
  assert.equal(sanitizeName(''), '');
  assert.equal(sanitizeName('   \u200b  '), '');
  assert.equal(sanitizeName(42), '');
  assert.equal(sanitizeName(null), '');
  assert.equal(sanitizeName({ toString: () => 'x' }), '');
});

test('sanitizeName never splits a surrogate pair', () => {
  const out = sanitizeName('\u{1F600}'.repeat(40));
  assert.equal(Array.from(out).length, NAME_MAX);
  assert.ok(!/\p{Cs}/u.test(out));
  assert.equal(sanitizeName('\ud83d'), '');
});

test('sanitizeChat caps at CHAT_MAX and flattens lines', () => {
  assert.equal(sanitizeChat('hi\r\nthere'), 'hi there');
  assert.equal(sanitizeChat('y'.repeat(5000)).length, CHAT_MAX);
  assert.equal(sanitizeChat(undefined), '');
});

test('sanitizeLook clamps indices and falls back to the default look', () => {
  assert.deepEqual(sanitizeLook(null), { ...DEFAULT_LOOK });
  assert.deepEqual(sanitizeLook('red'), { ...DEFAULT_LOOK });
  assert.deepEqual(sanitizeLook({ hat: 2, coat: 3, scarf: 4, skin: 5 }), { hat: 2, coat: 3, scarf: 4, skin: 5 });
  const high = sanitizeLook({ hat: 99, coat: 99, scarf: 99, skin: 99 });
  assert.deepEqual(high, { hat: LOOK.hat.length - 1, coat: LOOK.coat.length - 1, scarf: LOOK.scarf.length - 1, skin: LOOK.skin.length - 1 });
  assert.deepEqual(sanitizeLook({ hat: -3, coat: 1.9, scarf: NaN, skin: Infinity }), { hat: 0, coat: 1, scarf: DEFAULT_LOOK.scarf, skin: DEFAULT_LOOK.skin });
  assert.deepEqual(sanitizeLook({ hat: 'x', evil: 1 }), { ...DEFAULT_LOOK });
  assert.equal(sanitizeLook({}) === DEFAULT_LOOK, false);
});

test('sanitizeSettings keeps valid keys, rejects the rest, and drops unknown keys', () => {
  assert.deepEqual(sanitizeSettings(null), { ...DEFAULT_SETTINGS });
  assert.deepEqual(
    sanitizeSettings({ mode: MODE.FFA, mapId: 'pond', difficulty: DIFFICULTY.COZY, waveCount: 5, extra: 1 }),
    { mode: MODE.FFA, mapId: 'pond', difficulty: DIFFICULTY.COZY, waveCount: 5 },
  );
  const base = { mode: MODE.FORTWARS, mapId: 'yard', difficulty: DIFFICULTY.BLIZZARD, waveCount: 0 };
  assert.deepEqual(sanitizeSettings({ mode: 'chess', mapId: 'moon', difficulty: 9, waveCount: 7 }, base), base);
  assert.deepEqual(sanitizeSettings(JSON.parse('{"__proto__":{"polluted":1},"mode":"ffa"}'), base), { ...base, mode: MODE.FFA });
  assert.equal({}.polluted, undefined);
});

test('room codes use only the alphabet and validate strictly', () => {
  const rng = mulberry32(1);
  for (let i = 0; i < 500; i++) {
    const code = makeRoomCode(rng);
    assert.equal(code.length, ROOM_CODE_LEN);
    assert.ok(isValidCode(code), code);
  }
  assert.equal(makeRoomCode(() => 0), ROOM_CODE_ALPHABET[0].repeat(ROOM_CODE_LEN));
  assert.ok(isValidCode(makeRoomCode(() => 0.9999999999)));
  assert.ok(isValidCode(makeRoomCode(() => 1)), 'an rng that returns exactly 1 must not run off the alphabet');
  for (const bad of ['', 'BCD', 'BCDFG', 'bcdf', 'ABCD', 'BCD1', 1234, null, undefined, ['B', 'C', 'D', 'F']]) {
    assert.equal(isValidCode(bad), false, String(bad));
  }
});

test('back-pressure verdict follows the three rules', () => {
  const snap = encodeSnapshot({ tick: 1, ack: 0, you: null, actors: [] });
  const input = encodeInput(baseFrame);
  assert.equal(sendVerdict(snap, 0), SEND.OK);
  assert.equal(sendVerdict(snap, SNAP_DROP_BYTES), SEND.OK);
  assert.equal(sendVerdict(snap, SNAP_DROP_BYTES + 1), SEND.SKIP);
  assert.equal(sendVerdict('{"t":"meta"}', SNAP_DROP_BYTES + 1), SEND.OK);
  assert.equal(sendVerdict(input, SNAP_DROP_BYTES + 1), SEND.OK);
  assert.equal(sendVerdict(new ArrayBuffer(0), SNAP_DROP_BYTES + 1), SEND.OK);
  assert.equal(sendVerdict(snap, CONN_KILL_BYTES), SEND.SKIP);
  assert.equal(sendVerdict(snap, CONN_KILL_BYTES + 1), SEND.KILL);
  assert.equal(sendVerdict('{"t":"full"}', CONN_KILL_BYTES + 1), SEND.KILL);
});

function reassemble(frames) {
  const asm = new ChunkAssembler();
  let out = null;
  frames.forEach((f, i) => {
    const got = asm.push(f);
    if (i < frames.length - 1) assert.equal(got, null, `frame ${i} must not complete the message`);
    else out = got;
  });
  return out;
}

test('chunking leaves small messages alone and honors the frame header', () => {
  assert.equal(chunkMessage('small', 1), null);
  assert.equal(chunkMessage(new ArrayBuffer(CHUNK_BYTES), 1), null);
  assert.equal(chunkMessage('x'.repeat(CHUNK_BYTES), 1), null);
  const frames = chunkMessage('x'.repeat(CHUNK_BYTES + 1), 0x1234);
  assert.equal(frames.length, 2);
  frames.forEach((f, i) => {
    const d = new DataView(f);
    assert.ok(f.byteLength <= CHUNK_BYTES);
    assert.equal(d.getUint8(0), BIN.CHUNK);
    assert.equal(d.getUint8(1), 1);
    assert.equal(d.getUint16(2, true), 0x1234);
    assert.equal(d.getUint16(4, true), i);
    assert.equal(d.getUint16(6, true), 2);
  });
});

test('chunking round-trips text and binary, including UTF-8 split across frames', () => {
  const text = '\u{1F9E3}snow'.repeat(9000);
  assert.ok(new TextEncoder().encode(text).byteLength > CHUNK_BYTES * 3);
  assert.equal(reassemble(chunkMessage(text, 3)), text);
  const bytes = new Uint8Array(100000);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31) & 255;
  const back = reassemble(chunkMessage(bytes.buffer.slice(0), 4));
  assert.ok(back instanceof ArrayBuffer);
  assert.deepEqual(new Uint8Array(back), bytes);
});

test('chunking measures encoded bytes, not string length', () => {
  const text = '\u{1F9E3}'.repeat(4000); // 8000 UTF-16 units, 16000 UTF-8 bytes
  assert.ok(text.length < CHUNK_BYTES);
  const frames = chunkMessage(text, 1);
  assert.ok(frames && frames.length === 2);
  assert.equal(reassemble(frames), text);
});

test('chunking refuses a message past the frame count limit', () => {
  const tooBig = new ArrayBuffer((CHUNK_BYTES - CHUNK_HEADER_BYTES) * MAX_CHUNKS + 1);
  assert.throws(() => chunkMessage(tooBig, 1), RangeError);
  const justFits = new ArrayBuffer((CHUNK_BYTES - CHUNK_HEADER_BYTES) * MAX_CHUNKS);
  assert.equal(chunkMessage(justFits, 1).length, MAX_CHUNKS);
});

test('assembler rejects a frame count over 256 and a bad header', () => {
  const asm = new ChunkAssembler();
  const frame = new ArrayBuffer(CHUNK_HEADER_BYTES + 4);
  const d = new DataView(frame);
  d.setUint8(0, BIN.CHUNK);
  d.setUint16(6, 257, true);
  assert.equal(asm.push(frame), null);
  assert.equal(asm.parts, null);
  d.setUint16(6, 0, true);
  assert.equal(asm.push(frame), null);
  d.setUint16(6, 2, true);
  d.setUint16(4, 5, true);
  assert.equal(asm.push(frame), null);
  assert.equal(asm.push(new ArrayBuffer(3)), null);
  assert.equal(asm.push('text'), null);
});

test('assembler discards a partial on a gap, a foreign msgId, or reset', () => {
  const frames = chunkMessage('z'.repeat(CHUNK_BYTES * 3), 9);
  assert.ok(frames.length >= 3);
  const gap = new ChunkAssembler();
  gap.push(frames[0]);
  assert.equal(gap.push(frames[2]), null);
  assert.equal(gap.parts, null, 'a gap drops the partial');
  const other = chunkMessage('y'.repeat(CHUNK_BYTES * 3), 10);
  const mixed = new ChunkAssembler();
  mixed.push(frames[0]);
  assert.equal(mixed.push(other[1]), null);
  assert.equal(mixed.parts, null, 'a frame from another message drops the partial');
  const closing = new ChunkAssembler();
  closing.push(frames[0]);
  closing.reset();
  assert.equal(closing.push(frames[1]), null, 'nothing survives a close');
  const restart = new ChunkAssembler();
  restart.push(other[0]);
  frames.forEach((f, i) => {
    const got = restart.push(f);
    if (i === frames.length - 1) assert.equal(got, 'z'.repeat(CHUNK_BYTES * 3), 'frame 0 restarts cleanly');
  });
});
