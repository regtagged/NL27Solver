/**
 * What each seat makes in a solved badugi spot, and which hands make it.
 *
 *   node --max-old-space-size=16000 scripts/badugi-ev.mjs [--spot btn-bb]
 *        [--deals 400000] [--seed 99]
 *
 * The solves run with `trackEv: false`, because the per-hand EV tables are
 * another random write into another big block at every visit and a solve that
 * is only after the strategy does not need them. So this measures instead:
 * deal, play the hand out with both seats drawing from their average
 * strategies, and average what the pot pays.
 *
 * Money is hundredths of a big blind throughout, so every number here is
 * already big blinds per hundred hands, and it is counted from the start of the
 * hand - the big blind's posted blind is part of what it is risking, which is
 * the only framing in which "what does defending cost" means anything.
 *
 * The seats sum to what the folded seats left behind rather than to zero: in
 * `btn-bb` the small blind's half a blind is dead money the two of them are
 * playing for, and a total of +50 is the check that this is pricing the same
 * game the solver solved.
 */

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { stateAfter, positionNames, DRAWING, FOLDED } from '../lib/tree.js';
import { BadugiSolver, badugiConfig } from '../lib/badugi-solve.js';
import { buttonOpeningRange, handFacts } from '../lib/badugi-benchmark.js';
import { loadBadugi } from '../lib/badugi-checkpoint.js';
import { makeRng } from '../lib/cards.js';
import { SPOTS, presetFor } from '../lib/badugi-spots.js';

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = argv.indexOf(`--${name}`);
  return at >= 0 && at + 1 < argv.length ? argv[at + 1] : fallback;
};


const key = flag('spot', 'btn-bb');
const spot = SPOTS[key];
if (!spot) throw new Error(`--spot wants one of ${Object.keys(SPOTS).join(', ')}`);

const names = positionNames(6);
const btn = names.indexOf('BTN');
const config = badugiConfig({
  players: 6,
  maxToDraw: null,
  coldCallSeats: null,
  coldCallThreeBets: true,
  maxDraw: String(flag('draws', '3,2,2')).split(',').map(Number),
  maxDrawBySeat: null,
  limit: { smallBet: 1, bigBet: 2, bigBetFrom: 2, cap: Number(flag('cap', 4)) },
  nodeLimit: 40e6,
  ...spot.over,
});

const from = stateAfter(config, spot.line);
const solver = new BadugiSolver({
  config,
  from,
  seed: Number(flag('seed', 21)),
  trackEv: false,
  explore: Number(flag('explore', 0.02)),
  presetRanges: presetFor(key, btn, buttonOpeningRange()),
});

// A labelled variant has its own checkpoint, so an experiment is never read
// against the run it is being compared with.
const label = flag('label', null);
const slug = label ? `${key}-${label}` : key;
const head = loadBadugi(solver, resolve(here, '..', 'solves', `badugi-${slug}`));
if (!head) throw new Error(`no checkpoint for ${key}; solve it first`);
if (head.mismatch) throw new Error(`the checkpoint describes a different game (${head.mismatch})`);

const { hands, total: allCombos } = handFacts();
const NAME = ['A', '2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K'];
const SIZE = { 4: 'badugi', 3: 'tri', 2: 'two-card', 1: 'one-card' };
const deals = Number(flag('deals', 400000));
const rng = makeRng(Number(flag('seed-ev', 99)));

const handNow = (seat) => solver.handTable[
  solver.handAfter[seat * solver.slotsPerSeat + solver.slotFor(seat)]];

/** One hand, both seats drawing from the average strategy. */
function playOut() {
  let id = solver.tree.root;
  for (let guard = 0; guard < 512; guard += 1) {
    const node = solver.nodes[id];
    if (node.kind !== 'decision') return node;
    const mix = solver.averageAt(id, handNow(node.seat));
    let roll = rng();
    let at = mix.length - 1;
    for (let a = 0; a < mix.length; a += 1) {
      roll -= mix[a];
      if (roll < 0) { at = a; break; }
    }
    if (node.street === DRAWING) {
      solver.drawn[node.seat * solver.rounds + solver.roundOf(node)] = node.actions[at].option;
    }
    id = node.actions[at].child;
  }
  throw new Error('the walk did not end');
}

const seats = solver.live;
const sum = new Map(seats.map((seat) => [seat, 0]));
const squares = new Map(seats.map((seat) => [seat, 0]));
// The defending seat is the one acting at the root; its result is bucketed by
// the hand it was dealt, which is the read a player wants.
const hero = solver.nodes[solver.tree.root].seat;
const byClass = new Map();

for (let n = 0; n < deals; n += 1) {
  solver.dealHands(rng);
  const dealt = handNow(hero);
  const node = playOut();
  for (const seat of seats) {
    const value = solver.payoff(node, seat);
    sum.set(seat, sum.get(seat) + value);
    squares.set(seat, squares.get(seat) + value * value);
  }
  const hand = hands[dealt];
  const label = hand.size >= 3
    ? `${NAME[hand.ranks[0]]}-high ${SIZE[hand.size]}`
    : `${SIZE[hand.size]} ${hand.ranks.map((r) => NAME[r]).join('')}`;
  if (!byClass.has(label)) {
    byClass.set(label, { label, size: hand.size, ranks: hand.ranks, n: 0, sum: 0 });
  }
  const row = byClass.get(label);
  row.n += 1;
  row.sum += solver.payoff(node, hero);
  solver.drawn.fill(-1);
}

const start = Math.round(config.stack * 100);
const dead = from.status.reduce((acc, _, seat) => (seats.includes(seat) ? acc
  : acc + (start - from.stack[seat])), 0);

console.log(`${slug}: ${head.iterations.toLocaleString()} iterations, `
  + `${deals.toLocaleString()} deals played out.\n`);
console.log('  seat        bb/100        note');
for (const seat of seats) {
  const mean = sum.get(seat) / deals;
  const spread = Math.max(0, squares.get(seat) / deals - mean * mean);
  const error = Math.sqrt(spread / deals);
  console.log(`  ${names[seat].padEnd(6)} ${mean.toFixed(1).padStart(9)} ± ${error.toFixed(1)}`
    + `${seat === hero ? `   against ${-Math.round(config.bigBlind * 100)} for folding every hand` : ''}`);
}
const table = seats.reduce((acc, seat) => acc + sum.get(seat) / deals, 0);
console.log(`\n  the two together: ${table.toFixed(1)} against ${dead.toFixed(0)} of dead money`
  + ` (${Math.abs(table - dead) < 3 ? 'matches' : 'DOES NOT MATCH'})`);

console.log(`\n  ${names[hero]}'s result by the hand it was dealt:\n`);
// Folding forfeits the posted blind, so that - not zero - is what every hand
// here is being compared against. A hand losing 95 is not a losing hand; it is
// five better than the alternative.
const folding = -Math.round(config.bigBlind * 100);
console.log(`  folding is ${folding} bb/100 - the blind, forfeited. Everything above it defends.
`);
console.log(`  ${'hand'.padEnd(18)} ${'% of deck'.padStart(9)} ${'bb/100'.padStart(9)} ${'vs folding'.padStart(11)}`);
console.log(`  ${'-'.repeat(18)} ${'-'.repeat(9)} ${'-'.repeat(9)} ${'-'.repeat(11)}`);
const order = [...byClass.values()].sort((a, b) => (b.size - a.size)
  || (a.ranks[0] - b.ranks[0]) || ((a.ranks[1] ?? 0) - (b.ranks[1] ?? 0)));
let lastSize = null;
for (const row of order) {
  if (row.n < deals / 2000) continue;
  if (lastSize !== null && row.size !== lastSize) console.log('');
  lastSize = row.size;
  console.log(`  ${row.label.padEnd(18)} ${`${(100 * row.n / deals).toFixed(2)}%`.padStart(9)} `
    + `${(row.sum / row.n).toFixed(0).padStart(9)} `
    + `${((row.sum / row.n) - folding >= 0 ? '+' : '')}${((row.sum / row.n) - folding).toFixed(0)}`.padStart(12));
}
