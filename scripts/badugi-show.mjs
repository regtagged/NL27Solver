/**
 * Reads a solved badugi spot back as a range a player can look at.
 *
 *   node scripts/badugi-show.mjs [--spot btn-bb] [--decision 0] [--detail]
 *
 * The solve stores a strategy per hand *value* - 1,092 of them - which is the
 * right thing to compute and the wrong thing to read. This groups them the way
 * the hands are talked about: badugis by their high card, tris by theirs, and
 * the two-card holdings by name. Each row is weighted by combinations, so a
 * row's percentage is what happens at the table rather than the average over
 * distinct values, which would count A-2-3-4 the same as every nine-high tri
 * put together.
 *
 * `--detail` spells out the individual hands inside a row instead, for the rows
 * where the summary hides a disagreement.
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { handFacts } from '../lib/badugi-benchmark.js';
import { checkDraws } from '../lib/badugi-checks.js';

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = argv.indexOf(`--${name}`);
  return at >= 0 && at + 1 < argv.length ? argv[at + 1] : fallback;
};

const spot = flag('spot', 'btn-bb');
const file = resolve(here, '..', 'data', `badugi-${spot}.json`);
const data = JSON.parse(readFileSync(file));
const { hands } = handFacts();
const NAME = ['A', '2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K'];
const SIZE = { 4: 'badugi', 3: 'tri', 2: 'two-card', 1: 'one-card' };

/** How a hand is grouped for reading: its size and its high card. */
const groupOf = (hand) => (hand.size === 2 || hand.size === 1
  // Two-card holdings are few enough to name outright, and they are the ones a
  // range is actually written in terms of - A2, A3, 23.
  ? `${SIZE[hand.size]} ${hand.ranks.map((r) => NAME[r]).reverse().join('')}`
  : `${NAME[hand.ranks[0]]}-high ${SIZE[hand.size]}`);

const decision = Number(flag('decision', 0));
const line = data.spots[decision];
if (!line) {
  throw new Error(`--decision wants 0..${data.spots.length - 1}`);
}

console.log(`${data.what}`);
console.log(`  button opened ${data.preset.share.toFixed(1)}% of hands; `
  + `${data.iterations.toLocaleString()} iterations${data.complete ? '' : ' so far'}`);
console.log(`  reading: ${line.what}\n`);
data.spots.forEach((s, i) => {
  const mark = i === decision ? '>' : ' ';
  console.log(`  ${mark} [${i}] ${s.what.padEnd(22)} `
    + s.actions.map((a, j) => `${a.label} ${s.overall[j].toFixed(1)}%`).join('  '));
});

const labels = line.actions.map((a) => a.label);
const rows = new Map();
for (let hand = 0; hand < hands.length; hand += 1) {
  const key = groupOf(hands[hand]);
  if (!rows.has(key)) {
    rows.set(key, { combos: 0, weight: new Float64Array(labels.length), size: hands[hand].size });
  }
  const row = rows.get(key);
  const mix = line.hands[hand];
  row.combos += hands[hand].combos;
  // Sorted by the cards, not by their names: a ten sorts under a jack, which
  // alphabetically it does not.
  row.ranks ??= hands[hand].ranks;
  for (let a = 0; a < labels.length; a += 1) row.weight[a] += hands[hand].combos * mix[a];
}

const total = [...rows.values()].reduce((sum, row) => sum + row.combos, 0);
const order = [...rows.entries()].sort((a, b) => (b[1].size - a[1].size)
  || (a[1].ranks[0] - b[1].ranks[0])
  || ((a[1].ranks[1] ?? 0) - (b[1].ranks[1] ?? 0)));

console.log(`\n  ${'hand'.padEnd(18)} ${'% of deck'.padStart(9)}   `
  + labels.map((l) => l.padStart(9)).join(' '));
console.log(`  ${'-'.repeat(18)} ${'-'.repeat(9)}   ${labels.map(() => '-'.repeat(9)).join(' ')}`);
let lastSize = null;
for (const [key, row] of order) {
  if (lastSize !== null && row.size !== lastSize) console.log('');
  lastSize = row.size;
  const parts = labels.map((_, a) => `${(100 * row.weight[a] / row.combos).toFixed(1)}%`.padStart(9));
  console.log(`  ${key.padEnd(18)} ${`${(100 * row.combos / total).toFixed(2)}%`.padStart(9)}   ${parts.join(' ')}`);
}

if (argv.includes('--detail')) {
  console.log('\n  hand by hand, worst first inside each group:\n');
  for (let hand = hands.length - 1; hand >= 0; hand -= 1) {
    const mix = line.hands[hand];
    const text = hands[hand].ranks.map((r) => NAME[r]).reverse().join('');
    console.log(`  ${`${SIZE[hands[hand].size]} ${text}`.padEnd(18)} `
      + `${`${(100 * hands[hand].combos / total).toFixed(3)}%`.padStart(9)}   `
      + labels.map((_, a) => `${(100 * mix[a]).toFixed(1)}%`.padStart(9)).join(' '));
  }
}


/**
 * The dominance check, printed under the range.
 *
 * A hand short of a badugi that stands pat is giving up a free look at one:
 * drawing its dead cards away cannot make it worse. That is a snow when the
 * hand is bad for its size and has nothing to show down, and a starved
 * information set when the hand is good. Only the second is reported.
 */
const reports = checkDraws(data);
const flagged = reports.filter((report) => report.violations.length);
console.log('');
if (!reports.length) {
  console.log('  no draw decisions in this spot to check.');
} else if (!flagged.length) {
  const skipped = reports.reduce((n, r) => n + r.unreachable, 0);
  console.log(`  dominance check: ${reports.length} draw decisions, `
    + 'nothing reachable standing pat that should not be'
    + (skipped ? ` (${skipped} unreachable entries skipped).` : '.'));
} else {
  console.log(`  DOMINANCE CHECK: ${flagged.length} of ${reports.length} draw decisions have a`);
  console.log('  hand standing pat on a holding it should be improving. Drawing its dead');
  console.log('  cards away cannot make it worse, and these hands are too good for their');
  console.log('  size to be snowing - so these are starved nodes rather than strategy.\n');
  for (const report of flagged) {
    console.log(`  [${report.at}] ${report.what}`);
    for (const row of report.violations.slice(0, 8)) {
      console.log(`      ${row.label.padEnd(14)} pats ${(100 * row.pat).toFixed(0).padStart(3)}%`
        + `  (dominated by ${row.dominatedBy})`
        + `  reaches here ${(100 * row.reach).toFixed(0)}% of the time`
        + `, top ${(100 * row.standing).toFixed(0)}% of its size`
        + `, ${row.share.toFixed(2)}% of the deck`);
    }
    if (report.violations.length > 8) {
      console.log(`      …and ${report.violations.length - 8} more`);
    }
  }
}
