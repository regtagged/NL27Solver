/**
 * The viewer's server. No dependencies, no build step.
 *
 *   node serve.js [--port 43195]
 *
 * It serves `public/` and the ranked hand table. If the table has not been
 * built yet it says so rather than starting up empty, because a viewer with no
 * data looks like a broken viewer rather than a missing file.
 */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const publicDir = resolve(here, 'public');
const dataFile = resolve(here, 'data', 'ranked.json');

const argv = process.argv.slice(2);
const at = argv.indexOf('--port');
const port = Number(at >= 0 ? argv[at + 1] : process.env.PORT ?? 43195);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

if (!existsSync(dataFile)) {
  console.error('No ranked hand table yet. Build it first:\n');
  console.error('  node --max-old-space-size=6000 scripts/rank-hands.mjs\n');
  process.exit(1);
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`);

  if (url.pathname === '/api/ranked') {
    const body = await readFile(dataFile);
    response.writeHead(200, {
      'content-type': TYPES['.json'],
      'cache-control': 'no-cache',
    });
    response.end(body);
    return;
  }

  // Everything else is a file under public/, and nothing above it.
  const wanted = url.pathname === '/' ? '/index.html' : url.pathname;
  const path = join(publicDir, normalize(wanted).replace(/^(\.\.[/\\])+/, ''));
  if (!path.startsWith(publicDir)) {
    response.writeHead(403).end('No.');
    return;
  }

  try {
    const info = await stat(path);
    if (!info.isFile()) throw new Error('not a file');
    const body = await readFile(path);
    response.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream' });
    response.end(body);
  } catch {
    response.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
  }
});

server.listen(port, () => {
  console.log(`DrawSolver viewer on http://localhost:${port}`);
});
