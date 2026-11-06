// The client side of server mode.
import { ERR } from '../../shared/schema.js';

const CONNECT_DEADLINE_MS = 10000;

export class WsTransport {
  constructor(url) {
    this.kind = 'ws';
    this.url = url;
    this.ws = null;
    this.onmessage = null;
    this.onclose = null;
  }

  connect() {
    return new Promise((resolve, reject) => {
      let opened = false;
      let settled = false;
      const fail = (code, msg) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this._drop();
        reject({ code, msg });
      };
      const timer = setTimeout(() => fail(ERR.TIMEOUT, 'The server did not answer'), CONNECT_DEADLINE_MS);
      let ws;
      try {
        ws = new WebSocket(this.url);
      } catch (err) {
        fail(ERR.NET, err.message);
        return;
      }
      this.ws = ws;
      ws.binaryType = 'arraybuffer';
      ws.onopen = () => {
        opened = true;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      ws.onmessage = (e) => this.onmessage?.(e.data);
      // onerror is always followed by onclose, which carries the real outcome.
      ws.onerror = () => {};
      ws.onclose = (e) => {
        if (!opened) {
          fail(ERR.NET, 'Could not reach the server');
          return;
        }
        this.ws = null;
        this.onclose?.(e.reason || 'closed');
      };
    });
  }

  send(data) {
    if (this.ws?.readyState === 1) this.ws.send(data);
  }

  close() {
    this._drop();
  }

  _drop() {
    const ws = this.ws;
    this.ws = null;
    if (!ws) return;
    ws.onopen = ws.onmessage = ws.onclose = null;
    try {
      ws.close();
    } catch {
      // Already closing; nothing left to release.
    }
  }
}
