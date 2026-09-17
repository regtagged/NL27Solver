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
import { existsSync, readFileSync } from 'node:fs';
import { extname, join, normalize, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Solver } from './lib/solve.js';
import { indexNodes, strategyTree, foldRoundTo } from './lib/browse.js';
import { positionNames, preDrawOrder } from './lib/tree.js';

const here = dirname(fileURLToPath(import.meta.url));
const publicDir = resolve(here, 'public');
const dataFile = resolve(here, 'data', 'ranked.json');

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = argv.indexOf(`--${name}`);
  return at >= 0 && at + 1 < argv.length ? argv[at + 1] : fallback;
};
const port = Number(flag('port', process.env.PORT ?? 43195));

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

/**
 * The solve the browser walks, run here rather than shipped.
 *
 * Holding the solver in the server is what lets a node be asked for by id and
 * answered with a grouped range: the alternative is writing every node's whole
 * range to disk, which is the same numbers spelled out 679 times.
 */
let solve = null;
if (argv.includes('--solve')) {
  const iterations = Number(flag('iterations', 2000000));
  const config = {
    players: Number(flag('players', 7)),
    stack: Number(flag('stack', 40)),
    smallBlind: Number(flag('sb', 0.5)),
    bigBlind: Number(flag('bb', 1)),
    ante: Number(flag('ante', 0)),
    anteMode: flag('ante-mode', 'none'),
    nodeLimit: 2e7,
  };
  const { players } = config;
  process.stdout.write(`Solving ${players}-handed ${config.stack}bb, `
    + `blinds ${config.smallBlind}/${config.bigBlind}`
    + `${config.ante ? `, ante ${config.ante} (${config.anteMode})` : ''}, `
    + `${iterations.toLocaleString()} iterations…\n`);
  const started = Date.now();
  const solver = new Solver({ config, abstraction: 'coarse' });
  solver.run(iterations);
  const rows = JSON.parse(readFileSync(dataFile)).rows;
  solve = {
    solver,
    rows,
    players,
    config,
    names: positionNames(players),
    nodes: indexNodes(solver.tree, players),
    iterations,
  };
  console.log(`  ${solve.nodes.size} pre-draw decisions, `
    + `${((Date.now() - started) / 1000).toFixed(0)}s`);
}

const json = (response, body) => {
  response.writeHead(200, { 'content-type': TYPES['.json'], 'cache-control': 'no-cache' });
  response.end(JSON.stringify(body));
};

const server = createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`);

  if (url.pathname === '/api/solve') {
    if (!solve) return json(response, { running: false });
    return json(response, {
      running: true,
      players: solve.players,
      names: solve.names,
      iterations: solve.iterations,
      config: solve.config,
      // What each seat started the hand with, which is the thing a strategy is
      // only meaningful relative to.
      stacks: solve.names.map(() => solve.config.stack),
      // Seats in the order they act before the draw: UTG first, blinds last.
      order: preDrawOrder(solve.players),
      root: solve.solver.tree.root,
      nodes: [...solve.nodes.values()],
    });
  }

  if (url.pathname === '/api/strategy') {
    if (!solve) return json(response, { running: false });
    const id = Number(url.searchParams.get('node'));
    const answer = strategyTree(solve.solver, id, solve.rows);
    if (!answer) {
      response.writeHead(404, { 'content-type': 'text/plain' }).end('No such decision');
      return;
    }
    const entry = solve.nodes.get(id);
    return json(response, {
      running: true,
      id,
      seat: answer.seat,
      seatName: solve.names[answer.seat],
      sequence: entry?.sequence ?? [],
      actions: answer.actions.map((label, i) => ({
        label,
        child: entry?.actions[i]?.child ?? -1,
      })),
      // Where a seat's own decision lives from here, if everyone between folds.
      jumps: solve.names.map((_, seat) => foldRoundTo(solve.solver.tree, id, seat)),
      tree: answer.tree,
    });
  }

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
