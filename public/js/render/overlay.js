// Pass 8: everything that sits on the glass, ungraded, in CSS pixels. Name tags, speech, numbers,
// lens splats, edge arrows and on-screen sticks.
import { ACTOR, AFLAG, MODE, STRUCT } from '../../shared/schema.js';
import { CELL, LOOK, TEAM_STYLE } from '../../shared/constants.js';
import { P, teamColor } from './palette.js';
import { TextBank, bakeEdgeArrow, bakeEdgeGlyph, bakeLensSplat, bakeFrost } from './hudart.js';
import { iconCanvas } from './sprites.js';

const TAU = Math.PI * 2;
const MAX_NUMBERS = 48;
const MAX_SPLATS = 6;
const BUBBLE_POP_S = 0.16;
const EDGE_MARGIN = 38;

// World units from an actor's feet to just above its head.
const HEAD = {
  [ACTOR.KID]: 52, [ACTOR.PIPSQUEAK]: 42, [ACTOR.SLINGER]: 46, [ACTOR.LOBBER]: 46, [ACTOR.BRUISER]: 74, [ACTOR.SLEDDER]: 46,
  [ACTOR.LIDKID]: 46, [ACTOR.SNEAK]: 44, [ACTOR.TRUCK]: 116, [ACTOR.STEVE]: 138,
};
export const headHeight = (kind) => HEAD[kind] ?? 48;

const NO_ACTORS = Object.freeze([]);
const easeOut = (t) => 1 - (1 - t) * (1 - t);

// Overshoot on pop-in: a few frames of bounce is what makes UI feel like it has weight.
function popScale(t) {
  if (t >= 1) return 1;
  const s = 1.70158;
  const u = t - 1;
  return 1 + (s + 1) * u * u * u + s * u * u;
}

export class Overlay {
  constructor() {
    this.text = new TextBank();
    this.numbers = [];
    this.bubbles = new Map();
    this.splats = [];
    this.splatArt = [bakeLensSplat(301), bakeLensSplat(302), bakeLensSplat(303)];
    this.frost = bakeFrost();
    this.frostAmt = 0;
    this.arrows = new Map();
    this.glyphs = { ice: bakeEdgeGlyph('ice'), carrot: bakeEdgeGlyph('carrot'), foe: bakeEdgeGlyph('foe') };
    this.iconCache = new Map();
    this.tagColor = new Map();
  }

  clear() {
    this.numbers.length = 0;
    this.bubbles.clear();
    this.splats.length = 0;
  }

  arrowFor(color) {
    let c = this.arrows.get(color);
    if (!c) {
      c = bakeEdgeArrow(color);
      this.arrows.set(color, c);
    }
    return c;
  }

  // ---- feed -----------------------------------------------------------------

  // Text sprites are built here, as events arrive, and never during a frame.
  addNumber(x, y, text, style, id = 0, value = 0) {
    // Rapid hits on one target fold into one growing number rather than a stack of illegible digits.
    if (id && value) {
      for (let i = this.numbers.length - 1; i >= 0; i--) {
        const n = this.numbers[i];
        if (n.id === id && n.style === style && n.t < 0.14) {
          n.value += value;
          n.t = 0;
          n.sp = this.text.label(String(Math.round(n.value)), style);
          return;
        }
      }
    }
    if (this.numbers.length >= MAX_NUMBERS) this.numbers.shift();
    this.numbers.push({
      x, y, style, id, value, t: 0, life: style === 'big' ? 1.05 : 0.85, drift: (Math.random() - 0.5) * 22, sp: this.text.label(text, style),
    });
  }

  addBubble(id, text, style, x, y, duration) {
    this.bubbles.set(id, { id, x, y, t: 0, life: duration, sp: this.text.bubble(text, style) });
  }

  addSplat(W, H) {
    if (this.splats.length >= MAX_SPLATS) this.splats.shift();
    const edge = Math.random() < 0.7;
    this.splats.push({
      art: this.splatArt[Math.floor(Math.random() * this.splatArt.length)],
      x: edge ? (Math.random() < 0.5 ? W * 0.14 : W * 0.86) + (Math.random() - 0.5) * W * 0.14 : W * (0.25 + Math.random() * 0.5),
      y: H * (0.16 + Math.random() * 0.68),
      size: Math.min(W, H) * (0.26 + Math.random() * 0.18),
      rot: (Math.random() - 0.5) * 1.2,
      t: 0,
      life: 1.9,
      slide: 0,
    });
  }

  update(dt, reduceMotion) {
    const nums = this.numbers;
    for (let i = nums.length - 1; i >= 0; i--) {
      nums[i].t += dt;
      if (nums[i].t >= nums[i].life) nums.splice(i, 1);
    }
    for (const b of this.bubbles.values()) {
      b.t += dt;
      if (b.t >= b.life) this.bubbles.delete(b.id);
    }
    const sp = this.splats;
    for (let i = sp.length - 1; i >= 0; i--) {
      const s = sp[i];
      s.t += dt;
      if (!reduceMotion && s.t > 0.45) s.slide += dt * (12 + (s.t - 0.45) * 26);
      if (s.t >= s.life) sp.splice(i, 1);
    }
  }

  // ---- draw -----------------------------------------------------------------

  tagColorFor(actor, player, view) {
    if (view.mode === MODE.FORTWARS) return TEAM_STYLE[actor.team]?.color ?? teamColor(actor.team);
    const look = player?.look;
    if (look) return LOOK.scarf[look.scarf] ?? '#ffffff';
    return teamColor(actor.team);
  }

  drawNameTags(ctx, view, r) {
    const actors = view.actors;
    if (!actors) return;
    const meId = view.me ? view.me.id : -1;
    const players = view.players;
    for (let i = 0; i < actors.length; i++) {
      const a = actors[i];
      if (a.kind === ACTOR.KID) {
        if (a.id === meId) continue;
        const sx = (a.x - r.cam.x) * r.zoom;
        const sy = (a.y - r.cam.y - HEAD[ACTOR.KID]) * r.zoom;
        if (sx < -60 || sy < -30 || sx > r.cssW + 60 || sy > r.cssH + 90) continue;
        const player = players ? players.get(a.id) : null;
        if (player && player.name) {
          const tag = this.text.nameTag(player.name, this.tagColorFor(a, player, view));
          ctx.globalAlpha = player.connected === false ? 0.55 : 1;
          ctx.drawImage(tag.canvas, sx - tag.w / 2, sy - tag.h, tag.w, tag.h);
          ctx.globalAlpha = 1;
        }
        if (a.flags & AFLAG.FROZEN) this.pip(ctx, sx, sy + 7, 40, a.aux / 255, '#8fe0f8');
        else if (a.hp < 0.995) this.pip(ctx, sx, sy + 6, 32, a.hp, a.hp < 0.34 ? P.bad : P.good);
      } else if (a.hp < 0.995 && a.kind !== ACTOR.TRUCK && a.kind !== ACTOR.STEVE && !(a.flags & AFLAG.FLEEING)) {
        // Bosses have the HUD bar; every other foe shows a pip only once it has actually been hurt.
        const sx = (a.x - r.cam.x) * r.zoom;
        const sy = (a.y - r.cam.y - headHeight(a.kind)) * r.zoom;
        if (sx < -30 || sy < -20 || sx > r.cssW + 30 || sy > r.cssH + 30) continue;
        this.pip(ctx, sx, sy + 4, 26, a.hp, '#ffb35a');
      }
    }
  }

  pip(ctx, x, y, w, v, color) {
    const h = 4;
    const x0 = x - w / 2;
    ctx.fillStyle = 'rgba(40,42,90,0.62)';
    ctx.beginPath();
    ctx.moveTo(x0 + 2, y);
    ctx.arcTo(x0 + w, y, x0 + w, y + h, 2);
    ctx.arcTo(x0 + w, y + h, x0, y + h, 2);
    ctx.arcTo(x0, y + h, x0, y, 2);
    ctx.arcTo(x0, y, x0 + w, y, 2);
    ctx.fill();
    const f = v < 0 ? 0 : v > 1 ? 1 : v;
    if (f > 0.02) {
      ctx.fillStyle = color;
      ctx.fillRect(x0 + 1, y + 1, (w - 2) * f, h - 2);
    }
  }

  drawBubbles(ctx, view, r) {
    for (const b of this.bubbles.values()) {
      const a = r.actorById.get(b.id);
      if (a) {
        b.x = a.x;
        b.y = a.y - headHeight(a.kind);
      }
      const sp = b.sp;
      let sx = (b.x - r.cam.x) * r.zoom;
      let sy = (b.y - r.cam.y) * r.zoom - 4;
      if (sx < -sp.w || sy < -sp.h * 2 || sx > r.cssW + sp.w || sy > r.cssH + sp.h * 2) continue;
      sx = Math.min(Math.max(sx, sp.w / 2 + 6), r.cssW - sp.w / 2 - 6);
      sy = Math.max(sy, sp.h + 6);
      const s = popScale(Math.min(1, b.t / BUBBLE_POP_S));
      const fade = Math.min(1, (b.life - b.t) / 0.22);
      ctx.globalAlpha = fade;
      const w = sp.w * s;
      const h = sp.h * s;
      ctx.drawImage(sp.canvas, sx - w / 2, sy - h, w, h);
    }
    ctx.globalAlpha = 1;
  }

  drawNumbers(ctx, r) {
    for (let i = 0; i < this.numbers.length; i++) {
      const n = this.numbers[i];
      const k = n.t / n.life;
      const sp = n.sp;
      const rise = easeOut(k) * 42;
      const sx = (n.x - r.cam.x) * r.zoom + n.drift * k;
      const sy = (n.y - r.cam.y) * r.zoom - rise;
      if (sx < -40 || sy < -40 || sx > r.cssW + 40 || sy > r.cssH + 40) continue;
      const s = popScale(Math.min(1, n.t / 0.13));
      ctx.globalAlpha = k > 0.66 ? (1 - k) / 0.34 : 1;
      ctx.drawImage(sp.canvas, sx - (sp.w * s) / 2, sy - (sp.h * s) / 2, sp.w * s, sp.h * s);
    }
    ctx.globalAlpha = 1;
  }

  drawFrost(ctx, view, r, dt) {
    const me = view.me;
    let want = 0;
    if (me) {
      if (me.flags & AFLAG.FROZEN) want = 1;
      else if (me.hp < 0.3) want = (0.3 - me.hp) * 1.3;
    }
    this.frostAmt += (want - this.frostAmt) * (1 - Math.exp(-dt / 0.3));
    if (this.frostAmt < 0.012) return;
    ctx.globalAlpha = Math.min(1, this.frostAmt);
    ctx.drawImage(this.frost, 0, 0, r.cssW, r.cssH);
    ctx.globalAlpha = 1;
  }

  drawSplats(ctx) {
    const list = this.splats;
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      const age = s.t / s.life;
      const pop = s.t < 0.09 ? 0.55 + (s.t / 0.09) * 0.45 : 1;
      ctx.globalAlpha = age > 0.58 ? (1 - age) / 0.42 : 1;
      const size = s.size * pop;
      ctx.save();
      ctx.translate(s.x, s.y + s.slide);
      ctx.rotate(s.rot);
      ctx.drawImage(s.art, -size / 2, -size / 2, size, size);
      ctx.restore();
    }
    ctx.globalAlpha = 1;
  }

  iconFor(name) {
    let c = this.iconCache.get(name);
    if (c === undefined) {
      c = iconCanvas(name, 48) || null;
      this.iconCache.set(name, c);
    }
    return c;
  }

  // Pins a marker to the screen edge along the line from the centre to the target.
  edgeArrow(ctx, r, wx, wy, color, glyph, pulse) {
    const sx = (wx - r.cam.x) * r.zoom;
    const sy = (wy - r.cam.y) * r.zoom;
    const inset = 8;
    if (sx >= inset && sy >= inset && sx <= r.cssW - inset && sy <= r.cssH - inset) return;
    const cx = r.cssW / 2;
    const cy = r.cssH / 2;
    const dx = sx - cx;
    const dy = sy - cy;
    const hw = cx - EDGE_MARGIN;
    // The HUD is DOM above this canvas, so an arrow pinned to the very edge would sit behind it.
    const hh = cy - Math.max(EDGE_MARGIN, dy < 0 ? r.edgeInsets.top : r.edgeInsets.bottom);
    const k = Math.min(Math.abs(hw / (dx || 1e-3)), Math.abs(hh / (dy || 1e-3)));
    const ax = cx + dx * k;
    const ay = cy + dy * k;
    const ang = Math.atan2(dy, dx);
    const size = 46 * (1 + pulse * 0.08);
    ctx.save();
    ctx.translate(ax, ay);
    ctx.save();
    ctx.rotate(ang);
    ctx.drawImage(this.arrowFor(color), -size / 2, -size / 2, size, size);
    ctx.restore();
    if (glyph) ctx.drawImage(glyph, -11, -11, 22, 22);
    ctx.restore();
  }

  drawEdgeArrows(ctx, view, r, time) {
    const me = view.me;
    const myTeam = r.myTeam(view);
    const pulse = Math.sin(time * 6) * 0.5 + 0.5;
    const actors = view.actors || NO_ACTORS;
    const meta = view.meta;
    const lastFoes = view.mode === MODE.SIEGE && meta && meta.foesLeft > 0 && meta.foesLeft <= 3;
    for (let i = 0; i < actors.length; i++) {
      const a = actors[i];
      if (a.kind === ACTOR.KID) {
        if (me && a.id !== me.id && myTeam !== null && a.team === myTeam && (a.flags & AFLAG.FROZEN)) {
          this.edgeArrow(ctx, r, a.x, a.y, '#59bfe6', this.glyphs.ice, pulse);
        }
      } else if (a.kind === ACTOR.TRUCK || a.kind === ACTOR.STEVE) {
        if (!(a.flags & AFLAG.FLEEING)) this.edgeArrow(ctx, r, a.x, a.y, '#e0505c', this.iconFor(`foe:${a.kind}`) || this.glyphs.foe, pulse);
      } else if (lastFoes && !(a.flags & AFLAG.FLEEING)) {
        this.edgeArrow(ctx, r, a.x, a.y, '#a26ad6', this.iconFor(`foe:${a.kind}`) || this.glyphs.foe, pulse);
      }
    }
    const structs = view.structs;
    if (structs && myTeam !== null) {
      for (let i = 0; i < structs.length; i++) {
        const s = structs[i];
        if (s.kind === STRUCT.COLONEL && s.team === myTeam && r.time - (r.colonelHitAt.get(s.team) ?? -99) < 3) {
          this.edgeArrow(ctx, r, (s.cx + 1) * CELL, (s.cy + 1) * CELL, P.carrot, this.glyphs.carrot, pulse);
        }
      }
    }
  }

  drawSticks(ctx, sticks) {
    for (let i = 0; i < sticks.length; i++) {
      const s = sticks[i];
      const lob = s.kind === 'lob';
      const ringColor = lob ? P.gold : '#ffffff';
      ctx.globalAlpha = s.active ? 0.95 : 0.55;
      ctx.fillStyle = 'rgba(60,62,120,0.22)';
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, TAU);
      ctx.fill();
      // A dark line under the ring: a white circle alone disappears on the snow behind it.
      ctx.strokeStyle = 'rgba(52,54,110,0.42)';
      ctx.lineWidth = lob ? 6.5 : 5.5;
      ctx.stroke();
      ctx.strokeStyle = ringColor;
      ctx.lineWidth = lob ? 4 : 3;
      ctx.stroke();
      const kx = s.kx ?? s.x;
      const ky = s.ky ?? s.y;
      ctx.fillStyle = s.active ? 'rgba(255,255,255,0.94)' : 'rgba(255,255,255,0.62)';
      ctx.beginPath();
      ctx.arc(kx, ky, s.r * 0.42, 0, TAU);
      ctx.fill();
      ctx.strokeStyle = lob ? P.gold : 'rgba(52,54,110,0.42)';
      ctx.lineWidth = lob ? 3 : 2;
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  draw(ctx, view, ui, r, dt) {
    ctx.setTransform(r.pixelRatio, 0, 0, r.pixelRatio, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    this.drawNameTags(ctx, view, r);
    this.drawBubbles(ctx, view, r);
    this.drawNumbers(ctx, r);
    this.drawFrost(ctx, view, r, dt);
    this.drawSplats(ctx);
    this.drawEdgeArrows(ctx, view, r, r.time);
    if (ui && ui.sticks && ui.sticks.length) this.drawSticks(ctx, ui.sticks);
  }
}
