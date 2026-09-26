/**
 * One thread of a parallel badugi solve.
 *
 * It builds its own solver from the description it was handed - its own tree,
 * scratch, deck and generator - and attaches to the strategy tables the main
 * thread allocated. Everything is private except those two buffers, which is
 * the whole point: the threads share what they are solving and share nothing
 * else.
 *
 * The discount step is not *decided* here. It rewrites every regret in the
 * table, so it belongs to the one moment when nothing is walking, and the main
 * thread owns that moment - but it then hands each thread a slice of the pass to
 * do, because a thread stopped for a step may as well be doing a share of it.
 */

import { parentPort, workerData } from 'node:worker_threads';

import { stateAfter } from './tree.js';
import { BadugiSolver, badugiConfig } from './badugi-solve.js';
import { discountRange } from './solve.js';
import { buttonOpeningRange, rangeByShare, handFacts } from './badugi-benchmark.js';

const { build, seed, buffers } = workerData;

/**
 * A worker is told how to build its solver rather than sent one, because a
 * solver is a tree and gigabytes of tables and neither travels between threads.
 * The description has to name everything that changes the answer.
 */
function makeSolver() {
  const config = badugiConfig(build.config);
  const from = build.line ? stateAfter(config, build.line) : null;
  const presetRanges = build.preset
    ? {
      [build.preset.seat]: build.preset.share == null
        ? buttonOpeningRange()
        : rangeByShare(build.preset.share),
    }
    : null;

  return new BadugiSolver({
    config,
    from,
    presetRanges,
    seed,
    trackEv: false,
    explore: build.explore ?? 0,
    // Both of these change what the walk does, so a worker that did not get
    // them would be solving a different algorithm from the one the run reports -
    // exploring when it should have stopped, or walking what the main thread
    // believes is pruned.
    exploreDecay: build.exploreDecay ?? null,
    exploreFloor: build.exploreFloor,
    prune: build.prune ?? null,
    // The averaging weight is `t ** gamma` and every thread computes it for
    // itself, so a gamma set only on the main thread would have the workers
    // weighting their contributions by a different curve from the one the run
    // believes it is using.
    discount: build.discount ?? undefined,
    algorithm: build.algorithm ?? 'dcfr',
    // No discounting inside a worker: the main thread stops everything and does
    // it, because a step that rewrites the table cannot run beside a walk.
    shared: buffers,
  });
}

/**
 * A lock has to be rebuilt in every thread, not sent.
 *
 * It is keyed by node id and the workers build their own trees, so what travels
 * is the *description* - which decision, which hands, which action - and each
 * thread makes the tables itself. A worker that skipped this would solve the
 * unlocked game while the main thread reported a locked one, which is the
 * quietest way an experiment can come out wrong.
 */
function applyLocks(solver) {
  if (!build.lockBadugis) return;
  const root = solver.nodes[solver.tree.root];
  const raise = root.actions.findIndex((a) => a.kind === 'raise');
  if (raise < 0) throw new Error('nothing to raise with at the first decision');
  const { hands } = handFacts();
  const applies = new Uint8Array(solver.handCount);
  const mix = new Float32Array(solver.handCount * root.actions.length);
  for (let h = 0; h < hands.length; h += 1) {
    if (hands[h].size !== 4) continue;
    applies[h] = 1;
    mix[h * root.actions.length + raise] = 1;
  }
  solver.locks = [];
  solver.locks[solver.tree.root] = { applies, mix };
}

let solver = null;
try {
  solver = makeSolver();
  applyLocks(solver);
  parentPort.postMessage({ ok: true });
} catch (error) {
  parentPort.postMessage({ ok: false, error: error.message });
}

/**
 * The regret layer as one flat array, for a share of the discount step.
 *
 * The blocks are packed end to end in the buffer, so a slice of the buffer is a
 * slice of the work and no worker needs to know which decisions its share
 * covers. Built once: it is a view, not a copy.
 */
const flatRegret = new Float32Array(buffers.regret);

parentPort.on('message', (message) => {
  if (!message) return;
  // A share of the discount step. It rewrites every regret in the table, so it
  // runs with every thread stopped - and a thread that is stopped may as well
  // be doing a twentieth of it as watching the main thread do all of it.
  if (message.discount) {
    const { from, to, t, discount } = message.discount;
    discountRange(flatRegret, from, to, t, discount);
    parentPort.postMessage({ discounted: to - from });
    return;
  }
  if (!message.run) return;
  const before = solver.rejected;
  const skippedBefore = solver.pruneSkipped;
  const seenBefore = solver.pruneSeen;
  // `runBatch` rather than `run`: no discounting, no progress callback, and the
  // iteration counter is the worker's own rather than the solve's.
  solver.runBatch(message.run, message.at);
  parentPort.postMessage({
    ran: message.run,
    rejected: solver.rejected - before,
    skipped: solver.pruneSkipped - skippedBefore,
    seen: solver.pruneSeen - seenBefore,
  });
});
