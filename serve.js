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
import { indexNodes, strategyTree, foldRoundTo, followLine } from './lib/browse.js';
import { positionNames, preDrawOrder, threeBetFlag } from './lib/tree.js';
import { save, load, solveKey } from './lib/checkpoint.js';

const here = dirname(fileURLToPath(import.meta.url));
const publicDir = resolve(here, 'public');
const dataFile = resolve(here, 'data', 'ranked.json');
const pushFoldFile = resolve(here, 'data', 'pushfold.json');

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
    ante: Number(flag('ante', 0.6)),
    anteMode: flag('ante-mode', 'each'),
    openTo: Number(flag('open', 3)),
    threeBetTo: threeBetFlag(flag('three-bet')),
    nodeLimit: 2e7,
  };
  const { players } = config;
  const algorithm = flag('algorithm', 'cfr+');
  // Discounted CFR's knobs, when they are being turned: `--beta 0` is the
  // paper's setting, which converges as fast and leaves junk hands playable.
  const discount = {};
  if (argv.includes('--every')) discount.every = Number(flag('every'));
  if (argv.includes('--beta')) discount.beta = Number(flag('beta'));
  const tuning = Object.keys(discount).length ? discount : undefined;
  const explore = Number(flag('explore', 0));
  process.stdout.write(`Solving ${players}-handed ${config.stack}bb, `
    + `blinds ${config.smallBlind}/${config.bigBlind}`
    + `${config.ante ? `, ante ${config.ante} (${config.anteMode})` : ''}, `
    + `${iterations.toLocaleString()} iterations of ${algorithm}…\n`);
  const started = Date.now();
  const joint = argv.includes('--joint');
  const solver = new Solver({ config, abstraction: 'coarse', joint, algorithm, discount: tuning, explore });

  // A solve is minutes of work and the answer never changes, so it is read back
  // rather than paid for again. `--fresh` forces one, for when the question is
  // whether the solver has changed rather than what it says.
  const key = solveKey(config, joint, iterations, algorithm, solver.discount, solver.explore);
  const file = resolve(here, 'solves', key);
  const loaded = argv.includes('--fresh') ? false : load(solver, file);
  if (loaded) {
    console.log(`  loaded ${key}`
      + ` (solved ${new Date(loaded.built).toLocaleString()})`);
  } else {
    solver.run(iterations);
    const written = save(solver, file);
    console.log(`  solved and stored ${(written.bytes / 1024 / 1024).toFixed(0)} MB`);
  }
  const rows = JSON.parse(readFileSync(dataFile)).rows;

  /**
   * One betting structure, ready to be browsed.
   *
   * Two sizings of the same game are two different trees - different nodes,
   * different actions, different sizes on the labels - so they are two views to
   * switch between rather than one view with two sets of numbers in it.
   */
  const viewOf = (built, sizing, count, name) => ({
    solver: built,
    config: sizing,
    iterations: count,
    key: name,
    label: describeSizing(sizing),
    game: describeGame(sizing),
    nodes: indexNodes(built.tree, players),
  });

  const views = [viewOf(solver, config, iterations, key)];

  // `--also` adds structures that have already been solved and stored; the
  // stored file says what game it was, so it takes a solve's name and nothing else.
  for (const also of (flag('also') ?? '').split(',').map((name) => name.trim()).filter(Boolean)) {
    const head = JSON.parse(readFileSync(resolve(here, 'solves', `${also}.json`)));
    if (head.config.players !== players) {
      console.error(`  ${also} is ${head.config.players}-handed; this one is ${players}-handed.`);
      process.exit(1);
    }
    const other = new Solver({
      config: head.config,
      abstraction: 'coarse',
      joint: head.joint,
      algorithm: head.algorithm ?? 'cfr+',
      // Its own settings, not today's defaults: the file is what it is.
      discount: head.discount ?? undefined,
      explore: head.explore ?? 0,
    });
    if (!load(other, resolve(here, 'solves', also))) {
      console.error(`  ${also} does not load: it was solved on a different tree.`);
      process.exit(1);
    }
    views.push(viewOf(other, head.config, head.iterations, also));
    console.log(`  also serving ${also}`);
  }

  views.forEach((view, index) => { view.index = index; });
  solve = { rows, players, names: positionNames(players), views };
  console.log(`  ${views.map((view) => `${view.label}: ${view.nodes.size} pre-draw decisions`).join(', ')}`
    + `, ${((Date.now() - started) / 1000).toFixed(0)}s`);
}

/** How a structure is named in the switcher: the sizes that make it that game. */
function describeSizing(config) {
  const threeBet = config.threeBetTo
    ? `3-bet ${config.threeBetTo.inPosition}/${config.threeBetTo.blinds}bb`
    : '3-bet jam only';
  return `${config.openTo}x open · ${threeBet}`;
}

/**
 * The game underneath the sizing, which is the other half of what a structure
 * is: seats and dead money decide how wide anybody opens before a size does.
 */
function describeGame(config) {
  if (!config.ante) return `${config.players}-handed · no ante`;
  const dead = config.ante * (config.anteMode === 'button' ? 1 : config.players);
  return `${config.players}-handed · ${config.ante}bb ante `
    + `${config.anteMode === 'button' ? 'button' : 'each'} · ${dead.toFixed(2).replace(/\.?0+$/, '')}bb dead`;
}

/** Which structure a request is about; the first one when it does not say. */
function viewFrom(url, name) {
  const at = Number(url.searchParams.get(name));
  return solve.views[Number.isInteger(at) ? at : 0] ?? solve.views[0];
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
      // What each seat started the hand with, which is the thing a strategy is
      // only meaningful relative to.
      stacks: solve.names.map(() => solve.views[0].config.stack),
      // Seats in the order they act before the draw: UTG first, blinds last.
      order: preDrawOrder(solve.players),
      views: solve.views.map((view, index) => ({
        index,
        key: view.key,
        label: view.label,
        game: view.game,
        config: view.config,
        iterations: view.iterations,
        root: view.solver.tree.root,
      })),
    });
  }

  /**
   * The same line in another structure, for switching without losing your place.
   *
   * Node ids mean nothing across trees, so the line is walked: who acted and
   * what kind of thing they did. A line the other structure does not have -
   * anything under a sized 3-bet, when the other only has the jam - lands on
   * its root instead, and says it was not exact.
   */
  if (url.pathname === '/api/same') {
    if (!solve) return json(response, { running: false });
    const to = viewFrom(url, 'to');
    const entry = viewFrom(url, 'from').nodes.get(Number(url.searchParams.get('node')));
    const at = entry ? followLine(to.solver.tree, entry.sequence) : -1;
    return json(response, {
      running: true,
      node: at >= 0 ? at : to.solver.tree.root,
      exact: at >= 0,
    });
  }

  if (url.pathname === '/api/strategy') {
    if (!solve) return json(response, { running: false });
    const view = viewFrom(url, 'view');
    const id = Number(url.searchParams.get('node'));
    const answer = strategyTree(view.solver, id, solve.rows);
    if (!answer) {
      response.writeHead(404, { 'content-type': 'text/plain' }).end('No such decision');
      return;
    }
    const entry = view.nodes.get(id);
    return json(response, {
      running: true,
      id,
      view: view.index,
      seat: answer.seat,
      seatName: solve.names[answer.seat],
      sequence: entry?.sequence ?? [],
      actions: answer.actions.map((label, i) => ({
        label,
        kind: answer.kinds[i],
        child: entry?.actions[i]?.child ?? -1,
      })),
      // Every seat, offered its own decision and everything it could do there.
      // A seat that has already acted is offered the decision it actually made
      // - the one in this hand, with the action it took marked and the ones it
      // passed up alongside, because "what else could it have done" is the next
      // question after "what did it do". A seat not yet in the hand has no such
      // decision in this line, so it gets the one it would face if everyone
      // between folded, which is how people ask about it anyway.
      jumps: solve.names.map((_, seat) => {
        const acted = [...(entry?.sequence ?? [])].reverse().find((step) => step.seat === seat);
        const at = acted ? acted.at : foldRoundTo(view.solver.tree, id, seat);
        if (at < 0) return { node: -1, took: -1, actions: [] };
        return {
          node: at,
          took: acted ? acted.index : -1,
          actions: view.solver.nodes[at].actions.map((action) => ({
            label: action.label,
            kind: action.kind,
            child: action.child,
          })),
        };
      }),
      tree: answer.tree,
    });
  }

  /**
   * The push-fold ranges, served as they were solved.
   *
   * A different game and a different shape: 169 hands rather than 7,462 rows,
   * and no tree to walk, so it is a file rather than a solver held in memory.
   */
  if (url.pathname === '/api/pushfold') {
    if (!existsSync(pushFoldFile)) return json(response, { running: false });
    const body = JSON.parse(readFileSync(pushFoldFile));
    return json(response, { running: true, ...body });
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
