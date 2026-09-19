/**
 * What an opening range actually makes by the last draw.
 *
 *   node scripts/measure-draws.mjs [--deals 1000000] [--seed 4]
 *
 * The button opens 32.7% of hands and roughly a fifth of those are already a
 * badugi; the rest are drawing. This plays the range out under the policy the
 * dominance lemma justifies - throw exactly the cards that are not playing,
 * which can never make the hand worse - and counts what is holding a badugi
 * after each draw.
 *
 * Card removal is one player's: four cards dealt, replacements from the other
 * 48. A real hand also has an opponent taking cards, which moves these by a
 * fraction of a point and is not what anybody means by "the odds of getting
 * there". `lib/badugi-solve.js` deals both seats and is where the numbers that
 * price a *decision* come from.
 */

import { freshDeck, makeRng, deal } from '../lib/cards.js';
import { score, sizeOf, describe } from '../lib/badugi.js';
import { keepFor } from '../lib/badugi-solve.js';
import { buttonOpeningRange, handFacts } from '../lib/badugi-benchmark.js';
import { badugiTable, handIndex } from '../lib/badugi.js';

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = argv.indexOf(`--${name}`);
  return at >= 0 && at + 1 < argv.length ? Number(argv[at + 1]) : fallback;
};

const deals = flag('deals', 1000000);
const rng = makeRng(flag('seed', 4));
const range = buttonOpeningRange();
const { table } = badugiTable();

// The ceiling the subgames use. A range with no one-card hands never needs
// more than two, so it does not bind here - but a wider range would.
const CEILING = [3, 2, 2];

const SIZES = [4, 3, 2];
const byStart = new Map(SIZES.map((size) => [size, { dealt: 0, made: [0, 0, 0] }]));
const overall = { dealt: 0, made: [0, 0, 0] };
const finalHigh = new Map();

const deck = freshDeck();
const keep = new Array(4);

for (let n = 0; n < deals; n += 1) {
  // A hand from the range, by rejection - which keeps card removal exact.
  let hand = null;
  for (let tries = 0; tries < 500; tries += 1) {
    deal(deck, 4 + 6, rng);
    const four = [deck[0], deck[1], deck[2], deck[3]];
    const sorted = [...four].sort((a, b) => a - b);
    if (range[table[handIndex(sorted)]]) { hand = four; break; }
  }
  if (!hand) throw new Error('the range is too narrow to deal');

  const started = sizeOf(score(hand));
  byStart.get(started).dealt += 1;
  overall.dealt += 1;

  // Replacements come off the same deck, after the four that were dealt.
  let cards = hand;
  let at = 4;
  for (let round = 0; round < 3; round += 1) {
    const size = sizeOf(score(cards));
    const want = Math.min(4 - size, CEILING[round]);
    if (want > 0) {
      const kept = keepFor(cards, want, keep);
      const next = new Array(4);
      for (let i = 0; i < kept; i += 1) next[i] = keep[i];
      for (let i = 0; i < want; i += 1) next[kept + i] = deck[at + i];
      at += want;
      cards = next;
    }
    if (sizeOf(score(cards)) === 4) {
      byStart.get(started).made[round] += 1;
      overall.made[round] += 1;
    }
  }

  const value = score(cards);
  if (sizeOf(value) === 4) {
    const top = describe(value).split(' ')[1][0];
    finalHigh.set(top, (finalHigh.get(top) ?? 0) + 1);
  }
}

const { total } = handFacts();
const pct = (a, b) => `${(100 * a / b).toFixed(1)}%`;

console.log(`The button's opening range, played out over three draws.`);
console.log(`${deals.toLocaleString()} deals, replacements off the same deck, `
  + `throwing exactly the cards that are not playing.\n`);
console.log(`  range: ${range.share.toFixed(1)}% of all hands\n`);

console.log('  holding a badugi after            draw 1    draw 2    draw 3');
console.log(`  ${'-'.repeat(30)} ${'-'.repeat(9)} ${'-'.repeat(9)} ${'-'.repeat(9)}`);
const label = { 4: 'dealt a badugi', 3: 'dealt a tri', 2: 'dealt two cards' };
for (const size of SIZES) {
  const row = byStart.get(size);
  if (!row.dealt) continue;
  console.log(`  ${`${label[size]} (${pct(row.dealt, overall.dealt)} of the range)`.padEnd(30)} `
    + row.made.map((made) => pct(made, row.dealt).padStart(9)).join(' '));
}
console.log(`  ${'-'.repeat(30)} ${'-'.repeat(9)} ${'-'.repeat(9)} ${'-'.repeat(9)}`);
console.log(`  ${'the whole range'.padEnd(30)} `
  + overall.made.map((made) => pct(made, overall.dealt).padStart(9)).join(' '));

console.log('\n  and what those badugis are, at the end:');
const NAMES = ['A', '2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K'];
let running = 0;
for (const name of NAMES) {
  const count = finalHigh.get(name) ?? 0;
  if (!count) continue;
  running += count;
  console.log(`    ${name} high or better   ${pct(running, overall.dealt).padStart(7)} of the range`);
}
