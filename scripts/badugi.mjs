/**
 * Solves fixed-limit badugi and writes out the decisions worth reading.
 *
 *   node --max-old-space-size=12000 scripts/badugi.mjs [--players 2]
 *                                   [--iterations 10000000] [--seed 21]
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

import { tripleDrawConfig, positionNames, preDrawOrder, DRAWING } from '../lib/tree.js';
import { BadugiSolver } from '../lib/badugi-solve.js';
import { badugiTable } from '../lib/badugi.js';

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = argv.indexOf(`--${name}`);
  return at >= 0 && at + 1 < argv.length ? Number(argv[at + 1]) : fallback;
};

const players = flag('players', 2);
const iterations = flag('iterations', 10000000);
const config = tripleDrawConfig({
  players,
  allowLimp: false,
  coldCallSeats: ['BTN', 'BB'],
  coldCallThreeBets: false,
  maxToDraw: null,
  maxDraw: [2, 1, 1],
  maxDrawBySeat: { BB: [3, 1, 1] },
  limit: { smallBet: 1, bigBet: 2, bigBetFrom: 2, cap: 3 },
  nodeLimit: 9e6,
});

const solver = new BadugiSolver({ config, seed: flag('seed', 21), trackEv: false });
const { labels, combos } = badugiTable();
const names = positionNames(players);

console.log(`Fixed-limit badugi, ${players}-handed, three draws, ceiling 2,1,1 `
  + `(the big blind may take three first).`);
console.log(`${solver.nodes.length.toLocaleString()} nodes, ${solver.handCount} hand values, `
  + `${solver.cardsNeeded} of 52 cards a deal.`);
console.log(`${iterations.toLocaleString()} iterations…\n`);

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
