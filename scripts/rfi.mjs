/**
 * Raise-first-in by position, which is the number a player can check by eye.
 *
 *   node --max-old-space-size=8000 scripts/rfi.mjs [--players 7] [--joint] [--to 20000000]
 *     [--algorithm cfr+|dcfr] [--stored 10000000]
 *
 * `--stored` reads a solve `serve.js` already saved instead of running one, so
 * the numbers are the ones the strategy browser shows.
 *
 * Also reports what snow candidates do at the draw - hands with no low to make
 * and no draw worth taking, which stand pat only because a pat hand that bets
 * wins pots a broken one cannot.
 */

import { parseHand, RANKS } from '../lib/cards.js';
import { handIndex } from '../lib/eval27.js';
import { DRAWING, PRE_DRAW, threeBetFlag } from '../lib/tree.js';
import { Solver } from '../lib/solve.js';
import { load, solveKey } from '../lib/checkpoint.js';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  ante: Number(flag('ante', 0.6)),
  anteMode: flag('ante-mode', 'each'),
  openTo: Number(flag('open', 3)),
  threeBetTo: threeBetFlag(flag('three-bet')),
  nodeLimit: 5e7,
};
const joint = argv.includes('--joint');
const target = Number(flag('to', 20000000));
const algorithm = flag('algorithm', 'cfr+');
const stored = argv.includes('--stored') ? Number(flag('stored')) : null;
const discount = argv.includes('--beta') ? { beta: Number(flag('beta')) } : undefined;
const explore = Number(flag('explore', 0));

const solver = new Solver({
  config, joint, abstraction: 'coarse', seed: 20260917, algorithm, discount, explore,
});

let head = null;
if (stored !== null) {
  const key = solveKey(config, joint, stored, algorithm, solver.discount, solver.explore);
  head = load(solver, resolve(dirname(fileURLToPath(import.meta.url)), '..', 'solves', key));
  if (!head) {
    console.error(`No stored solve matches ${key}.`);
    process.exit(1);
  }
}

// How many hands sit in each bucket, so a frequency is weighted by the deck.
const weights = new Float64Array(solver.bucketCount);
for (let i = 0; i < solver.bucketTable.length; i += 1) weights[solver.bucketTable[i]] += 1;
const allHands = solver.bucketTable.length;

const dead = config.ante * (config.anteMode === 'button' ? 1 : config.players);
console.log(`${config.players}-handed ${config.stack}bb, blinds ${config.smallBlind}/${config.bigBlind}`
  + `, ante ${config.ante} ${config.anteMode} (${dead.toFixed(1)}bb dead, `
  + `${(dead + config.smallBlind + config.bigBlind).toFixed(1)}bb to win)`);
console.log(`${joint ? 'joint' : 'pre-draw only'}: ${solver.nodes.length.toLocaleString()} nodes, `
  + `${solver.bucketCount} buckets${joint ? `, ${solver.showdownCount} showdown` : ''}, ${algorithm}`
  + `${head ? `, stored ${new Date(head.built).toLocaleString()}` : ''}\n`);

/** The chance this seat puts money in, folded round to it. */
function rfi(seat) {
  const id = solver.openingNode(seat);
  if (id < 0) return null;
  const node = solver.nodes[id];
  const fold = node.actions.findIndex((action) => action.kind === 'fold');
  let raising = 0;
  for (let bucket = 0; bucket < solver.bucketCount; bucket += 1) {
    const mix = solver.strategyAt(id, bucket);
    let plays = 0;
    for (let a = 0; a < mix.length; a += 1) if (a !== fold) plays += mix[a];
    raising += weights[bucket] * plays;
  }
  return raising / allHands;
}

const marks = [2e6, 5e6, 10e6, target].filter((m, i, all) => all.indexOf(m) === i && m <= target);
const seats = solver.names.map((_, seat) => seat).filter((seat) => solver.openingNode(seat) >= 0);

const line = () => seats.map((seat) => `${(rfi(seat) * 100).toFixed(0)}%`.padStart(6)).join('');

console.log('iterations   ' + seats.map((s) => solver.names[s].padStart(6)).join(''));
if (head) {
  console.log(`${(head.iterations / 1e6).toFixed(0)}M stored`.padEnd(13) + line());
} else {
  let done = 0;
  const started = Date.now();
  for (const mark of marks) {
    solver.run(mark - done);
    done = mark;
    console.log(`${(done / 1e6).toFixed(0)}M`.padEnd(13) + line());
  }
  console.log(`\n${((Date.now() - started) / 1000).toFixed(0)}s`);
}

// Snows: hands that could draw and choose not to, because a pat hand can bet.
if (joint) {
  // The draw a hand almost never reaches says nothing - its information set is
  // still sitting on the uniform strategy it started with. So the node with the
  // most traffic is the one worth reading, and the visit count is printed
  // beside every line so a number can be told from a starting position.
  let drawNode = null;
  let busiest = 0;
  for (const node of solver.nodes) {
    if (node.kind !== 'decision' || node.street !== DRAWING) continue;
    const hits = solver.evHits[node.id];
    if (!hits) continue;
    let total = 0;
    for (let i = 0; i < hits.length; i += 1) total += hits[i];
    if (total > busiest) {
      busiest = total;
      drawNode = node;
    }
  }

  if (drawNode) {
    console.log(`\nAt the busiest draw (${solver.names[drawNode.seat]}, `
      + `${Math.round(busiest).toLocaleString()} visits):`);
    const labels = drawNode.actions.map((a) => a.label);
    console.log(`  ${'hand'.padEnd(22)}${labels.map((l) => l.padStart(7)).join('')}    visits`);
    const candidates = [
      ['22558 low two pair', '2c2d5h5s8c'],
      ['33328 low trips', '3c3d3h2s8c'],
      ['44553 low two pair', '4c4d5h5s3c'],
      ['86432 a made eight', '8c6d4h3s2c'],
      ['J5432 convertible', 'Jc5d4h3s2c'],
      ['KQJ94 no blockers', 'Kc Qd Jh 9s 4c'],
    ];
    for (const [label, text] of candidates) {
      const bucket = solver.bucketTable[handIndex(parseHand(text))];
      const mix = solver.strategyAt(drawNode.id, bucket);
      const hits = solver.evHits[drawNode.id]?.[bucket] ?? 0;
      console.log(`  ${label.padEnd(22)}`
        // Array.from, not mix.map: a Float64Array maps to a Float64Array, and
        // every formatted percentage comes back as NaN.
        + Array.from(mix, (v) => `${(v * 100).toFixed(0)}%`.padStart(7)).join('')
        + `    ${Math.round(hits).toLocaleString()}`);
    }
  }
}
