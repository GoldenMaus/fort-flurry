// Fort Flurry — the audio graph shared by the live engine and offline renders.
// Everything takes a BaseAudioContext, so a test renders through exactly the chain
// players hear instead of a lookalike.
//
//   music ----> duck ----+
//   sfx -----------------+-> master -> high-pass -> shelf -> limiter -> trim -> clip -> out
//   musicWet -> wetDuck -+
//   sfxWet --> reverb ---/

const WAVES = {
  // Harmonic amplitudes for the sustained music voices. Few strong upper partials:
  // these are meant to sit under gameplay all match without tiring anyone's ears.
  tine: [1, 0.16, 0.09, 0.03],
  warm: [1, 0.38, 0.17, 0.07, 0.03],
  upright: [1, 0.62, 0.36, 0.22, 0.12, 0.07, 0.03],
  tuba: [1, 0.85, 0.55, 0.32, 0.18, 0.09, 0.04],
  bassoon: [0.55, 1, 0.92, 0.66, 0.46, 0.3, 0.18, 0.1, 0.05],
  // Near-silent even harmonics are what make a clarinet sound hollow.
  clarinet: [1, 0.03, 0.52, 0.03, 0.28, 0.02, 0.14, 0.02, 0.07, 0.01, 0.03],
  reed: [1, 0.72, 0.55, 0.46, 0.36, 0.28, 0.2, 0.14, 0.09, 0.05],
};

const NOISE_SECONDS = 2;

// Our own generator: seeded noise means an offline render is the same every run, so a
// level regression in the tests is a real change rather than dice.
function seededRandom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1;
  };
}

function makeNoise(ctx, color) {
  const length = Math.floor(ctx.sampleRate * NOISE_SECONDS);
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  const random = seededRandom(color.length * 7919);
  if (color === 'white') {
    for (let i = 0; i < length; i++) data[i] = random() * 0.9;
  } else if (color === 'pink') {
    // Paul Kellet's filter: three poles is close enough for snow.
    let b0 = 0, b1 = 0, b2 = 0;
    for (let i = 0; i < length; i++) {
      const w = random();
      b0 = 0.99765 * b0 + w * 0.099046;
      b1 = 0.963 * b1 + w * 0.2965164;
      b2 = 0.57 * b2 + w * 1.0526913;
      data[i] = (b0 + b1 + b2 + w * 0.1848) * 0.18;
    }
  } else {
    let last = 0;
    for (let i = 0; i < length; i++) {
      last = (last + 0.02 * random()) / 1.02;
      data[i] = last * 3.2;
    }
  }
  return buffer;
}

/** Shared raw material: noise and periodic waves, built once per context. */
export class Kit {
  constructor(ctx) {
    this.ctx = ctx;
    this.noise = { white: makeNoise(ctx, 'white'), pink: makeNoise(ctx, 'pink'), brown: makeNoise(ctx, 'brown') };
    this._waves = new Map();
  }

  wave(name) {
    let wave = this._waves.get(name);
    if (!wave) {
      const harmonics = WAVES[name];
      const imag = new Float32Array(harmonics.length + 1);
      imag.set(harmonics, 1);
      wave = this.ctx.createPeriodicWave(new Float32Array(harmonics.length + 1), imag);
      this._waves.set(name, wave);
    }
    return wave;
  }
}

// A soft room for the whole game: short enough to stay out of the way of the action,
// with a tail that darkens as it decays the way snow eats high frequencies.
function makeImpulse(ctx) {
  const rate = ctx.sampleRate;
  const seconds = 1.7;
  const preDelay = Math.floor(0.014 * rate);
  const length = Math.floor(seconds * rate);
  const buffer = ctx.createBuffer(2, length, rate);
  for (let channel = 0; channel < 2; channel++) {
    const data = buffer.getChannelData(channel);
    const random = seededRandom(101 + channel * 977);
    let low = 0;
    for (let i = preDelay; i < length; i++) {
      const t = (i - preDelay) / rate;
      low += (random() - low) * (0.05 + 0.4 * Math.exp(-t * 3.2));
      data[i] = low * Math.exp(-t * 4.4);
    }
  }
  return buffer;
}

// Transparent below 0.72, then bends smoothly toward a ceiling of CLIP_CEILING. The
// shaper's domain is -1..1 and it clamps beyond that, so it is fed at half level to
// cover input up to +-2: nothing the limiter lets past can reach full scale.
const CLIP_CEILING = 0.94;
const CLIP_KNEE = 0.72;

function makeClipCurve() {
  const size = 4097;
  const curve = new Float32Array(size);
  const span = CLIP_CEILING - CLIP_KNEE;
  for (let i = 0; i < size; i++) {
    const x = ((i / (size - 1)) * 2 - 1) * 2;
    const magnitude = Math.abs(x);
    const y = magnitude <= CLIP_KNEE ? magnitude : CLIP_KNEE + span * Math.tanh((magnitude - CLIP_KNEE) / span);
    curve[i] = Math.sign(x) * y;
  }
  return curve;
}

// Sliders run through this power because loudness goes roughly as amplitude to the 0.6:
// half way up the slider then sounds like half as loud.
const TAPER = 1.6;

// The level everything was balanced at. These are the settings a new player starts on,
// so the trims below put the mix at its designed loudness on first launch, leaving
// room to go louder than that.
export const DEFAULT_VOLUMES = Object.freeze({ master: 0.8, music: 0.6, sfx: 0.9 });
const MUSIC_TRIM = 1.6;
const SFX_TRIM = 2;
const VERB_RETURN = 0.72;

// DynamicsCompressorNode adds makeup gain of its own, fixed by its settings. Taken back
// out here so that sound under the threshold passes at unity and levels mean what they
// say. The figure is measured with a test tone and only holds for these three settings.
const LIMIT_THRESHOLD = -5;
const LIMIT_KNEE = 3;
const LIMIT_RATIO = 20;
const MAKEUP_DB = 2.33;

const curve = (value) => value ** TAPER;

export function createMixer(ctx, volumes = DEFAULT_VOLUMES) {
  const gain = (value) => {
    const node = ctx.createGain();
    node.gain.value = value;
    return node;
  };

  const musicLevel = curve(volumes.music) * MUSIC_TRIM;
  const sfxLevel = curve(volumes.sfx) * SFX_TRIM;
  const music = gain(musicLevel);
  const duck = gain(1);
  const sfx = gain(sfxLevel);
  const master = gain(curve(volumes.master));

  // Reverb sends go through their own bus's slider and ducking, or turning the music
  // down would leave its echo playing.
  const musicWet = gain(musicLevel);
  const wetDuck = gain(1);
  const sfxWet = gain(sfxLevel);

  const convolver = ctx.createConvolver();
  convolver.buffer = makeImpulse(ctx);
  const verbReturn = gain(VERB_RETURN);

  // Phones can't reproduce it and a laptop speaker only rattles trying to.
  const rumbleCut = ctx.createBiquadFilter();
  rumbleCut.type = 'highpass';
  rumbleCut.frequency.value = 30;
  rumbleCut.Q.value = 0.5;

  // A broad tilt is kinder than policing every sound: whatever slips through, the top
  // end of the mix stays soft.
  const shelf = ctx.createBiquadFilter();
  shelf.type = 'highshelf';
  shelf.frequency.value = 6500;
  shelf.gain.value = -5;

  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = LIMIT_THRESHOLD;
  limiter.knee.value = LIMIT_KNEE;
  limiter.ratio.value = LIMIT_RATIO;
  limiter.attack.value = 0.002;
  limiter.release.value = 0.14;

  const trim = gain(10 ** (-MAKEUP_DB / 20) * 0.5);
  const clip = ctx.createWaveShaper();
  clip.curve = makeClipCurve();
  // Oversampling would let the shaper's filters overshoot the ceiling it exists to
  // guarantee, and only high-level peaks ever reach the curve.
  clip.oversample = 'none';

  music.connect(duck).connect(master);
  sfx.connect(master);
  musicWet.connect(wetDuck).connect(convolver);
  sfxWet.connect(convolver);
  convolver.connect(verbReturn).connect(master);
  master.connect(rumbleCut).connect(shelf).connect(limiter).connect(trim).connect(clip).connect(ctx.destination);

  const kit = new Kit(ctx);

  return {
    ctx,
    kit,
    music,
    musicWet,
    sfx,
    sfxWet,
    master,
    output: clip,

    setVolumes({ master: m, music: mu, sfx: s }, when = ctx.currentTime) {
      const glide = (node, value) => node.gain.setTargetAtTime(value, when, 0.02);
      glide(master, curve(m));
      glide(music, curve(mu) * MUSIC_TRIM);
      glide(musicWet, curve(mu) * MUSIC_TRIM);
      glide(sfx, curve(s) * SFX_TRIM);
      glide(sfxWet, curve(s) * SFX_TRIM);
    },

    // Big moments push the music back briefly so the roar lands, then let it return.
    duck(depth, seconds, when = ctx.currentTime) {
      for (const { gain: param } of [duck, wetDuck]) {
        param.cancelScheduledValues(when);
        param.setTargetAtTime(1 - depth, when, 0.03);
        param.setTargetAtTime(1, when + seconds, 0.35);
      }
    },
  };
}
