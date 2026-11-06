// Fort Flurry — renders sounds and music faster than real time through the real mixer,
// and measures the result. Only the soundboard and the test scripts load this: it is
// how anyone can check levels and silence without listening.

import { Conductor } from './conductor.js';
import { createMixer } from './mixer.js';
import { startVoice } from './sfx.js';
import { TRACKS } from './tracks.js';

const RATE = 48000;

function offlineContext(seconds) {
  return new OfflineAudioContext(2, Math.ceil(seconds * RATE), RATE);
}

/** Renders one sound effect, with room after it for the reverb to die away. */
export async function renderSound(name, options = {}, { seconds = 4 } = {}) {
  const ctx = offlineContext(seconds);
  const mix = createMixer(ctx);
  const voice = startVoice(mix, name, options, 0.02);
  const buffer = await ctx.startRendering();
  return { buffer, voice, length: voice.end - 0.02 };
}

/** Renders `seconds` of a track at a fixed intensity level, muting any parts in `mute`. */
export async function renderTrack(id, { seconds, level = 0, only = null, mute = null } = {}) {
  const track = TRACKS[id];
  const length = seconds ?? track.clock(track.loopBeats) + (track.loop ? 0 : 3);
  const ctx = offlineContext(length);
  const mix = createMixer(ctx);
  const conductor = new Conductor(mix);
  conductor.setLevel(level);
  conductor.play(id, 0.02, 0);
  if (only || mute) {
    for (const [part, bus] of conductor.active.buses) {
      const silent = only ? !only.includes(part.id) : mute.includes(part.id);
      if (silent) bus.input.gain.value = 0;
    }
  }
  // Scheduling the whole render at once is what the lookahead does in small steps.
  conductor.active.pump(length, 0);
  const buffer = await ctx.startRendering();
  return { buffer, notes: conductor.stats.notes, length };
}

/** Level figures for a rendered buffer, both channels. */
export function measure(buffer) {
  const left = buffer.getChannelData(0);
  const right = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : left;
  const n = left.length;
  let peak = 0;
  let sum = 0;
  let offset = 0;
  let first = -1;
  let last = -1;
  let jump = 0;
  for (let i = 0; i < n; i++) {
    const l = left[i];
    const r = right[i];
    const magnitude = Math.max(Math.abs(l), Math.abs(r));
    if (magnitude > peak) peak = magnitude;
    sum += l * l + r * r;
    offset += l + r;
    if (magnitude > 0.001) {
      if (first < 0) first = i;
      last = i;
    }
    if (i) {
      const d = Math.max(Math.abs(l - left[i - 1]), Math.abs(r - right[i - 1]));
      if (d > jump) jump = d;
    }
  }
  const rms = Math.sqrt(sum / (2 * n));
  const db = (v) => (v > 0 ? 20 * Math.log10(v) : -Infinity);
  return {
    peak,
    peakDb: db(peak),
    rms,
    rmsDb: db(rms),
    dc: offset / (2 * n),
    // The biggest sample-to-sample step: a click shows up here long before it can be
    // seen on a waveform.
    jump,
    audibleFrom: first / buffer.sampleRate,
    audibleTo: last / buffer.sampleRate,
  };
}

// Radix-2 FFT, so the board can check for harsh highs without any library.
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const step = (-2 * Math.PI) / size;
    for (let start = 0; start < n; start += size) {
      for (let k = 0; k < size / 2; k++) {
        const wr = Math.cos(step * k);
        const wi = Math.sin(step * k);
        const a = start + k;
        const b = a + size / 2;
        const tr = re[b] * wr - im[b] * wi;
        const ti = re[b] * wi + im[b] * wr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
      }
    }
  }
}

/** Where a buffer's energy sits: share in each band, plus the spectral centroid. */
export function spectrum(buffer, { from = 0, to = Infinity } = {}) {
  const size = 4096;
  const data = buffer.getChannelData(0);
  const rate = buffer.sampleRate;
  const begin = Math.floor(from * rate);
  const end = Math.min(data.length, to * rate);
  const totals = new Float64Array(size / 2);
  const window = Float64Array.from({ length: size }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size));
  const hop = Math.max(size, Math.floor((end - begin) / 400));
  for (let at = begin; at + size <= end; at += hop) {
    const re = new Float64Array(size);
    const im = new Float64Array(size);
    for (let i = 0; i < size; i++) re[i] = data[at + i] * window[i];
    fft(re, im);
    for (let i = 0; i < size / 2; i++) totals[i] += re[i] * re[i] + im[i] * im[i];
  }
  let energy = 0;
  let weighted = 0;
  let high = 0;
  let low = 0;
  for (let i = 1; i < size / 2; i++) {
    const hz = (i * rate) / size;
    energy += totals[i];
    weighted += totals[i] * hz;
    if (hz >= 6000) high += totals[i];
    if (hz < 150) low += totals[i];
  }
  if (!energy) return { centroid: 0, above6k: 0, below150: 0 };
  return { centroid: weighted / energy, above6k: high / energy, below150: low / energy };
}
