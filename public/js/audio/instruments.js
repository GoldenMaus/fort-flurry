// Fort Flurry — the band. Each instrument schedules one note on any BaseAudioContext.
// Signature: (kit, out, t, midi, seconds, velocity). Nothing here keeps a reference
// after scheduling: sources stop themselves, and an unreferenced finished node is
// collected, so the conductor can fire a note and forget it.

function hz(midi) {
  return 440 * 2 ** ((midi - 69) / 12);
}

const QUIET = 0.0001;

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function struck(param, t, peak, attack, decay) {
  param.setValueAtTime(0, t);
  param.linearRampToValueAtTime(peak, t + attack);
  param.exponentialRampToValueAtTime(QUIET, t + attack + decay);
}

function held(param, t, peak, attack, seconds, release) {
  const off = t + Math.max(attack, seconds);
  param.setValueAtTime(0, t);
  param.linearRampToValueAtTime(peak, t + attack);
  param.setValueAtTime(peak, off);
  param.linearRampToValueAtTime(0, off + release);
}

const BUILT_IN = new Set(['sine', 'triangle', 'sawtooth', 'square']);

function oscillator(kit, source, frequency) {
  const osc = kit.ctx.createOscillator();
  if (BUILT_IN.has(source)) osc.type = source;
  else osc.setPeriodicWave(kit.wave(source));
  osc.frequency.value = frequency;
  return osc;
}

function gainNode(kit) {
  const g = kit.ctx.createGain();
  g.gain.value = 0;
  return g;
}

// Every note unplugs itself when its source ends. A finished note left wired in is still
// visited by the audio thread on every render quantum until garbage collection reaches
// it, which over a long match took the music from 3% of a core to 9%, then back down in
// one lump at a major GC. `tail` is whatever joins this note to the mix.
function run(source, t, stop, tail) {
  source.onended = () => tail.disconnect();
  source.start(t);
  source.stop(stop);
}

function noiseSource(kit, color) {
  const source = kit.ctx.createBufferSource();
  source.buffer = kit.noise[color];
  source.loop = true;
  return source;
}

function runNoise(source, t, stop, tail) {
  source.onended = () => tail.disconnect();
  source.start(t, Math.random() * 1.5);
  source.stop(stop);
}

// Slow vibrato that fades in, because a held reed note with instant vibrato sounds
// like a toy. Stops with the note.
function vibrato(kit, osc, t, seconds, rate, cents) {
  if (seconds < 0.3) return;
  const lfo = kit.ctx.createOscillator();
  lfo.frequency.value = rate;
  const depth = kit.ctx.createGain();
  depth.gain.setValueAtTime(0, t);
  depth.gain.setValueAtTime(0, t + 0.16);
  depth.gain.linearRampToValueAtTime(cents, t + 0.42);
  lfo.connect(depth).connect(osc.detune);
  run(lfo, t, t + seconds + 0.1, depth);
}

// ---- Bells and mallets --------------------------------------------------------

function tine(kit, out, t, midi, v, cents) {
  const f = hz(midi);
  // Low tines ring for seconds, high ones are gone almost at once, as on the real comb.
  const ring = clamp(3.6 - (midi - 60) * 0.075, 0.9, 3.6);
  const body = oscillator(kit, 'tine', f);
  body.detune.value = cents;
  const bodyGain = gainNode(kit);
  struck(bodyGain.gain, t, v * 0.5, 0.002, ring);
  body.connect(bodyGain).connect(out);
  run(body, t, t + ring + 0.02, bodyGain);

  // The ping of the pin leaving the tine. Kept under about 7 kHz and very short: it
  // gives the note its edge without any of the sting.
  const ratio = f * 6.02 < 7000 ? 6.02 : 3.01;
  const ping = oscillator(kit, 'sine', f * ratio);
  ping.detune.value = cents;
  const pingGain = gainNode(kit);
  struck(pingGain.gain, t, v * 0.045, 0.001, 0.07);
  ping.connect(pingGain).connect(out);
  run(ping, t, t + 0.08, pingGain);
}

function musicBox(kit, out, t, midi, seconds, v) {
  tine(kit, out, t, midi, v, 0);
}

// The Truck's voice: the same comb with a pair of tines a little out of tune with each
// other, the slow beating that makes a jingle sound like it has seen things.
function chime(kit, out, t, midi, seconds, v) {
  tine(kit, out, t, midi, v * 0.72, -9);
  tine(kit, out, t, midi, v * 0.72, 8);
}

function bell(kit, out, t, midi, seconds, v) {
  const f = hz(midi);
  const ring = clamp(1.7 - (midi - 60) * 0.03, 0.7, 1.7);
  const body = oscillator(kit, 'sine', f);
  const bodyGain = gainNode(kit);
  struck(bodyGain.gain, t, v * 0.5, 0.003, ring);
  body.connect(bodyGain).connect(out);
  run(body, t, t + ring + 0.02, bodyGain);
  const shine = oscillator(kit, 'sine', f * 3);
  const shineGain = gainNode(kit);
  struck(shineGain.gain, t, v * 0.09, 0.002, ring * 0.3);
  shine.connect(shineGain).connect(out);
  run(shine, t, t + ring * 0.3 + 0.02, shineGain);
}

function vibes(kit, out, t, midi, seconds, v) {
  const f = hz(midi);
  const ring = clamp(1.1 - (midi - 60) * 0.012, 0.5, 1.1);
  const body = oscillator(kit, 'sine', f);
  const bodyGain = gainNode(kit);
  struck(bodyGain.gain, t, v * 0.5, 0.003, ring);
  body.connect(bodyGain).connect(out);
  run(body, t, t + ring + 0.02, bodyGain);
  const bar = oscillator(kit, 'sine', f * 4);
  const barGain = gainNode(kit);
  struck(barGain.gain, t, v * 0.07, 0.001, 0.09);
  bar.connect(barGain).connect(out);
  run(bar, t, t + 0.11, barGain);
}

function mallet(kit, out, t, midi, seconds, v) {
  const f = hz(midi);
  const ring = clamp(0.55 - (midi - 60) * 0.008, 0.18, 0.55);
  const body = oscillator(kit, 'sine', f);
  const bodyGain = gainNode(kit);
  struck(bodyGain.gain, t, v * 0.6, 0.003, ring);
  body.connect(bodyGain).connect(out);
  run(body, t, t + ring + 0.02, bodyGain);
  // Marimba bars are tuned so the first overtone sits two octaves up.
  const knock = oscillator(kit, 'sine', f * 4);
  const knockGain = gainNode(kit);
  struck(knockGain.gain, t, v * 0.11, 0.001, 0.05);
  knock.connect(knockGain).connect(out);
  run(knock, t, t + 0.07, knockGain);
}

// ---- Plucked ------------------------------------------------------------------

function plucked(kit, out, t, frequency, v, { source, decay, open, close, peak, attack = 0.003 }) {
  const osc = oscillator(kit, source, frequency);
  const filter = kit.ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.Q.value = 0.7;
  filter.frequency.setValueAtTime(open, t);
  filter.frequency.exponentialRampToValueAtTime(close, t + decay * 0.6);
  const g = gainNode(kit);
  struck(g.gain, t, v * peak, attack, decay);
  osc.connect(filter).connect(g).connect(out);
  run(osc, t, t + decay + 0.02, g);
}

function pizz(kit, out, t, midi, seconds, v) {
  const f = hz(midi);
  // A raw saw edge at the attack reads as a click, so the filter starts half closed.
  plucked(kit, out, t, f, v, { source: 'sawtooth', decay: clamp(0.38 - (midi - 60) * 0.004, 0.2, 0.38), open: Math.min(2800, f * 3.2), close: f * 1.6, peak: 0.85, attack: 0.006 });
}

function pluckBass(kit, out, t, midi, seconds, v) {
  const f = hz(midi);
  plucked(kit, out, t, f, v, { source: 'upright', decay: 0.42, open: Math.min(2200, f * 9), close: f * 2.5, peak: 0.66 });
}

// Walking bass: the pitch sags slightly after each attack, which is most of what makes
// a synthetic bass feel like it bounces. Upper harmonics carry the line on small speakers.
function upright(kit, out, t, midi, seconds, v) {
  const f = hz(midi);
  const decay = clamp(seconds * 1.4, 0.2, 0.7);
  const osc = oscillator(kit, 'upright', f);
  osc.detune.setValueAtTime(34, t);
  osc.detune.exponentialRampToValueAtTime(1, t + 0.05);
  const filter = kit.ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.Q.value = 0.9;
  filter.frequency.setValueAtTime(1500, t);
  filter.frequency.exponentialRampToValueAtTime(420, t + decay);
  const g = gainNode(kit);
  struck(g.gain, t, v * 0.8, 0.004, decay);
  osc.connect(filter).connect(g).connect(out);
  run(osc, t, t + decay + 0.02, g);
}

// Short muted electric-piano stabs for comping.
function keys(kit, out, t, midi, seconds, v) {
  const f = hz(midi);
  const body = oscillator(kit, 'warm', f);
  const g = gainNode(kit);
  struck(g.gain, t, v * 0.5, 0.004, 0.3);
  body.connect(g).connect(out);
  run(body, t, t + 0.32, g);
}

// ---- Sustained ----------------------------------------------------------------

function pad(kit, out, t, midi, seconds, v) {
  const f = hz(midi);
  const attack = Math.min(0.5, seconds * 0.35);
  const release = 0.7;
  const g = gainNode(kit);
  held(g.gain, t, v * 0.42, attack, seconds, release);
  g.connect(out);
  for (const cents of [-5, 6]) {
    const osc = oscillator(kit, 'warm', f);
    osc.detune.value = cents;
    osc.connect(g);
    run(osc, t, t + seconds + release + 0.02, g);
  }
}

function woodwind(kit, out, t, midi, seconds, v, { wave, attack, release, peak, cutoff, rate, cents }) {
  const osc = oscillator(kit, wave, hz(midi));
  vibrato(kit, osc, t, seconds, rate, cents);
  const filter = kit.ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.Q.value = 0.5;
  filter.frequency.value = cutoff;
  const g = gainNode(kit);
  held(g.gain, t, v * peak, attack, seconds, release);
  osc.connect(filter).connect(g).connect(out);
  run(osc, t, t + Math.max(attack, seconds) + release + 0.02, g);
}

function clarinet(kit, out, t, midi, seconds, v) {
  woodwind(kit, out, t, midi, seconds, v, { wave: 'clarinet', attack: 0.018, release: 0.05, peak: 0.55, cutoff: 3000, rate: 5.2, cents: 7 });
}

function bassoon(kit, out, t, midi, seconds, v) {
  woodwind(kit, out, t, midi, seconds, v, { wave: 'bassoon', attack: 0.03, release: 0.08, peak: 0.55, cutoff: 1500, rate: 4.6, cents: 10 });
}

function reed(kit, out, t, midi, seconds, v) {
  const release = 0.04;
  const g = gainNode(kit);
  held(g.gain, t, v * 0.32, 0.012, seconds, release);
  const filter = kit.ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = 1900;
  filter.Q.value = 0.4;
  filter.connect(g).connect(out);
  // Two reeds tuned apart: the shimmer of a squeezebox, and it keeps the waltz silly.
  for (const cents of [-6, 7]) {
    const osc = oscillator(kit, 'reed', hz(midi));
    osc.detune.value = cents;
    osc.connect(filter);
    run(osc, t, t + seconds + release + 0.02, g);
  }
}

function tuba(kit, out, t, midi, seconds, v) {
  const osc = oscillator(kit, 'tuba', hz(midi));
  // Brass speaks from slightly under the note.
  osc.detune.setValueAtTime(-38, t);
  osc.detune.linearRampToValueAtTime(0, t + 0.06);
  const filter = kit.ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.Q.value = 0.4;
  filter.frequency.setValueAtTime(420, t);
  filter.frequency.linearRampToValueAtTime(760, t + 0.05);
  filter.frequency.linearRampToValueAtTime(520, t + Math.max(0.08, seconds));
  const g = gainNode(kit);
  held(g.gain, t, v * 0.72, 0.024, seconds, 0.07);
  osc.connect(filter).connect(g).connect(out);
  run(osc, t, t + Math.max(0.024, seconds) + 0.09, g);
}

function brass(kit, out, t, midi, seconds, v) {
  const f = hz(midi);
  const release = 0.09;
  const filter = kit.ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.Q.value = 0.8;
  // The filter opening is the "blat" at the front of a brass note.
  filter.frequency.setValueAtTime(Math.min(900, f * 2), t);
  filter.frequency.linearRampToValueAtTime(Math.min(3000, f * 6), t + 0.05);
  filter.frequency.linearRampToValueAtTime(Math.min(2100, f * 4), t + Math.max(0.1, seconds));
  const g = gainNode(kit);
  held(g.gain, t, v * 0.3, 0.02, seconds, release);
  filter.connect(g).connect(out);
  for (const cents of [-5, 5]) {
    const osc = oscillator(kit, 'sawtooth', f);
    osc.detune.value = cents;
    osc.connect(filter);
    run(osc, t, t + Math.max(0.02, seconds) + release + 0.02, g);
  }
}

// ---- Percussion ---------------------------------------------------------------
// Unpitched voices ignore `midi`, apart from the timpani and tom, which sit on a note.

function hit(kit, out, t, v, { color = 'pink', type, frequency, q = 0.7, attack = 0.001, decay, peak }) {
  const source = noiseSource(kit, color);
  const filter = kit.ctx.createBiquadFilter();
  filter.type = type;
  filter.frequency.value = frequency;
  filter.Q.value = q;
  const g = gainNode(kit);
  struck(g.gain, t, v * peak, attack, decay);
  source.connect(filter).connect(g).connect(out);
  runNoise(source, t, t + attack + decay + 0.02, g);
}

function kick(kit, out, t, midi, seconds, v) {
  const osc = oscillator(kit, 'sine', 118);
  osc.frequency.setValueAtTime(118, t);
  osc.frequency.exponentialRampToValueAtTime(48, t + 0.09);
  const g = gainNode(kit);
  struck(g.gain, t, v * 0.9, 0.002, 0.2);
  osc.connect(g).connect(out);
  run(osc, t, t + 0.22, g);
}

function brushTap(kit, out, t, midi, seconds, v) {
  hit(kit, out, t, v, { color: 'white', type: 'bandpass', frequency: 5000, q: 0.6, decay: 0.05, peak: 1 });
}

function brushSwish(kit, out, t, midi, seconds, v) {
  hit(kit, out, t, v, { color: 'white', type: 'bandpass', frequency: 3000, q: 0.5, attack: 0.022, decay: 0.16, peak: 1 });
}

function rim(kit, out, t, midi, seconds, v) {
  const osc = oscillator(kit, 'triangle', 1560);
  const g = gainNode(kit);
  struck(g.gain, t, v * 0.3, 0.001, 0.03);
  osc.connect(g).connect(out);
  run(osc, t, t + 0.05, g);
  hit(kit, out, t, v, { color: 'white', type: 'bandpass', frequency: 2300, q: 1, decay: 0.03, peak: 0.7 });
}

function tamb(kit, out, t, midi, seconds, v) {
  hit(kit, out, t, v, { color: 'white', type: 'bandpass', frequency: 6000, q: 1.2, attack: 0.002, decay: 0.05, peak: 1 });
}

function shaker(kit, out, t, midi, seconds, v) {
  hit(kit, out, t, v, { color: 'white', type: 'bandpass', frequency: 4600, q: 0.7, attack: 0.012, decay: 0.05, peak: 1 });
}

function woodblock(kit, out, t, midi, seconds, v) {
  const f = hz(midi);
  const osc = oscillator(kit, 'sine', f);
  const g = gainNode(kit);
  struck(g.gain, t, v * 0.5, 0.001, 0.06);
  osc.connect(g).connect(out);
  run(osc, t, t + 0.08, g);
  const upper = oscillator(kit, 'sine', f * 2.3);
  const upperGain = gainNode(kit);
  struck(upperGain.gain, t, v * 0.16, 0.001, 0.03);
  upper.connect(upperGain).connect(out);
  run(upper, t, t + 0.05, upperGain);
}

function drumTone(kit, out, t, frequency, v, { fall, decay, peak, slap }) {
  const osc = oscillator(kit, 'sine', frequency);
  osc.frequency.setValueAtTime(frequency * fall, t);
  osc.frequency.exponentialRampToValueAtTime(frequency, t + 0.05);
  const g = gainNode(kit);
  struck(g.gain, t, v * peak, 0.003, decay);
  osc.connect(g).connect(out);
  run(osc, t, t + decay + 0.02, g);
  hit(kit, out, t, v, { type: 'lowpass', frequency: 900, q: 0.5, decay: 0.05, peak: slap });
}

function timpani(kit, out, t, midi, seconds, v) {
  drumTone(kit, out, t, hz(midi), v, { fall: 1.18, decay: 0.75, peak: 0.85, slap: 0.3 });
}

function tom(kit, out, t, midi, seconds, v) {
  drumTone(kit, out, t, hz(midi), v, { fall: 1.3, decay: 0.2, peak: 0.7, slap: 0.35 });
}

// Soft swell that peaks on the downbeat after the note, for sweeping into a final chord.
function cymbal(kit, out, t, midi, seconds, v) {
  const source = noiseSource(kit, 'white');
  const filter = kit.ctx.createBiquadFilter();
  filter.type = 'bandpass';
  filter.frequency.value = 5200;
  filter.Q.value = 0.4;
  const g = gainNode(kit);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(v * 0.1, t + seconds * 0.55);
  g.gain.exponentialRampToValueAtTime(v * 0.7, t + seconds);
  g.gain.exponentialRampToValueAtTime(QUIET, t + seconds + 1.6);
  source.connect(filter).connect(g).connect(out);
  runNoise(source, t, t + seconds + 1.65, g);
}

export const INSTRUMENTS = Object.freeze({
  musicBox, chime, bell, vibes, mallet, pizz, pluckBass, upright, keys, pad, clarinet, bassoon, reed, tuba, brass,
  kick, brushTap, brushSwish, rim, tamb, shaker, woodblock, timpani, tom, cymbal,
});
