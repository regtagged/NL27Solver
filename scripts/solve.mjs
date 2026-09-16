/**
 * Run a pre-draw solve and print what it found.
 *
 *   node --max-old-space-size=8000 scripts/solve.mjs --iterations 2000000
 *
 * Options: --players --stack --sb --bb --ante --ante-mode --iterations --seed
 *          --limits pat,d1,d2   (rank letters, e.g. J,T,9)
 *          --post-draw threshold|none
 */

import { RANKS, parseHand } from '../lib/cards.js';
import { handIndex } from '../lib/eval27.js';
import { buckets, describe } from '../lib/abstraction.js';
import { Solver } from '../lib/solve.js';
import { BB } from '../lib/tree.js';

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = argv.indexOf(`--${name}`);
  return at >= 0 && at + 1 < argv.length ? argv[at + 1] : fallback;
};
const number = (name, fallback) => Number(flag(name, fallback));

const limitText = flag('limits', 'J,T,9').split(',');
const limits = {
  pat: RANKS.indexOf(limitText[0].toUpperCase()),
  keep4: RANKS.indexOf(limitText[1].toUpperCase()),
  keep3: RANKS.indexOf(limitText[2].toUpperCase()),
};

const config = {
  players: number('players', 7),
  stack: number('stack', 40),
  smallBlind: number('sb', 0.5),
  bigBlind: number('bb', 1),
  ante: number('ante', 0),
  anteMode: flag('ante-mode', 'none'),
  nodeLimit: 2e7,
};

const iterations = number('iterations', 500000);

console.log(`${config.players}-handed, ${config.stack}bb, blinds ${config.smallBlind}/${config.bigBlind}`
  + `${config.ante ? `, ante ${config.ante} (${config.anteMode})` : ''}`);
console.log(`detail ceilings: pat ${limitText[0]}, d1 ${limitText[1]}, d2 ${limitText[2]}`);

const setupStarted = Date.now();
const solver = new Solver({ config, limits, seed: number('seed', 1), postDraw: flag('post-draw', 'threshold') });
const { descriptors } = buckets(limits);
console.log(`tree ${solver.nodes.length.toLocaleString()} nodes, `
  + `${solver.bucketCount.toLocaleString()} buckets, set up in ${((Date.now() - setupStarted) / 1000).toFixed(1)}s\n`);

const started = Date.now();
solver.run(iterations, (s) => {
  const secs = (Date.now() - started) / 1000;
  process.stdout.write(`\r  ${s.iterations.toLocaleString()} iterations  `
    + `${Math.round(s.iterations / secs).toLocaleString()}/s  `
    + `${(s.memory() / 1024 ** 3).toFixed(2)} GB   `);
});
const elapsed = (Date.now() - started) / 1000;
process.stdout.write('\r');
console.log(`${solver.iterations.toLocaleString()} iterations in ${elapsed.toFixed(1)}s `
  + `(${Math.round(solver.iterations / elapsed).toLocaleString()}/s), `
  + `${(solver.memory() / 1024 ** 3).toFixed(2)} GB held\n`);

// Hands chosen to walk down the strength ladder: made lows first, then one-card
// draws by what they are drawing to, then a two-card draw, then nothing.
const REPRESENTATIVES = [
  '7c5d4h3s2c', '8c7d6h5s2c', '9c8d7h5s2c', 'Tc9d7h5s2c', 'Jc9d7h5s2c',
  'Kc7d5h4s3c', 'Kc8d5h4s3c', 'Kc9d7h5s4c', 'KcTd7h5s4c',
  'KcQd7h5s2c', 'AcKdQhJs9c',
];

const { table } = buckets(limits);
const bucketFor = (text) => table[handIndex(parseHand(text))];

const pct = (value) => (value * 100).toFixed(0).padStart(3);

for (let seat = 0; seat < config.players; seat += 1) {
  const nodeId = solver.openingNode(seat);
  if (nodeId < 0) continue;
  const node = solver.nodes[nodeId];
  const labels = node.actions.map((action) => action.label);

  console.log(`${solver.names[seat]} opening  (${labels.join(' / ')})`);

  // What the whole range does, weighted by how many hands sit in each bucket.
  const totals = new Float64Array(labels.length);
  let hands = 0;
  for (let bucket = 0; bucket < solver.bucketCount; bucket += 1) {
    const weight = descriptors[bucket].hands;
    const strategy = solver.strategyAt(nodeId, bucket);
    for (let a = 0; a < labels.length; a += 1) totals[a] += weight * strategy[a];
    hands += weight;
  }
  console.log(`  ${'every hand'.padEnd(22)}${labels.map((l, a) => `${l} ${pct(totals[a] / hands)}%`).join('  ')}`);

  for (const text of REPRESENTATIVES) {
    const strategy = solver.strategyAt(nodeId, bucketFor(text));
    const label = describe(parseHand(text));
    console.log(`  ${label.padEnd(22)}${labels.map((l, a) => `${l} ${pct(strategy[a])}%`).join('  ')}`);
  }
  console.log();
}
