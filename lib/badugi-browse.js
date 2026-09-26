/**
 * Reading any node of a solved badugi spot, one action at a time.
 *
 * The report writes down a handful of decisions because the whole strategy is
 * hundreds of thousands of them and will not fit in a file - 226,098 decisions
 * at a thousand hands apiece is gigabytes of JSON. That is the right way to
 * ship a summary and the wrong way to answer "what happens if he raises here
 * instead", which is the question a player actually has.
 *
 * So this keeps the solve open and hands out one node at a time - and open is
 * not the same as loaded. The header says where every block sits, so the five
 * gigabytes stay on disk and a decision is one seek and thirteen kilobytes.
 * Opening costs a couple of seconds, nearly all of it building the tree, and a
 * node after that is single-digit milliseconds.
 *
 * Reach follows the same rule it does everywhere else in this repository - the
 * preset range times the seat's own choices, dropped the moment that seat draws
 * a card, because a hand's strategy is indexed by its value and drawing changes
 * the value. Past that point what is left is which hands the solve ever saw at
 * the node, which still tells the reader that half the table cannot be there.
 */

import { resolve } from 'node:path';

import { stateAfter, positionNames, DRAWING } from './tree.js';
import { BadugiSolver, badugiConfig } from './badugi-solve.js';
import { buttonOpeningRange } from './badugi-benchmark.js';
import { openBadugi } from './badugi-checkpoint.js';
import { SPOTS, spotNamed, presetFor } from './badugi-spots.js';
import { HEADS_UP, headsUpSolver } from './badugi-headsup.js';

const ORDINAL = ['first', 'second', 'third', 'fourth'];

/**
 * The solver for a spot, built the way every script here builds it.
 *
 * The heads-up game is not a spot and is built elsewhere: it is two seats dealt
 * from a full deck rather than two seats left in a six-handed one, so it has its
 * own player count, its own ceilings and no prefix. It is recognised by name
 * here so that everything which reads a solve - the viewer, the drill, the hand
 * history - can open it without knowing which of the two it is.
 */
export function solverFor(key, options = {}) {
  if (key === HEADS_UP.key || key.startsWith(`${HEADS_UP.key}-`)) {
    const built = headsUpSolver({ ...options, prune: null });
    return {
      solver: built.solver,
      spot: { what: HEADS_UP.what, line: [], over: {}, preset: null },
      names: built.names,
      config: built.config,
    };
  }
  const spot = spotNamed(key);
  const names = positionNames(6);
  const btn = names.indexOf('BTN');
  const config = badugiConfig({
    players: 6,
    maxToDraw: null,
    coldCallSeats: null,
    coldCallThreeBets: true,
    maxDraw: options.draws ?? [3, 2, 2],
    maxDrawBySeat: null,
    limit: { smallBet: 1, bigBet: 2, bigBetFrom: 2, cap: options.cap ?? 4 },
    nodeLimit: 90e6,
    ...spot.over,
  });
  const solver = new BadugiSolver({
    config,
    from: stateAfter(config, spot.line),
    seed: options.seed ?? 21,
    trackEv: false,
    explore: options.explore ?? 0.02,
    presetRanges: presetFor(key, btn, buttonOpeningRange()),
  });
  return { solver, spot, names, config };
}

/**
 * Opens a solve for reading: build the game, then point it at the checkpoint.
 *
 * A couple of seconds, and the strategy is never held in memory - so callers
 * may keep one open cheaply, and a second one costs no more than the first.
 */
export function openSolve(key, { label = null, dir = 'solves', cache = 4096 } = {}) {
  const built = solverFor(key);
  const slug = label ? `${key}-${label}` : key;
  // Opened rather than loaded: the strategy stays on disk and arrives a node at
  // a time. Reading all of it costs a minute and five gigabytes, and a page
  // showing one decision needs thirteen kilobytes of it.
  //
  // A page showing one decision wants the small cache it gets by default. A
  // measurement that plays millions of hands out wants a bigger one, because
  // everything below a single draw is a few thousand blocks and holding all of
  // them turns every rollout after the first into memory reads.
  const head = openBadugi(built.solver, resolve(dir, `badugi-${slug}`), { cache });
  if (!head) throw new Error(`no checkpoint for ${slug}`);
  if (head.mismatch) throw new Error(`${slug} describes a different game (${head.mismatch})`);
  return { ...built, head, slug, key };
}

/**
 * Matches an action the way a player names it, or by its index.
 *
 * Indices are what a link carries - labels contain spaces, and `raise 1bb`
 * appears at more than one point in a round - so a line in a URL is a list of
 * numbers and arrives here as strings.
 */
function actionIndex(node, want) {
  const asNumber = typeof want === 'number' ? want
    : (/^\d+$/.test(String(want)) ? Number(want) : null);
  if (asNumber !== null) {
    return asNumber >= 0 && asNumber < node.actions.length ? asNumber : -1;
  }
  return node.actions.findIndex((a) => a.kind === want || a.label === want
    || (want === 'bet' && (a.kind === 'bet' || a.kind === 'raise')));
}

/** What a decision is called, given how many draws this seat has taken. */
function describe(node, names, drawsSoFar) {
  if (node.street === DRAWING) {
    return `${names[node.seat]} ${ORDINAL[drawsSoFar] ?? `draw ${drawsSoFar + 1}`} draw`;
  }
  return node.actions.some((a) => a.kind === 'fold')
    ? `${names[node.seat]} facing the bet`
    : `${names[node.seat]} first to act`;
}

/** Where each hand stands for each seat before anything has happened. */
function newReach(solver) {
  const reach = new Map();
  for (const seat of solver.live) {
    const start = new Float64Array(solver.handCount).fill(1);
    const preset = solver.presetRanges ? solver.presetRanges[seat] : null;
    if (preset) for (let h = 0; h < solver.handCount; h += 1) start[h] = preset[h] ? 1 : 0;
    reach.set(seat, start);
  }
  return reach;
}

/**
 * How much of this node's traffic each hand was, measured rather than derived.
 *
 * Past a draw the analytic reach is gone - a hand's strategy is indexed by its
 * value and drawing changes the value - and what replaces it here is what the
 * solve saw. The average table adds `weight * strategy` to a hand's row once
 * per visit, so the mass in that row is how often the hand was actually at this
 * node over forty million iterations: the arrival distribution, sampled.
 *
 * It replaces a yes/no 'was it ever here' flag, which passed anything the
 * solver touched once and then showed its one visit as though it were a
 * strategy: a two-card hand that arrives a millionth as often as the busiest
 * one was printing a confident raising frequency.
 */
function trafficAt(solver, node) {
  const width = node.actions.length;
  const block = solver.average[node.id];
  const traffic = new Float64Array(solver.handCount);
  if (!block) return traffic;
  let total = 0;
  for (let hand = 0; hand < solver.handCount; hand += 1) {
    let mass = 0;
    for (let a = 0; a < width; a += 1) mass += block[hand * width + a];
    traffic[hand] = mass;
    total += mass;
  }
  if (total > 0) for (let h = 0; h < traffic.length; h += 1) traffic[h] /= total;
  return traffic;
}

/**
 * The mix a whole range plays at a node, weighted the way the tables are.
 *
 * Needed at every step and not only at the end, because multiplying these
 * together is how often the line itself happens - and a decision reached once
 * in three thousand hands has a strategy made of almost no traffic, which is
 * the one thing a reader has to know before believing it.
 */
function mixAt(solver, node, combos, weightFor) {
  const width = node.actions.length;
  const mix = new Float64Array(width);
  let total = 0;
  for (let hand = 0; hand < solver.handCount; hand += 1) {
    const weight = weightFor(hand);
    if (!weight) continue;
    const strategy = solver.averageAt(node.id, hand);
    for (let a = 0; a < width; a += 1) mix[a] += weight * strategy[a];
    total += weight;
  }
  return { mix, total: total || 1 };
}

/** How a hand ends, for an action that does not lead to another decision. */
function endingOf(solver, node, names) {
  if (node.kind === 'showdown') return { kind: 'showdown', what: 'showdown' };
  if (node.kind === 'fold') {
    const folded = solver.foldedAt[node.id];
    const gone = solver.live.filter((seat) => folded[seat]).map((seat) => names[seat]);
    return { kind: 'fold', what: gone.length ? `${gone.join(' and ')} folds` : 'fold' };
  }
  return { kind: node.kind, what: node.kind };
}

/**
 * Walks a line of actions and describes where it lands.
 *
 * `steps` are action names or indices. A step that is not legal is refused
 * rather than followed elsewhere, so a stale link says so instead of quietly
 * showing a different decision.
 */
export function browse(solver, steps, { names, combos, hand = null }) {
  const reach = newReach(solver);
  const drew = new Set();
  const drawsBySeat = new Map();
  const path = [];
  // How often this line is played, which is the product of the range-weighted
  // frequency of each action taken along it.
  let reached = 1;
  let id = solver.tree.root;

  for (const want of steps) {
    const node = solver.nodes[id];
    if (!node || node.kind !== 'decision') {
      throw new Error(`the hand ended before "${want}"`);
    }
    const at = actionIndex(node, want);
    if (at < 0) {
      throw new Error(`"${want}" is not legal for ${names[node.seat]} here; `
        + `offered ${node.actions.map((a) => a.label).join(', ')}`);
    }
    const action = node.actions[at];
    const mine = reach.get(node.seat);
    let chance = 1;
    {
      const carriedHere = !drew.has(node.seat);
      const seen = carriedHere ? null : trafficAt(solver, node);
      const priced = mixAt(solver, node, combos, (h) => (carriedHere
        ? combos[h] * mine[h] : seen[h]));
      chance = priced.mix[at] / priced.total;
      reached *= chance;
    }
    if (mine && !drew.has(node.seat)) {
      for (let h = 0; h < solver.handCount; h += 1) mine[h] *= solver.averageAt(id, h)[at];
    }
    // Read before the draw is applied, not after. The decision to draw one was
    // made holding the hand that was typed in - it is everything *after* it
    // that is about a hand nobody can name yet.
    const held = !drew.has(node.seat);
    if (node.street === DRAWING) {
      drawsBySeat.set(node.seat, (drawsBySeat.get(node.seat) ?? 0) + 1);
      if (action.option > 0) drew.add(node.seat);
    }
    path.push({
      seat: node.seat,
      who: names[node.seat],
      label: action.label,
      kind: action.kind,
      option: action.option ?? null,
      at,
      // How often the range takes this action here, so a line can be drawn to
      // scale rather than described.
      chance: Number(chance.toFixed(4)),
      // What one particular hand would have done at this point, when the caller
      // has named one. Only meaningful for a seat that still holds the hand it
      // was dealt: once it draws, its strategy is indexed by a value it no
      // longer has, and saying otherwise would be inventing a read.
      yours: hand === null ? null : {
        mix: Array.from(solver.averageAt(id, hand), (v) => Number(v.toFixed(4))),
        stale: !held,
      },
    });
    id = action.child;
  }

  const node = solver.nodes[id];
  if (!node) throw new Error('that line leads nowhere');
  if (node.kind !== 'decision') {
    return { path, reached, ending: endingOf(solver, node, names), node: null };
  }

  const width = node.actions.length;
  const carried = !drew.has(node.seat);
  const reachOut = carried ? reach.get(node.seat) : null;
  const traffic = carried ? null : trafficAt(solver, node);

  // Per-hand strategy, and the overall mix weighted by what arrives.
  const hands = [];
  const mix = new Float64Array(width);
  let total = 0;
  for (let hand = 0; hand < solver.handCount; hand += 1) {
    const strategy = solver.averageAt(node.id, hand);
    hands.push(Array.from(strategy, (v) => Number(v.toFixed(4))));
    const weight = reachOut ? combos[hand] * reachOut[hand] : (traffic ? traffic[hand] : combos[hand]);
    for (let a = 0; a < width; a += 1) mix[a] += weight * strategy[a];
    total += weight;
  }

  return {
    path,
    reached,
    ending: null,
    node: {
      id: node.id,
      seat: node.seat,
      who: names[node.seat],
      what: describe(node, names, drawsBySeat.get(node.seat) ?? 0),
      drawing: node.street === DRAWING,
      actions: node.actions.map((a, at) => {
        const child = solver.nodes[a.child];
        return {
          at,
          label: a.label,
          kind: a.kind,
          option: a.option ?? null,
          // What taking it leads to, so a button that ends the hand can say so
          // rather than looking like one more step into the tree.
          leadsTo: child && child.kind === 'decision'
            ? 'decision'
            : endingOf(solver, child ?? {}, names).kind,
        };
      }),
      overall: Array.from(mix, (v) => Number((100 * v / (total || 1)).toFixed(2))),
      yours: hand === null ? null : {
        mix: Array.from(solver.averageAt(node.id, hand), (v) => Number(v.toFixed(4))),
        stale: !carried,
      },
      reach: reachOut ? Array.from(reachOut, (v) => Number(v.toFixed(4))) : null,
      traffic: traffic ? Array.from(traffic, (v) => Number(v.toExponential(4))) : null,
      hands,
    },
  };
}

/** The spots that can be browsed, for a picker. */
export const browsable = () => [
  ...Object.entries(SPOTS).map(([key, spot]) => ({ key, what: spot.what })),
  { key: HEADS_UP.key, what: HEADS_UP.what },
];
