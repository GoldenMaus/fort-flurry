// The world: map data, cards, waves, and every foe, boss and bot behaviour, driven through
// the real Game so the AI is judged against the sim it actually ships with.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { ACTOR, AFLAG, AUX, BALL, BTN, CMD, DIFFICULTY, EV, MOD_KEYS, MODE, PHASE, PICKUP, SFX, STRUCT, TEAM } from '../public/shared/schema.js';
import {
  BOSS, BUILD, CELL, DIFF, DT, FOES, KID, MAX_ACTORS, SIEGE, SIM_HZ, THROW, WAVES, WAVE_NAMES,
} from '../public/shared/constants.js';
import { MAPS, getMap } from '../public/shared/maps.js';
import { CARDS, CARD_BY_ID, defaultMods, modsFromCards, rollCards } from '../public/shared/cards.js';
import { WaveRunner, waveInfo } from '../public/shared/waves.js';
import { COLONEL_LINES, FOE_LINES, GIVE_UP_LINES, dressFoe } from '../public/shared/ai_foes.js';
import { botFrame } from '../public/shared/ai_bots.js';
import { createCollisionWorld } from '../public/shared/physics.js';
import { Game } from '../public/shared/game.js';

const OBSTACLE_TYPES = new Set(['house', 'tree', 'pine', 'car', 'fence', 'lamp', 'rock', 'bench', 'swing', 'slide', 'bush',
  'mailbox', 'hydrant', 'monkeybars', 'bin', 'schoolwall']);
const LINE_DECOR = new Set(['road', 'path']);
const AREA_DECOR = new Set(['bridge', 'snowpatch']);
const SPOT_DECOR = new Set(['sled', 'shovel', 'reeds', 'drift', 'hopscotch', 'tiretracks']);
const BIG_BODY = FOES[ACTOR.STEVE].r;
const TRUCK_BODY = FOES[ACTOR.TRUCK].r;

// ---- geometry helpers ---------------------------------------------------------

function gapToObstacle(o, x, y) {
  if (o.shape === 'circle') return Math.hypot(x - o.x, y - o.y) - o.r;
  return Math.hypot(Math.max(o.x - x, 0, x - o.x - o.w), Math.max(o.y - y, 0, y - o.y - o.h));
}

function clearance(map, x, y) {
  let best = Infinity;
  for (const o of map.obstacles) {
    if (o.blocksMove) best = Math.min(best, gapToObstacle(o, x, y));
  }
  return best;
}

function segmentClearance(map, a, b) {
  let best = Infinity;
  const steps = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 10);
  for (let i = 0; i <= steps; i++) {
    best = Math.min(best, clearance(map, a.x + ((b.x - a.x) * i) / steps, a.y + ((b.y - a.y) * i) / steps));
  }
  return best;
}

// Breadth-first over cell centres, passable only where a body of radius r fits. This is an
// independent check on the data; it does not lean on the game's own flow field.
function reachable(map, from, goal, r, goalRadius) {
  const cols = map.w / CELL, rows = map.h / CELL;
  const fits = (cx, cy) => {
    if (cx < 0 || cy < 0 || cx >= cols || cy >= rows) return false;
    return clearance(map, (cx + 0.5) * CELL, (cy + 0.5) * CELL) >= r;
  };
  const start = { cx: Math.floor(from.x / CELL), cy: Math.floor(from.y / CELL) };
  const seen = new Set([start.cy * cols + start.cx]);
  const queue = [start];
  for (let head = 0; head < queue.length; head++) {
    const { cx, cy } = queue[head];
    if (Math.hypot((cx + 0.5) * CELL - goal.x, (cy + 0.5) * CELL - goal.y) <= goalRadius) return true;
    for (const [ox, oy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = cx + ox, ny = cy + oy;
      if (!fits(nx, ny) || seen.has(ny * cols + nx)) continue;
      seen.add(ny * cols + nx);
      queue.push({ cx: nx, cy: ny });
    }
  }
  return false;
}

const sideOf = (truce, p) => Math.sign((truce.axis === 'x' ? p.x : p.y) - truce.at);
const mirrored = (truce, p) => (truce.axis === 'x' ? { x: 2 * truce.at - p.x, y: p.y } : { x: p.x, y: 2 * truce.at - p.y });

function twinOf(map, o) {
  const { at } = map.truce;
  const wantX = o.shape === 'circle' ? 2 * at - o.x : 2 * at - o.x - o.w;
  return map.obstacles.find((p) => p.shape === o.shape && p.x === wantX && p.y === o.y
    && (o.shape === 'circle' ? p.r === o.r : p.w === o.w && p.h === o.h)
    && p.blocksMove === o.blocksMove && p.blocksBalls === o.blocksBalls);
}

// ---- maps ---------------------------------------------------------------------

describe('maps', () => {
  test('menu order, lookups and fallback', () => {
    assert.deepEqual(MAPS.map((m) => m.id), ['court', 'pond', 'yard']);
    assert.equal(getMap('pond').id, 'pond');
    assert.equal(getMap('nowhere'), MAPS[0]);
    assert.deepEqual(MAPS.map((m) => m.name), ['Maple Court', 'Wobble Pond', 'Recess Yard']);
  });

  for (const map of MAPS) {
    describe(map.name, () => {
      const cw = createCollisionWorld(map);

      test('header fields', () => {
        assert.equal(map.id, map.theme);
        assert.ok(map.blurb.length > 20);
        assert.equal(map.w % CELL, 0);
        assert.equal(map.h % CELL, 0);
        assert.ok(map.w >= 1600 && map.w <= 2000, `w=${map.w}`);
        assert.ok(map.h >= 1200 && map.h <= 1400, `h=${map.h}`);
      });

      test('obstacles are well formed and inside the map', () => {
        assert.ok(map.obstacles.length >= 30, 'plenty of scenery');
        for (const o of map.obstacles) {
          assert.ok(OBSTACLE_TYPES.has(o.type), o.type);
          assert.ok(typeof o.blocksMove === 'boolean' && typeof o.blocksBalls === 'boolean');
          assert.ok(o.height > 0);
          assert.ok(o.rot === 0 || o.rot === 90);
          if (o.shape === 'circle') {
            assert.ok(o.r > 0 && o.x - o.r >= 0 && o.y - o.r >= 0 && o.x + o.r <= map.w && o.y + o.r <= map.h, JSON.stringify(o));
          } else {
            assert.equal(o.shape, 'rect');
            assert.ok(o.w > 0 && o.h > 0 && o.x >= 0 && o.y >= 0 && o.x + o.w <= map.w && o.y + o.h <= map.h, JSON.stringify(o));
          }
        }
      });

      test('every spawn list has at least 8 points, none inside anything', () => {
        const lists = { siege: map.spawns.siege, teamA: map.spawns.fortwars[0], teamB: map.spawns.fortwars[1], ffa: map.spawns.ffa };
        for (const [name, list] of Object.entries(lists)) {
          assert.ok(list.length >= 8, `${name} has ${list.length}`);
          for (const p of list) {
            assert.ok(p.x > KID.radius && p.y > KID.radius && p.x < map.w - KID.radius && p.y < map.h - KID.radius, `${name} ${p.x},${p.y}`);
            assert.ok(clearance(map, p.x, p.y) >= KID.radius + 2, `${name} ${p.x},${p.y} touches scenery`);
          }
        }
      });

      test('Siege kids and Face-Off kids start somewhere they can pack', () => {
        for (const p of [...map.spawns.siege, ...map.spawns.fortwars[0], ...map.spawns.fortwars[1]]) {
          assert.ok(!cw.isIce(p.x, p.y), `${p.x},${p.y} is on ice`);
        }
      });

      test('Free-for-All spawns are spread out', () => {
        const { ffa } = map.spawns;
        for (let i = 0; i < ffa.length; i++) {
          for (let j = i + 1; j < ffa.length; j++) {
            assert.ok(Math.hypot(ffa[i].x - ffa[j].x, ffa[i].y - ffa[j].y) >= 200, `ffa ${i} and ${j} are too close`);
          }
        }
      });

      test('forts sit on a cell corner with all four Colonel cells free', () => {
        for (const fort of [map.fort, ...map.forts]) {
          assert.equal(fort.x % CELL, 0);
          assert.equal(fort.y % CELL, 0);
          const cx = fort.x / CELL, cy = fort.y / CELL;
          for (const [x, y] of [[cx - 1, cy - 1], [cx, cy - 1], [cx - 1, cy], [cx, cy]]) {
            assert.ok(!cw.hasObstacleOverlap(x, y), `cell ${x},${y}`);
          }
        }
      });

      test('a generous ring of buildable ground around every fort', () => {
        for (const fort of [map.fort, ...map.forts]) {
          let free = 0, total = 0;
          for (let cy = 0; cy < map.h / CELL; cy++) {
            for (let cx = 0; cx < map.w / CELL; cx++) {
              const d = Math.hypot((cx + 0.5) * CELL - fort.x, (cy + 0.5) * CELL - fort.y);
              if (d < 60 || d > KID.buildRange) continue;
              total += 1;
              if (!cw.hasObstacleOverlap(cx, cy)) free += 1;
            }
          }
          assert.ok(free / total >= 0.85, `only ${free} of ${total} cells are free around ${fort.x},${fort.y}`);
        }
      });

      test('entrances are on the edge, clear, and out of each other\'s way', () => {
        assert.ok(map.entrances.length >= 3);
        for (const e of map.entrances) {
          const fromEdge = Math.min(e.x, e.y, map.w - e.x, map.h - e.y);
          assert.ok(fromEdge <= 60 && fromEdge > 0, `${e.x},${e.y}`);
          assert.ok(clearance(map, e.x, e.y) >= BIG_BODY, `${e.x},${e.y} has ${clearance(map, e.x, e.y)}`);
        }
      });

      test('no entrance no-build zone reaches the fort ring', () => {
        for (const e of map.entrances) {
          assert.ok(Math.hypot(e.x - map.fort.x, e.y - map.fort.y) > SIEGE.entranceNoBuild + KID.buildRange);
        }
      });

      test('every entrance reaches the fort with clearance for a big body', () => {
        for (const e of map.entrances) {
          assert.ok(reachable(map, e, map.fort, BIG_BODY, BOSS.steve.stopDist), `entrance ${e.x},${e.y}`);
        }
      });

      test('no sealed pockets where the action, or a dropped pickup, can land', () => {
        const { cols, rows } = cw;
        const seen = new Set([Math.floor(map.fort.y / CELL) * cols + Math.floor(map.fort.x / CELL) + 2]);
        const queue = [...seen];
        for (let head = 0; head < queue.length; head++) {
          const here = queue[head];
          const cx = here % cols, cy = Math.floor(here / cols);
          for (const [ox, oy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const next = (cy + oy) * cols + cx + ox;
            if (cw.isObstacleCell(cx + ox, cy + oy) || seen.has(next)) continue;
            seen.add(next);
            queue.push(next);
          }
        }
        for (let cy = Math.floor(rows * 0.12); cy <= rows * 0.88; cy++) {
          for (let cx = Math.floor(cols * 0.12); cx <= cols * 0.88; cx++) {
            if (!cw.isObstacleCell(cx, cy)) assert.ok(seen.has(cy * cols + cx), `cell ${cx},${cy} is walled off`);
          }
        }
      });

      test('the Face-Off forts reach each other with clearance for a kid', () => {
        assert.ok(reachable(map, map.spawns.fortwars[0][0], map.forts[1], KID.radius, 120));
      });

      test('truck path is a clear closed loop that keeps off the fort', () => {
        const path = map.truckPath;
        assert.ok(path.length >= 4);
        for (let i = 0; i < path.length; i++) {
          const a = path[i], b = path[(i + 1) % path.length];
          const gap = segmentClearance(map, a, b);
          assert.ok(gap >= TRUCK_BODY, `leg ${i} has only ${gap.toFixed(1)}`);
          assert.ok(Math.min(a.x, a.y, map.w - a.x, map.h - a.y) > TRUCK_BODY);
          assert.ok(Math.hypot(a.x - map.fort.x, a.y - map.fort.y) > KID.buildRange + TRUCK_BODY, `vertex ${i} crowds the fort`);
        }
      });

      test('the truck can get on and off the loop', () => {
        // WaveRunner brings it in by the entrance nearest the loop's first vertex.
        const start = map.truckPath[0];
        const gate = [...map.entrances].sort((a, b) => Math.hypot(a.x - start.x, a.y - start.y) - Math.hypot(b.x - start.x, b.y - start.y))[0];
        assert.ok(segmentClearance(map, gate, start) >= TRUCK_BODY, 'way in');
      });

      test('lights and decor', () => {
        assert.ok(map.lights.length >= 8);
        for (const l of map.lights) {
          assert.ok(l.x >= 0 && l.y >= 0 && l.x <= map.w && l.y <= map.h && l.r > 0 && /^#[0-9a-f]{6}$/i.test(l.color));
        }
        for (const lampPost of map.obstacles.filter((o) => o.type === 'lamp')) {
          assert.ok(map.lights.some((l) => Math.hypot(l.x - lampPost.x, l.y - lampPost.y) < 2), 'every lamp post has a light');
        }
        assert.ok(map.decor.length >= 12, 'plenty of decor');
        for (const d of map.decor) {
          if (LINE_DECOR.has(d.type)) assert.ok(d.points.length >= 2 && d.width > 0);
          else if (AREA_DECOR.has(d.type)) assert.ok(d.w > 0 && d.h > 0);
          else assert.ok(SPOT_DECOR.has(d.type), d.type);
        }
      });

      test('Face-Off halves are correct and fair', () => {
        const { truce, forts, spawns } = map;
        assert.ok(truce.axis === 'x' || truce.axis === 'y');
        assert.equal(truce.at % CELL, 0, 'the rope runs along a cell edge so "own half" is exact');
        assert.equal(sideOf(truce, forts[0]), -sideOf(truce, forts[1]));
        assert.deepEqual(mirrored(truce, forts[0]), forts[1]);
        for (const team of [0, 1]) {
          for (const p of spawns.fortwars[team]) {
            assert.equal(sideOf(truce, p), sideOf(truce, forts[team]), `team ${team} spawn ${p.x},${p.y}`);
          }
          assert.ok(Math.abs((truce.axis === 'x' ? forts[team].x : forts[team].y) - truce.at) >= BUILD[STRUCT.PULT].range,
            'a flinger at the rope must not reach the enemy Colonel');
        }
        spawns.fortwars[0].forEach((p, i) => assert.deepEqual(mirrored(truce, p), spawns.fortwars[1][i]));
      });

      test('everything solid has a mirror twin, so neither Face-Off team has the better side', () => {
        for (const o of map.obstacles) {
          if (!o.blocksMove && !o.blocksBalls) continue;
          assert.ok(twinOf(map, o), `${o.type} at ${o.x},${o.y} has no twin`);
        }
      });

      test('ice is mirrored too', () => {
        const { at } = map.truce;
        for (const z of map.ice) {
          const wantX = z.shape === 'rect' ? 2 * at - z.x - z.w : 2 * at - z.x;
          assert.ok(map.ice.some((q) => q.shape === z.shape && q.x === wantX && q.y === z.y), `${z.shape} at ${z.x},${z.y}`);
        }
      });
    });
  }

  test('Maple Court is a cul-de-sac with three street entrances', () => {
    const map = getMap('court');
    assert.equal(map.entrances.length, 3);
    for (const type of ['house', 'car', 'lamp', 'mailbox', 'tree']) {
      assert.ok(map.obstacles.some((o) => o.type === type), type);
    }
    assert.ok(map.decor.filter((d) => d.type === 'road').length >= 3);
  });

  test('Wobble Pond: an island in the ice, reached by snow bridges', () => {
    const map = getMap('pond');
    const cw = createCollisionWorld(map);
    assert.ok(map.entrances.length >= 5, 'foes skate in from all sides');
    // The island is dry and ringed by ice on every heading that is not a bridge.
    for (let a = 0; a < 360; a += 5) {
      const ux = Math.cos((a * Math.PI) / 180), uy = Math.sin((a * Math.PI) / 180);
      assert.ok(!cw.isIce(map.fort.x + ux * 190, map.fort.y + uy * 190), `island at ${a} degrees`);
      const onBridge = map.decor.some((d) => d.type === 'bridge'
        && Math.abs(map.fort.x + ux * 400 - (d.x + d.w / 2)) <= d.w / 2 + 40 && Math.abs(map.fort.y + uy * 400 - (d.y + d.h / 2)) <= d.h / 2 + 40);
      if (onBridge) continue;
      let iced = false;
      for (let r = 200; r < 520; r += 10) iced ||= cw.isIce(map.fort.x + ux * r, map.fort.y + uy * r);
      assert.ok(iced, `no ice at ${a} degrees`);
    }
    const bridges = map.decor.filter((d) => d.type === 'bridge');
    assert.equal(bridges.length, 4);
    for (const b of bridges) {
      for (let i = 1; i < 10; i++) {
        for (let j = 1; j < 10; j++) {
          assert.ok(!cw.isIce(b.x + (b.w * i) / 10, b.y + (b.h * j) / 10), 'a bridge is a packing spot');
        }
      }
    }
    assert.ok(map.obstacles.some((o) => o.type === 'pine') && map.obstacles.some((o) => o.type === 'rock'));
  });

  test('Recess Yard: fences stop feet, not balls', () => {
    const map = getMap('yard');
    const cw = createCollisionWorld(map);
    const fences = map.obstacles.filter((o) => o.type === 'fence');
    assert.ok(fences.length >= 8);
    assert.ok(fences.every((f) => f.blocksMove && !f.blocksBalls));
    for (const type of ['monkeybars', 'slide', 'swing', 'bench', 'schoolwall']) {
      assert.ok(map.obstacles.some((o) => o.type === type), type);
    }
    const wall = map.obstacles.find((o) => o.type === 'schoolwall');
    assert.ok(wall.w >= map.w * 0.9, 'a long wall down one side');
    // A ball passes straight through a fence but a kid does not.
    const fence = fences.find((f) => f.w > f.h);
    assert.ok(cw.isObstacleCell(Math.floor((fence.x + 40) / CELL), Math.floor(fence.y / CELL)));
  });

  test('each map feels like a different place', () => {
    const count = (map, type) => map.obstacles.filter((o) => o.type === type).length;
    assert.ok(count(getMap('court'), 'house') >= 10);
    assert.equal(count(getMap('pond'), 'house'), 0);
    assert.equal(count(getMap('yard'), 'house'), 0);
    assert.ok(getMap('pond').ice.length > getMap('court').ice.length * 4);
    assert.ok(count(getMap('pond'), 'pine') >= 20);
  });
});

// ---- cards --------------------------------------------------------------------

function seeded(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

describe('cards', () => {
  test('defaultMods has exactly the agreed keys and neutral values', () => {
    const mods = defaultMods();
    assert.deepEqual(Object.keys(mods).sort(), [...MOD_KEYS].sort());
    for (const key of MOD_KEYS) assert.equal(mods[key], key.endsWith('Mul') ? 1 : 0, key);
    assert.notEqual(defaultMods(), defaultMods());
  });

  test('at least the fourteen named cards, with unique ids and full text', () => {
    assert.ok(CARDS.length >= 14);
    assert.equal(new Set(CARDS.map((c) => c.id)).size, CARDS.length);
    for (const c of CARDS) {
      assert.ok(typeof c.id === 'string' && c.id.length > 0 && c.id.length <= 16, c.id);
      assert.ok(c.name.length > 0 && c.blurb.length > 0);
      assert.equal(CARD_BY_ID[c.id], c);
    }
    const names = new Set(CARDS.map((c) => c.name));
    for (const name of ['Fuzzy Earmuffs', 'Good Boots', 'Snowball Tongs', 'Big Mittens', 'Ice Core', 'Fastball', 'Big Splat', 'Hair Dryer',
      'Greased Belly', 'Long Arms', 'Second Sweater', 'Spring Spoon', 'Packed Tight', 'Lucky Mitten']) {
      assert.ok(names.has(name), name);
    }
  });

  const SPEC_CARDS = [
    ['Fuzzy Earmuffs', 'maxWarmth', 25], ['Good Boots', 'speedMul', 1.12], ['Snowball Tongs', 'packTimeMul', 0.75],
    ['Big Mittens', 'maxBalls', 3], ['Ice Core', 'throwDmgMul', 1.2], ['Fastball', 'throwSpeedMul', 1.15],
    ['Big Splat', 'lobSplashMul', 1.3], ['Hair Dryer', 'thawTimeMul', 0.6], ['Greased Belly', 'slideCdMul', 0.65],
    ['Long Arms', 'buildRangeMul', 1.3], ['Second Sweater', 'regenMul', 1.6], ['Spring Spoon', 'pultDmgMul', 1.3],
    ['Packed Tight', 'wallHpMul', 1.25], ['Lucky Mitten', 'flakeBonus', 1],
  ];

  test('each named card does what the spec says, and nothing else', () => {
    for (const [name, key, value] of SPEC_CARDS) {
      const card = CARDS.find((c) => c.name === name);
      const mods = modsFromCards([card.id]);
      const base = defaultMods();
      for (const k of MOD_KEYS) assert.equal(mods[k], k === key ? value : base[k], `${name} ${k}`);
    }
  });

  test('every Mul key multiplies and every other key adds', () => {
    for (const card of CARDS) {
      const once = defaultMods();
      card.apply(once);
      const twice = defaultMods();
      card.apply(twice);
      card.apply(twice);
      for (const key of MOD_KEYS) {
        if (key.endsWith('Mul')) assert.ok(Math.abs(twice[key] - once[key] ** 2) < 1e-12, `${card.id} ${key}`);
        else assert.equal(twice[key], once[key] * 2, `${card.id} ${key}`);
      }
    }
  });

  test('stacking compounds, up to three copies', () => {
    const id = (name) => CARDS.find((c) => c.name === name).id;
    assert.equal(modsFromCards(Array(3).fill(id('Big Mittens'))).maxBalls, 9);
    assert.ok(Math.abs(modsFromCards(Array(3).fill(id('Good Boots'))).speedMul - 1.12 ** 3) < 1e-12);
    assert.equal(modsFromCards(Array(4).fill(id('Big Mittens'))).maxBalls, 9, 'a fourth copy does nothing');
  });

  test('the three timing clamps hold however the cards stack', () => {
    const all = CARDS.flatMap((c) => [c.id, c.id, c.id]);
    const mods = modsFromCards(all);
    assert.equal(mods.packTimeMul, 0.4);
    assert.equal(mods.slideCdMul, 0.45);
    assert.equal(mods.thawTimeMul, 0.3);
    const dryer = CARDS.find((c) => c.name === 'Hair Dryer').id;
    assert.equal(modsFromCards([dryer, dryer]).thawTimeMul, 0.36, 'above the floor it is untouched');
  });

  test('host and client derive identical floats, whatever the order', () => {
    const rng = seeded(11);
    for (let round = 0; round < 200; round++) {
      const ids = [];
      for (let i = 0; i < 12; i++) ids.push(CARDS[Math.floor(rng() * CARDS.length)].id);
      const host = modsFromCards(ids);
      const wire = JSON.parse(JSON.stringify(ids)).reverse();
      const client = modsFromCards(wire);
      for (const key of MOD_KEYS) assert.ok(Object.is(host[key], client[key]), key);
    }
  });

  test('unknown ids are ignored rather than trusted', () => {
    assert.deepEqual(modsFromCards(['not-a-card']), defaultMods());
    assert.deepEqual(modsFromCards([]), defaultMods());
    assert.deepEqual(modsFromCards(undefined), defaultMods());
  });

  test('rollCards gives n distinct ids and never a card held three times', () => {
    const rng = seeded(5);
    const maxed = CARDS[0].id;
    for (let i = 0; i < 400; i++) {
      const owned = [maxed, maxed, maxed, CARDS[1].id];
      const roll = rollCards(rng, owned);
      assert.equal(roll.length, 3);
      assert.equal(new Set(roll).size, 3);
      assert.ok(!roll.includes(maxed));
      assert.ok(roll.every((id) => CARD_BY_ID[id]));
    }
    assert.equal(rollCards(rng, [], 5).length, 5);
  });

  test('rollCards is a pure function of the rng', () => {
    assert.deepEqual(rollCards(seeded(9), []), rollCards(seeded(9), []));
  });

  test('every card turns up', () => {
    const rng = seeded(2);
    const seen = new Set();
    for (let i = 0; i < 500; i++) for (const id of rollCards(rng, [])) seen.add(id);
    assert.equal(seen.size, CARDS.length);
  });

  test('an exhausted deck yields what is left, then nothing', () => {
    const all = CARDS.flatMap((c) => [c.id, c.id, c.id]);
    assert.deepEqual(rollCards(seeded(1), all), []);
    const oneLeft = all.slice(1);
    assert.deepEqual(rollCards(seeded(1), oneLeft), [CARDS[0].id]);
  });
});

// ---- waves --------------------------------------------------------------------

// Just enough Game for the wave schedule, so these tests can count every foe exactly.
function waveStage({ seed = 1, difficulty = DIFFICULTY.NORMAL, countMul = 1, mapId = 'court', cap = Infinity } = {}) {
  const map = getMap(mapId);
  const spawned = [];
  const stage = {
    map, difficulty, countMul, dt: DT, tick: 0, time: 0, rng: seeded(seed), cw: createCollisionWorld(map),
    spawned, cap, colonel: () => null, foes: () => [], bark() {},
    spawnFoe(kind, x, y, opts) {
      if (spawned.length >= stage.cap) return null;
      const foe = { kind, x, y, opts, flags: AFLAG.GRACE, ai: {}, at: stage.time };
      spawned.push(foe);
      return foe;
    },
  };
  return stage;
}

function playWave(stage, n, seconds = 90) {
  const runner = new WaveRunner(stage, n);
  for (let i = 0; i < seconds * SIM_HZ; i++) {
    stage.time += DT;
    stage.tick += 1;
    runner.update();
  }
  return runner;
}

const expectedCount = (base, difficulty, countMul) => Math.max(1, Math.round(base * DIFF[difficulty].count * countMul));

function tally(foes) {
  const counts = {};
  for (const f of foes) counts[f.kind] = (counts[f.kind] ?? 0) + 1;
  return counts;
}

describe('waves', () => {
  test('preview and spawns match the WAVES table at every difficulty and head-count', () => {
    for (const difficulty of Object.values(DIFFICULTY)) {
      for (const countMul of [1, 1.275, 2.65, 4.85]) {
        for (let n = 1; n <= 9; n++) {
          if (!WAVES[n].foes) continue;
          const stage = waveStage({ difficulty, countMul, seed: n });
          const runner = new WaveRunner(stage, n);
          const want = Object.entries(WAVES[n].foes).map(([k, base]) => ({ k: Number(k), n: expectedCount(base, difficulty, countMul) }));
          assert.deepEqual(runner.preview.foes, want.sort((a, b) => a.k - b.k), `wave ${n}`);
          assert.equal(runner.remaining, want.reduce((sum, f) => sum + f.n, 0));
          assert.equal(runner.done, false);
          for (let i = 0; i < (WAVES[n].win + 2) * SIM_HZ; i++) { stage.time += DT; runner.update(); }
          assert.equal(runner.remaining, 0);
          assert.equal(runner.done, true);
          assert.deepEqual(tally(stage.spawned), Object.fromEntries(want.map((f) => [f.k, f.n])));
        }
      }
    }
  });

  test('boss waves spawn exactly one boss', () => {
    for (const [n, boss] of [[5, ACTOR.TRUCK], [10, ACTOR.STEVE]]) {
      const stage = waveStage({ seed: n, countMul: 3 });
      const runner = playWave(stage, n, 5);
      assert.deepEqual(runner.preview.foes, [{ k: boss, n: 1 }]);
      assert.equal(runner.preview.from.length, 1);
      assert.equal(stage.spawned.length, 1);
      assert.equal(stage.spawned[0].kind, boss);
      assert.ok(runner.done);
    }
  });

  test('the truck comes in by the street nearest its loop', () => {
    for (const map of MAPS) {
      const stage = waveStage({ mapId: map.id });
      const runner = playWave(stage, 5, 5);
      const gate = map.entrances[runner.preview.from[0]];
      assert.deepEqual({ x: stage.spawned[0].x, y: stage.spawned[0].y }, { x: gate.x, y: gate.y });
    }
  });

  function squadsOf(stage) {
    const squads = [];
    for (const foe of stage.spawned) {
      const last = squads[squads.length - 1];
      if (last && Math.abs(last.at - foe.at) < DT / 2) last.foes.push(foe);
      else squads.push({ at: foe.at, foes: [foe] });
    }
    return squads;
  }

  test('squads hold 3 to 6 foes, evenly spaced, first at +2 s', () => {
    for (let n = 2; n <= 9; n++) {
      if (!WAVES[n].foes) continue;
      for (const countMul of [1, 2]) {
        const stage = waveStage({ seed: 100 + n, countMul });
        playWave(stage, n);
        const squads = squadsOf(stage);
        assert.ok(Math.abs(squads[0].at - 2) <= DT * 1.5, `first squad at ${squads[0].at}`);
        for (const s of squads) assert.ok(s.foes.length >= 3 && s.foes.length <= 6, `squad of ${s.foes.length} in wave ${n}`);
        const gap = squads[1].at - squads[0].at;
        // Spawns land on tick boundaries, so each gap can be a tick either side of exact.
        for (let i = 2; i < squads.length; i++) assert.ok(Math.abs(squads[i].at - squads[i - 1].at - gap) <= DT * 2.5, 'even spacing');
        assert.ok(squads[squads.length - 1].at <= WAVES[n].win + DT * 2, 'all inside the window');
      }
    }
  });

  test('wave 1 opens with two Pipsqueaks', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const stage = waveStage({ seed, countMul: 1 + (seed % 3) });
      playWave(stage, 1);
      const squads = squadsOf(stage);
      assert.equal(squads[0].foes.length, 2);
      assert.ok(squads[0].foes.every((f) => f.kind === ACTOR.PIPSQUEAK));
    }
  });

  function entranceOf(map, foe) {
    let best = -1, bestDist = Infinity;
    map.entrances.forEach((e, i) => {
      const d = Math.hypot(e.x - foe.x, e.y - foe.y);
      if (d < bestDist) { bestDist = d; best = i; }
    });
    return best;
  }

  test('each squad uses one entrance; early waves two, later waves all', () => {
    for (const map of MAPS) {
      for (let n = 1; n <= 9; n++) {
        if (!WAVES[n].foes) continue;
        const stage = waveStage({ mapId: map.id, seed: n * 7, countMul: 2 });
        const runner = playWave(stage, n);
        const wanted = n <= 4 ? Math.min(2, map.entrances.length) : map.entrances.length;
        assert.equal(runner.preview.from.length, wanted, `${map.id} wave ${n}`);
        assert.deepEqual(runner.preview.from, [...new Set(runner.preview.from)].sort((a, b) => a - b));
        for (const squad of squadsOf(stage)) {
          const used = new Set(squad.foes.map((f) => entranceOf(map, f)));
          assert.equal(used.size, 1, 'one entrance per squad');
          assert.ok(runner.preview.from.includes([...used][0]));
        }
      }
    }
  });

  test('rolls happen in the constructor and replay from the seed', () => {
    const a = new WaveRunner(waveStage({ seed: 3 }), 8);
    const b = new WaveRunner(waveStage({ seed: 3 }), 8);
    const c = new WaveRunner(waveStage({ seed: 4 }), 8);
    assert.deepEqual(a.preview, b.preview);
    assert.deepEqual(a.schedule, b.schedule);
    assert.notDeepEqual(a.schedule, c.schedule);
  });

  test('nothing spawns until update runs', () => {
    const stage = waveStage();
    const runner = new WaveRunner(stage, 3);
    assert.equal(stage.spawned.length, 0);
    assert.ok(runner.remaining > 0);
  });

  test('a full field queues foes and loses none', () => {
    const stage = waveStage({ seed: 3, countMul: 3, cap: 5 });
    const runner = new WaveRunner(stage, 9);
    const total = runner.remaining;
    for (let i = 0; i < 70 * SIM_HZ; i++) { stage.time += DT; runner.update(); }
    assert.equal(stage.spawned.length, 5);
    assert.equal(runner.remaining, total - 5);
    assert.equal(runner.done, false);
    stage.cap = Infinity;
    stage.time += DT;
    runner.update();
    assert.equal(stage.spawned.length, total);
    assert.equal(runner.done, true);
  });

  test('Endless past wave 10: the mix and hp grow on schedule', () => {
    for (const n of [11, 13, 17, 21]) {
      const stage = waveStage({ seed: n, cap: Infinity });
      const runner = playWave(stage, n);
      const past = n - 9;
      const want = Object.entries(WAVES[9].foes).map(([k, base]) => ({ k: Number(k), n: Math.max(1, Math.round(base * 1.12 ** past)) }));
      assert.deepEqual(runner.preview.foes, want.sort((a, b) => a.k - b.k));
      for (const foe of stage.spawned) assert.ok(Math.abs(foe.opts.hpMul - 1.03 ** past) < 1e-9);
    }
  });

  test('Endless bosses return at 5s and 0s, tougher each decade', () => {
    const cases = [[15, ACTOR.TRUCK, 1.3], [20, ACTOR.STEVE, 1.3], [25, ACTOR.TRUCK, 1.6], [30, ACTOR.STEVE, 1.6], [35, ACTOR.TRUCK, 1.9]];
    for (const [n, boss, hpMul] of cases) {
      const stage = waveStage({ seed: n });
      playWave(stage, n, 4);
      assert.equal(stage.spawned.length, 1);
      assert.equal(stage.spawned[0].kind, boss);
      assert.ok(Math.abs(stage.spawned[0].opts.hpMul - hpMul) < 1e-9, `wave ${n}`);
      assert.equal(waveInfo(n, 0).boss, boss);
    }
  });

  test('waveInfo names every wave and flags the bosses', () => {
    for (let n = 1; n <= 10; n++) {
      const info = waveInfo(n, 10);
      assert.equal(info.name, WAVE_NAMES[n]);
      assert.ok(info.sub.length > 10, `wave ${n}`);
    }
    assert.equal(waveInfo(5, 10).boss, ACTOR.TRUCK);
    assert.equal(waveInfo(10, 10).boss, ACTOR.STEVE);
    assert.equal(waveInfo(1, 10).boss, null);
    assert.notEqual(waveInfo(5, 5).sub, waveInfo(5, 10).sub, 'Quick mode says wave 5 is the finale');
    for (let n = 11; n < 40; n++) {
      const info = waveInfo(n, 0);
      assert.ok(info.name.length > 3 && info.sub.length > 10, `wave ${n}`);
    }
    assert.equal(waveInfo(12, 0).boss, null);
  });

  test('copy for every speaker is written', () => {
    for (const lines of [...Object.values(COLONEL_LINES), ...Object.values(FOE_LINES), GIVE_UP_LINES]) {
      assert.ok(lines.length >= 2);
      for (const line of lines) assert.ok(line.length > 3 && line.length <= 64, line);
    }
  });
});

// ---- the real Game ------------------------------------------------------------

const HERO = 1;
const human = (id = HERO, team = TEAM.A) => ({ id, name: `Kid ${id}`, team, isBot: false, look: null });
const bot = (id, team = TEAM.A) => ({ id, name: `Bot ${id}`, team, isBot: true, look: null });

// Waves are a separate concern, tested above. Holding the runner open keeps a fight running
// with only the foes a test places.
function withoutWaves(fn) {
  const real = WaveRunner.prototype.update;
  WaveRunner.prototype.update = function holdOpen() { this.done = false; };
  try {
    return fn();
  } finally {
    WaveRunner.prototype.update = real;
  }
}

function arena({ mapId = 'court', players = [human()], mode = MODE.SIEGE, difficulty = DIFFICULTY.NORMAL, seed = 7 } = {}) {
  const g = new Game({ mode, mapId, difficulty, waveCount: 10, seed, players });
  for (const p of players) if (!p.isBot) g.command(p.id, { c: CMD.READY });
  g.flakes[TEAM.A] = 500;
  g.drainEvents();
  assert.equal(g.phase, PHASE.FIGHT);
  return g;
}

function run(g, seconds, onTick) {
  const log = [];
  for (let i = 0; i < seconds * SIM_HZ; i++) {
    g.step();
    const events = g.drainEvents();
    log.push(...events);
    if (onTick && onTick(events) === false) break;
  }
  return log;
}

function foeAt(g, kind, x, y, opts = {}) {
  const foe = g.spawnFoe(kind, x, y, opts);
  dressFoe(foe);
  // Spawn GRACE is covered on its own below; everywhere else it only adds a second of waiting.
  foe.graceT = 0;
  foe.flags &= ~AFLAG.GRACE;
  return foe;
}

function place(g, id, x, y) {
  const kid = g.actors.get(id);
  kid.x = x; kid.y = y; kid.vx = 0; kid.vy = 0;
  return kid;
}

function wall(g, cx, cy, kind = STRUCT.WALL) {
  const builder = g.actors.get(HERO);
  const px = builder.x, py = builder.y;
  place(g, HERO, (cx + 0.5) * CELL + 60, (cy + 0.5) * CELL);
  g.command(HERO, { c: CMD.BUILD, k: kind, cx, cy });
  place(g, HERO, px, py);
  g.drainEvents();
  const s = g.structAt(cx, cy);
  assert.ok(s, `no struct at ${cx},${cy}`);
  return s;
}

const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const ofKind = (events, e) => events.filter((ev) => ev.e === e);
const ballsFrom = (events, id) => ofKind(events, EV.BALL).filter((ev) => ev.by === id);

describe('foe targeting', () => {
  test('with nobody around, foes go for the Colonel', () => withoutWaves(() => {
    const g = arena();
    g.removePlayer(HERO);
    const foe = foeAt(g, ACTOR.PIPSQUEAK, 30, 600);
    const log = run(g, 12);
    const col = g.colonel(TEAM.A);
    assert.ok(distance(foe, g.map.fort) <= FOES[ACTOR.PIPSQUEAK].range + CELL + 2, 'stops at range');
    assert.ok(distance(foe, g.map.fort) >= FOES[ACTOR.PIPSQUEAK].range, 'and no closer');
    assert.ok(ballsFrom(log, foe.id).length >= 2, 'then throws');
    assert.ok(col.hp < col.maxHp, 'and hits him');
  }));

  test('a kid within 220 outranks the Colonel', () => withoutWaves(() => {
    const g = arena();
    const foe = foeAt(g, ACTOR.PIPSQUEAK, 500, 600);
    const kid = place(g, HERO, 620, 640);
    const log = run(g, 2.5);
    const balls = ballsFrom(log, foe.id);
    assert.ok(balls.length >= 1);
    const angle = Math.atan2(balls[0].vy, balls[0].vx);
    const toKid = Math.atan2(kid.y - foe.y, kid.x - foe.x);
    assert.ok(Math.abs(angle - toKid) < 0.3, 'throws at the kid');
  }));

  test('a kid who hit a foe gets chased out to range, even past 220', () => withoutWaves(() => {
    const g = arena();
    const foe = foeAt(g, ACTOR.PIPSQUEAK, 200, 600);
    const kid = place(g, HERO, 700, 600);
    g.damageActor(foe, 1, kid, {});
    run(g, 0.7);
    assert.equal(foe.ai.kid, kid);
    assert.ok(foe.ai.grudge);
    const before = distance(foe, kid);
    run(g, 1.2);
    assert.ok(distance(foe, kid) < before - 60, 'walks toward them');
  }));

  test('the grudge fades after 3 seconds', () => withoutWaves(() => {
    const g = arena();
    const foe = foeAt(g, ACTOR.PIPSQUEAK, 200, 600);
    const kid = place(g, HERO, 1500, 200);
    g.damageActor(foe, 1, kid, {});
    run(g, 3.8);
    assert.equal(foe.ai.kid, null);
    assert.equal(foe.ai.struct, g.colonel(TEAM.A));
  }));

  test('frozen and GRACE kids are never targets', () => withoutWaves(() => {
    for (const state of ['frozen', 'grace']) {
      const g = arena();
      const foe = foeAt(g, ACTOR.PIPSQUEAK, 500, 600);
      const kid = place(g, HERO, 560, 600);
      if (state === 'frozen') g.freezeOrFlee(kid, null);
      else kid.flags |= AFLAG.GRACE;
      run(g, 1);
      assert.equal(foe.ai.kid, null, state);
      assert.equal(foe.ai.struct, g.colonel(TEAM.A), state);
    }
  }));

  test('a Spare Coat fools foes, but each foe rolls for it once', () => withoutWaves(() => {
    let fooled = 0;
    const trials = 60;
    const g = arena();
    place(g, HERO, 1700, 150);
    const coat = wall(g, 12, 15, STRUCT.DECOY);
    for (let i = 0; i < trials; i++) {
      const foe = foeAt(g, ACTOR.PIPSQUEAK, 300, 620);
      run(g, 0.55);
      assert.equal(foe.ai.coats.size, 1);
      const rolled = foe.ai.coats.get(coat.id);
      if (rolled) { fooled += 1; assert.equal(foe.ai.struct, coat); }
      run(g, 0.55);
      assert.equal(foe.ai.coats.get(coat.id), rolled, 'the roll sticks');
      g.despawn(foe);
      coat.hp = coat.maxHp;
    }
    const rate = fooled / trials;
    assert.ok(rate > 0.5 && rate < 0.9, `fooled ${fooled} of ${trials}`);
  }));

  test('foes do not act during spawn GRACE', () => withoutWaves(() => {
    const g = arena();
    const foe = g.spawnFoe(ACTOR.PIPSQUEAK, 30, 600);
    run(g, 0.9);
    assert.equal(foe.x, 30);
    run(g, 0.5);
    assert.ok(foe.x > 30);
  }));
});

describe('blocked and stuck', () => {
  test('a walled-off foe attacks what is in its way, and moves on when it falls', () => withoutWaves(() => {
    const g = arena({ mapId: 'yard' });
    g.flakes[TEAM.A] = 999;
    const west = 16;   // the west gate of the ball cage, four cells tall
    const blocks = [17, 18, 19, 20].map((cy) => wall(g, west, cy));
    place(g, HERO, 1500, 300);
    g.actors.get(HERO).flags |= AFLAG.GRACE;
    for (const s of blocks) s.hp = s.maxHp = 2;
    const foe = foeAt(g, ACTOR.BRUISER, 500, 760);
    const log = run(g, 10);
    assert.ok(ofKind(log, EV.S_DEL).length >= 1, 'it knocks a wall down');
    assert.ok(foe.x > west * CELL + CELL, 'and walks through the gap');
  }));

  test('thrower: a wall on the flow line stops it and takes the snow', () => withoutWaves(() => {
    const g = arena();
    place(g, HERO, 1500, 200);
    g.actors.get(HERO).flags |= AFLAG.GRACE;
    // Seal the Colonel so that any path must break through.
    const ring = [];
    for (let cx = 19; cx <= 26; cx++) { ring.push([cx, 11], [cx, 18]); }
    for (let cy = 12; cy <= 17; cy++) { ring.push([19, cy], [26, cy]); }
    const walls = ring.map(([cx, cy]) => wall(g, cx, cy, STRUCT.ICEWALL));
    const foe = foeAt(g, ACTOR.PIPSQUEAK, 500, 600);
    const log = run(g, 12);
    assert.ok(ballsFrom(log, foe.id).length >= 2);
    assert.ok(walls.some((s) => s.hp < s.maxHp), 'a wall took the hits');
    assert.equal(g.colonel(TEAM.A).hp, g.colonel(TEAM.A).maxHp, 'not the Colonel');
    assert.ok(foe.x < 19 * CELL, 'it never got through');
  }));

  test('a walking foe that makes no progress for 3 s hops to the next flow cell', () => withoutWaves(() => {
    const g = arena();
    g.removePlayer(HERO);
    const foe = foeAt(g, ACTOR.PIPSQUEAK, 300, 600);
    g.moveActor = () => null;   // glued to the spot
    const start = { x: foe.x, y: foe.y };
    run(g, 2.8);
    assert.deepEqual({ x: foe.x, y: foe.y }, start);
    run(g, 0.4);
    assert.ok(distance(foe, start) >= 12, 'hopped');
    assert.equal(foe.x % CELL, CELL / 2, 'to a cell centre');
    assert.equal(foe.y % CELL, CELL / 2);
  }));
});

describe('Pipsqueak and Slinger', () => {
  test('flat throw flight follows the spec', () => withoutWaves(() => {
    const g = arena();
    const foe = foeAt(g, ACTOR.PIPSQUEAK, 600, 600);
    const kid = place(g, HERO, 760, 600);
    const log = run(g, 2);
    const ball = ballsFrom(log, foe.id)[0];
    assert.ok(ball, 'threw');
    const st = FOES[ACTOR.PIPSQUEAK];
    const speed = Math.hypot(ball.vx, ball.vy);
    assert.ok(Math.abs(speed - st.ballSpeed) < 1);
    const dist = 160;
    const wantTicks = Math.round(Math.min(st.range + 60, dist + 40) / st.ballSpeed / DT);
    const z0 = THROW.z0;
    const gravity = (2 * z0) / (DT * DT * wantTicks * (wantTicks - 1));
    assert.ok(Math.abs(ball.g - gravity) / gravity < 0.2, `ball.g ${ball.g} want ${gravity}`);
    assert.ok(kid.hp <= KID.maxWarmth);
  }));

  test('Pipsqueaks spread their throws, Slingers do not', () => withoutWaves(() => {
    const spreadOf = (kind) => {
      const g = arena();
      const foe = foeAt(g, kind, 600, 600);
      place(g, HERO, 760, 600);
      const kid = g.actors.get(HERO);
      kid.takeDmgMul = 0;
      const angles = ballsFrom(run(g, 30), foe.id).map((b) => Math.atan2(b.vy, b.vx));
      assert.ok(angles.length >= 8);
      return Math.max(...angles) - Math.min(...angles);
    };
    assert.ok(spreadOf(ACTOR.PIPSQUEAK) > spreadOf(ACTOR.SLINGER) * 2);
  }));

  test('Slingers keep long range and back away from a kid who closes in', () => withoutWaves(() => {
    const g = arena();
    const foe = foeAt(g, ACTOR.SLINGER, 500, 600);
    const kid = place(g, HERO, 620, 600);
    kid.takeDmgMul = 0;
    const before = distance(foe, kid);
    run(g, 1);
    assert.ok(distance(foe, kid) > before + 20, 'gives ground');
  }));

  test('Slingers lead a moving kid a little', () => withoutWaves(() => {
    const g = arena({ players: [human()] });
    const foe = foeAt(g, ACTOR.SLINGER, 500, 400);
    const kid = place(g, HERO, 500, 620);
    kid.takeDmgMul = 0;
    const aimed = [];
    for (let i = 0; i < 90 && aimed.length === 0; i++) {
      kid.vx = 200; kid.x = 400 + i * 2;
      g.step();
      for (const ball of ballsFrom(g.drainEvents(), foe.id)) {
        const straight = Math.atan2(kid.y - foe.y, kid.x - foe.x);
        aimed.push(Math.atan2(ball.vy, ball.vx) - straight);
      }
    }
    assert.ok(aimed.length > 0, 'threw');
    assert.ok(aimed[0] < -0.05, 'aims ahead of a kid moving to the right of it');
  }));
});

describe('Lobber', () => {
  test('hangs back and lobs at the Colonel over everything', () => withoutWaves(() => {
    const g = arena();
    g.removePlayer(HERO);
    const foe = foeAt(g, ACTOR.LOBBER, 30, 600);
    const log = run(g, 10);
    const balls = ballsFrom(log, foe.id);
    assert.ok(balls.length >= 1);
    assert.equal(balls[0].k, BALL.LOB);
    assert.ok(balls[0].ft > 0, 'clients get the landing spot');
    assert.ok(Math.hypot(balls[0].lx - g.map.fort.x, balls[0].ly - g.map.fort.y) < 10);
    assert.ok(distance(foe, g.map.fort) > 400, 'stays far');
  }));

  test('prefers a cluster of kids', () => withoutWaves(() => {
    const g = arena({ players: [human(1), human(2), human(3)] });
    for (const id of [1, 2, 3]) g.actors.get(id).takeDmgMul = 0;
    place(g, 1, 900, 300); place(g, 2, 960, 300); place(g, 3, 930, 340);
    const foe = foeAt(g, ACTOR.LOBBER, 560, 300);
    const log = run(g, 3.5);
    const lob = ballsFrom(log, foe.id)[0];
    assert.ok(lob, 'lobbed');
    assert.ok(Math.hypot(lob.lx - 930, lob.ly - 313) < 40, `landed at ${lob.lx},${lob.ly}`);
  }));

  test('lobs at a structure in range before walking on', () => withoutWaves(() => {
    const g = arena();
    g.actors.get(HERO).flags |= AFLAG.GRACE;
    const s = wall(g, 8, 15);
    place(g, HERO, 1700, 200);
    const foe = foeAt(g, ACTOR.LOBBER, 30, 600);
    const log = run(g, 4);
    assert.ok(distance(foe, { x: 30, y: 600 }) < 60, 'already in range, so it stops at once');
    const lob = ballsFrom(log, foe.id)[0];
    assert.ok(lob, 'lobbed');
    assert.ok(Math.hypot(lob.lx - (s.cx + 0.5) * CELL, lob.ly - (s.cy + 0.5) * CELL) < 5);
  }));

  test('backs off from a kid who gets close', () => withoutWaves(() => {
    const g = arena();
    const foe = foeAt(g, ACTOR.LOBBER, 700, 300);
    const kid = place(g, HERO, 780, 300);
    kid.takeDmgMul = 0;
    const before = distance(foe, kid);
    run(g, 2.5);
    assert.ok(distance(foe, kid) > before + 15);
  }));
});

describe('Big Kid', () => {
  test('ignores kids beyond arm\'s reach', () => withoutWaves(() => {
    const g = arena();
    const foe = foeAt(g, ACTOR.BRUISER, 300, 600);
    const kid = place(g, HERO, 400, 400);
    run(g, 2);
    assert.equal(kid.hp, KID.maxWarmth);
    assert.ok(foe.x > 400, 'keeps walking the flow field');
  }));

  test('shoves a kid in range: damage and knockback', () => withoutWaves(() => {
    const g = arena();
    const foe = foeAt(g, ACTOR.BRUISER, 300, 600);
    const kid = place(g, HERO, 335, 600);
    const log = run(g, 1.2);
    assert.ok(kid.hp <= KID.maxWarmth - FOES[ACTOR.BRUISER].dmg + 0.001);
    const hit = ofKind(log, EV.HIT).find((h) => h.id === HERO);
    assert.equal(hit.by, foe.id);
    assert.equal(hit.k, -1, 'melee');
    assert.ok(kid.x > 345, 'knocked back');
  }));

  test('shoves walls for dmg per cd', () => withoutWaves(() => {
    const g = arena();
    g.actors.get(HERO).flags |= AFLAG.GRACE;
    place(g, HERO, 1700, 200);
    const ring = [];
    for (let cx = 19; cx <= 26; cx++) { ring.push([cx, 11], [cx, 18]); }
    for (let cy = 12; cy <= 17; cy++) { ring.push([19, cy], [26, cy]); }
    const walls = ring.map(([cx, cy]) => wall(g, cx, cy, STRUCT.ICEWALL));
    foeAt(g, ACTOR.BRUISER, 700, 600);
    run(g, 6);
    const lost = walls.reduce((sum, s) => sum + (s.maxHp - s.hp), 0);
    assert.ok(lost >= FOES[ACTOR.BRUISER].dmg * 2 && lost <= FOES[ACTOR.BRUISER].dmg * 6, `lost ${lost}`);
  }));

  test('leans on the Colonel when it arrives', () => withoutWaves(() => {
    const g = arena();
    g.removePlayer(HERO);
    const foe = foeAt(g, ACTOR.BRUISER, 700, 600);
    run(g, 6);
    const col = g.colonel(TEAM.A);
    assert.ok(col.hp <= col.maxHp - FOES[ACTOR.BRUISER].dmg);
    assert.ok(distance(foe, g.map.fort) < 120);
  }));
});

describe('Sledder', () => {
  test('sleds in on its lane and crashes into the first wall', () => withoutWaves(() => {
    const g = arena();
    place(g, HERO, 1700, 200);
    const barrier = [13, 14, 15, 16].map((cy) => wall(g, 18, cy));
    const foe = foeAt(g, ACTOR.SLEDDER, 300, 600);
    assert.ok(foe.flags & AFLAG.SLEDDING);
    const log = run(g, 1.5);
    assert.equal(foe.flags & AFLAG.SLEDDING, 0, 'the sled is finished');
    assert.equal(foe.kind, ACTOR.SLEDDER, 'still a Sledder, now on foot');
    assert.ok(barrier.some((s) => s.hp <= s.maxHp - 0.5) || ofKind(log, EV.S_DEL).length > 0, 'the wall took it');
    assert.ok(ofKind(log, EV.SFX).some((e) => e.name === SFX.SLED_CRASH));
  }));

  test('fights on with the foot stats after a crash', () => withoutWaves(() => {
    const g = arena();
    const foe = foeAt(g, ACTOR.SLEDDER, 300, 600);
    g.step();
    foe.flags &= ~AFLAG.SLEDDING;   // as a crash leaves it
    const kid = place(g, HERO, 420, 600);
    kid.takeDmgMul = 0;
    const log = run(g, 3);
    const balls = ballsFrom(log, foe.id);
    assert.ok(balls.length >= 1);
    assert.ok(Math.abs(Math.hypot(balls[0].vx, balls[0].vy) - FOES[ACTOR.SLEDDER].ballSpeed) < 1);
  }));

  test('runs a kid over and keeps going', () => withoutWaves(() => {
    const g = arena();
    const kid = place(g, HERO, 400, 600);
    const foe = foeAt(g, ACTOR.SLEDDER, 150, 600);
    let stunnedAt = null;
    run(g, 1.3, () => { if (stunnedAt === null && kid.stunT > 0) stunnedAt = kid.stunT; });
    const st = FOES[ACTOR.SLEDDER];
    assert.ok(kid.hp <= KID.maxWarmth - st.kidDmg + 0.001, `hp ${kid.hp}`);
    assert.ok(stunnedAt > st.kidStun - 0.1 && stunnedAt <= st.kidStun, `stun ${stunnedAt}`);
    assert.ok(foe.flags & AFLAG.SLEDDING, 'the sled keeps going');
    assert.ok(foe.x > 500);
  }));

  test('a kid only gets run over once per sled', () => withoutWaves(() => {
    const g = arena();
    const kid = place(g, HERO, 400, 600);
    foeAt(g, ACTOR.SLEDDER, 300, 600);
    const log = run(g, 1);
    assert.equal(ofKind(log, EV.HIT).filter((h) => h.id === HERO).length, 1);
    assert.ok(kid.hp < KID.maxWarmth);
  }));

  test('takes a lane that actually reaches the fort when one exists', () => withoutWaves(() => {
    for (const map of MAPS) {
      const g = arena({ mapId: map.id });
      g.removePlayer(HERO);
      const gate = map.entrances[0];
      const foe = foeAt(g, ACTOR.SLEDDER, gate.x, gate.y);
      const col = g.colonel(TEAM.A);
      run(g, 5);
      assert.equal(foe.flags & AFLAG.SLEDDING, 0, map.id);
      assert.ok(col.hp < col.maxHp, `${map.id}: the Colonel took the hit`);
    }
  }));
});

describe('Lid Kid', () => {
  test('carries its shield from the moment it arrives', () => withoutWaves(() => {
    const g = arena();
    const foe = g.spawnFoe(ACTOR.LIDKID, 300, 600);
    dressFoe(foe);
    assert.ok(foe.flags & AFLAG.SHIELDED);
    assert.ok(foe.flags & AFLAG.GRACE);
  }));

  test('turns no faster than turnRate', () => withoutWaves(() => {
    const g = arena();
    const foe = foeAt(g, ACTOR.LIDKID, 500, 600);
    foe.aim = 0;
    const kid = place(g, HERO, 400, 600);
    kid.takeDmgMul = 0;
    let last = foe.aim;
    let turned = 0;
    run(g, 1.5, () => {
      const step = Math.abs(Math.atan2(Math.sin(foe.aim - last), Math.cos(foe.aim - last)));
      assert.ok(step <= FOES[ACTOR.LIDKID].turnRate * DT + 1e-9, `turned ${step} in a tick`);
      turned += step;
      last = foe.aim;
    });
    assert.ok(turned > 1, 'but it does turn');
  }));

  test('a kid can out-turn it inside 200 units', () => withoutWaves(() => {
    const g = arena();
    const foe = foeAt(g, ACTOR.LIDKID, 700, 300);
    const kid = place(g, HERO, 640, 300);
    kid.takeDmgMul = 0;
    let bestGap = 0;
    run(g, 3, () => {
      // A circle strafe at kid speed around a foe 60 units away.
      const a = (g.tick * DT * KID.speed) / 60;
      kid.x = foe.x + Math.cos(a) * 60;
      kid.y = foe.y + Math.sin(a) * 60;
      const toKid = Math.atan2(kid.y - foe.y, kid.x - foe.x);
      const gap = Math.abs(Math.atan2(Math.sin(toKid - foe.aim), Math.cos(toKid - foe.aim)));
      bestGap = Math.max(bestGap, gap);
    });
    assert.ok(bestGap > FOES[ACTOR.LIDKID].shieldArc / 2, 'the kid gets behind the lid');
  }));

  test('blocks flat balls from the front, not from behind, and never lobs', () => withoutWaves(() => {
    const g = arena();
    const foe = foeAt(g, ACTOR.LIDKID, 700, 300);
    foe.ai.awake = false;
    foe.aim = 0;
    foe.flags |= AFLAG.STUNNED;
    foe.stunT = 100;
    const kid = g.actors.get(HERO);
    const hp0 = foe.hp;

    place(g, HERO, 800, 300);
    g.throwFlat(kid, Math.PI, { speed: 500, flight: 0.5, dmg: 10, kind: BALL.QUICK });
    run(g, 0.5);
    assert.equal(foe.hp, hp0, 'front: blocked');

    place(g, HERO, 600, 300);
    g.throwFlat(kid, 0, { speed: 500, flight: 0.5, dmg: 10, kind: BALL.QUICK });
    run(g, 0.5);
    assert.equal(foe.hp, hp0 - 10, 'back: hit');

    place(g, HERO, 800, 300);
    g.throwLob(kid, 700, 300, { dmg: 10, splash: 40 });
    run(g, 1.2);
    assert.equal(foe.hp, hp0 - 20, 'lob: hit from the front anyway');
  }));
});

describe('Carrot Thief', () => {
  test('ignores kids, runs to the Colonel and takes a carrot', () => withoutWaves(() => {
    const g = arena();
    const kid = place(g, HERO, 500, 620);
    const foe = foeAt(g, ACTOR.SNEAK, 400, 600);
    const col = g.colonel(TEAM.A);
    const log = run(g, 6, () => (foe.aux & AUX.NOSE ? false : undefined));
    assert.ok(foe.aux & AUX.NOSE, 'got the nose');
    assert.equal(foe.flags & AFLAG.FLEEING, 0, 'a carrier is not FLEEING, so it stays hittable');
    assert.equal(kid.hp, KID.maxWarmth, 'never bothered the kid');
    assert.ok(ofKind(log, EV.SFX).some((e) => e.name === SFX.NOSE_GRAB));
    assert.equal(col.hp, col.maxHp, 'no hp lost yet');
  }));

  test('vaults built walls, at reduced speed', () => withoutWaves(() => {
    const g = arena();
    place(g, HERO, 1700, 200);
    const ring = [];
    for (let cx = 19; cx <= 26; cx++) { ring.push([cx, 11], [cx, 18]); }
    for (let cy = 12; cy <= 17; cy++) { ring.push([19, cy], [26, cy]); }
    ring.forEach(([cx, cy]) => wall(g, cx, cy));
    const foe = foeAt(g, ACTOR.SNEAK, 600, 600);
    run(g, 6, () => (foe.aux & AUX.NOSE ? false : undefined));
    assert.ok(foe.aux & AUX.NOSE, 'only kids can stop it');
  }));

  test('escape costs the Colonel stealPct of max hp over countMul, and pays no Flakes', () => withoutWaves(() => {
    const g = arena();
    g.countMul = 2;
    const col = g.colonel(TEAM.A);
    const flakes0 = g.flakes[TEAM.A];
    const foe = foeAt(g, ACTOR.SNEAK, 200, 600);
    foe.aux |= AUX.NOSE;
    foe.x = 60;
    const log = run(g, 3);
    assert.ok(!g.actors.has(foe.id), 'gone');
    const want = (FOES[ACTOR.SNEAK].stealPct * col.maxHp) / 2;
    assert.ok(Math.abs(col.maxHp - col.hp - want) < 0.01, `lost ${col.maxHp - col.hp}`);
    assert.equal(g.flakes[TEAM.A], flakes0);
    assert.ok(ofKind(log, EV.BARK).some((b) => b.id === col.id), 'and he shouts about it');
  }));

  test('finds its way out even when the nearest edge is behind a house', () => withoutWaves(() => {
    const g = arena();
    const foe = foeAt(g, ACTOR.SNEAK, 180, 260);
    foe.aux |= AUX.NOSE;
    run(g, 12);
    assert.ok(!g.actors.has(foe.id), 'reached an open edge');
  }));

  test('freezing a carrier saves the nose and pays out', () => withoutWaves(() => {
    const g = arena();
    const col = g.colonel(TEAM.A);
    const foe = foeAt(g, ACTOR.SNEAK, 800, 500);
    foe.aux |= AUX.NOSE;
    const kid = g.actors.get(HERO);
    const flakes0 = g.flakes[TEAM.A];
    g.damageActor(foe, 1000, kid, {});
    assert.ok(foe.flags & AFLAG.FLEEING);
    assert.ok(g.flakes[TEAM.A] > flakes0, 'its Flakes');
    run(g, 8);
    assert.equal(col.hp, col.maxHp, 'no hp lost');
    assert.equal(g.meta().colonels[0].nose, true);
  }));
});

describe('The Sno-Cone Truck', () => {
  function truckFight(mapId = 'court', players = [human()]) {
    const g = arena({ mapId, players });
    const gate = g.map.entrances[0];
    const truck = g.spawnFoe(ACTOR.TRUCK, g.map.truckPath[0].x, g.map.truckPath[0].y);
    truck.graceT = 0;
    truck.flags &= ~AFLAG.GRACE;
    assert.ok(gate);
    return { g, truck };
  }

  test('drives its loop on every map without wedging', () => withoutWaves(() => {
    for (const map of MAPS) {
      const { g, truck } = truckFight(map.id);
      g.removePlayer(HERO);
      g.colonel(TEAM.A).hp = g.colonel(TEAM.A).maxHp = 1e9;
      const visited = new Set();
      run(g, 70, () => { visited.add(truck.ai.leg); });
      assert.equal(visited.size, map.truckPath.length, `${map.id} covered ${visited.size} of ${map.truckPath.length} legs`);
    }
  }));

  test('parks on schedule with doors open and double damage', () => withoutWaves(() => {
    const { g, truck } = truckFight();
    g.removePlayer(HERO);
    g.colonel(TEAM.A).hp = g.colonel(TEAM.A).maxHp = 1e9;
    const { parkEvery, parkTime, parkDmgMul } = BOSS.truck;
    let opened = null, closed = null;
    run(g, parkEvery + parkTime + 2, () => {
      const doors = (truck.aux & AUX.DOORS) !== 0;
      if (doors && opened === null) { opened = g.time; assert.equal(truck.takeDmgMul, parkDmgMul); }
      if (!doors && opened !== null && closed === null) { closed = g.time; assert.equal(truck.takeDmgMul, 1); }
      if (doors) assert.equal(Math.hypot(truck.vx, truck.vy), 0, 'parked means parked');
    });
    assert.ok(opened !== null && closed !== null);
    assert.ok(Math.abs(closed - opened - parkTime) < 0.1);
  }));

  test('door squad is round(doorSquad × countMul) Pipsqueaks worth no Flakes', () => withoutWaves(() => {
    const { g, truck } = truckFight();
    g.removePlayer(HERO);
    g.colonel(TEAM.A).hp = g.colonel(TEAM.A).maxHp = 1e9;
    g.countMul = 2.2;
    const log = run(g, BOSS.truck.parkEvery + 1);
    const squad = ofKind(log, EV.SPAWN).filter((s) => s.id !== truck.id);
    assert.equal(squad.length, Math.round(BOSS.truck.doorSquad * 2.2));
    assert.ok(ofKind(log, EV.SFX).some((e) => e.name === SFX.TRUCK_DOORS));
    for (const s of squad) {
      assert.equal(s.k, ACTOR.PIPSQUEAK);
      assert.ok(distance(s, truck) < truck.r + 60, 'out of the rear doors');
      const kid = g.actors.get(s.id);
      assert.equal(kid.noFlakes, true);
    }
  }));

  test('turret fires three CONE balls at the nearest kid in range, else a struct', () => withoutWaves(() => {
    const { g, truck } = truckFight();
    const kid = place(g, HERO, truck.x + 200, truck.y);
    kid.takeDmgMul = 0;
    const log = run(g, 3);
    const volley = ballsFrom(log, truck.id);
    assert.ok(volley.length >= 3);
    assert.equal(volley.length % 3, 0);
    assert.ok(volley.every((b) => b.k === BALL.CONE));
    const first = volley.slice(0, 3).map((b) => Math.atan2(b.vy, b.vx)).sort((a, b) => a - b);
    assert.ok(Math.abs(first[1] - first[0] - BOSS.truck.coneSpread) < 0.01);
    assert.ok(Math.abs(Math.hypot(volley[0].vx, volley[0].vy) - BOSS.truck.ballSpeed) < 1);

    const lone = truckFight();
    lone.g.colonel(TEAM.A).hp = lone.g.colonel(TEAM.A).maxHp = 1e9;
    place(lone.g, HERO, 1700, 200);
    lone.g.actors.get(HERO).flags |= AFLAG.GRACE;
    const shots = ballsFrom(run(lone.g, 3), lone.truck.id);
    assert.ok(shots.length >= 3, 'with no kid about, it shoots the Colonel');
  }));

  test('crushes structures in its path but not the Colonel', () => withoutWaves(() => {
    const { g, truck } = truckFight();
    place(g, HERO, 1700, 200);
    g.actors.get(HERO).flags |= AFLAG.GRACE;
    const next = g.map.truckPath[1];
    const cell = g.cw.cellOf(next.x, next.y);
    const victim = wall(g, cell.cx, cell.cy, STRUCT.ICEWALL);
    assert.ok(g.structs.has(victim.id));
    const log = run(g, 6, () => (g.structs.has(victim.id) ? undefined : false));
    assert.ok(!g.structs.has(victim.id), 'flattened');
    assert.ok(ofKind(log, EV.S_DEL).some((e) => e.id === victim.id));
    assert.ok(truck.hp === truck.maxHp);
  }));

  test('defeated, it drives off the edge on every map, escorts in tow', () => withoutWaves(() => {
    for (const map of MAPS) {
      const { g, truck } = truckFight(map.id);
      g.colonel(TEAM.A).hp = g.colonel(TEAM.A).maxHp = 1e9;
      g.actors.get(HERO).takeDmgMul = 0;
      run(g, 20);
      const squad = g.foes().filter((f) => f.kind === ACTOR.PIPSQUEAK);
      assert.ok(squad.length > 0);
      const flakes0 = g.flakes[TEAM.A];
      g.damageActor(truck, 1e6, g.actors.get(HERO), {});
      assert.ok(g.flakes[TEAM.A] >= flakes0 + FOES[ACTOR.TRUCK].flakes / Math.sqrt(g.countMul) - 0.01);
      assert.ok(squad.every((f) => f.flags & AFLAG.FLEEING), 'when a boss falls its escorts flee too');
      const from = { x: truck.x, y: truck.y };
      let moved = 0;
      run(g, 13, () => {
        moved = Math.max(moved, distance(truck, from));
        return g.actors.has(truck.id) ? undefined : false;
      });
      assert.ok(!g.actors.has(truck.id), `${map.id}: gone`);
      assert.ok(moved > 100, `${map.id}: actually drove`);
      assert.ok(Math.min(truck.x, truck.y, map.w - truck.x, map.h - truck.y) < truck.r + 16, `${map.id}: left at the edge, ended ${truck.x},${truck.y}`);
    }
  }));
});

describe('Abominable Steve', () => {
  function steveFight(mapId = 'court', x = 60, y = 600) {
    const g = arena({ mapId });
    const steve = g.spawnFoe(ACTOR.STEVE, x, y);
    steve.graceT = 0;
    steve.flags &= ~AFLAG.GRACE;
    return { g, steve };
  }

  test('walks up to stopDist from the Colonel on every map, from every entrance', () => withoutWaves(() => {
    for (const map of MAPS) {
      for (const gate of map.entrances) {
        const { g, steve } = steveFight(map.id, gate.x, gate.y);
        g.removePlayer(HERO);
        g.colonel(TEAM.A).hp = g.colonel(TEAM.A).maxHp = 1e9;
        run(g, 24);
        const d = distance(steve, map.fort);
        assert.ok(d <= BOSS.steve.stopDist + 4 && d >= BOSS.steve.stopDist - 12, `${map.id} ended ${d.toFixed(0)} away`);
      }
    }
  }));

  test('POUND telegraphs, then hurts everything in the radius and shakes the camera', () => withoutWaves(() => {
    const { g, steve } = steveFight('court', 500, 300);
    const near = place(g, HERO, 580, 300);
    const s = wall(g, 12, 9);
    place(g, HERO, 580, 300);
    let telegraphAt = null, landAt = null;
    const log = run(g, 4, (events) => {
      if (telegraphAt === null && steve.aux & AUX.POUND) telegraphAt = g.time;
      if (landAt === null && ofKind(events, EV.QUAKE).length) landAt = g.time;
      return landAt === null ? undefined : false;
    });
    assert.ok(telegraphAt !== null && landAt !== null);
    assert.ok(Math.abs(landAt - telegraphAt - BOSS.steve.poundTelegraph) < 0.1);
    assert.equal(steve.aux & AUX.POUND, 0);
    assert.ok(near.hp <= KID.maxWarmth - FOES[ACTOR.STEVE].dmg + 0.001);
    assert.ok(s.hp <= s.maxHp - FOES[ACTOR.STEVE].dmg + 0.001);
    assert.equal(ofKind(log, EV.QUAKE)[0].amt, 1);
    assert.ok(ofKind(log, EV.SFX).some((e) => e.name === SFX.STEVE_POUND));
  }));

  test('throws a BOULDER when nothing is close, and on every third attack regardless', () => withoutWaves(() => {
    const { g, steve } = steveFight('court', 300, 600);
    g.colonel(TEAM.A).hp = g.colonel(TEAM.A).maxHp = 1e9;
    const kid = place(g, HERO, 700, 600);
    kid.takeDmgMul = 0;
    let boulder = null;
    const log = run(g, 5, (events) => {
      boulder ??= ballsFrom(events, steve.id).find((b) => b.k === BALL.BOULDER) ?? null;
      return boulder ? false : undefined;
    });
    assert.ok(boulder, 'nothing within poundRadius, so it rolls one');
    assert.equal(boulder.r, BOSS.steve.boulderR0);
    assert.equal(boulder.rMax, BOSS.steve.boulderR1);
    assert.ok(Math.abs(boulder.grow - (BOSS.steve.boulderR1 - BOSS.steve.boulderR0) / BOSS.steve.boulderLife) < 0.01);
    assert.ok(Math.abs(Math.hypot(boulder.vx, boulder.vy) - BOSS.steve.boulderSpeed) < 1);
    assert.equal(ofKind(log, EV.QUAKE).length, 0);

    const close = steveFight('court', 500, 300);
    close.g.colonel(TEAM.A).hp = close.g.colonel(TEAM.A).maxHp = 1e9;
    close.steve.speed = 0;
    const friend = place(close.g, HERO, 560, 300);
    friend.takeDmgMul = 0;
    const attacks = [];
    run(close.g, 12, (events) => {
      if (ofKind(events, EV.QUAKE).length) attacks.push('pound');
      if (ballsFrom(events, close.steve.id).some((b) => b.k === BALL.BOULDER)) attacks.push('boulder');
    });
    assert.deepEqual(attacks.slice(0, 3).sort(), ['boulder', 'pound', 'pound']);
    assert.equal(attacks[2], 'boulder', 'every third attack');
  }));

  test('below enrageAt: ENRAGED, faster, and the blizzard rolls in', () => withoutWaves(() => {
    const { g, steve } = steveFight('court', 60, 600);
    g.removePlayer(HERO);
    g.colonel(TEAM.A).hp = g.colonel(TEAM.A).maxHp = 1e9;
    run(g, 2);
    const walked = (seconds) => {
      const from = { x: steve.x, y: steve.y };
      run(g, seconds);
      return distance(steve, from) / seconds;
    };
    const calm = walked(1);
    assert.ok(Math.abs(calm - steve.speed) < 6, `calm speed ${calm}`);
    assert.equal(g.blizzard, false);
    steve.hp = steve.maxHp * BOSS.steve.enrageAt - 1;
    const log = run(g, 0.1);
    assert.ok(steve.flags & AFLAG.ENRAGED);
    assert.equal(g.blizzard, true);
    assert.ok(ofKind(log, EV.SFX).some((e) => e.name === SFX.STEVE_ROAR));
    const angry = walked(1);
    assert.ok(Math.abs(angry - steve.speed * BOSS.steve.enrageSpeedMul) < 8, `enraged speed ${angry}`);
  }));

  test('escorts arrive every escortEvery: 3 Pipsqueaks + 1 Slinger × countMul, no Flakes', () => withoutWaves(() => {
    const { g, steve } = steveFight('court', 60, 600);
    g.removePlayer(HERO);
    g.colonel(TEAM.A).hp = g.colonel(TEAM.A).maxHp = 1e9;
    g.countMul = 2;
    const log = run(g, BOSS.steve.escortEvery + 1);
    const arrivals = ofKind(log, EV.SPAWN).filter((s) => s.id !== steve.id);
    assert.equal(arrivals.filter((s) => s.k === ACTOR.PIPSQUEAK).length, 6);
    assert.equal(arrivals.filter((s) => s.k === ACTOR.SLINGER).length, 2);
    for (const a of arrivals) assert.equal(g.actors.get(a.id).noFlakes, true);
  }));

  test('defeated: he sits down, the crowd cheers, and he goes home', () => withoutWaves(() => {
    const { g, steve } = steveFight();
    g.actors.get(HERO).flags |= AFLAG.GRACE;
    g.damageActor(steve, 1e6, g.actors.get(HERO), {});
    assert.ok(steve.flags & AFLAG.FLEEING);
    const seat = { x: steve.x, y: steve.y };
    const log = run(g, 3);
    assert.deepEqual({ x: steve.x, y: steve.y }, seat, 'sitting means sitting');
    assert.ok(ofKind(log, EV.SFX).some((e) => e.name === SFX.CHEER));
    assert.ok(ofKind(log, EV.BARK).some((b) => b.id === steve.id));
    assert.ok(g.actors.has(steve.id));
    run(g, 3);
    assert.ok(!g.actors.has(steve.id));
  }));
});

describe('scaling', () => {
  test('foe count, boss hp and Colonel hp follow the head-count formulas', () => {
    const players = [human(1), human(2), bot(3), bot(4)];
    const g = new Game({ mode: MODE.SIEGE, mapId: 'court', difficulty: DIFFICULTY.BLIZZARD, waveCount: 10, seed: 1, players });
    const weighted = 2 + 2 * SIEGE.botPlayerWeight;
    assert.equal(g.weightedPlayers(), weighted);
    assert.ok(Math.abs(g.countMul - (1 + SIEGE.perExtraPlayerCount * (weighted - 1))) < 1e-9);
    assert.ok(Math.abs(g.colonel(TEAM.A).maxHp - BUILD[STRUCT.COLONEL].hp * (1 + SIEGE.colonelHpPerExtraPlayer * (weighted - 1))) < 1e-9);
    const runner = new WaveRunner(g, 1);
    assert.equal(runner.remaining, expectedCount(WAVES[1].foes[ACTOR.PIPSQUEAK], DIFFICULTY.BLIZZARD, g.countMul));
    const foe = g.spawnFoe(ACTOR.PIPSQUEAK, 30, 600);
    assert.ok(Math.abs(foe.maxHp - FOES[ACTOR.PIPSQUEAK].hp * DIFF.blizzard.hp * (1 + SIEGE.perExtraPlayerHp * (weighted - 1))) < 1e-9);
    const boss = g.spawnFoe(ACTOR.TRUCK, 30, 600, { hpMul: 1.3 });
    assert.ok(Math.abs(boss.maxHp - FOES[ACTOR.TRUCK].hp * DIFF.blizzard.hp * (1 + SIEGE.perExtraPlayerBossHp * (weighted - 1)) * 1.3) < 1e-9);
  });

  test('in the real sim a huge wave waits at the door instead of breaking MAX_ACTORS', () => {
    const g = new Game({ mode: MODE.SIEGE, mapId: 'court', difficulty: DIFFICULTY.NORMAL, waveCount: 0, seed: 2, players: [human()] });
    g.command(HERO, { c: CMD.READY });
    g.removePlayer(HERO);
    g.colonel(TEAM.A).hp = g.colonel(TEAM.A).maxHp = 1e9;
    const runner = new WaveRunner(g, 33);
    const total = runner.remaining;
    assert.ok(total > MAX_ACTORS, `only ${total} foes`);
    for (let i = 0; i < 70 * SIM_HZ; i++) {
      g.step();
      runner.update();
      g.drainEvents();
      assert.ok(g.foes().length <= MAX_ACTORS);
    }
    assert.equal(g.foes().length, MAX_ACTORS);
    assert.ok(runner.remaining > 0 && !runner.done, 'the rest are queued');
    const waiting = runner.remaining;
    for (const foe of g.foes()) g.despawn(foe);
    g.step();
    runner.update();
    assert.equal(g.foes().length, Math.min(MAX_ACTORS, waiting), 'and they walk in as soon as there is room');
    assert.ok(runner.remaining < waiting);
  });

  test('a wave run through the real sim spawns what the preview promised', () => {
    const g = new Game({ mode: MODE.SIEGE, mapId: 'pond', difficulty: DIFFICULTY.NORMAL, waveCount: 10, seed: 4, players: [human()] });
    const promised = g.meta().next;
    assert.ok(promised.from.length >= 1);
    g.command(HERO, { c: CMD.READY });
    const kid = g.actors.get(HERO);
    kid.takeDmgMul = 0;
    const spawned = {};
    for (let i = 0; i < 40 * SIM_HZ; i++) {
      g.step();
      for (const ev of g.drainEvents()) if (ev.e === EV.SPAWN) spawned[ev.k] = (spawned[ev.k] ?? 0) + 1;
    }
    assert.deepEqual(spawned, Object.fromEntries(promised.foes.map((f) => [f.k, f.n])));
  });
});

describe('buddy bots', () => {
  const buddies = (n) => [human(), ...Array.from({ length: n }, (_, i) => bot(i + 2))];

  test('a frame is always well formed, in every phase and state', () => {
    for (const mode of Object.values(MODE)) {
      const players = mode === MODE.FORTWARS ? [bot(1, TEAM.A), bot(2, TEAM.B)]
        : mode === MODE.FFA ? [bot(1, TEAM.FFA_BASE), bot(2, TEAM.FFA_BASE + 1)] : [bot(1), human(2)];
      const g = new Game({ mode, mapId: 'yard', difficulty: DIFFICULTY.NORMAL, waveCount: 5, seed: 2, players });
      for (let i = 0; i < 90 * SIM_HZ && !g.isOver(); i++) {
        g.step();
        g.drainEvents();
        const frame = botFrame(g, g.actors.get(1));
        for (const key of ['mx', 'my', 'aim', 'tx', 'ty']) assert.ok(Number.isFinite(frame[key]), `${mode} ${key}`);
        assert.equal(frame.seq, 0);
        assert.ok(Number.isInteger(frame.btn));
      }
    }
  });

  test('stay near the fight, not out at the entrances', () => withoutWaves(() => {
    const g = arena({ players: buddies(1) });
    const buddy = g.actors.get(2);
    place(g, HERO, g.map.fort.x, g.map.fort.y - 60);
    const foe = foeAt(g, ACTOR.PIPSQUEAK, 200, 600);
    foe.takeDmgMul = 0;
    foe.speed = 0;
    run(g, 6);
    assert.ok(distance(buddy, g.map.fort) <= 440, `wandered ${distance(buddy, g.map.fort)} from the fort`);
    const quiet = arena({ players: buddies(1) });
    run(quiet, 4);
    assert.ok(distance(quiet.actors.get(2), quiet.map.fort) <= 300, 'idle bots stand guard close by');
  }));

  test('walk toward a threat near the fort and throw at it', () => withoutWaves(() => {
    const g = arena({ players: buddies(1) });
    const buddy = place(g, 2, 920, 480);
    const foe = foeAt(g, ACTOR.BRUISER, 1400, 600);
    foe.takeDmgMul = 0;
    const log = run(g, 8);
    assert.ok(ofKind(log, EV.BALL).filter((b) => b.by === buddy.id).length >= 2, 'thrown at the Big Kid');
  }));

  test('stop to pack when low on snow', () => withoutWaves(() => {
    const g = arena({ players: buddies(1) });
    const buddy = g.actors.get(2);
    buddy.balls = 1;
    let packing = false;
    run(g, 2.5, () => { packing ||= (buddy.flags & AFLAG.PACKING) !== 0; });
    assert.ok(packing);
    assert.ok(buddy.balls > 1);
  }));

  test('leave the ice to pack', () => withoutWaves(() => {
    const g = arena({ mapId: 'pond', players: buddies(1) });
    const buddy = place(g, 2, 700, 280);
    buddy.balls = 0;
    assert.ok(g.cw.isIce(buddy.x, buddy.y));
    run(g, 8);
    assert.ok(buddy.balls >= 3, `packed ${buddy.balls}`);
    assert.ok(!g.cw.isIce(buddy.x, buddy.y));
  }));

  test('thaw a frozen friend', () => withoutWaves(() => {
    const g = arena({ players: buddies(1) });
    const kid = place(g, HERO, 1000, 700);
    const buddy = place(g, 2, 800, 500);
    g.freezeOrFlee(kid, null);
    assert.ok(kid.flags & AFLAG.FROZEN);
    const log = run(g, 6);
    assert.equal(kid.flags & AFLAG.FROZEN, 0);
    const thaw = ofKind(log, EV.THAW)[0];
    assert.equal(thaw.by, buddy.id);
    assert.equal(buddy.stats.thaws, 1);
  }));

  test('only the nearest bot goes to thaw; the rest keep fighting', () => withoutWaves(() => {
    const g = arena({ players: buddies(3) });
    const kid = place(g, HERO, 800, 400);
    place(g, 2, 860, 400);
    const far = place(g, 3, 1200, 800);
    const also = place(g, 4, 1180, 760);
    g.freezeOrFlee(kid, null);
    const start = distance(far, kid), start2 = distance(also, kid);
    run(g, 1);
    assert.ok(distance(far, kid) > start - 100 && distance(also, kid) > start2 - 100);
  }));

  test('lob over a Lid Kid who is facing them, throw when it is not', () => withoutWaves(() => {
    const g = arena({ players: buddies(1) });
    const buddy = place(g, 2, 900, 300);
    const shotsAt = (aim) => {
      const foe = foeAt(g, ACTOR.LIDKID, 1140, 300);
      foe.takeDmgMul = 0;
      foe.aim = aim;
      foe.stunT = 1000;       // holds the lid where this test put it
      place(g, 2, 900, 300);
      buddy.balls = buddy.maxBalls;
      const log = run(g, 4);
      g.despawn(foe);
      return ofKind(log, EV.THROW).filter((t) => t.id === buddy.id);
    };
    const facing = shotsAt(Math.PI);
    assert.ok(facing.length >= 1, 'it took a shot');
    assert.equal(facing[0].lob, true, 'over the lid');
    const turned = shotsAt(0);
    assert.ok(turned.length >= 1);
    assert.equal(turned[0].lob, false, 'a Lid Kid looking the other way just gets a snowball');
  }));

  test('pick up specials on the way past', () => withoutWaves(() => {
    const g = arena({ players: buddies(1) });
    const buddy = place(g, 2, 900, 400);
    g.dropPickup(1100, 400);
    const [pickup] = [...g.pickups.values()];
    assert.ok(pickup, 'dropped');
    run(g, 3);
    assert.equal(g.pickups.size, 0);
    if (pickup.kind === PICKUP.BOARD) assert.ok(buddy.boardT > 0);
  }));

  test('cocoa is left for those who need it', () => withoutWaves(() => {
    const g = arena({ players: buddies(1) });
    const buddy = place(g, 2, 900, 400);
    let id;
    do {
      g.pickups.clear();
      g.dropPickup(1100, 400);
      id = [...g.pickups.values()][0];
    } while (id.kind !== PICKUP.COCOA);
    buddy.hp = buddy.maxHp;
    run(g, 2);
    assert.equal(g.pickups.size, 1);
    place(g, 2, 900, 400);
    buddy.hp = 20;
    run(g, 3);
    assert.equal(g.pickups.size, 0);
  }));

  test('dodge out of a ball\'s way some of the time', () => withoutWaves(() => {
    let dodges = 0;
    for (let trial = 0; trial < 20; trial++) {
      const g = arena({ players: buddies(1), seed: 100 + trial });
      const buddy = place(g, 2, 900, 300);
      buddy.balls = 0;        // busy packing, so any step it takes is a dodge
      run(g, 0.5);
      const foe = foeAt(g, ACTOR.PIPSQUEAK, 1100, 300);
      foe.stunT = 1000;
      g.throwFlat(foe, Math.atan2(buddy.y - foe.y, buddy.x - foe.x), { speed: 360, flight: 0.9, dmg: 6, kind: BALL.QUICK });
      const hp0 = buddy.hp;
      run(g, 1);
      if (buddy.hp === hp0) dodges += 1;
    }
    assert.ok(dodges >= 3 && dodges < 20, `dodged ${dodges} of 20`);
  }));

  test('spend only on repairs with a human on the team, up to a quarter of the pool', () => withoutWaves(() => {
    const g = arena({ players: buddies(2) });
    place(g, HERO, 900, 300);
    place(g, 2, 900, 700);
    place(g, 3, 960, 700);
    const damaged = [wall(g, 21, 11), wall(g, 23, 11), wall(g, 25, 11), wall(g, 21, 9)];
    g.flakes[TEAM.A] = 20;
    g.refreshBudgets();
    for (const s of damaged) s.hp = 5;
    const count = g.structs.size;
    place(g, 2, 900, 560);
    place(g, 3, 960, 560);
    run(g, 3);
    assert.equal(g.structs.size, count, 'bots build nothing new');
    const repaired = damaged.filter((s) => s.hp === s.maxHp).length;
    assert.ok(repaired >= 1, 'but they mend walls');
    assert.ok(20 - g.flakes[TEAM.A] <= 20 * 0.25, `spent ${20 - g.flakes[TEAM.A]}`);
  }));

  test('never spend on the Colonel', () => withoutWaves(() => {
    const g = arena({ players: buddies(2) });
    const col = g.colonel(TEAM.A);
    col.hp = col.maxHp / 2;
    const flakes0 = g.flakes[TEAM.A];
    run(g, 2);
    assert.equal(g.flakes[TEAM.A], flakes0);
    assert.equal(col.hp, col.maxHp / 2);
  }));

  test('walk to a far damaged wall during BUILD and mend it', () => {
    const g = new Game({ mode: MODE.SIEGE, mapId: 'court', difficulty: DIFFICULTY.NORMAL, waveCount: 10, seed: 3, players: buddies(1) });
    g.flakes[TEAM.A] = 100;
    g.refreshBudgets();
    place(g, HERO, 400, 620);
    g.command(HERO, { c: CMD.BUILD, k: STRUCT.WALL, cx: 7, cy: 15 });
    const s = g.structAt(7, 15);
    assert.ok(s);
    s.hp = 5;
    place(g, HERO, 900, 500);
    run(g, 8);
    assert.equal(s.hp, s.maxHp);
  });

  test('never send CARD or READY', () => {
    const g = new Game({ mode: MODE.SIEGE, mapId: 'court', difficulty: DIFFICULTY.NORMAL, waveCount: 10, seed: 3, players: buddies(2) });
    const sent = [];
    const real = g.command.bind(g);
    g.command = (id, cmd) => { sent.push(cmd.c); real(id, cmd); };
    run(g, 40);
    assert.ok(!sent.includes(CMD.CARD) && !sent.includes(CMD.READY));
  });

  test('do not stand on the ground a human wants to build on during BUILD', () => {
    for (const map of MAPS) {
      const g = new Game({ mode: MODE.SIEGE, mapId: map.id, difficulty: DIFFICULTY.NORMAL, waveCount: 10, seed: 3, players: buddies(3) });
      run(g, 12);
      for (const id of [2, 3, 4]) {
        const kid = g.actors.get(id);
        assert.ok(distance(kid, map.fort) >= 150, `${map.id}: bot ${id} is ${distance(kid, map.fort).toFixed(0)} from the fort`);
        assert.equal(kid.balls, kid.maxBalls);
      }
    }
  });
});

describe('Face-Off bots', () => {
  test('a bots-only team builds flingers and a ring; a team with a human leaves that to them', () => {
    const players = [human(1, TEAM.A), bot(2, TEAM.A), bot(3, TEAM.B), bot(4, TEAM.B)];
    const g = new Game({ mode: MODE.FORTWARS, mapId: 'court', difficulty: DIFFICULTY.NORMAL, waveCount: 10, seed: 3, players });
    run(g, 30);
    const ours = [...g.structs.values()].filter((s) => s.team === TEAM.A && s.kind !== STRUCT.COLONEL);
    const theirs = [...g.structs.values()].filter((s) => s.team === TEAM.B && s.kind !== STRUCT.COLONEL);
    assert.equal(ours.length, 0, 'the human decides what the Brigade builds');
    assert.ok(theirs.filter((s) => s.kind === STRUCT.PULT).length >= 1, 'flingers');
    assert.ok(theirs.filter((s) => s.kind === STRUCT.WALL).length >= 6, 'and a ring of walls');
    const col = g.colonel(TEAM.B);
    for (const s of theirs) {
      assert.ok(Math.max(Math.abs(s.cx - col.cx), Math.abs(s.cy - col.cy)) <= 5, 'close around the Colonel');
      assert.ok((s.cx + 0.5) * CELL > g.map.truce.at, 'and on their own half');
    }
  });

  test('the fort grows with difficulty, and a second flinger always turns up', () => {
    const flingersAt = (difficulty, seconds, stayHome = false) => {
      const players = [human(1, TEAM.A), bot(2, TEAM.B)];
      const g = new Game({ mode: MODE.FORTWARS, mapId: 'court', difficulty, waveCount: 10, seed: 3, players });
      place(g, HERO, 200, 620);
      g.actors.get(HERO).takeDmgMul = 0;
      run(g, seconds, () => { if (stayHome) place(g, 2, g.map.forts[1].x - 170, g.map.forts[1].y); });
      return [...g.structs.values()].filter((s) => s.team === TEAM.B && s.kind === STRUCT.PULT).length;
    };
    assert.equal(flingersAt(DIFFICULTY.BLIZZARD, 35), 2);
    assert.equal(flingersAt(DIFFICULTY.NORMAL, 35), 1, 'a new player gets a head start on Normal');
    assert.equal(flingersAt(DIFFICULTY.NORMAL, FORTWARS_BUILD_SECONDS + 110, true), 2, 'if someone is home to build it');
  });

  test('the ring leaves a way out', () => {
    for (const map of MAPS) {
      const players = [bot(1, TEAM.A), bot(2, TEAM.B)];
      const g = new Game({ mode: MODE.FORTWARS, mapId: map.id, difficulty: DIFFICULTY.NORMAL, waveCount: 10, seed: 3, players });
      g.flakes[TEAM.A] = g.flakes[TEAM.B] = 200;
      run(g, FORTWARS_BUILD_SECONDS + 25);
      for (const team of [TEAM.A, TEAM.B]) {
        const home = g.map.forts[team];
        const col = g.colonel(team);
        const from = { cx: col.cx - 1, cy: col.cy };
        assert.ok(walksOut(g, from, home), `${map.id} team ${team}`);
      }
    }
  });

  test('nobody crosses the rope or throws during the truce', () => {
    for (const map of MAPS) {
      const players = [bot(1, TEAM.A), bot(2, TEAM.A), bot(3, TEAM.B), bot(4, TEAM.B)];
      const g = new Game({ mode: MODE.FORTWARS, mapId: map.id, difficulty: DIFFICULTY.NORMAL, waveCount: 10, seed: 3, players });
      const log = run(g, 30, () => {
        for (const kid of g.kids()) {
          const side = Math.sign(kid.x - map.truce.at);
          assert.equal(side, kid.team === TEAM.A ? -1 : 1);
        }
      });
      assert.equal(ofKind(log, EV.BALL).length, 0);
    }
  });

  test('raiders get around their own ring and go after the enemy Colonel', () => {
    for (const map of MAPS) {
      const players = [human(1, TEAM.A), bot(2, TEAM.B)];
      const g = new Game({ mode: MODE.FORTWARS, mapId: map.id, difficulty: DIFFICULTY.BLIZZARD, waveCount: 10, seed: 5, players });
      place(g, HERO, map.forts[0].x - 120, map.forts[0].y);
      run(g, FORTWARS_BUILD_SECONDS + 178, () => (g.phase === PHASE.FIGHT || g.phase === PHASE.BUILD ? undefined : false));
      assert.equal(g.roundWins[TEAM.B], 1, `${map.id}: an undefended Colonel falls before Sudden Thaw`);
    }
  });

  test('a homebody raider runs back when its own Colonel is under attack', () => {
    const players = [human(1, TEAM.A), bot(2, TEAM.B)];
    const g = new Game({ mode: MODE.FORTWARS, mapId: 'court', difficulty: DIFFICULTY.NORMAL, waveCount: 10, seed: 5, players });
    run(g, FORTWARS_BUILD_SECONDS + 1);
    const raider = place(g, 2, 1000, 600);
    const kid = place(g, HERO, g.map.forts[1].x - 250, g.map.forts[1].y - 150);
    kid.takeDmgMul = 0;
    run(g, 1);
    assert.equal(raider.ai.target, kid);
  });
});

const FORTWARS_BUILD_SECONDS = 40;

function walksOut(g, start, home) {
  const seen = new Set();
  const cols = g.cw.cols;
  const queue = [start];
  seen.add(start.cy * cols + start.cx);
  for (let head = 0; head < queue.length; head++) {
    const { cx, cy } = queue[head];
    if (Math.hypot((cx + 0.5) * CELL - home.x, (cy + 0.5) * CELL - home.y) > 300) return true;
    for (const [ox, oy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = cx + ox, ny = cy + oy;
      if (g.cw.isSolidCell(nx, ny) || seen.has(ny * cols + nx)) continue;
      seen.add(ny * cols + nx);
      queue.push({ cx: nx, cy: ny });
    }
  }
  return false;
}

describe('rival bots are a fair fight', () => {
  // A scripted first-time player: walks at the enemy, sidesteps in bursts, throws about every
  // 0.8 s with a shaky aim at where the enemy is now, never dodges on purpose, and only stops
  // to pack once completely out of snow.
  function newPlayerFrame(g, kid, memory, seq) {
    const enemy = g.nearestEnemy(kid, 2000);
    const frame = { seq, mx: 0, my: 0, aim: kid.aim, btn: 0, tx: kid.x, ty: kid.y };
    if (!enemy) return frame;
    const dx = enemy.x - kid.x, dy = enemy.y - kid.y;
    const d = Math.hypot(dx, dy) || 1;
    frame.aim = Math.atan2(dy, dx) + Math.sin(g.tick / 5.3) * 0.1;
    if (kid.balls === 0) memory.packing = true;
    if (kid.balls >= 7) memory.packing = false;
    if (memory.packing) return frame;
    if (d > 300) {
      frame.mx = dx / d;
      frame.my = dy / d;
    } else {
      const sway = Math.sin(g.tick / 37);
      const burst = sway > 0.2 ? 1 : sway < -0.2 ? -1 : 0;
      frame.mx = (-dy / d) * burst;
      frame.my = (dx / d) * burst;
    }
    if (g.tick % 24 < 3 && d < 370) frame.btn = BTN.THROW;
    return frame;
  }

  function duel(difficulty, seed, mapId) {
    const players = [human(1, TEAM.FFA_BASE), bot(2, TEAM.FFA_BASE + 1)];
    const g = new Game({ mode: MODE.FFA, mapId, difficulty, waveCount: 10, seed, players });
    const memory = {};
    let seq = 0;
    while (!g.isOver() && g.tick < 200 * SIM_HZ) {
      seq += 1;
      g.queueInput(1, newPlayerFrame(g, g.actors.get(1), memory, seq));
      g.step();
      g.drainEvents();
    }
    return { me: g.actors.get(1).stats, them: g.actors.get(2).stats };
  }

  function record(difficulty) {
    let wins = 0, games = 0, theirHits = 0;
    for (const mapId of ['court', 'pond', 'yard']) {
      for (let seed = 1; seed <= 6; seed++) {
        const { me, them } = duel(difficulty, seed, mapId);
        games += 1;
        theirHits += them.hits;
        if (me.freezes > them.freezes || (me.freezes === them.freezes && me.hits >= them.hits)) wins += 1;
      }
    }
    return { rate: wins / games, wins, games, theirHits };
  }

  test('a clumsy first-timer usually beats a Cozy rival and often beats a Normal one', () => {
    const cozy = record(DIFFICULTY.COZY);
    const normal = record(DIFFICULTY.NORMAL);
    assert.ok(cozy.rate >= 0.8, `Cozy: won ${cozy.wins} of ${cozy.games}`);
    assert.ok(normal.rate >= 0.5, `Normal: won ${normal.wins} of ${normal.games}`);
  });

  // Face-Off for the same first-timer: a few walls and a flinger, then a march on the enemy
  // Colonel, turning back when the Colonel bar starts to drop.
  function faceOffFrame(g, kid, memory, seq) {
    const frame = { seq, mx: 0, my: 0, aim: kid.aim, btn: 0, tx: kid.x, ty: kid.y };
    const home = g.colonel(TEAM.A), rival = g.colonel(TEAM.B);
    if (g.phase === PHASE.BUILD) {
      if (g.tick % 45 === 0) {
        const placed = memory.placed ?? 0;
        memory.placed = placed + 1;
        const toward = g.map.forts[1].x > g.map.forts[0].x ? 5 : -4;
        if (placed < 8) g.command(kid.id, { c: CMD.BUILD, k: STRUCT.WALL, cx: home.cx + toward, cy: home.cy + placed - 3 });
        else if (placed === 8) g.command(kid.id, { c: CMD.BUILD, k: STRUCT.PULT, cx: home.cx + Math.sign(toward) * 3, cy: home.cy });
      }
      return frame;
    }
    if (g.phase !== PHASE.FIGHT) { memory.placed = 0; return frame; }
    if (kid.balls === 0) memory.packing = true;
    if (kid.balls >= 7) memory.packing = false;
    if (memory.packing) return frame;

    const sway = Math.sin(g.tick / 37) > 0 ? 1 : -1;
    const enemy = g.nearestEnemy(kid, 360);
    if (enemy) {
      const dx = enemy.x - kid.x, dy = enemy.y - kid.y, d = Math.hypot(dx, dy) || 1;
      frame.aim = Math.atan2(dy, dx) + Math.sin(g.tick / 5.3) * 0.1;
      if (d > 300) { frame.mx = dx / d; frame.my = dy / d; } else { frame.mx = (-dy / d) * sway; frame.my = (dx / d) * sway; }
      if (g.tick % 24 < 3) frame.btn = BTN.THROW;
      return frame;
    }
    const homeAt = { x: (home.cx + 1) * CELL, y: (home.cy + 1) * CELL };
    const raider = g.kids().find((k) => k.team !== kid.team && !(k.flags & AFLAG.FROZEN) && distance(k, homeAt) < 420);
    const goal = raider ?? { x: (rival.cx + 1) * CELL, y: (rival.cy + 1) * CELL };
    const dx = goal.x - kid.x, dy = goal.y - kid.y, d = Math.hypot(dx, dy) || 1;
    frame.aim = Math.atan2(dy, dx);
    frame.tx = goal.x;
    frame.ty = goal.y;
    if (raider) {
      frame.mx = dx / d;
      frame.my = dy / d;
    } else if (d <= 340) {
      if (g.tick % 30 < 6) frame.btn = g.los(kid.x, kid.y, goal.x, goal.y) ? BTN.THROW : BTN.LOB;
      frame.mx = (-dy / d) * sway;
      frame.my = (dx / d) * sway;
    } else {
      const flow = g.flow(kid.team).dirAt(kid.x, kid.y);
      frame.mx = flow.dx;
      frame.my = flow.dy;
    }
    return frame;
  }

  function faceOffRecord(difficulty) {
    let matches = 0, mine = 0, theirs = 0, games = 0;
    for (const mapId of ['court', 'pond', 'yard']) {
      for (const seed of [1, 2]) {
        const players = [human(1, TEAM.A), bot(2, TEAM.B)];
        const g = new Game({ mode: MODE.FORTWARS, mapId, difficulty, waveCount: 10, seed, players });
        const memory = {};
        let seq = 0;
        while (!g.isOver() && g.tick < 1500 * SIM_HZ) {
          seq += 1;
          g.queueInput(1, faceOffFrame(g, g.actors.get(1), memory, seq));
          g.step();
          g.drainEvents();
        }
        games += 1;
        mine += g.roundWins[TEAM.A];
        theirs += g.roundWins[TEAM.B];
        if (g.roundWins[TEAM.A] > g.roundWins[TEAM.B]) matches += 1;
      }
    }
    return { matches, games, mine, theirs };
  }

  test('Face-Off: a first-timer can beat Cozy bots and takes rounds off Normal ones', () => {
    const cozy = faceOffRecord(DIFFICULTY.COZY);
    assert.ok(cozy.matches / cozy.games >= 0.5, `Cozy: won ${cozy.matches} of ${cozy.games} matches`);
    const normal = faceOffRecord(DIFFICULTY.NORMAL);
    assert.ok(normal.mine >= 2, `Normal: took ${normal.mine} rounds to their ${normal.theirs}`);
  });

  test('rivals still put up a fight, and climb with difficulty', () => {
    const [cozy, normal, blizzard] = [DIFFICULTY.COZY, DIFFICULTY.NORMAL, DIFFICULTY.BLIZZARD].map(record);
    assert.ok(cozy.theirHits >= cozy.games * 5, `only ${cozy.theirHits} hits in ${cozy.games} games`);
    assert.ok(blizzard.theirHits > normal.theirHits && normal.theirHits > cozy.theirHits, 'skill climbs with difficulty');
    assert.ok(blizzard.rate < normal.rate, 'and Blizzard is the hard one');
  });

  test('in Free-for-All a human is never the whole room\'s only target', () => {
    const players = [human(1, TEAM.FFA_BASE), ...Array.from({ length: 7 }, (_, i) => bot(i + 2, TEAM.FFA_BASE + 1 + i))];
    const g = new Game({ mode: MODE.FFA, mapId: 'court', difficulty: DIFFICULTY.NORMAL, waveCount: 10, seed: 4, players });
    g.actors.get(1).takeDmgMul = 0;
    let worst = 0;
    for (let i = 0; i < 80 * SIM_HZ && !g.isOver(); i++) {
      g.step();
      g.drainEvents();
      let hunters = 0;
      for (const kid of g.kids()) if (kid.isBot && kid.ai.target === g.actors.get(1)) hunters += 1;
      worst = Math.max(worst, hunters);
    }
    assert.ok(worst <= 3, `${worst} bots piled on`);
  });
});

describe('whole matches', () => {
  test('bots finish a match in every mode on every map, deterministically', () => {
    for (const map of MAPS) {
      for (const mode of Object.values(MODE)) {
        const roster = () => {
          if (mode === MODE.SIEGE) return [bot(1), bot(2), bot(3)];
          if (mode === MODE.FORTWARS) return [bot(1, TEAM.A), bot(2, TEAM.A), bot(3, TEAM.B), bot(4, TEAM.B)];
          return Array.from({ length: 6 }, (_, i) => bot(i + 1, TEAM.FFA_BASE + i));
        };
        const play = () => {
          const g = new Game({ mode, mapId: map.id, difficulty: DIFFICULTY.NORMAL, waveCount: 5, seed: 12, players: roster() });
          for (let i = 0; i < 40 * 60 * SIM_HZ && !g.isOver(); i++) {
            g.step();
            g.drainEvents();
          }
          return g;
        };
        const g = play();
        assert.ok(g.isOver(), `${mode} on ${map.id} never ended`);
        assert.ok(g.result().summary.length > 0);
        assert.deepEqual(play().result(), g.result(), 'same seed, same match');
        for (const a of g.actors.values()) assert.ok(Number.isFinite(a.x) && Number.isFinite(a.y));
      }
    }
  });
});
