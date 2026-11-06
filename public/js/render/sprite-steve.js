// Fort Flurry — Abominable Steve: a big fellow having a very bad day.
// Pear-shaped, dusty lilac, tired, and in a sweater he must have owned since he was smaller. He is a
// cut-out puppet: the fur is far too dear to redraw and far too big to store as frames, so a few
// cached parts swing live and a 120 px boss animates smoothly instead of stepping through poses.
// Art direction limits, on purpose: never white with a blue face, no fangs, never near a snow cone.

import {
  TAU, INK, CREAM, COCOA, ell, curve, capsule, litFill, linGrad, tone, mix, alpha, clipped, smoothPath, seeded, roundRect,
} from './sprite-paint.js';

const FUR = '#a597c6';
const FUR_HI = '#c6bbdc';
const FUR_LO = '#8072a8';
const FUR_DEEP = '#675a8e';
const FACE = '#d7b5a8';
const FACE_LO = '#b98f8c';
const WOOL = '#dca83a';
const WOOL_HI = '#f0c95e';
const WOOL_LO = '#b07f22';
const HAT = '#3fa79b';

const BODY_H = 112;
export const STEVE_BODY_BOX = Object.freeze({ w: 136, h: 158, ax: 68, ay: 146 });
export const STEVE_ARM_BOX = Object.freeze({ w: 46, h: 92, ax: 23, ay: 14 });
export const STEVE_FOOT_BOX = Object.freeze({ w: 56, h: 34, ax: 28, ay: 24 });
export const STEVE_SIT_BOX = Object.freeze({ w: 160, h: 140, ax: 80, ay: 122 });

function outline(c) {
  // Pear in profile is slimmer front-to-back than across, so the same pear narrows as he turns.
  const k = 0.84 + 0.16 * Math.abs(Math.sin(c));
  const p = [
    [0, -BODY_H], [14, -BODY_H + 3], [23, -BODY_H + 17], [28, -74], [37, -52], [50, -27], [46, -10], [26, -3],
    [-26, -3], [-46, -10], [-50, -27], [-37, -52], [-28, -74], [-23, -BODY_H + 17], [-14, -BODY_H + 3],
  ];
  return p.map(([x, y]) => [x * k, y]);
}

// Shag, not spines: fur is soft overlapping locks that all fall downhill. Three close values do the
// work and the seed keeps every rebuild identical, so he never shimmers.
function lock(ctx, x, y, len, ang, w, color) {
  ell(ctx, x + Math.cos(ang) * len * 0.5, y + Math.sin(ang) * len * 0.5, len * 0.62, w, color, ang);
}

function furFringe(ctx, pts, rnd, spike = 1) {
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    const seg = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const steps = Math.ceil(seg / 6.4);
    for (let k = 0; k < steps; k++) {
      const t = k / steps;
      const x = a[0] + (b[0] - a[0]) * t, y = a[1] + (b[1] - a[1]) * t;
      // Locks flare out a little at the flanks and hang straight at the hem.
      const flare = Math.max(-0.75, Math.min(0.75, -x / 60));
      const ang = Math.PI / 2 + flare + (rnd() - 0.5) * 0.4;
      const col = x < -8 ? (rnd() > 0.5 ? FUR_HI : FUR) : (rnd() > 0.5 ? FUR : FUR_LO);
      lock(ctx, x, y - 2, (8 + rnd() * 5) * spike, ang, 4.2, col);
    }
  }
}

function furFill(ctx, rnd, x0, y0, x1, y1, count, spike = 1) {
  for (let i = 0; i < count; i++) {
    const x = x0 + rnd() * (x1 - x0), y = y0 + rnd() * (y1 - y0);
    const lit = 1 - ((x - x0) / (x1 - x0)) * 0.7 - ((y - y0) / (y1 - y0)) * 0.35;
    const col = rnd() < lit * 0.6 ? FUR_HI : FUR_LO;
    lock(ctx, x, y, (11 + rnd() * 10) * spike, Math.PI / 2 + (rnd() - 0.5) * 0.5, 1.6, alpha(col, 0.42));
  }
}

function stitch(ctx, pts, color, w = 0.85) {
  ctx.beginPath();
  pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
  ctx.strokeStyle = color;
  ctx.lineWidth = w;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.stroke();
}

// Hand-stitched letters as stroked paths: real lettering would need a font, and a tag sewn on by a
// worried relative should wobble a little.
const GLYPH = {
  S: [[1, 0.1], [0.2, 0], [0, 0.26], [0.3, 0.46], [0.8, 0.56], [1, 0.8], [0.7, 1], [0, 0.92]],
  T: [[0, 0], [1, 0], [0.5, 0], [0.5, 1]],
  E: [[1, 0], [0, 0], [0, 0.5], [0.8, 0.5], [0, 0.5], [0, 1], [1, 1]],
  V: [[0, 0], [0.5, 1], [1, 0]],
};

export function paintNameTag(ctx, x, y, w, rot = -0.04) {
  const h = w * 0.42;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rot);
  roundRect(ctx, -w / 2, -h / 2, w, h, 1.6);
  ctx.fillStyle = linGrad(ctx, 0, -h / 2, 0, h / 2, ['#fffaf0', CREAM, '#ecdcbc']);
  ctx.fill();
  ctx.setLineDash([1.5, 1.3]);
  roundRect(ctx, -w / 2 + 1, -h / 2 + 1, w - 2, h - 2, 1.2);
  ctx.strokeStyle = '#b5583c';
  ctx.lineWidth = 0.5;
  ctx.stroke();
  ctx.setLineDash([]);
  const word = 'STEVE';
  const gw = (w - 6.4) / word.length;
  const lw = gw * 0.68, lh = h - 5;
  for (let i = 0; i < word.length; i++) {
    const g = GLYPH[word[i]];
    const ox = -w / 2 + 3.4 + i * gw, oy = -lh / 2 + (i % 2 ? 0.25 : -0.15);
    stitch(ctx, g.map(([a, b]) => [ox + a * lw, oy + b * lh]), '#a23a2f', 0.82);
  }
  ctx.restore();
}

function paintTinyHat(ctx, x, y, tilt) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(tilt);
  ell(ctx, 0, -14, 5, 5, linGrad(ctx, -5, -19, 5, -9, ['#ffffff', CREAM, '#d9c7a4']));
  ctx.beginPath();
  ctx.moveTo(-10, 0);
  ctx.bezierCurveTo(-10, -13, 10, -13, 10, 0);
  ctx.quadraticCurveTo(0, 2, -10, 0);
  ctx.closePath();
  ctx.fillStyle = litFill(ctx, 0, -5, 10, 7, HAT, 0.26, 0.26);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(-11, 1.6);
  ctx.quadraticCurveTo(0, 4, 11, 1.6);
  ctx.lineTo(10.6, -3);
  ctx.quadraticCurveTo(0, -0.6, -10.6, -3);
  ctx.closePath();
  ctx.fillStyle = tone(HAT, 0.5);
  ctx.fill();
  ctx.restore();
}

// Tired is all in the lids: a heavy fold over a small pupil, and bags underneath.
function paintEye(ctx, x, y, r, d, mood) {
  ell(ctx, x, y, r, r * 0.92, '#fbf6ec');
  const py = mood === 'strain' ? y - 0.6 : y + 1;
  ell(ctx, x + (mood === 'strain' ? 0 : d * 0.3), py, r * 0.46, r * 0.5, INK);
  ell(ctx, x - r * 0.18, py - r * 0.2, r * 0.13, r * 0.13, '#ffffff');
  const lid = mood === 'blink' ? 1 : mood === 'strain' ? 0.24 : mood === 'mad' ? 0.42 : 0.56;
  ctx.save();
  ctx.beginPath();
  ctx.ellipse(x, y, r + 0.3, r * 0.92 + 0.3, 0, 0, TAU);
  ctx.clip();
  const tilt = mood === 'mad' ? d * 0.34 : mood === 'blink' ? 0 : -d * 0.14;
  ctx.translate(x, y - r + r * 2 * lid);
  ctx.rotate(tilt);
  ctx.fillStyle = FACE_LO;
  ctx.fillRect(-r * 1.8, -r * 3, r * 3.6, r * 3);
  ctx.fillStyle = tone(FACE_LO, -0.22);
  ctx.fillRect(-r * 1.8, -1, r * 3.6, 1.1);
  ctx.restore();
  curve(ctx, x - r * 0.84, y + r * 1.02, x, y + r * 1.5, x + r * 0.84, y + r * 1.02, alpha(tone(FACE_LO, -0.32), 0.85), 1.1);
  if (mood !== 'blink') curve(ctx, x - r * 0.62, y + r * 1.42, x, y + r * 1.76, x + r * 0.62, y + r * 1.42, alpha(tone(FACE_LO, -0.3), 0.45), 0.8);
}


function paintFace(ctx, cx, cy, sq, mood) {
  const mad = mood === 'mad' || mood === 'madblink';
  const look = mood === 'madblink' ? 'blink' : mad ? 'mad' : mood;
  const faceW = 22 * (0.62 + 0.38 * sq);
  ctx.beginPath();
  ctx.moveTo(cx - faceW, cy - 6);
  ctx.bezierCurveTo(cx - faceW - 2, cy - 21, cx - 8, cy - 22, cx, cy - 15);
  ctx.bezierCurveTo(cx + 8, cy - 22, cx + faceW + 2, cy - 21, cx + faceW, cy - 6);
  ctx.bezierCurveTo(cx + faceW + 1, cy + 11, cx + 12, cy + 18, cx, cy + 18);
  ctx.bezierCurveTo(cx - 12, cy + 18, cx - faceW - 1, cy + 11, cx - faceW, cy - 6);
  ctx.closePath();
  const skin = mad ? mix(FACE, '#ee8d82', 0.55) : FACE;
  ctx.fillStyle = litFill(ctx, cx, cy, faceW, 18, skin, 0.16, 0.2);
  ctx.fill();
  const ex = 10.6 * (0.3 + 0.7 * sq);
  paintEye(ctx, cx - ex, cy - 5, 5.6, -1, look);
  paintEye(ctx, cx + ex, cy - 5, 5.6, 1, look);
  const browCol = FUR_DEEP;
  for (const d of [-1, 1]) {
    const bx = cx + d * ex;
    // Inner end up reads weary, inner end down reads cross. It is the whole of his acting range.
    const innerY = cy - 5 + (mad ? -7.4 : mood === 'strain' ? -13.5 : -12.5);
    const outerY = cy - 5 + (mad ? -12 : mood === 'strain' ? -12 : -8.6);
    capsule(ctx, bx - d * 6.4, innerY, 1.7, bx + d * 6.6, outerY, 2.1, browCol);
  }
  ell(ctx, cx, cy + 3.4, 5.4, 3.5, mix(FACE_LO, '#8a5a6a', 0.6));
  ell(ctx, cx - 1.5, cy + 2.4, 1.6, 0.9, 'rgba(255,255,255,0.5)');
  const my = cy + 11.5;
  const mouth = tone(FACE_LO, -0.5);
  if (mood === 'strain') {
    ell(ctx, cx, my + 0.6, 4, 3.4, tone(FACE_LO, -0.6));
  } else if (mad) {
    ctx.beginPath();
    ctx.moveTo(cx - 8, my + 2);
    ctx.quadraticCurveTo(cx - 4, my - 2.4, cx, my + 0.4);
    ctx.quadraticCurveTo(cx + 4, my - 2.4, cx + 8, my + 2);
    ctx.strokeStyle = mouth;
    ctx.lineWidth = 1.7;
    ctx.lineCap = 'round';
    ctx.stroke();
  } else {
    curve(ctx, cx - 7, my + 2, cx, my - 2.6, cx + 7, my + 2, mouth, 1.5);
  }
}

function paintSweaterFront(ctx, th, pts) {
  const c = Math.cos(th), s = Math.sin(th);
  const k = 0.84 + 0.16 * Math.abs(s);
  const top = -77, hem = -38;
  smoothPath(ctx, pts, true, 0.5);
  clipped(ctx, () => {
    const shift = c * 8;
    // Sweater body: tight enough that the hem rides up and a belly of fur escapes below it.
    ctx.beginPath();
    ctx.moveTo(-70, top - 6);
    ctx.quadraticCurveTo(shift, top + (s > -0.3 ? 8 : 0), 70, top - 6);
    ctx.lineTo(70, hem - 4);
    ctx.quadraticCurveTo(shift, hem + 8, -70, hem - 4);
    ctx.closePath();
    ctx.fillStyle = linGrad(ctx, -48 * k, top, 48 * k, hem + 10, [WOOL_HI, WOOL, WOOL_LO]);
    ctx.fill();
    // Knit rows, then the ribbed hem and collar. The ribbing does the work of saying "sweater".
    ctx.strokeStyle = alpha(WOOL_LO, 0.5);
    ctx.lineWidth = 0.8;
    for (let y = top + 6; y < hem - 2; y += 4.4) {
      ctx.beginPath();
      ctx.moveTo(-60, y - 5);
      ctx.quadraticCurveTo(shift, y + 8, 60, y - 5);
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.moveTo(-70, hem - 11);
    ctx.quadraticCurveTo(shift, hem + 1, 70, hem - 11);
    ctx.lineTo(70, hem - 4);
    ctx.quadraticCurveTo(shift, hem + 8, -70, hem - 4);
    ctx.closePath();
    ctx.fillStyle = tone(WOOL, -0.18);
    ctx.fill();
    ctx.strokeStyle = alpha(WOOL_LO, 0.9);
    ctx.lineWidth = 1.1;
    for (let x = -56; x <= 56; x += 4.6) {
      const t = (x - shift) / 70;
      const y = hem - 2 + 6 * (1 - t * t) * 0.8;
      ctx.beginPath();
      ctx.moveTo(x, y - 6);
      ctx.lineTo(x, y);
      ctx.stroke();
    }
  });
}

// dir is 0..7. He is never mirrored: a mirrored Steve wears his name tag back to front.
export function paintSteveBody(ctx, dir, mood) {
  const th = dir * (Math.PI / 4);
  const c = Math.cos(th), s = Math.sin(th);
  const mad = mood === 'mad' || mood === 'madblink';
  const pts = outline(th);
  const rnd = seeded(77 + dir);
  furFringe(ctx, pts, rnd, mad ? 1.25 : 1);
  smoothPath(ctx, pts, true, 0.5);
  ctx.fillStyle = linGrad(ctx, -48, -BODY_H, 46, 0, [FUR_HI, FUR, FUR_LO]);
  ctx.fill();
  clipped(ctx, () => {
    ell(ctx, 18, -26, 42, 44, alpha(FUR_LO, 0.5));
    ell(ctx, 8, 0, 56, 22, alpha(FUR_DEEP, 0.42));
    furFill(ctx, rnd, -52, -BODY_H, 52, 0, 210, mad ? 1.2 : 1);
  });
  paintSweaterFront(ctx, th, pts);
  const facing = s > -0.3;
  const sq = Math.abs(s);
  if (facing) {
    // Collar of the sweater, pulled too tight under where a neck would be.
    const cx = c * 9;
    smoothPath(ctx, pts, true, 0.5);
    clipped(ctx, () => {
      ctx.beginPath();
      ctx.moveTo(-34 + cx, -85);
      ctx.quadraticCurveTo(cx, -67, 34 + cx, -85);
      ctx.lineTo(34 + cx, -79);
      ctx.quadraticCurveTo(cx, -61, -34 + cx, -79);
      ctx.closePath();
      ctx.fillStyle = tone(WOOL, -0.12);
      ctx.fill();
    });
    paintNameTag(ctx, -11 + c * 18, -55, 27);
    paintFace(ctx, c * 7, -90 + s * 0.6, sq, mood);
  } else {
    // From behind: just shag, a stressed collar, and one sad little darn in the wool.
    ctx.beginPath();
    ctx.moveTo(-27, -81);
    ctx.quadraticCurveTo(0, -74, 27, -81);
    ctx.lineTo(27, -76);
    ctx.quadraticCurveTo(0, -69, -27, -76);
    ctx.closePath();
    ctx.fillStyle = tone(WOOL, -0.12);
    ctx.fill();
    roundRect(ctx, 8, -60, 12, 9, 2);
    ctx.fillStyle = '#c75f4a';
    ctx.fill();
    stitch(ctx, [[8.4, -60], [19.6, -51]], '#f0c95e', 0.7);
    stitch(ctx, [[8.4, -51], [19.6, -60]], '#f0c95e', 0.7);
    // Walking away at an angle he glances back over his shoulder. Steve spends a lot of the boss fight
    // pointed at the Colonel, and his face is why anyone likes him.
    if (Math.abs(c) > 0.3) paintFace(ctx, c * 13, -91, 0.34, mood);
  }
  const tilt = mad ? 0.34 : c * -0.1;
  paintTinyHat(ctx, c * 4, -BODY_H + 4, tilt);
}

// Arm hangs from its pivot along +y. The sleeve gives up well above the elbow: it stopped fitting years ago.
export function paintSteveArm(ctx) {
  const rnd = seeded(12);
  const len = 60, r0 = 8.5, r1 = 12;
  const pts = [[-r0, 0], [0, -r0 * 0.8], [r0, 0], [r1, len * 0.7], [r1 - 1, len], [0, len + 7], [-r1 + 1, len], [-r1, len * 0.7]];
  furFringe(ctx, pts, rnd, 0.62);
  smoothPath(ctx, pts, true, 0.5);
  ctx.fillStyle = linGrad(ctx, -r1, 0, r1, len, [FUR_HI, FUR, FUR_LO]);
  ctx.fill();
  clipped(ctx, () => {
    furFill(ctx, rnd, -r1, 14, r1, len + 8, 46, 0.8);
    ctx.beginPath();
    ctx.moveTo(-20, -16);
    ctx.lineTo(20, -16);
    ctx.lineTo(20, 12);
    ctx.quadraticCurveTo(0, 18, -20, 12);
    ctx.closePath();
    ctx.fillStyle = linGrad(ctx, -12, 0, 12, 16, [WOOL_HI, WOOL, WOOL_LO]);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(-20, 8);
    ctx.quadraticCurveTo(0, 14, 20, 8);
    ctx.lineTo(20, 12);
    ctx.quadraticCurveTo(0, 18, -20, 12);
    ctx.closePath();
    ctx.fillStyle = tone(WOOL, -0.22);
    ctx.fill();
  });
  // Big soft paw with three blunt knuckles: strong hands, nothing sharp.
  for (const x of [-7, 0, 7]) ell(ctx, x, len + 2.2, 3.9, 3.4, tone(FUR_LO, -0.12));
}

export function paintSteveFoot(ctx) {
  ell(ctx, 0, -6, 22, 11.5, linGrad(ctx, -18, -16, 18, 6, [FUR_HI, FUR, FUR_DEEP]));
  const rnd = seeded(4);
  for (let i = 0; i < 16; i++) {
    const a = Math.PI + (i / 15) * Math.PI;
    lock(ctx, Math.cos(a) * 19, -6 + Math.sin(a) * 9.5, 7, Math.PI / 2 + (rnd() - 0.5), 2.6, alpha(FUR_HI, 0.8));
  }
  for (const x of [-11, -2, 8]) ell(ctx, x, 1.6, 5.2, 3.8, tone(FUR_LO, -0.18));
}

// Defeat: he sits down, somebody hands him a cup of cocoa, and for the first time today he looks okay.
export function paintSteveSitting(ctx, frame) {
  const rnd = seeded(31);
  const lift = frame ? 0.7 : 0;
  for (const sd of [-1, 1]) {
    ctx.save();
    ctx.translate(sd * 38, -2);
    ctx.scale(sd > 0 ? 1 : -1, 1);
    ctx.rotate(0.14);
    paintSteveFoot(ctx);
    ctx.restore();
  }
  const H = 92;
  const pts = [[0, -H], [16, -H + 3], [28, -H + 18], [38, -46], [58, -16], [46, -4], [0, 0], [-46, -4], [-58, -16], [-38, -46], [-28, -H + 18], [-16, -H + 3]]
    .map(([x, y]) => [x, y + lift]);
  furFringe(ctx, pts, rnd);
  smoothPath(ctx, pts, true, 0.5);
  ctx.fillStyle = linGrad(ctx, -50, -H, 46, 0, [FUR_HI, FUR, FUR_LO]);
  ctx.fill();
  clipped(ctx, () => {
    furFill(ctx, rnd, -60, -H, 60, 0, 220);
    ctx.beginPath();
    ctx.moveTo(-70, -66);
    ctx.quadraticCurveTo(0, -56, 70, -66);
    ctx.lineTo(70, -34);
    ctx.quadraticCurveTo(0, -18, -70, -34);
    ctx.closePath();
    ctx.fillStyle = linGrad(ctx, -40, -66, 40, -20, [WOOL_HI, WOOL, WOOL_LO]);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(-70, -39);
    ctx.quadraticCurveTo(0, -23, 70, -39);
    ctx.lineTo(70, -34);
    ctx.quadraticCurveTo(0, -18, -70, -34);
    ctx.closePath();
    ctx.fillStyle = tone(WOOL, -0.2);
    ctx.fill();
  });
  paintNameTag(ctx, -14, -44 + lift, 25);
  // Face at peace: lids shut and a very small smile, the first of the day.
  const cx = 0, cy = -71 + lift;
  ctx.beginPath();
  ctx.ellipse(cx, cy, 21, 18, 0, 0, TAU);
  ctx.fillStyle = litFill(ctx, cx, cy, 21, 18, FACE, 0.16, 0.2);
  ctx.fill();
  for (const d of [-1, 1]) {
    curve(ctx, cx + d * 10 - 5.5, cy - 4, cx + d * 10, cy + 1, cx + d * 10 + 5.5, cy - 4, tone(FACE_LO, -0.45), 1.6);
    capsule(ctx, cx + d * 15, cy - 12.5, 1.8, cx + d * 5, cy - 13.5, 1.5, FUR_DEEP);
    ell(ctx, cx + d * 14.5, cy + 4.5, 3.6, 2.2, alpha('#e97f7c', 0.45));
  }
  ell(ctx, cx, cy + 3.2, 4.8, 3.1, mix(FACE_LO, '#8a5a6a', 0.6));
  curve(ctx, cx - 5, cy + 9.4, cx, cy + 12.4, cx + 5, cy + 9.4, tone(FACE_LO, -0.5), 1.4);
  paintTinyHat(ctx, 1, -H + 3 + lift, -0.16);
  // Arms round the mug, then the mug on top so nothing hides it.
  const mugX = 0, mugY = -29 + lift;
  for (const sd of [-1, 1]) {
    capsule(ctx, sd * 31, -52 + lift, 8.5, sd * 16, -29 + lift, 9, linGrad(ctx, sd * 30, -56, sd * 10, -24, [FUR_HI, FUR]));
    ell(ctx, sd * 14.5, -27 + lift, 7.6, 6.6, tone(FUR_LO, -0.08));
  }
  roundRect(ctx, mugX - 11, mugY - 11, 22, 21, 4);
  ctx.fillStyle = linGrad(ctx, mugX - 11, mugY, mugX + 11, mugY, ['#fbf1dc', '#fbf1dc', '#d9c7a4']);
  ctx.fill();
  ell(ctx, mugX, mugY - 10.6, 11, 4, '#e7d6b4');
  ell(ctx, mugX, mugY - 10.2, 9.4, 3, COCOA);
  ell(ctx, mugX - 2.6, mugY - 10.6, 3, 1.7, '#fff6ea');
  ell(ctx, mugX + 3.2, mugY - 9.6, 2.5, 1.4, '#fff6ea');
  ctx.fillStyle = '#d6404e';
  ctx.fillRect(mugX - 11, mugY - 2, 22, 2.2);
  ctx.fillRect(mugX - 11, mugY + 2, 22, 1.1);
}
