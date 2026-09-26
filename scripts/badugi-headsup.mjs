/**
 * Heads-up badugi, solved whole.
 *
 *   node --max-old-space-size=40000 scripts/badugi-headsup.mjs --probe 90
 *   node --max-old-space-size=40000 scripts/badugi-headsup.mjs \
 *        [--iterations 1000000000] [--workers 8] [--save-every 20] [--fresh]
 *        [--draws 4,3,2] [--cap 4] [--limp] [--label wide]
 *
 * The game is in `lib/badugi-headsup.js`, including what is and is not left out
 * of it. What is here is running it, and finding out how fast it runs.
 *
 * ## `--probe`
 *
 * Runs for a number of seconds and reports the rate, then says what a billion
 * iterations would cost at it. Nothing is written, so it is safe to run beside
 * nothing and cheap to run before committing a week.
 *
 * The rate is quoted *after* the workers have spawned, because spawning is a
 * tree built per thread and a minute of it says nothing about the hours after.
 * It also excludes the first batch each worker runs, which is slower than the
 * settled rate while the pages it touches are still cold.
 *
 * ## The worker count is decided by memory, not by cores
 *
 * The tables are shared, so a worker's own cost is its tree - and this tree is
 * nearly three times the subgame's. Measured at 1.7 KB a node, that is about
 * 2.3 GB each against 850 MB, so on a 128 GB box the count comes out in the
 * high teens rather than at the core count. The default is computed from what is
 * free and printed, so a run about to swap says so before it starts rather than
 * four hours in.
 *
 * It is also why sharing the tree is the cheapest speedup available here: it is
 * immutable and identical in every thread, and moving it into typed arrays in a
 * `SharedArrayBuffer` would return that whole cost and the minutes of spawning
 * with it.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { freemem, totalmem } from 'node:os';

import { badugiTable } from '../lib/badugi.js';
import { saveBadugi, loadBadugi } from '../lib/badugi-checkpoint.js';
import { runParallel } from '../lib/badugi-parallel.js';
import { walkSpots, buildReport } from '../lib/badugi-report.js';
import {
  HEADS_UP, headsUpSolver, headsUpBuild, tableBytes,
} from '../lib/badugi-headsup.js';

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = argv.indexOf(`--${name}`);
  return at >= 0 && at + 1 < argv.length ? argv[at + 1] : fallback;
};
const number = (name, fallback) => Number(flag(name, fallback));

const GB = 2 ** 30;
const probe = argv.includes('--probe') ? number('probe', 90) : 0;
const iterations = number('iterations', 1e9);
const saveEvery = number('save-every', 20);
const seed = number('seed', 21);

const over = {
  draws: String(flag('draws', HEADS_UP.draws.join(','))).split(',').map(Number),
  cap: number('cap', HEADS_UP.cap),
  allowLimp: argv.includes('--limp') ? true : HEADS_UP.allowLimp,
  seed,
  explore: number('explore', 0.02),
  // Both off switches exist for the same reason: so the thing they turn off can
  // be measured against its own absence on the same warm checkpoint, rather than
  // argued about.
  exploreDecay: argv.includes('--no-decay') ? null : number('explore-decay', HEADS_UP.exploreDecay),
  prune: argv.includes('--no-prune') ? null : { revisit: number('revisit', HEADS_UP.prune.revisit) },
};

// Variants get their own checkpoint. The draw ceilings and the limp change the
// game, and a checkpoint that describes a different one is detected and thrown
// away - so without a label, trying a wider tree costs the hours already spent
// on the narrower one.
const label = flag('label', null);
const slug = label ? `${HEADS_UP.key}-${label}` : HEADS_UP.key;

/**
 * How many threads the memory will take, which is the binding constraint here.
 *
 * The tables are allocated once and shared; each worker then costs a tree.
 * Leave the operating system a few gigabytes and the main thread its own tree,
 * and what is left divided by the per-worker cost is the honest answer - which
 * on this game is a single-digit number and not the core count.
 */
function workersThatFit(bytes, perWorker) {
  const spare = 6 * GB;
  const room = freemem() - bytes - perWorker - spare;
  return Math.max(1, Math.min(20, Math.floor(room / perWorker)));
}

console.log(`${HEADS_UP.what}`);
process.stdout.write('  building the tree…');
const built = headsUpSolver({ ...over, shared: true });
const { solver, config, names } = built;
const bytes = tableBytes(solver);
let decisions = 0;
for (const node of solver.nodes) if (node.kind === 'decision') decisions += 1;
console.log(` ${solver.nodes.length.toLocaleString()} nodes`);

// 1.7 KB a node is the measured cost of a tree in a worker, from the 850 MB the
// 487k-node subgame took. It is an estimate and it is used only to decide the
// thread count, which is printed so it can be argued with.
const perWorker = Math.round(1.7e3 * solver.nodes.length);
const workers = argv.includes('--workers')
  ? number('workers')
  : workersThatFit(bytes, perWorker);

console.log(`  ${decisions.toLocaleString()} decisions x ${solver.handCount} hand values `
  + `= ${(bytes / GB).toFixed(1)} GB of tables`);
console.log(`  draws ${over.draws.join(',')}, ${config.limit.cap} bets a round, `
  + `${over.allowLimp ? 'completing allowed' : 'raise or fold'}, `
  + `${solver.cardsNeeded} of 52 cards a deal`);
console.log(`  live: ${solver.live.map((s) => names[s]).join(' vs ')}; `
  + 'no preset range, no hand abstraction, played to showdown');
// Both of these change the answer, so both are said out loud on every run.
console.log(`  ${over.prune
  ? `pruning regret below ${solver.pruneBelow.toFixed(0)}, `
    + `${(100 * solver.pruneRevisit).toFixed(0)}% of iterations walking everything`
  : 'no pruning'}; exploring ${(100 * solver.explore).toFixed(1)}%`
  + `${over.exploreDecay ? `, halving every ${over.exploreDecay} discount steps` : ' throughout'}`);
console.log(`  memory: ${(totalmem() / GB).toFixed(0)} GB total, `
  + `${(freemem() / GB).toFixed(0)} GB free; ${workers} workers at about `
  + `${(perWorker / GB).toFixed(1)} GB of tree each`
  + `${argv.includes('--workers') ? ' (asked for)' : ' (what fits)'}`);

const checkpoint = resolve(here, '..', 'solves', `badugi-${slug}`);
const build = headsUpBuild(over);

/**
 * The checkpoint is read before the probe, not after.
 *
 * Pruning earns nothing on the first iteration - no regret is below the
 * threshold yet - so a rate measured from empty tables is a measurement of the
 * algorithm without the feature in it. What matters is the rate on a solve that
 * has been running, which is what the remaining days will be spent at, and that
 * means starting the probe from whatever is on disk.
 */
const resumed = argv.includes('--fresh') ? false : loadBadugi(solver, checkpoint);
if (resumed && resumed.mismatch) {
  console.log(`  a checkpoint exists but describes a different game `
    + `(${resumed.mismatch}); starting fresh. Pass --fresh to stop seeing this.`);
}
const already = resumed && !resumed.mismatch ? resumed.iterations : 0;

/* -------------------------------------------------------------------- probe */

if (probe) {
  console.log(`\n  probing for ${probe}s from `
    + `${already ? `${(already / 1e6).toFixed(2)}M iterations on disk` : 'empty tables'}`
    + `${over.prune ? `, pruning below ${solver.pruneBelow.toFixed(0)} with `
      + `${(100 * solver.pruneRevisit).toFixed(0)}% revisited` : ', pruning off'}…`);
  // A small batch, so the measurement lands near the time asked for instead of
  // overshooting it by a whole batch on every thread.
  const batch = 250;
  let began = 0;            // the first batch back, which is when solving starts
  let first = 0;
  let firstAt = 0;          // once every worker has run one batch
  let last = 0;
  let lastAt = 0;
  const freeBefore = freemem();

  await runParallel(solver, 1e9, {
    workers,
    batch,
    build,
    // Timed from the first batch home rather than from now. Spawning six trees
    // is over a minute, and a clock started before it can expire before a
    // single iteration has run - which is a measurement of nothing.
    until: () => began > 0 && Date.now() >= began + probe * 1000,
    onProgress: (s, done) => {
      const now = Date.now();
      if (!began) began = now;
      // The first batch from each worker is cold: pages of a 28 GB table that
      // nothing has touched are faulted in during it, and counting them makes
      // the rate look worse than the hours that follow.
      if (!first && done >= workers * batch) { first = done; firstAt = now; }
      last = done;
      lastAt = now;
    },
  });

  const warm = firstAt && lastAt > firstAt
    ? (last - first) / ((lastAt - firstAt) / 1000)
    : last / (((lastAt || Date.now()) - (began || Date.now() - 1)) / 1000);
  const rate = Number.isFinite(warm) && warm > 0
    ? warm
    : solver.iterations / (solver.lastRun.solveMs / 1000);
  const days = 1e9 / rate / 86400;
  console.log(`\n  ran:    ${last.toLocaleString()} iterations in `
    + `${((lastAt - began) / 1000).toFixed(0)}s`
    + `${firstAt ? `, ${(last - first).toLocaleString()} of them warm` : ' (never got warm)'}`);
  console.log(`  memory: ${((freeBefore - freemem()) / GB).toFixed(1)} GB taken by the run, `
    + `${(freemem() / GB).toFixed(0)} GB still free`);
  if (solver.pruneSeen > 0) {
    console.log(`  pruned: ${(100 * solver.pruneSkipped / solver.pruneSeen).toFixed(1)}% of the `
      + 'traverser action edges were skipped');
  }
  console.log(`\n  spawn:  ${(solver.lastRun.spawnMs / 1000).toFixed(0)}s for ${workers} `
    + `trees (paid once a run)`);
  console.log(`  warm:   ${Math.round(rate).toLocaleString()} iterations a second `
    + `across ${workers} workers`);
  console.log(`  a billion iterations: ${days.toFixed(1)} days `
    + `(${(days / 7).toFixed(1)} weeks) of wall clock`);
  for (const target of [10e6, 40e6, 160e6, 1e9]) {
    const d = target / rate / 86400;
    console.log(`    ${(target / 1e6).toString().padStart(5)}M  `
      + (d < 1 ? `${(d * 24).toFixed(1)} hours` : `${d.toFixed(1)} days`));
  }
  process.exit(0);
}

/* ---------------------------------------------------------------------- run */

console.log(already
  ? `\n  resuming at ${already.toLocaleString()}, up to ${iterations.toLocaleString()}…\n`
  : `\n  ${iterations.toLocaleString()} iterations…\n`);

const { labels, combos } = badugiTable();
const watched = walkSpots(solver, { follow: null, branches: [], names });

function report(final) {
  const out = buildReport(solver, {
    key: slug,
    what: HEADS_UP.what,
    line: [],
    config,
    preset: null,
    labels,
    combos,
    names,
    watched,
    final,
  });
  const file = resolve(here, '..', 'data', `badugi-${slug}.json`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(out));
  return out;
}

const togo = Math.max(0, iterations - already);
const started = Date.now();

/**
 * Both cadences are clocks, not milestones.
 *
 * A run this long has no useful milestone: a two-hundredth of a billion
 * iterations is three and a half hours, so a log keyed on iterations says
 * nothing for the first afternoon and a checkpoint keyed on one is hours of
 * work to lose. Time is the thing that matters to whoever is watching and the
 * thing that matters to whoever loses power, so time is what both use.
 */
const lineEvery = number('line-every', 5) * 60 * 1000;
let lastLine = Date.now();
let lastSave = Date.now();
let lastDone = 0;
let lastSkipped = 0;
let lastSeen = 0;

const progress = (s, done) => {
  const now = Date.now();
  const sinceLine = now - lastLine;
  if (sinceLine < lineEvery) return;
  const seconds = (now - started) / 1000;
  // The rate since the last line, not since the run began. Pruning earns nothing
  // at the start and more as the strategy sharpens, so an average over the whole
  // run hides the only thing worth watching - whether it is still speeding up.
  // The interval has to be measured before `lastLine` moves, or it is zero and
  // the rate is a whole interval's iterations reported as one second of them.
  const rate = (done - lastDone) / (sinceLine / 1000);
  const overall = done / seconds;
  const left = (togo - done) / rate;
  lastLine = now;
  lastDone = done;
  const skipped = s.pruneSeen
    ? `  ${(100 * (s.pruneSkipped - lastSkipped) / ((s.pruneSeen - lastSeen) || 1)).toFixed(1)}% pruned`
    : '';
  lastSkipped = s.pruneSkipped;
  lastSeen = s.pruneSeen;
  console.log(`  ${(s.iterations / 1e6).toFixed(2)}M  ${Math.round(rate)}/s `
    + `(${Math.round(overall)}/s avg)${skipped}  ${(seconds / 3600).toFixed(1)}h in, `
    + `${left / 86400 >= 1 ? `${(left / 86400).toFixed(1)}d` : `${(left / 3600).toFixed(1)}h`} to go`);
  // At 28.6 GB a save is minutes of disk, so it gets its own, slower clock -
  // but it is no longer behind a milestone, which is what made the first
  // checkpoint of a month-long run land three hours in.
  if (now - lastSave > saveEvery * 60 * 1000) {
    saveBadugi(solver, checkpoint, HEADS_UP.what);
    report(false);
    lastSave = Date.now();
    console.log(`         checkpointed at ${(s.iterations / 1e6).toFixed(2)}M `
      + `(${((Date.now() - now) / 1000).toFixed(0)}s to write)`);
  }
};

if (togo > 0) {
  await runParallel(solver, togo, { workers, batch: number('batch', 2000), build, onProgress: progress });
  saveBadugi(solver, checkpoint, HEADS_UP.what);
}
report(true);
console.log(`\n  ${solver.iterations.toLocaleString()} iterations. `
  + `Checkpoint in solves/badugi-${slug}.bin, report in data/badugi-${slug}.json.`);
