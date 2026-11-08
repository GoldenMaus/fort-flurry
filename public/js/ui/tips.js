// Contextual tips: one at a time, each once per browser, worked out from the view rather than from
// events so a tip can't fire for something the player can't see yet (SPEC 11.4).
import { ACTOR, AFLAG, MODE, PHASE } from '../../shared/schema.js';

const SHOW_MS = 6000;
const LOW_SNOW_GAP_MS = 14000;
const PACKS_TO_LEARN = 3;

const TIPS = Object.freeze({
  firstBuild: {
    kbm: 'Protect Colonel Carrot! Press 1, then click near him to build.',
    touch: 'Protect Colonel Carrot! Tap a tool, then touch near him to build.',
    pad: 'Protect Colonel Carrot! Press RB for a tool, then X near him to build.',
  },
  classicBuild: {
    kbm: 'Press 1, 3 or 4, then click your side. 3 free things!',
    touch: 'Tap a tool, then tap your side!',
    pad: 'RB for a tool, then X on your side. 3 free things!',
  },
  ready: {
    kbm: "Press R when you're ready.",
    touch: "Tap Ready when you're ready.",
    pad: "Press Y when you're ready.",
  },
  throw: {
    kbm: 'Click to throw. Hold longer to throw harder and farther.',
    touch: 'Press the right stick and let go to throw. Hold longer to throw harder and farther.',
    pad: 'Pull RT to throw. Hold longer to throw harder and farther.',
  },
  lowSnow: { all: 'Low on snow! Stand still to pack more.' },
  thawFriend: { all: 'Stand next to a frozen friend to thaw them.' },
  frozen: { all: "Brrr! You'll thaw soon." },
  lid: {
    kbm: 'Lids block throws. Hit from the side, or hold right-click to lob.',
    touch: 'Lids block throws. Hit from the side, or turn on Lob.',
    pad: 'Lids block throws. Hit from the side, or hold LT to lob.',
  },
  thief: { all: 'Thief! Freeze it to save the nose!' },
  offer: { all: 'Pick a card!' },
});

export const tipText = (id, mode) => TIPS[id].all ?? TIPS[id][mode] ?? TIPS[id].kbm;

export class TipEngine {
  constructor(prefs, onShow) {
    this.prefs = prefs;
    this.onShow = onShow;
    this.reset();
  }

  reset() {
    this.showingUntil = 0;
    this.lowSnowAt = -Infinity;
    this.lastBalls = null;
    this.lowSnow = false;
  }

  // Whether the ball pips should pulse: true for as long as the low-snow lesson still applies.
  get pulsePips() { return this.lowSnow; }

  trackPacking(view) {
    const { you, me } = view;
    if (!you || !me) { this.lastBalls = null; return; }
    if (this.lastBalls !== null && you.balls > this.lastBalls && (me.flags & AFLAG.PACKING)) this.prefs.addPack();
    this.lastBalls = you.balls;
  }

  // Ordered most urgent first, so the one slot goes to what matters right now.
  candidate(view, session, now) {
    const { you, me, meta, phase, mode } = view;
    const seen = (id) => this.prefs.tipSeen(id);
    const fight = phase === PHASE.FIGHT;
    const build = phase === PHASE.BUILD;
    if (!me || !you) return null;

    if ((me.flags & AFLAG.FROZEN) && mode !== MODE.CLASSIC && !seen('frozen')) return 'frozen';

    let thief = false;
    let lid = false;
    let friendFrozen = false;
    for (const a of view.actors ?? []) {
      if (a.kind === ACTOR.SNEAK) thief = true;
      else if (a.kind === ACTOR.LIDKID) lid = true;
      else if (a.kind === ACTOR.KID && a.id !== me.id && a.team === me.team && (a.flags & AFLAG.FROZEN)) friendFrozen = true;
    }
    if (thief && !seen('thief')) return 'thief';
    if (lid && !seen('lid')) return 'lid';

    const learning = this.prefs.packs < PACKS_TO_LEARN;
    this.lowSnow = learning && fight && you.balls <= 1;
    if (this.lowSnow && now - this.lowSnowAt > LOW_SNOW_GAP_MS) {
      this.lowSnowAt = now;
      return 'lowSnow';
    }
    if (friendFrozen && mode !== MODE.CLASSIC && !seen('thawFriend')) return 'thawFriend';
    if (session?.offer && !seen('offer')) return 'offer';
    if (fight && !seen('throw')) return 'throw';
    if (build && mode === MODE.CLASSIC && !seen('classicBuild')) return 'classicBuild';
    if (build && mode !== MODE.FFA && mode !== MODE.CLASSIC && !seen('firstBuild')) return 'firstBuild';
    const team = me.team;
    const flakes = meta?.flakes?.[team] ?? 0;
    const late = view.secondsLeft !== null && view.secondsLeft !== undefined && view.secondsLeft <= 10;
    if (build && (flakes < 2 || late) && !seen('ready')) return 'ready';
    return null;
  }

  update(view, session, mode, now) {
    this.trackPacking(view);
    if (now < this.showingUntil) {
      // The pips keep pulsing while another tip has the slot.
      this.lowSnow = this.prefs.packs < PACKS_TO_LEARN && view.phase === PHASE.FIGHT && (view.you?.balls ?? 99) <= 1;
      return;
    }
    const id = this.candidate(view, session, now);
    if (!id) return;
    if (id !== 'lowSnow') this.prefs.markTip(id);
    this.showingUntil = now + SHOW_MS;
    this.onShow(id, tipText(id, mode), SHOW_MS);
  }
}
