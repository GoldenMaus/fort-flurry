// Fort Flurry — reads the score back as text and checks it as a harmony exercise.
// Used by the soundboard and by Node, because nobody can listen to a test run. It
// classifies every melody note against the chord beneath it, the way a theory
// teacher would mark a page.

import { chordAt, noteName } from './notation.js';

const eq = (a, b) => Math.abs(a - b) < 1e-6;

const UNPITCHED = new Set(['brushTap', 'brushSwish', 'kick', 'rim', 'tamb', 'shaker', 'woodblock', 'tom', 'cymbal', 'timpani']);

function leadNotes(track) {
  return track.parts.filter((p) => track.lead.includes(p.id)).flatMap((p) => p.notes).sort((a, b) => a.b - b.b || b.m - a.m);
}

function pcOf(midi) {
  return ((midi % 12) + 12) % 12;
}

// Strong beats are where a wrong note is heard as wrong rather than as decoration.
function isStrong(beat, beats) {
  const inBar = ((beat % beats) + beats) % beats;
  if (eq(inBar, 0)) return true;
  return beats === 4 && eq(inBar, 2);
}

/**
 * Marks each melody note as chord tone ("chord"), or as a recognised decoration:
 * passing (step in, step on, same direction), neighbour (step away and back),
 * appoggiatura/suspension (dissonant on the beat, resolved by step), anticipation
 * (lands on a tone of the next chord) or short decoration on a weak beat. Anything
 * else is reported as "exposed": a dissonance with no melodic explanation.
 */
export function harmonyReport(track) {
  const notes = leadNotes(track);
  const rows = notes.map((note, i) => {
    const chord = chordAt(track.chords, note.b);
    const prev = notes[i - 1];
    const next = notes[i + 1];
    const pc = pcOf(note.m);
    const inChord = chord.pcs.includes(pc);
    let kind = 'chord';
    if (!inChord) {
      const inStep = prev ? Math.abs(note.m - prev.m) <= 2 && note.m !== prev.m : false;
      const outStep = next ? Math.abs(next.m - note.m) <= 2 && next.m !== note.m : false;
      const sameWay = prev && next ? Math.sign(note.m - prev.m) === Math.sign(next.m - note.m) : false;
      const nextChord = next ? chordAt(track.chords, next.b) : null;
      const anticipates = chordAt(track.chords, note.b + note.d).pcs.includes(pc);
      if (inStep && outStep && sameWay) kind = 'passing';
      else if (inStep && outStep) kind = 'neighbour';
      else if (outStep && nextChord?.pcs.includes(pcOf(next.m))) kind = 'appoggiatura';
      else if (anticipates) kind = 'anticipation';
      else if (!isStrong(note.b, track.beats) && note.d <= 0.5) kind = 'weak-decoration';
      else kind = 'exposed';
    }
    return { bar: Math.floor(note.b / track.beats) + 1, beat: note.b, name: noteName(note.m), midi: note.m, d: note.d, chord: chord.symbol, kind, strong: isStrong(note.b, track.beats) };
  });
  const counts = {};
  for (const r of rows) counts[r.kind] = (counts[r.kind] ?? 0) + 1;
  const strongTotal = rows.filter((r) => r.strong).length;
  const strongChord = rows.filter((r) => r.strong && r.kind === 'chord').length;
  return {
    rows,
    counts,
    total: rows.length,
    strongChordTones: strongTotal ? strongChord / strongTotal : 1,
    exposed: rows.filter((r) => r.kind === 'exposed'),
    range: [Math.min(...rows.map((r) => r.midi)), Math.max(...rows.map((r) => r.midi))],
    maxLeap: rows.reduce((max, r, i) => (i ? Math.max(max, Math.abs(r.midi - rows[i - 1].midi)) : 0), 0),
  };
}

/** Clashes between the accompaniment parts and the chord chart, per part. */
export function accompanimentReport(track) {
  const out = {};
  for (const p of track.parts) {
    if (track.lead.includes(p.id)) continue;
    if (UNPITCHED.has(p.inst)) continue;
    const pitched = p.notes;
    if (!pitched.length) continue;
    const outside = pitched.filter((n) => !chordAt(track.chords, n.b).pcs.includes(pcOf(n.m)));
    out[p.id] = { notes: pitched.length, outside: outside.length, share: outside.length / pitched.length };
  }
  return out;
}

/**
 * The vertical check. Chord symbols can agree while the actual notes rub: this looks at
 * every pitched note sounding under a lead note on a strong beat, and reports semitone
 * clashes (minor seconds, major sevenths, minor ninths), the intervals an ear can't
 * forgive. Parts above a given intensity level are included, since all can play at once.
 */
export function clashReport(track) {
  const leads = leadNotes(track);
  const under = track.parts.filter((p) => !track.lead.includes(p.id) && !UNPITCHED.has(p.inst));
  const clashes = [];
  let checked = 0;
  for (const lead of leads) {
    if (!isStrong(lead.b, track.beats)) continue;
    for (const part of under) {
      for (const n of part.notes) {
        if (n.b > lead.b + 1e-6 || n.b + n.d <= lead.b + 1e-6) continue;
        checked++;
        const gap = Math.abs(pcOf(lead.m) - pcOf(n.m));
        if (gap === 1 || gap === 11) {
          clashes.push({ bar: Math.floor(lead.b / track.beats) + 1, lead: noteName(lead.m), against: noteName(n.m), part: part.id, chord: chordAt(track.chords, lead.b).symbol });
        }
      }
    }
  }
  return { checked, clashes };
}

/** One line per bar: chords and the lead's note names with lengths. */
export function printScore(track) {
  const notes = leadNotes(track);
  const lines = [];
  for (let bar = 0; bar < track.bars; bar++) {
    const start = bar * track.beats;
    const inBar = (b) => b >= start - 1e-6 && b < start + track.beats - 1e-6;
    const chords = track.chords.filter((c) => inBar(c.b)).map((c) => c.symbol).join(' ') || chordAt(track.chords, start).symbol;
    const tune = notes.filter((n) => inBar(n.b)).map((n) => `${noteName(n.m)}/${n.d * 2}`).join(' ');
    lines.push(`${String(bar + 1).padStart(3)}  ${chords.padEnd(16)} ${tune}`);
  }
  return lines.join('\n');
}
