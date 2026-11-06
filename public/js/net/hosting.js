// Chooses how this page connects. A connectFn returns a fresh, unconnected transport each
// call, which is what lets Session retry without knowing what it is talking to.
import { GAME_NAME } from '../../shared/schema.js';
import { makeRoomCode } from '../../shared/protocol.js';
import { LocalTransport } from './transport-local.js';
import { WsTransport } from './transport-ws.js';
import { P2PClientTransport, P2PHostTransport } from './transport-p2p.js';

const DETECT_TIMEOUT_MS = 2000;

let detected = null;

async function probe() {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), DETECT_TIMEOUT_MS);
  try {
    const res = await fetch('api/info', { signal: abort.signal, cache: 'no-store' });
    if (!res.ok) return 'p2p';
    const info = await res.json();
    return info?.game === GAME_NAME ? 'server' : 'p2p';
  } catch {
    // Static hosts answer 404 or an HTML fallback page; either way there is no server.
    return 'p2p';
  } finally {
    clearTimeout(timer);
  }
}

export function detectMode() {
  detected ??= probe();
  return detected;
}

function wsUrl(query) {
  const url = new URL('ws', location.href);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.search = query;
  url.hash = '';
  return url.href;
}

export function soloConnect() {
  return () => new LocalTransport(makeRoomCode(Math.random));
}

// Session passes the room code back on a retry: a host who lost the socket must rejoin
// the room it made, not create another.
export function hostConnect(mode) {
  if (mode === 'server') return (code) => new WsTransport(wsUrl(code ? `room=${code}` : 'create=1'));
  return () => new P2PHostTransport();
}

export function joinConnect(mode, code) {
  const room = String(code).toUpperCase();
  if (mode === 'server') return () => new WsTransport(wsUrl(`room=${room}`));
  return () => new P2PClientTransport(room);
}
