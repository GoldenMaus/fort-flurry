// The two claims the shorter drivers cannot reach: a real match played all the way to
// results and Play Again over P2P, and a host that keeps the match running while its tab is
// truly hidden. Takes a few minutes and needs the internet for the broker.
//   node test/p2p-endgame.mjs [hiddenHost|endgame ...]      with no names, runs both
import { chromium } from 'playwright-core';
import { startStatic } from './p2p-static.mjs';

const PORT = Number(process.env.P2P_PORT) || 8106;
const ICE_ARG = '--disable-features=WebRtcHideLocalIpsWithMdns';

const note = (...args) => console.log('   ', ...args);
const expect = (cond, msg) => { if (!cond) throw new Error(msg); };
const wait = (ms) => new Promise((done) => setTimeout(done, ms));

async function until(what, ms, check) {
  const start = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - start > ms) throw new Error(`timed out after ${ms} ms waiting for ${what}`);
    await wait(200);
  }
}

const peek = (page) => page.evaluate(() => {
  const s = window.__ff.session;
  if (!s) return null;
  const v = s.view;
  return {
    me: s.me, code: s.roomCode, connected: s.connected, reconnecting: s.reconnecting, inMatch: s.inMatch, ping: s.ping,
    isHost: s.isHost, phase: v.phase, renderTick: v.renderTick, hasMe: !!v.me, players: v.players.size, result: s.result,
    secondsLeft: v.secondsLeft,
  };
});

async function openGame(context, url) {
  const page = await context.newPage();
  await page.goto(url);
  await page.waitForFunction('window.__ff !== undefined');
  return page;
}

async function hostAndInvite(browser, base) {
  const host = await openGame(await browser.newContext({ viewport: { width: 1024, height: 640 } }), base);
  await until('Host to enable', 6000, () => host.evaluate(() => !document.querySelector('#btn-host')?.disabled));
  await host.click('#btn-host');
  const code = await until('a room code', 15000, async () => (await peek(host))?.code);
  const joiner = await openGame(await browser.newContext({ viewport: { width: 1024, height: 640 } }), `${base}?join=${code}`);
  await until('the invite card', 6000, () => joiner.isVisible('#btn-invite-join'));
  await joiner.click('#btn-invite-join');
  await until('two in the lobby', 15000, async () => (await peek(joiner))?.players === 2);
  return { host, joiner, code };
}

const scenarios = {
  // Headless Chrome cannot truly hide a tab, so this reproduces what Chrome does to a hidden
  // page, installed before the app loads: main-thread timers drop to once a second,
  // requestAnimationFrame stops, and the app is told through the real visibilitychange path.
  // Workers are exempt, which is exactly the claim under test: a Room on the main thread
  // would fall to about 5 ticks a second here (5 per update, the rest discarded).
  async hiddenHost(site) {
    const browser = await chromium.launch({ channel: 'chrome', headless: true, args: [ICE_ARG] });
    try {
      const context = await browser.newContext({ viewport: { width: 1024, height: 640 } });
      await context.addInitScript(() => {
        const tab = { hidden: false };
        window.fakeTab = tab;
        const realInterval = window.setInterval.bind(window);
        const realTimeout = window.setTimeout.bind(window);
        const realFrame = window.requestAnimationFrame.bind(window);
        window.setInterval = (fn, ms, ...args) => {
          let last = 0;
          return realInterval(() => {
            const now = performance.now();
            if (tab.hidden && now - last < 1000) return;
            last = now;
            fn(...args);
          }, ms);
        };
        window.setTimeout = (fn, ms, ...args) => realTimeout(fn, tab.hidden ? Math.max(ms ?? 0, 1000) : ms, ...args);
        window.requestAnimationFrame = (fn) => realFrame(function frame(t) {
          if (tab.hidden) realFrame(frame);
          else fn(t);
        });
        tab.set = (hidden) => {
          tab.hidden = hidden;
          Object.defineProperty(document, 'hidden', { value: hidden, configurable: true });
          Object.defineProperty(document, 'visibilityState', { value: hidden ? 'hidden' : 'visible', configurable: true });
          document.dispatchEvent(new Event('visibilitychange'));
        };
      });
      const host = await openGame(context, site.url);
      await until('Host to enable', 6000, () => host.evaluate(() => !document.querySelector('#btn-host')?.disabled));
      await host.click('#btn-host');
      const code = await until('a room code', 15000, async () => (await peek(host))?.code);
      const joiner = await openGame(await browser.newContext({ viewport: { width: 1024, height: 640 } }), `${site.url}?join=${code}`);
      await until('the invite card', 6000, () => joiner.isVisible('#btn-invite-join'));
      await joiner.click('#btn-invite-join');
      await until('two in the lobby', 15000, async () => (await peek(joiner))?.players === 2);
      await host.click('#btn-start');
      await until('both kids', 10000, async () => (await peek(host)).hasMe && (await peek(joiner)).hasMe);

      await host.evaluate(() => {
        window.timerFires = 0;
        setInterval(() => { window.timerFires += 1; }, 50);
        window.fakeTab.set(true);
      });
      await wait(1500);
      const t0 = await peek(joiner);
      await host.evaluate(() => { window.timerFires = 0; });
      const started = Date.now();
      await wait(12000);
      const t1 = await peek(joiner);
      const fires = await host.evaluate(() => window.timerFires);
      const seconds = (Date.now() - started) / 1000;
      const rate = (t1.renderTick - t0.renderTick) / seconds;
      note(`over ${seconds.toFixed(1)} s "hidden": host main-thread 50 ms timer fired ${(fires / seconds).toFixed(1)} times/s (20 when visible)`);
      note(`joiner saw the match advance at ${rate.toFixed(1)} ticks/s (30 is full speed), connected ${t1.connected}`);
      expect(fires / seconds < 2, `timers were not throttled (${(fires / seconds).toFixed(1)}/s), so this proves nothing`);
      expect(rate > 27, `the match slowed to ${rate.toFixed(1)} ticks/s`);
      expect(t1.connected && !t1.reconnecting, 'the joiner stayed connected');

      await host.evaluate(() => window.fakeTab.set(false));
      await wait(1500);
      const back = await peek(host);
      expect(back.connected && back.hasMe && Math.abs(back.renderTick - (await peek(joiner)).renderTick) < 12, 'the host caught up after returning');
      note('back in front: host view caught straight up with the joiner');
    } finally {
      await browser.close();
    }
  },

  async endgame(site) {
    const browser = await chromium.launch({ channel: 'chrome', headless: true, args: [ICE_ARG] });
    try {
      const { host, joiner } = await hostAndInvite(browser, site.url);
      const firstFx = [];
      await host.evaluate(() => {
        const s = window.__ff.session;
        s.lobbyOp('set', { settings: { mode: 'ffa' } });
        s.lobbyOp('addBot');
        s.lobbyOp('addBot');
      });
      await until('4 kids', 5000, async () => (await peek(joiner)).players === 4);
      await host.click('#btn-start');
      await until('both kids', 10000, async () => (await peek(host)).hasMe && (await peek(joiner)).hasMe);
      const startTick = (await peek(joiner)).renderTick;
      note(`Free-for-All started at tick ${Math.round(startTick)}, ${(await peek(host)).secondsLeft?.toFixed(0)} s on the first clock`);

      // A real ending, no shortcuts: first to the freeze target, or the 180 s clock.
      const results = await until('RESULT on both clients', 230000, async () => {
        const [a, b] = await Promise.all([peek(host), peek(joiner)]);
        expect(a.connected && b.connected, 'a client dropped during the match');
        return a.result && b.result ? [a.result, b.result] : null;
      });
      const [ra, rb] = results;
      expect(JSON.stringify(ra) === JSON.stringify(rb), 'both clients got the same result');
      note(`match ended: "${ra.summary}", winners ${JSON.stringify(ra.winners)}, ${ra.players.length} players scored`);
      await until('the results screen', 8000, () => host.isVisible('#btn-play-again'));
      const waiting = await until('the joiner wait line', 8000, () => joiner.evaluate(() => {
        const el = document.querySelector('#results-wait');
        return el && !el.hidden && el.textContent ? el.textContent : null;
      }));
      expect(!(await joiner.isVisible('#btn-play-again')), 'only the host gets Play Again');
      note(`host sees Play Again, joiner sees "${waiting}"`);
      firstFx.push(await joiner.evaluate(() => window.__ff.session.view.renderTick));

      await host.click('#btn-play-again');
      await until('the rematch', 12000, async () => {
        const [a, b] = await Promise.all([peek(host), peek(joiner)]);
        return a.inMatch && b.inMatch && a.hasMe && b.hasMe && !a.result && !b.result && b.renderTick < firstFx[0];
      });
      note('Play Again: RETURN then START crossed P2P, new match running on both clients');
    } finally {
      await browser.close();
    }
  },
};

const wanted = process.argv.slice(2);
const site = await startStatic(PORT);
let failed = false;
for (const [name, run] of Object.entries(scenarios)) {
  if (wanted.length && !wanted.includes(name)) continue;
  console.log(`\n== ${name}`);
  const t0 = Date.now();
  try {
    await run(site);
    console.log(`   PASS (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  } catch (err) {
    failed = true;
    console.log(`   FAIL: ${err.message}`);
  }
}
await site.close();
process.exit(failed ? 1 : 0);
