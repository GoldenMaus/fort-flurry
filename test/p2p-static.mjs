// The deployment P2P mode is built for: public/ on a dumb static host. Deliberately no
// api/info, so detectMode must land on 'p2p' the way it does on GitHub Pages. The harness
// page is overlaid at the site root so its relative imports match the real site.
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC = resolve(HERE, '..', 'public');
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

// `prefix` serves the site under a sub-path, the way GitHub Pages serves a project site.
// `missing` lists site paths to answer 404 for, so a test can stand in for a host where a
// file is absent.
export function startStatic(port, prefix = '', { missing = [] } = {}) {
  const server = createServer((req, res) => {
    // Bound to 127.0.0.1 and only ever pointed at by the test driver, so no path filtering.
    const full = normalize(decodeURIComponent(req.url.split('?')[0]));
    if (!full.startsWith(`${prefix}/`) || missing.includes(full.slice(prefix.length))) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
      return;
    }
    const path = full.slice(prefix.length);
    const file = path === '/p2p-harness.html' ? join(HERE, 'p2p-harness.html') : join(PUBLIC, path === '/' ? 'index.html' : path);
    if (!existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
    createReadStream(file).pipe(res);
  });
  return new Promise((done, fail) => {
    server.once('error', fail);
    server.listen(port, '127.0.0.1', () => done({
      url: `http://127.0.0.1:${port}${prefix}/`,
      close: () => new Promise((closed) => {
        server.closeAllConnections();
        server.close(closed);
      }),
    }));
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const site = await startStatic(Number(process.argv[2]) || 8106);
  console.log(`static P2P site on ${site.url}`);
}
