/**
 * How much the solve actually saw at a decision, hand by hand.
 *
 *   node scripts/badugi-traffic.mjs --spot sb-bb --line 1,1,0,0
 *
 * A strategy table answers every question asked of it, including the ones it
 * has no information about. `averageAt` returns a uniform mix for a hand with
 * nothing in its block - that is a fact about the solver, not a read - and one
 * visit returns whatever that single visit happened to do. Both look exactly
 * like strategy on a page.
 *
 * The average table is accumulated reach-weighted strategy, so the mass in a
 * hand's row is proportional to how much traffic that hand's decision got. It
 * is not a visit count and the units mean nothing on their own; what means
 * something is the spread. A hand carrying a millionth of the mass of the hand
 * beside it has a number on the page that nobody should read.
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

const key = flag('spot', 'sb-bb');
const steps = String(flag('line', '')).split(',').map((s) => s.trim()).filter(Boolean);
const solve = openSolve(key, { dir: resolve(here, '..', 'solves') });
const { combos } = badugiTable();
const { hands } = handFacts();
const NAME = ['A', '2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K'];
const SIZE = { 4: 'badugi', 3: 'tri', 2: 'two-card' };
const nameOf = (h) => (h.size >= 3
  ? `${NAME[h.ranks[0]]}-high ${SIZE[h.size]}`
  : h.size === 2 ? `two-card ${h.ranks.map((r) => NAME[r]).reverse().join('')}`
    : h.ranks[0] <= 9 ? `monotone ${NAME[h.ranks[0]]}` : `quads ${NAME[h.ranks[0]]}`);

const out = browse(solve.solver, steps, { names: solve.names, combos });
if (!out.node) {
  console.log(`that line ends the hand: ${out.ending.what}`);
  process.exit(0);
}

const node = solve.solver.nodes[out.node.id];
const width = node.actions.length;
const block = solve.solver.average[out.node.id];

// Mass per hand, and the same number per class, so a rare hand inside a busy
// class is not hidden by it.
const mass = new Float64Array(solve.solver.handCount);
let total = 0;
for (let hand = 0; hand < solve.solver.handCount; hand += 1) {
  let sum = 0;
  if (block) for (let a = 0; a < width; a += 1) sum += block[hand * width + a];
  mass[hand] = sum;
  total += sum;
}

console.log(`${key}: ${solve.head.iterations.toLocaleString()} iterations`);
console.log(`  ${out.path.map((p) => `${p.who} ${p.label}`).join(' · ') || 'the first decision'}`);
console.log(`  ${out.node.what}: ${node.actions.map((a, i) => `${a.label} ${out.node.overall[i]}%`).join('  ')}`);
console.log(`  reach ${out.node.reach ? 'carried' : 'dropped (this seat has drawn)'}\n`);

const rows = new Map();
hands.forEach((h, i) => {
  const label = nameOf(h);
  if (!rows.has(label)) {
    rows.set(label, { label, size: h.size, ranks: h.ranks, mass: 0, combos: 0, w: new Float64Array(width) });
  }
  const row = rows.get(label);
  row.mass += mass[i];
  row.combos += h.combos;
  const strategy = solve.solver.averageAt(out.node.id, i);
  for (let a = 0; a < width; a += 1) row.w[a] += mass[i] * strategy[a];
});

const order = [...rows.values()].sort((a, b) => b.mass - a.mass);
const most = order[0]?.mass || 1;
const shown = Number(flag('rows', 24));

console.log(`  ${'hand'.padEnd(16)} ${'traffic'.padStart(9)} ${'vs busiest'.padStart(11)}   `
  + `${node.actions.map((a) => a.label.padStart(9)).join(' ')}`);
console.log(`  ${'-'.repeat(16)} ${'-'.repeat(9)} ${'-'.repeat(11)}   `
  + `${node.actions.map(() => '-'.repeat(9)).join(' ')}`);
for (const row of order.slice(0, shown)) {
  const share = row.mass / most;
  const mark = share < 1e-3 ? '  <- noise' : share < 1e-2 ? '  <- thin' : '';
  console.log(`  ${row.label.padEnd(16)} ${(100 * row.mass / (total || 1)).toFixed(3).padStart(8)}% `
    + `${share < 1e-4 ? share.toExponential(0) : `1 in ${Math.round(1 / share)}`}`.padStart(11)
    + `   ${node.actions.map((_, a) => `${(100 * row.w[a] / (row.mass || 1)).toFixed(1)}%`.padStart(9)).join(' ')}`
    + mark);
}

const quiet = order.filter((r) => r.mass / most < 1e-3);
console.log(`\n  ${order.length} classes here; ${quiet.length} carry less than a thousandth of the`
  + ' busiest one\'s traffic.');
if (quiet.length) {
  console.log(`  Those are: ${quiet.slice(0, 12).map((r) => r.label).join(', ')}`
    + `${quiet.length > 12 ? ', …' : ''}`);
  console.log('  Their frequencies are what the solver does with almost no information.');
}
