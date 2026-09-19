/**
 * Solves fixed-limit badugi and writes out the decisions worth reading.
 *
 *   node --max-old-space-size=12000 scripts/badugi.mjs [--players 2]
 *                                   [--iterations 10000000] [--seed 21]
 *                                   [--max-to-draw 2] [--explore 0.02]
 *
 * The whole strategy is 22,187 decisions by 1,092 hands, which is far too much
 * to write as JSON and not much use spelled out. What goes to disk is the
 * handful of decisions a player actually looks up - who opens what, who
 * continues against it, and what each seat does on the first draw - with every
 * hand under each. It is written at every milestone rather than at the end, so
 * a run that is stopped early is still worth something.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { positionNames, preDrawOrder, DRAWING } from '../lib/tree.js';
import { BadugiSolver, badugiConfig } from '../lib/badugi-solve.js';
import { badugiTable } from '../lib/badugi.js';

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = argv.indexOf(`--${name}`);
  return at >= 0 && at + 1 < argv.length ? Number(argv[at + 1]) : fallback;
};

const players = flag('players', 2);
const iterations = flag('iterations', 10000000);

// It counts *voluntary* entries and the big blind has not entered by posting,
// so a cap of two means the pot is usually heads-up and at most three-way.
const maxToDraw = argv.includes('--max-to-draw') ? flag('max-to-draw') : undefined;

/**
 * Exploration, and why a solve of this game wants it.
 *
 * The average strategy only accumulates where play actually goes, so a hand
 * that opens 0% never trains its own post-open decisions - and opening then
 * gets priced as opening and playing randomly, which is worse than folding, so
 * it stays at 0% whichever way round it should have been. The seat this costs
 * most is the button, whose hands are worth what they are worth *for how they
 * play after*, which is exactly what never gets trained.
 *
 * `lib/solve.js` has carried this for 2-7 for a while; badugi was constructed
 * without it, which is the first thing to rule out when a strategy opens the
 * button tighter than UTG. It is deliberately not importance-weighted: the
 * correct weighting gives an explored line weight zero, which is the whole
 * thing it is there to fix. The bias is O(ε).
 */
const explore = flag('explore', 0.02);

const config = badugiConfig({ players, maxToDraw });
const solver = new BadugiSolver({
  config, seed: flag('seed', 21), trackEv: false, explore,
});
const { labels, combos } = badugiTable();
const names = positionNames(players);

console.log(`Fixed-limit badugi, ${players}-handed, three draws, ceiling 2,1,1 `
  + `(the big blind may take three first)`
  + `${config.maxToDraw == null ? '' : `, at most ${config.maxToDraw} seats entering`}.`);
console.log(`${solver.nodes.length.toLocaleString()} nodes, ${solver.handCount} hand values, `
  + `${solver.cardsNeeded} of 52 cards a deal.`);
console.log(`${iterations.toLocaleString()} iterations, exploring `
  + `${(100 * explore).toFixed(1)}% of the time…\n`);

/** The decisions worth writing down, found by walking rather than by id. */
function spots() {
  const found = [];
  const seen = new Set();
  const add = (id, what) => {
    if (id < 0 || seen.has(id)) return;
    const node = solver.nodes[id];
    if (!node || node.kind !== 'decision') return;
    seen.add(id);
    found.push({ id, what, seat: node.seat, street: node.street });
  };

  for (const seat of preDrawOrder(players)) {
    const open = solver.openingNode(seat);
    add(open, `${names[seat]} first in`);
    if (open < 0) continue;
    const raise = solver.nodes[open].actions.find((a) => a.kind === 'raise');
    if (!raise) continue;
    // Whoever answers the open, the draw that follows, and the round after it.
    // Counting the draws as they go past is what keeps the labels honest: a
    // seat acting after a draw is not a seat facing an open.
    let id = raise.child;
    let draws = 0;
    for (let guard = 0; guard < 10 && id >= 0; guard += 1) {
      const node = solver.nodes[id];
      if (!node || node.kind !== 'decision') break;
      if (node.street === DRAWING) {
        add(id, `${names[node.seat]} draw ${draws + 1}, ${names[seat]} opened`);
        const pat = node.actions[0];
        id = pat ? pat.child : -1;
        if (node.seat === preDrawOrder(players)[players - 1]) draws += 1;
        continue;
      }
      add(id, draws === 0
        ? `${names[node.seat]} facing ${names[seat]}'s open`
        : `${names[node.seat]} after draw ${draws}, all pat`);
      const call = node.actions.find((a) => a.kind === 'call');
      const check = node.actions.find((a) => a.kind === 'check');
      const fold = node.actions.find((a) => a.kind === 'fold');
      id = (call ?? check ?? fold)?.child ?? -1;
    }
  }
  return found;
}

const watched = spots();

function report(final) {
  const out = {
    built: new Date().toISOString(),
    config,
    iterations: solver.iterations,
    complete: final,
    names,
    labels,
    combos: Array.from(combos),
    spots: watched.map(({ id, what, seat, street }) => {
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
        drawing: street === DRAWING,
        actions: node.actions.map((a) => ({ label: a.label, kind: a.kind })),
        overall: Array.from(mix, (v) => Number((100 * v / total).toFixed(2))),
        hands: perHand,
      };
    }),
  };
  const file = resolve(here, '..', 'data', `badugi-${players}p.json`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(out));
  return out;
}

const started = Date.now();
const every = Math.max(1, Math.round(iterations / 20));
solver.run(iterations, (s) => {
  if (s.iterations % every !== 0) return;
  report(false);
  const seconds = (Date.now() - started) / 1000;
  const left = (iterations - s.iterations) / (s.iterations / seconds);
  console.log(`  ${(s.iterations / 1e6).toFixed(1)}M  ${Math.round(s.iterations / seconds)}/s  `
    + `${(s.memory() / 1e9).toFixed(2)}GB  ${(left / 60).toFixed(0)} min left`);
});

const out = report(true);
console.log(`\n  ${((Date.now() - started) / 1000 / 60).toFixed(0)} minutes\n`);
for (const spot of out.spots) {
  const line = spot.actions
    .map((a, i) => `${a.label} ${spot.overall[i].toFixed(1)}%`)
    .join('  ');
  console.log(`  ${spot.what.padEnd(34)} ${line}`);
}
