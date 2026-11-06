// Fort Flurry — score notation. Pure data helpers: no Web Audio, so the same code
// compiles the music in the browser and lets Node print and analyse it.
//
// The melodies are written by hand as text, because a human-readable line is the
// only way to review harmony without being able to hear it:
//     line('G5/3 F#5/1 D5/2 | E5/4 B4/2')   note/length, length in `unit` beats
// Every bar is length-checked at load, so a miscounted bar fails loudly in dev
// instead of silently sliding every later note off the harmony.

const LETTER = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const SHARP_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];

export function noteNumber(name) {
  const m = /^([A-G])([#b]?)(-?\d)$/.exec(name);
  if (!m) throw new Error(`Bad note name: ${name}`);
  const accidental = m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0;
  return (Number(m[3]) + 1) * 12 + LETTER[m[1]] + accidental;
}

export function noteName(midi) {
  return `${SHARP_NAMES[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`;
}

export function pitchClass(letters) {
  const m = /^([A-G])([#b]?)$/.exec(letters);
  if (!m) throw new Error(`Bad pitch class: ${letters}`);
  return (LETTER[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? 11 : 0)) % 12;
}

const QUALITY = {
  '': [0, 4, 7], m: [0, 3, 7], 7: [0, 4, 7, 10], m7: [0, 3, 7, 10], maj7: [0, 4, 7, 11],
  6: [0, 4, 7, 9], sus: [0, 5, 7], '7sus': [0, 5, 7, 10], m7b5: [0, 3, 6, 10],
};

export function parseChord(symbol) {
  const [main, slash] = symbol.split('/');
  const m = /^([A-G][#b]?)(.*)$/.exec(main);
  if (!m || !(m[2] in QUALITY)) throw new Error(`Bad chord: ${symbol}`);
  const root = pitchClass(m[1]);
  return {
    symbol,
    root,
    bass: slash ? pitchClass(slash) : root,
    intervals: QUALITY[m[2]],
    pcs: QUALITY[m[2]].map((i) => (root + i) % 12),
  };
}

/**
 * Parses a melody or rhythm line. Tokens: `G5/3`, `r/2`, `C4+E4+G4/2` (a chord),
 * with an optional trailing `>` for an accent. Returns notes in beats from the
 * start of the line, which callers shift with `at`.
 */
export function line(text, { unit = 0.5, perBar, vel = 0.8, at = 0 }) {
  const notes = [];
  let pos = at;
  text.split('|').forEach((bar, index) => {
    if (!bar.trim()) return;
    let used = 0;
    for (const token of bar.trim().split(/\s+/)) {
      const m = /^(.+)\/(\d+(?:\.\d+)?)(>?)$/.exec(token);
      if (!m) throw new Error(`Bad token: ${token}`);
      const length = Number(m[2]);
      if (m[1] !== 'r') {
        for (const name of m[1].split('+')) {
          notes.push({ b: pos + used * unit, m: noteNumber(name), d: length * unit, v: m[3] ? Math.min(1, vel * 1.25) : vel });
        }
      }
      used += length;
    }
    if (perBar && used !== perBar) throw new Error(`Bar ${index + 1} has ${used} units, wanted ${perBar}: "${bar.trim()}"`);
    pos += used * unit;
  });
  return notes;
}

/**
 * Parses a chord chart: `G | Em7 | Am7:1 D7:2`. A lone chord fills its bar and
 * `:n` gives a length in beats.
 */
export function chart(text, beats) {
  const chords = [];
  let pos = 0;
  text.split('|').forEach((bar, index) => {
    const tokens = bar.trim().split(/\s+/);
    let used = 0;
    for (const token of tokens) {
      const [symbol, length] = token.split(':');
      const d = length ? Number(length) : beats;
      chords.push({ ...parseChord(symbol), b: pos + used, d });
      used += d;
    }
    if (used !== beats) throw new Error(`Chart bar ${index + 1} has ${used} beats: "${bar.trim()}"`);
    pos += beats;
  });
  return chords;
}

export function chordAt(chords, beat) {
  let found = chords[0];
  for (const c of chords) {
    if (c.b > beat + 1e-6) break;
    found = c;
  }
  return found;
}

// The lowest note of a pitch class at or above `low`.
export function place(pc, low) {
  return low + ((((pc - low) % 12) + 12) % 12);
}

/**
 * Open arpeggio voicing: bass, fifth, then the colour tones an octave up. Spreading
 * the chord keeps a bell-like accompaniment clear of muddy close seconds.
 */
export function spread(chord, low) {
  const root = place(chord.root, low);
  const bass = place(chord.bass, low);
  const [, third, fifth, seventh] = chord.intervals;
  return seventh === undefined
    ? [bass, root + fifth, root + 12, root + 12 + third]
    : [bass, root + fifth, root + 12 + third, root + 12 + seventh];
}

/**
 * Close voicings where each chord takes the inversion nearest the last one, so pads
 * and afterbeats move by step. Seventh chords drop the root (the bass has it), which
 * is what keeps the top line smooth.
 */
export function voiceLead(chords, low, high) {
  let previous = null;
  return chords.map((chord) => {
    const pcs = chord.intervals.length > 3 ? chord.pcs.slice(1) : chord.pcs;
    const options = [];
    for (let turn = 0; turn < pcs.length; turn++) {
      const order = [...pcs.slice(turn), ...pcs.slice(0, turn)];
      for (let start = low; start < low + 12; start++) {
        if (start % 12 !== order[0]) continue;
        const notes = [start];
        for (let i = 1; i < order.length; i++) notes.push(place(order[i], notes[i - 1] + 1));
        for (let shift = 0; notes[notes.length - 1] + shift <= high; shift += 12) {
          options.push(notes.map((n) => n + shift));
        }
      }
    }
    if (!options.length) throw new Error(`No voicing for ${chord.symbol} in ${low}..${high}`);
    const cost = (notes) => (previous ? notes.reduce((sum, n, i) => sum + Math.abs(n - (previous[i] ?? previous[0])), 0) : notes[0]);
    const best = options.reduce((a, b) => (cost(b) < cost(a) ? b : a));
    previous = best;
    return { ...chord, voicing: best };
  });
}

/**
 * Harmony a third or so under a melody: the highest chord tone at least a minor
 * third below each note. Reading the chord rather than shifting the line by a fixed
 * interval keeps the second voice in key through every chord change.
 */
export function harmonyBelow(notes, chords, vel) {
  return notes.map((n) => {
    const { pcs } = chordAt(chords, n.b);
    let m = n.m - 3;
    while (!pcs.includes(((m % 12) + 12) % 12)) m--;
    return { ...n, m, v: vel };
  });
}

/** Rhythm from a text grid: X accent, x normal, o ghost, anything else silence. */
export function grid(pattern, { unit = 0.5, bars = 1, at = 0, vel = 0.7, m = 60, length = unit }) {
  const notes = [];
  const cells = pattern.replace(/\s+/g, '');
  for (let bar = 0; bar < bars; bar++) {
    [...cells].forEach((cell, i) => {
      const scale = cell === 'X' ? 1.3 : cell === 'x' ? 1 : cell === 'o' ? 0.55 : 0;
      if (scale) notes.push({ b: at + (bar * cells.length + i) * unit, m, d: length, v: Math.min(1, vel * scale) });
    });
  }
  return notes;
}

// Beat to seconds, swing and ritardando included. A swung beat stretches its first
// eighth, which is all that separates a shuffle from a march at the same tempo.
export function makeClock({ bpm, swing = 0.5, rit = null }) {
  const spb = 60 / bpm;
  const swung = (beat) => {
    const whole = Math.floor(beat);
    const f = beat - whole;
    const w = f < 0.5 ? f * (swing / 0.5) : swing + (f - 0.5) * ((1 - swing) / 0.5);
    return whole + w;
  };
  if (!rit) return (beat) => swung(beat) * spb;
  // Integrated once at load: a slowing tempo has no closed form worth keeping.
  const step = 1 / 32;
  const table = [0];
  for (let b = 0; b < rit.until + 64; b += step) {
    const progress = Math.min(1, Math.max(0, (b - rit.from) / (rit.until - rit.from)));
    const speed = 1 - (1 - rit.slowest) * progress;
    table.push(table[table.length - 1] + (spb * step) / speed);
  }
  return (beat) => {
    const i = Math.min(table.length - 2, Math.max(0, Math.floor(beat / step)));
    return table[i] + (table[i + 1] - table[i]) * (beat / step - i);
  };
}
