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
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { extname, join, normalize, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Solver } from './lib/solve.js';
import { indexNodes, strategyTree, foldRoundTo, followLine } from './lib/browse.js';
import { positionNames, preDrawOrder, threeBetFlag, DRAWING, POST_DRAW } from './lib/tree.js';
import { save, load, solveKey } from './lib/checkpoint.js';
import { handFacts } from './lib/badugi-benchmark.js';
import { badugiTable } from './lib/badugi.js';
import { keepFor } from './lib/badugi-solve.js';
import { openSolve, browse } from './lib/badugi-browse.js';
import { startsWhole } from './lib/badugi-spots.js';
import { priceActions } from './lib/badugi-price.js';
import { makeRng } from './lib/cards.js';

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

/**
 * Badugi solves held open for browsing, a few at a time.
 *
 * Opening one is a couple of seconds of tree building and a block cache; the
 * five gigabytes of strategy stay on disk and arrive a node at a time. It still
 * happens in the background - the first request starts it and is told to come
 * back - and a failure is remembered too, so a missing checkpoint is reported
 * instead of being retried on every poll.
 */
const badugis = new Map();
// Few enough to stay cheap, more than one because there is more than one page.
// Holding exactly one meant a drill and a viewer on different spots evicted each
// other on every request: each poll dropped the other's solve, both spent their
// lives reopening, and a hand in progress died mid-decision with the server
// answering `loading` forever. Open is not loaded - a solve is its tree and a
// block cache, not the five gigabytes on disk - so a handful costs little.
const BADUGI_OPEN = 3;

function openBadugi(key) {
  const held = badugis.get(key);
  if (held) {
    // Most recently used last, so the eviction below drops the coldest.
    badugis.delete(key);
    badugis.set(key, held);
    if (held.error) return { error: held.error };
    if (held.solve) return { solve: held.solve };
    return { since: Date.now() - held.since };
  }
  const badugi = { slug: key, solve: null, loading: null, since: Date.now(), error: null };
  badugis.set(key, badugi);
  while (badugis.size > BADUGI_OPEN) badugis.delete(badugis.keys().next().value);
  badugi.loading = (async () => {
    try {
      // Yield first: the load blocks this thread for a minute, and the request
      // that started it has to be answered before that happens.
      await new Promise((go) => setImmediate(go));
      // A big block cache, because the drill prices actions by playing thousands
      // of hands out and a rollout lands on scattered nodes across the whole
      // tree. At 4,096 blocks almost every one of those is a seek, and a single
      // price took minutes instead of half a second - with the event loop
      // blocked for all of it, because the reads are synchronous. Everything
      // reachable under the average strategy is a few tens of thousands of
      // blocks, so holding that many turns the second price and every one after
      // it into memory reads.
      const solve = openSolve(key, { dir: resolve(here, 'solves'), cache: 80000 });
      badugi.solve = solve;
      console.log(`  badugi: ${key} open at ${solve.head.iterations.toLocaleString()} iterations`);
    } catch (error) {
      badugi.error = String(error.message ?? error);
      console.log(`  badugi: ${key} could not be opened - ${error.message ?? error}`);
    }
  })();
  return { since: 0 };
}

/**
 * Hands in progress, for the drill.
 *
 * A deal is the deck, and the deck is what makes the hand reproducible: the
 * replacement cards come off it before anything is played, so a draw is a lookup
 * rather than a new random card, and the same deal can be replayed for pricing
 * as many times as the pricer wants. The client holds an id and nothing else -
 * the deck stays here, because it contains the opponent's cards and a client
 * that had them could read them.
 *
 * Capped and evicted oldest-first. A drill session is a few dozen hands and a
 * deck is twenty-six numbers, so this is kilobytes; the cap is there so a page
 * left open for a week cannot become a leak.
 */
const drills = new Map();
const DRILL_LIMIT = 500;

function remember(deal) {
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  drills.set(id, deal);
  while (drills.size > DRILL_LIMIT) drills.delete(drills.keys().next().value);
  return id;
}

/* ----------------------------------------------------------------- the drill */

/**
 * One deal for the drill, with the player's seat fixed.
 *
 * `dealHands` respects the preset ranges, so a drill against `btn-bb` deals the
 * button a hand it would actually have opened. The deck is copied out because
 * the solver's own is scratch and every later call re-installs this one.
 */
function dealDrill(solver, mine) {
  solver.dealHands(makeRng((Math.random() * 2 ** 31) >>> 0));
  return { mine, deck: Array.from(solver.deck), at: Date.now(), plays: [] };
}

/**
 * Which of the two seats has position, found rather than assumed.
 *
 * Position in a draw game is who acts *last* after the draw, and that is not
 * something to hardcode: the blinds act last before the draw and first after it,
 * so the seat order flips, and a subgame starting part way through a hand can
 * leave either seat to act first. So the tree is asked - the shallowest betting
 * decision after a draw belongs to whoever is out of position, and the other
 * live seat is in it.
 */
function positionOf(solver) {
  const seen = new Set([solver.tree.root]);
  const queue = [solver.tree.root];
  while (queue.length) {
    const node = solver.nodes[queue.shift()];
    if (!node || node.kind !== 'decision') continue;
    if (node.street === POST_DRAW) {
      const first = node.seat;
      return { out: first, in: solver.live.find((seat) => seat !== first) ?? first };
    }
    for (const action of node.actions) {
      if (seen.has(action.child)) continue;
      seen.add(action.child);
      queue.push(action.child);
    }
  }
  // Nothing past the draw in this tree, which only happens for a game that ends
  // at one. Then nobody has position and the first to act is named so.
  const first = solver.nodes[solver.tree.root].seat;
  return { out: first, in: solver.live.find((seat) => seat !== first) ?? first };
}

/**
 * What is in the pot before anybody in this tree has acted.
 *
 * A subgame starts part way through a hand, and its `from` state is the record of
 * what has already gone in - the button's open in `btn-bb`, the blinds in
 * `sb-bb`. A whole game has no such state, so it is the blinds and antes.
 */
function startingPot(solver) {
  const start = Math.round(solver.config.stack * 100);
  if (solver.from) {
    let pot = 0;
    for (let seat = 0; seat < solver.players; seat += 1) pot += start - solver.from.stack[seat];
    return pot;
  }
  const { smallBlind = 0, bigBlind = 0, ante = 0 } = solver.config;
  return Math.round((smallBlind + bigBlind + ante * solver.players) * 100);
}

/**
 * Puts a remembered deal back into the solver and replays a line onto it.
 *
 * The pot is added up on the way through, because only terminal nodes carry the
 * state that prices one - a walk has no use for the pot at a decision, so the
 * tree does not keep it there. Every action carries what it puts in, which is the
 * same number from the other end.
 */
function restore(solver, deal, line) {
  solver.deck.set(deal.deck);
  solver.drawn.fill(-1);
  for (const seat of solver.live) solver.prepareSeat(seat);
  let id = solver.tree.root;
  let pot = startingPot(solver);
  for (const at of line) {
    const node = solver.nodes[id];
    if (!node || node.kind !== 'decision') throw new Error('the hand ended before that action');
    if (at < 0 || at >= node.actions.length) throw new Error('that action is not offered here');
    if (node.street === DRAWING) {
      solver.drawn[node.seat * solver.rounds + solver.roundOf(node)] = node.actions[at].option;
    }
    pot += node.actions[at].amount ?? 0;
    id = node.actions[at].child;
  }
  return { id, pot };
}

/**
 * The four cards a seat is holding now, drawn cards included.
 *
 * The solver keeps `handAfter` - the badugi *value* after any draw history - but
 * never the cards themselves, because a walk has no use for them. A drill does:
 * a player who drew two has to be shown what they drew. So the history is
 * replayed exactly as `prepareSeat` builds it, same keep rule and same
 * replacements off the same deck, which is what makes the cards shown agree with
 * the value the strategy is indexed by.
 */
function cardsNow(solver, seat) {
  let cards = [];
  for (let i = 0; i < 4; i += 1) cards.push(solver.deck[seat * 4 + i]);
  const into = new Array(4);
  const base = seat * solver.rounds;
  for (let round = 0; round < solver.rounds; round += 1) {
    const took = solver.drawn[base + round];
    if (took < 0) break;
    if (took === 0) continue;
    const kept = keepFor(cards, took, into);
    const next = cards.slice();
    for (let i = 0; i < kept; i += 1) next[i] = into[i];
    const from = solver.reserveAt[seat] + solver.roundOffset[seat][round];
    for (let i = 0; i < took; i += 1) next[kept + i] = solver.deck[from + i];
    cards = next;
  }
  return cards.sort((a, b) => a - b);
}

/**
 * Where the hand stands, and what the solve would do with what the player holds.
 *
 * The opponent's actions are *not* taken here. The page asks for a state, is told
 * whose turn it is, and when it is the opponent's turn it asks the solve to move
 * - which keeps every action in the line the client holds, so a hand can be
 * replayed, priced, and linked to in the viewer by exactly the line that
 * happened.
 */
function drillState(solver, names, deal, line) {
  const { id, pot } = restore(solver, deal, line);
  const node = solver.nodes[id];
  const mine = deal.mine;
  const theirs = solver.live.find((seat) => seat !== mine);
  const held = solver.handTable[solver.handAfter[mine * solver.slotsPerSeat + solver.slotFor(mine)]];
  const over = !node || node.kind !== 'decision';

  const out = {
    seat: mine,
    who: names[mine],
    against: names[theirs],
    cards: cardsNow(solver, mine),
    // The value of what the player is holding *now*, after any draws, which is
    // the whole reason a drill can show a strategy at all past the first draw:
    // the deck is known here even though the player cannot name the cards.
    value: held,
    label: solver.handLabels[held],
    line,
    over,
  };
  if (over) {
    return {
      ...out,
      ending: node ? node.kind : 'nothing',
      // Only now, and only because the hand is over.
      showdown: cardsNow(solver, theirs),
      theirValue: solver.handTable[
        solver.handAfter[theirs * solver.slotsPerSeat + solver.slotFor(theirs)]],
      won: node ? solver.payoff(node, mine) : 0,
    };
  }
  const actor = node.seat === mine;
  const acting = solver.handTable[
    solver.handAfter[node.seat * solver.slotsPerSeat + solver.slotFor(node.seat)]];
  const mix = Array.from(solver.averageAt(node.id, acting), (v) => Number(v.toFixed(4)));
  return {
    ...out,
    yours: actor,
    node: {
      id: node.id,
      seat: node.seat,
      who: names[node.seat],
      drawing: node.street === DRAWING,
      // `potAt` is only priced for terminals - a walk never needs the pot at a
      // decision - so it is added up here from what the seats have put in.
      pot,
      actions: node.actions.map((a, at) => ({
        at, label: a.label, kind: a.kind, option: a.option ?? null,
      })),
    },
    // The mix for whoever is to act, which is the player's own strategy when it
    // is their turn and the solve's when it is not. Sending it either way is what
    // lets the page move the opponent without another round trip.
    mix: actor ? mix : null,
    theirMix: actor ? null : mix,
  };
}

/**
 * What each action at this decision is worth to the player, measured.
 *
 * Two thousand deals by default, which is about half a second and an error near
 * fifteen hundredths of a bet - enough to catch a blunder and not enough to rank
 * two close actions. The page says which, because a number without its error is
 * how a drill teaches something that is not true.
 */
function drillPrice(solver, deal, line, deals) {
  restore(solver, deal, line);
  const cards = cardsNow(solver, deal.mine);
  const value = solver.holeValue(deal.mine);
  const out = priceActions(solver, {
    line, seat: deal.mine, cards, deals, seed: 4242, baseline: 0,
  });
  // Restored afterwards because pricing deals thousands of other hands into the
  // solver's deck, and the next request expects this one's.
  restore(solver, deal, line);
  const best = out.arms.reduce((a, b) => (b.mean > a.mean ? b : a), out.arms[0]);
  return {
    deals: out.used,
    value,
    // Everything quoted against the best action, so a mistake reads as what it
    // cost rather than as an absolute nobody has a feel for.
    best: best.at,
    arms: out.arms.map((arm) => ({
      at: arm.at,
      label: arm.label,
      ev: Number(arm.mean.toFixed(1)),
      error: Number.isFinite(arm.error) ? Number(arm.error.toFixed(1)) : null,
      cost: Number((arm.mean - best.mean).toFixed(1)),
    })),
  };
}

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

  /**
   * A solved badugi spot, with the hand facts the page needs to group by.
   *
   * The solve stores a strategy per hand *value* and nothing about what those
   * values are; `handFacts` supplies the size, the cards and the combination
   * count, which is what turns 1,092 numbers into rows a player reads. Computed
   * here rather than written into the file, because it is a property of the
   * deck and not of any particular solve.
   */
  if (url.pathname === '/api/badugi') {
    const spot = url.searchParams.get('spot') ?? 'btn-bb';
    const file = resolve(here, 'data', `badugi-${spot.replace(/[^a-z0-9-]/gi, '')}.json`);
    if (!existsSync(file)) return json(response, { running: false });
    const body = JSON.parse(readFileSync(file));
    const { hands } = handFacts();
    return json(response, { running: true, ...body, hands });
  }

  /**
   * Which badugi solves are on disk, so the viewer can offer them rather than
   * be told about them. A labelled variant - an experiment - is a file beside
   * the run it varies, and this is what makes it findable.
   */
  if (url.pathname === '/api/badugi-solves') {
    const dir = resolve(here, 'data');
    const found = existsSync(dir)
      ? readdirSync(dir)
        .filter((name) => /^badugi-.+.json$/.test(name))
        .map((name) => name.replace(/^badugi-|.json$/g, ''))
        .filter((name) => !/^d+p$/.test(name))
      : [];
    // `?whole=1` keeps only the solves that begin where a hand begins, which is
    // what the drill wants: a spot starting after somebody has already raised
    // hands the player a decision they never made.
    const whole = url.searchParams.has('whole');
    return json(response, {
      solves: whole ? found.filter(startsWhole) : found,
    });
  }

  /**
   * Any node of a badugi solve, reached by the actions that lead to it.
   *
   *   /api/badugi-node?spot=sb-bb&line=raise,call,pat
   *
   * The report file holds fourteen decisions; this holds all 226,098 of them,
   * because it keeps the checkpoint open instead of writing it out. That costs
   * five gigabytes of memory and about a minute to read, which is why the load
   * happens once, in the background, and this answers `{ loading: true }` until
   * it is done rather than holding the request open for a minute.
   */
  if (url.pathname === '/api/badugi-node') {
    const key = (url.searchParams.get('spot') ?? 'btn-bb').replace(/[^a-z0-9-]/gi, '');
    const opened = openBadugi(key);
    if (opened.error) return json(response, { ok: false, error: opened.error });
    if (!opened.solve) {
      return json(response, { ok: false, loading: true, slug: key, since: opened.since });
    }
    const steps = (url.searchParams.get('line') ?? '')
      .split(',').map((s) => s.trim()).filter(Boolean);
    try {
      const { combos } = badugiTable();
      // An optional hand the reader has typed in, so the answer can say what
      // that hand does rather than only what the range does.
      const asked = url.searchParams.get('hand');
      const hand = asked !== null && /^[0-9]+$/.test(asked) ? Number(asked) : null;
      const out = browse(opened.solve.solver, steps, { names: opened.solve.names, combos, hand });
      return json(response, {
        ok: true,
        spot: key,
        what: opened.solve.spot.what,
        iterations: opened.solve.head.iterations,
        preset: opened.solve.solver.presetRanges ? true : false,
        live: [...opened.solve.solver.live],
        ...out,
      });
    } catch (error) {
      return json(response, { ok: false, error: String(error.message ?? error) });
    }
  }

  /**
   * The drill: play a hand out against the solve, and be told what it cost.
   *
   *   /api/drill?spot=sb-bb&do=deal[&seat=0]
   *   /api/drill?spot=sb-bb&do=state&id=...&line=0,1
   *   /api/drill?spot=sb-bb&do=price&id=...&line=0,1[&deals=2000]
   *
   * Stateless except for the deck, which is held by id. `state` says where the
   * hand stands, what the player may do, and what the solve's own strategy is for
   * the hand the player is holding - so the page can show a mistake as a
   * frequency immediately and ask for the price of one separately, because a
   * price is a few thousand play-outs and a frequency is a lookup.
   *
   * The opponent plays the solve. Its hand is never sent until the hand is over.
   */
  if (url.pathname === '/api/drill') {
    const key = (url.searchParams.get('spot') ?? 'sb-bb').replace(/[^a-z0-9-]/gi, '');
    const opened = openBadugi(key);
    if (opened.error) return json(response, { ok: false, error: opened.error });
    if (!opened.solve) {
      return json(response, { ok: false, loading: true, slug: key, since: opened.since });
    }
    const { solver, names } = opened.solve;
    const doing = url.searchParams.get('do') ?? 'state';
    try {
      if (doing === 'seats') {
        // Named for the page's picker: which seats there are, what they are
        // called, and which of them is the one with position.
        const spots = positionOf(solver);
        return json(response, {
          ok: true,
          what: opened.solve.spot.what,
          iterations: opened.solve.head.iterations,
          seats: solver.live.map((seat) => ({
            seat, who: names[seat], position: seat === spots.in ? 'in' : 'out',
          })),
          inPosition: spots.in,
          outOfPosition: spots.out,
        });
      }
      if (doing === 'deal') {
        const wants = url.searchParams.get('seat') ?? '';
        const spots = positionOf(solver);
        // A seat may be asked for by number or by where it sits. "Alternate" is
        // the page's business, not the server's: it picks a side and names it.
        const asked = wants === 'in' ? spots.in
          : wants === 'out' ? spots.out
            : Number(wants);
        // Whoever acts first by default, so a drill that says nothing gets the
        // seat whose decision the solve is really about.
        const mine = solver.live.includes(asked) ? asked : solver.nodes[solver.tree.root].seat;
        const deal = dealDrill(solver, mine);
        const id = remember(deal);
        return json(response, { ok: true, id, ...drillState(solver, names, deal, []) });
      }
      const id = url.searchParams.get('id') ?? '';
      const deal = drills.get(id);
      if (!deal) return json(response, { ok: false, error: 'that hand is no longer held' });
      const line = (url.searchParams.get('line') ?? '')
        .split(',').map((s) => s.trim()).filter(Boolean).map(Number);
      if (doing === 'price') {
        const deals = Math.max(200, Math.min(20000, Number(url.searchParams.get('deals') ?? 2000)));
        return json(response, { ok: true, id, ...drillPrice(solver, deal, line, deals) });
      }
      return json(response, { ok: true, id, ...drillState(solver, names, deal, line) });
    } catch (error) {
      return json(response, { ok: false, error: String(error.message ?? error) });
    }
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
