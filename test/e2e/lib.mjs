// Shared plumbing for the end-to-end run: a real Chrome, strict error capture, and helpers that
// drive the game the way a player does, with real mouse and keyboard events on the real page.
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { AFLAG } from '../../public/shared/schema.js';

export const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(HERE, '..', '..');
export const ARTIFACTS = process.env.E2E_ARTIFACTS || join(HERE, 'artifacts');
export const SERVER_PORT = Number(process.env.E2E_SERVER_PORT) || 8110;
export const STATIC_PORT = Number(process.env.E2E_STATIC_PORT) || 8111;

export const wait = (ms) => new Promise((done) => { setTimeout(done, ms); });

export async function until(what, ms, check, every = 100) {
  const start = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - start > ms) throw new Error(`timed out after ${ms} ms waiting for ${what}`);
    await wait(every);
  }
}

export function expect(cond, msg) {
  if (!cond) throw new Error(msg);
}

export function launch() {
  return chromium.launch({
    channel: 'chrome',
    headless: true,
    args: [
      // Two pages on one machine can't resolve each other's mDNS candidates. Test-only, and
      // without it the real broker path still works but no direct connection forms.
      '--disable-features=WebRtcHideLocalIpsWithMdns',
      '--enable-precise-memory-info',
    ],
  });
}

// Every console error and page error fails the run, unless the caller named that exact
// message in advance. Nothing is filtered silently: allowed lines are counted and printed.
export class Problems {
  constructor() {
    this.list = [];
    this.allowed = new Map();
    this.warnings = new Map();
    this.pages = new Set();
    this.inCheck = false;
    this.closing = new Set();
  }

  // Pages closed during a check wait for its end, so a failure can still photograph them.
  async closeDeferred() {
    for (const page of this.closing) await page.context().close().catch(() => {});
    this.closing.clear();
  }

  warn(line) { this.warnings.set(line, (this.warnings.get(line) ?? 0) + 1); }

  add(line) { this.list.push(line); }

  allow(line) { this.allowed.set(line, (this.allowed.get(line) ?? 0) + 1); }

  take() {
    const out = [...new Set(this.list)];
    this.list.length = 0;
    return out;
  }
}

export async function openPage(browser, url, label, problems, opts = {}) {
  const context = await browser.newContext({
    viewport: opts.viewport ?? { width: 1280, height: 720 },
    deviceScaleFactor: opts.dpr ?? 1,
    ...(opts.context ?? {}),
  });
  const page = await context.newPage();
  page.label = label;
  page.isTouch = !!opts.context?.hasTouch;
  page.problems = problems;
  problems.pages.add(page);
  page.on('close', () => problems.pages.delete(page));
  const isAllowed = opts.allow ?? (() => false);
  page.on('pageerror', (e) => problems.add(`${label} pageerror: ${e.message}\n${e.stack ?? ''}`));
  page.on('console', (m) => {
    if (m.type() !== 'error' && m.type() !== 'warning') return;
    const line = `${label} console.${m.type()}: ${m.text()} @ ${m.location().url}`;
    if (isAllowed(m)) problems.allow(line);
    else if (m.type() === 'error') problems.add(line);
    else problems.warn(line);
  });
  page.on('crash', () => problems.add(`${label} page crashed`));
  page.on('response', (r) => {
    if (r.status() < 400) return;
    const line = `${label} HTTP ${r.status()} ${r.url()}`;
    if (isAllowed({ text: () => line, location: () => ({ url: r.url() }), status: r.status() })) problems.allow(line);
    else problems.add(line);
  });
  if (opts.init) await page.addInitScript(opts.init);
  await page.goto(url);
  await page.waitForFunction('window.__ff !== undefined');
  return page;
}

export async function closePage(page) {
  if (page.problems.inCheck) page.problems.closing.add(page);
  else await page.context().close().catch(() => {});
}

export async function shot(page, name) {
  mkdirSync(ARTIFACTS, { recursive: true });
  const path = join(ARTIFACTS, `${name}.png`);
  await page.screenshot({ path });
  return path;
}

// Everything a check might want to know, in one round trip.
export const peek = (page) => page.evaluate(() => {
  const ff = window.__ff;
  const s = ff.session;
  if (!s) return { hasSession: false, screen: ff.ui.current };
  const v = s.view;
  const kinds = {};
  for (const a of v.actors) kinds[a.kind] = (kinds[a.kind] ?? 0) + 1;
  const structKinds = {};
  for (const st of v.structs) structKinds[st.kind] = (structKinds[st.kind] ?? 0) + 1;
  return {
    hasSession: true,
    screen: ff.ui.current,
    state: ff.app.state,
    me: s.me,
    code: s.roomCode,
    connected: s.connected,
    reconnecting: s.reconnecting,
    inMatch: s.inMatch,
    ping: s.ping,
    isHost: s.isHost,
    offer: s.offer,
    result: s.result,
    mode: v.mode,
    mapId: v.mapId,
    phase: v.phase,
    wave: v.wave,
    waveCount: v.waveCount,
    secondsLeft: v.secondsLeft,
    renderTick: v.renderTick,
    hasMe: !!v.me,
    x: v.me?.x,
    y: v.me?.y,
    meFlags: v.me?.flags,
    actors: v.actors.length,
    kinds,
    structs: v.structs.length,
    structKinds,
    balls: v.balls.length,
    pickups: v.pickups.length,
    foesLeft: v.meta?.foesLeft,
    flakes: v.meta?.flakes,
    boss: v.meta?.boss,
    blizzard: v.blizzard,
    dayT: v.dayT,
    colonels: v.meta?.colonels,
    you: v.you ? { balls: v.you.balls, warmth: v.you.warmth, frozenT: v.you.frozenT } : null,
    players: v.players.size,
    cards: v.meta?.cards?.[s.me] ?? [],
    scores: v.meta?.scores,
    fps: ff.renderer.stats?.fps,
  };
});

// The nearest thing worth throwing at, and where it is on screen.
export const target = (page) => page.evaluate((untouchable) => {
  const ff = window.__ff;
  const v = ff.session?.view;
  const me = v?.me;
  if (!me) return null;
  let best = null;
  let bestD = Infinity;
  for (const a of v.actors) {
    if (a.id === me.id || a.team === me.team) continue;
    if (a.flags & untouchable) continue;
    const d = Math.hypot(a.x - me.x, a.y - me.y);
    if (d < bestD) { bestD = d; best = a; }
  }
  if (!best) return null;
  const p = ff.renderer.worldToScreen(best.x, best.y);
  const c = ff.renderer.worldToScreen(me.x, me.y);
  // Throws go along the aim, so the cursor only needs the direction. Keeping it near the kid stops
  // a click meant for a foe off behind the HUD from pressing a HUD button instead.
  const px = p.x - c.x;
  const py = p.y - c.y;
  const reach = Math.min(1, 170 / (Math.hypot(px, py) || 1));
  return { id: best.id, kind: best.kind, x: best.x, y: best.y, dist: bestD, sx: c.x + px * reach, sy: c.y + py * reach, mex: me.x, mey: me.y };
}, AFLAG.FLEEING | AFLAG.GRACE | AFLAG.FROZEN);

export const screenOf = (page, x, y) => page.evaluate(([wx, wy]) => window.__ff.renderer.worldToScreen(wx, wy), [x, y]);

// Moves the real mouse onto a world point, following it until the camera has stopped easing.
export async function pointAt(page, x, y) {
  let p = await screenOf(page, x, y);
  for (let i = 0; i < 30; i += 1) {
    await page.mouse.move(p.x, p.y);
    await wait(50);
    const q = await screenOf(page, x, y);
    const still = Math.hypot(q.x - p.x, q.y - p.y) < 0.5;
    p = q;
    if (still) break;
  }
  return p;
}

export async function clickWorld(page, x, y, opts = {}) {
  await pointAt(page, x, y);
  await page.mouse.down({ button: opts.button ?? 'left' });
  await wait(opts.hold ?? 60);
  await page.mouse.up({ button: opts.button ?? 'left' });
}

// A phone is driven with taps, or the game rightly decides a mouse has been plugged in.
export const press = (page, selector) => (page.isTouch ? page.tap(selector) : page.click(selector));

// The lobby, set up by clicking the same buttons a host clicks.
export async function setupLobby(page, { mode, map, difficulty, length, bots = 0 } = {}) {
  await until('the lobby', 15000, () => page.isVisible('#btn-start'));
  const pick = async (selector) => {
    await press(page, selector);
    await until(`${selector} to take`, 4000, () => page.evaluate((sel) => document.querySelector(sel)?.getAttribute('aria-checked') === 'true', selector));
  };
  if (mode) await pick(`.setup-panel .seg-btn[data-value="${mode}"]`);
  if (map) await pick(`.map-btn[data-map="${map}"]`);
  if (length !== undefined) await pick(`.setup-panel .seg-btn[data-value="${length}"]`);
  for (let i = 0; i < bots; i += 1) {
    const before = await page.evaluate(() => window.__ff.session.lobby.players.length);
    // Face-Off has one add button per team, so the bot goes to whichever side is shorter.
    const side = await page.evaluate(() => {
      const cols = [...document.querySelectorAll('.team-col')];
      if (cols.length < 2) return 0;
      const size = (col) => col.querySelectorAll('.kid-card[data-player]').length;
      return size(cols[1]) < size(cols[0]) ? 1 : 0;
    });
    await press(page, `.add-card >> nth=${side}`);
    await until('the bot to appear', 4000, () => page.evaluate((n) => window.__ff.session.lobby.players.length === n + 1, before));
  }
  // Last, because outside Siege this control only appears once there are bots.
  if (difficulty) await pick(`.setup-panel .seg-btn[data-value="${difficulty}"]`);
}

export async function startMatch(page) {
  await until('Start to enable', 5000, () => page.evaluate(() => !document.querySelector('#btn-start').disabled));
  await press(page, '#btn-start');
  await until('the match screen', 15000, async () => {
    const s = await peek(page);
    return s.inMatch && s.screen === 'match' && s.hasMe;
  });
}

export async function goSolo(page) {
  await until('Play Solo', 5000, () => page.isVisible('#btn-solo'));
  await press(page, '#btn-solo');
}

// Keeps a log inside the page of what the session reports, so two clients can be compared later.
// Survives the session changing, because it re-attaches to whichever one is current.
export const installRecorder = (page) => page.evaluate(() => {
  if (window.__rec) return;
  const rec = { counts: {}, events: [], ballsSeen: new Set(), frames: 0, worstGap: 0, last: 0, startedAt: performance.now() };
  window.__rec = rec;
  const attach = () => {
    const s = window.__ff.session;
    if (!s || s.__recorded) return;
    s.__recorded = true;
    s.on('fx', (ev) => {
      rec.counts[ev.e] = (rec.counts[ev.e] ?? 0) + 1;
      if (['ball', 'freeze', 'thaw', 'respawn', 'sAdd', 'card', 'banner'].includes(ev.e)) rec.events.push({ ...ev });
      if (rec.events.length > 4000) rec.events.splice(0, 2000);
    });
  };
  const frame = (now) => {
    attach();
    rec.frames += 1;
    if (rec.last) rec.worstGap = Math.max(rec.worstGap, now - rec.last);
    rec.last = now;
    for (const b of window.__ff.session?.view?.balls ?? []) rec.ballsSeen.add(b.id);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
});

export const recorded = (page) => page.evaluate(() => {
  const r = window.__rec;
  const fps = r.frames / ((performance.now() - r.startedAt) / 1000);
  return { counts: r.counts, events: r.events, ballsSeen: [...r.ballsSeen], frames: r.frames, worstGap: r.worstGap, fps };
});

// How many strongly coloured pixels the last rendered frame holds in a box around a world point.
// Snow is pale, so this tells a drawn kid or foe from bare ground. It reads through a small copy
// so the game canvas itself never gets a readback.
export const inkAt = (page, x, y, w = 44, h = 64, lift = 30) => page.evaluate(([wx, wy, bw, bh, up]) => {
  const c = document.getElementById('game');
  const p = window.__ff.renderer.worldToScreen(wx, wy);
  const zoom = window.__ff.renderer.zoom ?? 1;
  const k = c.width / c.clientWidth;
  const sw = bw * zoom;
  const sh = bh * zoom;
  const sx = p.x - sw / 2;
  const sy = p.y - up * zoom - sh / 2;
  if (sx + sw < 0 || sy + sh < 0 || sx > c.clientWidth || sy > c.clientHeight) return { onScreen: false, ink: 0 };
  const off = new OffscreenCanvas(Math.max(1, Math.round(bw)), Math.max(1, Math.round(bh)));
  const ctx = off.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(c, sx * k, sy * k, sw * k, sh * k, 0, 0, off.width, off.height);
  const d = ctx.getImageData(0, 0, off.width, off.height).data;
  let ink = 0;
  for (let i = 0; i < d.length; i += 4) {
    const hi = Math.max(d[i], d[i + 1], d[i + 2]);
    const lo = Math.min(d[i], d[i + 1], d[i + 2]);
    if (hi - lo > 70 || hi < 110) ink += 1;
  }
  return { onScreen: true, ink, total: d.length / 4, sx, sy };
}, [x, y, w, h, lift]);

export const actorOf = (page, id) => page.evaluate((who) => {
  const a = window.__ff.session?.view.actors.find((it) => it.id === who);
  return a ? { id: a.id, kind: a.kind, team: a.team, x: a.x, y: a.y, flags: a.flags, hp: a.hp } : null;
}, id);

// The next waypoint on a walkable route, found by BFS over the client's own collision grid.
const routeStep = (page, tx, ty) => page.evaluate(([gx, gy]) => {
  const v = window.__ff.session?.view;
  const me = v?.me;
  if (!me || !v.cw) return null;
  const { cw } = v;
  const key = (cx, cy) => cy * 4096 + cx;
  const start = cw.cellOf(me.x, me.y);
  const goal = cw.cellOf(gx, gy);
  const prev = new Map([[key(start.cx, start.cy), null]]);
  const queue = [[start.cx, start.cy]];
  let found = false;
  for (let i = 0; i < queue.length && i < 6000 && !found; i += 1) {
    const [cx, cy] = queue[i];
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (prev.has(key(nx, ny)) || cw.isSolidCell(nx, ny)) continue;
      prev.set(key(nx, ny), [cx, cy]);
      if (nx === goal.cx && ny === goal.cy) { found = true; break; }
      queue.push([nx, ny]);
    }
  }
  if (!found) return { x: gx, y: gy, mex: me.x, mey: me.y };
  let cell = [goal.cx, goal.cy];
  const path = [cell];
  while (prev.get(key(cell[0], cell[1]))) {
    cell = prev.get(key(cell[0], cell[1]));
    path.unshift(cell);
  }
  const hop = path[Math.min(2, path.length - 1)];
  const last = hop[0] === goal.cx && hop[1] === goal.cy;
  return { x: last ? gx : (hop[0] + 0.5) * 40, y: last ? gy : (hop[1] + 0.5) * 40, mex: me.x, mey: me.y };
}, [tx, ty]);

// Holds WASD through a set of real key events, changing only what differs from the last call.
export class Keys {
  constructor(page) {
    this.page = page;
    this.held = new Set();
  }

  async set(want) {
    for (const k of [...this.held]) {
      if (!want.has(k)) { await this.page.keyboard.up(k); this.held.delete(k); }
    }
    for (const k of want) {
      if (!this.held.has(k)) { await this.page.keyboard.down(k); this.held.add(k); }
    }
  }

  async towards(dx, dy) {
    const len = Math.hypot(dx, dy) || 1;
    const want = new Set();
    if (dx / len > 0.38) want.add('KeyD');
    if (dx / len < -0.38) want.add('KeyA');
    if (dy / len > 0.38) want.add('KeyS');
    if (dy / len < -0.38) want.add('KeyW');
    await this.set(want);
  }

  release() { return this.set(new Set()).catch(() => {}); }
}

export async function walkTo(page, x, y, { near = 24, ms = 15000 } = {}) {
  const keys = new Keys(page);
  const start = Date.now();
  try {
    for (;;) {
      const step = await routeStep(page, x, y);
      if (!step) { await wait(100); continue; }
      if (Math.hypot(x - step.mex, y - step.mey) <= near) return true;
      if (Date.now() - start > ms) return false;
      await keys.towards(step.x - step.mex, step.y - step.mey);
      await wait(50);
    }
  } finally {
    await keys.release();
  }
}

// A plain player: walks at the nearest foe with WASD, aims with the mouse, and holds and releases
// the left button to throw. Every action is a real input event. Runs until stop() says so.
export async function playLoop(page, { stop, onTick, every = 120, reach = 300 } = {}) {
  const keys = new Keys(page);
  try {
    for (;;) {
      const s = await peek(page);
      if (await stop(s)) return s;
      if (onTick) await onTick(s);
      const t = s.screen === 'match' && s.hasMe ? await target(page) : null;
      if (!t) { await keys.release(); await wait(every); continue; }
      if (t.dist > reach) {
        const step = await routeStep(page, t.x, t.y);
        if (step) await keys.towards(step.x - step.mex, step.y - step.mey);
      } else {
        await keys.release();
      }
      await page.mouse.move(t.sx, t.sy);
      if (t.dist < 520 && s.you?.balls > 0 && !(s.meFlags & AFLAG.FROZEN)) {
        await page.mouse.down();
        await wait(Math.min(420, 80 + t.dist));
        const again = await target(page);
        if (again) await page.mouse.move(again.sx, again.sy);
        await page.mouse.up();
      }
      await wait(every);
    }
  } finally {
    await keys.release();
  }
}
