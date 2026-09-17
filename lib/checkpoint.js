/**
 * Solves, kept.
 *
 * A solve is minutes of work and the answer never changes, so paying for it
 * again on every restart is the difference between a tool you open and a tool
 * you schedule. What gets written is the average strategy and the EV - the
 * things the viewer reads - and not the regrets, which are scaffolding: they
 * are only needed to carry on solving, and a stored solve is one that has
 * stopped.
 *
 * The file is keyed by the game it solved, so two configurations sit side by
 * side rather than overwriting each other.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/** A name that says which game this is, so the file is self-describing. */
export function solveKey(config, joint, iterations) {
  const ante = config.ante ? `-a${config.ante}${config.anteMode}` : '';
  return `${config.players}p-${config.stack}bb-${config.smallBlind}_${config.bigBlind}${ante}`
    + `${joint ? '-joint' : '-predraw'}-${Math.round(iterations / 1e6)}M`;
}

/**
 * A cheap hash of the tree's shape.
 *
 * Stored strategies are addressed by node id, so a change to the tree makes an
 * old file not stale but wrong - the same index meaning a different decision.
 * Refusing to load one is the only safe answer, and re-solving is a cost; a
 * silently mismatched strategy is not.
 */
export function fingerprint(tree) {
  let hash = 2166136261;
  const eat = (text) => {
    for (let i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
  };
  for (const node of tree.nodes) {
    eat(node.kind);
    if (node.kind !== 'decision') continue;
    eat(`${node.seat}:${node.street}:`);
    for (const action of node.actions) eat(`${action.label},`);
  }
  return (hash >>> 0).toString(16);
}

const layers = ['average', 'evSum', 'evHits'];

export function save(solver, file) {
  const parts = [];
  let floats = 0;
  for (const layer of layers) {
    const store = solver[layer];
    for (let id = 0; id < store.length; id += 1) {
      if (!store[id]) continue;
      parts.push({ layer, id, length: store[id].length, at: floats });
      floats += store[id].length;
    }
  }

  const blob = new Float32Array(floats);
  for (const part of parts) blob.set(solver[part.layer][part.id], part.at);

  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(`${file}.bin`, Buffer.from(blob.buffer, 0, blob.byteLength));
  writeFileSync(`${file}.json`, JSON.stringify({
    built: new Date().toISOString(),
    config: solver.config,
    joint: solver.joint,
    iterations: solver.iterations,
    nodes: solver.nodes.length,
    buckets: solver.bucketCount,
    showdown: solver.showdownCount ?? null,
    fingerprint: fingerprint(solver.tree),
    parts,
  }));
  return { bytes: blob.byteLength, entries: parts.length };
}

/**
 * Reads a solve back onto a solver built from the same configuration.
 *
 * Returns false rather than throwing when there is nothing to load or the tree
 * has moved underneath it, so the caller's answer is simply to solve.
 */
export function load(solver, file) {
  if (!existsSync(`${file}.json`) || !existsSync(`${file}.bin`)) return false;

  const head = JSON.parse(readFileSync(`${file}.json`));
  if (head.nodes !== solver.nodes.length
    || head.buckets !== solver.bucketCount
    || head.joint !== solver.joint
    || head.fingerprint !== fingerprint(solver.tree)) {
    return false;
  }

  const raw = readFileSync(`${file}.bin`);
  const blob = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
  for (const part of head.parts) {
    const slice = blob.subarray(part.at, part.at + part.length);
    const copy = new Float32Array(part.length);
    copy.set(slice);
    solver[part.layer][part.id] = copy;
    solver.bytes += copy.byteLength;
  }
  solver.iterations = head.iterations;
  return head;
}
