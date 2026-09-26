/**
 * What a seat's range looks like at a decision, as a player would state it.
 *
 *   node scripts/badugi-ranges.mjs [--spot hu] [--line ""] [--top 30]
 *
 * `badugi-sweep.mjs` prices every class and says which ones are settled;
 * `badugi-traffic.mjs` says how much the solve saw of each. This answers the
 * plainer question those are built on top of - *what is the range* - by reading
 * the mix at one decision and weighting every class by how often it is dealt.
 *
 * Two readings are printed because a range has two honest summaries. The
 * **shape** is what it does with each family of hands, which is how a player
 * holds a range in their head. The **edges** are the classes it splits on, which
 * is where all the information is: a range that raises every badugi and folds
 * every two-card tells you nothing you did not know, and the twenty classes it
 * is genuinely mixing on are the strategy.
 *
 * Frequencies are weighted by combinations, not by class. There are 1,092
 * classes and they are not equally likely - a 4-high badugi is dealt once in
 * twenty thousand hands and a two-card 2-A once in seventy - so an average over
 * classes is not an average over hands and would misstate the range badly.
 */

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { openSolve, browse } from '../lib/badugi-browse.js';
import { badugiTable } from '../lib/badugi.js';
import { handFacts } from '../lib/badugi-benchmark.js';

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = argv.indexOf(`--${name}`);
  return at >= 0 && at + 1 < argv.length ? argv[at + 1] : fallback;
};

const key = flag('spot', 'hu');
const top = Number(flag('top', 30));
const steps = String(flag('line', '')).split(',').map((s) => s.trim()).filter(Boolean);

const NAME = ['A', '2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K'];
const SIZE = { 4: 'badugis', 3: 'tris', 2: 'two-card hands', 1: 'one-card hands' };
const { combos } = badugiTable();
const { hands: facts, total } = handFacts();

const solve = openSolve(key, { dir: resolve(here, '..', 'solves'), cache: 20000 });
const { solver, names } = solve;
const out = browse(solver, steps, { names, combos, hand: null });
if (!out.node) throw new Error(`that line ends the hand (${out.ending && out.ending.what})`);

const node = out.node;
const width = node.actions.length;
const labels = node.actions.map((a) => a.label);

console.log(`${key}: ${solve.head.iterations.toLocaleString()} iterations`);
console.log(`${node.what} - ${labels.join(' / ')}`);
if (steps.length) {
  console.log(`  after ${out.path.map((p) => `${p.who} ${p.label}`).join(', ')}`
    + `, a line played ${(100 * out.reached).toFixed(2)}% of the time`);
}

/**
 * The range's mix, by class and overall.
 *
 * `node.hands` is the strategy for every class; what turns it into a range is
 * the weight, and the weight is how often the class is dealt. Past a draw the
 * solve's own traffic replaces that, because a hand's value has changed and how
 * often it was dealt no longer says how often it is here.
 */
const weightOf = (hand) => (node.reach
  ? combos[hand] * node.reach[hand]
  : (node.traffic ? Number(node.traffic[hand]) : combos[hand]));

const rows = [];
const overall = new Float64Array(width);
let weighed = 0;
for (let hand = 0; hand < solver.handCount; hand += 1) {
  const weight = weightOf(hand);
  if (!weight) continue;
  const mix = node.hands[hand];
  for (let a = 0; a < width; a += 1) overall[a] += weight * mix[a];
  weighed += weight;
  rows.push({
    hand,
    mix,
    weight,
    share: combos[hand] / total,
    size: facts[hand].size,
    ranks: facts[hand].ranks,
    label: `${facts[hand].ranks.map((r) => NAME[r]).join('-')}`,
  });
}

console.log(`\n  the whole range: `
  + labels.map((l, a) => `${l} ${(100 * overall[a] / weighed).toFixed(1)}%`).join('   '));

/* ------------------------------------------------------------------- shape */

console.log(`\n  shape, by family and high card`);
// Not "% of deck": a class whose reach is zero has been folded out upstream and
// is skipped, so past the first decision this column is the share of the *deck*
// that is still in the range here. At the root the two are the same thing, which
// is exactly why labelling it "% of deck" everywhere would go unnoticed.
console.log(`  ${'hand'.padEnd(18)} ${(steps.length ? 'still in' : '% of deck').padStart(9)}  `
  + labels.map((l) => l.padStart(9)).join(' '));
const families = new Map();
for (const row of rows) {
  const tag = `${row.size}|${row.ranks[0]}`;
  const found = families.get(tag) ?? {
    size: row.size, high: row.ranks[0], weight: 0, share: 0, mix: new Float64Array(width),
  };
  found.weight += row.weight;
  found.share += row.share;
  for (let a = 0; a < width; a += 1) found.mix[a] += row.weight * row.mix[a];
  families.set(tag, found);
}
let lastSize = null;
for (const family of [...families.values()].sort((a, b) => (b.size - a.size) || (a.high - b.high))) {
  if (family.size !== lastSize) {
    console.log(`  ${SIZE[family.size]}`);
    lastSize = family.size;
  }
  console.log(`    ${`${NAME[family.high]}-high`.padEnd(16)} `
    + `${`${(100 * family.share).toFixed(2)}%`.padStart(9)}  `
    + labels.map((l, a) => `${(100 * family.mix[a] / family.weight).toFixed(1)}%`.padStart(9)).join(' '));
}

/* ------------------------------------------------------------------- edges */

// Mixed on something, ordered by how much of the deck is sitting on the fence.
// A class that is 100/0 is a rule; these are the decisions.
const mixed = rows
  .filter((row) => row.mix.filter((p) => p > 0.02 && p < 0.98).length > 0)
  .sort((a, b) => b.share - a.share)
  .slice(0, top);

console.log(`\n  the ${mixed.length} classes it is actually mixing on, `
  + `${(100 * mixed.reduce((sum, r) => sum + r.share, 0)).toFixed(1)}% of the deck`);
console.log(`  ${'hand'.padEnd(18)} ${(steps.length ? 'still in' : '% of deck').padStart(9)}  `
  + labels.map((l) => l.padStart(9)).join(' '));
for (const row of mixed) {
  console.log(`    ${`${SIZE[row.size].replace(/s$/, '')} ${row.label}`.padEnd(16)} `
    + `${`${(100 * row.share).toFixed(2)}%`.padStart(9)}  `
    + labels.map((l, a) => `${(100 * row.mix[a]).toFixed(1)}%`.padStart(9)).join(' '));
}
