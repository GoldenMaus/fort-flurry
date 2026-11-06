// Fort Flurry — building blocks for sound effects. A Patch is one voice under
// construction: recipes call tone/noise/throat, and the Patch keeps count of when the
// last source stops, which is how the engine knows when to release the voice.

const QUIET = 0.0001;

function envelope(param, t, { a, hold, d, g }) {
  param.setValueAtTime(0, t);
  param.linearRampToValueAtTime(g, t + a);
  if (hold > 0) param.setValueAtTime(g, t + a + hold);
  param.exponentialRampToValueAtTime(QUIET, t + a + hold + d);
  return t + a + hold + d;
}

// Exponential motion through [[seconds, value], ...]: pitch and filter sweeps are heard
// logarithmically, so a linear ramp would seem to rush at the start and then stall.
function sweep(param, t, path) {
  param.setValueAtTime(path[0][1], t + path[0][0]);
  for (let i = 1; i < path.length; i++) param.exponentialRampToValueAtTime(path[i][1], t + path[i][0]);
}

export class Patch {
  constructor(ctx, kit, out, t) {
    this.ctx = ctx;
    this.kit = kit;
    this.out = out;
    this.t = t;
    this.end = t;
    this.sources = [];
  }

  _track(source, start, stop, offset) {
    if (offset === undefined) source.start(start);
    else source.start(start, offset);
    source.stop(stop);
    this.sources.push(source);
    if (stop > this.end) this.end = stop;
  }

  /** Slow wobble on any param. Stops itself at `stop`. */
  wobble(param, rate, depth, at, stop) {
    const lfo = this.ctx.createOscillator();
    lfo.frequency.value = rate;
    const amount = this.ctx.createGain();
    amount.gain.value = depth;
    lfo.connect(amount).connect(param);
    this._track(lfo, at, stop);
  }

  /**
   * One oscillator. Pitch is `f`, or `f` gliding to `to` across the note, or an explicit
   * `path` of [[seconds, hz], ...]. Returns its gain so recipes can add a wobble.
   */
  tone({ type = 'sine', wave = null, f, to = null, path = null, at = 0, a = 0.003, hold = 0, d = 0.1, g = 0.3, vib = null, dest = this.out }) {
    const t = this.t + at;
    const osc = this.ctx.createOscillator();
    if (wave) osc.setPeriodicWave(this.kit.wave(wave));
    else osc.type = type;
    if (path) sweep(osc.frequency, t, path);
    else if (to) sweep(osc.frequency, t, [[0, f], [a + hold + d, to]]);
    else osc.frequency.value = f;
    const amp = this.ctx.createGain();
    amp.gain.value = 0;
    const stop = envelope(amp.gain, t, { a, hold, d, g }) + 0.01;
    osc.connect(amp).connect(dest);
    if (vib) this.wobble(osc.detune, vib.rate, vib.cents, t, stop);
    this._track(osc, t, stop);
    return amp;
  }

  /**
   * Filtered noise. Give `lp`, `hp` or `bp` for the filter frequency, or `path` with a
   * `kind` for a sweep. Every snow sound in the game starts here.
   */
  noise({ color = 'white', at = 0, a = 0.002, hold = 0, d = 0.1, g = 0.3, lp, hp, bp, path = null, kind = 'bandpass', q = 0.8, dest = this.out }) {
    const t = this.t + at;
    const source = this.ctx.createBufferSource();
    source.buffer = this.kit.noise[color];
    source.loop = true;
    const filter = this.ctx.createBiquadFilter();
    filter.type = lp ? 'lowpass' : hp ? 'highpass' : bp ? 'bandpass' : kind;
    filter.Q.value = q;
    if (path) sweep(filter.frequency, t, path);
    else filter.frequency.value = lp ?? hp ?? bp;
    const amp = this.ctx.createGain();
    amp.gain.value = 0;
    const stop = envelope(amp.gain, t, { a, hold, d, g }) + 0.01;
    source.connect(filter).connect(amp).connect(dest);
    this._track(source, t, stop, Math.random() * 1.5);
    return amp;
  }

  /**
   * A vocal tract in miniature: a buzzy source through parallel resonances, each
   * `[hz, q, level]` or `[[seconds, hz]..., q, level]` for a moving vowel. This one
   * voice gives the Colonel's harrumph, the kazoo, Steve and the crowd.
   */
  throat({ type = 'sawtooth', f, to = null, path = null, at = 0, a = 0.02, hold = 0, d = 0.2, g = 0.3, formants, vib = null, dest = this.out }) {
    const t = this.t + at;
    const osc = this.ctx.createOscillator();
    osc.type = type;
    if (path) sweep(osc.frequency, t, path);
    else if (to) sweep(osc.frequency, t, [[0, f], [a + hold + d, to]]);
    else osc.frequency.value = f;
    const amp = this.ctx.createGain();
    amp.gain.value = 0;
    const stop = envelope(amp.gain, t, { a, hold, d, g }) + 0.01;
    for (const [frequency, q, level] of formants) {
      const filter = this.ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.Q.value = q;
      if (Array.isArray(frequency)) sweep(filter.frequency, t, frequency);
      else filter.frequency.value = frequency;
      const mix = this.ctx.createGain();
      mix.gain.value = level;
      osc.connect(filter).connect(mix).connect(amp);
    }
    amp.connect(dest);
    if (vib) this.wobble(osc.detune, vib.rate, vib.cents, t, stop);
    this._track(osc, t, stop);
    return amp;
  }

  /** A soft struck bell: two partials, the upper one fading first. */
  ding(f, { at = 0, d = 0.4, g = 0.1, shine = 0.2 } = {}) {
    this.tone({ f, at, a: 0.002, d, g });
    if (shine) this.tone({ f: f * 2.76, at, a: 0.001, d: d * 0.35, g: g * shine });
  }
}
