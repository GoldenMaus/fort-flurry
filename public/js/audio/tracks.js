// Fort Flurry — the soundtrack, all original, written by hand.
//
// Key plan: the title waltz is in G, and its falling figure G F# D | E B is the game's
// signature. The win stinger brings that figure back in triumph and the lose stinger
// brings it back in the minor. The Truck's chime sits in D, the dominant of the title
// key, so it sounds like a sour cousin of the menu music box. Build is a bright C
// major, the fight a mischievous D minor swing, and Steve a heavy C minor stomp.
//
// Each part can carry a `min`/`max` intensity level: the conductor reads the level at
// every bar line and only plays parts inside it, which is how the fight and both boss
// themes grow without ever changing key, tempo or form.

import { line, chart, chordAt, spread, voiceLead, harmonyBelow, grid, place, makeClock } from './notation.js';

// The phrase is fixed by the game's spec. Nothing here may alter it, and the chime
// voice plays no other notes.
export const TRUCK_CHIME = Object.freeze({
  notes: Object.freeze([74, 79, 76, 81, 78, 74, 76, 69]),
  eighths: Object.freeze([1, 1, 1, 1, 2, 1, 1, 4]),
  restBars: 1,
  beats: 3,
  bpm: 132,
});

function part(id, inst, notes, options = {}) {
  return { id, inst, notes, gain: 1, pan: 0, send: 0, min: 0, max: 9, art: 1, bus: null, ...options };
}

function compose(def) {
  const events = [];
  for (const p of def.parts) for (const n of p.notes) events.push({ ...n, part: p });
  events.sort((a, b) => a.b - b.b);
  return Object.freeze({ swing: 0.5, rit: null, gain: 1, sections: null, ...def, loopBeats: def.bars * def.beats, events, clock: makeClock(def) });
}

function chordsInBar(chords, bar, beats) {
  return chords.filter((c) => c.b >= bar * beats && c.b < (bar + 1) * beats);
}

function barRange(from, to) {
  return Array.from({ length: to - from }, (_, i) => from + i);
}

// A chord's fifth, folded down when it would climb out of a bass line's range.
function bassFifth(root, high) {
  return root + 7 <= high ? root + 7 : root - 5;
}

// ---- Menu: "Snow Globe Waltz" ------------------------------------------------
// 32 bars, AABA. The B section falls in thirds by repeating one two-bar figure
// (bars 17, 19, 21), and the last A borrows C minor in bar 30 for one bittersweet
// moment before going home.

function menuTrack() {
  const beats = 3;
  const chords = chart(`
    G | Em7 | C | D | G/B | C | Am7 | D7 |
    G | Em7 | C | Am7 | Bm7 | Em7 | Am7:1 D7:2 | G |
    Em | Bm | C | G/B | Am7 | Em/G | Am7 | D7sus:1 D7:2 |
    G | Em7 | C | Am7 | G/B | C:2 Cm:1 | G/D:2 D7:1 | G`.trim(), beats);

  const lead = line(`
    G5/3 F#5/1 D5/2 | E5/4 B4/2 | C5/3 D5/1 E5/2 | F#5/4 A5/2 |
    B5/3 A5/1 G5/2 | E5/4 G5/2 | A5/2 G5/2 E5/2 | D5/4 r/2 |
    G5/3 F#5/1 D5/2 | E5/4 B4/2 | C5/3 D5/1 E5/2 | A5/4 C6/2 |
    B5/3 A5/1 F#5/2 | G5/3 F#5/1 E5/2 | C6/2 A5/2 F#5/2 | G5/4 r/2 |
    G5/2 F#5/1 G5/1 B5/2 | F#5/4 D5/2 | E5/2 D5/1 E5/1 G5/2 | D5/4 B4/2 |
    C5/2 B4/1 C5/1 E5/2 | B4/4 G4/2 | A4/2 C5/2 E5/2 | G5/3 F#5/1 A5/2 |
    G5/3 F#5/1 D5/2 | E5/4 B4/2 | C5/3 D5/1 E5/2 | A5/4 C6/2 |
    B5/3 A5/1 G5/2 | E5/2 G5/2 Eb5/2 | D5/2 B4/2 A4/1 C5/1 | B4/4 r/2`, { perBar: 6, vel: 0.82 });

  // A sections roll in eighths. The B section drops to a plain waltz so the falling
  // melody has room, then the rolling figure returning marks the reprise.
  const roll = [];
  const waltz = [];
  const pattern = [0, 1, 2, 3, 2, 1];
  for (const bar of barRange(0, 32)) {
    const inB = bar >= 16 && bar < 24;
    for (let step = 0; step < 6; step++) {
      const b = bar * beats + step * 0.5;
      const chord = chordAt(chords, b);
      const voicing = spread(chord, 48);
      if (inB) {
        if (step === 0) waltz.push({ b, m: voicing[0], d: 1, v: 0.5 });
        else if (step === 2 || step === 4) {
          waltz.push({ b, m: voicing[2], d: 1, v: 0.3 }, { b, m: voicing[3], d: 1, v: 0.3 });
        }
      } else {
        // A chord change inside the bar restarts the figure from its bass note, or
        // the new harmony would have nothing under it.
        const fresh = step > 0 && chord.b === b;
        roll.push({ b, m: voicing[fresh ? 0 : pattern[step]], d: 0.5, v: step === 0 || fresh ? 0.46 : 0.32 });
      }
    }
  }

  const held = voiceLead(chords, 60, 76);
  const pad = held.flatMap((c) => c.voicing.map((m) => ({ b: c.b, m, d: c.d, v: 0.5 })));
  const bassPad = chords.map((c) => ({ b: c.b, m: place(c.bass, 36), d: c.d, v: 0.5 }));

  // The final A doubles the tune an octave up, quietly, so the last time through
  // glows a little brighter than the first.
  const descant = lead.filter((n) => n.b >= 24 * beats).map((n) => ({ ...n, m: n.m + 12, v: 0.34 }));

  return compose({
    id: 'menu', title: 'Snow Globe Waltz', key: 'G major', bpm: 92, beats, bars: 32, loop: true, gain: 0.6,
    chords, lead: ['lead'],
    parts: [
      part('lead', 'musicBox', lead, { gain: 0.8, send: 0.55 }),
      part('descant', 'musicBox', descant, { gain: 0.5, send: 0.7, pan: 0.15 }),
      part('roll', 'musicBox', roll, { gain: 0.56, send: 0.4, pan: -0.15 }),
      part('waltz', 'musicBox', waltz, { gain: 0.5, send: 0.4, pan: -0.15 }),
      part('pad', 'pad', pad, { gain: 0.1, send: 0.5 }),
      part('bassPad', 'pad', bassPad, { gain: 0.16, send: 0.2 }),
    ],
  });
}

// ---- Build: "Hammer and Mitten" ----------------------------------------------
// 24 bars, A A' B. Short hops over a tresillo bass in the A sections, a sequence that
// steps down a third (bars 1 and 3), then a smoother dotted line in the B section for
// contrast. Light enough to think over while placing walls.

function buildTrack() {
  const beats = 4;
  const chords = chart(`
    C | F:2 G:2 | Am | Dm:2 G7:2 | C | F:2 G:2 | Am:2 D7:2 | G:2 G7:2 |
    C | F:2 G:2 | Am | Dm:2 G7:2 | Em:2 A7:2 | Dm:2 G7:2 | C | C |
    F | G | Em | Am | Dm | G7 | Em:2 A7:2 | Dm:2 G7:2`.trim(), beats);

  const hops = line(`
    G5/1 r/1 E5/1 r/1 C5/1 D5/1 E5/1 r/1 | F5/1 r/1 A5/1 r/1 G5/2 D5/1 r/1 |
    E5/1 r/1 C5/1 r/1 A4/1 B4/1 C5/1 r/1 | D5/1 r/1 F5/1 r/1 D5/2 B4/1 r/1 |
    G5/1 r/1 E5/1 r/1 C5/1 D5/1 E5/1 r/1 | F5/1 r/1 A5/1 r/1 G5/2 B5/1 r/1 |
    C6/1 r/1 A5/1 r/1 F#5/1 G5/1 A5/1 r/1 | G5/2 r/2 F5/1 E5/1 D5/1 r/1 |
    G5/1 r/1 E5/1 r/1 C5/1 D5/1 E5/1 r/1 | F5/1 r/1 A5/1 r/1 G5/2 D5/1 r/1 |
    E5/1 r/1 C5/1 r/1 A4/1 B4/1 C5/1 r/1 | D5/1 r/1 F5/1 r/1 D5/2 B4/1 r/1 |
    B5/1 r/1 G5/1 r/1 E5/1 F#5/1 G5/1 r/1 | A5/1 r/1 F5/1 r/1 D5/1 E5/1 F5/1 r/1 |
    E5/2 C5/1 E5/1 G5/2 r/2 | C6/2 r/1 G5/1 C5/1 r/3 |`, { perBar: 8, vel: 0.8 });

  const song = line(`
    A5/3 G5/1 F5/2 C5/2 | B4/3 C5/1 D5/2 G5/2 |
    G5/3 F#5/1 E5/2 B4/2 | C5/3 D5/1 E5/2 A5/2 |
    F5/3 E5/1 D5/2 A4/2 | B4/3 C5/1 D5/2 F5/2 |
    G5/2 E5/2 C#5/2 E5/2 | F5/2 D5/2 B4/2 D5/1 F5/1 |`, { perBar: 8, vel: 0.72, at: 16 * beats });

  const bass = [];
  const roll = [];
  for (const bar of barRange(0, 24)) {
    const inB = bar >= 16;
    const here = chordsInBar(chords, bar, beats);
    const start = bar * beats;
    for (const c of here) {
      const root = place(c.root, 40);
      const fifth = bassFifth(root, 55);
      if (here.length === 1 && !inB) {
        // Tresillo, 3+3+2: the bounce that keeps a four-chord loop from plodding.
        bass.push({ b: start, m: root, d: 1.3, v: 0.85 }, { b: start + 1.5, m: fifth, d: 1.3, v: 0.7 }, { b: start + 3, m: root, d: 0.9, v: 0.75 });
      } else if (here.length === 1) {
        bass.push({ b: start, m: root, d: 0.9, v: 0.8 }, { b: start + 1, m: fifth, d: 0.9, v: 0.6 }, { b: start + 2, m: root, d: 0.9, v: 0.7 }, { b: start + 3, m: fifth, d: 0.9, v: 0.6 });
      } else {
        bass.push({ b: c.b, m: root, d: 0.9, v: 0.8 }, { b: c.b + 1, m: fifth, d: 0.9, v: 0.62 });
      }
    }
    if (inB) {
      const figure = [0, 1, 2, 1, 3, 1, 2, 1];
      figure.forEach((index, step) => {
        const b = start + step * 0.5;
        roll.push({ b, m: spread(chordAt(chords, b), 48)[index], d: 0.5, v: step % 2 ? 0.34 : 0.46 });
      });
    }
  }

  const voiced = voiceLead(chords, 57, 72);
  const dabs = [];
  for (const bar of barRange(0, 16)) {
    for (const offset of [1, 3]) {
      const b = bar * beats + offset;
      for (const m of chordAt(voiced, b).voicing.slice(-2)) dabs.push({ b, m, d: 0.4, v: 0.5 });
    }
  }

  const blocks = [];
  for (const bar of barRange(0, 24)) {
    if (bar % 8 === 3 || bar % 8 === 7) blocks.push(...grid('.....xxX', { at: bar * beats, vel: 0.55, m: 76 }));
    else if (bar % 2 === 1) blocks.push(...grid('.......x', { at: bar * beats, vel: 0.5, m: 76 }));
  }

  return compose({
    id: 'build', title: 'Hammer and Mitten', key: 'C major', bpm: 116, beats, bars: 24, loop: true, gain: 1.1, sections: [0, 8, 16],
    chords, lead: ['hops', 'song'],
    parts: [
      part('hops', 'pizz', hops, { gain: 0.85, send: 0.22, pan: 0.1 }),
      part('song', 'bell', song, { gain: 1, send: 0.35, pan: 0.1 }),
      part('bass', 'pluckBass', bass, { gain: 0.5, send: 0.05 }),
      part('dabs', 'mallet', dabs, { gain: 0.5, send: 0.2, pan: -0.25 }),
      part('roll', 'mallet', roll, { gain: 0.62, send: 0.22, pan: -0.25 }),
      part('shaker', 'shaker', grid('oxoxoxox', { bars: 24, vel: 0.5 }), { gain: 0.5, pan: 0.3 }),
      part('blocks', 'woodblock', blocks, { gain: 0.5, send: 0.2, pan: -0.1 }),
    ],
  });
}

// ---- Fight: "Snowball Swing" -------------------------------------------------
// 32 bars of cartoon-caper swing: a 12-bar minor blues twice, then an 8-bar bridge in
// the relative major. One walking bass line and the brushes run throughout, and the
// band piles in as the foe count climbs:
//   level 0  bass, brushes, comping
//   level 1  + clarinet tune
//   level 2  + vibes on the tune, ghost notes
//   level 3  + second clarinet in harmony, rim, tambourine, brass kicks

function fightTrack() {
  const beats = 4;
  const chords = chart(`
    Dm7 | Dm7 | Dm7 | D7 | Gm7 | Gm7 | Dm7 | Dm7 | Bb7 | A7 | Dm7 | A7 |
    Dm7 | Dm7 | Dm7 | D7 | Gm7 | Gm7 | Dm7 | Dm7 | Bb7 | A7 | Dm7 | C7 |
    F | D7 | Gm7 | C7 | F | D7 | Gm7 | A7`.trim(), beats);

  // Beat 1 is a chord tone and beat 4 steps into the next root, so the line walks
  // with purpose instead of arpeggiating in place.
  const walk = line(`
    D2/2 F2/2 A2/2 C3/2 | D3/2 C3/2 A2/2 F2/2 | D2/2 E2/2 F2/2 A2/2 | D3/2 C3/2 A2/2 F#2/2 |
    G2/2 A2/2 Bb2/2 D3/2 | G2/2 Bb2/2 C3/2 C#3/2 | D3/2 A2/2 F2/2 E2/2 | D2/2 F2/2 G2/2 A2/2 |
    Bb2/2 D3/2 F3/2 D3/2 | A2/2 C#3/2 E3/2 C#3/2 | D3/2 C3/2 Bb2/2 A2/2 | A2/2 G2/2 E2/2 C#2/2 |
    D2/2 A2/2 D3/2 C3/2 | D3/2 C3/2 A2/2 G2/2 | F2/2 G2/2 A2/2 C3/2 | D3/2 C3/2 A2/2 F#2/2 |
    G2/2 D3/2 G3/2 F3/2 | D3/2 Bb2/2 A2/2 C#3/2 | D3/2 A2/2 F2/2 E2/2 | D2/2 F2/2 G2/2 A2/2 |
    Bb2/2 D3/2 F3/2 Bb2/2 | A2/2 E3/2 C#3/2 A2/2 | D3/2 C3/2 A2/2 F2/2 | C3/2 Bb2/2 G2/2 E2/2 |
    F2/2 A2/2 C3/2 C#3/2 | D3/2 A2/2 F#2/2 A2/2 | G2/2 Bb2/2 D3/2 C#3/2 | C3/2 Bb2/2 G2/2 E2/2 |
    F2/2 A2/2 C3/2 C#3/2 | D3/2 C3/2 A2/2 F#2/2 | G2/2 D3/2 C3/2 Bb2/2 | A2/2 G2/2 F2/2 E2/2 |`, { perBar: 8, vel: 0.8 })
    .map((n, i) => ({ ...n, v: i % 2 ? 0.86 : 0.74 }));

  // The riff starts on the "and" of one, so it always feels like it is sneaking in.
  // First chorus states it on the tonic and up a fourth, the second chorus turns it
  // upside down, and the bridge runs a falling sequence through the cycle of fifths.
  const tune = line(`
    r/1 A4/1 D5/1 F5/1 r/1 E5/1 D5/2 | r/1 C5/1 A4/2 r/4 |
    r/1 A4/1 D5/1 F5/1 r/1 G5/1 A5/2 | r/1 C6/1 A5/1 F#5/1 r/1 D5/1 C5/1 A4/1 |
    r/1 D5/1 G5/1 Bb5/1 r/1 A5/1 G5/2 | r/1 F5/1 D5/2 r/4 |
    r/1 A4/1 D5/1 F5/1 r/1 E5/1 D5/2 | r/1 C5/1 A4/2 r/1 D5/1 F5/1 A5/1 |
    Bb5/3 Ab5/1 F5/2 D5/2 | A5/3 G5/1 E5/2 C#5/2 |
    D5/1 F5/1 A5/1 D6/1 r/1 C6/1 A5/2 | r/1 G5/1 E5/1 C#5/1 r/1 A4/1 r/2 |
    r/1 A5/1 F5/1 D5/1 r/1 E5/1 F5/2 | r/1 E5/1 C5/2 r/4 |
    r/1 A5/1 F5/1 D5/1 r/1 G5/1 A5/2 | r/1 C6/1 A5/1 F#5/1 r/1 E5/1 D5/1 C5/1 |
    r/1 Bb5/1 G5/1 D5/1 r/1 F5/1 G5/2 | r/1 F5/1 D5/2 r/4 |
    r/1 A5/1 F5/1 D5/1 r/1 E5/1 F5/2 | r/1 E5/1 C5/2 r/1 F5/1 A5/1 C6/1 |
    Bb5/2 D6/2 Ab5/2 F5/2 | A5/2 C#6/2 G5/2 E5/2 |
    F5/2 A5/2 D5/2 F5/2 | E5/2 G5/2 C6/2 Bb5/2 |
    A5/2 C6/1 A5/1 r/1 F5/1 G5/1 A5/1 | F#5/2 A5/1 F#5/1 r/1 D5/1 E5/1 F#5/1 |
    G5/2 Bb5/1 G5/1 r/1 D5/1 E5/1 F5/1 | E5/2 G5/1 E5/1 r/1 C5/1 D5/1 E5/1 |
    A5/2 C6/1 A5/1 r/1 F5/1 G5/1 A5/1 | F#5/2 A5/1 C6/1 r/1 A5/1 F#5/1 D5/1 |
    Bb5/3 A5/1 G5/2 F5/2 | E5/2 G5/2 C#5/2 A4/2 |`, { perBar: 8, vel: 0.8 });

  // Hand-placed so each change moves by a step or less. Dm7 and Gm7 leave out the ninth:
  // the tune sits on F and Bb over them, and a ninth below would make a minor ninth.
  const voicings = {
    Dm7: [60, 62, 65, 69], D7: [60, 64, 66, 69], Gm7: [58, 62, 65, 67], Bb7: [56, 60, 62, 65],
    A7: [55, 61, 64, 69], C7: [58, 62, 64, 67], F: [57, 60, 62, 65],
  };
  const comp = [];
  const kicks = [];
  const rhythms = [[0, 3], [3, 6], [0, 3], [1, 5]];
  for (const bar of barRange(0, 32)) {
    const start = bar * beats;
    for (const eighth of rhythms[bar % 4]) {
      const b = start + eighth * 0.5;
      for (const m of voicings[chordAt(chords, b).symbol]) comp.push({ b, m, d: 0.4, v: eighth === 0 ? 0.62 : 0.5 });
    }
    // Brass kicks punctuate the end of each phrase, landing just before the bar line.
    if (bar % 4 === 3) {
      for (const eighth of [5, 7]) {
        const b = start + eighth * 0.5;
        for (const m of voicings[chordAt(chords, b + 0.5).symbol]) kicks.push({ b, m: m + 12, d: 0.45, v: 0.5 });
      }
    }
  }

  const fills = [];
  for (const bar of [11, 23, 31]) fills.push(...grid('.....xxX', { at: bar * beats, vel: 0.6, m: 50 }));

  return compose({
    id: 'fight', title: 'Snowball Swing', key: 'D minor', bpm: 152, beats, bars: 32, loop: true, swing: 0.62, gain: 0.75, sections: [0, 12, 24],
    chords, lead: ['tune'],
    parts: [
      part('walk', 'upright', walk, { gain: 0.58, send: 0.04, art: 0.92 }),
      part('ride', 'brushTap', grid('x.Xox.Xo', { bars: 32, vel: 0.5 }), { gain: 0.8, pan: 0.2, send: 0.06 }),
      part('swish', 'brushSwish', grid('..x...x.', { bars: 32, vel: 0.6 }), { gain: 0.62, pan: -0.1, send: 0.08 }),
      part('kick', 'kick', grid('x...x...', { bars: 32, vel: 0.55 }), { gain: 0.5 }),
      part('comp', 'keys', comp, { gain: 0.5, pan: -0.2, send: 0.14 }),
      part('fills', 'tom', fills, { gain: 0.4, send: 0.1, min: 1 }),
      part('tune', 'clarinet', tune, { gain: 0.46, pan: 0.1, send: 0.2, min: 1, art: 0.86 }),
      part('vibes', 'vibes', tune, { gain: 0.34, pan: 0.25, send: 0.3, min: 2 }),
      part('ghosts', 'brushTap', grid('.o.o.o.o', { bars: 32, vel: 0.5 }), { gain: 0.5, pan: -0.25, min: 2 }),
      part('second', 'clarinet', harmonyBelow(tune, chords, 0.7), { gain: 0.3, pan: -0.3, send: 0.2, min: 3, art: 0.86 }),
      part('rim', 'rim', grid('..x...x.', { bars: 32, vel: 0.55 }), { gain: 0.45, pan: 0.1, send: 0.1, min: 3 }),
      part('tamb', 'tamb', grid('.x.x.x.x', { bars: 32, vel: 0.5 }), { gain: 0.4, pan: 0.35, min: 3 }),
      part('kicks', 'brass', kicks, { gain: 0.3, send: 0.2, min: 3 }),
    ],
  });
}

// ---- The Sno-Cone Truck ------------------------------------------------------
// The chime phrase loops on its own bus, which the engine pans and fades with the
// truck's position. Beneath it runs a lopsided carnival waltz. The accompaniment
// keeps walking through the chime's rest bar, and the harmony under the phrase shifts
// on each pass, so a fixed eight-note tune stays alive for a whole boss fight:
//   D-A, D-Em7, Bm-Em7, G D/F#-A, every pass landing on A7. The fourth pass slips to
//   D/F# on beat 3 of its first bar because the phrase holds F# there, which would
//   otherwise sit as an unprepared major seventh against G.

function truckTrack() {
  const beats = TRUCK_CHIME.beats;
  const chords = chart(`
    D | A | A7 | D | Em7 | A7 | Bm | Em7 | A7 | G:2 D/F#:1 | A | A7`.trim(), beats);

  const chime = [];
  const passBeats = beats * 3;
  for (let pass = 0; pass < 4; pass++) {
    let at = pass * passBeats;
    TRUCK_CHIME.notes.forEach((m, i) => {
      const d = TRUCK_CHIME.eighths[i] * 0.5;
      chime.push({ b: at, m, d, v: 0.8 });
      at += d;
    });
  }

  const oom = line(`
    D3/1 r/2 | A2/1 r/2 | A2/1 B2/1 C#3/1 |
    D3/1 r/2 | E3/1 r/2 | A2/1 B2/1 C#3/1 |
    B2/1 r/2 | E3/1 r/2 | A2/1 G2/1 F#2/1 |
    G2/1 r/1 F#2/1 | A2/1 r/2 | A2/1 B2/1 C#3/1 |`, { unit: 1, perBar: 3, vel: 0.85 });

  const voiced = voiceLead(chords, 57, 71);
  const pah = [];
  for (const bar of barRange(0, 12)) {
    for (const offset of [1, 2]) {
      const b = bar * beats + offset;
      for (const m of chordAt(voiced, b).voicing) pah.push({ b, m, d: 0.42, v: offset === 1 ? 0.6 : 0.5 });
    }
  }

  return compose({
    id: 'truck', title: 'The Sno-Cone Truck', key: 'D major', bpm: TRUCK_CHIME.bpm, beats, bars: 12, loop: true, gain: 0.7,
    chords, lead: ['chime'],
    parts: [
      part('chime', 'chime', chime, { gain: 0.86, send: 0.35, bus: 'chime' }),
      part('oom', 'tuba', oom, { gain: 0.31, send: 0.06, art: 0.7 }),
      part('pah', 'reed', pah, { gain: 0.4, pan: -0.2, send: 0.14 }),
      part('kick', 'kick', grid('x.....', { bars: 12, vel: 0.5 }), { gain: 0.7 }),
      part('tick', 'brushTap', grid('..x.x.', { bars: 12, vel: 0.5 }), { gain: 0.7, pan: 0.2 }),
      part('shaker', 'shaker', grid('oxoxox', { bars: 12, vel: 0.55 }), { gain: 0.5, pan: 0.3, min: 1 }),
      part('rim', 'rim', grid('..x.x.', { bars: 12, vel: 0.5 }), { gain: 0.42, pan: -0.1, min: 2 }),
      part('octave', 'tuba', oom.map((n) => ({ ...n, m: n.m - 12, v: 0.7 })), { gain: 0.21, art: 0.7, min: 2 }),
    ],
  });
}

// ---- Abominable Steve: "A Very Bad Day" --------------------------------------
// A trudging minor stomp for a big fellow who wants it all to stop. The tune is built
// on a sigh, the semitone lean Ab to G in bar 1, and the B section climbs into the
// relative major as if the day might improve before it sinks back down. When Steve
// loses his temper (level 2) the same tune gets a gallop, brass and an octave of brass
// doubling, so the fight changes gear with no change of key or tempo.

function steveTrack() {
  const beats = 4;
  const chords = chart(`
    Cm | Cm | Fm | G7 | Cm | Ab | Dm7b5:2 G7:2 | Cm |
    Ab | Eb/G | Fm | Bb7 | Eb | Ab | Fm7:2 G7:2 | Cm:2 G7:2`.trim(), beats);

  const tune = line(`
    G4/3 Ab4/1 G4/2 Eb4/2 | C4/4 r/2 D4/1 Eb4/1 | F4/3 G4/1 Ab4/2 F4/2 | D4/4 r/2 G3/1 B3/1 |
    G4/3 Ab4/1 G4/2 Eb4/2 | C5/3 Bb4/1 Ab4/2 Eb4/2 | F4/2 Ab4/2 G4/2 F4/1 D4/1 | Eb4/3 D4/1 C4/4 |
    Ab4/2 C5/2 Eb5/4 | Bb4/2 Eb5/2 G5/4 | F5/3 Eb5/1 C5/2 Ab4/2 | D5/4 r/2 F4/1 Ab4/1 |
    G4/2 Bb4/2 Eb5/4 | C5/3 Bb4/1 Ab4/4 | Ab4/2 C5/2 B4/2 D5/2 | C5/4 B4/2 D5/2 |`, { perBar: 8, vel: 0.8 });

  const stomp = line(`
    C2/3 r/1 G2/3 r/1 | C2/3 r/1 Eb2/2 E2/2 | F2/3 r/1 C3/3 r/1 | G2/3 r/1 D3/2 B2/2 |
    C2/3 r/1 G2/3 r/1 | Ab2/3 r/1 Eb2/3 r/1 | D2/3 r/1 G2/3 r/1 | C2/3 r/1 Eb2/2 G2/2 |
    Ab2/3 r/1 Eb2/3 r/1 | G2/3 r/1 Bb2/3 r/1 | F2/3 r/1 C3/3 r/1 | Bb2/3 r/1 F2/3 r/1 |
    Eb2/3 r/1 Bb2/3 r/1 | Ab2/3 r/1 C3/3 r/1 | F2/3 r/1 G2/3 r/1 | C2/3 r/1 G2/2 B1/2 |`, { perBar: 8, vel: 0.85 });

  const steps = [];
  const gallop = [];
  const stabs = [];
  const voiced = voiceLead(chords, 55, 70);
  for (const bar of barRange(0, 16)) {
    const start = bar * beats;
    for (const offset of [0, 2]) {
      const c = chordAt(chords, start + offset);
      steps.push({ b: start + offset, m: place(c.root, 41), d: 0.8, v: offset ? 0.6 : 0.8 });
    }
    // Long-short-short across each beat pair: the sound of a very large animal running.
    for (const eighth of [0, 2, 3, 4, 6, 7]) {
      const b = start + eighth * 0.5;
      gallop.push({ b, m: place(chordAt(chords, b).root, 45), d: 0.4, v: eighth % 4 === 0 ? 0.75 : 0.55 });
    }
    if (bar % 2 === 1) {
      const next = chordAt(voiced, (start + 3.5) % (16 * beats));
      for (const m of next.voicing) stabs.push({ b: start + 3.5, m, d: 0.45, v: 0.62 });
    }
  }

  const low = voiceLead(chords, 48, 64).flatMap((c) => c.voicing.map((m) => ({ b: c.b, m, d: c.d, v: 0.5 })));

  return compose({
    id: 'steve', title: 'A Very Bad Day', key: 'C minor', bpm: 100, beats, bars: 16, loop: true, gain: 0.8,
    chords, lead: ['tune'],
    parts: [
      part('stomp', 'tuba', stomp, { gain: 0.29, send: 0.08, art: 0.92 }),
      part('steps', 'timpani', steps, { gain: 0.46, send: 0.16 }),
      part('chuff', 'brushSwish', grid('..x...x.', { bars: 16, vel: 0.65 }), { gain: 0.44, pan: -0.1, send: 0.1 }),
      part('tune', 'bassoon', tune, { gain: 0.56, pan: 0.1, send: 0.24, art: 0.94 }),
      part('strings', 'pad', low, { gain: 0.1, send: 0.3, min: 1 }),
      part('gallop', 'upright', gallop, { gain: 0.6, pan: -0.15, min: 2, art: 0.7 }),
      part('stabs', 'brass', stabs, { gain: 0.34, send: 0.2, min: 2 }),
      part('horn', 'brass', tune.map((n) => ({ ...n, v: 0.66 })), { gain: 0.3, pan: 0.2, send: 0.24, min: 2, art: 0.9 }),
      part('rim', 'rim', grid('..x...x.', { bars: 16, vel: 0.5 }), { gain: 0.28, send: 0.1, min: 2 }),
    ],
  });
}

// ---- Stingers ------------------------------------------------------------------
// Win: the signature figure as a brass fanfare, ending on a 4-3-2-1 descent (C B A G)
// that lands the home chord under a cymbal and a sparkle of music box.

function winTrack() {
  const beats = 4;
  const chords = chart('G | G/B:2 C:2 | Am7:2 D7:2 | G | G', beats);
  const fanfare = line(`
    G4/1 B4/1 D5/1 G5/1 B5/3 A5/1 | G5/3 F#5/1 D5/2 E5/2 | G5/2 A5/2 C6/2 B5/1 A5/1 | G5/6 r/2 | r/8`, { perBar: 8, vel: 0.9 });
  const low = line(`
    G2/4 D3/4 | B2/4 C3/4 | A2/4 D3/4 | G2/8 | r/8`, { perBar: 8, vel: 0.85 });
  const held = voiceLead(chords, 55, 72).flatMap((c) => c.voicing.map((m) => ({ b: c.b, m, d: c.d, v: 0.6 })));
  const sparkle = line(`
    r/8 | r/8 | r/8 | r/1 G5/1 B5/1 D6/1 G6/2 D6/1 G6/1 | B6/4 r/4`, { perBar: 8, vel: 0.62 });
  return compose({
    id: 'win', title: 'Fort Holds', key: 'G major', bpm: 128, beats, bars: 5, loop: false, gain: 0.8,
    chords, lead: ['fanfare'],
    parts: [
      part('fanfare', 'brass', fanfare, { gain: 0.7, send: 0.3 }),
      part('second', 'brass', harmonyBelow(fanfare, chords, 0.7), { gain: 0.5, pan: -0.2, send: 0.3 }),
      part('box', 'musicBox', fanfare, { gain: 0.42, pan: 0.2, send: 0.4 }),
      part('low', 'tuba', low, { gain: 0.28, send: 0.1 }),
      part('held', 'pad', held, { gain: 0.11, send: 0.4 }),
      part('sparkle', 'musicBox', sparkle, { gain: 0.9, send: 0.6, pan: 0.2 }),
      part('timp', 'timpani', grid('x...x...x.x.x...x.xxX...........', { at: 0, vel: 0.6, m: 43 }), { gain: 0.42, send: 0.2 }),
      part('swell', 'cymbal', [{ b: 10, m: 0, d: 2, v: 0.5 }], { gain: 0.5, send: 0.3 }),
    ],
  });
}

// Lose: the same figure in the minor on a music box that is running down, with the
// tempo sagging toward the end. The last chord turns major: nobody got hurt, and
// there is always tomorrow's snow.
function loseTrack() {
  const beats = 3;
  const chords = chart('Gm | Cm7 | Cm | D7 | G', beats);
  const tune = line(`
    G5/3 F5/1 D5/2 | Eb5/4 Bb4/2 | C5/3 D5/1 Eb5/2 | D5/2 C5/2 A4/2 | G4+B4+D5/6`, { perBar: 6, vel: 0.72 });
  const low = line(`
    G2/6 | C3/6 | C3/3 Bb2/3 | A2/3 D3/3 | G2/6`, { perBar: 6, vel: 0.6 });
  const held = voiceLead(chords, 55, 70).flatMap((c) => c.voicing.map((m) => ({ b: c.b, m, d: c.d, v: 0.5 })));
  return compose({
    id: 'lose', title: 'Tomorrow\'s Snow', key: 'G minor', bpm: 76, beats, bars: 5, loop: false, gain: 0.9,
    rit: { from: 6, until: 13, slowest: 0.5 },
    chords, lead: ['tune'],
    parts: [
      part('tune', 'musicBox', tune, { gain: 0.6, send: 0.6 }),
      part('low', 'bassoon', low, { gain: 0.3, send: 0.3, art: 0.96 }),
      part('held', 'pad', held, { gain: 0.1, send: 0.5 }),
    ],
  });
}

export const TRACKS = Object.freeze({
  menu: menuTrack(),
  build: buildTrack(),
  fight: fightTrack(),
  truck: truckTrack(),
  steve: steveTrack(),
  win: winTrack(),
  lose: loseTrack(),
});

export const TRACK_IDS = Object.freeze(Object.keys(TRACKS));
