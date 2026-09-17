/**
 * Rank every starting hand by equity and write the table the viewer reads.
 *
 *   node --max-old-space-size=6000 scripts/rank-hands.mjs [--trials 12000]
 *
 * Takes a couple of minutes. The result is derived, not authored, so it is not
 * committed - delete `data/ranked.json` and run this again to rebuild it.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeRng, RANKS, rankOf, formatCard } from '../lib/cards.js';
import { score, categoryOf, rank27, STRAIGHT } from '../lib/eval27.js';
import { handClasses, classLabel } from '../lib/ranking.js';
import { analyse, DRAW_LABELS, PAT, DRAW_ONE } from '../lib/abstraction.js';
import { equityOf } from '../lib/equity.js';

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, '..', 'data', 'ranked.json');

const argv = process.argv.slice(2);
const at = argv.indexOf('--trials');
const trials = at >= 0 ? Number(argv[at + 1]) : 12000;

/** How many replacement cards would turn this keep into a straight. */
function straightOuts(cards, kept) {
  if (!kept || kept.length !== 4) return 0;
  let outs = 0;
  const held = new Set(cards);
  for (let card = 0; card < 52; card += 1) {
    if (held.has(card)) continue;
    if (categoryOf(score([...kept, card])) === STRAIGHT) outs += 1;
  }
  return outs;
}

console.log(`Ranking every starting hand at ${trials.toLocaleString()} trials each.`);
const started = Date.now();

const classes = handClasses();
console.log(`${classes.length.toLocaleString()} rows found in ${((Date.now() - started) / 1000).toFixed(0)}s`);

const rows = [];
for (let i = 0; i < classes.length; i += 1) {
  const entry = classes[i];
  const info = analyse(entry.cards);
  const keepRanks = entry.option === PAT ? null
    : (entry.option === DRAW_ONE ? info.keep4 : info.keep3);

  // Which of the five cards survive the draw, in the order they are displayed.
  const shown = [...entry.cards].sort((x, y) => rankOf(y) - rankOf(x));
  const pool = keepRanks ? [...keepRanks] : null;
  const kept = shown.map((card) => {
    if (!pool) return true;
    const at2 = pool.indexOf(rankOf(card));
    if (at2 < 0) return false;
    pool.splice(at2, 1);
    return true;
  });

  rows.push({
    hand: classLabel(entry),
    ranks: entry.ranks,
    cards: shown.map(formatCard),
    kept,
    suited: entry.monotone,
    combos: entry.combos,
    draw: entry.option,
    keep: keepRanks ? keepRanks.map((rank) => RANKS[rank]).reverse().join('') : null,
    straightOuts: straightOuts(entry.cards, shown.filter((_, k) => kept[k])),
    rank: rank27(entry.cards),
    // Common random numbers: every hand faces the same sequence of shuffles.
    // Ranking depends on the *differences* between equities, and giving each
    // hand its own seed makes those differences the sum of two independent
    // errors - enough to put 7-6-5-3-2 below 7-6-5-4-2, which is simply wrong.
    hu: equityOf(entry.cards, 1, trials, makeRng(20260916)),
    three: equityOf(entry.cards, 2, trials, makeRng(20260916)),
  });

  if ((i + 1) % 500 === 0) {
    const secs = (Date.now() - started) / 1000;
    process.stdout.write(`\r  ${i + 1}/${classes.length}  ${secs.toFixed(0)}s`);
  }
}
process.stdout.write('\r');

// Equity decides, and where sampling cannot separate two hands the exact 2-7
// ranking does - it is free and it is not an estimate.
rows.sort((a, b) => b.hu - a.hu || a.rank - b.rank);

const total = rows.reduce((sum, row) => sum + row.combos, 0);
let running = 0;
for (const row of rows) {
  running += row.combos;
  row.cum = running / total; // share of the deck at least this strong
}

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify({
  built: new Date().toISOString(),
  trials,
  totalCombos: total,
  drawLabels: DRAW_LABELS,
  rows,
}));

const secs = (Date.now() - started) / 1000;
console.log(`${rows.length.toLocaleString()} hands, ${total.toLocaleString()} combos, in ${secs.toFixed(0)}s`);
console.log(`written to ${out}\n`);

for (const want of ['75432', 'K7543']) {
  for (const row of rows.filter((r) => r.hand.replace(/s$/, '') === want)) {
    console.log(`  ${row.hand.padEnd(7)} ${row.cards.join(' ').padEnd(18)}`
      + `${(row.hu * 100).toFixed(1).padStart(6)}%  ${row.combos.toLocaleString().padStart(5)} combos  `
      + `${DRAW_LABELS[row.draw]}`);
  }
}
