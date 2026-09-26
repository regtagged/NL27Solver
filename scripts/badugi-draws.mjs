/**
 * What each draw was worth, on the hands actually held.
 *
 *   node scripts/badugi-draws.mjs --file "phenom-export.txt" [--high J,Q]
 *        [--deals 40000] [--spot sb-bb] [--show 40]
 *
 * ## Why this is measured rather than read
 *
 * The solves run with `trackEv: false` - per-hand EV tables are another random
 * write into another big block at every visit, and a solve that is only after
 * the strategy does not need them. So the frequencies say *what* the solve
 * does and nothing says what it is worth, which is the question behind "drawing
 * to a jack cannot be right": a 30% draw-one is not an argument on its own,
 * because the alternative might be worse by a tenth of a bet or by a whole one.
 *
 * ## How a single decision is priced
 *
 * Take the line the real hand took as far as the hero's draw. Deal the rest of
 * the deck around the four cards the export named, weight the deal by how often
 * the opponent would have played the prefix holding what it was dealt, then
 * take each draw in turn and play the hand out with both seats drawing from
 * their average strategies. The average payoff over many deals is what that
 * draw is worth from where the hand actually stood.
 *
 * Two things make the comparison sharper than the noise it swims in:
 *
 * - **The deck is dealt once per trial.** Replacement cards are dealt up front,
 *   so drawing one and drawing two on the same trial receive the *same* cards.
 *   Nobody gets lucky in one arm and not the other.
 * - **The difference is paired.** Every arm is played on the same deal with the
 *   same random stream, so what is reported is the mean of per-trial
 *   differences and its own standard error - a much smaller number than the
 *   error on either arm alone, and the only one the comparison needs.
 *
 * Money is hundredths of a big blind counted from the start of the hand, the
 * same convention as `badugi-ev.mjs`, so the levels are comparable with it and
 * a difference of 10 is a tenth of a big blind.
 *
 * The opponent is the *solve's* opponent, not the one at the table. This says
 * which draw is better against a player who is playing the solve, which is the
 * question worth asking about one's own draw and not a read on anybody.
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { openSolve } from '../lib/badugi-browse.js';
import { badugiTable } from '../lib/badugi.js';
import { handFacts } from '../lib/badugi-benchmark.js';
import { handsFrom, follow, showCards, deckCard, NAMES } from '../lib/badugi-history.js';
import { priceActions } from '../lib/badugi-price.js';

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = argv.indexOf(`--${name}`);
  return at >= 0 && at + 1 < argv.length ? argv[at + 1] : fallback;
};

/* --------------------------------------------------------------------- main */

const file = flag('file', null);
if (!file) throw new Error('--file wants the path to a Phenom export');
const deals = Number(flag('deals', 40000));
const show = Number(flag('show', 40));
const want = flag('spot', null);
const seed = Number(flag('seed', 4242));
const highs = String(flag('high', 'J,Q')).toUpperCase().split(',')
  .map((c) => NAMES.indexOf(c.trim()));
const sizes = String(flag('size', '3')).split(',').map(Number);

const { labels } = badugiTable();
const { hands: facts } = handFacts();
const SIZE = { 4: 'badugi', 3: 'tri', 2: 'two-card', 1: 'one-card' };
// Named down to the last card, not just the high one. "J-high tri" is the
// wrong unit for this question: what a jack draws to depends on what is under
// it, and J-4-A and J-8-7 are not the same decision in any respect that
// matters.
const klassOf = (i) => `${SIZE[facts[i].size]} `
  + `${facts[i].ranks.map((r) => NAMES[r]).join('-')}`;

process.stdout.write('reading the export…');
const { badugis, found } = handsFrom(readFileSync(file, 'utf8'), labels);
process.stdout.write(` ${badugis.toLocaleString()} badugi hands\n`);

console.log(`Pricing every draw the hero made holding a `
  + `${sizes.map((s) => SIZE[s]).join(' or ')} of `
  + `${highs.map((h) => NAMES[h]).join(' or ')}, on ${deals.toLocaleString()} deals apiece.\n`
  + `Hundredths of a big blind, counted from the start of the hand.\n`);

const spots = want ? [want] : ['btn-bb', 'sb-bb'];
const overall = new Map();

for (const key of spots) {
  const hands = found[key];
  if (!hands.length) continue;
  // Big cache: everything under one draw is a few thousand blocks, and holding
  // them makes every rollout after the first a memory read.
  const solve = openSolve(key, { dir: resolve(here, '..', 'solves'), cache: 60000 });
  const { solver, names } = solve;

  // One decision may appear on many hands; it is priced once and reported for
  // each of them, because forty thousand rollouts is not free.
  const jobs = new Map();
  for (const hand of hands) {
    const fact = facts[hand.value];
    if (!sizes.includes(fact.size) || !highs.includes(fact.ranks[0])) continue;
    const { steps } = follow(solver, names, hand, key);
    for (const step of steps) {
      if (!step.hero || !step.drawing || !step.known) continue;
      const tag = `${step.line.join(',')}|${hand.value}`;
      if (!jobs.has(tag)) {
        jobs.set(tag, { tag, step, value: hand.value, cards: hand.cards, hands: [] });
      }
      jobs.get(tag).hands.push(hand);
    }
  }
  if (!jobs.size) continue;

  console.log(`\n${'='.repeat(78)}\n${key}: ${solve.head.iterations.toLocaleString()} iterations, `
    + `${jobs.size} distinct draw${jobs.size === 1 ? '' : 's'} `
    + `across ${[...jobs.values()].reduce((n, j) => n + j.hands.length, 0)} hands`
    + `\n${'='.repeat(78)}`);

  let printed = 0;
  for (const job of jobs.values()) {
    const { step } = job;
    const cards = job.cards.map(deckCard);
    // Everything is quoted against drawing one, whatever was actually played,
    // because that is the comparison being argued about. What was played is
    // marked separately and is a different question.
    const actions = solver.nodes[step.nodeId].actions;
    const one = actions.findIndex((a) => a.option === 1);
    const baseline = one >= 0 ? one : step.at;
    const started = Date.now();
    const out = priceActions(solver, {
      line: step.line, seat: step.seat, cards, value: job.value, deals, seed, baseline,
    });
    if (printed >= show) continue;
    printed += 1;

    const mix = solver.averageAt(step.nodeId, job.value);
    const also = job.hands.length > 1 ? ` (and ${job.hands.length - 1} more)` : '';
    console.log(`\n  #${job.hands[0].id}  ${showCards(job.cards)}  ${klassOf(job.value)}`
      + `  -  ${step.seatName} draw, played ${step.label}${also}`);
    console.log(`     the solve plays  `
      + out.arms.map((arm, a) => `${arm.label} ${(100 * mix[a]).toFixed(0)}%`).join('   '));
    console.log(`     ${'option'.padEnd(8)} ${'bb/100'.padStart(9)} `
      + `${`vs ${out.arms[baseline].label}`.padStart(16)}`);
    for (const [a, arm] of out.arms.entries()) {
      const gap = a === baseline ? '-'
        : `${arm.versus.mean >= 0 ? '+' : ''}${arm.versus.mean.toFixed(1)} `
          + `± ${arm.versus.error.toFixed(1)}`;
      console.log(`     ${arm.label.padEnd(8)} ${arm.mean.toFixed(1).padStart(9)} `
        + `${gap.padStart(16)}${a === step.at ? '   <- played' : ''}`);
      if (a === baseline) continue;
      const tag = `${klassOf(job.value)}|${arm.label}`;
      const row = overall.get(tag) ?? {
        klass: klassOf(job.value), to: arm.label, n: 0, sum: 0, better: 0,
      };
      row.n += 1;
      row.sum += arm.versus.mean;
      if (arm.versus.mean > 2 * arm.versus.error) row.better += 1;
      overall.set(tag, row);
    }
    console.log(`     (${out.used.toLocaleString()} deals, `
      + `${Math.round(out.effective).toLocaleString()} of them effective, `
      + `${((Date.now() - started) / 1000).toFixed(1)}s)`);
  }
}

if (overall.size) {
  console.log(`\n${'='.repeat(78)}\nAveraged over the decisions above\n${'='.repeat(78)}\n`);
  console.log(`  ${'hand'.padEnd(14)} ${'instead of d1'.padEnd(14)} `
    + `${'spots'.padStart(5)} ${'mean gap'.padStart(9)} ${'ahead in'.padStart(9)}`);
  const order = [...overall.values()].sort((a, b) => a.klass.localeCompare(b.klass)
    || a.to.localeCompare(b.to));
  for (const row of order) {
    console.log(`  ${row.klass.padEnd(14)} ${row.to.padEnd(14)} `
      + `${String(row.n).padStart(5)} `
      + `${`${row.sum / row.n >= 0 ? '+' : ''}${(row.sum / row.n).toFixed(1)}`.padStart(9)} `
      + `${`${row.better}/${row.n}`.padStart(9)}`);
  }
  console.log('\n  A positive gap is that option beating the one-card draw, and'
    + '\n  "ahead in" counts the decisions where it beat it by two standard errors.');
}
