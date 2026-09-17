/**
 * Does the strategy settle, and what does it settle on?
 *
 * Runs one solve and reads the same few decisions back at increasing iteration
 * counts. A strategy still moving between checkpoints has not converged; one
 * that has stopped moving and is still wrong is a bug somewhere else.
 *
 *   node --max-old-space-size=8000 scripts/converge.mjs [--players 7] [--to 40000000]
 */

import { parseHand } from '../lib/cards.js';
import { handIndex } from '../lib/eval27.js';
import { buckets } from '../lib/abstraction.js';
import { Solver } from '../lib/solve.js';

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = argv.indexOf(`--${name}`);
  return at >= 0 && at + 1 < argv.length ? argv[at + 1] : fallback;
};

const config = {
  players: Number(flag('players', 7)),
  stack: Number(flag('stack', 40)),
  smallBlind: Number(flag('sb', 0.5)),
  bigBlind: Number(flag('bb', 1)),
  ante: Number(flag('ante', 0)),
  anteMode: flag('ante-mode', 'none'),
  nodeLimit: 2e7,
};
const target = Number(flag('to', 40000000));

const WATCH = [
  ['75432 pat', '7c5d4h3s2c'],
  ['87652 pat', '8c7d6h5s2c'],
  ['T9752 pat', 'Tc9d7h5s2c'],
  ['7543 d1', 'Kc7d5h4s3c'],
  ['KQJ9 trash', 'AcKdQhJs9c'],
];

const solver = new Solver({
  config,
  seed: 20260916,
  abstraction: argv.includes('--fine') ? 'fine' : 'coarse',
});
const table = solver.bucketTable;
const watched = WATCH.map(([label, text]) => [label, table[handIndex(parseHand(text))]]);

// How many hands sit in each bucket, so "every hand" is weighted by the deck
// rather than by the buckets - which works whichever abstraction is in use.
const weights = new Float64Array(solver.bucketCount);
for (let i = 0; i < table.length; i += 1) weights[table[i]] += 1;

console.log(`${config.players}-handed ${config.stack}bb, blinds ${config.smallBlind}/${config.bigBlind}`
  + `${config.ante ? `, ante ${config.ante} ${config.anteMode}` : ''}`);
console.log(`${solver.nodes.length.toLocaleString()} nodes, `
  + `${solver.bucketCount.toLocaleString()} buckets\n`);

const open = solver.openingNode(2 % config.players) >= 0
  ? solver.openingNode(2 % config.players)
  : solver.tree.root;
const node = solver.nodes[solver.tree.root];
const labels = node.actions.map((action) => action.label);
const pct = (v) => String(Math.round(v * 100)).padStart(3) + '%';

console.log(`First in (${labels.join(' / ')})`);
console.log('iterations'.padEnd(12) + 'every hand'.padEnd(22)
  + WATCH.map(([label]) => label.padEnd(20)).join(''));

let done = 0;
const started = Date.now();
for (const mark of [1e6, 3e6, 8e6, 15e6, 25e6, target]) {
  if (mark <= done) continue;
  solver.run(mark - done);
  done = mark;

  const totals = new Float64Array(labels.length);
  let hands = 0;
  for (let bucket = 0; bucket < solver.bucketCount; bucket += 1) {
    const weight = weights[bucket];
    const mix = solver.strategyAt(solver.tree.root, bucket);
    for (let a = 0; a < labels.length; a += 1) totals[a] += weight * mix[a];
    hands += weight;
  }

  const cells = watched.map(([, bucket]) => {
    const mix = solver.strategyAt(solver.tree.root, bucket);
    return Array.from(mix, pct).join(' ').padEnd(20);
  });
  console.log(
    `${(done / 1e6).toFixed(0)}M`.padEnd(12)
    + Array.from(totals, (v) => pct(v / hands)).join(' ').padEnd(22)
    + cells.join(''),
  );
}
console.log(`\n${((Date.now() - started) / 1000).toFixed(0)}s`);
