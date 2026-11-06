// The whole game, end to end, in real Chrome: no placeholders, every import resolves, npm test,
// solo through to results, server multiplayer, P2P through the real PeerJS broker, every mode on
// every map, and both bosses. Prints PASS or FAIL per check and saves screenshots to artifacts/.
//   npm run test:e2e                 everything
//   node test/e2e/run.mjs solo p2p   just those stages
// Stages: static unit solo server p2p matrix bosses endings world layout
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { dirname, join, relative, resolve } from 'node:path';
import { startStatic } from '../p2p-static.mjs';
import { startServer } from '../../server/index.js';
import { ACTOR, AFLAG, AUX, BALL, MODE, PICKUP, STRUCT, TEAM } from '../../public/shared/schema.js';
import { CELL } from '../../public/shared/constants.js';
import { MAPS as MAP_LIST } from '../../public/shared/maps.js';
import { boss, gameOf, holdBuild, jumpToWave, placePickup, setBossHp, setColonelHp } from './hooks.mjs';
import {
  ARTIFACTS, Problems, ROOT, SERVER_PORT, STATIC_PORT, actorOf, clickWorld, closePage, expect, goSolo, inkAt, installRecorder,
  launch, openPage, peek, playLoop, pointAt, press, recorded, screenOf, setupLobby, shot, startMatch, until, wait, walkTo,
} from './lib.mjs';

const MODES = Object.values(MODE);
const MAPS = MAP_LIST.map((m) => m.id);
const FOE_KINDS = [ACTOR.PIPSQUEAK, ACTOR.SLINGER, ACTOR.LOBBER, ACTOR.BRUISER, ACTOR.SLEDDER, ACTOR.LIDKID, ACTOR.SNEAK];
const seconds = (ms) => (ms / 1000).toFixed(1);
const CHECK_LIMIT_MS = 8 * 60000;

// ---- reporting -------------------------------------------------------------------------------

class Stage {
  constructor(runner, name) {
    this.runner = runner;
    this.name = name;
    this.problems = new Problems();
  }

  // A failed check ends its stage, since the ones after it build on what it proved. Any console
  // or page error raised while a check runs fails that check.
  async check(name, fn) {
    const t0 = Date.now();
    let note;
    let deadline;
    this.problems.inCheck = true;
    try {
      // A loop that never meets its stop condition must fail the run, not hang it.
      const stuck = new Promise((_, fail) => {
        deadline = setTimeout(() => fail(new Error(`still not done after ${CHECK_LIMIT_MS / 60000} minutes`)), CHECK_LIMIT_MS);
      });
      note = await Promise.race([fn(), stuck]);
      const errors = this.problems.take();
      expect(errors.length === 0, `console or page errors:\n      ${errors.slice(0, 8).join('\n      ')}`);
    } catch (err) {
      this.runner.report(this.name, name, false, Date.now() - t0, err.message);
      await this.autopsy();
      throw err;
    } finally {
      clearTimeout(deadline);
      this.problems.inCheck = false;
      await this.problems.closeDeferred();
    }
    this.runner.report(this.name, name, true, Date.now() - t0, typeof note === 'string' ? note : '');
    return note;
  }

  // What every open page looked like at the moment a check failed.
  async autopsy() {
    for (const page of this.problems.pages) {
      try {
        await shot(page, `FAILED-${this.name}-${page.label.replace(/\W+/g, '-')}`);
        const s = await peek(page);
        console.log(`        ${page.label}: ${JSON.stringify({ screen: s.screen, phase: s.phase, me: s.me, x: s.x, y: s.y, structs: s.structKinds, flakes: s.flakes })}`);
      } catch { /* the page may be the thing that died */ }
    }
  }
}

class Runner {
  constructor() {
    this.results = [];
    this.stagesFailed = [];
  }

  report(stage, name, ok, ms, detail) {
    this.results.push({ stage, name, ok, ms, detail });
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name} (${seconds(ms)} s)${detail ? `\n        ${detail}` : ''}`);
  }

  async stage(name, fn) {
    console.log(`\n== ${name}`);
    const stage = new Stage(this, name);
    const t0 = Date.now();
    try {
      await fn(stage);
    } catch (err) {
      this.stagesFailed.push(name);
      if (!this.results.some((r) => r.stage === name && !r.ok)) this.report(name, 'stage ran to its end', false, Date.now() - t0, err.stack);
    }
    if (stage.problems.allowed.size) {
      console.log('  note  expected and allowed:');
      for (const [line, n] of stage.problems.allowed) console.log(`        ${n} x ${line.slice(0, 160)}`);
    }
    if (stage.problems.warnings.size) {
      console.log('  note  console warnings:');
      for (const [line, n] of stage.problems.warnings) console.log(`        ${n} x ${line.slice(0, 200)}`);
    }
    console.log(`  ---   ${seconds(Date.now() - t0)} s`);
  }

  finish() {
    const failed = this.results.filter((r) => !r.ok);
    console.log(`\n${this.results.length} checks, ${this.results.length - failed.length} passed, ${failed.length} failed`);
    for (const r of failed) console.log(`  FAILED ${r.stage}: ${r.name}`);
    mkdirSync(ARTIFACTS, { recursive: true });
    writeFileSync(join(ARTIFACTS, 'report.json'), JSON.stringify(this.results, null, 2));
    return failed.length === 0 && this.stagesFailed.length === 0 && this.results.length > 0;
  }
}

// ---- static checks ---------------------------------------------------------------------------

function* walk(dir, skip) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (skip.has(e.name)) continue;
    const path = join(dir, e.name);
    if (e.isDirectory()) yield* walk(path, skip);
    else yield path;
  }
}

function exportsOf(file, seen = new Map()) {
  if (seen.has(file)) return seen.get(file);
  const names = new Set();
  seen.set(file, names);
  const src = readFileSync(file, 'utf8');
  for (const m of src.matchAll(/^\s*export\s+(?:async\s+)?(?:const|let|var|function\*?|class)\s+([A-Za-z_$][\w$]*)/gm)) names.add(m[1]);
  for (const m of src.matchAll(/^\s*export\s*\{([^}]*)\}/gm)) {
    for (const part of m[1].split(',')) {
      const bits = part.trim().split(/\s+as\s+/);
      if (bits[0]) names.add((bits[1] ?? bits[0]).trim());
    }
  }
  return names;
}

function checkImports() {
  const skip = new Set(['node_modules', 'vendor', 'artifacts', '.git']);
  const files = [...walk(ROOT, skip)].filter((f) => /\.m?js$/.test(f));
  const bad = [];
  let count = 0;
  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    // Matches every specifier and skips the bare ones afterwards, so that a lazy match can never
    // run past one statement into the next.
    for (const m of src.matchAll(/(?:^|\n)\s*(?:import|export)\s+(?:([^'";]*?)\s+from\s+)?['"]([^'"]+)['"]/g)) {
      if (!m[2].startsWith('.')) continue;
      count += 1;
      const dep = resolve(dirname(file), m[2]);
      const where = relative(ROOT, file);
      if (!existsSync(dep)) { bad.push(`${where}: ${m[2]} does not exist`); continue; }
      const braces = m[1]?.match(/\{([\s\S]*)\}/);
      if (!braces) continue;
      const names = exportsOf(dep);
      for (const part of braces[1].split(',')) {
        const name = part.trim().split(/\s+as\s+/)[0];
        if (name && !names.has(name)) bad.push(`${where}: ${relative(ROOT, dep)} has no export ${name}`);
      }
    }
    for (const m of src.matchAll(/import\(\s*['"](\.[^'"]+)['"]\s*\)/g)) {
      count += 1;
      if (!existsSync(resolve(dirname(file), m[1]))) bad.push(`${relative(ROOT, file)}: dynamic ${m[1]} does not exist`);
    }
  }
  return { bad, count, files: files.length };
}

async function staticStage(st) {
  await st.check('no placeholder text anywhere in the project', () => {
    const word = ['PLACE', 'HOLDER'].join('');
    const skip = new Set(['node_modules', 'vendor', 'artifacts', '.git']);
    const hits = [];
    let scanned = 0;
    for (const file of walk(ROOT, skip)) {
      scanned += 1;
      if (readFileSync(file, 'latin1').includes(word)) hits.push(relative(ROOT, file));
    }
    expect(hits.length === 0, `found in ${hits.join(', ')}`);
    return `${scanned} files scanned`;
  });
  await st.check('every import resolves to a real file and a real export', () => {
    const { bad, count, files } = checkImports();
    expect(bad.length === 0, bad.join('\n      '));
    return `${count} imports across ${files} files`;
  });
}

function runCommand(cmd, args, opts = {}) {
  return new Promise((done) => {
    const child = spawn(cmd, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], ...opts });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (code) => done({ code, out }));
  });
}

async function unitStage(st) {
  await st.check('npm test passes completely', async () => {
    const { code, out } = await runCommand('npm', ['test']);
    const count = (label) => Number(out.match(new RegExp(`ℹ ${label} (\\d+)`))?.[1] ?? -1);
    expect(code === 0 && count('fail') === 0 && count('cancelled') === 0 && count('pass') > 0, `exit ${code}\n${out.slice(-1500)}`);
    return `${count('pass')} tests pass`;
  });
}

// ---- small game helpers ----------------------------------------------------------------------

const roomCodeOnScreen = (page) => page.evaluate(() => document.querySelector('#room-code')?.dataset.code ?? '');
const hudVisible = (page, sel) => page.evaluate((s) => {
  const node = document.querySelector(s);
  if (!node || node.hidden) return false;
  const r = node.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}, sel);

// A row of cells this kid could build on right now, according to the same rule the host uses.
const freeCells = (page, count, kind = STRUCT.WALL) => page.evaluate(([n, k]) => {
  const { input, session } = window.__ff;
  const v = session.view;
  const c = v.cw.cellOf(v.me.x, v.me.y);
  for (const dy of [2, -2, 3, -3, 4, -4, 1, -1]) {
    for (let dx = -3; dx <= 3; dx += 1) {
      const run = [];
      for (let i = 0; i < n; i += 1) {
        const cx = c.cx + dx + i;
        const cy = c.cy + dy;
        if (input.judge(v, k, { cx, cy, struct: null }) === 'ok') run.push({ cx, cy, x: (cx + 0.5) * 40, y: (cy + 0.5) * 40 });
        else break;
      }
      if (run.length === n) return run;
    }
  }
  return null;
}, [count, kind]);

const structAtCell = (page, cx, cy) => page.evaluate(([x, y]) => {
  const s = window.__ff.session.view.structs.find((it) => it.cx === x && it.cy === y);
  return s ? { id: s.id, kind: s.kind, ownerId: s.ownerId, solid: window.__ff.session.view.cw.isSolidCell(x, y) } : null;
}, [cx, cy]);

// Tool key, one real click on the ground, tool key again to put it away.
async function buildAt(page, digit, cell) {
  await page.keyboard.press(digit);
  await clickWorld(page, cell.x, cell.y);
  await page.keyboard.press(digit);
}

const hasFoes = (s) => Object.keys(s.kinds).some((k) => Number(k) !== ACTOR.KID);

// Hovers a cell, so a key that acts under the cursor acts on it.
const pressNear = (page, cell) => pointAt(page, cell.x, cell.y);

async function pressReady(page) {
  await press(page, '#hud-ready');
}

async function leaveMatch(page) {
  await page.click('#hud-menu');
  await until('the Menu', 4000, () => page.isVisible('#btn-menu-leave'));
  await page.click('#btn-menu-leave');
  await until('the leave prompt', 4000, () => page.isVisible('#btn-leave'));
  await page.click('#btn-leave');
  await until('the title screen', 6000, () => page.isVisible('#btn-solo'));
}

async function hostRoom(page) {
  await until('Host to enable', 8000, () => page.evaluate(() => !document.querySelector('#btn-host').disabled));
  await page.click('#btn-host');
  await until('the host lobby', 20000, () => page.isVisible('#btn-start'));
  const code = await until('the room code', 6000, () => roomCodeOnScreen(page));
  expect(/^[A-Z]{4}$/.test(code), `room code ${code}`);
  return code;
}

async function joinByCode(page, code) {
  await until('Join to enable', 8000, () => page.evaluate(() => !document.querySelector('#btn-join').disabled));
  await page.click('#btn-join');
  await until('the code field', 4000, () => page.isVisible('#join-code'));
  await page.fill('#join-code', code.toLowerCase());
  await page.click('#btn-join-go');
  await until('the lobby as a guest', 25000, async () => (await peek(page)).screen === 'lobby');
}

async function joinByInvite(page, code) {
  await until('the invite card', 6000, () => page.isVisible('#btn-invite-join'));
  await page.click('#btn-invite-join');
  await until('the lobby through the invite', 25000, async () => (await peek(page)).screen === 'lobby');
  expect((await peek(page)).code === code, 'joined the wrong room');
}

const sameRoster = async (pages, n) => {
  for (const p of pages) if ((await peek(p)).players !== n) return false;
  return true;
};

async function bothInMatch(pages) {
  await until('every client in the match', 20000, async () => {
    for (const p of pages) {
      const s = await peek(p);
      if (!(s.inMatch && s.hasMe && s.screen === 'match')) return false;
    }
    return true;
  });
}

// ---- solo ------------------------------------------------------------------------------------

// Remembers the node feeding the speakers, so a check can measure what really comes out. One-shot
// sources are skipped: the engine plays a silent sample straight to the output to unlock iOS.
const AUDIO_TAP = `(() => {
  const connect = AudioNode.prototype.connect;
  AudioNode.prototype.connect = function tapped(dest, ...rest) {
    if (dest instanceof AudioDestinationNode && !(this instanceof AudioScheduledSourceNode)) window.__audioOut = this;
    return connect.call(this, dest, ...rest);
  };
})();`;

const outputPeak = (page, ms) => page.evaluate(async (span) => {
  const out = window.__audioOut;
  if (!out) return -1;
  const probe = out.context.createAnalyser();
  probe.fftSize = 2048;
  out.connect(probe);
  const data = new Float32Array(probe.fftSize);
  let peak = 0;
  const end = performance.now() + span;
  while (performance.now() < end) {
    probe.getFloatTimeDomainData(data);
    for (const v of data) peak = Math.max(peak, Math.abs(v));
    await new Promise((done) => { setTimeout(done, 40); });
  }
  out.disconnect(probe);
  return peak;
}, ms);

async function soloStage(st, browser) {
  const site = await startStatic(STATIC_PORT);
  let page;
  try {
    await st.check('title screen renders with every button, in P2P mode on a static site', async () => {
      page = await openPage(browser, site.url, 'solo', st.problems, { init: AUDIO_TAP });
      await installRecorder(page);
      await until('Play Solo', 8000, () => page.isVisible('#btn-solo'));
      for (const id of ['#btn-host', '#btn-join', '#btn-howto', '#btn-settings', '#name-input']) expect(await page.isVisible(id), `${id} missing`);
      await until('the network check', 5000, () => page.evaluate(() => window.__ff.app.netMode === 'p2p'));
      await wait(600);
      await shot(page, 'solo-01-title');
      expect((await page.evaluate(() => window.__ff.audio.ctx)) === null, 'audio must wait for a gesture');
    });

    await st.check('Play Solo reaches the lobby, which sets up a Siege with bots', async () => {
      await goSolo(page);
      await setupLobby(page, { mode: 'siege', map: 'court', difficulty: 'cozy', length: 5, bots: 3 });
      const crew = await page.evaluate(() => document.querySelectorAll('.crew-body .kid-card[data-player]').length);
      expect(crew === 4, `crew shows ${crew} kids`);
      expect(!(await page.isVisible('#room-code')), 'solo should not show a room code');
      await shot(page, 'solo-02-lobby');
    });

    await st.check('Start opens the match on BUILD with the HUD up', async () => {
      await startMatch(page);
      const s = await peek(page);
      expect(s.phase === 'build' && s.wave === 1 && s.mode === 'siege', `phase ${s.phase} wave ${s.wave}`);
      expect(s.kinds[ACTOR.KID] === 4, `kids ${s.kinds[ACTOR.KID]}`);
      for (const sel of ['#hud-timer', '.tray', '#hud-ready', '.colonel-bar', '.flakes']) expect(await hudVisible(page, sel), `${sel} missing`);
      await wait(1200);
      await shot(page, 'solo-03-build');
      const audio = await page.evaluate(() => ({ state: window.__ff.audio.ctx?.state, track: window.__ff.audio.stats?.track }));
      expect(audio.state === 'running', `real clicks should have unlocked audio, state is ${audio.state}`);
      expect(audio.track === 'build', `music should be the build tune, got ${audio.track}`);
    });

    let walls;
    await st.check('real clicks and a real drag place walls in the build phase', async () => {
      const before = await peek(page);
      walls = await freeCells(page, 5);
      expect(walls, 'no room for walls');
      await page.keyboard.press('Digit1');
      await until('the tool', 2000, () => page.evaluate(() => window.__ff.input.tool === 0));
      const first = await screenOf(page, walls[0].x, walls[0].y);
      await page.mouse.move(first.x, first.y);
      await wait(80);
      await page.mouse.down();
      for (const cell of walls.slice(1)) {
        const p = await screenOf(page, cell.x, cell.y);
        await page.mouse.move(p.x, p.y, { steps: 3 });
        await wait(170);
      }
      await page.mouse.up();
      await page.keyboard.press('Digit1');
      await until('five walls', 5000, async () => ((await peek(page)).structKinds[STRUCT.WALL] ?? 0) >= 5);
      // Meta rides on its own 8-tick beat, so the Flakes can land a moment after the walls do.
      await until('five walls to be paid for', 2000, async () => (await peek(page)).flakes[0] === before.flakes[0] - 10);
      const s = await peek(page);
      await shot(page, 'solo-04-walls');
      return `${s.structKinds[STRUCT.WALL]} walls, ${s.flakes[0]} Flakes left`;
    });

    await st.check('a wall can be built on the cell drawn behind Colonel Carrot', async () => {
      const cell = await page.evaluate(() => {
        const col = window.__ff.session.view.structs.find((s) => s.kind === 6);
        return { cx: col.cx, cy: col.cy - 1, x: (col.cx + 0.5) * 40, y: (col.cy - 0.5) * 40 };
      });
      const inRange = await walkTo(page, cell.x - 60, cell.y - 40, { near: 40, ms: 8000 });
      expect(inRange, 'could not walk near the Colonel');
      await buildAt(page, 'Digit1', cell);
      await until('the wall behind him', 3000, () => structAtCell(page, cell.cx, cell.cy));
    });

    await st.check('Ready ends BUILD and foes arrive', async () => {
      await page.keyboard.press('KeyR');
      await until('FIGHT', 6000, async () => (await peek(page)).phase === 'fight');
      await until('foes on the field', 15000, async () => hasFoes(await peek(page)));
    });

    await st.check('sound really reaches the output during the match', async () => {
      const peak = await outputPeak(page, 1500);
      expect(peak > 0.02 && peak < 1, `peak ${peak} at the output`);
      return `peak ${peak.toFixed(3)} on the fight music, track ${await page.evaluate(() => window.__ff.audio.stats.track)}`;
    });

    await st.check('throwing with the real mouse sends balls at foes, and the wave is survived', async () => {
      const { me } = await peek(page);
      let shotTaken = false;
      const end = await playLoop(page, {
        stop: (s) => s.wave >= 2 && s.phase === 'build',
        onTick: async (s) => {
          if (!shotTaken && Object.keys(s.kinds).length > 1 && s.balls > 0) {
            shotTaken = true;
            await shot(page, 'solo-05-fight');
          }
        },
      });
      const rec = await recorded(page);
      const mine = rec.events.filter((e) => e.e === 'ball' && e.by === me).length;
      expect(mine > 0 && rec.counts.ballEnd > 0, 'the player threw nothing');
      return `wave 1 cleared with ${mine} balls from the player, ${end.flakes[0]} Flakes`;
    });

    await st.check('cards appear after the wave and a click takes one', async () => {
      await until('the offer', 5000, async () => (await peek(page)).offer?.length === 3);
      await until('the card panel', 3000, () => hudVisible(page, '.cards-panel'));
      expect((await page.locator('.cards-list .card').count()) === 3, 'three cards');
      await wait(300);
      await shot(page, 'solo-06-cards');
      const offered = (await peek(page)).offer;
      await page.click('.cards-list .card >> nth=1');
      await until('the card', 3000, async () => (await peek(page)).cards.includes(offered[1]));
      await until('the panel to go', 3000, async () => !(await hudVisible(page, '.cards-panel')));
      return `took ${offered[1]} from ${offered.join(', ')}`;
    });

    await st.check('every other structure can be built with its tool key', async () => {
      const wanted = [['Digit2', STRUCT.ICEWALL], ['Digit3', STRUCT.DECOY], ['Digit4', STRUCT.PULT], ['Digit5', STRUCT.SLICK], ['Digit6', STRUCT.COCOA]];
      for (const [digit, kind] of wanted) {
        const cells = await freeCells(page, 1, kind);
        expect(cells, `no room for kind ${kind}`);
        await buildAt(page, digit, cells[0]);
        await until(`struct kind ${kind}`, 3000, async () => ((await peek(page)).structKinds[kind] ?? 0) >= 1);
      }
      await wait(500);
      await shot(page, 'solo-07-structures');
    });

    await st.check('the Menu pauses solo and resumes', async () => {
      await page.click('#hud-menu');
      await until('the Menu', 3000, () => page.isVisible('#btn-resume'));
      await wait(500);
      const a = (await peek(page)).renderTick;
      await wait(1200);
      const b = (await peek(page)).renderTick;
      expect(b - a < 3, `the match ran on while paused: ${a} to ${b}`);
      await shot(page, 'solo-08-menu');
      await page.click('#btn-resume');
      await until('the match to resume', 3000, async () => (await peek(page)).renderTick > b + 5);
    });

    await st.check('the match plays out to the results screen', async () => {
      const seen = new Set();
      const end = await playLoop(page, {
        stop: (s) => s.screen === 'results',
        onTick: async (s) => {
          if (s.phase === 'build' && s.screen === 'match') {
            if (s.offer) {
              // The offer can auto-pick between looking and clicking, which is fine.
              await page.click('.cards-list .card >> nth=0', { timeout: 1500 }).catch(() => {});
            }
            await page.keyboard.press('KeyR');
            await wait(250);
          }
          if (s.boss && !seen.has('boss')) {
            seen.add('boss');
            await until('the boss bar', 3000, () => hudVisible(page, '.boss'));
          }
        },
      });
      await wait(1000);
      await shot(page, 'solo-09-results');
      expect(end.result, 'no result');
      expect(await page.isVisible('#results-title'), 'results title hidden');
      expect(await page.isVisible('#btn-play-again'), 'Play Again hidden');
      const title = await page.textContent('#results-title');
      const mine = end.result.players.find((p) => p.id === end.me);
      expect(mine.stats.hits > 0, 'the player never hit a foe');
      return `"${title}" after ${end.wave} waves, player landed ${mine.stats.hits} hits: ${end.result.summary}`;
    });

    await st.check('Play Again starts a fresh match, and Leave returns to the title', async () => {
      await page.click('#btn-play-again');
      await until('a new match', 10000, async () => {
        const s = await peek(page);
        return s.screen === 'match' && s.wave === 1 && s.phase === 'build' && s.hasMe;
      });
      await leaveMatch(page);
    });

    await st.check('the whole run kept up with the browser, at about 30 fps or better', async () => {
      const rec = await recorded(page);
      // Headless Chrome paces rAF at 60 or at 30 depending on the machine's state, even on a blank
      // page, so a healthy run reads as one of those. The floor only has to catch the game lagging.
      expect(rec.fps >= 28, `only ${rec.fps.toFixed(1)} fps`);
      return `${rec.fps.toFixed(1)} fps over ${rec.frames} frames, worst gap ${rec.worstGap.toFixed(0)} ms`;
    });
  } finally {
    if (page) await closePage(page);
    await site.close();
  }
}

// ---- multiplayer -----------------------------------------------------------------------------

// `base` decides the transport; everything else is the same three people playing.
async function multiplayer(st, browser, base, tag, { p2p, allow }) {
  const pages = [];
  const open = async (url, label) => {
    const page = await openPage(browser, url, label, st.problems, { allow });
    await installRecorder(page);
    pages.push(page);
    return page;
  };
  try {
    let A; let B; let C; let code;

    await st.check(`${tag}: host a room, one friend joins by code, one by invite link`, async () => {
      A = await open(base, 'A');
      await until('the network check', 5000, () => A.evaluate(() => window.__ff.app.netMode !== null));
      expect((await A.evaluate(() => window.__ff.app.netMode)) === (p2p ? 'p2p' : 'server'), 'wrong network mode');
      code = await hostRoom(A);
      B = await open(base, 'B');
      await joinByCode(B, code);
      C = await open(`${base}?join=${code}`, 'C');
      await joinByInvite(C, code);
      await until('all three in each lobby', 8000, () => sameRoster([A, B, C], 3));
      await shot(A, `${tag}-01-lobby-host`);
      await shot(B, `${tag}-02-lobby-guest`);
      return `room ${code}`;
    });

    await st.check(`${tag}: a code nobody is using gets the friendly dialog`, async () => {
      const lost = await open(base, 'lost');
      await until('Join to enable', 8000, () => lost.evaluate(() => !document.querySelector('#btn-join').disabled));
      await lost.click('#btn-join');
      await lost.fill('#join-code', 'ZZZZ');
      await lost.click('#btn-join-go');
      await until('the noRoom dialog', 12000, async () => (await lost.evaluate(() => document.querySelector('#error-text')?.textContent ?? '')).includes("Can't find room ZZZZ"));
      await shot(lost, `${tag}-02b-no-room`);
      await closePage(lost);
    });

    await st.check(`${tag}: lobby chat and settings reach everyone`, async () => {
      await B.fill('.screen-lobby .chat-input', 'see you on the ice');
      await B.press('.screen-lobby .chat-input', 'Enter');
      for (const p of [A, C]) {
        await until('the chat line', 5000, () => p.evaluate(() => document.querySelector('.screen-lobby .chat-list').textContent.includes('see you on the ice')));
      }
      await setupLobby(A, { mode: 'siege', map: 'court', difficulty: 'normal', length: 5 });
      await until('the guest to see the settings', 3000, () => B.evaluate(() => window.__ff.session.lobby.settings.waveCount === 5));
      expect(!(await B.isVisible('#btn-start')), 'a guest must not see Start');
    });

    let ids;
    await st.check(`${tag}: host starts, and every kid is drawn on every other screen`, async () => {
      await startMatch(A);
      await bothInMatch([A, B, C]);
      await wait(1500);
      ids = { A: (await peek(A)).me, B: (await peek(B)).me, C: (await peek(C)).me };
      const list = [[A, 'A'], [B, 'B'], [C, 'C']];
      const seen = [];
      for (const [page, name] of list) {
        for (const other of Object.keys(ids)) {
          if (other === name) continue;
          const a = await actorOf(page, ids[other]);
          expect(a, `${name} has no actor for ${other}`);
          const ink = await inkAt(page, a.x, a.y);
          const blank = await inkAt(page, a.x + 75, a.y + 40);
          expect(ink.onScreen, `${other} is off ${name}'s screen`);
          expect(ink.ink - blank.ink > 40, `${other} is not drawn on ${name}'s canvas: ink ${ink.ink}, ground ${blank.ink}`);
          seen.push(`${name}<-${other}:${ink.ink}`);
        }
      }
      await shot(A, `${tag}-03-match-A`);
      await shot(B, `${tag}-04-match-B`);
      await until('the fair share line', 3000, () => hudVisible(B, '.share'));
      expect((await B.textContent('.share')).startsWith('Your share:'), 'three humans share the Flakes');
      return seen.join(' ');
    });

    await st.check(`${tag}: a ball thrown by one kid flies on every screen`, async () => {
      const me = await peek(A);
      const aim = await screenOf(A, me.x + 180, me.y + 20);
      await A.mouse.move(aim.x, aim.y);
      await wait(100);
      await A.mouse.down();
      await wait(180);
      await A.mouse.up();
      for (const [page, name] of [[B, 'B'], [C, 'C']]) {
        const ball = await until(`${name} to see the ball`, 3000, async () => (await recorded(page)).events.find((e) => e.e === 'ball' && e.by === ids.A));
        await until(`${name} to draw it`, 3000, async () => (await recorded(page)).ballsSeen.includes(ball.id));
      }
      await until('the thrower to see it land', 3000, async () => ((await recorded(A)).counts.ballEnd ?? 0) > 0);
    });

    await st.check(`${tag}: a wall built by one kid stands on every screen`, async () => {
      const [cell] = await freeCells(B, 1);
      await buildAt(B, 'Digit1', cell);
      for (const [page, name] of [[A, 'A'], [B, 'B'], [C, 'C']]) {
        const s = await until(`${name} to see the wall`, 4000, () => structAtCell(page, cell.cx, cell.cy));
        expect(s.kind === STRUCT.WALL && s.ownerId === ids.B, `${name} sees ${JSON.stringify(s)}`);
        expect(s.solid, `${name}'s collision world has no wall`);
      }
      await wait(400);
      await shot(C, `${tag}-05-wall-C`);
      return `cell ${cell.cx},${cell.cy}`;
    });

    await st.check(`${tag}: everyone readies up, and the fight agrees on all screens`, async () => {
      for (const p of [A, B, C]) await pressReady(p);
      await until('FIGHT on every client', 8000, async () => {
        for (const p of [A, B, C]) if ((await peek(p)).phase !== 'fight') return false;
        return true;
      });
      await until('foes everywhere', 15000, async () => {
        for (const p of [A, B, C]) if (!hasFoes(await peek(p))) return false;
        return true;
      });
      const end = Date.now() + 14000;
      await Promise.all([A, B, C].map((p) => playLoop(p, { stop: () => Date.now() > end })));
      await shot(B, `${tag}-06-fight-B`);
      const [ra, rb, rc] = await Promise.all([recorded(A), recorded(B), recorded(C)]);
      const [sa, sb] = await Promise.all([peek(A), peek(B)]);
      expect(Math.abs(sa.foesLeft - sb.foesLeft) <= 2, `foesLeft ${sa.foesLeft} vs ${sb.foesLeft}`);
      expect(Math.abs(sa.colonels[0].hp - sb.colonels[0].hp) <= 60, 'Colonel hp disagrees');
      for (const k of ['hit', 'flee', 'spawn']) {
        const drift = Math.max(ra.counts[k] ?? 0, rb.counts[k] ?? 0, rc.counts[k] ?? 0) - Math.min(ra.counts[k] ?? 0, rb.counts[k] ?? 0, rc.counts[k] ?? 0);
        expect(drift <= 4, `${k} counts drifted: ${ra.counts[k]}, ${rb.counts[k]}, ${rc.counts[k]}`);
      }
      return `balls ${ra.counts.ball}/${rb.counts.ball}/${rc.counts.ball}, hits ${ra.counts.hit}/${rb.counts.hit}/${rc.counts.hit}, ping ${sb.ping.toFixed(1)} ms`;
    });

    await st.check(`${tag}: Enter opens chat in a match and the line reaches the others`, async () => {
      await A.keyboard.press('Enter');
      await until('the chat box', 3000, () => A.evaluate(() => document.activeElement?.id === 'match-chat-input'));
      await A.keyboard.type('hold the line');
      await A.keyboard.press('Enter');
      await until('the chat line on B', 4000, () => B.evaluate(() => document.querySelector('.match-chat-log')?.textContent.includes('hold the line')));
      expect(!(await A.evaluate(() => document.activeElement?.id === 'match-chat-input')), 'chat should close');
    });

    await st.check(`${tag}: a reload mid-fight resumes the same kid`, async () => {
      await C.reload();
      await C.waitForFunction('window.__ff !== undefined');
      await installRecorder(C);
      const back = await until('C to resume', 25000, async () => {
        const s = await peek(C);
        return s.inMatch && s.hasMe && s.connected ? s : null;
      });
      expect(back.me === ids.C, `came back as ${back.me}, was ${ids.C}`);
    });

    await st.check(`${tag}: a friend joining mid-fight waits, watching, then hops in at the next BUILD`, async () => {
      const D = await open(`${base}?join=${code}`, 'D');
      await until('the invite card', 6000, () => D.isVisible('#btn-invite-join'));
      await D.click('#btn-invite-join');
      const waiting = await until('the late joiner in the match', 20000, async () => {
        const s = await peek(D);
        return s.screen === 'match' && s.inMatch ? s : null;
      });
      expect(!waiting.hasMe && waiting.phase === 'fight', 'no kid until the next BUILD');
      await until('the hop-in note', 3000, () => hudVisible(D, '#hop-in'));
      await wait(600);
      await shot(D, `${tag}-06b-late-joiner`);
      await Promise.all([A, B, C].map((p) => playLoop(p, { stop: (s) => s.phase === 'build' || s.screen !== 'match', every: 150 })));
      await until('the late kid', 8000, async () => (await peek(D)).hasMe);
      expect(!(await hudVisible(D, '#hop-in')), 'the note should go');
      for (const p of [A, B, C]) await until('everyone to see the new kid', 4000, async () => (await peek(p)).kinds[ACTOR.KID] === 4);
      await leaveMatch(D);
    });

    await st.check(`${tag}: leaving behaves for host and guests`, async () => {
      await leaveMatch(A);
      if (p2p) {
        for (const p of [B, C]) {
          await until('the host-left dialog', 20000, async () => (await p.evaluate(() => document.querySelector('#error-text')?.textContent ?? '')).includes('The host left'));
          await p.click('#btn-error-ok');
        }
      } else {
        await until('host rights to pass on', 8000, async () => (await peek(B)).isHost || (await peek(C)).isHost);
        await leaveMatch(B);
        await leaveMatch(C);
      }
    });

    let attacker; let pair;
    await st.check(`${tag}: Fort Face-Off lobby splits the three kids into two teams`, async () => {
      code = await hostRoom(A);
      await setupLobby(A, { mode: 'fortwars', map: 'court' });
      await joinByCode(B, code);
      await joinByCode(C, code);
      await until('all three', 8000, () => sameRoster([A, B, C], 3));
      const teams = await A.evaluate(() => window.__ff.session.lobby.players.map((p) => [p.id, p.team]));
      const count = (t) => teams.filter(([, team]) => team === t).length;
      expect(count(0) === 2 && count(1) === 1, `teams ${JSON.stringify(teams)}`);
      const byId = new Map();
      for (const p of [A, B, C]) byId.set((await peek(p)).me, p);
      attacker = byId.get(teams.find(([, t]) => t === 1)[0]);
      pair = teams.filter(([, t]) => t === 0).map(([id]) => byId.get(id));
      await shot(A, `${tag}-07-faceoff-lobby`);
    });

    await st.check(`${tag}: Face-Off opens with a truce, and walls show on the other team's screen`, async () => {
      await startMatch(A);
      await bothInMatch([A, B, C]);
      const s = await peek(A);
      expect(s.mode === 'fortwars' && s.phase === 'build' && s.colonels.length === 2, `mode ${s.mode}`);
      expect(await A.evaluate(() => window.__ff.session.view.meta.truce), 'no truce');
      const [cell] = await freeCells(pair[0], 1);
      await buildAt(pair[0], 'Digit1', cell);
      await until('the rival to see the wall', 4000, () => structAtCell(attacker, cell.cx, cell.cy));
      await shot(attacker, `${tag}-08-faceoff-build`);
    });

    await st.check(`${tag}: a kid frozen by a rival is seen frozen everywhere, and a teammate thaws them`, async () => {
      for (const p of [A, B, C]) await pressReady(p);
      await until('the truce to end', 8000, async () => (await peek(A)).phase === 'fight');
      const spot = await A.evaluate(() => {
        const { map } = window.__ff.session.view;
        return { x: map.forts[0].x + 170, y: map.forts[0].y };
      });
      await Promise.all([walkTo(pair[0], spot.x, spot.y, { near: 14 }), walkTo(pair[1], spot.x + 14, spot.y, { near: 14 })]);
      let frozen = null;
      await playLoop(attacker, {
        reach: 260,
        stop: async () => {
          const rec = await recorded(attacker);
          frozen = rec.events.find((e) => e.e === 'freeze');
          return !!frozen;
        },
      });
      const clients = [A, B, C];
      const seenFrozen = await Promise.all(clients.map(async (p) => {
        const a = await actorOf(p, frozen.id);
        return a && (a.flags & AFLAG.FROZEN) !== 0;
      }));
      await shot(attacker, `${tag}-09-frozen-rival-view`);
      const victim = await until('the frozen page', 2000, async () => {
        for (const p of clients) if ((await peek(p)).me === frozen.id) return p;
        return null;
      });
      await shot(victim, `${tag}-10-frozen-own-view`);
      for (const p of clients) await until('the freeze on every client', 3000, async () => (await recorded(p)).events.some((e) => e.e === 'freeze' && e.id === frozen.id));
      const thaw = await until('a teammate thaw', 8000, async () => (await recorded(A)).events.find((e) => e.e === 'thaw' && e.id === frozen.id && e.by !== 0));
      for (const p of [B, C]) await until('the thaw on every client', 3000, async () => (await recorded(p)).events.some((e) => e.e === 'thaw' && e.id === frozen.id && e.by === thaw.by));
      await until('the kid to be warm again', 3000, async () => {
        const a = await actorOf(A, frozen.id);
        return a && (a.flags & AFLAG.FROZEN) === 0;
      });
      await shot(attacker, `${tag}-11-thawed`);
      return `kid ${frozen.id} frozen by ${frozen.by}, thawed by ${thaw.by}; frozen on clients: ${seenFrozen.join(',')}`;
    });

    await st.check(`${tag}: everyone leaves the Face-Off cleanly`, async () => {
      await leaveMatch(A);
      if (p2p) {
        for (const p of [B, C]) {
          await until('the host-left dialog', 20000, async () => (await p.evaluate(() => document.querySelector('#error-text')?.textContent ?? '')).includes('The host left'));
          await p.click('#btn-error-ok');
        }
      } else {
        await leaveMatch(B);
        await leaveMatch(C);
      }
    });

    await st.check(`${tag}: a whole Free-for-All plays through to results on every client`, async () => {
      code = await hostRoom(A);
      await setupLobby(A, { mode: 'ffa', map: 'yard', bots: 1 });
      await joinByCode(B, code);
      await joinByCode(C, code);
      await until('everyone', 8000, () => sameRoster([A, B, C], 4));
      await startMatch(A);
      await bothInMatch([A, B, C]);
      for (const p of [A, B, C]) await pressReady(p);
      await until('the fight', 8000, async () => (await peek(A)).phase === 'fight');
      await Promise.all([A, B, C].map((p) => playLoop(p, { stop: (s) => s.screen === 'results', every: 150 })));
      await wait(800);
      await shot(A, `${tag}-12-results-host`);
      await shot(B, `${tag}-13-results-guest`);
      const [ra, rb] = await Promise.all([peek(A), peek(B)]);
      expect(JSON.stringify(ra.result) === JSON.stringify(rb.result), 'clients disagree on the result');
      expect(await A.isVisible('#btn-play-again'), 'the host gets Play Again');
      expect(await B.isVisible('#results-wait') && !(await B.isVisible('#btn-play-again')), 'a guest waits for the host');
      return ra.result.summary;
    });

    await st.check(`${tag}: Play Again takes everyone into a new match`, async () => {
      await A.click('#btn-play-again');
      await bothInMatch([A, B, C]);
      const s = await peek(B);
      expect(s.phase === 'build', `phase ${s.phase}`);
    });
  } finally {
    for (const p of pages) await closePage(p);
  }
}

function startNpmServer(port) {
  const child = spawn('npm', ['start'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  return {
    ready: until('npm start to listen', 10000, () => out.includes(`:${port}/`)),
    stop: async () => {
      try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already gone */ }
      await new Promise((done) => { child.once('close', done); setTimeout(done, 3000); });
    },
    output: () => out,
  };
}

async function serverStage(st, browser) {
  const server = startNpmServer(SERVER_PORT);
  try {
    await st.check(`npm start serves the game on port ${SERVER_PORT}`, async () => {
      await server.ready;
      const info = await (await fetch(`http://127.0.0.1:${SERVER_PORT}/api/info`)).json();
      expect(info.game === 'Fort Flurry', JSON.stringify(info));
    });
    await multiplayer(st, browser, `http://127.0.0.1:${SERVER_PORT}/`, 'server', { p2p: false });
  } finally {
    await server.stop();
  }
}

async function p2pStage(st, browser) {
  // The plain static host from the brief: public/ with nothing answering api/info. Chrome logs that
  // probe's 404 and that exact line is the only thing excused here. The site as shipped ships a
  // marker there so real visitors see no error at all, which the solo stage checks with no excuses.
  const site = await startStatic(STATIC_PORT, '', { missing: ['/api/info'] });
  const allow = (m) => (m.location().url.endsWith('/api/info'));
  try {
    await st.check('the PeerJS cloud broker is reachable from here', async () => {
      const res = await fetch('https://0.peerjs.com/peerjs/id', { signal: AbortSignal.timeout(8000) }).catch((err) => ({ ok: false, status: err.message }));
      expect(res.ok, `0.peerjs.com did not answer (${res.status}), so nothing in this stage can work`);
    });
    await multiplayer(st, browser, site.url, 'p2p', { p2p: true, allow });
  } finally {
    await site.close();
  }

  // And the real thing: GitHub Pages serves a project site from a sub-path, with public/ as shipped.
  const pages = await startStatic(STATIC_PORT, '/fort-flurry');
  let A;
  let B;
  try {
    await st.check('as shipped on a sub-path like GitHub Pages: P2P works and the console stays spotless', async () => {
      A = await openPage(browser, pages.url, 'pagesHost', st.problems);
      await until('the network check', 5000, () => A.evaluate(() => window.__ff.app.netMode === 'p2p'));
      const code = await hostRoom(A);
      const link = await A.evaluate((c) => window.__ff.ui.inviteLink(c), code);
      expect(link === `${pages.url}?join=${code}`, `invite link ${link}`);
      B = await openPage(browser, link, 'pagesGuest', st.problems);
      await joinByInvite(B, code);
      await startMatch(A);
      await bothInMatch([A, B]);
      await wait(1500);
      return link;
    });
  } finally {
    if (A) await closePage(A);
    if (B) await closePage(B);
    await pages.close();
  }
}

// ---- every mode on every map -----------------------------------------------------------------

async function matrixRun(st, browser, base, mode, map) {
  const label = `${mode}/${map}`;
  const page = await openPage(browser, base, label, st.problems);
  try {
    await installRecorder(page);
    await goSolo(page);
    await setupLobby(page, { mode, map, difficulty: 'normal', length: mode === 'siege' ? 10 : undefined, bots: 3 });
    await startMatch(page);
    const startTick = (await peek(page)).renderTick;
    const t0 = Date.now();
    await wait(1200);
    await shot(page, `matrix-${mode}-${map}-1-build`);
    await pressReady(page);
    await until('the fight', 8000, async () => (await peek(page)).phase === 'fight');
    let midShot = false;
    let peak = 0;
    const end = await playLoop(page, {
      every: 200,
      stop: (s) => Date.now() - t0 >= 62000 || s.screen === 'results',
      onTick: async (s) => {
        peak = Math.max(peak, s.actors);
        if (s.phase === 'build' && s.screen === 'match') await page.keyboard.press('KeyR');
        if (!midShot && Date.now() - t0 > 35000) {
          midShot = true;
          await shot(page, `matrix-${mode}-${map}-2-fight`);
        }
      },
    });
    await shot(page, `matrix-${mode}-${map}-3-late`);
    const rec = await recorded(page);
    const ran = (Date.now() - t0) / 1000;
    expect(ran >= 60, `only ran ${ran} s`);
    expect(end.renderTick - startTick > 1500, `only ${end.renderTick - startTick} ticks in ${ran} s`);
    expect(rec.counts.ball > 5, 'nobody threw anything');
    expect(rec.counts.hit > 0, 'nobody hit anything');
    expect(end.mode === mode && end.mapId === map, `played ${end.mode} on ${end.mapId}`);
    if (mode === 'siege') expect(rec.counts.spawn > 0, 'no foes came');
    return `${label}: ${Math.round(ran)} s, ${Math.round(end.renderTick - startTick)} ticks, ${rec.counts.ball} balls, ${rec.counts.hit} hits, peak ${peak} actors, worst frame gap ${rec.worstGap.toFixed(0)} ms`;
  } finally {
    await closePage(page);
  }
}

async function matrixStage(st, browser) {
  const site = await startStatic(STATIC_PORT);
  try {
    for (const mode of MODES) {
      await st.check(`${mode} on every map runs for a minute with bots`, async () => {
        const notes = await Promise.all(MAPS.map((map) => matrixRun(st, browser, site.url, mode, map)));
        return notes.join('\n        ');
      });
    }
  } finally {
    await site.close();
  }
}

// ---- bosses ----------------------------------------------------------------------------------

async function bossFight(st, browser, server, base, map) {
  const page = await openPage(browser, base, `boss/${map}`, st.problems);
  const log = [];
  try {
    await installRecorder(page);
    const code = await hostRoom(page);
    await setupLobby(page, { mode: 'siege', map, difficulty: 'cozy', length: 10, bots: 3 });
    await startMatch(page);
    const g = gameOf(server, code);
    expect(g, 'room not found on the server');

    // ---- wave 5, the Truck
    jumpToWave(g, 5);
    await until('wave 5 BUILD', 4000, async () => {
      const s = await peek(page);
      return s.wave === 5 && s.phase === 'build';
    });
    await pressReady(page);
    await until('the Truck', 8000, async () => (await peek(page)).boss?.kind === ACTOR.TRUCK);
    await until('the boss bar', 3000, () => hudVisible(page, '.boss'));
    expect((await page.textContent('.boss-name')).includes('Sno-Cone Truck'), 'boss bar name');
    await until('the Truck theme', 4000, () => page.evaluate(() => window.__ff.audio.stats?.track === 'truck' || window.__ff.audio._wanted === 'truck'));
    let doors = false;
    let squad = 0;
    let closeUp = false;
    const fightUntil = Date.now() + 90000;
    let weakened = false;
    await playLoop(page, {
      reach: 240,
      stop: (s) => (s.wave === 6 && s.phase === 'build') || s.screen === 'results',
      onTick: async (s) => {
        const seen = await page.evaluate(([kind, doorBit, fleeBit]) => {
          const t = window.__ff.session.view.actors.find((a) => a.kind === kind);
          return t ? { doors: (t.aux & doorBit) !== 0, x: t.x, y: t.y, fleeing: (t.flags & fleeBit) !== 0 } : null;
        }, [ACTOR.TRUCK, AUX.DOORS, AFLAG.FLEEING]);
        squad = Math.max(squad, s.kinds[ACTOR.PIPSQUEAK] ?? 0);
        if (seen?.doors && !doors) {
          doors = true;
          await shot(page, `boss-${map}-truck-doors`);
        }
        if (seen && !closeUp && Math.hypot(seen.x - s.x, seen.y - s.y) < 320) {
          closeUp = true;
          await shot(page, `boss-${map}-truck`);
        }
        if (seen?.fleeing && !log.includes('truck leaves')) {
          log.push('truck leaves');
          await shot(page, `boss-${map}-truck-flees`);
        }
        if (!weakened && doors && Date.now() > fightUntil - 60000 && boss(g)) {
          // The fight is proven; what is left to see is how it ends, so hurry it along.
          weakened = true;
          setBossHp(g, 0.06);
        }
        if (Date.now() > fightUntil && boss(g)) setBossHp(g, 0.01);
      },
    });
    let s = await peek(page);
    expect(s.wave === 6 && s.phase === 'build', `after the Truck: wave ${s.wave} ${s.phase}, screen ${s.screen}`);
    expect(doors, 'the Truck never opened its doors');
    expect(squad > 0, 'no Pipsqueaks hopped out');
    log.push(`truck beaten, ${squad} door squad`);

    // ---- wave 10, Steve
    jumpToWave(g, 10);
    await until('wave 10 BUILD', 4000, async () => {
      const now = await peek(page);
      return now.wave === 10 && now.phase === 'build';
    });
    await pressReady(page);
    await until('Steve', 8000, async () => (await peek(page)).boss?.kind === ACTOR.STEVE);
    await until('the boss bar', 3000, () => hudVisible(page, '.boss'));
    expect((await page.textContent('.boss-name')).includes('Abominable Steve'), 'boss bar name');
    await until('the Steve theme', 4000, () => page.evaluate(() => window.__ff.audio.stats?.track === 'steve' || window.__ff.audio._wanted === 'steve'));
    let pound = false;
    let boulders = 0;
    let enraged = false;
    let blizzard = false;
    let close = false;
    let hurried = false;
    const steveUntil = Date.now() + 100000;
    await playLoop(page, {
      reach: 240,
      stop: (now) => now.screen === 'results',
      onTick: async (now) => {
        const seen = await page.evaluate(([kind, poundBit, rageBit, fleeBit, rock]) => {
          const v = window.__ff.session.view;
          const a = v.actors.find((it) => it.kind === kind);
          return {
            steve: a ? { pound: (a.aux & poundBit) !== 0, enraged: (a.flags & rageBit) !== 0, fleeing: (a.flags & fleeBit) !== 0, x: a.x, y: a.y } : null,
            boulders: v.balls.filter((b) => b.kind === rock).length,
          };
        }, [ACTOR.STEVE, AUX.POUND, AFLAG.ENRAGED, AFLAG.FLEEING, BALL.BOULDER]);
        boulders = Math.max(boulders, seen.boulders);
        if (seen.steve?.pound && !pound) {
          pound = true;
          await shot(page, `boss-${map}-steve-pound`);
        }
        if (seen.boulders > 0 && !log.includes('boulder')) {
          log.push('boulder');
          await shot(page, `boss-${map}-steve-boulder`);
        }
        if (seen.steve && !close && Math.hypot(seen.steve.x - now.x, seen.steve.y - now.y) < 320) {
          close = true;
          await shot(page, `boss-${map}-steve`);
        }
        if (seen.steve?.enraged && !enraged) {
          enraged = true;
          await wait(400);
          await shot(page, `boss-${map}-steve-enraged`);
        }
        if (now.blizzard && !blizzard) {
          blizzard = true;
          await wait(600);
          await shot(page, `boss-${map}-blizzard`);
        }
        if (seen.steve?.fleeing && !log.includes('steve sits')) {
          log.push('steve sits');
          await wait(800);
          await shot(page, `boss-${map}-steve-cocoa`);
        }
        // The jump skipped eight waves of fort building, cards and Flakes, so without help a bare
        // Colonel loses this race about half the time. Keep him up: the ending is what's on test.
        const colonel = g.colonel(TEAM.A);
        if (colonel && colonel.hp < colonel.maxHp * 0.5) setColonelHp(g, TEAM.A, colonel.maxHp);
        const b = boss(g);
        if (!hurried && b && (pound || boulders > 0) && Date.now() > steveUntil - 70000) {
          hurried = true;
          setBossHp(g, 0.52);
        }
        if (b && enraged && Date.now() > steveUntil - 35000) setBossHp(g, 0.05);
        if (Date.now() > steveUntil && b) setBossHp(g, 0.01);
      },
    });
    await wait(600);
    await shot(page, `boss-${map}-results`);
    s = await peek(page);
    expect(enraged, 'Steve never enraged');
    expect(blizzard, 'no blizzard');
    expect(pound || boulders > 0, 'Steve never attacked');
    expect(s.result?.won === true, `result: ${JSON.stringify(s.result)}`);
    expect(await page.textContent('#results-title') === 'You held the block!', 'win headline');
    return `${map}: ${log.join(', ')}; Steve: pound ${pound}, boulders ${boulders}, enraged, blizzard, won`;
  } finally {
    await closePage(page);
  }
}

async function bossStage(st, browser) {
  const server = await startServer({ port: SERVER_PORT, host: '127.0.0.1', log: () => {} });
  const base = `http://127.0.0.1:${server.port}/`;
  try {
    await st.check('both bosses are reached, fought and beaten on every map', async () => {
      const notes = await Promise.all(MAPS.map((map) => bossFight(st, browser, server, base, map)));
      return notes.join('\n        ');
    });
  } finally {
    await server.close();
  }
}

// ---- the other two endings -------------------------------------------------------------------

async function endingsStage(st, browser) {
  const server = await startServer({ port: SERVER_PORT, host: '127.0.0.1', log: () => {} });
  const base = `http://127.0.0.1:${server.port}/`;
  try {
    await st.check('Siege: Colonel Carrot falling ends the match with the losing results', async () => {
      const page = await openPage(browser, base, 'lose', st.problems);
      try {
        const code = await hostRoom(page);
        await setupLobby(page, { mode: 'siege', map: 'pond', difficulty: 'normal', length: 10, bots: 0 });
        await startMatch(page);
        await pressReady(page);
        await until('foes', 12000, async () => hasFoes(await peek(page)));
        setColonelHp(gameOf(server, code), TEAM.A, 0);
        await until('results', 8000, async () => (await peek(page)).screen === 'results');
        await wait(600);
        await shot(page, 'ending-siege-lost');
        const title = await page.textContent('#results-title');
        expect(title === 'Colonel Carrot took a tumble', `headline ${title}`);
        expect((await peek(page)).result.won === false, 'should be a loss');
      } finally {
        await closePage(page);
      }
    });

    await st.check('a dropped connection shows the snow nap overlay, then comes back as the same kid', async () => {
      const A = await openPage(browser, base, 'dropA', st.problems);
      let B;
      try {
        const code = await hostRoom(A);
        B = await openPage(browser, `${base}?join=${code}`, 'dropB', st.problems);
        await joinByInvite(B, code);
        await setupLobby(A, { mode: 'siege', map: 'court', difficulty: 'cozy', length: 5 });
        await startMatch(A);
        await bothInMatch([A, B]);
        const before = (await peek(B)).me;
        for (const ws of server.wss.clients) ws.terminate();
        await until('the overlay', 4000, () => B.isVisible('#reconnect-text'));
        await shot(B, 'ending-reconnecting');
        await until('the kid back', 15000, async () => {
          const s = await peek(B);
          return s.connected && !s.reconnecting && s.hasMe;
        });
        await until('the overlay to clear', 3000, async () => !(await B.isVisible('#reconnect-text')));
        const after = await peek(B);
        expect(after.me === before, `came back as ${after.me}, was ${before}`);
      } finally {
        await closePage(A);
        if (B) await closePage(B);
      }
    });

    await st.check('a kicked friend is told so, and the crew shrinks', async () => {
      const A = await openPage(browser, base, 'kickA', st.problems);
      let B;
      try {
        const code = await hostRoom(A);
        B = await openPage(browser, `${base}?join=${code}`, 'kickB', st.problems);
        await joinByInvite(B, code);
        await until('both in the lobby', 5000, () => sameRoster([A, B], 2));
        await A.click('.kid-remove');
        await until('the kick dialog', 5000, async () => (await B.evaluate(() => document.querySelector('#error-text')?.textContent ?? '')).includes('The host removed you'));
        await until('the crew to shrink', 3000, () => sameRoster([A], 1));
      } finally {
        await closePage(A);
        if (B) await closePage(B);
      }
    });

    await st.check('Face-Off: two rounds won ends the match with the right headline for each team', async () => {
      const A = await openPage(browser, base, 'fortA', st.problems);
      let B;
      try {
        const code = await hostRoom(A);
        await setupLobby(A, { mode: 'fortwars', map: 'yard', bots: 0 });
        B = await openPage(browser, `${base}?join=${code}`, 'fortB', st.problems);
        await joinByInvite(B, code);
        await startMatch(A);
        await bothInMatch([A, B]);
        const g = gameOf(server, code);
        for (let round = 1; round <= 2; round += 1) {
          await until(`round ${round} BUILD`, 12000, async () => (await peek(A)).phase === 'build' && g.round === round);
          await pressReady(A);
          await pressReady(B);
          await until('the fight', 6000, async () => (await peek(B)).phase === 'fight');
          await wait(1500);
          setColonelHp(g, TEAM.B, 0);
          if (round === 1) {
            await until('the round break', 6000, async () => (await peek(B)).phase === 'roundEnd');
            await shot(B, 'ending-faceoff-round');
          }
        }
        await until('results', 10000, async () => (await peek(A)).screen === 'results' && (await peek(B)).screen === 'results');
        await wait(600);
        await shot(A, 'ending-faceoff-winner');
        await shot(B, 'ending-faceoff-loser');
        const titleA = await A.textContent('#results-title');
        const titleB = await B.textContent('#results-title');
        expect(titleA === 'Your fort is still standing!', `winner sees ${titleA}`);
        expect(titleB.includes('rule the block'), `loser sees ${titleB}`);
        await A.click('#btn-to-lobby');
        for (const p of [A, B]) await until('back in the lobby', 6000, async () => (await peek(p)).screen === 'lobby');
        expect(await A.isVisible('#btn-start') && !(await B.isVisible('#btn-start')), 'the same host keeps Start');
        await setupLobby(A, { mode: 'ffa', map: 'court' });
        await startMatch(A);
        await bothInMatch([A, B]);
        expect((await peek(B)).mode === 'ffa', 'a new match from the same room');
      } finally {
        await closePage(A);
        if (B) await closePage(B);
      }
    });
  } finally {
    await server.close();
  }
}

// ---- everything else a player can meet -------------------------------------------------------

async function throwOnce(page, hold = 150) {
  const s = await peek(page);
  const p = await screenOf(page, s.x + 200, s.y + 30);
  await page.mouse.move(p.x, p.y);
  await wait(60);
  await page.mouse.down();
  await wait(hold);
  await page.mouse.up();
}

async function pickupsCheck(st, browser, server, base) {
  const page = await openPage(browser, base, 'items', st.problems);
  try {
    await installRecorder(page);
    const code = await hostRoom(page);
    await setupLobby(page, { mode: 'siege', map: 'court', difficulty: 'normal', length: 10 });
    await startMatch(page);
    const g = gameOf(server, code);
    const { me } = await peek(page);
    const kid = g.actors.get(me);
    holdBuild(g, 600);

    const lineup = Object.values(PICKUP).map((kind, i) => placePickup(g, kind, kid.x - 150 + i * 60, kid.y + 90));
    await until('six pickups on the ground', 3000, async () => (await peek(page)).pickups === 6);
    await wait(500);
    await shot(page, 'items-1-pickups');
    for (const p of lineup) g.removePickup(p, 0);

    let side = -1;
    const take = async (kind) => {
      // Back and forth, so the walks don't march the kid into the Colonel.
      side = -side;
      const spot = { x: kid.x - side * 70, y: kid.y };
      const p = placePickup(g, kind, spot.x, spot.y);
      await until('the pickup', 3000, async () => (await peek(page)).pickups === 1);
      await walkTo(page, spot.x, spot.y, { near: 10, ms: 5000 });
      await until('the pickup to be taken', 4000, async () => (await peek(page)).pickups === 0);
      return p;
    };
    // A client's own throws show as its predicted balls, so this also proves prediction picked the
    // right ball. The host's own count of the kid's snow says the throw really happened.
    const ballsOf = async (kind) => (await recorded(page)).events.filter((e) => e.e === 'ball' && e.by === me && (kind === undefined || e.k === kind)).length;

    for (const [name, kind, ball] of [['Ice Chunk', PICKUP.ICE, BALL.ICE], ['Slushball', PICKUP.SLUSH, BALL.SLUSH], ['Giant Roller', PICKUP.GIANT, BALL.GIANT]]) {
      await take(kind);
      await until(`the ${name} icon`, 3000, () => hudVisible(page, '.special'));
      const before = await ballsOf(ball);
      const usesBefore = kid.specialN;
      await wait(350);
      await throwOnce(page);
      await until(`a ${name} thrown`, 4000, async () => (await ballsOf(ball)) > before);
      await until('the host to spend one use', 3000, () => kid.specialN === usesBefore - 1);
      if (kind === PICKUP.GIANT) {
        await wait(300);
        await shot(page, 'items-2-giant-roller');
        expect(!(await hudVisible(page, '.special')), 'one use only');
      }
      kid.special = null;
      kid.specialN = 0;
    }

    await take(PICKUP.TRIPLE);
    await until('the Triple Toss icon', 3000, () => hudVisible(page, '.special'));
    const before = await ballsOf();
    await wait(350);
    await throwOnce(page);
    await until('three balls from one throw', 4000, async () => (await ballsOf()) === before + 3);
    await wait(100);
    await shot(page, 'items-3-triple');
    kid.special = null;
    kid.specialN = 0;

    kid.hp = 30;
    await take(PICKUP.COCOA);
    await until('warmth from the cocoa', 3000, async () => (await peek(page)).you.warmth >= 69);

    await take(PICKUP.BOARD);
    await until('the board', 3000, async () => ((await peek(page)).meFlags & 16) !== 0);
    await wait(250);
    await shot(page, 'items-4-board');
    const a = await peek(page);
    await page.keyboard.down('KeyA');
    await wait(600);
    const b = await peek(page);
    await page.keyboard.up('KeyA');
    const speed = Math.abs(b.x - a.x) / 0.6;
    expect(speed > 230, `a boarding kid should outrun a walking one, went ${speed.toFixed(0)} u/s`);
    return `all six pickups taken and used; boarding at ${speed.toFixed(0)} u/s`;
  } finally {
    await closePage(page);
  }
}

async function actionsCheck(st, browser, server, base) {
  const page = await openPage(browser, base, 'actions', st.problems);
  try {
    await installRecorder(page);
    const code = await hostRoom(page);
    await setupLobby(page, { mode: 'siege', map: 'court', difficulty: 'normal', length: 10 });
    await startMatch(page);
    const g = gameOf(server, code);
    const { me } = await peek(page);
    const kid = g.actors.get(me);
    holdBuild(g, 600);
    await wait(1200);
    const flakes = async () => (await peek(page)).flakes[0];
    const notes = [];

    // Lob: hold the right button, aim at the ground, let go. Two balls, and it lands on the spot.
    const before = await peek(page);
    const spot = { x: before.x - 220, y: before.y + 60 };
    await page.evaluate(() => { window.__lands = []; window.__ff.session.on('fx', (e) => { if (e.e === 'splash') window.__lands.push(e); }); });
    await pointAt(page, spot.x, spot.y);
    await page.mouse.down({ button: 'right' });
    // The camera leads a lob, so the spot slides away from a still cursor. A player follows it.
    await wait(450);
    await pointAt(page, spot.x, spot.y);
    await shot(page, 'actions-1-lob-aim');
    await page.mouse.up({ button: 'right' });
    await until('the lob to land', 4000, () => page.evaluate(() => window.__lands.length > 0));
    const land = await page.evaluate(() => window.__lands[0]);
    expect(Math.hypot(land.x - spot.x, land.y - spot.y) < 12, `lob landed ${land.x},${land.y}, aimed ${spot.x},${spot.y}`);
    expect((await recorded(page)).events.some((e) => e.e === 'ball' && e.by === me && e.k === 2), 'no LOB ball');
    notes.push(`lob landed ${Math.round(Math.hypot(land.x - spot.x, land.y - spot.y))} units from the cursor`);

    // Packing: stand still and the pips fill back up.
    kid.balls = 3;
    await until('the low pips', 2000, async () => (await peek(page)).you.balls <= 4);
    await until('packing to refill the pips', 6000, async () => (await peek(page)).you.balls >= 8);
    notes.push('packing refills');

    // Cancel: Esc during a charge throws nothing and costs nothing.
    const full = (await peek(page)).you.balls;
    const thrown = (await recorded(page)).counts.ball ?? 0;
    await page.mouse.down();
    await wait(250);
    await page.keyboard.press('Escape');
    await wait(120);
    await page.mouse.up();
    await wait(500);
    expect(((await recorded(page)).counts.ball ?? 0) === thrown, 'a cancelled charge threw');
    expect((await peek(page)).you.balls >= full, 'a cancelled charge cost snow');
    notes.push('Esc cancels a charge');

    // Belly slide on Space.
    const slides = (await recorded(page)).counts.slide ?? 0;
    const start = await peek(page);
    await page.keyboard.down('KeyA');
    await wait(120);
    await page.keyboard.press('Space');
    await wait(250);
    await page.keyboard.up('KeyA');
    await until('the slide', 2000, async () => ((await recorded(page)).counts.slide ?? 0) > slides);
    expect(start.x - (await peek(page)).x > 70, 'the slide should carry the kid');
    await wait(500);
    notes.push('Space slides');

    // Demolish with X under the cursor gives half back.
    const [cell] = await freeCells(page, 1);
    await buildAt(page, 'Digit1', cell);
    const wall = await until('the wall', 3000, () => structAtCell(page, cell.cx, cell.cy));
    const afterBuild = await flakes();
    await pressNear(page, cell);
    await page.keyboard.press('KeyX');
    await until('the wall to go', 3000, async () => !(await structAtCell(page, cell.cx, cell.cy)));
    await until('the refund', 2000, async () => (await flakes()) === afterBuild + 1);
    notes.push(`X demolished ${wall.id} for 1 Flake back`);

    // Repair: the same tool on a damaged wall of yours.
    const [patchCell] = await freeCells(page, 1);
    await buildAt(page, 'Digit1', patchCell);
    await until('the second wall', 3000, () => structAtCell(page, patchCell.cx, patchCell.cy));
    const hurt = [...g.structs.values()].find((x) => x.cx === patchCell.cx && x.cy === patchCell.cy);
    hurt.hp = 20;
    g.touchStruct(hurt);
    await until('the wall to look hurt', 3000, () => page.evaluate(([cx, cy]) => window.__ff.session.view.structs.find((x) => x.cx === cx && x.cy === cy)?.hp === 20, [patchCell.cx, patchCell.cy]));
    const beforeRepair = await flakes();
    await buildAt(page, 'Digit1', patchCell);
    await until('the repair', 3000, () => hurt.hp === hurt.maxHp);
    await until('the repair cost', 2000, async () => (await flakes()) === beforeRepair - 1);
    notes.push('repair restores a wall for half price');

    // A healthy Colonel's sprite must not get in the way of the wall drawn behind him, either way.
    const col = g.colonel(TEAM.A);
    await walkTo(page, col.x - 90, col.y + 10, { near: 30, ms: 6000 });
    const behind = { cx: col.cx, cy: col.cy - 1, x: (col.cx + 0.5) * CELL, y: (col.cy - 0.5) * CELL };
    await buildAt(page, 'Digit1', behind);
    await until('the wall behind him', 3000, () => structAtCell(page, behind.cx, behind.cy));
    await pressNear(page, behind);
    await page.keyboard.press('KeyX');
    await until('X to reach it', 3000, async () => !(await structAtCell(page, behind.cx, behind.cy)));
    notes.push('walls behind the Colonel can be built and demolished');

    // Patch: the wall tool on a hurt Colonel, in BUILD.
    setColonelHp(g, TEAM.A, col.maxHp * 0.5);
    await until('the hurt Colonel', 3000, async () => (await peek(page)).colonels[0].hp <= col.maxHp * 0.5 + 1);
    kid.hp = kid.maxHp;
    g.flakes[TEAM.A] = 30;
    await buildAt(page, 'Digit1', { x: col.x - 10, y: col.y + 10 });
    await until('the patch', 3000, () => col.hp > col.maxHp * 0.5 + 1);
    notes.push('patch heals the hurt Colonel');

    // Shout menu, and Tab for the scores.
    const emotes = (await recorded(page)).counts.emote ?? 0;
    await page.keyboard.press('KeyV');
    await until('the shout menu', 2000, () => hudVisible(page, '#shout-menu'));
    await page.keyboard.press('Digit2');
    await until('the shout', 3000, async () => ((await recorded(page)).counts.emote ?? 0) > emotes);
    await wait(300);
    await shot(page, 'actions-2-shout');
    await page.keyboard.down('Tab');
    await until('the scoreboard', 2000, () => hudVisible(page, '#scoreboard'));
    await page.keyboard.up('Tab');
    await until('the scoreboard to close', 2000, async () => !(await hudVisible(page, '#scoreboard')));
    notes.push('V shouts, Tab shows scores');

    // Mute on M stays in step with the Menu.
    const wasMuted = await page.evaluate(() => window.__ff.ui.prefs.muted);
    await page.keyboard.press('KeyM');
    expect((await page.evaluate(() => window.__ff.ui.prefs.muted)) === !wasMuted, 'M toggles sound');
    await page.keyboard.press('KeyM');

    // The Colonel, off screen and under attack, gets an arrow at the edge.
    await walkTo(page, col.x, col.y + 640, { near: 60, ms: 9000 });
    const off = await screenOf(page, col.x, col.y);
    const size = await page.evaluate(() => ({ w: innerWidth, h: innerHeight }));
    expect(off.x > size.w || off.x < 0 || off.y < 0 || off.y > size.h, 'the Colonel should be off screen for this');
    g.damageStruct(col, 5, null);
    await wait(500);
    await shot(page, 'actions-3-colonel-arrow');
    // The renderer pins it above the HUD's lower edge, on the line up to him, so it can be seen.
    const clear = await page.evaluate(() => {
      const { top } = window.__ff.renderer.edgeInsets;
      return { top, hud: document.querySelector('.hud-center').getBoundingClientRect().bottom };
    });
    expect(clear.top > clear.hud, `edge arrows would sit behind the HUD: ${JSON.stringify(clear)}`);
    return notes.join(', ');
  } finally {
    await closePage(page);
  }
}

async function foesCheck(st, browser, server, base) {
  const page = await openPage(browser, base, 'foes', st.problems);
  try {
    await installRecorder(page);
    const code = await hostRoom(page);
    await setupLobby(page, { mode: 'siege', map: 'yard', difficulty: 'normal', length: 10 });
    await startMatch(page);
    const g = gameOf(server, code);
    const { me } = await peek(page);
    const kid = g.actors.get(me);
    holdBuild(g, 600);

    // Every walking foe at once, in the open, on a real client.
    // Stunned so they stand still past their spawn grace, which draws them translucent.
    const lineup = FOE_KINDS.map((kind, i) => g.spawnFoe(kind, kid.x - 240 + i * 80, kid.y + 90, { noFlakes: true }));
    for (const foe of lineup) if (foe) foe.stunT = 4;
    await until('the lineup', 3000, async () => Object.keys((await peek(page)).kinds).length === 8);
    await wait(1400);
    await shot(page, 'foes-1-lineup');
    const inks = [];
    for (const foe of lineup) {
      if (!foe) continue;
      const a = await actorOf(page, foe.id);
      expect(a, `kind ${foe.kind} missing from the view`);
      const ink = await inkAt(page, a.x, a.y, 36, 56, 26);
      const blank = await inkAt(page, a.x, a.y + 60, 36, 56, 26);
      expect(ink.onScreen && ink.ink - blank.ink > 12, `kind ${foe.kind} is not drawn: ${JSON.stringify(ink)}, ground ${blank.ink}`);
      inks.push(`${foe.kind}:${ink.ink}`);
    }
    for (const foe of lineup) if (foe) g.despawn(foe);

    // Wave 7 is the Carrot Thieves. Nobody defends, so one gets the nose.
    jumpToWave(g, 7);
    await until('wave 7', 4000, async () => (await peek(page)).wave === 7);
    await pressReady(page);
    let noseShot = false;
    const seen = new Set();
    await until('a Thief to grab the nose', 90000, async () => {
      const s = await peek(page);
      for (const k of Object.keys(s.kinds)) seen.add(Number(k));
      const c = g.colonel(TEAM.A);
      if (c.hp < c.maxHp * 0.3) setColonelHp(g, TEAM.A, c.maxHp);
      if (s.colonels?.[0]?.nose === false) {
        noseShot = true;
        return true;
      }
      return false;
    }, 250);
    expect(noseShot, 'the nose never went');
    await walkTo(page, g.map.fort.x + 110, g.map.fort.y + 60, { near: 40, ms: 8000 });
    await shot(page, 'foes-2-nose-stolen');

    // Wave 9 has every crew in town at once.
    jumpToWave(g, 9);
    await until('wave 9', 4000, async () => (await peek(page)).wave === 9);
    await pressReady(page);
    const t0 = Date.now();
    await playLoop(page, {
      every: 200,
      stop: () => Date.now() - t0 > 40000,
      onTick: async (s) => {
        for (const k of Object.keys(s.kinds)) seen.add(Number(k));
        const c = g.colonel(TEAM.A);
        if (c && c.hp < c.maxHp * 0.3) setColonelHp(g, TEAM.A, c.maxHp);
      },
    });
    await shot(page, 'foes-3-wave9');
    for (const kind of FOE_KINDS) expect(seen.has(kind), `foe kind ${kind} never showed up in waves 7 and 9`);
    return `all seven foe kinds drawn (${inks.join(' ')}) and seen in real waves`;
  } finally {
    await closePage(page);
  }
}

async function endlessCheck(st, browser, server, base) {
  const page = await openPage(browser, base, 'endless', st.problems);
  try {
    const code = await hostRoom(page);
    await setupLobby(page, { mode: 'siege', map: 'pond', difficulty: 'normal', length: 0, bots: 1 });
    await startMatch(page);
    const g = gameOf(server, code);
    jumpToWave(g, 15);
    await until('wave 15', 4000, async () => (await peek(page)).wave === 15);
    await pressReady(page);
    await until('an Endless Truck', 8000, async () => (await peek(page)).boss?.kind === ACTOR.TRUCK);
    const line = await page.textContent('.wave-name');
    expect(line.startsWith('Wave 15:'), `HUD says ${line}`);
    const b = boss(g);
    expect(b.maxHp > 1500, `Endless boss hp ${b.maxHp}`);
    await shot(page, 'endless-wave15');
    return `${line}, Truck at ${Math.round(b.maxHp)} hp`;
  } finally {
    await closePage(page);
  }
}

async function worldStage(st, browser) {
  const server = await startServer({ port: SERVER_PORT, host: '127.0.0.1', log: () => {} });
  const base = `http://127.0.0.1:${server.port}/`;
  try {
    await st.check('all six pickups are drawn, taken and used, including special throws', () => pickupsCheck(st, browser, server, base));
    await st.check('lob, packing, cancel, slide, demolish, repair, patch, shout and scores all work by hand', () => actionsCheck(st, browser, server, base));
    await st.check('every foe kind is drawn, and each turns up in real waves', () => foesCheck(st, browser, server, base));
    await st.check('Endless runs past wave 10 with bosses that keep growing', () => endlessCheck(st, browser, server, base));
  } finally {
    await server.close();
  }
}

// ---- screens from a phone to 4K --------------------------------------------------------------

const sideOverflow = (page) => page.evaluate(() => {
  const w = document.documentElement.clientWidth;
  const h = document.documentElement.clientHeight;
  const bad = [];
  for (const node of document.querySelectorAll('#hud button, #hud .patch, #hud .tray')) {
    if (node.closest('[hidden]') || node.offsetParent === null) continue;
    const r = node.getBoundingClientRect();
    if (r.width === 0) continue;
    if (r.left < -1 || r.top < -1 || r.right > w + 1 || r.bottom > h + 1) bad.push(`${node.className}: ${Math.round(r.left)},${Math.round(r.top)} to ${Math.round(r.right)},${Math.round(r.bottom)}`);
  }
  return bad;
});

async function layoutRun(st, browser, base, name, opts, viewportCheck) {
  const page = await openPage(browser, base, name, st.problems, opts);
  try {
    await goSolo(page);
    await setupLobby(page, { mode: 'siege', map: 'court', difficulty: 'cozy', length: 5, bots: 1 });
    await shot(page, `layout-${name}-1-lobby`);
    await startMatch(page);
    await wait(1500);
    await shot(page, `layout-${name}-2-build`);
    const size = await page.evaluate(() => ({ w: innerWidth, h: innerHeight, cw: document.getElementById('game').clientWidth, ch: document.getElementById('game').clientHeight }));
    expect(size.cw === size.w && size.ch === size.h, `canvas ${size.cw}x${size.ch} on a ${size.w}x${size.h} screen`);
    const over = await sideOverflow(page);
    expect(over.length === 0, `off screen: ${over.join('; ')}`);
    await pressReady(page);
    await until('the fight', 8000, async () => (await peek(page)).phase === 'fight');
    await wait(6000);
    await shot(page, `layout-${name}-3-fight`);
    if (viewportCheck) await viewportCheck(page);
    const over2 = await sideOverflow(page);
    expect(over2.length === 0, `off screen in FIGHT: ${over2.join('; ')}`);
    return `${name} ${size.w}x${size.h}`;
  } finally {
    await closePage(page);
  }
}

// Real multi-touch, through the same event path a phone's screen uses.
async function touchCheck(st, browser, base) {
  const page = await openPage(browser, base, 'touch', st.problems, { viewport: { width: 844, height: 390 }, dpr: 2, context: { hasTouch: true, isMobile: true } });
  try {
    await installRecorder(page);
    await goSolo(page);
    await setupLobby(page, { mode: 'siege', map: 'court', difficulty: 'cozy', length: 5 });
    await startMatch(page);
    await wait(800);
    const cdp = await page.context().newCDPSession(page);
    const touch = (type, touchPoints) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints });

    const a = await peek(page);
    await touch('touchStart', [{ x: 150, y: 300, id: 1 }]);
    await wait(60);
    await touch('touchMove', [{ x: 90, y: 300, id: 1 }]);
    await wait(700);
    await shot(page, 'controls-touch-stick');
    await touch('touchEnd', []);
    const b = await peek(page);
    expect(a.x - b.x > 70, `the left stick should walk the kid left: ${a.x} to ${b.x}`);

    // Hold the right stick out, then let go, and a ball leaves while the left thumb walks.
    const before = (await recorded(page)).counts.ball ?? 0;
    await touch('touchStart', [{ x: 700, y: 300, id: 2 }]);
    await wait(60);
    await touch('touchMove', [{ x: 760, y: 300, id: 2 }]);
    await wait(300);
    await touch('touchEnd', []);
    await until('a ball from the right stick', 3000, async () => ((await recorded(page)).counts.ball ?? 0) > before);

    // A drag that comes back into the deadzone cancels, spending nothing.
    await wait(700);
    const held = (await recorded(page)).counts.ball;
    await touch('touchStart', [{ x: 700, y: 300, id: 3 }]);
    await wait(60);
    await touch('touchMove', [{ x: 760, y: 300, id: 3 }]);
    await wait(250);
    await touch('touchMove', [{ x: 701, y: 300, id: 3 }]);
    await wait(80);
    await touch('touchEnd', []);
    await wait(500);
    expect((await recorded(page)).counts.ball === held, 'a stick let go in the deadzone must not throw');

    await page.tap('#hud-slide');
    await page.tap('.tool[data-tool="0"]');
    await until('the tool', 2000, () => page.evaluate(() => window.__ff.input.tool === 0));
    const [cell] = await freeCells(page, 1);
    const p = await screenOf(page, cell.x, cell.y);
    await touch('touchStart', [{ x: p.x, y: p.y, id: 4 }]);
    await wait(60);
    await touch('touchEnd', []);
    await until('a wall from a touch', 3000, async () => ((await peek(page)).structKinds[STRUCT.WALL] ?? 0) >= 1);
    return `walked ${Math.round(a.x - b.x)} units, threw, cancelled and built by touch`;
  } finally {
    await closePage(page);
  }
}

// A stand-in for navigator.getGamepads: the browser can't be handed a real controller here.
const PAD_STUB = `(() => {
  const pad = { id: 'e2e pad', index: 0, connected: true, mapping: 'standard', timestamp: 0, axes: [0, 0, 0, 0],
    buttons: Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 })) };
  window.__pad = pad;
  navigator.getGamepads = () => [pad];
})();`;

async function padCheck(st, browser, base) {
  const page = await openPage(browser, base, 'pad', st.problems, { init: PAD_STUB });
  const stick = (axis, value) => page.evaluate(([i, v]) => { window.__pad.axes[i] = v; }, [axis, value]);
  const button = (i, on) => page.evaluate(([b, v]) => {
    window.__pad.buttons[b].pressed = v;
    window.__pad.buttons[b].value = v ? 1 : 0;
  }, [i, on]);
  const tap = async (i) => { await button(i, true); await wait(90); await button(i, false); await wait(90); };
  try {
    await installRecorder(page);
    await goSolo(page);
    await setupLobby(page, { mode: 'siege', map: 'court', difficulty: 'cozy', length: 5 });
    await startMatch(page);
    await wait(800);

    const a = await peek(page);
    await stick(0, -1);
    await wait(700);
    await stick(0, 0);
    const b = await peek(page);
    expect(a.x - b.x > 70, `the left stick should walk the kid: ${a.x} to ${b.x}`);
    expect(await page.evaluate(() => window.__ff.input.mode === 'pad'), 'the HUD should know it is a pad');

    await stick(2, -1);
    await wait(150);
    const before = (await recorded(page)).counts.ball ?? 0;
    await button(7, true);
    await wait(250);
    await button(7, false);
    await until('a ball from RT', 3000, async () => ((await recorded(page)).counts.ball ?? 0) > before);
    await stick(2, 0);

    await tap(5);
    await until('RB to pick a tool', 2000, () => page.evaluate(() => window.__ff.input.tool !== null));
    await stick(3, 1);
    await wait(150);
    await tap(2);
    await until('X to build', 3000, async () => ((await peek(page)).structs ?? 0) >= 2);
    await stick(3, 0);
    await tap(1);
    await until('B to drop the tool', 2000, () => page.evaluate(() => window.__ff.input.tool === null));

    await tap(3);
    await until('Y to ready up', 4000, async () => (await peek(page)).phase === 'fight');
    return 'walked, threw, picked a tool, built and readied up with the pad';
  } finally {
    await closePage(page);
  }
}

async function layoutStage(st, browser) {
  const site = await startStatic(STATIC_PORT);
  const phone = { hasTouch: true, isMobile: true };
  try {
    await st.check('phone in landscape: compact HUD, touch controls, nothing off screen', () => layoutRun(st, browser, site.url, 'phone-landscape', {
      viewport: { width: 844, height: 390 }, dpr: 3, context: phone,
    }, async (page) => {
      expect(await page.evaluate(() => window.__ff.input.mode === 'touch'), 'touch mode');
      expect(await hudVisible(page, '#hud-hammer'), 'hammer in FIGHT');
      await page.touchscreen.tap(700, 250);
      await wait(250);
      await shot(page, 'layout-phone-landscape-4-touch');
    }));
    await st.check('touch twin-stick walks, throws, cancels and builds in a real match', () => touchCheck(st, browser, site.url));
    await st.check('a gamepad walks, throws, builds and readies up in a real match', () => padCheck(st, browser, site.url));
    await st.check('small laptop', () => layoutRun(st, browser, site.url, 'laptop', { viewport: { width: 1024, height: 640 } }));
    await st.check('4K desktop', () => layoutRun(st, browser, site.url, '4k', { viewport: { width: 3840, height: 2160 } }));
    await st.check('the dev pages load clean', async () => {
      for (const name of ['render-gallery', 'sprites-gallery', 'audio-board', 'ui-harness']) {
        const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
        const page = await context.newPage();
        page.on('pageerror', (e) => st.problems.add(`${name} pageerror: ${e.message}`));
        page.on('console', (m) => { if (m.type() === 'error') st.problems.add(`${name} console.error: ${m.text()}`); });
        await page.goto(`${site.url}dev/${name}.html`);
        await wait(1500);
        await context.close();
      }
    });
    await st.check('resizing mid-match keeps drawing, from desktop to phone size and back', async () => {
      const page = await openPage(browser, site.url, 'resize', st.problems, { viewport: { width: 1600, height: 900 } });
      try {
        await goSolo(page);
        await setupLobby(page, { mode: 'ffa', map: 'yard', bots: 2 });
        await startMatch(page);
        for (const [width, height] of [[640, 300], [320, 568], [1920, 1080]]) {
          await page.setViewportSize({ width, height });
          await wait(700);
          const c = await page.evaluate(() => ({ w: document.getElementById('game').width, h: document.getElementById('game').height, cw: document.getElementById('game').clientWidth }));
          expect(c.cw === width, `canvas css width ${c.cw} on ${width}`);
          const a = await peek(page);
          await wait(300);
          const b = await peek(page);
          expect(b.renderTick > a.renderTick, 'stopped ticking');
          await shot(page, `layout-resize-${width}x${height}`);
        }
      } finally {
        await closePage(page);
      }
    });
  } finally {
    await site.close();
  }
}

// ---- main ------------------------------------------------------------------------------------

const listening = (port) => new Promise((done) => {
  const socket = connect(port, '127.0.0.1');
  socket.once('connect', () => { socket.destroy(); done(true); });
  socket.once('error', () => done(false));
});

const STAGES = {
  static: staticStage,
  unit: unitStage,
  solo: soloStage,
  server: serverStage,
  p2p: p2pStage,
  matrix: matrixStage,
  bosses: bossStage,
  endings: endingsStage,
  world: worldStage,
  layout: layoutStage,
};
const wanted = process.argv.slice(2);
for (const name of wanted) {
  if (!STAGES[name]) {
    console.error(`unknown stage ${name}; stages are ${Object.keys(STAGES).join(' ')}`);
    process.exit(2);
  }
}
const full = wanted.length === 0;
if (full) rmSync(ARTIFACTS, { recursive: true, force: true });
mkdirSync(ARTIFACTS, { recursive: true });

const runner = new Runner();
const started = Date.now();
const needsBrowser = (full ? Object.keys(STAGES) : wanted).some((n) => n !== 'static' && n !== 'unit');
const browser = needsBrowser ? await launch() : null;
try {
  for (const [name, fn] of Object.entries(STAGES)) {
    if (full || wanted.includes(name)) await runner.stage(name, (st) => fn(st, browser));
  }
} finally {
  await browser?.close();
}
if (needsBrowser) {
  await runner.stage('cleanup', (st) => st.check('nothing is left listening on the test ports', async () => {
    for (const port of [SERVER_PORT, STATIC_PORT]) expect(!(await listening(port)), `port ${port} is still open`);
  }));
}
const ok = runner.finish();
console.log(`${ok ? 'PASS' : 'FAIL'} in ${seconds(Date.now() - started)} s; screenshots in ${relative(ROOT, ARTIFACTS)}/`);
process.exit(ok ? 0 : 1);
