// Fort Flurry Node host: the secondary deployment. Serves public/, answers api/info and
// runs one Room per code. Every limit here exists because this process faces strangers;
// the Rooms themselves already distrust everything a conn sends.
import { randomBytes } from 'node:crypto';
import { createReadStream, realpathSync } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { Room } from '../public/shared/room.js';
import { CLOSE, ERR, GAME_NAME, MSG, PROTOCOL_VERSION } from '../public/shared/schema.js';
import {
  MAX_CONNS_PER_IP, MAX_INBOUND_BYTES, MAX_ROOMS, MAX_ROOMS_PER_IP,
} from '../public/shared/constants.js';
import { SEND, isValidCode, makeRoomCode, sendVerdict } from '../public/shared/protocol.js';

const PUBLIC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const ROOM_UPDATE_MS = 8;
const PING_EVERY_MS = 5000;
const PONG_DEADLINE_MS = 15000;
const NO_ROOM_LIMIT = 20;
const NO_ROOM_WINDOW_MS = 60000;
const NO_ROOM_BAN_MS = 5 * 60000;
const REFUSE_LINGER_MS = 250;
const CLOSE_CODE = 4000;

const MIME = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
});

// A wire-side conn for Room. Back-pressure lives here, not in Room, because only the
// transport can see what is stuck in the socket.
export function makeWsConn(id, ws, onSlow) {
  return {
    id,
    send(data) {
      if (ws.readyState !== 1) return;
      const verdict = sendVerdict(data, ws.bufferedAmount);
      if (verdict === SEND.OK) ws.send(data);
      else if (verdict === SEND.KILL) onSlow();
    },
    close(reason) {
      // Queued frames drain first, so the KICKED or CLOSED just sent still arrives.
      if (ws.readyState === 0 || ws.readyState === 1) ws.close(CLOSE_CODE, String(reason ?? '').slice(0, 64));
    },
  };
}

function lanAddress() {
  for (const list of Object.values(networkInterfaces())) {
    for (const net of list ?? []) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return null;
}

function send404(res) {
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not found');
}

function isInside(root, path) {
  return path === root || path.startsWith(root + sep);
}

async function serveStatic(req, res, root) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD', 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Method not allowed');
    return;
  }
  let pathname;
  try {
    pathname = decodeURIComponent(req.url.split(/[?#]/, 1)[0]);
  } catch {
    send404(res);
    return;
  }
  if (pathname.includes('\0')) {
    send404(res);
    return;
  }
  // The explicit containment check is the guard; resolve() alone happily walks out.
  let file = resolve(root, `.${pathname}`);
  if (!isInside(root, file)) {
    send404(res);
    return;
  }
  try {
    let info = await stat(file);
    if (info.isDirectory()) {
      file = join(file, 'index.html');
      info = await stat(file);
    }
    // Checked after stat as well, so a symlink cannot lead out of public/.
    const real = await realpath(file);
    if (!info.isFile() || !isInside(root, real)) {
      send404(res);
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
      'Content-Length': info.size,
      'X-Content-Type-Options': 'nosniff',
      // Plain ES modules with no content hashes: a stale cache means mismatched modules.
      'Cache-Control': 'no-cache',
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    const stream = createReadStream(file);
    stream.on('error', () => res.destroy());
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  } catch {
    send404(res);
  }
}

export async function startServer({
  port = 3000, host, trustProxy = false, publicDir = PUBLIC_DIR, log = console.log, GameClass,
  pingEveryMs = PING_EVERY_MS, pongDeadlineMs = PONG_DEADLINE_MS,
} = {}) {
  const root = realpathSync(publicDir);
  const rooms = new Map();
  const connsByIp = new Map();
  const roomsByIp = new Map();
  const noRoomByIp = new Map();
  const bannedUntil = new Map();
  const sockets = new Set();
  let nextConnId = 1;

  const bump = (map, key, by) => {
    const n = (map.get(key) ?? 0) + by;
    if (n > 0) map.set(key, n);
    else map.delete(key);
  };

  const clientIp = (req) => {
    if (trustProxy) {
      const forwarded = req.headers['x-forwarded-for'];
      if (typeof forwarded === 'string' && forwarded.length) return forwarded.split(',')[0].trim();
    }
    return req.socket.remoteAddress ?? 'unknown';
  };

  const info = () => {
    let players = 0;
    for (const room of rooms.values()) players += room.humanCount;
    const lan = lanAddress();
    return {
      game: GAME_NAME,
      version: PROTOCOL_VERSION,
      rooms: rooms.size,
      players,
      lanUrl: lan ? `http://${lan}:${server.address().port}/` : null,
    };
  };

  const server = createServer((req, res) => {
    const path = req.url.split(/[?#]/, 1)[0];
    if (path.endsWith('/api/info') && (req.method === 'GET' || req.method === 'HEAD')) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(info()));
      return;
    }
    serveStatic(req, res, root).catch(() => res.destroy());
  });

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_INBOUND_BYTES,
    // Compression costs CPU per frame and opens a decompression-bomb path for ~100 byte messages.
    perMessageDeflate: false,
  });

  const refuse = (ws, code, msg) => {
    ws.on('error', () => {});
    ws.send(JSON.stringify({ t: MSG.ERROR, code, msg }));
    ws.close(CLOSE_CODE, code);
    // A refused socket must not sit around for the full close handshake timeout.
    setTimeout(() => ws.terminate(), REFUSE_LINGER_MS).unref();
  };

  const noteNoRoom = (ip, now) => {
    const hits = (noRoomByIp.get(ip) ?? []).filter((t) => now - t < NO_ROOM_WINDOW_MS);
    hits.push(now);
    noRoomByIp.set(ip, hits);
    if (hits.length >= NO_ROOM_LIMIT) {
      bannedUntil.set(ip, now + NO_ROOM_BAN_MS);
      noRoomByIp.delete(ip);
    }
  };

  const createRoom = (ip) => {
    let code;
    do {
      code = makeRoomCode(() => randomBytes(4).readUInt32LE(0) / 2 ** 32);
    } while (rooms.has(code));
    const room = new Room({
      code,
      GameClass,
      now: () => performance.now(),
      randomHex: (bytes) => randomBytes(bytes).toString('hex'),
      log: (...args) => log(`[room ${code}]`, ...args),
      onEmpty: () => {
        rooms.delete(code);
        bump(roomsByIp, ip, -1);
      },
    });
    rooms.set(code, room);
    bump(roomsByIp, ip, 1);
    return room;
  };

  const accept = (ws, req, url) => {
    const ip = clientIp(req);
    const now = Date.now();
    const ban = bannedUntil.get(ip);
    if (ban !== undefined && ban > now) return refuse(ws, ERR.RATE, 'Too many bad room codes. Try again soon.');
    if (ban !== undefined) bannedUntil.delete(ip);
    if ((connsByIp.get(ip) ?? 0) >= MAX_CONNS_PER_IP) return refuse(ws, ERR.SERVER_FULL, 'Too many connections');

    let room;
    if (url.searchParams.has('create')) {
      if (rooms.size >= MAX_ROOMS || (roomsByIp.get(ip) ?? 0) >= MAX_ROOMS_PER_IP) {
        return refuse(ws, ERR.SERVER_FULL, 'Too many rooms');
      }
      room = createRoom(ip);
    } else {
      const code = (url.searchParams.get('room') ?? '').toUpperCase();
      room = isValidCode(code) ? rooms.get(code) : undefined;
      if (!room) {
        noteNoRoom(ip, now);
        return refuse(ws, ERR.NO_ROOM, 'No such room');
      }
    }

    const id = nextConnId;
    nextConnId += 1;
    ws.binaryType = 'arraybuffer';
    ws.lastPong = performance.now();
    bump(connsByIp, ip, 1);
    sockets.add(ws);
    const conn = makeWsConn(id, ws, () => {
      // Nothing can be flushed through a full pipe, so skip the close handshake. The
      // client sees a plain drop, reconnects, and catches up with FULL.
      ws.terminate();
    });
    ws.on('message', (data, isBinary) => room.onData(id, isBinary ? data : data.toString()));
    ws.on('pong', () => {
      ws.lastPong = performance.now();
    });
    // ws closes the socket itself after an oversized or invalid frame; this only keeps
    // the error from becoming an uncaught exception.
    ws.on('error', (err) => log('socket error', err.message));
    ws.on('close', () => {
      sockets.delete(ws);
      bump(connsByIp, ip, -1);
      room.dropConn(id);
    });
    room.addConn(conn);
    return undefined;
  };

  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => {});
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      socket.destroy();
      return;
    }
    if (!url.pathname.endsWith('/ws')) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => accept(ws, req, url));
  });

  const updateTimer = setInterval(() => {
    const now = performance.now();
    for (const [code, room] of rooms) {
      try {
        room.update(now);
      } catch (err) {
        // One broken match must not take every other room down with the process.
        log(`[room ${code}] update failed`, err);
        room.destroy(CLOSE.NET_LOST);
        if (rooms.has(code)) room.onEmpty();
      }
    }
  }, ROOM_UPDATE_MS);

  const pingTimer = setInterval(() => {
    const now = performance.now();
    for (const ws of sockets) {
      if (now - ws.lastPong > pongDeadlineMs) ws.terminate();
      else if (ws.readyState === 1) ws.ping();
    }
  }, pingEveryMs);

  // Keyed by whoever connects, so without this an address-rotating client grows them forever.
  const sweepTimer = setInterval(() => {
    const now = Date.now();
    for (const [ip, until] of bannedUntil) if (until <= now) bannedUntil.delete(ip);
    for (const [ip, hits] of noRoomByIp) if (now - hits[hits.length - 1] >= NO_ROOM_WINDOW_MS) noRoomByIp.delete(ip);
  }, NO_ROOM_WINDOW_MS);
  sweepTimer.unref();

  await new Promise((done, fail) => {
    server.once('error', fail);
    server.listen(port, host, () => {
      server.off('error', fail);
      done();
    });
  });

  return {
    port: server.address().port,
    rooms,
    server,
    wss,
    async close() {
      clearInterval(updateTimer);
      clearInterval(pingTimer);
      clearInterval(sweepTimer);
      for (const room of rooms.values()) room.destroy(CLOSE.HOST_LEFT);
      rooms.clear();
      for (const ws of sockets) ws.terminate();
      wss.close();
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
    },
  };
}

const launchedDirectly = process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (launchedDirectly) {
  const started = await startServer({
    port: Number(process.env.PORT) || 3000,
    host: process.env.HOST || undefined,
    trustProxy: process.env.TRUST_PROXY === '1',
  });
  console.log(`${GAME_NAME} is up on http://localhost:${started.port}/`);
}
