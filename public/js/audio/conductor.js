// Fort Flurry — the lookahead music scheduler.
//
// Timers in a browser tab jitter by tens of milliseconds, far too much to play notes
// from. So a coarse timer only asks "what is due soon?" and each note is handed to the
// audio clock with an exact start time. LOOKAHEAD is the slack: it must outlast a
// main-thread stall (a renderer rebuild, a GC pause) or notes get skipped, and it is
// also how long a change of intensity can take to be heard.

import { TRACKS } from './tracks.js';
import { INSTRUMENTS } from './instruments.js';

export const LOOKAHEAD = 0.3;
export const TICK_MS = 40;

const FADE_IN = 0.06;

class Performance {
  constructor(conductor, track, at, startBeat = 0) {
    this.conductor = conductor;
    this.track = track;
    this.ctx = conductor.mix.ctx;
    this.t0 = at - track.clock(startBeat);
    this.index = Math.max(0, track.events.findIndex((e) => e.b >= startBeat));
    this.cycle = 0;
    this.barLevel = conductor.level;
    this.lastBar = -1;
    this.finished = false;
    this.killAt = Infinity;

    // Separate dry and wet faders so a crossfade takes the reverb tail down with the
    // track instead of leaving it hanging.
    this.dry = this.ctx.createGain();
    this.wet = this.ctx.createGain();
    this.dry.gain.value = 0;
    this.wet.gain.value = 0;
    this.dry.gain.setValueAtTime(0, at);
    this.dry.gain.linearRampToValueAtTime(track.gain, at + FADE_IN);
    this.wet.gain.setValueAtTime(0, at);
    this.wet.gain.linearRampToValueAtTime(track.gain, at + FADE_IN);
    this.dry.connect(conductor.mix.music);
    this.wet.connect(conductor.mix.musicWet);
    this.buses = null;
    this._openBuses();
  }

  // One small strip per part. Notes connect here and are never tracked individually,
  // which is what lets `hold` silence everything already queued with a few disconnects.
  _openBuses() {
    const { ctx } = this;
    this.buses = new Map();
    for (const part of this.track.parts) {
      const input = ctx.createGain();
      input.gain.value = part.gain;
      const nodes = [input];
      let tail = input;
      let panner = null;
      if (part.pan || part.bus) {
        panner = ctx.createStereoPanner();
        panner.pan.value = part.pan;
        tail.connect(panner);
        tail = panner;
        nodes.push(panner);
      }
      tail.connect(this.dry);
      if (part.send) {
        const send = ctx.createGain();
        send.gain.value = part.send;
        tail.connect(send).connect(this.wet);
        nodes.push(send);
      }
      this.buses.set(part, { input, nodes, panner });
    }
  }

  _closeBuses() {
    for (const { nodes } of this.buses.values()) for (const node of nodes) node.disconnect();
    this.buses = null;
  }

  // Absolute beats are only ever an estimate of the audio clock, used to find a place
  // to resume from, so the linear inverse is close enough even for swung tracks.
  _beatAt(time) {
    const beats = this.track.loopBeats;
    const loopSeconds = this.track.clock(beats);
    const elapsed = Math.max(0, time - this.t0);
    return (elapsed / loopSeconds) * beats;
  }

  /** The next section boundary after `time`, where a later return should pick up. */
  nextSection(time) {
    const { sections, beats, loopBeats } = this.track;
    const beat = this._beatAt(time) % loopBeats;
    const bar = sections.find((start) => start * beats > beat) ?? 0;
    return bar * beats;
  }

  pump(until, now) {
    const { track, conductor } = this;
    const { kit } = conductor.mix;
    while (!this.finished) {
      let event = track.events[this.index];
      if (!event) {
        if (!track.loop) {
          this.finished = true;
          return;
        }
        this.cycle++;
        this.index = 0;
        event = track.events[0];
      }
      const beat = event.b + this.cycle * track.loopBeats;
      const when = this.t0 + track.clock(beat);
      if (when >= until) return;
      this.index++;

      // Intensity moves only on a bar line, so a layer never enters mid-phrase.
      const bar = Math.floor(beat / track.beats);
      if (bar !== this.lastBar) {
        this.lastBar = bar;
        this.barLevel = conductor.level;
      }
      const { part } = event;
      if (this.barLevel < part.min || this.barLevel > part.max) continue;
      // If the main thread stalled past a note, drop it. A burst of late notes is a
      // far worse sound than a short gap.
      if (when < now) {
        conductor.stats.lateNotes++;
        continue;
      }
      const seconds = (track.clock(beat + event.d) - track.clock(beat)) * part.art;
      INSTRUMENTS[part.inst](kit, this.buses.get(part).input, when, event.m, seconds, event.v);
      conductor.stats.notes++;
      conductor.stats.lastNoteAt = when;
    }
  }

  fadeOut(at, seconds) {
    for (const fader of [this.dry, this.wet]) {
      fader.gain.cancelScheduledValues(at);
      fader.gain.setTargetAtTime(0, at, seconds / 3);
    }
    this.killAt = at + seconds + 0.2;
  }

  /**
   * Detaches every queued note and remembers the musical position. Notes already handed
   * to the audio clock can't be recalled, but cut off from the mix they play to nobody.
   */
  hold(now) {
    const beat = this._beatAt(now);
    const { loop, loopBeats } = this.track;
    this.heldBeat = loop ? beat % loopBeats : Math.min(beat, loopBeats);
    this._closeBuses();
  }

  restart(at) {
    const { track } = this;
    const beat = this.heldBeat ?? 0;
    this.heldBeat = undefined;
    this.index = track.events.findIndex((e) => e.b >= beat);
    if (this.index < 0) {
      this.index = track.loop ? 0 : track.events.length;
    }
    const resumeBeat = this.index < track.events.length ? track.events[this.index].b : 0;
    this.cycle = 0;
    this.t0 = at - track.clock(resumeBeat);
    this.lastBar = -1;
    this._openBuses();
  }

  dispose() {
    if (this.buses) this._closeBuses();
    this.dry.disconnect();
    this.wet.disconnect();
  }
}

export class Conductor {
  constructor(mix) {
    this.mix = mix;
    this.active = null;
    this.fading = [];
    this.level = 0;
    this.stats = { notes: 0, lateNotes: 0, lastNoteAt: 0 };
    // Build phases are shorter than the build loop and there are ten a match, so a track
    // with sections picks up where it left off instead of replaying its opening.
    this.resumeAt = new Map();
  }

  get current() {
    return this.active?.track.id ?? null;
  }

  play(id, at, fade = 0.5) {
    this.stop(at, fade);
    this.active = new Performance(this, TRACKS[id], at, this.resumeAt.get(id));
  }

  stop(at, fade = 0.5) {
    if (!this.active) return;
    if (this.active.track.sections) this.resumeAt.set(this.active.track.id, this.active.nextSection(at));
    this.active.fadeOut(at, fade);
    this.fading.push(this.active);
    this.active = null;
  }

  setLevel(level) {
    this.level = level;
  }

  /** Steers one bus of the running track, used to make the Truck's chime travel. */
  steer(busName, pan, gain, when) {
    if (!this.active?.buses) return;
    for (const [part, bus] of this.active.buses) {
      if (part.bus !== busName) continue;
      bus.panner?.pan.setTargetAtTime(pan, when, 0.12);
      bus.input.gain.setTargetAtTime(part.gain * gain, when, 0.12);
    }
  }

  pump(now) {
    this.active?.pump(now + LOOKAHEAD, now);
    this.sweep(now);
  }

  sweep(now) {
    for (let i = this.fading.length - 1; i >= 0; i--) {
      if (now >= this.fading[i].killAt) {
        this.fading[i].dispose();
        this.fading.splice(i, 1);
      }
    }
  }

  hold(now) {
    this.active?.hold(now);
    // A track mid-crossfade has nothing worth resuming.
    for (const old of this.fading) old.dispose();
    this.fading.length = 0;
  }

  restart(at) {
    this.active?.restart(at);
  }

  /** The earliest beat time a track would next place a note, for tests and the board. */
  get nextNoteTime() {
    const a = this.active;
    if (!a || a.finished) return null;
    const event = a.track.events[a.index] ?? a.track.events[0];
    const cycle = a.track.events[a.index] ? a.cycle : a.cycle + 1;
    return a.t0 + a.track.clock(event.b + cycle * a.track.loopBeats);
  }
}
