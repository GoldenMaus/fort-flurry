// Proof that P2P works where it has to: real Chrome, a static site with no api/info, and
// the real PeerJS cloud broker. Not part of `npm test`, because it needs the internet.
//   node test/p2p-chrome.mjs [scenario ...]      with no names, runs them all
import { chromium } from 'playwright-core';
import { startStatic } from './p2p-static.mjs';

const PORT = Number(process.env.P2P_PORT) || 8101;
const results = [];
const consoleProblems = [];
let site;
let browser;

const note = (...args) => console.log('   ', ...args);
const fail = (msg) => { throw new Error(msg); };
const expect = (cond, msg) => { if (!cond) fail(msg); };

async function openPage() {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on('pageerror', (e) => consoleProblems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !m.text().includes('favicon') && !m.text().includes('404')) consoleProblems.push(`console.error: ${m.text()}`);
  });
  await page.goto(`${site.url}p2p-harness.html`);
  await page.waitForFunction('window.ffReady === true');
  return page;
}

const closeAll = async (...pages) => {
  for (const p of pages) await p?.context().close().catch(() => {});
};

const state = (page) => page.evaluate(() => window.ff.state());

// Polls from Node rather than the page: the page under test may be hung or crashed.
async function until(what, ms, check) {
  const start = Date.now();
  for (;;) {
    const value = await check();
    if (value) return { value, ms: Date.now() - start };
    if (Date.now() - start > ms) fail(`timed out after ${ms} ms waiting for ${what}`);
    await new Promise((done) => setTimeout(done, 100));
  }
}

async function hostAndJoin(hostName = 'Hana', joinName = 'Joe') {
  const host = await openPage();
  const joiner = await openPage();
  const room = await host.evaluate((n) => window.ff.host(n), hostName);
  const joined = await joiner.evaluate(([c, n]) => window.ff.join(c, n), [room.code, joinName]);
  expect(joined.ok, `join failed: ${JSON.stringify(joined)}`);
  return { host, joiner, room, joined };
}

const scenarios = {
  async basics() {
    const host = await openPage();
    const started = Date.now();
    const mode = await host.evaluate(() => window.ff.detectMode());
    expect(mode === 'p2p', `detectMode said ${mode}`);
    note(`detectMode -> p2p in ${Date.now() - started} ms`);

    const t0 = Date.now();
    const room = await host.evaluate(() => window.ff.host('Hana'));
    expect(room.kind === 'p2pHost' && /^[BCDFGHJKMNPQRSTVWXZ]{4}$/.test(room.code), JSON.stringify(room));
    expect(room.me === 1, 'host is player 1');
    note(`room ${room.code} created in ${Date.now() - t0} ms`);

    const joiner = await openPage();
    const joined = await joiner.evaluate(([c]) => window.ff.join(c, 'Joe'), [room.code]);
    expect(joined.ok && joined.kind === 'p2p' && joined.me === 2, JSON.stringify(joined));
    note(`joined by code in ${joined.ms} ms`);

    const lower = await openPage();
    const low = await lower.evaluate(([c]) => window.ff.join(c, 'Lou'), [room.code.toLowerCase()]);
    expect(low.ok, `lowercase code: ${JSON.stringify(low)}`);

    await until('three in the lobby', 5000, async () => (await state(host)).players?.length === 3);
    expect((await state(joiner)).isHost === false, 'joiner is not host');
    expect((await state(host)).isHost === true, 'host is host');

    // lobby sync, both directions
    await host.evaluate(() => window.ff.lobbyOp('set', { settings: { mapId: 'pond', difficulty: 'cozy' } }));
    await until('settings to reach the joiner', 3000, async () => (await state(joiner)).settings?.mapId === 'pond');
    await joiner.evaluate(() => window.ff.lobbyOp('me', { name: 'Joey', ready: true, look: { hat: 3 } }));
    await until('me op to reach the host', 3000, async () => {
      const p = (await state(host)).players?.find((x) => x.id === 2);
      return p?.name === 'Joey' && p.ready === true && p.look.hat === 3;
    });
    await host.evaluate(() => window.ff.lobbyOp('addBot'));
    await until('the bot to reach everyone', 3000, async () => (await state(lower)).players?.some((p) => p.isBot));
    await joiner.evaluate(() => window.ff.chat('hi from the joiner'));
    await until('chat to reach the host', 3000, () => host.evaluate(() => window.ff.eventsNamed('chat').some((e) => e.data.text === 'hi from the joiner')));
    note('lobby sync, ME ops, bots and chat all crossed the data channels');
    await closeAll(host, joiner, lower);
  },

  async badCode() {
    const joiner = await openPage();
    const bad = await joiner.evaluate(() => window.ff.join('ZZZZ', 'Lost'));
    expect(!bad.ok && bad.code === 'noRoom', JSON.stringify(bad));
    expect(bad.ms < 10000, `noRoom took ${bad.ms} ms`);
    note(`bad code -> noRoom in ${bad.ms} ms`);
    const closed = await joiner.evaluate(() => window.ff.eventsNamed('closed').length);
    expect(closed === 0, 'a failed start must not emit closed');
    await closeAll(joiner);
  },

  async chunks() {
    const { host, joiner } = await hostAndJoin();
    await joiner.evaluate(() => window.ff.captureRaw());
    await host.evaluate(() => {
      window.ff.sendBig(0, `{"t":"nothing","pad":"${'\u{1F9E3}snow'.repeat(9000)}"}`);
      window.ff.sendBigBinary(0, 200000);
      window.ff.sendBig(0, 'small after big');
    });
    const raw = await until('reassembled messages', 8000, async () => {
      const seen = await joiner.evaluate(() => window.rawSeen);
      return seen?.length >= 3 ? seen : null;
    });
    const [text, bin, small] = raw.value;
    const wantText = `{"t":"nothing","pad":"${'\u{1F9E3}snow'.repeat(9000)}"}`;
    expect(text.type === 'text' && text.length === wantText.length, `text arrived as ${JSON.stringify(text)}`);
    expect(text.head === wantText.slice(0, 16) && text.tail === wantText.slice(-16), 'text survived, multi-byte splits included');
    let sum = 0;
    for (let i = 0; i < 200000; i++) sum = (sum + ((i * 7) & 255)) & 0xffffff;
    expect(bin.type === 'binary' && bin.length === 200000 && bin.sum === sum, `binary arrived as ${JSON.stringify(bin)}`);
    expect(small.type === 'text' && small.length === 15, 'a small message follows in order');
    note(`${text.length} char text (${new TextEncoder().encode(wantText).length} bytes) and 200000 byte binary reassembled in order in ${raw.ms} ms`);
    expect((await state(joiner)).connected === true, 'the conn survived');
    await closeAll(host, joiner);
  },

  async match() {
    const { host, joiner, room } = await hostAndJoin();
    await host.evaluate(() => window.ff.lobbyOp('start'));
    await until('both in the match', 8000, async () => (await state(host)).inMatch && (await state(joiner)).inMatch);
    await until('own kids', 8000, async () => (await state(host)).hasMe && (await state(joiner)).hasMe);
    const before = await state(joiner);
    await joiner.evaluate(() => window.ff.setFrame({ mx: 0, my: 1, aim: 1.57, btn: 0, tx: 0, ty: 0 }));
    await until('the joiner to move', 5000, async () => Math.abs((await state(joiner)).y - before.y) > 40);
    await joiner.evaluate(() => window.ff.setFrame({ mx: 0, my: 0, aim: 1.57, btn: 0, tx: 0, ty: 0 }));
    await new Promise((done) => setTimeout(done, 800));
    const a = await state(joiner);
    note(`joiner ping ${a.ping?.toFixed(1)} ms, actors ${a.actors}, renderTick ${a.renderTick?.toFixed(1)}, phase ${a.phase}`);
    expect(a.connected && a.actors >= 2, JSON.stringify(a));

    // A third player arriving during the match gets the full late-join service.
    const late = await openPage();
    const joined = await late.evaluate(([c]) => window.ff.join(c, 'Late'), [room.code]);
    expect(joined.ok, JSON.stringify(joined));
    await until('late joiner in the match', 8000, async () => (await state(late)).inMatch);
    note('late joiner served LOBBY_STATE, START and FULL over a real data channel');
    await closeAll(host, joiner, late);
  },

  async hostCloses() {
    for (const how of ['tab close', 'navigation']) {
      const { host, joiner } = await hostAndJoin();
      await new Promise((done) => setTimeout(done, 300));
      const t0 = Date.now();
      if (how === 'tab close') await host.close({ runBeforeUnload: true });
      else await host.goto('about:blank');
      const closed = await until('closed event', 40000, async () => {
        const list = await joiner.evaluate(() => window.ff.eventsNamed('closed'));
        return list.length ? list : null;
      });
      expect(closed.value.length === 1 && closed.value[0].data.reason === 'hostLeft', JSON.stringify(closed.value));
      const retried = await joiner.evaluate(() => window.ff.eventsNamed('reconnecting').length);
      note(`${how}: joiner saw hostLeft ${Date.now() - t0} ms later, retries before that: ${retried}`);
      await closeAll(host, joiner);
    }
  },

  async peerCrash() {
    const { host, joiner, room, joined } = await hostAndJoin();
    await host.evaluate(() => window.ff.lobbyOp('start'));
    await until('both in the match', 8000, async () => (await state(joiner)).inMatch);
    await until('the joiner kid', 8000, async () => (await state(joiner)).hasMe);
    const cdp = await joiner.context().newCDPSession(joiner);
    const t0 = Date.now();
    cdp.send('Page.crash').catch(() => {});
    const seen = await until('the host to notice', 16000, async () => {
      const p = (await state(host)).players?.find((x) => x.id === joined.me);
      return p?.connected === false;
    });
    const took = Date.now() - t0;
    note(`joiner renderer crashed: host marked it disconnected after ${took} ms (no close event from PeerJS, liveness rule)`);
    expect(took > 8000 && took < 13000, `expected about 10 s, got ${took}`);
    expect(seen.value, 'unreachable');

    const back = await openPage();
    const again = await back.evaluate(([c, t]) => window.ff.join(c, 'Joe', t), [room.code, joined.token]);
    expect(again.ok && again.me === joined.me && again.token === joined.token, JSON.stringify(again));
    await until('the reclaimed slot', 5000, async () => (await state(host)).players?.find((x) => x.id === joined.me)?.connected === true);
    await until('the resync', 8000, async () => (await state(back)).inMatch && (await state(back)).hasMe);
    note(`reconnect with the token reclaimed slot ${again.me} in ${again.ms} ms and resynced mid-match`);
    const startEvents = await back.evaluate(() => window.ff.eventsNamed('start').length);
    expect(startEvents === 1, 'a fresh page does see one start');
    await closeAll(host, joiner, back);
  },

  async hostCrash() {
    const { host, joiner } = await hostAndJoin();
    await host.evaluate(() => window.ff.lobbyOp('start'));
    await until('the joiner kid', 8000, async () => (await state(joiner)).hasMe);
    const cdp = await host.context().newCDPSession(host);
    const t0 = Date.now();
    cdp.send('Page.crash').catch(() => {});
    const hiccup = await until('the hiccup', 8000, async () => {
      const s = await state(joiner);
      return s.connected === false && s.reconnecting === false;
    });
    note(`host renderer crashed: hiccup after ${Date.now() - t0} ms`);
    expect(hiccup.ms > 2500, `hiccup came too soon, ${hiccup.ms}`);
    await until('reconnecting', 14000, async () => (await state(joiner)).reconnecting === true);
    note(`watchdog started reconnecting after ${Date.now() - t0} ms`);
    const closed = await until('closed', 60000, async () => {
      const list = await joiner.evaluate(() => window.ff.eventsNamed('closed'));
      return list.length ? list : null;
    });
    expect(closed.value.length === 1 && closed.value[0].data.reason === 'hostLeft', JSON.stringify(closed.value));
    const attempts = await joiner.evaluate(() => {
      const { events } = window.ff;
      const firstRetry = events.find((e) => e.name === 'reconnecting').at;
      return events.filter((e) => e.name === 'reconnecting' || e.name === 'closed').map((e) => `${e.name === 'closed' ? 'closed' : `#${e.data.attempt}`}@${((e.at - firstRetry) / 1000).toFixed(1)}s`);
    });
    note(`joiner ended with hostLeft ${Date.now() - t0} ms after the crash; retry timeline ${attempts.join(' ')}`);
    await closeAll(host, joiner);
  },

  async cleanReconnect() {
    const { host, joiner, room, joined } = await hostAndJoin();
    await until('host sees joiner', 4000, async () => (await state(host)).players?.length === 2);
    // Drop only the joiner's page: the transport close is the fast path.
    await joiner.goto('about:blank');
    await until('host sees the drop', 5000, async () => (await state(host)).players?.find((x) => x.id === joined.me)?.connected === false);
    await joiner.goto(`${site.url}p2p-harness.html`);
    await joiner.waitForFunction('window.ffReady === true');
    const again = await joiner.evaluate(([c, t]) => window.ff.join(c, 'Joe', t), [room.code, joined.token]);
    expect(again.ok && again.me === joined.me, JSON.stringify(again));
    await until('connected again', 5000, async () => (await state(host)).players?.find((x) => x.id === joined.me)?.connected === true);
    expect((await state(host)).players.length === 2, 'no duplicate slot');
    note(`a page reload with the token reclaimed slot ${again.me} in ${again.ms} ms`);
    await closeAll(host, joiner);
  },

  async broker() {
    const { host, joiner, room } = await hostAndJoin();
    const before = await host.evaluate(() => window.ff.brokerState());
    await host.evaluate(() => window.ff.dropBroker());
    await until('invitesPaused', 3000, async () => (await state(host)).netStatus === 'invitesPaused');
    const t0 = Date.now();
    await until('the broker to return', 15000, async () => {
      const s = await state(host);
      const b = await host.evaluate(() => window.ff.brokerState());
      return s.netStatus === 'ok' && b.open;
    });
    const after = await host.evaluate(() => window.ff.brokerState());
    expect(after.id === before.id, `id changed: ${before.id} -> ${after.id}`);
    note(`host broker socket dropped: invitesPaused, then back on the same id after ${Date.now() - t0} ms`);
    expect((await state(joiner)).connected === true, 'the joiner never noticed');

    // Invites work again, so the code really was reclaimed at the broker.
    const third = await openPage();
    const joined = await third.evaluate(([c]) => window.ff.join(c, 'Third'), [room.code]);
    expect(joined.ok, `join after broker return: ${JSON.stringify(joined)}`);

    // A joiner's broker socket dropping must change nothing at all.
    await joiner.evaluate(() => window.ff.dropBroker());
    await new Promise((done) => setTimeout(done, 1500));
    const s = await state(joiner);
    expect(s.connected && !s.reconnecting, JSON.stringify(s));
    await joiner.evaluate(() => window.ff.chat('still here'));
    await until('chat after broker loss', 3000, () => host.evaluate(() => window.ff.eventsNamed('chat').some((e) => e.data.text === 'still here')));
    note('joiner broker socket dropped: data channel unaffected');
    await closeAll(host, joiner, third);
  },

  // A long broker outage. Nothing in the running game may care, the retries must follow
  // the 1, 2, 4, 8, 15 schedule, and invites must come back on the same code afterwards.
  async brokerOutage() {
    const { host, joiner, room } = await hostAndJoin();
    await host.evaluate(() => window.ff.watchReconnects());
    await host.context().setOffline(true);
    const dropped = await host.evaluate(() => {
      window.ff.dropBroker();
      return Math.round(performance.now());
    });
    await until('invitesPaused', 3000, async () => (await state(host)).netStatus === 'invitesPaused');
    await until('five failed retries', 40000, async () => (await host.evaluate(() => window.reconnectTimes.length)) >= 5);
    const times = await host.evaluate(() => window.reconnectTimes);
    const gaps = times.map((t, i) => (t - (i ? times[i - 1] : dropped)) / 1000);
    note(`broker retries at gaps of ${gaps.map((g) => g.toFixed(1)).join(', ')} s (spec: 1, 2, 4, 8, 15)`);
    [1, 2, 4, 8, 15].forEach((want, i) => expect(Math.abs(gaps[i] - want) < 1.6, `retry ${i} after ${gaps[i]} s, wanted ${want}`));
    expect((await state(host)).netStatus === 'invitesPaused', 'still paused');
    expect((await state(joiner)).connected === true, 'the match does not depend on the broker');
    await joiner.evaluate(() => window.ff.chat('through the outage'));
    await until('chat during the outage', 3000, () => host.evaluate(() => window.ff.eventsNamed('chat').some((e) => e.data.text === 'through the outage')));
    await host.context().setOffline(false);
    const back = await until('the broker to return', 20000, async () => {
      const b = await host.evaluate(() => window.ff.brokerState());
      return (await state(host)).netStatus === 'ok' && b.open ? b : null;
    });
    note(`back online: reclaimed ${back.value.id} ${back.ms} ms later`);
    const third = await openPage();
    const joined = await third.evaluate(([c]) => window.ff.join(c, 'Third'), [room.code]);
    expect(joined.ok, `join after the outage: ${JSON.stringify(joined)}`);
    await closeAll(host, joiner, third);
  },

  // No network at all. Both ends must fail fast with the code the UI words as "can't reach
  // the online service", which also offers Play Solo.
  async offline() {
    const host = await openPage();
    await host.evaluate(() => window.ff.trackPeers());
    await host.context().setOffline(true);
    const started = Date.now();
    const hosted = await host.evaluate(() => window.ff.host('Hana').then((r) => ({ ok: true, r }), (e) => ({ ok: false, code: e.code })));
    expect(!hosted.ok && hosted.code === 'net', JSON.stringify(hosted));
    note(`hosting offline: rejected ${hosted.code} after ${Date.now() - started} ms`);
    const joiner = await openPage();
    await joiner.evaluate(() => window.ff.trackPeers());
    await joiner.context().setOffline(true);
    const joined = await joiner.evaluate(() => window.ff.join('BCDF', 'Joe'));
    expect(!joined.ok && joined.code === 'net', JSON.stringify(joined));
    note(`joining offline: rejected ${joined.code} after ${joined.ms} ms`);
    expect((await host.evaluate(() => window.ff.livePeers())) === 0, 'host left a Peer behind');
    expect((await joiner.evaluate(() => window.ff.livePeers())) === 0, 'joiner left a Peer behind');
    await closeAll(host, joiner);
  },

  async hostile() {
    const host = await openPage();
    const room = await host.evaluate(() => window.ff.host('Hana'));
    const evil = await openPage();
    const connect = (options) => evil.evaluate(([c, o]) => window.ff.rawConnect(c, o), [room.code, options]);
    const rawState = (i) => evil.evaluate((n) => window.ff.rawState(n), i);
    const raw = { reliable: true, serialization: 'raw' };
    const settled = (i, want, ms = 12000) => until(`raw peer ${i} to be ${want}`, ms, async () => (await rawState(i)).state === want);

    // wrong serialization: refused at once, so it never opens
    const wrong = await connect({ reliable: true, serialization: 'binary' });
    await new Promise((done) => setTimeout(done, 2500));
    expect((await rawState(wrong)).state !== 'open' || (await host.evaluate(() => window.ff.remotes().length)) === 0, 'binary serialization must be refused');
    expect((await host.evaluate(() => window.ff.remotes().length)) === 0, 'nothing registered for it');
    note('wrong serialization refused');

    // a chunk frame sent to the host
    const chunker = await connect(raw);
    await settled(chunker, 'open');
    await evil.evaluate((i) => window.ff.rawSend(i, 'chunk'), chunker);
    await settled(chunker, 'closed');
    note('BIN.CHUNK sent to the host: conn closed');

    // over the size cap
    const huge = await connect(raw);
    await settled(huge, 'open');
    await evil.evaluate((i) => window.ff.rawSend(i, 'huge', 5000), huge);
    await settled(huge, 'closed');
    const hugeBin = await connect(raw);
    await settled(hugeBin, 'open');
    await evil.evaluate((i) => window.ff.rawSend(i, 'hugeBinary', 5000), hugeBin);
    await settled(hugeBin, 'closed');
    note('oversized text and binary: conn closed before reaching the worker');

    // first message not HELLO
    const rude = await connect(raw);
    await settled(rude, 'open');
    await evil.evaluate((i) => window.ff.rawSend(i, 'garbage'), rude);
    await settled(rude, 'closed');
    const got = (await rawState(rude)).got.join('');
    expect(got.includes('badMsg'), `expected ERROR badMsg first, got ${got}`);
    note('garbage as a first message: ERROR badMsg arrived before the close (flush rule works)');

    // silent conns: a fifth with no HELLO is refused, and the HELLO deadline clears them
    const silent = [];
    for (let i = 0; i < 4; i++) {
      const n = await connect(raw);
      silent.push(n);
      await settled(n, 'open');
    }
    const fifth = await connect(raw);
    await new Promise((done) => setTimeout(done, 2500));
    expect((await rawState(fifth)).state !== 'open', 'a fifth conn with no HELLO must be refused');
    note('fifth conn with no HELLO refused');
    await Promise.all(silent.map((n) => settled(n, 'closed', 9000)));
    note('silent conns closed by the 5 s HELLO deadline');
    const sixth = await connect(raw);
    await settled(sixth, 'open');
    note('capacity came back after they closed');

    const honest = await openPage();
    const joined = await honest.evaluate(([c]) => window.ff.join(c, 'Fine'), [room.code]);
    expect(joined.ok, `honest join after the attacks: ${JSON.stringify(joined)}`);
    expect((await state(host)).players.length === 2, 'host intact');
    await closeAll(host, evil, honest);
  },

  // What a phone does to a hidden tab: every line of JS stops while the network stack
  // stays up, so nothing reports a close. Pausing in the debugger stops the same things.
  async frozenTab() {
    const { host, joiner, joined } = await hostAndJoin();
    await host.evaluate(() => window.ff.lobbyOp('start'));
    await until('the joiner kid', 8000, async () => (await state(joiner)).hasMe);
    const cdp = await joiner.context().newCDPSession(joiner);
    await cdp.send('Debugger.enable');
    const paused = new Promise((done) => cdp.once('Debugger.paused', done));
    await cdp.send('Debugger.pause');
    await paused;
    const t0 = Date.now();
    await until('the host to drop the suspended client', 16000, async () => (await state(host)).players?.find((x) => x.id === joined.me)?.connected === false);
    const took = Date.now() - t0;
    note(`suspended tab: host dropped it after ${took} ms`);
    expect(took > 8000 && took < 13000, `expected about 10 s, got ${took}`);
    await new Promise((done) => setTimeout(done, 1000));
    await cdp.send('Debugger.resume');
    await cdp.send('Debugger.disable');
    const t1 = Date.now();
    await until('the client to come back on its own', 30000, async () => (await state(host)).players?.find((x) => x.id === joined.me)?.connected === true);
    await until('in sync again', 10000, async () => {
      const s = await state(joiner);
      return s.connected && !s.reconnecting && s.hasMe;
    });
    const s = await state(joiner);
    expect(s.me === joined.me, 'same slot');
    note(`resumed tab reconnected by itself and reclaimed slot ${s.me} in ${Date.now() - t1} ms`);
    await closeAll(host, joiner);
  },

  async backpressure() {
    const { host, joiner, joined } = await hostAndJoin();
    await host.evaluate(() => window.ff.lobbyOp('start'));
    await until('the joiner kid', 8000, async () => (await state(joiner)).hasMe);
    await joiner.evaluate(() => window.ff.captureRaw());

    // Over SNAP_DROP_BYTES: a snapshot is skipped, JSON still queues.
    const buffered = await host.evaluate(() => {
      window.ff.sendBig(0, 'y'.repeat(120000));
      const amount = window.ff.bufferedAmount(0);
      window.ff.sendFakeSnapshot(0);
      window.ff.sendBig(0, 'json after the skipped snapshot');
      return amount;
    });
    note(`bufferedAmount right after a 120000 byte send: ${buffered}`);
    expect(buffered > 32768, 'the buffer must be over SNAP_DROP_BYTES for this to mean anything');
    const seen = await until('messages after the skip', 5000, async () => {
      const list = await joiner.evaluate(() => window.rawSeen);
      const i = list.findIndex((m) => m.head === 'json after the s');
      return i >= 0 ? list.slice(0, i + 1) : null;
    });
    expect(seen.value.every((m) => !(m.type === 'binary' && m.length === 11)), 'the snapshot was skipped');
    note('over SNAP_DROP_BYTES: snapshot skipped, the JSON behind it delivered');

    // Over CONN_KILL_BYTES: the conn dies and the client comes back through FULL.
    await host.evaluate(() => {
      window.ff.sendBig(0, 'z'.repeat(1200000));
      window.ff.sendBig(0, 'this send finds the buffer full');
    });
    await until('the kill', 6000, async () => (await state(joiner)).reconnecting || (await joiner.evaluate(() => window.ff.eventsNamed('reconnecting').length)) > 0);
    await until('the client to return', 15000, async () => {
      const s = await state(joiner);
      return s.connected && !s.reconnecting && s.hasMe;
    });
    const hostView = (await state(host)).players.find((x) => x.id === joined.me);
    expect(hostView.connected, 'same slot, connected');
    note('over CONN_KILL_BYTES: conn closed, client reconnected and resynced by itself');
    await closeAll(host, joiner);
  },

  async lifecycle() {
    // The host leaves through the menu.
    {
      const { host, joiner } = await hostAndJoin();
      await host.evaluate(() => window.ff.leave());
      const closed = await until('hostLeft', 8000, async () => {
        const list = await joiner.evaluate(() => window.ff.eventsNamed('closed'));
        return list.length ? list : null;
      });
      expect(closed.value[0].data.reason === 'hostLeft', JSON.stringify(closed.value));
      note(`host Leave: joiner got hostLeft in ${closed.ms} ms`);
      await closeAll(host, joiner);
    }
    // A joiner leaves: LEAVE must beat the channel teardown, so the slot goes at once.
    {
      const { host, joiner } = await hostAndJoin();
      await until('two players', 4000, async () => (await state(host)).players?.length === 2);
      await joiner.evaluate(() => window.ff.leave());
      await until('the slot to go at once', 3000, async () => (await state(host)).players?.length === 1);
      note('joiner Leave: slot removed at once (no 60 s grace, so LEAVE arrived)');
      await closeAll(host, joiner);
    }
    // Kick: KICKED arrives before the close, the token is refused afterwards.
    {
      const { host, joiner, room, joined } = await hostAndJoin();
      await host.evaluate((id) => window.ff.lobbyOp('kick', { id }), joined.me);
      const closed = await until('kicked', 6000, async () => {
        const list = await joiner.evaluate(() => window.ff.eventsNamed('closed'));
        return list.length ? list : null;
      });
      expect(closed.value[0].data.reason === 'kicked', JSON.stringify(closed.value));
      const again = await openPage();
      const refused = await again.evaluate(([c, t]) => window.ff.join(c, 'Back', t), [room.code, joined.token]);
      expect(!refused.ok && refused.code === 'kicked', JSON.stringify(refused));
      note('kick: KICKED delivered, and the same token is refused on the way back in');
      await closeAll(host, joiner, again);
    }
    // A second tab with the token replaces the first.
    {
      const { host, joiner, room, joined } = await hostAndJoin();
      const tab = await openPage();
      const second = await tab.evaluate(([c, t]) => window.ff.join(c, 'Joe', t), [room.code, joined.token]);
      expect(second.ok && second.me === joined.me, JSON.stringify(second));
      const closed = await until('replaced', 6000, async () => {
        const list = await joiner.evaluate(() => window.ff.eventsNamed('closed'));
        return list.length ? list : null;
      });
      expect(closed.value[0].data.reason === 'replaced', JSON.stringify(closed.value));
      note('second tab: the first was told replaced, the slot moved');
      await closeAll(host, joiner, tab);
    }
  },

  async codeCollision() {
    // PeerJS draws from Math.random while loading, so load it first or the stub is off by one.
    const fixed = [0.51, 0.52, 0.53, 0.54];
    const first = await openPage();
    await first.evaluate(() => window.ff.trackPeers());
    await first.evaluate((v) => window.ff.stubRandom(v), fixed);
    const a = await first.evaluate(() => window.ff.host('First'));
    const second = await openPage();
    await second.evaluate(() => window.ff.trackPeers());
    await second.evaluate((v) => window.ff.stubRandom(v), fixed);
    const b = await second.evaluate(() => window.ff.host('Second'));
    expect(a.code === 'NNPP', `the stub should force NNPP, got ${a.code}`);
    expect(b.code !== a.code, `both got ${a.code}`);
    const peers = await second.evaluate(() => window.madePeers.length);
    const alive = await second.evaluate(() => window.ff.livePeers());
    expect(peers === 2 && alive === 1, `second page made ${peers} Peers, ${alive} alive`);
    note(`second host drew the taken code ${a.code}, its Peer died with unavailable-id, the retry claimed ${b.code}`);
    const joiner = await openPage();
    const joined = await joiner.evaluate(([c]) => window.ff.join(c, 'Joe'), [b.code]);
    expect(joined.ok, JSON.stringify(joined));
    await closeAll(first, second, joiner);
  },

  async cancelHosting() {
    const page = await openPage();
    await page.evaluate(() => window.ff.trackPeers());
    const outcome = await page.evaluate(() => window.ff.hostThenCancel());
    expect(outcome !== 'resolved', 'a cancelled start must reject');
    await new Promise((done) => setTimeout(done, 1500));
    const live = await page.evaluate(() => window.ff.livePeers());
    expect(live === 0, `${live} Peer still alive after the cancel`);
    note(`leave during host startup: start rejected (${outcome}), no Peer left behind`);
    await closeAll(page);
  },

  async mediaCall() {
    const host = await openPage();
    const room = await host.evaluate(() => window.ff.host('Hana'));
    const evil = await openPage();
    await evil.evaluate(([c]) => window.ff.rawConnect(c, { reliable: true, serialization: 'raw' }), [room.code]);
    await until('raw conn', 8000, async () => (await evil.evaluate(() => window.ff.rawState(0))).state === 'open');
    await evil.evaluate(([c]) => window.ff.rawCall(c), [room.code]);
    await new Promise((done) => setTimeout(done, 2500));
    expect((await state(host)).connected === true, 'a media call does nothing to the host');
    note('media call: refused without disturbing the room');
    await closeAll(host, evil);
  },

  async full() {
    const host = await openPage();
    const room = await host.evaluate(() => window.ff.host('Hana'));
    const peers = [];
    for (let i = 0; i < 3; i++) {
      const p = await openPage();
      const r = await p.evaluate(([c, n]) => window.ff.join(c, n), [room.code, `Kid${i}`]);
      expect(r.ok, JSON.stringify(r));
      peers.push(p);
    }
    await host.evaluate(() => { for (let i = 0; i < 4; i++) window.ff.lobbyOp('addBot'); });
    await until('8 kids', 4000, async () => (await state(peers[2])).players?.length === 8);
    const extra = await openPage();
    const r = await extra.evaluate(([c]) => window.ff.join(c, 'Bumped'), [room.code]);
    expect(r.ok, JSON.stringify(r));
    await until('a bot replaced', 4000, async () => {
      const players = (await state(host)).players;
      return players.length === 8 && players.filter((p) => p.isBot).length === 3;
    });
    note('a 5th human replaced the newest bot');
    await host.evaluate(() => window.ff.lobbyOp('start'));
    const all = [host, ...peers, extra];
    await until('all five in the match', 10000, async () => {
      const states = await Promise.all(all.map(state));
      return states.every((s) => s.inMatch && s.hasMe);
    });
    await new Promise((done) => setTimeout(done, 5000));
    const states = await Promise.all(all.map(state));
    for (const s of states) expect(s.connected && s.actors >= 8, `after 5 s: ${JSON.stringify({ c: s.connected, a: s.actors })}`);
    note(`5 humans + 3 bots ran 5 s: pings ${states.map((s) => s.ping.toFixed(1)).join(', ')} ms; renderTicks ${states.map((s) => Math.round(s.renderTick)).join(', ')}`);
    await closeAll(...all);
  },

  async relay() {
    const probe = await openPage();
    for (const server of ['turn:eu-0.turn.peerjs.com:3478', 'turn:us-0.turn.peerjs.com:3478', 'turn:eu-0.turn.peerjs.com:3478?transport=tcp', 'turn:us-0.turn.peerjs.com:3478?transport=tcp']) {
      const r = await probe.evaluate(([s]) => window.ff.probeTurn(s, 6), [server]);
      note(`TURN probe ${server}: ${r.relayCandidates} relay candidates; errors ${JSON.stringify(r.errors.slice(0, 2))}`);
    }
    await closeAll(probe);

    const host = await openPage();
    const joiner = await openPage();
    await host.evaluate(() => window.ff.relayOnly());
    await joiner.evaluate(() => window.ff.relayOnly());
    const room = await host.evaluate(() => window.ff.host('Hana'));
    const joined = await joiner.evaluate(([c]) => window.ff.join(c, 'Joe'), [room.code]);
    note(`relay-only join result: ${JSON.stringify(joined)}`);
    if (joined.ok) {
      const pair = await joiner.evaluate(() => window.ff.selectedPair());
      note(`selected candidate pair: ${JSON.stringify(pair)}`);
      const s = await until('ping over the relay', 6000, async () => {
        const st = await state(joiner);
        return st.ping > 0 ? st : null;
      });
      note(`ping over relay: ${s.value.ping.toFixed(1)} ms`);
    }
    await closeAll(host, joiner);
    return joined.ok ? 'bundled TURN relay WORKS' : `bundled TURN relay DOES NOT WORK today (${joined.code})`;
  },
};

async function main() {
  const wanted = process.argv.slice(2);
  site = await startStatic(PORT);
  // Two pages on one machine stand in for two machines. Chrome hides host candidates behind
  // mDNS names, and where mDNS cannot resolve (this includes sandboxed CI) the pages then
  // have no path to each other at all. P2P_DEFAULT_ICE=1 keeps Chrome's stock behavior.
  const args = process.env.P2P_DEFAULT_ICE ? [] : ['--disable-features=WebRtcHideLocalIpsWithMdns'];
  browser = await chromium.launch({ channel: 'chrome', headless: true, args });
  console.log(`static site ${site.url}, Chrome ${browser.version()}`);
  for (const [name, run] of Object.entries(scenarios)) {
    if (wanted.length && !wanted.includes(name)) continue;
    console.log(`\n== ${name}`);
    const t0 = Date.now();
    try {
      // A scenario that measures rather than asserts, like the relay probe, returns its finding.
      const finding = await run();
      results.push({ name, ok: true, finding });
      console.log(`   ${finding ? `FINDING: ${finding}` : 'PASS'} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
    } catch (err) {
      results.push({ name, ok: false, error: err.message });
      console.log(`   FAIL: ${err.message}`);
      for (const c of browser.contexts()) await c.close().catch(() => {});
    }
  }
  await browser.close();
  await site.close();
  console.log('\n== summary');
  for (const r of results) console.log(`${r.finding ? 'INFO' : r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.finding ? `: ${r.finding}` : r.ok ? '' : `: ${r.error}`}`);
  const noise = [...new Set(consoleProblems)];
  console.log(`console problems: ${noise.length}`);
  for (const line of noise.slice(0, 20)) console.log(`  ${line.slice(0, 200)}`);
  process.exit(results.every((r) => r.ok) ? 0 : 1);
}

await main();
