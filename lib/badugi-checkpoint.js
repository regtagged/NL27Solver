/**
 * Badugi solves, stopped and continued.
 *
 * `lib/checkpoint.js` stores a *finished* 2-7 solve: the average strategy and
 * the EV, and deliberately not the regrets, because "they are only needed to
 * carry on solving, and a stored solve is one that has stopped." Badugi's are
 * not stopped. A six-handed run is four hours and the thin information sets
 * want forty, so a run has to be something you add to rather than something you
 * start again - which means the regrets, and it means the deals.
 *
 * So this writes three things the other one does not:
 *
 * - **The regrets.** Without them a resumed run has the average strategy of a
 *   long solve and the regrets of a fresh one, and the next iteration undoes
 *   the last four hours.
 * - **The generator's state.** Restarting the deals from the seed re-trains on
 *   cards already seen, which is a slower way to the same place and biases the
 *   average toward whatever those deals happened to hold.
 * - **What was dealt and to whom** - the preset ranges and the live seats -
 *   because a file loaded onto a different subgame is not stale, it is wrong.
 *
 * The blocks are written one at a time rather than gathered into one buffer
 * first. A six-handed solve is 5.6 GB of strategy, and copying it to write it
 * would want that much again for no reason.
 */

import {
  openSync, readSync, writeSync, closeSync, statSync,
  readFileSync, writeFileSync, existsSync, mkdirSync,
} from 'node:fs';
import { dirname } from 'node:path';

import { fingerprint } from './checkpoint.js';

/**
 * Everything needed to carry on. `regret` first because it is the half that
 * makes this a checkpoint rather than a result.
 */
const LAYERS = ['regret', 'average', 'evSum', 'evHits'];

/** A cheap hash of a preset range, so a file cannot be read onto another one. */
export function rangeStamp(ranges) {
  if (!ranges) return null;
  const seats = Object.keys(ranges).map(Number).sort((a, b) => a - b);
  let hash = 2166136261;
  for (const seat of seats) {
    hash ^= seat;
    hash = Math.imul(hash, 16777619);
    const range = ranges[seat];
    for (let i = 0; i < range.length; i += 1) {
      hash ^= range[i];
      hash = Math.imul(hash, 16777619);
    }
  }
  return (hash >>> 0).toString(16);
}

/** What a file has to agree with before it may be read onto a solver. */
function identity(solver) {
  return {
    nodes: solver.nodes.length,
    handCount: solver.handCount,
    live: [...solver.live],
    rounds: solver.rounds,
    slotsPerSeat: solver.slotsPerSeat,
    explore: solver.explore,
    trackEv: solver.trackEv,
    discount: solver.discount ? { ...solver.discount } : null,
    ranges: rangeStamp(solver.presetRanges),
    fingerprint: fingerprint(solver.tree),
  };
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Writes a solve that can be continued.
 *
 * `label` is free text for whoever reads the header later - the spot's name,
 * usually. It is not checked, because what has to match is the tree and the
 * ranges, and those are checked exactly.
 */
export function saveBadugi(solver, file, label = null) {
  // Only which nodes have a block, per layer. Its length follows from the
  // node's action count and its offset from the running total, and deriving
  // both took the header from 27 MB to under two - which matters, because the
  // header is parsed before a resumed run can start.
  const ids = {};
  const parts = [];
  let at = 0;
  for (const layer of LAYERS) {
    const store = solver[layer];
    if (!store) continue;
    ids[layer] = [];
    for (let id = 0; id < store.length; id += 1) {
      if (!store[id]) continue;
      ids[layer].push(id);
      parts.push({ layer, id, length: store[id].length, at });
      at += store[id].length;
    }
  }

  mkdirSync(dirname(file), { recursive: true });
  // Written block by block. The alternative is a 5.6 GB copy of something that
  // is already in memory, to hand it to one write call.
  const handle = openSync(`${file}.bin`, 'w');
  try {
    for (const part of parts) {
      const block = solver[part.layer][part.id];
      writeSync(handle, Buffer.from(block.buffer, block.byteOffset, block.byteLength));
    }
  } finally {
    closeSync(handle);
  }

  writeFileSync(`${file}.json`, JSON.stringify({
    built: new Date().toISOString(),
    label,
    config: solver.config,
    iterations: solver.iterations,
    rejected: solver.rejected,
    // The deals carry on from here rather than from the seed. Both halves are
    // needed: `deal` shuffles the deck in place and never resets it, so the
    // order the cards are already in is as much of the state as the generator
    // is. Fifty-two bytes, and without them a resumed run is a different run
    // that merely looks like a continuation.
    rngState: solver.rng.state,
    deck: Array.from(solver.deck),
    ...identity(solver),
    ids,
  }));
  return { bytes: at * 4, entries: parts.length, iterations: solver.iterations };
}

/**
 * The blocks a header describes, rebuilt from the node ids it lists.
 *
 * A layer's block is one float per hand per action, except the EV layers which
 * are one per hand - the same shape `BadugiSolver.store` allocates. Rebuilding
 * it here rather than storing it is what keeps the header small, and the file's
 * byte length is checked against the total so a wrong guess cannot go unseen.
 */
function partsFrom(head, solver) {
  const parts = [];
  let at = 0;
  for (const layer of LAYERS) {
    for (const id of head.ids?.[layer] ?? []) {
      const node = solver.nodes[id];
      const width = layer === 'regret' || layer === 'average' ? node.actions.length : 1;
      const length = head.handCount * width;
      parts.push({ layer, id, length, at });
      at += length;
    }
  }
  return parts;
}

/**
 * Reads a solve back onto a solver built the same way, and returns its header.
 *
 * False rather than an exception when there is nothing to read or the file
 * describes a different game, so the caller's answer is simply to start one.
 * A mismatch is not recoverable by loading part of it: strategies are addressed
 * by node id, so the same index meaning a different decision is silent and
 * total.
 */
export function loadBadugi(solver, file) {
  if (!existsSync(`${file}.json`) || !existsSync(`${file}.bin`)) return false;

  const head = JSON.parse(readFileSync(`${file}.json`));
  const want = identity(solver);
  for (const key of Object.keys(want)) {
    if (!same(head[key], want[key])) return { mismatch: key, head };
  }

  const parts = partsFrom(head, solver);
  const expected = parts.reduce((sum, part) => sum + part.length, 0) * 4;
  if (statSync(`${file}.bin`).size !== expected) return { mismatch: 'size', head };

  const handle = openSync(`${file}.bin`, 'r');
  try {
    for (const part of parts) {
      const existing = solver[part.layer][part.id];
      if (existing && existing.length === part.length) {
        // **Read into the block rather than over it.** A preallocated table is
        // a view into `solver.buffers`, and replacing it with a fresh array
        // detaches the solver from the memory its workers are writing to -
        // silently, because everything still runs and every number still comes
        // out. That is exactly what happened to a forty-million-iteration run:
        // the main thread reported the checkpoint it had loaded, unchanged,
        // while twenty threads solved into a buffer nothing read.
        const into = Buffer.from(existing.buffer, existing.byteOffset, existing.byteLength);
        readSync(handle, into, 0, into.byteLength, part.at * 4);
        continue;
      }
      const block = new Float32Array(part.length);
      const view = Buffer.from(block.buffer, 0, block.byteLength);
      readSync(handle, view, 0, view.byteLength, part.at * 4);
      solver[part.layer][part.id] = block;
      solver.bytes += block.byteLength;
    }
  } finally {
    closeSync(handle);
  }

  solver.iterations = head.iterations;
  solver.rejected = head.rejected ?? 0;
  if (head.rngState != null) solver.rng.state = head.rngState;
  if (head.deck) solver.deck.set(head.deck);
  return head;
}

/** Whether a file is there and describes this solver, without reading 5 GB. */
export function inspectBadugi(solver, file) {
  if (!existsSync(`${file}.json`)) return null;
  const head = JSON.parse(readFileSync(`${file}.json`));
  const want = identity(solver);
  const mismatch = Object.keys(want).find((key) => !same(head[key], want[key]));
  return { head, mismatch: mismatch ?? null };
}
