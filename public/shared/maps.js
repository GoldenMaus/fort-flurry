// Fort Flurry — the three neighbourhood battlegrounds (SPEC section 6).
//
// Fairness rule shared by all three: everything solid is authored for the west
// half and mirrored across the Face-Off rope, so neither team ever has the better
// side. Mirrored pieces may change costume (a slide opposite the monkey bars), but
// never footprint or collision.

// Collision and height per obstacle type. `blocksBalls:false` on something tall means
// kids must go around it but can still throw through it, which is what makes the
// schoolyard fences interesting.
const OBSTACLE_DEFAULTS = Object.freeze({
  house:      { blocksMove: true,  blocksBalls: true,  height: 110 },
  tree:       { blocksMove: true,  blocksBalls: true,  height: 120 },
  pine:       { blocksMove: true,  blocksBalls: true,  height: 130 },
  car:        { blocksMove: true,  blocksBalls: true,  height: 44 },
  fence:      { blocksMove: true,  blocksBalls: true,  height: 42 },
  lamp:       { blocksMove: true,  blocksBalls: false, height: 130 },
  rock:       { blocksMove: true,  blocksBalls: true,  height: 42 },
  bench:      { blocksMove: true,  blocksBalls: true,  height: 28 },
  swing:      { blocksMove: false, blocksBalls: false, height: 90 },
  slide:      { blocksMove: true,  blocksBalls: true,  height: 70 },
  bush:       { blocksMove: true,  blocksBalls: true,  height: 36 },
  mailbox:    { blocksMove: true,  blocksBalls: false, height: 40 },
  hydrant:    { blocksMove: true,  blocksBalls: false, height: 28 },
  monkeybars: { blocksMove: true,  blocksBalls: false, height: 80 },
  bin:        { blocksMove: true,  blocksBalls: true,  height: 36 },
  schoolwall: { blocksMove: true,  blocksBalls: true,  height: 130 },
});

const LAMP_GLOW = '#ffd58a';
const WINDOW_GLOW = '#ffb95e';
const SCHOOL_GLOW = '#ffe2a8';
const LANTERN_GLOW = '#ffc97a';

function box(type, x, y, w, h, extra) {
  return { type, shape: 'rect', x, y, w, h, ...OBSTACLE_DEFAULTS[type], rot: h > w ? 90 : 0, variant: 0, ...extra };
}

function dot(type, x, y, r, extra) {
  return { type, shape: 'circle', x, y, r, ...OBSTACLE_DEFAULTS[type], rot: 0, variant: 0, ...extra };
}

function mirrorX(item, axis) {
  if (item.shape === 'rect') return { ...item, x: 2 * axis - item.x - item.w };
  return { ...item, x: 2 * axis - item.x };
}

// Copies the west-half obstacles to the east half. `dress` lets a pair differ in looks:
// a function from the original to the fields the east twin overrides.
function withTwins(west, axis, dress = () => ({})) {
  const east = west.map((o) => ({ ...mirrorX(o, axis), ...dress(o) }));
  return [...west, ...east];
}

const twinPoints = (points, axis) => [...points, ...points.map((p) => ({ ...p, x: 2 * axis - p.x }))];
const twinList = (points, axis) => points.map((p) => ({ ...p, x: 2 * axis - p.x }));
const lamp = (x, y) => ({ x, y, r: 190, color: LAMP_GLOW });
const glow = (x, y) => ({ x, y, r: 80, color: WINDOW_GLOW });

// The Colonel keeps a lantern lit. Fights happen around him, so night must never hide them.
const fortGlows = (fort, forts) => [fort, ...forts].map(({ x, y }) => ({ x, y, r: 240, color: LANTERN_GLOW }));

// ---- Maple Court --------------------------------------------------------------
// A cul-de-sac. The Colonel holds the snowy island in the middle of the turnaround.
// Three streets feed the ring road, and parked cars sit outside the kerb so the road
// itself stays drivable for a certain ice-cold vendor.
function mapleCourt() {
  const W = 1840, H = 1280, AX = 920;
  const fort = { x: 920, y: 600 };
  const forts = [{ x: 440, y: 600 }, { x: 1400, y: 600 }];

  const west = [
    // Front row of houses around the edge, largest in the corners.
    box('house', 40, 40, 280, 200, { variant: 0 }),
    box('house', 400, 40, 240, 160, { variant: 1 }),
    box('house', 40, 320, 200, 160, { variant: 2 }),
    box('house', 40, 780, 240, 180, { variant: 3 }),
    box('house', 40, 1060, 220, 180, { variant: 4 }),
    box('house', 400, 1060, 240, 180, { variant: 5 }),

    // Backyard fences close the gaps, so the fight stays on the street side.
    box('fence', 322, 110, 78, 10),
    box('fence', 640, 110, 160, 10),
    box('fence', 130, 240, 10, 80),
    box('fence', 130, 960, 10, 100),
    box('fence', 260, 1150, 140, 10),

    // Parked cars. Kerbside only: they cut the long street sight-lines into short
    // hops without ever narrowing a lane below what Steve needs.
    box('car', 30, 504, 120, 46, { variant: 0 }),
    box('car', 230, 650, 120, 46, { variant: 1 }),
    box('car', 500, 226, 120, 56, { variant: 2 }),
    box('car', 500, 924, 120, 56, { variant: 3 }),
    box('car', 806, 1110, 46, 120, { variant: 4 }),

    // Maples and hedges on the lawns give the diagonals their cover.
    dot('tree', 330, 300, 26, { variant: 0 }),
    dot('tree', 672, 160, 24, { variant: 1 }),
    dot('tree', 360, 1000, 26, { variant: 1 }),
    dot('tree', 700, 1060, 26, { variant: 0 }),
    dot('bush', 436, 262, 18),
    dot('bush', 300, 370, 18),
    dot('bush', 330, 860, 18),
    dot('bush', 442, 1016, 18),
    dot('bush', 594, 1030, 18),

    // Kerb furniture.
    dot('lamp', 250, 492, 8),
    dot('lamp', 250, 708, 8),
    dot('lamp', 660, 214, 8),
    dot('lamp', 650, 1000, 8),
    dot('lamp', 790, 1210, 8),
    dot('mailbox', 196, 492, 9, { variant: 0 }),
    dot('mailbox', 520, 210, 9, { variant: 1 }),
    dot('mailbox', 200, 708, 9, { variant: 2 }),
    dot('mailbox', 520, 1044, 9, { variant: 3 }),
    dot('hydrant', 790, 1000, 10),
    dot('bin', 330, 760, 14),
    dot('bin', 186, 262, 14),
  ];

  const centre = [
    box('house', 800, 40, 240, 130, { variant: 6 }),
  ];

  const obstacles = [...withTwins(west, AX, (o) => (o.type === 'house' || o.type === 'car' ? { variant: o.variant + 7 } : {})), ...centre];

  // Sixteen-sided ring so the Truck rounds the turnaround instead of cutting corners.
  const ring = [];
  for (let i = 0; i < 16; i++) {
    const a = Math.PI / 2 + (i * Math.PI) / 8;
    ring.push({ x: Math.round(fort.x + 345 * Math.cos(a)), y: Math.round(fort.y + 345 * Math.sin(a)) });
  }

  const windows = [
    ...[[110, 244], [250, 244], [470, 204], [570, 204], [90, 484], [190, 484]].map(([x, y]) => glow(x, y)),
    ...[[100, 964], [220, 964], [90, 1244], [200, 1244]].map(([x, y]) => glow(x, y)),
    ...[[470, 1244], [570, 1244]].map(([x, y]) => glow(x, y)),
  ];

  return {
    id: 'court', theme: 'court', name: 'Maple Court',
    blurb: 'A friendly cul-de-sac. Three streets in, parked cars for cover, and a snowy island for your fort.',
    w: W, h: H, obstacles,
    // Frozen puddles out on the ring road: a free slide if you meant it, a hazard if not.
    ice: [
      { shape: 'ellipse', x: 660, y: 330, rx: 70, ry: 40 },
      { shape: 'ellipse', x: 1180, y: 330, rx: 70, ry: 40 },
      { shape: 'ellipse', x: 640, y: 860, rx: 60, ry: 36 },
      { shape: 'ellipse', x: 1200, y: 860, rx: 60, ry: 36 },
    ],
    fort,
    forts,
    truce: { axis: 'x', at: AX },
    spawns: {
      siege: [
        { x: 810, y: 600 }, { x: 1030, y: 600 }, { x: 920, y: 490 }, { x: 920, y: 710 },
        { x: 840, y: 520 }, { x: 1000, y: 520 }, { x: 840, y: 680 }, { x: 1000, y: 680 },
      ],
      fortwars: [
        [
          { x: 330, y: 540 }, { x: 330, y: 600 }, { x: 372, y: 664 }, { x: 390, y: 500 },
          { x: 400, y: 710 }, { x: 280, y: 570 }, { x: 280, y: 620 }, { x: 450, y: 480 },
        ],
        twinList([
          { x: 330, y: 540 }, { x: 330, y: 600 }, { x: 372, y: 664 }, { x: 390, y: 500 },
          { x: 400, y: 710 }, { x: 280, y: 570 }, { x: 280, y: 620 }, { x: 450, y: 480 },
        ], AX),
      ],
      ffa: [
        { x: 440, y: 340 }, { x: 1400, y: 340 }, { x: 440, y: 860 }, { x: 1400, y: 860 },
        { x: 920, y: 600 }, { x: 920, y: 1120 }, { x: 150, y: 600 }, { x: 1690, y: 600 },
        { x: 720, y: 280 }, { x: 1120, y: 280 }, { x: 760, y: 900 }, { x: 1080, y: 900 },
      ],
    },
    entrances: [{ x: 30, y: 600 }, { x: W - 30, y: 600 }, { x: 920, y: H - 30 }],
    truckPath: ring,
    lights: [
      ...twinPoints([lamp(250, 492), lamp(250, 708), lamp(660, 214), lamp(650, 1000), lamp(790, 1210)], AX),
      ...twinPoints(windows, AX),
      glow(860, 174), glow(980, 174),
      ...fortGlows(fort, forts),
    ],
    decor: [
      { type: 'road', points: [...ring, ring[0]], width: 130 },
      { type: 'road', points: [{ x: 0, y: 600 }, { x: 560, y: 600 }], width: 200 },
      { type: 'road', points: [{ x: W, y: 600 }, { x: W - 560, y: 600 }], width: 200 },
      { type: 'road', points: [{ x: 920, y: H }, { x: 920, y: 955 }], width: 240 },
      { type: 'path', points: [{ x: 140, y: 482 }, { x: 140, y: 500 }], width: 56 },
      { type: 'path', points: [{ x: 1700, y: 482 }, { x: 1700, y: 500 }], width: 56 },
      { type: 'path', points: [{ x: 160, y: 776 }, { x: 160, y: 700 }], width: 56 },
      { type: 'path', points: [{ x: 1680, y: 776 }, { x: 1680, y: 700 }], width: 56 },
      { type: 'path', points: [{ x: 520, y: 200 }, { x: 560, y: 226 }], width: 50 },
      { type: 'path', points: [{ x: 1320, y: 200 }, { x: 1280, y: 226 }], width: 50 },
      { type: 'path', points: [{ x: 520, y: 1056 }, { x: 560, y: 980 }], width: 50 },
      { type: 'path', points: [{ x: 1320, y: 1056 }, { x: 1280, y: 980 }], width: 50 },
      { type: 'path', points: [{ x: 920, y: 172 }, { x: 920, y: 200 }], width: 60 },
      { type: 'snowpatch', x: 340, y: 780, w: 180, h: 110 },
      { type: 'snowpatch', x: 1320, y: 780, w: 180, h: 110 },
      { type: 'snowpatch', x: 700, y: 950, w: 120, h: 60 },
      { type: 'snowpatch', x: 1020, y: 950, w: 120, h: 60 },
      { type: 'drift', x: 760, y: 470, scale: 1.2 },
      { type: 'drift', x: 1080, y: 720, scale: 1.4 },
      { type: 'drift', x: 470, y: 330, scale: 1 },
      { type: 'drift', x: 1380, y: 900, scale: 1.2 },
      { type: 'drift', x: 1450, y: 340, scale: 1.1 },
      { type: 'drift', x: 420, y: 880, scale: 0.9 },
      { type: 'sled', x: 1046, y: 500, scale: 1 },
      { type: 'sled', x: 1540, y: 750, scale: 0.9 },
      { type: 'shovel', x: 800, y: 700 },
      { type: 'shovel', x: 200, y: 290 },
      { type: 'shovel', x: 1520, y: 1000 },
      { type: 'hopscotch', x: 1240, y: 780 },
      { type: 'hopscotch', x: 380, y: 440, scale: 0.9 },
      { type: 'tiretracks', x: 300, y: 590 },
      { type: 'tiretracks', x: 1520, y: 610 },
      { type: 'tiretracks', x: 930, y: 1080 },
      { type: 'tiretracks', x: 620, y: 420 },
      { type: 'tiretracks', x: 1210, y: 440 },
    ],
  };
}

// ---- Wobble Pond --------------------------------------------------------------
// The ice is a union of lobes. The format has no holes, so the island and bridges
// exist by the lobes stopping short of them; that scalloped edge also happens to be
// what gives the shoreline its wobble.
function wobblePond() {
  const W = 2000, H = 1360, AX = 1000;
  const fort = { x: 1000, y: 680 };
  const forts = [{ x: 360, y: 680 }, { x: 1640, y: 680 }];

  // West-side lobes, twinned east so Face-Off stays fair. North and south shores differ
  // on purpose: a pond with four identical corners reads as a logo, not a pond.
  const lobes = [
    // North shore: two big bays.
    { shape: 'ellipse', x: 700, y: 270, rx: 240, ry: 170 },
    { shape: 'ellipse', x: 396, y: 300, rx: 236, ry: 160 },
    { shape: 'ellipse', x: 600, y: 462, rx: 130, ry: 84 },
    // Lobes that hug the island's north-west shore.
    { shape: 'ellipse', x: 850, y: 395, rx: 86, ry: 62 },
    { shape: 'ellipse', x: 762, y: 440, rx: 92, ry: 62 },
    { shape: 'ellipse', x: 692, y: 525, rx: 70, ry: 78 },
    // Straight edges where the ice meets the bridges.
    { shape: 'rect', x: 880, y: 170, w: 60, h: 250 },
    { shape: 'rect', x: 540, y: 540, w: 150, h: 80 },
    // South shore: one long bay and a deep cove.
    { shape: 'ellipse', x: 716, y: 1076, rx: 224, ry: 160 },
    { shape: 'ellipse', x: 430, y: 1060, rx: 250, ry: 136 },
    { shape: 'ellipse', x: 590, y: 1160, rx: 120, ry: 80 },
    { shape: 'ellipse', x: 610, y: 900, rx: 124, ry: 84 },
    // Lobes that hug the island's south-west shore.
    { shape: 'ellipse', x: 850, y: 965, rx: 86, ry: 62 },
    { shape: 'ellipse', x: 762, y: 920, rx: 92, ry: 62 },
    { shape: 'ellipse', x: 692, y: 835, rx: 70, ry: 78 },
    { shape: 'rect', x: 880, y: 940, w: 60, h: 240 },
    { shape: 'rect', x: 540, y: 740, w: 150, h: 80 },
  ];
  const ice = [...lobes, ...lobes.map((l) => (l.shape === 'rect' ? { ...l, x: 2 * AX - l.x - l.w } : { ...l, x: 2 * AX - l.x }))];

  const west = [
    // North bank pines, thinned out wherever skaters come through.
    dot('pine', 130, 76, 24, { variant: 0 }),
    dot('pine', 250, 50, 22, { variant: 1 }),
    dot('pine', 560, 60, 24, { variant: 0 }),
    dot('pine', 700, 44, 20, { variant: 2 }),
    dot('pine', 860, 66, 24, { variant: 1 }),
    dot('rock', 430, 76, 26, { variant: 0 }),
    dot('rock', 790, 92, 18, { variant: 1 }),

    // West bank and the Face-Off peninsula's flanks.
    dot('pine', 60, 240, 24, { variant: 1 }),
    dot('pine', 96, 390, 22, { variant: 2 }),
    dot('rock', 60, 500, 26, { variant: 1 }),
    dot('pine', 170, 500, 22, { variant: 0 }),
    dot('pine', 60, 860, 24, { variant: 0 }),
    dot('rock', 170, 860, 24, { variant: 0 }),
    dot('pine', 96, 1004, 22, { variant: 2 }),
    dot('pine', 60, 1130, 24, { variant: 1 }),

    // South bank.
    dot('pine', 130, 1286, 24, { variant: 2 }),
    dot('rock', 260, 1310, 26, { variant: 1 }),
    dot('pine', 430, 1290, 22, { variant: 0 }),
    dot('pine', 560, 1312, 24, { variant: 1 }),
    dot('rock', 700, 1282, 20, { variant: 0 }),
    dot('pine', 860, 1300, 24, { variant: 2 }),

    // Boulders at the island's waist give the middle something to duck behind.
    dot('rock', 716, 610, 20, { variant: 2 }),
    dot('rock', 716, 750, 20, { variant: 1 }),
    dot('bush', 500, 500, 18),
    dot('bush', 500, 860, 18),

    // Where the grown-ups sit and lace skates.
    box('bench', 220, 430, 90, 24),
    box('bench', 220, 910, 90, 24, { variant: 1 }),
    dot('bin', 330, 442, 14),
    dot('lamp', 506, 596, 8),
    dot('lamp', 506, 764, 8),
    dot('lamp', 924, 96, 8),
    dot('lamp', 924, 1264, 8),
  ];

  const obstacles = withTwins(west, AX, (o) => ({ variant: (o.variant + 1) % 3 }));

  const loop = [];
  for (let i = 0; i < 12; i++) {
    const a = Math.PI / 2 + (i * Math.PI) / 6;
    loop.push({ x: Math.round(fort.x + 440 * Math.cos(a)), y: Math.round(fort.y + 420 * Math.sin(a)) });
  }

  return {
    id: 'pond', theme: 'pond', name: 'Wobble Pond',
    blurb: 'An island fort on a frozen pond. Foes skate in from every side, and you can only pack on dry snow.',
    w: W, h: H, obstacles, ice, fort, forts,
    truce: { axis: 'x', at: AX },
    spawns: {
      siege: [
        { x: 890, y: 680 }, { x: 1110, y: 680 }, { x: 1000, y: 570 }, { x: 1000, y: 790 },
        { x: 920, y: 600 }, { x: 1080, y: 600 }, { x: 920, y: 760 }, { x: 1080, y: 760 },
      ],
      fortwars: [
        [
          { x: 250, y: 620 }, { x: 250, y: 680 }, { x: 250, y: 740 }, { x: 310, y: 580 },
          { x: 310, y: 780 }, { x: 200, y: 650 }, { x: 200, y: 710 }, { x: 370, y: 560 },
        ],
        twinList([
          { x: 250, y: 620 }, { x: 250, y: 680 }, { x: 250, y: 740 }, { x: 310, y: 580 },
          { x: 310, y: 780 }, { x: 200, y: 650 }, { x: 200, y: 710 }, { x: 370, y: 560 },
        ], AX),
      ],
      ffa: [
        { x: 1000, y: 680 }, { x: 360, y: 680 }, { x: 1640, y: 680 }, { x: 1000, y: 150 },
        { x: 1000, y: 1210 }, { x: 240, y: 180 }, { x: 1760, y: 180 }, { x: 240, y: 1180 },
        { x: 1760, y: 1180 }, { x: 860, y: 520 }, { x: 1140, y: 840 },
      ],
    },
    entrances: [
      { x: 1000, y: 30 }, { x: 1000, y: H - 30 }, { x: 30, y: 680 }, { x: W - 30, y: 680 },
      { x: 340, y: 30 }, { x: W - 340, y: H - 30 },
    ],
    truckPath: loop,
    lights: [
      ...twinPoints([lamp(506, 596), lamp(506, 764), lamp(924, 96), lamp(924, 1264)], AX),
      ...fortGlows(fort, forts),
    ],
    decor: [
      { type: 'bridge', x: 940, y: 90, w: 120, h: 380 },
      { type: 'bridge', x: 940, y: 890, w: 120, h: 380 },
      { type: 'bridge', x: 520, y: 620, w: 210, h: 120 },
      { type: 'bridge', x: 1270, y: 620, w: 210, h: 120 },
      { type: 'reeds', x: 760, y: 520 }, { type: 'reeds', x: 1240, y: 520 },
      { type: 'reeds', x: 760, y: 840, scale: 1.2 }, { type: 'reeds', x: 1240, y: 840, scale: 1.2 },
      { type: 'reeds', x: 930, y: 450 }, { type: 'reeds', x: 1070, y: 910 },
      { type: 'reeds', x: 560, y: 480, scale: 0.8 }, { type: 'reeds', x: 1440, y: 880, scale: 0.8 },
      { type: 'reeds', x: 170, y: 300, scale: 1.1 }, { type: 'reeds', x: 1830, y: 340 },
      { type: 'reeds', x: 200, y: 1100 }, { type: 'reeds', x: 1800, y: 1060, scale: 1.1 },
      { type: 'reeds', x: 640, y: 106, scale: 0.9 }, { type: 'reeds', x: 1360, y: 1250, scale: 0.9 },
      { type: 'reeds', x: 460, y: 410, scale: 0.8 }, { type: 'reeds', x: 1540, y: 950, scale: 0.8 },
      { type: 'drift', x: 860, y: 780, scale: 1.2 }, { type: 'drift', x: 1120, y: 560, scale: 1.3 },
      { type: 'drift', x: 300, y: 860 }, { type: 'drift', x: 1700, y: 500 },
      { type: 'drift', x: 180, y: 620, scale: 1.2 }, { type: 'drift', x: 1800, y: 760, scale: 1.2 },
      { type: 'snowpatch', x: 240, y: 560, w: 150, h: 90 }, { type: 'snowpatch', x: 1610, y: 710, w: 150, h: 90 },
      { type: 'sled', x: 1100, y: 780, scale: 1 }, { type: 'sled', x: 260, y: 780, scale: 0.9 },
      { type: 'shovel', x: 900, y: 570 }, { type: 'shovel', x: 1760, y: 620 },
      { type: 'tiretracks', x: 700, y: 300 }, { type: 'tiretracks', x: 1300, y: 1060 },
    ],
  };
}

// ---- Recess Yard --------------------------------------------------------------
// The Colonel stands inside a chain-link ball cage with a gate in each side.
// Fences stop feet, not snowballs, so the cage is a fortress you can shoot out of and
// foes can shoot into. Blocking a gate with snow is the whole opening gambit.
function recessYard() {
  const W = 1920, H = 1320, AX = 960;
  const fort = { x: 960, y: 760 };
  const forts = [{ x: 440, y: 760 }, { x: 1480, y: 760 }];
  const chain = { blocksBalls: false, height: 56, variant: 1 };

  const west = [
    // Ball cage.
    box('fence', 640, 544, 240, 10, chain),
    box('fence', 644, 544, 10, 136, chain),
    box('fence', 644, 840, 10, 154, chain),
    box('fence', 640, 984, 240, 10, chain),

    // Stubs off the school wall and south edge turn the long lanes into a slalom.
    box('fence', 764, 200, 10, 120, chain),
    box('fence', 764, 1210, 10, 110, chain),

    // Far-yard fence runs shape the west and east yards into lanes.
    box('fence', 244, 200, 10, 130, chain),
    box('fence', 44, 980, 200, 10, chain),

    // Playground. Mirrored twins share a footprint but not a costume.
    box('monkeybars', 130, 440, 200, 56),
    box('swing', 130, 1060, 220, 70),
    box('bench', 400, 226, 100, 26, { rot: 0 }),
    box('bench', 610, 1250, 100, 26),
    box('bench', 560, 980, 26, 90, { variant: 1 }),
    box('bench', 700, 1010, 100, 26, { variant: 1 }),

    dot('bin', 620, 226, 15),
    dot('bin', 656, 226, 15),
    dot('bin', 120, 226, 15),
    dot('tree', 66, 660, 26, { variant: 1 }),
    dot('tree', 70, 1270, 26, { variant: 0 }),
    dot('bush', 200, 230, 18),
    dot('bush', 580, 1296, 16),
    dot('bush', 250, 660, 18),
    dot('bush', 250, 860, 18),
    dot('lamp', 620, 520, 8),
    dot('lamp', 620, 1010, 8),
    dot('lamp', 30, 300, 8),
    dot('lamp', 300, 1240, 8),
  ];

  const obstacles = [
    box('schoolwall', 0, 0, W, 200),
    ...withTwins(west, AX, (o) => {
      if (o.type === 'monkeybars') return { type: 'slide', blocksBalls: false };
      return {};
    }),
  ];

  const truckPath = [
    { x: 480, y: 1130 }, { x: 480, y: 450 }, { x: 540, y: 400 }, { x: 1380, y: 400 }, { x: 1440, y: 450 },
    { x: 1440, y: 1130 }, { x: 1380, y: 1160 }, { x: 540, y: 1160 },
  ];

  const school = [];
  for (let x = 120; x < W; x += 240) school.push({ x, y: 206, r: 110, color: SCHOOL_GLOW });

  return {
    id: 'yard', theme: 'yard', name: 'Recess Yard',
    blurb: 'Chain-link fences stop feet, not snowballs. Hold the ball cage and plug the gates.',
    w: W, h: H, obstacles,
    // Kids have been polishing these two strips with their boots since first bell.
    ice: [
      { shape: 'rect', x: 760, y: 462, w: 400, h: 44 },
      { shape: 'rect', x: 760, y: 1044, w: 400, h: 44 },
    ],
    fort,
    forts,
    truce: { axis: 'x', at: AX },
    spawns: {
      siege: [
        { x: 850, y: 760 }, { x: 1070, y: 760 }, { x: 960, y: 650 }, { x: 960, y: 870 },
        { x: 880, y: 680 }, { x: 1040, y: 680 }, { x: 880, y: 840 }, { x: 1040, y: 840 },
      ],
      fortwars: [
        [
          { x: 330, y: 700 }, { x: 330, y: 760 }, { x: 330, y: 820 }, { x: 390, y: 660 },
          { x: 390, y: 860 }, { x: 290, y: 730 }, { x: 290, y: 790 }, { x: 450, y: 640 },
        ],
        twinList([
          { x: 330, y: 700 }, { x: 330, y: 760 }, { x: 330, y: 820 }, { x: 390, y: 660 },
          { x: 390, y: 860 }, { x: 290, y: 730 }, { x: 290, y: 790 }, { x: 450, y: 640 },
        ], AX),
      ],
      ffa: [
        { x: 960, y: 760 }, { x: 960, y: 300 }, { x: 960, y: 1180 }, { x: 440, y: 760 },
        { x: 1480, y: 760 }, { x: 200, y: 330 }, { x: 1720, y: 330 }, { x: 200, y: 900 },
        { x: 1720, y: 900 }, { x: 620, y: 1140 }, { x: 1300, y: 1140 },
      ],
    },
    entrances: [
      { x: 30, y: 760 }, { x: W - 30, y: 760 }, { x: 480, y: H - 30 }, { x: W - 480, y: H - 30 },
    ],
    truckPath,
    lights: [
      ...twinPoints([lamp(620, 520), lamp(620, 1010), lamp(30, 300), lamp(300, 1240)], AX),
      ...school,
      ...fortGlows(fort, forts),
    ],
    decor: [
      { type: 'path', points: [{ x: 960, y: 200 }, { x: 960, y: 544 }], width: 110 },
      { type: 'path', points: [{ x: 0, y: 760 }, { x: 640, y: 760 }], width: 70 },
      { type: 'path', points: [{ x: W, y: 760 }, { x: W - 640, y: 760 }], width: 70 },
      { type: 'path', points: [{ x: 480, y: H }, { x: 480, y: 1180 }, { x: 960, y: 1090 }, { x: 960, y: 994 }], width: 70 },
      { type: 'path', points: [{ x: W - 480, y: H }, { x: W - 480, y: 1180 }, { x: 960, y: 1090 }], width: 70 },
      { type: 'hopscotch', x: 880, y: 430 }, { type: 'hopscotch', x: 1060, y: 1230 },
      { type: 'hopscotch', x: 410, y: 660 }, { type: 'hopscotch', x: 1580, y: 960, scale: 1.1 },
      { type: 'hopscotch', x: 650, y: 430, scale: 0.9 },
      { type: 'snowpatch', x: 720, y: 600, w: 480, h: 320 },
      { type: 'snowpatch', x: 160, y: 900, w: 170, h: 70 }, { type: 'snowpatch', x: 1590, y: 560, w: 170, h: 80 },
      { type: 'drift', x: 760, y: 900, scale: 1.3 }, { type: 'drift', x: 1160, y: 640, scale: 1.2 },
      { type: 'drift', x: 240, y: 560 }, { type: 'drift', x: 1660, y: 1040 },
      { type: 'drift', x: 1340, y: 300, scale: 1.1 }, { type: 'drift', x: 560, y: 1160, scale: 1.1 },
      { type: 'sled', x: 200, y: 1180, scale: 1 }, { type: 'sled', x: 1780, y: 600, scale: 0.9 },
      { type: 'sled', x: 1100, y: 1280, scale: 0.9 },
      { type: 'shovel', x: 1100, y: 620 }, { type: 'shovel', x: 90, y: 340 },
    ],
  };
}

// ---- Corner Lot ---------------------------------------------------------------
// Classic's arena (SPEC 2.4): a small snowy lot between two back fences, nearly one screen,
// a little cover on each side and a frozen puddle in the middle where the Iceball turns up.
function cornerLot() {
  const W = 1320, H = 780, AX = 660;
  const west = [
    dot('pine', 70, 80, 34), dot('pine', 70, 700, 34), dot('pine', 190, 40, 26), dot('pine', 190, 742, 26),
    box('bench', 300, 168, 96, 26), box('bench', 300, 586, 96, 26),
    dot('bush', 455, 390, 24),
    dot('rock', 560, 240, 20), dot('rock', 560, 540, 20),
    dot('bin', 250, 390, 14),
    dot('lamp', 120, 250, 8), dot('lamp', 120, 530, 8),
  ];
  const forts = [{ x: 170, y: 390 }, { x: W - 170, y: 390 }];
  const home = [
    { x: 170, y: 330 }, { x: 170, y: 450 }, { x: 230, y: 280 }, { x: 230, y: 500 },
    { x: 110, y: 390 }, { x: 290, y: 330 }, { x: 290, y: 450 }, { x: 140, y: 600 },
  ];
  return {
    id: 'lot', theme: 'court', name: 'Corner Lot', modes: ['classic'],
    blurb: 'A small snowy lot between two back fences. Eight seconds to dig in, then nowhere to hide for long.',
    w: W, h: H, obstacles: withTwins(west, AX),
    ice: [{ shape: 'ellipse', x: AX, y: 390, rx: 64, ry: 36 }],
    fort: { x: AX, y: 390 },
    forts,
    truce: { axis: 'x', at: AX },
    pickupSpot: { x: AX, y: 390 },
    spawns: {
      siege: home,
      fortwars: [home, twinList(home, AX)],
      ffa: twinPoints(home.slice(0, 4), AX),
    },
    entrances: [],
    truckPath: [],
    lights: [...twinPoints([lamp(120, 250), lamp(120, 530)], AX), ...fortGlows(forts[0], [forts[1]])],
    decor: [
      { type: 'snowpatch', x: 420, y: 250, w: 220, h: 110 }, { type: 'snowpatch', x: W - 640, y: 420, w: 220, h: 110 },
      { type: 'drift', x: 330, y: 70 }, { type: 'drift', x: W - 330, y: 710 },
      { type: 'drift', x: 600, y: 700, scale: 0.9 }, { type: 'drift', x: W - 600, y: 80, scale: 0.9 },
      { type: 'sled', x: 60, y: 420, scale: 0.8 },
    ],
  };
}

export const MAPS = [mapleCourt(), wobblePond(), recessYard()];
// Classic plays on its own lot, which no other mode offers (SPEC 2.4).
export const ARENAS = [cornerLot()];
export const mapsForMode = (mode) => (mode === 'classic' ? ARENAS : MAPS);

export const getMap = (id) => MAPS.find((m) => m.id === id) ?? ARENAS.find((m) => m.id === id) ?? MAPS[0];
