/**
 * One badugi spot, solved exactly, against a preset opening range.
 *
 *   node --max-old-space-size=20000 scripts/badugi-subgame.mjs --spot btn-bb
 *        [--btn-range 45] [--iterations 10000000] [--draws 3,2,2] [--cap 4]
 *        [--seed 21] [--save-every 20] [--fresh]
 *
 * ## Why this is the thing to run
 *
 * The whole-game solve has to be pruned to fit, and its prunings are what make
 * its answers arguable: at most two seats may enter, cold calls are restricted,
 * and `HANDOFF.md` records that nobody can yet say what the entry cap does to
 * the opening ranges. **A spot solved on its own needs almost none of that.**
 * Fix the action that led there and two seats remain, so there is no cap to
 * apply, no cold-calling rule to write, four-bets fit, and the draw ceiling can
 * be the real one rather than the one the tree could afford.
 *
 * What comes out is exact in a way nothing else here is: no hand abstraction -
 * the solver runs on all 1,092 values - no rollout, and the hand played to
 * showdown. The approximation left is the preset range.
 *
 * **`sb-3bet` is the exception and says so on every run.** To solve what the
 * small blind 3-bets rather than assume it, the spot has to begin before the
 * small blind acts, which leaves the big blind live behind it - three seats,
 * and over 25 million nodes uncapped. It is capped at two entries instead, so
 * the big blind cannot come along once the small blind has, and the range is
 * solved as though nobody can follow. The banner prints that, and the report
 * shows the big blind folding 100% of the time, which is the cap rather than a
 * strategy.
 *
 * ## And that approximation is the whole story
 *
 * **The preset decides the answer.** This is a study of how the blinds should
 * play against a button opening *the range it was given*, and nothing in the
 * solve will notice if that range is wrong.
 *
 * The default is `buttonOpeningRange()` - all badugis, tris down to 965, and
 * A2, A3, 23, A4, A5, 24, 25 - which is 32.7% of hands and is *given* rather
 * than derived. `--btn-range 45` substitutes the best 45% by showdown strength
 * instead, and that is a different shape, not a looser version of the same one:
 * strength ordering opens a queen-high tri and folds A2, where the real range
 * does the reverse, because what a hand draws to is worth more here than what
 * it currently is. The script prints the range it used, every time, in the
 * terms a player would state it.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { stateAfter, positionNames, preDrawOrder, DRAWING } from '../lib/tree.js';
import { BadugiSolver, badugiConfig } from '../lib/badugi-solve.js';
import { buttonOpeningRange, rangeByShare, describeRange } from '../lib/badugi-benchmark.js';
import { badugiTable } from '../lib/badugi.js';
import { saveBadugi, loadBadugi } from '../lib/badugi-checkpoint.js';
import { runParallel, defaultWorkers } from '../lib/badugi-parallel.js';

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = argv.indexOf(`--${name}`);
  return at >= 0 && at + 1 < argv.length ? argv[at + 1] : fallback;
};
const number = (name, fallback) => Number(flag(name, fallback));

/**
 * The spots after a button open: the line that leads to each, what to do with
 * the prunings there, and which action to follow when walking the decisions
 * worth reporting.
 *
 * **`sb-3bet` starts before the small blind acts**, so its 3-betting range is
 * solved rather than assumed - what it 3-bets is the point of the spot, and a
 * line beginning after the 3-bet can never say. That leaves three seats live,
 * which does not fit uncapped: over 25 million nodes against 974,539 with the
 * entry cap at two. **The cap is doing something real to that answer.** Once
 * the small blind comes in the big blind may not, so the range is solved as
 * though nobody can come along behind, which makes it wider than one facing a
 * live big blind. That is the price of having the decision in the tree at all,
 * and it is worth paying only because the alternative is not having it.
 *
 * `btn-bb` needs no cap - folded to the big blind, two seats are left - and it
 * **already contains the big blind's 3-betting range**: the raise at its first
 * decision is that 3-bet. `bb-3bet` is the other side of the same thing, the
 * button answering it.
 */
const SPOTS = {
  'btn-bb': {
    what: 'BTN vs BB, single raised pot',
    line: ['fold', 'fold', 'fold', 'raise', 'fold'],
    over: {},
  },
  'sb-3bet': {
    what: 'SB vs BTN, from the small blind\'s own decision',
    line: ['fold', 'fold', 'fold', 'raise'],
    over: { maxToDraw: 2 },
    // Follow the 3-bet rather than the flat: it is the line the spot is for.
    follow: 'raise',
  },
  'bb-3bet': {
    what: 'BTN facing the BB\'s 3-bet',
    line: ['fold', 'fold', 'fold', 'raise', 'fold', 'raise'],
    over: {},
  },
};

const key = flag('spot', 'btn-bb');
const spot = SPOTS[key];
if (!spot) {
  throw new Error(`--spot wants one of ${Object.keys(SPOTS).join(', ')}; got "${key}"`);
}

const draws = String(flag('draws', '3,2,2')).split(',').map(Number);
const iterations = number('iterations', 10000000);
const saveEvery = number('save-every', 20);
const workers = number('workers', defaultWorkers());
const names = positionNames(6);
const btn = names.indexOf('BTN');

const config = badugiConfig({
  players: 6,
  // None of these mean anything with two players left, which is the point.
  maxToDraw: null,
  coldCallSeats: null,
  coldCallThreeBets: true,
  maxDraw: draws,
  maxDrawBySeat: null,
  limit: { smallBet: 1, bigBet: 2, bigBetFrom: 2, cap: number('cap', 4) },
  nodeLimit: 40e6,
  ...spot.over,
});

// The given range by default; `--btn-range 45` substitutes the best 45% by
// showdown strength instead, which is a different shape and says so.
const btnRange = argv.includes('--btn-range')
  ? rangeByShare(number('btn-range'))
  : buttonOpeningRange();
const from = stateAfter(config, spot.line);
const solver = new BadugiSolver({
  config,
  from,
  seed: number('seed', 21),
  trackEv: false,
  explore: number('explore', 0.02),
  presetRanges: { [btn]: btnRange },
  // Laid out in shared memory so the worker threads solve into these tables
  // rather than each into its own. It also means nothing allocates during the
  // walk, which is why a run no longer starts at a third of its settled rate.
  shared: workers > 1,
});

const { labels, combos } = badugiTable();

/**
 * The run is resumed where one exists, because these are hours long and the
 * thin information sets want more hours than anyone sits through at once.
 * `--iterations` is the total to reach, not the number to add, so asking for
 * 10M twice is 10M and not 20M - and asking for 20M after a 10M run adds ten.
 */
const checkpoint = resolve(here, '..', 'solves', `badugi-${key}`);
const resumed = argv.includes('--fresh') ? false : loadBadugi(solver, checkpoint);
if (resumed && resumed.mismatch) {
  console.log(`  a checkpoint exists but describes a different game (${resumed.mismatch}); `
    + 'starting fresh. Pass --fresh to stop seeing this.');
}
const already = resumed && !resumed.mismatch ? resumed.iterations : 0;

console.log(`${spot.what}`);
console.log(`  ${solver.nodes.length.toLocaleString()} nodes, ${solver.handCount} hand values, `
  + 'no abstraction, no rollout, played to showdown.');
console.log(`  draws ${draws.join(',')}, ${config.limit.cap} bets a round, `
  + `${solver.cardsNeeded} of 52 cards a deal.`);
console.log(`  live: ${solver.live.map((s) => names[s]).join(' vs ')}`
  // Said out loud rather than left in the config: with three seats live the cap
  // bars the last one from defending, and that widens the range being solved.
  + (config.maxToDraw == null ? '; no entry cap' : (() => {
    // Who the cap actually bars: the live seat that acts last before the draw,
    // once the ones before it have used up the places.
    const order = preDrawOrder(6).filter((seat) => solver.live.includes(seat));
    const last = names[order[order.length - 1]];
    const before = names[order[order.length - 2]];
    return `; entry capped at ${config.maxToDraw} - once ${before} comes in, ${last} may `
      + 'not, so this is solved as though nobody can follow';
  })()));
console.log(`  BTN opens ${btnRange.share.toFixed(1)}%: ${describeRange(btnRange)}`);
console.log(!already
  ? `  ${iterations.toLocaleString()} iterations…\n`
  : already >= iterations
    ? `  a checkpoint at ${already.toLocaleString()} iterations is already past `
      + `the ${iterations.toLocaleString()} asked for.\n`
    : `  resuming at ${already.toLocaleString()}, up to ${iterations.toLocaleString()}…\n`);

/** The decisions worth writing down, found by walking from the root. */
function spots() {
  const found = [];
  const seen = new Set();
  let id = solver.tree.root;
  for (let guard = 0; guard < 8 && id >= 0; guard += 1) {
    const node = solver.nodes[id];
    if (!node || node.kind !== 'decision' || seen.has(id)) break;
    seen.add(id);
    found.push({
      id,
      what: node.street === DRAWING
        ? `${names[node.seat]} first draw`
        : `${names[node.seat]} facing the bet`,
      seat: node.seat,
      drawing: node.street === DRAWING,
    });
    // Follow the line everyone continues on, which is where the reads are.
    const next = (guard === 0 && spot.follow
      ? node.actions.find((a) => a.kind === spot.follow) : null)
      ?? node.actions.find((a) => a.kind === 'call')
      ?? node.actions.find((a) => a.kind === 'check')
      ?? node.actions[0];
    id = next ? next.child : -1;
  }
  return found;
}

const watched = spots();

function report(final) {
  const out = {
    built: new Date().toISOString(),
    spot: key,
    what: spot.what,
    line: spot.line,
    config,
    preset: { seat: btn, share: btnRange.share },
    iterations: solver.iterations,
    complete: final,
    names,
    labels,
    combos: Array.from(combos),
    spots: watched.map(({ id, what, seat, drawing }) => {
      const node = solver.nodes[id];
      const mix = new Float64Array(node.actions.length);
      let total = 0;
      const perHand = [];
      for (let hand = 0; hand < solver.handCount; hand += 1) {
        const strategy = solver.averageAt(id, hand);
        const weight = combos[hand];
        for (let a = 0; a < strategy.length; a += 1) mix[a] += weight * strategy[a];
        total += weight;
        perHand.push(Array.from(strategy, (v) => Number(v.toFixed(4))));
      }
      return {
        id,
        what,
        seat,
        drawing,
        actions: node.actions.map((a) => ({ label: a.label, kind: a.kind })),
        overall: Array.from(mix, (v) => Number((100 * v / total).toFixed(2))),
        hands: perHand,
      };
    }),
  };
  const file = resolve(here, '..', 'data', `badugi-${key}.json`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(out));
  return out;
}

const togo = Math.max(0, iterations - already);
if (togo === 0) {
  console.log(`  already at ${already.toLocaleString()} iterations; ask for more to carry on.\n`);
}

const started = Date.now();
// Two cadences. The console line stays at twenty per run so a log is readable;
// the data file is rewritten on a clock, because the viewer polls it and a
// forty-million-iteration run would otherwise refresh it once every half hour.
const every = Math.max(1, Math.round(togo / 20));
const reportEvery = number('report-every', 45) * 1000;
let lastReport = 0;
let lastSave = Date.now();
let nextReport = every;

/** What a worker needs to build its own copy of this game. */
const build = {
  config: {
    players: 6,
    maxToDraw: null,
    coldCallSeats: null,
    coldCallThreeBets: true,
    maxDraw: draws,
    maxDrawBySeat: null,
    limit: config.limit,
    nodeLimit: 40e6,
    ...spot.over,
  },
  line: spot.line,
  explore: number('explore', 0.02),
  preset: { seat: btn, share: argv.includes('--btn-range') ? number('btn-range') : null },
};

const progress = (s) => {
  const done = s.iterations - already;
  const now = Date.now();
  // The file first, so the page is never more than  behind.
  if (now - lastReport >= reportEvery) {
    report(false);
    lastReport = now;
  }
  if (done < nextReport) return;
  nextReport = done + every;
  report(false);
  // Checkpointed on a clock rather than a milestone count, so a run that is
  // killed loses minutes and not hours whatever its length. The interval is a
  // flag because the file is gigabytes: saving a 5 GB subgame every ten minutes
  // across a forty-hour run is more than a terabyte written to lose, at most,
  // ten minutes of a run that has already cost two thousand.
  const saveNow = Date.now() - lastSave > saveEvery * 60 * 1000;
  if (saveNow) {
    saveBadugi(solver, checkpoint, spot.what);
    lastSave = Date.now();
  }
  const seconds = (Date.now() - started) / 1000;
  const left = (togo - done) / (done / seconds);
  console.log(`  ${(s.iterations / 1e6).toFixed(2)}M  ${Math.round(done / seconds)}/s  `
    + `${(s.memory() / 1e9).toFixed(2)}GB  ${(left / 60).toFixed(0)} min left`
    + `${saveNow ? '  (saved)' : ''}`);
};

if (workers > 1) {
  console.log(`  ${workers} threads into one set of tables; `
    + 'each builds its own tree first, which takes a moment.\n');
  await runParallel(solver, togo, { workers, build, onProgress: progress });
} else {
  solver.run(togo, progress);
}

const written = saveBadugi(solver, checkpoint, spot.what);
const out = report(true);
console.log(`\n  ${((Date.now() - started) / 1000 / 60).toFixed(0)} minutes`);
console.log(`  checkpoint: ${(written.bytes / 1e9).toFixed(2)} GB at `
  + `${written.iterations.toLocaleString()} iterations - run again with a higher`);
console.log('  --iterations to carry on from here.\n');
for (const line of out.spots) {
  const text = line.actions
    .map((a, i) => `${a.label} ${line.overall[i].toFixed(1)}%`)
    .join('  ');
  console.log(`  ${line.what.padEnd(26)} ${text}`);
}
console.log(`\n  The button was dealt ${btnRange.share.toFixed(1)}% of hands: `
  + `${describeRange(btnRange)}.`);
console.log('  Change that range and every number above changes. It is the one thing');
console.log('  here the solve cannot check for you.');
