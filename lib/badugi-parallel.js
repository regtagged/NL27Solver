/**
 * One badugi solve, run on every core instead of one.
 *
 * The machine this was written on has twenty-four of them and the solver used
 * one, which is most of why a forty-million-iteration run was forty hours.
 * Measured before building any of this: eight independent solver processes each
 * held 65% of a lone process's rate, so the work scales and is not stuck behind
 * memory bandwidth.
 *
 * ## Why threads and not eight processes
 *
 * Eight processes are eight *separate solves*. CFR's regrets are a running
 * account of what each decision would have preferred, and two runs' accounts do
 * not add up - averaging their strategies is not the same answer as one run of
 * twice the length, and is not any answer in particular. So the threads have to
 * share the tables, which means `SharedArrayBuffer` and one set of them.
 *
 * ## The updates race, on purpose
 *
 * Workers read and write the same regrets with no locking. Two threads updating
 * one hand's row can interleave and lose an update - and that is fine here, the
 * standard "Hogwild" bargain: CFR is already an averaging process over sampled
 * deals, a lost update is indistinguishable from an iteration that went another
 * way, and the cost of making it exact is a lock on the hottest line in the
 * program. What is *not* left to chance is the discount step, which rewrites
 * every regret in the table: the workers are stopped for it.
 *
 * ## What runs where
 *
 * Each worker builds its own tree, its own scratch and its own deck - none of
 * which is shared - and its own generator, seeded apart so no two threads walk
 * the same deals. Only the two strategy tables are common. A worker is told to
 * run a batch, says when it is done, and the main thread decides whether it is
 * time to discount, to checkpoint, or to stop.
 */

import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { cpus } from 'node:os';

import { discountRegrets } from './solve.js';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * How many threads to use by default, from the measured curve rather than a
 * guess at one.
 *
 * On a 24-core, 32-thread i9-13900K, solving the 487k-node button-versus-blind
 * subgame:
 *
 * | workers | it/s | speedup | spawn | rss |
 * | --- | --- | --- | --- | --- |
 * | 1 | 241 | 1.0x | 2s | 6 GB |
 * | 4 | 579 | 2.4x | 9s | 9 GB |
 * | 8 | 947 | 3.9x | 29s | 13 GB |
 * | 12 | 1,070 | 4.4x | 28s | 17 GB |
 * | 16 | 1,080 | 4.5x | 37s | 20 GB |
 * | 20 | **1,169** | **4.9x** | 46s | 23 GB |
 * | 24 | 1,169 | 4.9x | 56s | 26 GB |
 *
 * **The knee is around twenty and the curve is flat after it.** Sixteen buys
 * one percent over twelve and twenty-four buys nothing over twenty, while every
 * worker costs another tree to build - a minute of startup by then - and about
 * 850 MB. The tables are shared, so that per-worker cost is the tree and the
 * scratch and nothing else.
 *
 * Four threads are left free, because a machine with every core saturated is
 * one nobody else can use while a ten-hour solve runs.
 */
export function defaultWorkers() {
  return Math.max(1, Math.min(20, cpus().length - 4));
}

/**
 * Runs `iterations` across `workers` threads, all solving into `solver`.
 *
 * `solver` must have been built with `shared: true`; its buffers are what the
 * workers attach to. Its own `iterations` count is advanced as they report, so
 * the checkpoint and the reports read the same as a single-threaded run.
 */
/**
 * The discount step, split across the threads that are stopped for it.
 *
 * It rewrites every regret in the table - 1.8 billion floats on the heads-up
 * game - and it has to happen with nothing walking, so it used to be the main
 * thread's alone while twenty others waited. They are already attached to the
 * buffer, the blocks are packed end to end inside it, and the operation is
 * element-wise, so a slice of the buffer is a slice of the work: no overlap, no
 * ordering, nothing to lock.
 *
 * Falls back to doing it here when there are no workers to hand it to, which is
 * every single-threaded run and every test.
 */
async function discountAcross(pool, solver, t, discount) {
  if (!pool.length || !solver.buffers) {
    discountRegrets(solver.regret, t, discount);
    return;
  }
  const floats = solver.tableFloats;
  const share = Math.ceil(floats / pool.length);
  await Promise.all(pool.map((worker, index) => new Promise((done, broken) => {
    const from = index * share;
    const to = Math.min(floats, from + share);
    if (from >= to) { done(); return; }
    worker.once('message', (message) => {
      if (message && message.discounted != null) done();
      else broken(new Error('a worker answered a discount with something else'));
    });
    worker.postMessage({ discount: { from, to, t, discount } });
  })));
}

export async function runParallel(solver, iterations, options = {}) {
  const {
    workers = defaultWorkers(),
    batch = 2000,
    onProgress = null,
    build,
    // Stops handing out batches once this says so, for a run bounded by time
    // rather than by a count - a rate measurement does not know in advance how
    // many iterations a minute is. Batches already handed out are waited for
    // rather than cut off, so the count comes back a little past the stopping
    // point and no thread is killed part way through a walk.
    until = null,
  } = options;

  if (!solver.preallocated) {
    throw new Error('a parallel run needs a solver built with shared: true');
  }

  // **The tables must still be views into the buffers the workers attach to.**
  // Anything that replaces one with a plain array - loading a checkpoint used
  // to - detaches the main thread from the memory being solved into, and
  // nothing else notices: the workers run, the rate looks right, the report
  // prints, and the numbers are whatever they were before. Nine hours went that
  // way once. It costs one comparison to refuse instead.
  const attached = (layer) => solver.nodes.every((node) => node.kind !== 'decision'
    || solver[layer][node.id]?.buffer === solver.buffers[layer]);
  for (const layer of ['regret', 'average']) {
    if (!attached(layer)) {
      throw new Error(`the ${layer} tables are no longer views into the shared buffer; `
        + 'the workers would solve into memory this thread cannot read');
    }
  }
  if (!build) {
    throw new Error('a parallel run needs `build`: how a worker makes its own solver');
  }

  const discount = solver.discount;
  // The discount rewrites every regret, so it cannot run while anything is
  // walking. Batches are sized so a step lands on a batch boundary rather than
  // stopping the world at an arbitrary moment.
  const step = discount ? discount.every : Infinity;

  const started = solver.iterations;
  let claimed = 0;   // handed out to workers
  let done = 0;      // reported back
  let nextDiscount = discount
    ? (Math.floor(started / step) + 1) * step - started
    : Infinity;

  const pool = [];
  const idle = [];
  let failure = null;

  const spawn = (index) => new Promise((ready, broken) => {
    const worker = new Worker(resolve(here, 'badugi-worker.js'), {
      workerData: {
        build,
        seed: (solver.rng.state ^ Math.imul(index + 1, 0x9e3779b9)) >>> 0,
        buffers: solver.buffers,
      },
    });
    worker.once('message', (message) => {
      if (message.ok) ready(worker);
      else broken(new Error(message.error));
    });
    worker.on('error', (error) => { failure ??= error; });
  });

  const spawning = Date.now();
  for (let i = 0; i < workers; i += 1) pool.push(await spawn(i));
  for (const worker of pool) idle.push(worker);
  // Each worker builds its own tree, which for a real subgame is seconds. Worth
  // knowing separately from the solving, and worth paying once per run rather
  // than once per batch.
  const spawnMs = Date.now() - spawning;
  const solving = Date.now();

  try {
    while (done < iterations && !failure && !(until && until(done))) {
      // Stop at the discount boundary, and never hand out more than is left.
      const ceiling = Math.min(iterations, done + nextDiscount);
      while (idle.length && claimed < ceiling) {
        const worker = idle.pop();
        const size = Math.min(batch, ceiling - claimed);
        claimed += size;
        worker.postMessage({ run: size, at: started + claimed - size });
        worker.once('message', (message) => {
          done += message.ran;
          solver.iterations = started + done;
          solver.rejected += message.rejected;
          // Pruning is counted in the threads and added up here, so the run can
          // report how much of the walk it is actually skipping rather than how
          // much it was hoped to.
          solver.pruneSkipped += message.skipped ?? 0;
          solver.pruneSeen += message.seen ?? 0;
          idle.push(worker);
          if (onProgress) onProgress(solver, done, iterations);
        });
      }

      await new Promise((settle) => setImmediate(settle));

      // Everything handed out has come back and a step is due: discount with
      // the threads stopped, which is the one place they must not be running.
      if (done >= ceiling && idle.length === pool.length) {
        if (discount && done < iterations) {
          await discountAcross(pool, solver, solver.iterations / step, discount);
          nextDiscount = step;
        } else if (done >= iterations) {
          break;
        }
      }
    }

    // Whatever is still out is waited for before the threads are stopped. A
    // worker terminated inside a walk leaves a half-applied update behind, in
    // tables the next checkpoint would then write to disk as though it were a
    // strategy.
    while (done < claimed && !failure) {
      await new Promise((settle) => setImmediate(settle));
    }
  } finally {
    await Promise.all(pool.map((worker) => worker.terminate()));
  }

  if (failure) throw failure;
  solver.lastRun = { spawnMs, solveMs: Date.now() - solving, workers, iterations };
  return solver;
}
