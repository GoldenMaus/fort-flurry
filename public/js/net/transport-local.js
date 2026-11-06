// The transport to a Room running in this browser's own worker: Solo, and the local
// half of a P2P host.
import { ERR } from '../../shared/schema.js';

export const LOCAL_CONN = 'local';

// Owns the worker and its message bridge. Exported because the P2P host needs the same
// plumbing plus remote peers.
export class HostWorker {
  constructor({ onSend, onClose, onBeat, onError }) {
    this.worker = new Worker(new URL('./host-worker.js', import.meta.url), { type: 'module' });
    this.worker.onmessage = ({ data: m }) => {
      if (m.op === 'send') onSend(m.id, m.data);
      else if (m.op === 'close') onClose(m.id, m.reason);
      else if (m.op === 'beat') onBeat?.();
    };
    this.worker.onerror = (e) => onError(e.message || 'worker failed');
  }

  post(message, data) {
    this.worker.postMessage(message, data instanceof ArrayBuffer ? [data] : []);
  }

  send(id, data) {
    this.post({ op: 'data', id, data }, data);
  }

  terminate() {
    this.worker.terminate();
  }
}

export class LocalTransport {
  constructor(code) {
    this.kind = 'local';
    this.code = code;
    this.onmessage = null;
    this.onclose = null;
    this.host = null;
  }

  async connect() {
    try {
      this.host = new HostWorker({
        onSend: (id, data) => this.onmessage?.(data),
        onClose: (id, reason) => this._closed(reason),
        onError: (reason) => this._closed(reason),
      });
    } catch (err) {
      throw { code: ERR.NET, msg: `Could not start the game worker: ${err.message}` };
    }
    this.host.post({ op: 'init', code: this.code, solo: true });
    this.host.post({ op: 'open', id: LOCAL_CONN });
  }

  send(data) {
    this.host?.send(LOCAL_CONN, data);
  }

  setPaused(on) {
    this.host?.post({ op: 'pause', on: !!on });
  }

  close() {
    this.host?.terminate();
    this.host = null;
  }

  _closed(reason) {
    this.close();
    this.onclose?.(reason);
  }
}
