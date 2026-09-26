/**
 * Two badugi solves, priced against each other on the same cards.
 *
 *   node --max-old-space-size=24000 scripts/badugi-compare.mjs --spot btn-bb \
 *        --against lock3b [--deals 400000]
 *
 * Measuring two strategies separately and subtracting does not work here. A
 * seat's result carries a whole deal's variance - about 0.9 bb/100 at 400,000
 * deals - so a difference of one or two is inside the noise of each side, and
 * two samples can disagree about its sign. That is exactly what happened when
 * this was first tried: -55.7 against -55.0 on one set of deals and -54.8
 * against -56.8 on another.
 *
 * So this deals once and plays the *same* hand out under both strategies,
 * accumulating the per-deal difference. The deal variance - which is nearly all
 * of it - cancels, and what is left is the strategies disagreeing, which is the
 * thing being asked about. It is the same reasoning `lib/exploitability.js`
 * gives for pairing its best response against the average on identical cards.
 *
 * Both solves must be of the same spot, or the trees do not line up and the
 * comparison is meaningless; the checkpoints are checked for that.
 */

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { stateAfter, positionNames, DRAWING } from '../lib/tree.js';
import { BadugiSolver, badugiConfig } from '../lib/badugi-solve.js';
import { buttonOpeningRange, handFacts } from '../lib/badugi-benchmark.js';
import { loadBadugi } from '../lib/badugi-checkpoint.js';
import { makeRng, deal } from '../lib/cards.js';
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
const against = flag('against', null);
if (!against) throw new Error('--against wants the label of the run to compare with');

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

const build = () => new BadugiSolver({
  config,
  from,
  seed: 21,
  trackEv: false,
  explore: Number(flag('explore', 0.02)),
  presetRanges: presetFor(key, btn, buttonOpeningRange()),
});

function loaded(slug) {
  const solver = build();
  const head = loadBadugi(solver, resolve(here, '..', 'solves', `badugi-${slug}`));
  if (!head) throw new Error(`no checkpoint for ${slug}`);
  if (head.mismatch) throw new Error(`${slug} describes a different game (${head.mismatch})`);
  return { solver, head, slug };
}

const base = loaded(key);
const other = loaded(`${key}-${against}`);

const { hands } = handFacts();
const NAME = ['A', '2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K'];
const SIZE = { 4: 'badugi', 3: 'tri', 2: 'two-card', 1: 'one-card' };
const deals = Number(flag('deals', 400000));

// One generator for the cards, one for each side's action sampling. Keeping the
// deals on their own generator is the whole point: both strategies see the same
// hand, so the only thing that differs is what they do with it.
const cards = makeRng(Number(flag('seed-ev', 99)));
const acting = [makeRng(11), makeRng(12)];

const handNow = (solver, seat) => solver.handTable[
  solver.handAfter[seat * solver.slotsPerSeat + solver.slotFor(seat)]];

function playOut(solver, rng) {
  let id = solver.tree.root;
  for (let guard = 0; guard < 512; guard += 1) {
    const node = solver.nodes[id];
    if (node.kind !== 'decision') return node;
    const mix = solver.averageAt(id, handNow(solver, node.seat));
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

const hero = base.solver.nodes[base.solver.tree.root].seat;
const seats = base.solver.live;
const totals = seats.map(() => [0, 0]);
let diff = 0;
let diffSquares = 0;
const byClass = new Map();

for (let n = 0; n < deals; n += 1) {
  // Dealt once, honouring the preset range, then copied so both sides hold the
  // same cards.
  base.solver.dealHands(cards);
  other.solver.deck.set(base.solver.deck);
  other.solver.drawn.fill(-1);
  for (const seat of other.solver.live) other.solver.prepareSeat(seat);

  const dealt = handNow(base.solver, hero);
  const ends = [playOut(base.solver, acting[0]), playOut(other.solver, acting[1])];
  const heroValues = [
    base.solver.payoff(ends[0], hero),
    other.solver.payoff(ends[1], hero),
  ];
  seats.forEach((seat, i) => {
    totals[i][0] += base.solver.payoff(ends[0], seat);
    totals[i][1] += other.solver.payoff(ends[1], seat);
  });
  const d = heroValues[1] - heroValues[0];
  diff += d;
  diffSquares += d * d;

  const hand = hands[dealt];
  const label = hand.size >= 3
    ? `${NAME[hand.ranks[0]]}-high ${SIZE[hand.size]}`
    : `${SIZE[hand.size]} ${hand.ranks.map((r) => NAME[r]).reverse().join('')}`;
  if (!byClass.has(label)) {
    byClass.set(label, { label, size: hand.size, ranks: hand.ranks, n: 0, diff: 0 });
  }
  const row = byClass.get(label);
  row.n += 1;
  row.diff += d;

  base.solver.drawn.fill(-1);
  other.solver.drawn.fill(-1);
}

const mean = diff / deals;
const spread = Math.max(0, diffSquares / deals - mean * mean);
const error = Math.sqrt(spread / deals);

console.log(`${key}: ${base.head.iterations.toLocaleString()} iterations`);
console.log(`${key}-${against}: ${other.head.iterations.toLocaleString()} iterations`);
console.log(`${deals.toLocaleString()} deals, the same cards played out under both.\n`);

console.log(`  seat      ${key.padEnd(14)} ${`${against}`.padEnd(14)}`);
seats.forEach((seat, i) => {
  console.log(`  ${names[seat].padEnd(6)} ${(totals[i][0] / deals).toFixed(1).padStart(13)} `
    + `${(totals[i][1] / deals).toFixed(1).padStart(14)}`);
});

console.log(`\n  ${names[hero]}'s change, paired: ${mean >= 0 ? '+' : ''}${mean.toFixed(2)} ± ${error.toFixed(2)} bb/100`);
const bar = 2 * error;
console.log(`  ${Math.abs(mean) > bar
  ? `That clears its error bar: the change is ${mean > 0 ? 'a gain' : 'a cost'}.`
  : 'That is inside its error bar: no measurable difference.'}`);

console.log(`\n  where the change comes from, by the hand ${names[hero]} was dealt:\n`);
console.log(`  ${'hand'.padEnd(18)} ${'% of deck'.padStart(9)} ${'change'.padStart(9)}`);
console.log(`  ${'-'.repeat(18)} ${'-'.repeat(9)} ${'-'.repeat(9)}`);
const order = [...byClass.values()].sort((a, b) => (b.size - a.size)
  || (a.ranks[0] - b.ranks[0]) || ((a.ranks[1] ?? 0) - (b.ranks[1] ?? 0)));
let lastSize = null;
for (const row of order) {
  if (row.n < deals / 2000) continue;
  if (lastSize !== null && row.size !== lastSize) console.log('');
  lastSize = row.size;
  const change = row.diff / row.n;
  console.log(`  ${row.label.padEnd(18)} ${`${(100 * row.n / deals).toFixed(2)}%`.padStart(9)} `
    + `${(change >= 0 ? '+' : '') + change.toFixed(0)}`.padStart(10));
}
