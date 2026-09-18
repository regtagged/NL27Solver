/**
 * Solves all-in-or-fold hold'em and writes the ranges out for the viewer.
 *
 *   node scripts/pushfold.mjs [--players 7] [--stack 15] [--ante 0.6]
 *                             [--iterations 2000000] [--seed 11]
 *
 * The whole answer is 126 decisions by 169 hands, which is small enough to
 * write as one JSON file and serve as it is. Nothing is grouped or summarised
 * on the way out, so what the page shows is what the solve said.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PushFoldSolver, SHOVE, FOLD } from '../lib/pushfold.js';
import { HAND_CLASS_LABELS, HAND_CLASS_COUNT, HAND_CLASS_COMBOS } from '../lib/holdem.js';
import { preDrawOrder } from '../lib/tree.js';

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = argv.indexOf(`--${name}`);
  return at >= 0 && at + 1 < argv.length ? Number(argv[at + 1]) : fallback;
};

const config = {
  players: flag('players', 7),
  stack: flag('stack', 15),
  smallBlind: flag('sb', 0.5),
  bigBlind: flag('bb', 1),
  ante: flag('ante', 0.6),
};
const iterations = flag('iterations', 2000000);
const solver = new PushFoldSolver({ config, seed: flag('seed', 11) });

const dead = config.ante * config.players;
console.log(`All-in or fold, ${config.players}-handed, ${config.stack}bb behind after a `
  + `${config.ante}bb ante (${dead.toFixed(1)}bb dead), blinds ${config.smallBlind}/${config.bigBlind}.`);
console.log(`${solver.tree.nodes.length} decisions over ${HAND_CLASS_COUNT} hands, `
  + `${iterations.toLocaleString()} iterations of ${solver.discount ? 'dcfr' : 'cfr+'}…`);

const started = Date.now();
solver.run(iterations);
const seconds = (Date.now() - started) / 1000;
console.log(`  solved in ${seconds.toFixed(0)}s`);

/**
 * The line that reaches every decision, and where each seat's own decision is.
 *
 * The same shape `lib/browse.js` builds for the 2-7 tree, so the page can be
 * navigated the same way: a strip of seats, every action a link to where it
 * leads, and a seat's box a way back to its own decision. This tree is a chain
 * with no merging, so each node has exactly one line into it.
 */
const lines = new Map();
(function walk(id, sequence) {
  if (id < 0) return;
  const node = solver.tree.nodes[id];
  lines.set(id, sequence);
  node.actions.forEach((action, index) => {
    walk(action.child, [...sequence, {
      seat: node.seat,
      name: solver.names[node.seat],
      label: action.label,
      kind: action.kind,
      at: id,
      index,
    }]);
  });
}(solver.tree.root, []));

/** Where a seat's decision lives from here, if everyone between folds. */
const foldRoundTo = (from, seat) => {
  let id = from;
  for (let guard = 0; guard < config.players * 2; guard += 1) {
    if (id < 0) return -1;
    const node = solver.tree.nodes[id];
    if (node.seat === seat) return id;
    id = node.actions[FOLD].child;
  }
  return -1;
};

/** Every decision, with what each of the 169 hands does at it. */
const nodes = solver.tree.nodes.map((node) => {
  const shove = new Array(HAND_CLASS_COUNT);
  const ev = new Array(HAND_CLASS_COUNT);
  for (let hand = 0; hand < HAND_CLASS_COUNT; hand += 1) {
    shove[hand] = Number(solver.averageAt(node.id, hand)[SHOVE].toFixed(4));
    const value = solver.evAt(node.id, hand);
    ev[hand] = value === null ? null : Number((value / 100).toFixed(3));
  }
  const sequence = lines.get(node.id) ?? [];
  return {
    id: node.id,
    seat: node.seat,
    facing: node.facing,
    live: node.live,
    frequency: Number(solver.frequency(node.id).toFixed(2)),
    actions: node.actions.map((action) => ({
      label: action.label, kind: action.kind, child: action.child,
    })),
    sequence,
    // Every seat, offered its own decision: the one it made if it has acted,
    // and otherwise the one it would face if everyone between folded.
    jumps: solver.names.map((_, seat) => {
      const acted = [...sequence].reverse().find((step) => step.seat === seat);
      const at = acted ? acted.at : foldRoundTo(node.id, seat);
      if (at < 0) return { node: -1, took: -1, actions: [] };
      return {
        node: at,
        took: acted ? acted.index : -1,
        actions: solver.tree.nodes[at].actions.map((action) => ({
          label: action.label, kind: action.kind, child: action.child,
        })),
      };
    }),
    shove,
    ev,
  };
});

/**
 * Calling off, which is the other half of the game.
 *
 * For each seat that could open-shove, the chain of seats behind it deciding
 * whether to call, with everyone between folding. That is the spot a player
 * actually looks up - "the button jammed, what do I call with" - and it is a
 * different question from what to shove: calling risks the stack to win a pot
 * that already has a stack in it, so the range is far tighter and far more
 * about raw equity than position.
 */
const calling = [];
for (const { seat: shover, node: openNode } of solver.tree.nodes
  .map((n) => ({ seat: n.seat, node: n.id }))
  .filter(({ seat, node }) => node === solver.openingNode(seat))) {
  let id = solver.tree.nodes[openNode].actions[SHOVE].child;
  const seats = [];
  while (id >= 0) {
    const node = solver.tree.nodes[id];
    seats.push({ seat: node.seat, node: id });
    id = node.actions[FOLD].child;
  }
  if (seats.length) calling.push({ shover, seats });
}

const out = {
  built: new Date().toISOString(),
  config,
  iterations,
  dead,
  names: solver.names,
  order: preDrawOrder(config.players),
  labels: HAND_CLASS_LABELS,
  combos: Array.from(HAND_CLASS_COMBOS),
  opening: preDrawOrder(config.players)
    .map((seat) => ({ seat, node: solver.openingNode(seat) }))
    .filter((entry) => entry.node >= 0),
  calling,
  nodes,
};

const file = resolve(here, '..', 'data', 'pushfold.json');
mkdirSync(dirname(file), { recursive: true });
writeFileSync(file, JSON.stringify(out));
console.log(`  wrote data/pushfold.json (${(JSON.stringify(out).length / 1024).toFixed(0)} KB)\n`);

console.log('open-shoving, folded round:');
for (const { seat, node } of out.opening) {
  console.log(`  ${solver.names[seat].padEnd(4)} ${nodes[node].frequency.toFixed(1).padStart(5)}%`);
}

console.log('\ncalling a lone shove, everyone between folding:');
for (const { shover, seats } of calling) {
  const line = seats
    .map(({ seat, node }) => `${solver.names[seat]} ${nodes[node].frequency.toFixed(1)}%`)
    .join('  ');
  console.log(`  vs ${solver.names[shover].padEnd(4)} ${line}`);
}
