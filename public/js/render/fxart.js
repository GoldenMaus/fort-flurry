// One atlas for every particle, so a storm of puffs stays a single texture on the GPU.
import { TAU, makeRng, makeCanvas, withAlpha, radial, orb, closedCurve, blobPoints } from './paint.js';

export const FX = Object.freeze({
  PUFF: 0, PUFF_SHADE: 1, CHUNK: 2, SHARD: 3, GOLD: 4, STAR: 5, FLAKE: 6, RING: 7, STEAM: 8, SMOKE: 9, WOOD: 10,
  CONF_R: 11, CONF_B: 12, CONF_Y: 13, CONF_G: 14, SLUSH: 15, DROP: 16, DUST: 17, HEAT: 18, FLASH: 19,
});

const CELL_PX = 64;
const COLS = 5;
const ROWS = 4;

function puff(g, color, rim) {
  g.fillStyle = radial(g, 0, 0, 0, 30, [[0, color], [0.55, withAlpha(rim, 0.86)], [1, withAlpha(rim, 0)]]);
  g.beginPath();
  g.arc(0, 0, 30, 0, TAU);
  g.fill();
}

function star(g, color, r = 28, waist = 0.1) {
  g.fillStyle = color;
  g.beginPath();
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * TAU - Math.PI / 2;
    const d = i % 2 ? r * waist : r;
    if (i === 0) g.moveTo(Math.cos(a) * d, Math.sin(a) * d);
    else g.lineTo(Math.cos(a) * d, Math.sin(a) * d);
  }
  g.closePath();
  g.fill();
}

function shard(g, a, b) {
  g.beginPath();
  g.moveTo(0, -28);
  g.lineTo(10, -6);
  g.lineTo(3, 26);
  g.lineTo(-9, 2);
  g.closePath();
  g.fillStyle = a;
  g.fill();
  g.beginPath();
  g.moveTo(0, -28);
  g.lineTo(10, -6);
  g.lineTo(3, 26);
  g.closePath();
  g.fillStyle = b;
  g.fill();
}

function confetti(g, color) {
  g.fillStyle = color;
  g.beginPath();
  g.moveTo(-16, -9);
  g.quadraticCurveTo(0, -15, 16, -9);
  g.lineTo(16, 9);
  g.quadraticCurveTo(0, 3, -16, 9);
  g.closePath();
  g.fill();
}

const PAINT = [
  (g) => puff(g, '#ffffff', '#f2f5fe'),
  (g) => puff(g, '#d5dbf4', '#bfc4ec'),
  (g, rng) => {
    g.beginPath();
    closedCurve(g, blobPoints(0, 0, 25, 22, rng, 0.2, 7));
    g.fillStyle = orb(g, 0, 0, 26, ['#ffffff', '#f2f5fe', '#c3c7ec']);
    g.fill();
  },
  (g) => shard(g, '#e4fbff', '#8edcf4'),
  (g) => { star(g, '#ffe48c', 30, 0.16); star(g, '#fff8dc', 16, 0.16); },
  (g) => {
    g.fillStyle = radial(g, 0, 0, 0, 30, [[0, 'rgba(255,255,255,0.75)'], [1, 'rgba(255,255,255,0)']]);
    g.beginPath();
    g.arc(0, 0, 30, 0, TAU);
    g.fill();
    star(g, '#ffffff', 28, 0.08);
  },
  (g) => {
    g.strokeStyle = '#ffffff';
    g.lineWidth = 4;
    g.lineCap = 'round';
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI;
      const dx = Math.cos(a) * 24;
      const dy = Math.sin(a) * 24;
      g.beginPath();
      g.moveTo(-dx, -dy);
      g.lineTo(dx, dy);
      g.stroke();
    }
  },
  (g) => {
    g.fillStyle = radial(g, 0, 0, 16, 30, [[0, 'rgba(255,255,255,0)'], [0.62, 'rgba(255,255,255,0.72)'], [0.8, 'rgba(255,255,255,0.9)'], [1, 'rgba(255,255,255,0)']]);
    g.beginPath();
    g.arc(0, 0, 30, 0, TAU);
    g.fill();
  },
  (g) => puff(g, 'rgba(255,255,255,0.72)', '#f8f4f2'),
  (g) => puff(g, 'rgba(190,178,206,0.8)', '#b4a8c8'),
  (g) => {
    g.beginPath();
    g.moveTo(-26, -6);
    g.lineTo(26, -9);
    g.lineTo(22, 7);
    g.lineTo(-23, 9);
    g.closePath();
    g.fillStyle = '#c0916a';
    g.fill();
  },
  (g) => confetti(g, '#e6505a'),
  (g) => confetti(g, '#4f8fe0'),
  (g) => confetti(g, '#f4c34e'),
  (g) => confetti(g, '#5fc08c'),
  (g, rng) => {
    g.beginPath();
    closedCurve(g, blobPoints(0, 0, 24, 22, rng, 0.2, 7));
    g.fillStyle = orb(g, 0, 0, 26, ['#dceaf4', '#8fb2d2', '#5f7fb0']);
    g.fill();
  },
  (g) => {
    g.beginPath();
    g.moveTo(0, -26);
    g.quadraticCurveTo(16, 2, 13, 13);
    g.arc(0, 13, 13, 0, Math.PI);
    g.quadraticCurveTo(-16, 2, 0, -26);
    g.fillStyle = '#d4f2fb';
    g.fill();
  },
  (g) => puff(g, '#f6f2ee', '#e3dce8'),
  (g) => {
    g.fillStyle = radial(g, 0, 0, 0, 30, [[0, 'rgba(255,190,110,0.9)'], [1, 'rgba(255,170,90,0)']]);
    g.beginPath();
    g.arc(0, 0, 30, 0, TAU);
    g.fill();
  },
  (g) => {
    g.fillStyle = radial(g, 0, 0, 0, 30, [[0, 'rgba(255,255,255,0.95)'], [0.5, 'rgba(255,255,255,0.5)'], [1, 'rgba(255,255,255,0)']]);
    g.beginPath();
    g.arc(0, 0, 30, 0, TAU);
    g.fill();
  },
];

export function bakeFxAtlas() {
  const canvas = makeCanvas(COLS * CELL_PX, ROWS * CELL_PX);
  const g = canvas.getContext('2d');
  const rng = makeRng(77);
  PAINT.forEach((paint, i) => {
    g.save();
    g.translate((i % COLS) * CELL_PX + CELL_PX / 2, Math.floor(i / COLS) * CELL_PX + CELL_PX / 2);
    paint(g, rng);
    g.restore();
  });
  const cells = new Int16Array(PAINT.length * 2);
  for (let i = 0; i < PAINT.length; i++) {
    cells[i * 2] = (i % COLS) * CELL_PX;
    cells[i * 2 + 1] = Math.floor(i / COLS) * CELL_PX;
  }
  return { canvas, cells, size: CELL_PX };
}
