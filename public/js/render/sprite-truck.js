// Fort Flurry — The Sno-Cone Truck.
// Rounded mint-and-cream step van. It drives a loop at any angle, so unlike the chibis it is built as a
// real solid: footprints lofted between heights and pushed through the camera's own projection, which
// makes every heading correct for free, rounded corners shaded facet by facet.
// Art direction limits, on purpose: no face (lights sit low and wide with no grille), nobody at the
// wheel, nothing on the front that could push snow, and the palette stays mint, cream and coral.

import { TAU, CREAM, ell, line, linGrad, tone, alpha, clipped, poly, capsule, roundRect, seeded } from './sprite-paint.js';

const Z = 0.8; // Z_LIFT, the renderer's height-to-screen factor

const MINT = '#8edcc0';
const MINT_LO = '#5dbfa2';
const CORAL = '#f2708c';
const CREAM_LO = '#e6d5b4';
const GLASS = '#bfeaf4';
const GLASS_LO = '#7fc4dc';
const TYRE = '#4a4468';
const CHROME = '#d5dde8';
const DARK = '#3e3560';

export const TRUCK_L = 56;
export const TRUCK_W = 31;
const ROOF_Z = 65;
const AWNING_OUT = 8;

// Local space: +x is forward, +y is the van's right, z is up.
function projector(h) {
  const c = Math.cos(h), s = Math.sin(h);
  return (x, y, z = 0) => [x * c - y * s, x * s + y * c - z * Z];
}

function footprint(front, side, rear, rf = 15, rr = 9) {
  const xF = TRUCK_L - front, xR = -TRUCK_L + rear, yS = TRUCK_W - side;
  const pts = [];
  const arc = (cx, cy, r, a0) => {
    for (let i = 0; i <= 6; i++) {
      const a = a0 + (i / 6) * (Math.PI / 2);
      pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
    }
  };
  arc(xF - rf, yS - rf, rf, 0);
  arc(xR + rr, yS - rr, rr, Math.PI / 2);
  arc(xR + rr, -yS + rr, rr, Math.PI);
  arc(xF - rf, -yS + rf, rf, Math.PI * 1.5);
  return pts;
}

// Fills the camera-facing facets between two outlines. Same vertex count top and bottom, so slanted
// surfaces such as the windscreen come out of the same code as walls.
function loft(ctx, P, A, z0, B, z1, base, gain = 1) {
  const n = A.length;
  ctx.lineJoin = 'round';
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const a = P(A[i][0], A[i][1], z0), b = P(A[j][0], A[j][1], z0);
    const c = P(B[j][0], B[j][1], z1), d = P(B[i][0], B[i][1], z1);
    const area = (a[0] * b[1] - b[0] * a[1]) + (b[0] * c[1] - c[0] * b[1]) + (c[0] * d[1] - d[0] * c[1]) + (d[0] * a[1] - a[0] * d[1]);
    if (area <= 0) continue;
    const ex = b[0] - a[0], ey = b[1] - a[1];
    const el = Math.hypot(ex, ey) || 1;
    const nx = ey / el, ny = -ex / el;
    const k = (-0.62 * nx + 0.22 * ny) * gain;
    const col = tone(base, k >= 0 ? k * 0.42 : k * 0.5);
    ctx.beginPath();
    ctx.moveTo(a[0], a[1]);
    ctx.lineTo(b[0], b[1]);
    ctx.lineTo(c[0], c[1]);
    ctx.lineTo(d[0], d[1]);
    ctx.closePath();
    ctx.fillStyle = col;
    ctx.fill();
    // Hairline stroke in the same colour hides antialiasing seams between neighbouring facets.
    ctx.strokeStyle = col;
    ctx.lineWidth = 0.7;
    ctx.stroke();
  }
}

function flat(ctx, P, A, z, fill) {
  ctx.beginPath();
  A.forEach((p, i) => {
    const q = P(p[0], p[1], z);
    if (i) ctx.lineTo(q[0], q[1]); else ctx.moveTo(q[0], q[1]);
  });
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
}

// Runs fn in a flat 2D space laid onto the solid: unit x runs O→A, unit y runs O→B. Skips faces turned
// away from the camera, so a decal never shows through the body.
function decal(ctx, P, O, A, B, fn, always = false) {
  const o = P(...O), a = P(...A), b = P(...B);
  const ax = a[0] - o[0], ay = a[1] - o[1], bx = b[0] - o[0], by = b[1] - o[1];
  const facing = ax * by - ay * bx;
  if (!always && facing >= 0) return false;
  ctx.save();
  ctx.transform(ax, ay, bx, by, o[0], o[1]);
  fn(ctx);
  ctx.restore();
  return true;
}

function paintWheel(ctx, P, x, side) {
  const y = side * (TRUCK_W + 0.2);
  const r = 12.5;
  decal(ctx, P, [x - r, y, 11.5 - r], [x + r, y, 11.5 - r], [x - r, y, 11.5 + r], (c) => {
    // A wheel arch first, then the tyre sits in it, so it looks set into the body.
    ell(c, 0.5, 0.5, 0.56, 0.56, tone(CREAM_LO, -0.34));
    ell(c, 0.5, 0.5, 0.5, 0.5, TYRE);
    ell(c, 0.5, 0.5, 0.29, 0.29, CHROME);
    ell(c, 0.5, 0.5, 0.2, 0.2, CORAL);
    ell(c, 0.47, 0.53, 0.09, 0.09, '#ffffff');
    // Snow in the tread.
    c.strokeStyle = 'rgba(255,255,255,0.7)';
    c.lineWidth = 0.05;
    c.lineCap = 'round';
    c.setLineDash([0.08, 0.15]);
    c.beginPath();
    c.arc(0.5, 0.5, 0.44, 0, TAU);
    c.stroke();
    c.setLineDash([]);
  }, true);
}

function paintCabWindow(ctx, P, side) {
  const y = side * (TRUCK_W - 2.3);
  decal(ctx, P, [40, y, 56], [15, y, 56], [41, y - side * 0.2, 34], (c) => {
    roundRect(c, 0, 0, 1, 1, 0.18);
    c.fillStyle = linGrad(c, 0, 0, 1, 1, ['#e9fbff', GLASS, GLASS_LO]);
    c.fill();
    clipped(c, () => {
      poly(c, [[0.1, 1.1], [0.42, -0.1], [0.62, -0.1], [0.3, 1.1]], 'rgba(255,255,255,0.55)');
    });
  }, true);
}

// A hand-painted sign on the flank: it says what the van sells, with no lettering and no face.
function paintBadge(ctx, P, side) {
  const y = side * (TRUCK_W - 1.6);
  decal(ctx, P, [-37, y, 55], [-54, y, 55], [-37, y, 33], (c) => {
    ell(c, 0.5, 0.5, 0.5, 0.5, CREAM);
    ell(c, 0.5, 0.5, 0.44, 0.44, tone(CORAL, 0.2));
    poly(c, [[0.28, 0.5], [0.72, 0.5], [0.5, 0.92]], '#fff5e2');
    ell(c, 0.5, 0.4, 0.27, 0.21, '#fff5e2');
    ell(c, 0.42, 0.38, 0.13, 0.12, '#ffdf6c');
    ell(c, 0.59, 0.42, 0.12, 0.11, '#7fe3c8');
  }, true);
}

function paintSide(ctx, P, side) {
  const y = side * TRUCK_W;
  const yU = side * (TRUCK_W - 2);
  // A few runs of syrup down from the stripe: a little joke that keeps the cream band from going dead.
  decal(ctx, P, [14, y, 24], [-14, y, 24], [14, y, 11], (c) => {
    const rnd = seeded(side > 0 ? 21 : 34);
    for (let x = 0.08; x < 0.95; x += 0.21 + rnd() * 0.08) {
      const l = 0.16 + rnd() * 0.3;
      capsule(c, x, 0, 0.05, x, l, 0.05 + rnd() * 0.02, CORAL);
    }
  }, true);
  paintCabWindow(ctx, P, side);
  paintBadge(ctx, P, side);
  // Serving hatch under the awning. Warm light, shelves of cups, and nobody home.
  decal(ctx, P, [11, yU, 45], [-35, yU, 45], [11, yU, 30.5], (c) => {
    roundRect(c, 0, 0, 1, 1, 0.14);
    c.fillStyle = '#7c5a6a';
    c.fill();
    clipped(c, () => {
      c.fillStyle = linGrad(c, 0, 0, 0, 1, ['#ffd98a', '#f6b35e', '#c9805a']);
      c.fillRect(0.03, 0.06, 0.94, 0.88);
      for (let i = 0; i < 7; i++) {
        const cx = 0.1 + i * 0.133;
        poly(c, [[cx - 0.04, 0.3], [cx + 0.04, 0.3], [cx + 0.016, 0.76], [cx - 0.016, 0.76]], '#fff7e6');
        ell(c, cx, 0.3, 0.045, 0.15, [CORAL, '#ffe066', MINT][i % 3]);
      }
    });
  }, true);
  decal(ctx, P, [13, side * (TRUCK_W + 1.8), 31], [-37, side * (TRUCK_W + 1.8), 31], [13, side * (TRUCK_W + 1.8), 28.8], (c) => {
    roundRect(c, 0, 0, 1, 1, 0.3);
    c.fillStyle = CHROME;
    c.fill();
  }, true);
}

// The striped awning, a slanted roof of its own. Kept short: straight out from the wall means straight
// down the screen in this camera, and any longer it would hide the hatch beneath it.
function paintAwning(ctx, P, side) {
  const y0 = side * (TRUCK_W - 2.5), y1 = side * (TRUCK_W + AWNING_OUT);
  const x0 = 14, x1 = -38, zTop = 60, zEnd = 53;
  const stripes = 8;
  const w = (x1 - x0) / stripes;
  for (let i = 0; i < stripes; i++) {
    const a = x0 + i * w, b = a + w;
    const col = i % 2 ? CREAM : CORAL;
    poly(ctx, [P(a, y0, zTop), P(b, y0, zTop), P(b, y1, zEnd), P(a, y1, zEnd)], tone(col, side > 0 ? 0.05 : -0.08));
    const e0 = P(a, y1, zEnd), e1 = P(b, y1, zEnd);
    const m = P((a + b) / 2, y1 + side * 1.2, zEnd - 5);
    ctx.beginPath();
    ctx.moveTo(e0[0], e0[1]);
    ctx.quadraticCurveTo(m[0], m[1], e1[0], e1[1]);
    ctx.closePath();
    ctx.fillStyle = tone(col, -0.14);
    ctx.fill();
  }
}

function paintWindscreen(ctx, P) {
  const xb = TRUCK_L - 10.5, xt = TRUCK_L - 16.5;
  decal(ctx, P, [xb, 23, 32], [xb, -23, 32], [xt, 21.5, 58], (c) => {
    roundRect(c, 0, 0, 1, 1, 0.14);
    c.fillStyle = linGrad(c, 0, 1, 1, 0, [GLASS_LO, GLASS, '#effdff']);
    c.fill();
    clipped(c, () => {
      poly(c, [[0.14, 1.1], [0.42, -0.1], [0.58, -0.1], [0.3, 1.1]], 'rgba(255,255,255,0.6)');
      poly(c, [[0.36, 1.1], [0.64, -0.1], [0.68, -0.1], [0.4, 1.1]], 'rgba(255,255,255,0.4)');
    });
  });
}

function paintNose(ctx, P) {
  const x = TRUCK_L + 0.3;
  // Headlights low and far apart: closer in and higher up they start to look like eyes.
  decal(ctx, P, [x, -25, 22], [x, 25, 22], [x, -25, 14], (c) => {
    for (const cx of [0.06, 0.94]) {
      ell(c, cx, 0.5, 0.07, 0.42, CHROME);
      ell(c, cx, 0.5, 0.05, 0.3, '#fff3b0');
    }
  });
  // Slim chrome bumper hugging the nose. It stops short of the corners and stays inside the footprint.
  decal(ctx, P, [x + 1, -21, 13.5], [x + 1, 21, 13.5], [x + 1, -21, 9.5], (c) => {
    roundRect(c, 0, 0, 1, 1, 0.5);
    c.fillStyle = linGrad(c, 0, 0, 0, 1, ['#f2f5fa', CHROME, '#a4b1c4']);
    c.fill();
  });
}

function paintRear(ctx, P, open) {
  const x = -TRUCK_L - 0.2;
  const w = TRUCK_W - 7;
  decal(ctx, P, [x, w, 58], [x, -w, 58], [x, w, 11], (c) => {
    if (open) {
      roundRect(c, 0, 0, 1, 1, 0.06);
      c.fillStyle = '#5a4258';
      c.fill();
      clipped(c, () => {
        c.fillStyle = linGrad(c, 0, 0, 0, 1, ['#ffcf7e', '#e39654', '#8a5a58']);
        c.fillRect(0.05, 0.04, 0.9, 0.92);
        for (const sy of [0.3, 0.56]) {
          c.fillStyle = '#9c6a52';
          c.fillRect(0.05, sy, 0.9, 0.035);
          for (let i = 0; i < 7; i++) {
            const cx = 0.14 + i * 0.12;
            poly(c, [[cx - 0.04, sy - 0.16], [cx + 0.04, sy - 0.16], [cx + 0.012, sy], [cx - 0.012, sy]], '#fff7e6');
          }
        }
        ell(c, 0.5, 1.02, 0.5, 0.2, 'rgba(62,53,96,0.5)');
      });
    } else {
      // Door seam and small square windows. Round ones either side of a centre line are a face, and
      // this van must never have one.
      c.fillStyle = alpha(DARK, 0.34);
      c.fillRect(0.492, 0.02, 0.016, 0.96);
      for (const cx of [0.26, 0.74]) {
        roundRect(c, cx - 0.15, 0.13, 0.3, 0.2, 0.04);
        c.fillStyle = CHROME;
        c.fill();
        roundRect(c, cx - 0.125, 0.15, 0.25, 0.16, 0.03);
        c.fillStyle = GLASS;
        c.fill();
      }
      for (const cx of [0.44, 0.56]) {
        roundRect(c, cx - 0.02, 0.5, 0.04, 0.13, 0.02);
        c.fillStyle = CHROME;
        c.fill();
      }
    }
  });
}

function paintRoof(ctx, P) {
  // Pinstripes stop the biggest flat area on the van going dead.
  const R = footprint(24, 9.5, 10, 11, 8);
  flat(ctx, P, R, ROOF_Z, linGrad(ctx, ...P(30, -24, ROOF_Z), ...P(-40, 24, ROOF_Z), ['#fffaf0', CREAM, CREAM_LO]));
  const stripe = (y) => {
    const a = P(TRUCK_L - 30, y, ROOF_Z), b = P(-TRUCK_L + 17, y, ROOF_Z);
    line(ctx, a[0], a[1], b[0], b[1], CORAL, 2.6);
  };
  stripe(-13);
  stripe(13);
  // The little chime horn, front of the roof.
  const h = P(22, 0, ROOF_Z), t = P(22, 0, ROOF_Z + 10), m = P(30, 0, ROOF_Z + 14);
  line(ctx, h[0], h[1], t[0], t[1], '#b8a184', 3);
  ell(ctx, h[0], h[1], 4.5, 3, tone(CREAM_LO, -0.2));
  const ha = Math.atan2(m[1] - t[1], m[0] - t[0]);
  ctx.save();
  ctx.translate(t[0], t[1]);
  ctx.rotate(ha);
  poly(ctx, [[-2, -1.4], [9, -5.6], [9, 5.6], [-2, 1.4]], '#f0b73a');
  ell(ctx, 9, 0, 2.2, 5.6, '#c9922c');
  ctx.restore();
  // The turret's swivel ring.
  const b = P(-8, 0, ROOF_Z);
  ell(ctx, b[0], b[1], 16, 13.5, tone(MINT_LO, -0.16));
  ell(ctx, b[0], b[1] - 1, 14.5, 12, MINT);
  ell(ctx, b[0], b[1] - 1, 8.5, 7, MINT_LO);
}

const boxMemo = new Map();

export function truckBox(h) {
  let b = boxMemo.get(h);
  if (b) return b;
  const c = Math.abs(Math.cos(h)), s = Math.abs(Math.sin(h));
  const hw = c * TRUCK_L + s * (TRUCK_W + AWNING_OUT);
  const hh = s * TRUCK_L + c * (TRUCK_W + AWNING_OUT);
  const w = Math.ceil(hw * 2 + 20), top = Math.ceil(hh + ROOF_Z * Z + 22), bot = Math.ceil(hh + 18);
  b = { w, h: top + bot, ax: w / 2, ay: top };
  boxMemo.set(h, b);
  return b;
}

export function paintTruck(ctx, h, open) {
  const P = projector(h);
  const base = footprint(0, 0, 0);
  // Tyres under the body show from nose-on and tail-on, where side wheels can't be seen.
  for (const [x, y] of [[32, 24], [32, -24], [-32, 24], [-32, -24]]) {
    const q = P(x, y, 6);
    ell(ctx, q[0], q[1] + 1, 12, 9, tone(TYRE, -0.1));
  }
  const far = (side) => {
    const a = P(0, side, 0);
    return a[1] < P(0, 0, 0)[1];
  };
  if (far(1)) paintAwning(ctx, P, 1);
  if (far(-1)) paintAwning(ctx, P, -1);
  const under = footprint(2, 1.5, 2);
  loft(ctx, P, under, 6, base, 11, tone(CREAM_LO, -0.34), 0.6);
  loft(ctx, P, base, 11, base, 24, CREAM);
  for (const sd of [1, -1]) {
    if (far(sd)) continue;
    paintWheel(ctx, P, 31, sd);
    paintWheel(ctx, P, -31, sd);
  }
  loft(ctx, P, base, 24, base, 28, CORAL);
  flat(ctx, P, base, 28, tone(MINT, 0.14));
  const shelf = footprint(8.5, 1.4, 0.5);
  const top = footprint(16, 4, 2.5);
  const crown = footprint(23, 9, 9.5, 11, 8);
  loft(ctx, P, shelf, 28.5, top, 60, MINT);
  loft(ctx, P, top, 60, crown, ROOF_Z, tone(MINT, 0.3));
  paintWindscreen(ctx, P);
  paintNose(ctx, P);
  paintRear(ctx, P, open);
  for (const sd of [1, -1]) {
    if (!far(sd)) paintSide(ctx, P, sd);
  }
  paintRoof(ctx, P);
  if (!far(1)) paintAwning(ctx, P, 1);
  if (!far(-1)) paintAwning(ctx, P, -1);
}

// Door leaves are live: they swing through every angle, and at most one truck is ever on the field.
export function paintDoorLeaves(ctx, h, x, y, open) {
  const P0 = projector(h);
  const P = (a, b, z) => {
    const q = P0(a, b, z);
    return [q[0] + x, q[1] + y];
  };
  const w = TRUCK_W - 7;
  const hingeX = -TRUCK_L - 0.5;
  const phi = open * 1.92;
  for (let side = -1; side <= 1; side += 2) {
    const hy = side * w;
    const fx = hingeX - w * Math.sin(phi), fy = hy - side * w * Math.cos(phi);
    const a = P(hingeX, hy, 11), b = P(fx, fy, 11), c = P(fx, fy, 58), d = P(hingeX, hy, 58);
    const ax = b[0] - a[0], ay = b[1] - a[1], bx = d[0] - a[0], by = d[1] - a[1];
    const outer = (ax * by - ay * bx) * side > 0;
    const col = outer ? tone(CREAM, -0.02) : tone(MINT, -0.12);
    poly(ctx, [a, b, c, d], col);
    // Mint top half, coral belt, cream skirt, so an open door still reads as a piece of the van.
    const t0 = (k) => [a[0] + bx * k, a[1] + by * k];
    const t1 = (k) => [b[0] + bx * k, b[1] + by * k];
    poly(ctx, [t0(0.5), t1(0.5), t1(1), t0(1)], outer ? MINT : tone(MINT, -0.2));
    poly(ctx, [t0(0.42), t1(0.42), t1(0.5), t0(0.5)], CORAL);
    const m = [a[0] + ax * 0.5 + bx * 0.76, a[1] + ay * 0.5 + by * 0.76];
    ctx.save();
    ctx.transform(ax / w, ay / w, bx / 47, by / 47, m[0], m[1]);
    roundRect(ctx, -7, -5, 14, 10, 2);
    ctx.fillStyle = CHROME;
    ctx.fill();
    roundRect(ctx, -6, -4, 12, 8, 1.6);
    ctx.fillStyle = GLASS;
    ctx.fill();
    ctx.restore();
  }
}

// The turret: a giant paper cone holding one enormous scoop, tipped towards whatever it is shooting at.
export function paintCone(ctx, aim) {
  const beta = 0.72;
  const sb = Math.sin(beta), cb = Math.cos(beta);
  const d = [Math.cos(aim) * sb, Math.sin(aim) * sb, cb];
  const u = [-Math.sin(aim), Math.cos(aim), 0];
  const v = [d[1] * u[2] - d[2] * u[1], d[2] * u[0] - d[0] * u[2], d[0] * u[1] - d[1] * u[0]];
  const L = 42, R = 18;
  const proj = (p) => [p[0], p[1] - p[2] * Z];
  const at = (t) => [0, 1, 2].map((i) => d[i] * L + (u[i] * Math.cos(t) + v[i] * Math.sin(t)) * R);
  const N = 20;
  const pts = [];
  for (let i = 0; i < N; i++) pts.push(at((i / N) * TAU));
  // The cone is convex, so whichever gores wind the right way on screen are the ones facing us.
  for (let i = 0; i < N; i++) {
    const pa = proj(pts[i]), pb = proj(pts[(i + 1) % N]);
    const area = pa[0] * pb[1] - pb[0] * pa[1];
    if (area >= 0) continue;
    const nx = (pa[0] + pb[0]) / 2;
    const k = -nx / (R * 1.4);
    const col = i % 4 < 2 ? '#fff5e2' : '#f7b0c0';
    const shade = tone(col, k >= 0 ? k * 0.14 : k * 0.34);
    poly(ctx, [[0, 0], pa, pb], shade);
    ctx.strokeStyle = shade;
    ctx.lineWidth = 0.5;
    ctx.stroke();
  }
  // A sphere looks round from every angle, so the scoop is simply drawn last, sitting in the mouth.
  const m = proj([d[0] * (L + 3), d[1] * (L + 3), d[2] * (L + 3)]);
  const r = R * 1.1;
  ctx.beginPath();
  ctx.ellipse(m[0], m[1], r, r, 0, 0, TAU);
  ctx.fillStyle = '#f58aa4';
  ctx.fill();
  clipped(ctx, () => {
    ell(ctx, m[0] + r * 0.82, m[1] - r * 0.1, r * 0.92, r * 1.1, '#ffdf6c', 0.3);
    ell(ctx, m[0] + r * 0.1, m[1] + r * 0.94, r * 1.2, r * 0.74, '#7fe3c8', -0.12);
    ell(ctx, m[0] + r * 0.46, m[1] + r * 0.62, r * 1.02, r * 0.62, alpha('#3f3572', 0.13), -0.5);
    ell(ctx, m[0] - r * 0.36, m[1] - r * 0.46, r * 0.32, r * 0.2, 'rgba(255,255,255,0.8)', -0.5);
    // Shaved ice: pale grains, thickest where the syrups meet, so the joins read as soft.
    const rnd = seeded(6);
    for (let i = 0; i < 30; i++) {
      const a = rnd() * TAU, q = Math.sqrt(rnd()) * r;
      ell(ctx, m[0] + Math.cos(a) * q, m[1] + Math.sin(a) * q, 1.2, 1, 'rgba(255,255,255,0.5)');
    }
  });
}

export const CONE_BOX = Object.freeze({ w: 116, h: 112, ax: 58, ay: 74 });

// Where on screen the cone stands for a given heading, relative to the truck's ground point.
export function coneSeat(h) {
  const q = projector(h)(-8, 0, ROOF_Z);
  return { x: q[0], y: q[1] - 1 };
}

// Which door leaves draw behind the body at this heading.
export function rearFacesCamera(h) {
  const P = projector(h);
  return P(-1, 0, 0)[1] > P(0, 0, 0)[1];
}
