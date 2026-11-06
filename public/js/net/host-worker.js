// Runs the Room off the main thread, for solo and for a P2P host. Worker timers keep
// firing while the tab is in the background, which is the whole reason this is a worker:
// a desktop host can alt-tab and the match keeps its pace.
import { Room } from '../../shared/room.js';

const UPDATE_MS = 1000 / 60;
const BEAT_MS = 1000;
const MAX_LOGGED_FAILURES = 5;

let room = null;
let failures = 0;

function randomHex(bytes) {
  const raw = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(raw, (b) => b.toString(16).padStart(2, '0')).join('');
}

function makeConn(id) {
  return {
    id,
    send(data) {
      self.postMessage({ op: 'send', id, data }, data instanceof ArrayBuffer ? [data] : []);
    },
    close(reason) {
      self.postMessage({ op: 'close', id, reason });
    },
  };
}

function update() {
  if (!room) return;
  try {
    room.update(performance.now());
  } catch (err) {
    // A throw costs one tick, not the room: players can still chat and leave cleanly.
    // A broken sim fails every tick, though, and 30 stack traces a second helps nobody.
    failures += 1;
    if (failures <= MAX_LOGGED_FAILURES) console.error('Room update failed', err);
  }
}

self.onmessage = ({ data: m }) => {
  switch (m.op) {
    case 'init':
      room = new Room({
        code: m.code,
        solo: !!m.solo,
        now: () => performance.now(),
        randomHex,
        log: (...args) => console.warn('[room]', ...args),
        onEmpty: () => {
          room = null;
        },
      });
      setInterval(update, UPDATE_MS);
      setInterval(() => self.postMessage({ op: 'beat' }), BEAT_MS);
      break;
    case 'open':
      room?.addConn(makeConn(m.id));
      break;
    case 'data':
      room?.onData(m.id, m.data);
      break;
    case 'close':
      room?.dropConn(m.id);
      break;
    case 'pause':
      room?.setPaused(m.on);
      break;
    default:
      break;
  }
};
