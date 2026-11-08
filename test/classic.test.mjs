// Classic mode (SPEC 2.4): fast knockout duels on the Corner Lot.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { AFLAG, BALL, CMD, DIFFICULTY, EV, MODE, PHASE, PICKUP, PROTOCOL_VERSION, STRUCT, TEAM } from '../public/shared/schema.js';
import { CELL, CLASSIC, SIM_HZ } from '../public/shared/constants.js';
import { Game } from '../public/shared/game.js';
import { ARENAS, MAPS, getMap, mapsForMode } from '../public/shared/maps.js';
import { sanitizeSettings, viewerWon } from '../public/shared/protocol.js';
import { canPlace } from '../public/shared/physics.js';

const human = (id, extra = {}) => ({ id, name: `Kid ${id}`, look: null, team: TEAM.A, isBot: false, ...extra });
const bot = (id, extra = {}) => human(id, { isBot: true, ...extra });
const duel = (players = [human(1), human(2, { team: TEAM.B })], opts = {}) => new Game({
  mode: MODE.CLASSIC, mapId: 'lot', difficulty: DIFFICULTY.NORMAL, seed: 7, players, ...opts,
});
const kid = (g, id) => g.actors.get(id);
const stepUntil = (g, done, limit = 40000) => {
  for (let i = 0; i < limit; i++) {
    if (done()) return;
    g.step();
  }
  assert.fail('condition never reached');
};
const toFight = (g) => stepUntil(g, () => g.phase === PHASE.FIGHT);
// The nearest free cell on this kid's own half, close enough to build on.
function freeCell(g, k, kind = STRUCT.WALL, skip = 0) {
  const { cx, cy } = g.cw.cellOf(k.x, k.y);
  const ahead = k.team === TEAM.A ? 1 : -1;
  for (let r = 1; r < 4; r++) {
    for (let dy = -r; dy <= r; dy++) {
      const c = { cx: cx + ahead * r, cy: cy + dy };
      if (canPlace(g.cw, g.placementQuery(k), kind, c.cx, c.cy) === 'ok' && skip-- <= 0) return c;
    }
  }
  return assert.fail('no free cell');
}
const build = (g, id, k, c) => g.command(id, { c: CMD.BUILD, k, cx: c.cx, cy: c.cy });
const hit = (g, target, by, kind = BALL.QUICK) => g.damageActor(target, 10, by, { kind });

test('classic: the Corner Lot belongs to Classic alone, and settings keep mode and map together', () => {
  assert.equal(PROTOCOL_VERSION, 2);
  assert.ok(!MAPS.some((m) => m.id === 'lot'), 'the lot is not offered to other modes');
  assert.deepEqual(mapsForMode(MODE.CLASSIC).map((m) => m.id), ARENAS.map((m) => m.id));
  assert.equal(getMap('lot').id, 'lot');
  assert.equal(sanitizeSettings({ mode: MODE.CLASSIC }).mapId, 'lot');
  assert.equal(sanitizeSettings({ mode: MODE.CLASSIC, mapId: 'court' }).mapId, 'lot');
  const back = sanitizeSettings({ mode: MODE.SIEGE }, sanitizeSettings({ mode: MODE.CLASSIC }));
  assert.equal(back.mapId, MAPS[0].id, 'leaving Classic leaves the lot too');
  assert.equal(sanitizeSettings({ mapId: 'lot' }).mapId, MAPS[0].id, 'no other mode can pick the lot');
});

test('classic: a round opens with an 8 s BUILD behind the truce rope, no Colonel and no Flakes', () => {
  const g = duel();
  assert.equal(g.map.id, 'lot');
  assert.equal(g.phase, PHASE.BUILD);
  assert.equal(g.round, 1);
  assert.equal(g.endsAtTick, CLASSIC.buildTime * SIM_HZ);
  assert.equal(g.cw.truce?.active, true);
  assert.equal(g.colonels.size, 0);
  const m = g.meta();
  assert.equal(m.speedMul, 1);
  assert.deepEqual(m.colonels, []);
  for (const id of [1, 2]) assert.equal(kid(g, id).hearts, CLASSIC.hits);
});

test('classic: three free things per kid, from three tools, on your own half, only in BUILD', () => {
  const g = duel();
  const a = kid(g, 1);
  const flakes = g.flakes[TEAM.A];
  build(g, 1, STRUCT.WALL, freeCell(g, a));
  build(g, 1, STRUCT.PULT, freeCell(g, a, STRUCT.PULT));
  assert.equal(canPlace(g.cw, g.placementQuery(a), STRUCT.PULT, freeCell(g, a).cx, freeCell(g, a).cy), 'limit', 'one flinger each');
  const decoyAt = freeCell(g, a, STRUCT.DECOY);
  const spare = freeCell(g, a, STRUCT.WALL, 1);
  build(g, 1, STRUCT.DECOY, decoyAt);
  const mine = [...g.structs.values()].filter((s) => s.ownerId === 1);
  assert.equal(mine.length, 3);
  assert.equal(g.flakes[TEAM.A], flakes, 'free');
  assert.equal(canPlace(g.cw, g.placementQuery(a), STRUCT.WALL, spare.cx, spare.cy), 'limit', 'a fourth is refused');
  for (const k of [STRUCT.ICEWALL, STRUCT.SLICK, STRUCT.COCOA]) {
    assert.equal(canPlace(g.cw, g.placementQuery(a), k, spare.cx, spare.cy), 'badCell', `no ${k}`);
  }
  const theirs = g.cw.cellOf(g.map.w - 300, 390);
  assert.equal(canPlace(g.cw, { ...g.placementQuery(a), x: g.map.w - 300, y: 390 }, STRUCT.WALL, theirs.cx, theirs.cy), 'badCell', 'own half only');

  // Demolishing your own gives the placement back; a teammate's is not yours to take.
  g.command(1, { c: CMD.DEMOLISH, cx: decoyAt.cx, cy: decoyAt.cy });
  assert.equal([...g.structs.values()].filter((s) => s.ownerId === 1).length, 2);
  assert.equal(canPlace(g.cw, g.placementQuery(a), STRUCT.WALL, spare.cx, spare.cy) === 'limit', false);

  toFight(g);
  const b = kid(g, 2);
  const late = g.cw.cellOf(b.x - 2 * CELL, b.y);
  const before = g.structs.size;
  build(g, 2, STRUCT.WALL, late);
  assert.equal(g.structs.size, before, 'no building in FIGHT');
});

test('classic: bots on a team with a human still place their own three', () => {
  const g = duel([human(1), bot(3), human(2, { team: TEAM.B }), bot(4, { team: TEAM.B })]);
  toFight(g);
  for (const id of [3, 4]) {
    const owned = [...g.structs.values()].filter((s) => s.ownerId === id);
    assert.equal(owned.length, CLASSIC.itemsPerKid, `bot ${id} placed ${owned.length}`);
  }
});

test('classic: hearts, not warmth: one per hit, two for an Iceball, out at zero with no thaw or regen', () => {
  const g = duel([human(1), human(3), human(2, { team: TEAM.B }), human(4, { team: TEAM.B })]);
  toFight(g);
  const a = kid(g, 1);
  const b = kid(g, 2);
  hit(g, b, a);
  assert.equal(b.hearts, 2);
  assert.ok(Math.abs(b.hp - (b.maxHp * 2) / 3) < 1e-9, 'warmth mirrors hearts');
  for (let i = 0; i < 300; i++) g.step();
  assert.equal(b.hearts, 2, 'no regen');
  hit(g, b, a, BALL.ICE);
  assert.equal(b.hearts, 0);
  assert.ok(b.flags & AFLAG.FROZEN, 'knocked out');
  for (let i = 0; i < 30 * SIM_HZ; i++) g.step();
  assert.ok(b.flags & AFLAG.FROZEN, 'still out: no thaw, no respawn');
  assert.equal(g.phase, PHASE.FIGHT, 'the round goes on while a teammate stands');
});

test('classic: wiping a team wins the round, and the next round is cleared, refilled and faster', () => {
  const g = duel();
  toFight(g);
  const b = kid(g, 2);
  for (let i = 0; i < CLASSIC.hits; i++) hit(g, b, kid(g, 1));
  g.step();
  assert.equal(g.phase, PHASE.ROUND_END);
  assert.equal(g.roundWins[TEAM.A], 1);
  stepUntil(g, () => g.phase === PHASE.BUILD);
  assert.equal(g.round, 2);
  assert.equal(g.structs.size, 0);
  assert.equal(kid(g, 2).hearts, CLASSIC.hits);
  assert.equal(kid(g, 2).flags & AFLAG.FROZEN, 0);
  assert.ok(Math.abs(g.speedMul - CLASSIC.speedUpPerRound) < 1e-9);
  assert.ok(Math.abs(kid(g, 1).mods.speedMul - CLASSIC.speedUpPerRound) < 1e-9);
  assert.equal(g.meta().speedMul, g.speedMul, 'the client learns it from Meta');
});

test('classic: the speed-up is capped', () => {
  const g = duel();
  g.round = 20;
  g.openClassicRound();
  assert.equal(g.speedMul, CLASSIC.maxSpeedUp);
});

test('classic: at the timeout more hearts wins, then more hits, then a coin toss', () => {
  const g = duel([human(1), human(3), human(2, { team: TEAM.B }), human(4, { team: TEAM.B })]);
  toFight(g);
  hit(g, kid(g, 2), kid(g, 1));
  g.tick = g.endsAtTick;
  g.step();
  assert.equal(g.roundWins[TEAM.A], 1, 'A had more hearts left');

  const h = duel([human(1), human(2, { team: TEAM.B })]);
  toFight(h);
  hit(h, kid(h, 2), kid(h, 1));
  hit(h, kid(h, 1), kid(h, 2));
  hit(h, kid(h, 2), kid(h, 1));
  hit(h, kid(h, 1), kid(h, 2));
  h.roundHits[TEAM.B] += 1;
  h.tick = h.endsAtTick;
  h.step();
  assert.equal(h.roundWins[TEAM.B], 1, 'equal hearts: more hits wins');
});

test('classic: both teams wiped at once goes to the tie-break, and a round never replays', () => {
  const g = duel();
  toFight(g);
  const a = kid(g, 1);
  const b = kid(g, 2);
  for (let i = 0; i < CLASSIC.hits; i++) {
    hit(g, b, a);
    hit(g, a, b);
  }
  g.step();
  assert.equal(g.phase, PHASE.ROUND_END);
  assert.equal(g.roundWins[TEAM.A] + g.roundWins[TEAM.B], 1);
});

test('classic: first to 3 rounds takes the match', () => {
  const g = duel();
  for (let round = 1; round <= CLASSIC.roundsToWin; round++) {
    toFight(g);
    for (let i = 0; i < CLASSIC.hits; i++) hit(g, kid(g, 2), kid(g, 1));
    g.step();
    if (round < CLASSIC.roundsToWin) stepUntil(g, () => g.phase === PHASE.BUILD);
  }
  assert.equal(g.phase, PHASE.OVER);
  const r = g.finalResult;
  assert.equal(r.mode, MODE.CLASSIC);
  assert.equal(r.winnerTeam, TEAM.A);
  assert.deepEqual(r.winners, [1]);
  assert.ok(viewerWon(r, 1));
  assert.ok(!viewerWon(r, 2));
  assert.match(r.summary, /takes the lot, 3 to 0/);
});

test('classic: a friend who joins mid-round sits it out, then plays the next', () => {
  const g = duel([human(1), human(3), human(2, { team: TEAM.B })]);
  toFight(g);
  g.addPlayer(human(4, { team: TEAM.B }));
  assert.ok(kid(g, 4).flags & AFLAG.FROZEN);
  assert.equal(g.phase, PHASE.FIGHT, 'a newcomer starting out does not end the round');
  for (let i = 0; i < CLASSIC.hits; i++) hit(g, kid(g, 2), kid(g, 1));
  g.step();
  stepUntil(g, () => g.phase === PHASE.BUILD);
  assert.equal(kid(g, 4).flags & AFLAG.FROZEN, 0);
  assert.equal(kid(g, 4).hearts, CLASSIC.hits);
});

test('classic: an Iceball turns up at the lot centre during FIGHT, one at a time', () => {
  const g = duel();
  toFight(g);
  const adds = [];
  for (let i = 0; i < (CLASSIC.pickupEvery * 2 + 1) * SIM_HZ; i++) {
    g.step();
    for (const e of g.drainEvents()) if (e.e === EV.P_ADD) adds.push(e);
  }
  assert.equal(adds.length, 1, 'never more than one on the field');
  assert.equal(adds[0].k, PICKUP.ICE);
  assert.deepEqual([adds[0].x, adds[0].y], [g.map.pickupSpot.x, g.map.pickupSpot.y]);
});

test('classic: bots-only matches finish at every difficulty with no NaN', () => {
  for (const difficulty of Object.values(DIFFICULTY)) {
    const g = duel([bot(1), bot(3), bot(2, { team: TEAM.B }), bot(4, { team: TEAM.B })], { difficulty, seed: 11 });
    stepUntil(g, () => {
      for (const k of g.kids()) assert.ok(Number.isFinite(k.x) && Number.isFinite(k.y) && Number.isFinite(k.hp));
      return g.phase === PHASE.OVER;
    }, 30 * 60 * 15);
    const wins = g.roundWins[g.finalResult.winnerTeam];
    assert.equal(wins, CLASSIC.roundsToWin, difficulty);
    assert.ok(g.round >= CLASSIC.roundsToWin && g.round <= CLASSIC.roundsToWin * 2 - 1);
  }
});

test('classic: other modes are untouched by the new rules', () => {
  const g = new Game({ mode: MODE.FORTWARS, map: getMap('court'), seed: 7, players: [human(1), human(2, { team: TEAM.B })] });
  assert.equal(g.classic, false);
  assert.equal(g.colonels.size, 2);
  assert.equal(g.meta().speedMul, 1);
  assert.equal(CELL > 0, true);
});
