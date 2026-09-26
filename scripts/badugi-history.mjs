/**
 * Real badugi hands, read out of a Phenom Poker export and priced by the solve.
 *
 *   node --max-old-space-size=24000 scripts/badugi-history.mjs \
 *        --file "mixedtracker-phenom-poker-hands.txt" [--spot btn-bb] [--show 20]
 *
 * The reading and the replaying live in `lib/badugi-history.js`; what is here is
 * the pricing. A hand's decision is shown with the mix the solve plays for the
 * exact four cards the export named, and only while the hero still holds them -
 * past its own draw the strategy is indexed by a value nobody wrote down, and
 * `browse` says so rather than answering anyway.
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { openSolve, browse } from '../lib/badugi-browse.js';
import { badugiTable } from '../lib/badugi.js';
import { handFacts } from '../lib/badugi-benchmark.js';
import { handsFrom, follow, showCards, NAMES } from '../lib/badugi-history.js';

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = argv.indexOf(`--${name}`);
  return at >= 0 && at + 1 < argv.length ? argv[at + 1] : fallback;
};

const file = flag('file', null);
if (!file) throw new Error('--file wants the path to a Phenom export');
const want = flag('spot', null);
const show = Number(flag('show', 20));

const { labels, combos } = badugiTable();
const { hands: facts } = handFacts();
const SIZE = { 4: 'badugi', 3: 'tri', 2: 'two-card' };
const klassOf = (i) => (facts[i].size >= 3
  ? `${NAMES[facts[i].ranks[0]]}-high ${SIZE[facts[i].size]}`
  : facts[i].size === 2
    ? `two-card ${facts[i].ranks.map((r) => NAMES[r]).join('')}`
    : `monotone ${NAMES[facts[i].ranks[0]]}`);

process.stdout.write('reading the export…');
const { blocks, badugis, found } = handsFrom(readFileSync(file, 'utf8'), labels);
process.stdout.write(` ${blocks.toLocaleString()} hands\n`);

console.log(`${badugis.toLocaleString()} badugi hands; `
  + `${found['btn-bb'].length} reach BTN vs BB and `
  + `${found['sb-bb'].length} reach SB vs BB with the hero in the spot.\n`);

const spots = want ? [want] : ['btn-bb', 'sb-bb'];

for (const key of spots) {
  const hands = found[key];
  if (!hands.length) continue;
  const solve = openSolve(key, { dir: resolve(here, '..', 'solves') });
  console.log(`\n${'='.repeat(78)}\n${key}: ${solve.head.iterations.toLocaleString()} iterations, `
    + `${hands.length} hands in the sample\n${'='.repeat(78)}`);

  const tally = { priced: 0, decisions: 0, offBook: [] };
  let printed = 0;
  for (const hand of hands) {
    const { steps, stop } = follow(solve.solver, solve.names, hand, key);
    const mine = steps.filter((s) => s.hero);
    if (!mine.some((s) => s.known)) continue;
    tally.priced += 1;
    const loud = printed < show;
    if (loud) printed += 1;

    if (loud) console.log(`\n  #${hand.id}  ${showCards(hand.cards)}  ${klassOf(hand.value)}`
      + `  (hero is ${hand.seat}, $${hand.bigBlind} big blind)`);
    for (const step of mine) {
      const out = browse(solve.solver, step.line, {
        names: solve.names, combos, hand: hand.value,
      });
      if (!step.known) {
        if (loud) console.log(`     ${out.node.what.padEnd(20)} played ${step.label.padEnd(10)}`
          + '   - hand unknown from here, it has drawn');
        continue;
      }
      tally.decisions += 1;
      const mix = out.node.yours.mix;
      const freq = mix[step.at];
      const bar = step.actions.map((a, i) => `${a} ${(100 * mix[i]).toFixed(0)}%`).join('  ');
      const rare = freq < 0.05;
      if (rare) {
        const best = step.actions[mix.indexOf(Math.max(...mix))];
        tally.offBook.push({
          id: hand.id, cards: showCards(hand.cards), klass: klassOf(hand.value),
          what: out.node.what, took: step.label, freq, best, seat: hand.seat,
        });
      }
      if (loud) console.log(`   ${rare ? '<' : ' '} ${out.node.what.padEnd(20)} played ${step.label.padEnd(10)} `
        + `${(100 * freq).toFixed(0).padStart(3)}%   [${bar}]`);
    }
    if (loud && stop) console.log(`     (ends: ${stop})`);
  }

  console.log(`\n  ${tally.priced} hands priced across ${tally.decisions} decisions; `
    + `${tally.offBook.length} of those are actions the solve takes under 5% of the time.`);
  if (tally.offBook.length) {
    console.log('\n  The ones off book:');
    for (const off of tally.offBook.slice(0, 25)) {
      console.log(`    ${off.cards}  ${off.klass.padEnd(15)} ${off.what.padEnd(19)}`
        + ` played ${off.took.padEnd(10)} (${(100 * off.freq).toFixed(1)}%)`
        + `  the solve plays ${off.best}`);
    }
  }
}
