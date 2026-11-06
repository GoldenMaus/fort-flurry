// The shipped game, driven through its own UI: real title screen, real invite link, real
// Renderer and Audio on top of the netcode. p2p-chrome.mjs proves the plumbing; this proves
// the plumbing and everything sitting on it agree. Needs the internet for the broker.
//   node test/p2p-ui.mjs [subpath|soak|p2p|server|solo ...]      with no names, runs them all
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { startStatic } from './p2p-static.mjs';
import { startServer } from '../server/index.js';

const PORT = Number(process.env.P2P_PORT) || 8101;
const SHOTS = process.env.P2P_SHOTS || null;
const problems = [];
let browser;

const note = (...args) => console.log('   ', ...args);
const expect = (cond, msg) => { if (!cond) throw new Error(msg); };
const wait = (ms) => new Promise((done) => setTimeout(done, ms));

async function until(what, ms, check) {
  const start = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - start > ms) throw new Error(`timed out after ${ms} ms waiting for ${what}`);
    await wait(100);
  }
}

async function openGame(url, label) {
  const context = await browser.newContext({ viewport: { width: 1024, height: 640 } });
  const page = await context.newPage();
  page.on('pageerror', (e) => problems.push(`${label} pageerror: ${e.message}`));
  // detectMode's probe of api/info is how a static host is recognized, so its 404 is the
  // expected answer. Chrome logs it regardless; anything else that fails is a real problem.
  page.on('response', (r) => {
    if (r.status() >= 400 && !r.url().endsWith('/api/info')) problems.push(`${label} HTTP ${r.status()} ${r.url()}`);
  });
  page.on('console', (m) => {
    const probe = m.text().includes('404') && m.location().url.endsWith('/api/info');
    if (m.type() === 'error' && !probe) problems.push(`${label} console.error: ${m.text()} @ ${m.location().url}`);
  });
  await page.goto(url);
  await page.waitForFunction('window.__ff !== undefined');
  // Every fx the app receives, so the two ends can be compared afterwards.
  await page.evaluate(() => {
    window.fxCount = {};
    const hook = () => {
      const s = window.__ff.session;
      if (!s || s.fxHooked) return;
      s.fxHooked = true;
      s.on('fx', (ev) => { window.fxCount[ev.e] = (window.fxCount[ev.e] ?? 0) + 1; });
    };
    setInterval(hook, 50);
  });
  return page;
}

const peek = (page) => page.evaluate(() => {
  const s = window.__ff.session;
  if (!s) return null;
  const v = s.view;
  return {
    me: s.me, code: s.roomCode, connected: s.connected, reconnecting: s.reconnecting, inMatch: s.inMatch, ping: s.ping,
    phase: v.phase, wave: v.wave, renderTick: v.renderTick, hasMe: !!v.me, x: v.me?.x, y: v.me?.y, actors: v.actors.length,
    foes: v.actors.filter((a) => a.kind !== 0).length, balls: v.balls.length, structs: v.structs.length, pickups: v.pickups.length,
    foesLeft: v.meta?.foesLeft, flakes: v.meta?.flakes, you: v.you ? { balls: v.you.balls, warmth: v.you.warmth } : null,
    colonel: v.meta?.colonels?.[0]?.hp, players: v.players.size,
  };
});

const fxCount = (page) => page.evaluate(() => window.fxCount);
const shot = async (page, name) => {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
};

// Walks toward open ground and throws in a slow circle. forceFrame goes through the same
// Input -> setFrameInput path a mouse does.
const play = (page) => page.evaluate(() => {
  let t = 0;
  clearInterval(window.playTimer);
  window.playTimer = setInterval(() => {
    t += 1;
    const me = window.__ff.session?.view.me;
    if (!me) return;
    const aim = t * 0.09;
    window.__ff.input.forceFrame({
      mx: Math.cos(t * 0.02), my: Math.sin(t * 0.02), aim, btn: t % 24 < 6 ? 1 : 0, tx: me.x + Math.cos(aim) * 200, ty: me.y + Math.sin(aim) * 200,
    });
  }, 33);
});

async function hostAndInvite(base) {
  const host = await openGame(base, 'host');
  await until('Host to enable', 6000, () => host.evaluate(() => !document.querySelector('#btn-host')?.disabled));
  await host.click('#btn-host');
  const code = await until('a room code', 15000, async () => (await peek(host))?.code);
  await until('the lobby', 6000, () => host.isVisible('#btn-start'));
  const joiner = await openGame(`${base}?join=${code}`, 'joiner');
  await until('the invite card', 6000, () => joiner.isVisible('#btn-invite-join'));
  await joiner.click('#btn-invite-join');
  await until('the joiner in the lobby', 15000, async () => (await peek(joiner))?.players === 2);
  await until('the host to see two kids', 6000, async () => (await peek(host))?.players === 2);
  note(`room ${code}: host through the title screen, joiner through the invite link`);
  return { host, joiner, code };
}

async function fullMatch(base, tag) {
  const { host, joiner, code } = await hostAndInvite(base);
  await shot(host, `${tag}-lobby-host`);
  await host.click('#btn-start');
  await until('both in the match', 10000, async () => (await peek(host)).inMatch && (await peek(joiner)).inMatch);
  await until('both kids', 8000, async () => (await peek(host)).hasMe && (await peek(joiner)).hasMe);
  await play(host);
  await play(joiner);
  await wait(1500);
  await shot(joiner, `${tag}-build-joiner`);
  const a = await peek(host);
  const b = await peek(joiner);
  note(`build: phase ${a.phase}, wave ${a.wave}, joiner ping ${b.ping.toFixed(1)} ms, ${b.structs} structs`);
  expect(a.structs === b.structs && a.structs >= 1, `structs differ: ${a.structs} vs ${b.structs}`);

  // Both ready up, which ends the build phase through the normal command path.
  for (const p of [host, joiner]) await p.evaluate(() => window.__ff.session.cmd('ready'));
  await until('FIGHT', 10000, async () => (await peek(joiner)).phase === 'fight');
  await until('foes on screen', 20000, async () => (await peek(joiner)).foes > 0);
  await wait(9000);
  await shot(joiner, `${tag}-fight-joiner`);
  const fa = await fxCount(host);
  const fb = await fxCount(joiner);
  const ha = await peek(host);
  const hb = await peek(joiner);
  note(`fight: foes ${ha.foes}/${hb.foes}, foesLeft ${ha.foesLeft}/${hb.foesLeft}, colonel ${ha.colonel}/${hb.colonel}, balls ${ha.balls}/${hb.balls}`);
  note(`host fx ${JSON.stringify(fa)}`);
  note(`joiner fx ${JSON.stringify(fb)}`);
  expect(fb.ball > 0 && fb.ballEnd > 0, 'the joiner saw balls fly and land');
  expect(Math.abs(ha.foes - hb.foes) <= 2, `foe counts disagree: ${ha.foes} vs ${hb.foes}`);
  expect(Math.abs(ha.colonel - hb.colonel) <= 60, `colonel hp disagrees: ${ha.colonel} vs ${hb.colonel}`);

  // A reload mid-fight: the app resumes from sessionStorage, no invite card, same slot.
  const me = hb.me;
  await joiner.reload();
  await joiner.waitForFunction('window.__ff !== undefined');
  await until('the joiner to resume', 15000, async () => {
    const s = await peek(joiner);
    return s?.inMatch && s.hasMe && s.connected;
  });
  const resumed = await peek(joiner);
  expect(resumed.me === me, `resumed as ${resumed.me}, was ${me}`);
  note(`reload mid-fight: resumed as player ${resumed.me} with ${resumed.foes} foes in view`);
  await shot(joiner, `${tag}-resumed-joiner`);
  return { host, joiner, code };
}

const runs = {
  // How GitHub Pages serves a project site, and the primary deployment. The worker URL, the
  // PeerJS import, the api/info probe and the invite link all have to resolve under it.
  async subpath() {
    const site = await startStatic(PORT, '/fort-flurry');
    try {
      expect(site.url.endsWith('/fort-flurry/'), site.url);
      const { host, joiner, code } = await hostAndInvite(site.url);
      const link = await host.evaluate((c) => window.__ff.ui.inviteLink(c), code);
      expect(link === `${site.url}?join=${code}`, `invite link ${link}`);
      await host.click('#btn-start');
      await until('both kids', 10000, async () => (await peek(host)).hasMe && (await peek(joiner)).hasMe);
      note(`served from /fort-flurry/: worker, PeerJS and invite link ${link} all resolved`);
      await joiner.context().close();
      await host.context().close();
    } finally {
      await site.close();
    }
  },

  // A longer stretch of a real fight, watching for drift rather than for crashes.
  async soak() {
    const site = await startStatic(PORT);
    try {
      const seconds = Number(process.env.P2P_SOAK_S) || 90;
      const { host, joiner } = await hostAndInvite(site.url);
      await host.click('#btn-start');
      await until('both kids', 10000, async () => (await peek(host)).hasMe && (await peek(joiner)).hasMe);
      await play(host);
      await play(joiner);
      for (const p of [host, joiner]) await p.evaluate(() => window.__ff.session.cmd('ready'));
      const heap = (p) => p.evaluate(() => performance.memory.usedJSHeapSize / 1048576);
      await wait(5000);
      const firstHeap = await heap(joiner);
      const worstLag = { value: 0 };
      const end = Date.now() + seconds * 1000;
      while (Date.now() < end) {
        await wait(1000);
        const [a, b] = await Promise.all([peek(host), peek(joiner)]);
        expect(a.connected && b.connected && !b.reconnecting, `dropped: ${JSON.stringify({ a: a.connected, b: b.connected })}`);
        worstLag.value = Math.max(worstLag.value, Math.abs(a.renderTick - b.renderTick));
        if (a.phase === 'build') for (const p of [host, joiner]) await p.evaluate(() => window.__ff.session.cmd('ready'));
      }
      const [a, b] = await Promise.all([peek(host), peek(joiner)]);
      const [fa, fb] = await Promise.all([fxCount(host), fxCount(joiner)]);
      const reconnects = await joiner.evaluate(() => window.__ff.session.reconnecting);
      note(`after ${seconds} s: wave ${a.wave}, tick ${Math.round(a.renderTick)}, joiner ping ${b.ping.toFixed(1)} ms, worst render gap between clients ${worstLag.value.toFixed(1)} ticks`);
      note(`heap ${firstHeap.toFixed(1)} -> ${(await heap(joiner)).toFixed(1)} MB; balls fx ${fa.ball}/${fb.ball}, hits ${fa.hit}/${fb.hit}, flee ${fa.flee}/${fb.flee}`);
      expect(!reconnects, 'no reconnect during the soak');
      expect(worstLag.value < 12, `clients drifted ${worstLag.value} ticks apart`);
      const drift = (k) => Math.abs((fa[k] ?? 0) - (fb[k] ?? 0));
      for (const k of ['ball', 'hit', 'flee', 'spawn', 'freeze', 'sAdd', 'sDel']) expect(drift(k) <= 3, `${k} differs: ${fa[k]} vs ${fb[k]}`);
      await joiner.context().close();
      await host.context().close();
    } finally {
      await site.close();
    }
  },

  async p2p() {
    const site = await startStatic(PORT);
    try {
      const { host, joiner } = await fullMatch(site.url, 'p2p');
      await host.close({ runBeforeUnload: false }).catch(() => {});
      const dialog = await until('the host-left dialog', 45000, async () => {
        const text = await joiner.evaluate(() => document.querySelector('#dialogs')?.innerText ?? '');
        return text.includes('The host left') ? text : null;
      });
      note(`host tab closed: joiner shows "${dialog.trim().split('\n')[0]}"`);
      await shot(joiner, 'p2p-hostleft-joiner');
      await joiner.context().close();

      const lost = await openGame(`${site.url}?join=ZZZZ`, 'lost');
      await until('the invite card', 6000, () => lost.isVisible('#btn-invite-join'));
      const t0 = Date.now();
      await lost.click('#btn-invite-join');
      const text = await until('the noRoom dialog', 10000, async () => {
        const t = await lost.evaluate(() => document.querySelector('#dialogs')?.innerText ?? '');
        return t.includes("Can't find room") ? t : null;
      });
      note(`bad code through the UI: "${text.trim().split('\n')[0]}" after ${Date.now() - t0} ms`);
      await lost.context().close();
    } finally {
      await site.close();
    }
  },

  async server() {
    const srv = await startServer({ port: PORT, host: '127.0.0.1', log: () => {} });
    try {
      const { host, joiner } = await fullMatch(`http://127.0.0.1:${srv.port}/`, 'server');
      await joiner.context().close();
      await host.context().close();
    } finally {
      await srv.close();
    }
  },

  async solo() {
    const site = await startStatic(PORT);
    try {
      const page = await openGame(site.url, 'solo');
      await until('Solo', 6000, () => page.isVisible('#btn-solo'));
      await page.click('#btn-solo');
      await until('the solo lobby', 8000, () => page.isVisible('#btn-start'));
      await page.click('#btn-start');
      await until('the match', 8000, async () => (await peek(page))?.hasMe);
      await play(page);
      await wait(3000);
      const s = await peek(page);
      note(`solo: tick ${Math.round(s.renderTick)}, ping ${s.ping.toFixed(1)} ms, moved to ${s.x.toFixed(0)},${s.y.toFixed(0)}`);
      expect(s.renderTick > 60, 'the worker room is ticking');
      await shot(page, 'solo-build');
      await page.context().close();
    } finally {
      await site.close();
    }
  },
};

const wanted = process.argv.slice(2);
browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: [...(process.env.P2P_DEFAULT_ICE ? [] : ['--disable-features=WebRtcHideLocalIpsWithMdns']), '--enable-precise-memory-info'],
});
let failed = false;
for (const [name, run] of Object.entries(runs)) {
  if (wanted.length && !wanted.includes(name)) continue;
  console.log(`\n== ${name}`);
  const t0 = Date.now();
  try {
    await run();
    console.log(`   PASS (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  } catch (err) {
    failed = true;
    console.log(`   FAIL: ${err.message}`);
    for (const c of browser.contexts()) await c.close().catch(() => {});
  }
}
await browser.close();
const unique = [...new Set(problems)];
console.log(`\nconsole problems: ${unique.length}`);
for (const line of unique.slice(0, 15)) console.log(`  ${line.slice(0, 240)}`);
process.exit(failed || unique.length ? 1 : 0);
