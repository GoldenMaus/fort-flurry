// Fort Flurry — the soundboard. A dev tool, but it drives the real engine through its
// real API: event sounds go through onFx with a mock view, so what you hear here is what
// the routing does in a match, not a shortcut around it.

import { ACTOR, AFLAG, AUX, BALL, EV, MODE, PHASE, PICKUP, SFX, STRUCT, TEAM } from '../shared/schema.js';
import { CELL } from '../shared/constants.js';
import { AudioEngine, MAX_STARTS, MAX_VOICES, START_WINDOW } from '../js/audio/audio.js';
import { SOUNDS, SOUND_NAMES } from '../js/audio/sfx.js';
import { TRACKS, TRACK_IDS, TRUCK_CHIME } from '../js/audio/tracks.js';
import { measure, renderSound, renderTrack, spectrum } from '../js/audio/offline.js';
import { accompanimentReport, harmonyReport, printScore } from '../js/audio/score-check.js';

const engine = new AudioEngine();
const byId = (id) => document.getElementById(id);

// ---- A pretend match for the routing to read ------------------------------------

const KID_ID = 1;
const OTHER_ID = 2;
const FOE_ID = 1100;
const STRUCT_ID = 1200;
const CENTRE = { x: 800, y: 600 };

const view = {
  map: { w: 1600, h: 1200, fort: { ...CENTRE } },
  mode: MODE.SIEGE, phase: PHASE.FIGHT, wave: 3, secondsLeft: null, blizzard: false,
  meta: { foesLeft: 12, boss: null, suddenDeath: false },
  me: { id: KID_ID, kind: ACTOR.KID, team: TEAM.A, x: CENTRE.x, y: CENTRE.y, vx: 0, vy: 0, flags: 0, aux: 0 },
  you: { balls: 10 },
  actors: [],
  structs: [],
  players: new Map([[KID_ID, { id: KID_ID, team: TEAM.A }]]),
};

// Where triggered sounds come from, in world units from the kid.
const source = { dx: 300, dy: -160 };
const spot = () => ({ x: CENTRE.x + source.dx, y: CENTRE.y + source.dy });

function placeExtras() {
  const { x, y } = spot();
  view.actors = [
    view.me,
    { id: OTHER_ID, kind: ACTOR.KID, team: TEAM.A, x, y, flags: 0 },
    { id: FOE_ID, kind: ACTOR.PIPSQUEAK, team: TEAM.FOES, x, y, flags: 0 },
  ];
  view.structs = [{ id: STRUCT_ID, kind: STRUCT.WALL, cx: Math.floor(x / CELL), cy: Math.floor(y / CELL), hp: 40, maxHp: 60 }];
}

function fire(ev) {
  placeExtras();
  engine.onFx(ev, view);
}

let nextBall = 5000;
function thrown(k, by, power = 0) {
  const { x, y } = spot();
  const id = nextBall++;
  fire({ e: EV.BALL, id, k, by, tm: TEAM.A, x, y, z: 20, vx: 540 + 320 * power, vy: 0, vz: 0, g: 0 });
  return id;
}
function landed(k, why, hit = 0) {
  const { x, y } = spot();
  const id = thrown(k, FOE_ID + nextBall);
  fire({ e: EV.BALL_END, id, x, y, z: 0, why, hit });
}
const cell = () => ({ cx: Math.floor(spot().x / CELL), cy: Math.floor(spot().y / CELL) });

// Each entry is a label and the real event that makes the sound.
const EVENT_GROUPS = [
  ['Throws', [
    ['Quick throw', () => thrown(BALL.QUICK, KID_ID, 0)],
    ['Half power', () => thrown(BALL.QUICK, KID_ID, 0.5)],
    ['Power throw', () => thrown(BALL.POWER, KID_ID, 1)],
    ['Lob', () => thrown(BALL.LOB, KID_ID)],
    ['Ice chunk', () => thrown(BALL.ICE, KID_ID)],
    ['Slushball', () => thrown(BALL.SLUSH, KID_ID)],
    ['Giant roller', () => thrown(BALL.GIANT, KID_ID)],
    ['Cone volley', () => thrown(BALL.CONE, FOE_ID)],
    ['Boulder', () => thrown(BALL.BOULDER, FOE_ID)],
    ['Flinger fires', () => fire({ e: EV.PULT, id: STRUCT_ID, ang: 0 })],
  ]],
  ['Impacts', [
    ['Ground splat', () => landed(BALL.QUICK, 'ground')],
    ['Ice on ground', () => landed(BALL.ICE, 'ground')],
    ['Wall', () => landed(BALL.QUICK, 'struct', STRUCT_ID)],
    ['Tree or car', () => landed(BALL.QUICK, 'obstacle')],
    ['Lid shield', () => landed(BALL.QUICK, 'shield')],
    ['Lob splash', () => fire({ e: EV.SPLASH, ...spot(), r: 46, k: BALL.LOB })],
    ['Slush splash', () => fire({ e: EV.SPLASH, ...spot(), r: 60, k: BALL.SLUSH })],
    ['You hit a foe', () => fire({ e: EV.HIT, id: FOE_ID, amt: 10, ...spot(), by: KID_ID, k: BALL.QUICK })],
    ['Foe hits friend', () => fire({ e: EV.HIT, id: OTHER_ID, amt: 6, ...spot(), by: FOE_ID, k: BALL.QUICK })],
    ['You got hit', () => fire({ e: EV.HIT, id: KID_ID, amt: 10, ...spot(), by: FOE_ID, k: BALL.QUICK })],
    ['Big Kid shove', () => fire({ e: EV.HIT, id: OTHER_ID, amt: 30, ...spot(), by: FOE_ID, k: -1 })],
    ['Quake', () => fire({ e: EV.QUAKE, ...spot(), amt: 0.5 })],
  ]],
  ['Kids and foes', [
    ['You freeze', () => fire({ e: EV.FREEZE, id: KID_ID, by: FOE_ID })],
    ['Friend freezes', () => fire({ e: EV.FREEZE, id: OTHER_ID, by: FOE_ID })],
    ['You thaw', () => fire({ e: EV.THAW, id: KID_ID, by: 0 })],
    ['Respawn', () => fire({ e: EV.RESPAWN, id: KID_ID, ...spot() })],
    ['Belly slide', () => fire({ e: EV.SLIDE, id: KID_ID })],
    ['Shout', () => fire({ e: EV.EMOTE, id: OTHER_ID, n: 0 })],
    ['Foe arrives', () => fire({ e: EV.SPAWN, id: FOE_ID, k: ACTOR.PIPSQUEAK, ...spot() })],
    ['Sledder', () => fire({ e: EV.SPAWN, id: FOE_ID, k: ACTOR.SLEDDER, ...spot() })],
    ['Carrot Thief', () => fire({ e: EV.SPAWN, id: FOE_ID, k: ACTOR.SNEAK, ...spot() })],
    ['Big Kid', () => fire({ e: EV.SPAWN, id: FOE_ID, k: ACTOR.BRUISER, ...spot() })],
    ['Foe gives up', () => fire({ e: EV.FLEE, id: FOE_ID, ...spot() })],
  ]],
  ['Building', Object.entries(STRUCT).filter(([, k]) => k !== STRUCT.COLONEL).map(([name, k]) => [
    `Place ${name.toLowerCase()}`, () => fire({ e: EV.S_ADD, id: STRUCT_ID + 1 + k, k, ...cell(), tm: TEAM.A, hp: 60, mhp: 60, by: KID_ID }),
  ]).concat([
    ['Repair', () => { fire({ e: EV.S_HP, id: STRUCT_ID, hp: 10 }); fire({ e: EV.S_HP, id: STRUCT_ID, hp: 60 }); }],
    ['Demolish', () => fire({ e: EV.S_DEL, id: STRUCT_ID, k: STRUCT.WALL, ...cell(), why: 'demolished' })],
  ])],
  ['Destroyed', Object.entries(STRUCT).map(([name, k]) => [
    `${name.toLowerCase()} falls`, () => fire({ e: EV.S_DEL, id: STRUCT_ID, k, ...cell(), why: 'destroyed' }),
  ])],
  ['Pickups and rewards', [
    ['Pickup appears', () => fire({ e: EV.P_ADD, id: 3000, k: PICKUP.ICE, ...spot() })],
    ...Object.entries(PICKUP).map(([name, k]) => [`Take ${name.toLowerCase()}`, () => fire({ e: EV.P_DEL, id: 3000, k, ...spot(), by: KID_ID })]),
    ['Flake', () => fire({ e: EV.FLAKES, amt: 1, ...spot(), tm: TEAM.A })],
    ['Flake run', () => { for (let i = 0; i < 6; i++) setTimeout(() => fire({ e: EV.FLAKES, amt: 2, ...spot(), tm: TEAM.A }), i * 130); }],
    ['Wave bonus', () => fire({ e: EV.FLAKES, amt: 20, ...spot(), tm: TEAM.A })],
    ['Card offer', () => fire({ e: EV.PICK_OFFER, to: KID_ID, cards: ['a', 'b', 'c'] })],
    ['Card taken', () => fire({ e: EV.CARD, id: KID_ID, card: 'a' })],
  ]],
  ['Phase cues', [
    ['Wave horn', () => phaseChange(3)],
    ['Boss horn', () => phaseChange(5)],
    ['Wave cleared', () => { view.phase = PHASE.FIGHT; engine.update(view); view.phase = PHASE.BUILD; engine.update(view); view.phase = PHASE.FIGHT; }],
    ['Countdown', () => countdown()],
    ['Steve winds up', () => windup()],
    ['Pack a ball', () => pack()],
    ['Blizzard on/off', () => { view.blizzard = !view.blizzard; }],
  ]],
];

function phaseChange(wave) {
  view.wave = wave;
  view.phase = PHASE.BUILD;
  engine.update(view);
  view.phase = PHASE.FIGHT;
  engine.update(view);
  view.wave = 3;
}

function countdown() {
  view.phase = PHASE.BUILD;
  [6, 5, 4, 3, 2, 1].forEach((s, i) => setTimeout(() => {
    view.secondsLeft = s;
    if (s === 1) setTimeout(() => { view.phase = PHASE.FIGHT; view.secondsLeft = null; }, 900);
  }, i * 1000));
}

function windup() {
  const { x, y } = spot();
  const steve = { id: FOE_ID, kind: ACTOR.STEVE, x, y, aux: AUX.POUND, flags: 0 };
  view.meta.boss = { kind: ACTOR.STEVE, name: 'Steve', hp: 100, mhp: 100 };
  view.actors = [view.me, steve];
  engine.update(view);
  steve.aux = 0;
  engine.update(view);
  view.meta.boss = null;
  setTimeout(() => fire({ e: EV.SFX, name: SFX.STEVE_POUND, ...spot() }), 800);
}

function pack() {
  view.me.flags = AFLAG.PACKING;
  view.you.balls = 5;
  engine.update(view);
  view.you.balls = 6;
  engine.update(view);
  view.me.flags = 0;
}

// ---- Page -----------------------------------------------------------------------

function button(parent, label, action, className = '') {
  const b = document.createElement('button');
  b.textContent = label;
  if (className) b.className = className;
  b.addEventListener('click', () => {
    engine.unlock();
    action(b);
  });
  parent.append(b);
  return b;
}

function buildBoard() {
  button(byId('transport'), 'Stop music', () => { engine.setMusic(null); markTrack(null); });
  button(byId('transport'), 'Storm: 200 throws in a second', storm);

  for (const id of TRACK_IDS) {
    button(byId('tracks'), TRACKS[id].title, () => { engine.setMusic(id); markTrack(id); }).dataset.track = id;
  }

  for (const name of Object.values(SFX)) button(byId('named'), name, () => fire({ e: EV.SFX, name, ...spot() }));

  for (const [title, entries] of EVENT_GROUPS) {
    const heading = document.createElement('h3');
    heading.textContent = title;
    const row = document.createElement('div');
    row.className = 'row';
    byId('events').append(heading, row);
    for (const [label, action] of entries) button(row, label, action);
  }

  for (const name of ['click', 'hover', 'join', 'deny']) button(byId('ui'), name, () => engine.ui(name));
  for (const name of SOUND_NAMES) button(byId('raw'), name, () => engine.play(name));

  for (const input of document.querySelectorAll('[data-vol]')) {
    input.addEventListener('input', () => {
      input.nextElementSibling.textContent = input.value;
      engine.setVolumes({ [input.dataset.vol]: input.value / 100 });
    });
  }

  const foes = byId('foes');
  foes.addEventListener('input', () => { byId('foesOut').textContent = foes.value; });
  const boss = byId('bossHp');
  boss.addEventListener('input', () => { byId('bossOut').textContent = boss.value; });

  for (const id of TRACK_IDS) button(byId('scoreTabs'), id, () => showScore(id));
  showScore('menu');
  byId('runTest').addEventListener('click', () => selfTest());

  // Any first gesture unlocks, exactly as main.js does it.
  const unlockOnce = () => {
    engine.unlock();
    if (engine.ctx?.state === 'running') for (const type of GESTURES) window.removeEventListener(type, unlockOnce, true);
  };
  for (const type of GESTURES) window.addEventListener(type, unlockOnce, true);
  document.addEventListener('visibilitychange', () => engine.setHidden(document.hidden));

  setupPad();
  requestAnimationFrame(frame);
}

const GESTURES = ['pointerup', 'touchend', 'click', 'keydown'];

function markTrack(id) {
  for (const b of byId('tracks').children) b.classList.toggle('on', b.dataset.track === id);
}

function storm() {
  let i = 0;
  const burst = setInterval(() => {
    for (let n = 0; n < 20; n++) {
      thrown(BALL.QUICK, 10 + (i % 50));
      fire({ e: EV.HIT, id: OTHER_ID, amt: 5, ...spot(), by: FOE_ID, k: BALL.QUICK });
      i++;
    }
    if (i >= 200) clearInterval(burst);
  }, 100);
}

function setupPad() {
  const pad = byId('pad');
  const range = 900;
  const paint = () => {
    const g = pad.getContext('2d');
    const { width: w, height: h } = pad;
    g.clearRect(0, 0, w, h);
    g.strokeStyle = '#c9d5e8';
    for (const r of [170, 500, 900]) {
      g.beginPath();
      g.arc(w / 2, h / 2, (r / range) * (w / 2), 0, Math.PI * 2);
      g.stroke();
    }
    g.fillStyle = '#d6404e';
    g.beginPath();
    g.arc(w / 2, h / 2, 9, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#3f8fc4';
    g.beginPath();
    g.arc(w / 2 + (source.dx / range) * (w / 2), h / 2 + (source.dy / range) * (h / 2), 11, 0, Math.PI * 2);
    g.fill();
    byId('padOut').textContent = `${Math.round(Math.hypot(source.dx, source.dy))} units from your kid`;
  };
  const move = (e) => {
    const box = pad.getBoundingClientRect();
    source.dx = ((e.clientX - box.left) / box.width - 0.5) * 2 * range;
    source.dy = ((e.clientY - box.top) / box.height - 0.5) * 2 * range;
    paint();
  };
  pad.addEventListener('pointerdown', (e) => {
    pad.setPointerCapture(e.pointerId);
    move(e);
  });
  pad.addEventListener('pointermove', (e) => { if (e.buttons) move(e); });
  paint();
}

let analyser = null;
let samples = null;

function drawScope() {
  const { mix } = engine;
  if (!mix) return;
  if (!analyser) {
    analyser = mix.ctx.createAnalyser();
    analyser.fftSize = 2048;
    samples = new Float32Array(analyser.fftSize);
    mix.output.connect(analyser);
  }
  analyser.getFloatTimeDomainData(samples);
  const canvas = byId('scope');
  const g = canvas.getContext('2d');
  const { width: w, height: h } = canvas;
  g.clearRect(0, 0, w, h);
  g.strokeStyle = '#3f8fc4';
  g.lineWidth = 2;
  g.beginPath();
  for (let i = 0; i < samples.length; i += 2) {
    const x = (i / samples.length) * w;
    const y = h / 2 - samples[i] * (h / 2);
    if (i) g.lineTo(x, y);
    else g.moveTo(x, y);
  }
  g.stroke();
}

function frame() {
  requestAnimationFrame(frame);
  const track = engine.stats.track;
  view.meta.foesLeft = Number(byId('foes').value);
  const hp = Number(byId('bossHp').value);
  view.meta.boss = track === 'truck' || track === 'steve'
    ? { kind: track === 'truck' ? ACTOR.TRUCK : ACTOR.STEVE, name: track, hp, mhp: 100 }
    : null;
  if (view.meta.boss) {
    // Parks the boss at the marker, so dragging it makes the Truck's chime travel.
    const body = { id: FOE_ID, kind: view.meta.boss.kind, ...spot(), aux: 0, flags: 0 };
    view.actors = [view.me, body];
  }
  engine.update(view);
  drawScope();
  const s = engine.stats;
  byId('sLive').textContent = s.live;
  byId('sPeak').textContent = s.peakVoices;
  byId('sRate').textContent = s.rateDropped;
  byId('sCap').textContent = s.capDropped;
  byId('sState').textContent = engine.state;
  byId('sLevel').textContent = s.level;
  byId('sNotes').textContent = s.music?.notes ?? 0;
}

// ---- Score view -----------------------------------------------------------------

function showScore(id) {
  const track = TRACKS[id];
  const report = harmonyReport(track);
  const counts = Object.entries(report.counts).map(([k, n]) => `${k} ${n}`).join(', ');
  const exposed = report.exposed.map((e) => `bar ${e.bar} ${e.name} over ${e.chord}`).join('; ') || 'none';
  byId('score').textContent = [
    `${track.title}  ${track.key}, ${track.beats}/4, ${track.bpm} bpm, ${track.bars} bars, ${track.clock(track.loopBeats).toFixed(1)} s`,
    `Notes: ${counts}`,
    `Chord tones on strong beats: ${Math.round(report.strongChordTones * 100)}%   Unexplained dissonance: ${exposed}`,
    '',
    printScore(track),
  ].join('\n');
}

// ---- Self test ------------------------------------------------------------------

const CEILING = 1;
const SILENCE_DB = -60;

/** Renders and measures everything. Returns a plain report, also shown on the page. */
async function selfTest() {
  const status = byId('status');
  const sounds = [];
  for (const [i, name] of SOUND_NAMES.entries()) {
    status.textContent = `Rendering ${name} (${i + 1}/${SOUND_NAMES.length})`;
    const options = name === 'whoosh' ? { power: 1 } : name === 'rumble' ? { amt: 1 } : {};
    const { buffer, length } = await renderSound(name, options);
    const m = measure(buffer);
    const s = spectrum(buffer);
    sounds.push({
      name, pri: SOUNDS[name].pri, seconds: length, peakDb: m.peakDb, rmsDb: m.rmsDb, jump: m.jump, dc: m.dc,
      above6k: s.above6k, centroid: s.centroid, tail: m.audibleTo,
      pass: m.peakDb > SILENCE_DB && m.peak < CEILING,
    });
  }

  const tracks = [];
  for (const id of TRACK_IDS) {
    const track = TRACKS[id];
    const levels = [...new Set(track.parts.map((p) => p.min))].sort((a, b) => a - b);
    for (const level of levels) {
      status.textContent = `Rendering ${id} level ${level}`;
      const { buffer, notes, length } = await renderTrack(id, { level });
      const m = measure(buffer);
      const s = spectrum(buffer);
      tracks.push({
        id, level, seconds: length, notes, peakDb: m.peakDb, rmsDb: m.rmsDb, jump: m.jump, above6k: s.above6k, centroid: s.centroid,
        pass: m.peakDb > SILENCE_DB && m.peak < CEILING,
      });
    }
  }

  const harmony = TRACK_IDS.map((id) => {
    const r = harmonyReport(TRACKS[id]);
    return { id, strong: r.strongChordTones, exposed: r.exposed.map((e) => `bar ${e.bar} ${e.name}/${e.chord}`), counts: r.counts, outside: accompanimentReport(TRACKS[id]) };
  });

  const chime = TRACKS.truck.parts.find((p) => p.id === 'chime').notes;
  const firstPass = chime.slice(0, TRUCK_CHIME.notes.length);
  const chimeExact = firstPass.every((n, i) => n.m === TRUCK_CHIME.notes[i] && n.d * 2 === TRUCK_CHIME.eighths[i]);

  const report = { sounds, tracks, harmony, chimeExact, limits: { MAX_VOICES, MAX_STARTS, START_WINDOW } };
  showReport(report);
  status.textContent = report.sounds.every((s) => s.pass) && report.tracks.every((t) => t.pass) ? 'All passed.' : 'Some checks failed, see below.';
  return report;
}

function showReport({ sounds, tracks }) {
  const box = byId('report');
  box.textContent = '';
  const table = (heading, columns, rows) => {
    const h = document.createElement('h3');
    h.textContent = heading;
    const t = document.createElement('table');
    const head = t.createTHead().insertRow();
    for (const c of columns) {
      const th = document.createElement('th');
      th.textContent = c[0];
      head.append(th);
    }
    const body = t.createTBody();
    for (const row of rows) {
      const tr = body.insertRow();
      for (const c of columns) {
        const td = tr.insertCell();
        td.textContent = c[1](row);
      }
      const last = tr.lastElementChild;
      last.className = row.pass ? 'ok' : 'fail';
    }
    box.append(h, t);
  };
  const db = (v) => (Number.isFinite(v) ? v.toFixed(1) : '-inf');
  table('Sounds', [
    ['name', (r) => r.name], ['pri', (r) => r.pri], ['seconds', (r) => r.seconds.toFixed(2)], ['peak dB', (r) => db(r.peakDb)],
    ['rms dB', (r) => db(r.rmsDb)], ['centroid Hz', (r) => Math.round(r.centroid)], ['over 6 kHz', (r) => `${(r.above6k * 100).toFixed(2)}%`],
    ['result', (r) => (r.pass ? 'ok' : 'FAIL')],
  ], sounds);
  table('Tracks', [
    ['track', (r) => r.id], ['level', (r) => r.level], ['seconds', (r) => r.seconds.toFixed(1)], ['notes', (r) => r.notes], ['peak dB', (r) => db(r.peakDb)],
    ['rms dB', (r) => db(r.rmsDb)], ['centroid Hz', (r) => Math.round(r.centroid)], ['over 6 kHz', (r) => `${(r.above6k * 100).toFixed(2)}%`],
    ['result', (r) => (r.pass ? 'ok' : 'FAIL')],
  ], tracks);
}

buildBoard();

// For scripts driving this page in a real browser.
globalThis.__audioBoard = { engine, view, fire, selfTest, EVENT_GROUPS };
