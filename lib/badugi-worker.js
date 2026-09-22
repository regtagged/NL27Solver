/**
 * One thread of a parallel badugi solve.
 *
 * It builds its own solver from the description it was handed - its own tree,
 * scratch, deck and generator - and attaches to the strategy tables the main
 * thread allocated. Everything is private except those two buffers, which is
 * the whole point: the threads share what they are solving and share nothing
 * else.
 *
 * The discount step is deliberately not run here. It rewrites every regret in
 * the table, so it belongs to the one moment when nothing is walking, and the
 * main thread owns that moment.
 */

import { parentPort, workerData } from 'node:worker_threads';

import { stateAfter } from './tree.js';
import { BadugiSolver, badugiConfig } from './badugi-solve.js';
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

parentPort.on('message', (message) => {
  if (!message || !message.run) return;
  const before = solver.rejected;
  // `runBatch` rather than `run`: no discounting, no progress callback, and the
  // iteration counter is the worker's own rather than the solve's.
  solver.runBatch(message.run, message.at);
  parentPort.postMessage({ ran: message.run, rejected: solver.rejected - before });
});
