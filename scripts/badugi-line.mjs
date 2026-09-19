/**
 * Reads any line of a solved badugi spot, not just the ones the report saved.
 *
 *   node --max-old-space-size=16000 scripts/badugi-line.mjs --spot btn-bb \
 *        --line call,pat,pat,check,bet [--hands "badugi T,badugi J"]
 *
 * `scripts/badugi-subgame.mjs` writes out a handful of decisions - the ones a
 * player looks up first - because the whole strategy is hundreds of thousands
 * of decisions by 1,092 hands and will not fit in a file. That is the right
 * default and the wrong answer to "what does a king-high badugi do after it
 * check-calls", because the line through a check and a *bet* is not the line
 * the report walks.
 *
 * So this loads the checkpoint instead of the report, walks the line asked
 * for, and prints the decision it lands on. The checkpoint is gigabytes and
 * takes a minute to read, which is the price of asking a question nobody
 * anticipated.
 *
 * Actions are named the way a player says them - `call`, `check`, `bet`,
 * `raise`, `fold`, and `pat`, `d1`, `d2`, `d3` at a draw - and each is matched
 * against what is actually legal, so a line that cannot happen says so rather
 * than quietly landing somewhere else.
 */

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { stateAfter, positionNames, DRAWING } from '../lib/tree.js';
import { BadugiSolver, badugiConfig } from '../lib/badugi-solve.js';
import { buttonOpeningRange, handFacts } from '../lib/badugi-benchmark.js';
import { loadBadugi } from '../lib/badugi-checkpoint.js';

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = argv.indexOf(`--${name}`);
  return at >= 0 && at + 1 < argv.length ? argv[at + 1] : fallback;
};

const SPOTS = {
  'btn-bb': { line: ['fold', 'fold', 'fold', 'raise', 'fold'], over: {} },
  'sb-3bet': { line: ['fold', 'fold', 'fold', 'raise'], over: { maxToDraw: 2 } },
  'bb-3bet': { line: ['fold', 'fold', 'fold', 'raise', 'fold', 'raise'], over: {} },
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

const solver = new BadugiSolver({
  config,
  from: stateAfter(config, spot.line),
  seed: Number(flag('seed', 21)),
  trackEv: false,
  explore: Number(flag('explore', 0.02)),
  presetRanges: { [btn]: buttonOpeningRange() },
});

const head = loadBadugi(solver, resolve(here, '..', 'solves', `badugi-${key}`));
if (!head) throw new Error(`no checkpoint for ${key}; solve it first`);
if (head.mismatch) throw new Error(`the checkpoint describes a different game (${head.mismatch})`);

/**
 * Walks the named actions from the root, saying where each one went - and how
 * likely each hand is to still be there when it arrives.
 *
 * **Reach is the whole point of doing this properly.** Badugis nine-high and
 * better three-bet essentially always, so after "BB call" the big blind cannot
 * hold one; a table that still prints a row for a five-high badugi is
 * describing a hand that is not in the range, and the number beside it was
 * trained on exploration traffic. Reach is the product of *this seat's own*
 * choices along the line - what the other seat did is fixed by the line and
 * says nothing about which of my hands are here, so it cancels.
 */
function walk(steps, forSeat) {
  const { hands } = handFacts();
  let id = solver.tree.root;
  const path = [];
  const reach = new Float64Array(hands.length).fill(1);
  for (const want of steps) {
    const node = solver.nodes[id];
    if (!node || node.kind !== 'decision') {
      throw new Error(`the hand ended before "${want}"`);
    }
    const at = node.actions.findIndex((a) => a.kind === want || a.label === want
      // `bet` and `raise` are the same thing at different points in a round.
      || (want === 'bet' && (a.kind === 'bet' || a.kind === 'raise')));
    if (at < 0) {
      throw new Error(`"${want}" is not legal for ${names[node.seat]}; `
        + `offered: ${node.actions.map((a) => `${a.label} (${a.kind})`).join(', ')}`);
    }
    if (node.seat === forSeat) {
      for (let h = 0; h < hands.length; h += 1) reach[h] *= solver.averageAt(id, h)[at];
    }
    path.push(`${names[node.seat]} ${node.actions[at].label}`);
    id = node.actions[at].child;
  }
  return { id, path, reach };
}

const steps = String(flag('line', 'call')).split(',').map((s) => s.trim()).filter(Boolean);
// The seat that acts at the end is the one whose range this is, so the walk
// runs twice: once to find out who that is, once to accumulate their reach.
const seatAt = walk(steps, -1);
const reading = solver.nodes[seatAt.id];
const { id, path, reach } = walk(steps, reading ? reading.seat : -1);
const node = solver.nodes[id];
if (!node || node.kind !== 'decision') {
  throw new Error(`that line ends the hand (${node ? node.kind : 'nowhere'})`);
}

const { hands, total } = handFacts();
const NAME = ['A', '2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K'];
const SIZE = { 4: 'badugi', 3: 'tri', 2: 'two-card', 1: 'one-card' };

console.log(`${key}: ${head.iterations.toLocaleString()} iterations\n`);
console.log(`  line: ${path.join('  ->  ')}`);
console.log(`  now:  ${names[node.seat]} to act`
  + `${node.street === DRAWING ? ' at the draw' : ''} - `
  + `${node.actions.map((a) => a.label).join(' / ')}\n`);

/** Which hands to show: everything, or the sizes and high cards asked for. */
const wanted = flag('hands', null);
const picks = wanted
  ? wanted.split(',').map((text) => text.trim().toLowerCase())
  : null;
const matches = (hand) => {
  if (!picks) return true;
  const size = SIZE[hand.size];
  const high = NAME[hand.ranks[0]].toLowerCase();
  return picks.some((pick) => pick === size || pick === `${size} ${high}` || pick === `${high} ${size}`);
};

const rows = new Map();
for (let i = 0; i < hands.length; i += 1) {
  if (!matches(hands[i])) continue;
  const label = hands[i].size >= 3
    ? `${NAME[hands[i].ranks[0]]}-high ${SIZE[hands[i].size]}`
    : `${SIZE[hands[i].size]} ${hands[i].ranks.map((r) => NAME[r]).reverse().join('')}`;
  if (!rows.has(label)) {
    rows.set(label, { label, size: hands[i].size, ranks: hands[i].ranks, combos: 0, dealt: 0, members: [], w: node.actions.map(() => 0) });
  }
  const row = rows.get(label);
  // Weighted by what arrives, not by what is dealt.
  const weight = hands[i].combos * reach[i];
  row.combos += weight;
  row.dealt += hands[i].combos;
  row.members.push(i);
  const mix = solver.averageAt(id, i);
  node.actions.forEach((_, a) => { row.w[a] += weight * mix[a]; });
}

const order = [...rows.values()].sort((a, b) => (b.size - a.size)
  || (a.ranks[0] - b.ranks[0]) || ((a.ranks[1] ?? 0) - (b.ranks[1] ?? 0)));
const labels = node.actions.map((a) => a.label);
const arriving = order.reduce((sum, r) => sum + r.combos, 0);
console.log(`  the range that arrives here is ${(100 * arriving / total).toFixed(2)}% of all hands
`);
console.log(`  ${'hand'.padEnd(16)} ${'of range'.padStart(9)} ${'of deck'.padStart(8)}   ${labels.map((l) => l.padStart(9)).join(' ')}`);
console.log(`  ${'-'.repeat(16)} ${'-'.repeat(9)} ${'-'.repeat(8)}   ${labels.map(() => '-'.repeat(9)).join(' ')}`);
for (const row of order) {
  // A class that never arrives is not a row; printing it is how a five-high
  // badugi ends up in a table of hands that all three-bet preflop.
  if (row.combos / arriving < 0.0005) continue;
  console.log(`  ${row.label.padEnd(16)} ${`${(100 * row.combos / arriving).toFixed(1)}%`.padStart(9)} ${`${(100 * row.dealt / total).toFixed(2)}%`.padStart(8)}   `
    + labels.map((_, a) => `${(100 * row.w[a] / row.combos).toFixed(1)}%`.padStart(9)).join(' '));
  if (!argv.includes('--detail')) continue;
  for (const i of [...row.members].sort((a, b) => b - a)) {
    const mix = solver.averageAt(id, i);
    console.log(`      ${hands[i].ranks.map((r) => NAME[r]).reverse().join('').padEnd(12)} `
      + `${`${(100 * hands[i].combos / total).toFixed(3)}%`.padStart(9)}   `
      + labels.map((_, a) => `${(100 * mix[a]).toFixed(1)}%`.padStart(9)).join(' '));
  }
}

/**
 * Both seats' ranges at the node, by playing the line out on real deals.
 *
 * The big blind's range can be had by multiplying its own action probabilities
 * along the line, because it stood pat and so held one hand throughout. **The
 * button's cannot.** It draws, so the hand it holds at the end is not the hand
 * it was dealt, and a product of probabilities indexed by hand value is
 * multiplying together numbers about different hands.
 *
 * So this samples instead: deal, walk the line, and weight the deal by how
 * likely *both* seats were to play it that way. Both, because the seats are
 * correlated through the deck - what the button holds changes what is left for
 * the blind - so conditioning on one seat's actions alone would get the card
 * removal wrong. What comes out is the hand each seat is actually holding when
 * the decision arrives, which for a drawing seat is the only way to ask.
 */
function sampledRanges(steps, deals) {
  const { hands } = handFacts();
  const weight = new Map(solver.live.map((seat) => [seat, new Float64Array(hands.length)]));
  let reached = 0;

  const handNow = (seat) => solver.handTable[
    solver.handAfter[seat * solver.slotsPerSeat + solver.slotFor(seat)]];

  for (let n = 0; n < deals; n += 1) {
    solver.dealHands(solver.rng);
    let id = solver.tree.root;
    let p = 1;
    for (const want of steps) {
      const node = solver.nodes[id];
      if (!node || node.kind !== 'decision') { p = 0; break; }
      const at = node.actions.findIndex((a) => a.kind === want || a.label === want
        || (want === 'bet' && (a.kind === 'bet' || a.kind === 'raise')));
      if (at < 0) { p = 0; break; }
      p *= solver.averageAt(id, handNow(node.seat))[at];
      if (p <= 0) break;
      // A draw changes what this seat holds from here on, which is the whole
      // reason this is sampled rather than multiplied out.
      if (node.street === DRAWING) {
        solver.drawn[node.seat * solver.rounds + solver.roundOf(node)] = node.actions[at].option;
      }
      id = node.actions[at].child;
    }
    if (p > 0) {
      reached += p;
      for (const seat of solver.live) weight.get(seat)[handNow(seat)] += p;
    }
    solver.drawn.fill(-1);
  }
  return { weight, reached, deals };
}

if (argv.includes('--ranges')) {
  const deals = Number(flag('deals', 200000));
  const { weight, reached } = sampledRanges(steps, deals);
  console.log(`\n  Both ranges at this node, from ${deals.toLocaleString()} sampled deals`
    + ` (${(100 * reached / deals).toFixed(2)}% of them get here).`);
  for (const seat of solver.live) {
    const w = weight.get(seat);
    const rows = new Map();
    let all = 0;
    for (let i = 0; i < hands.length; i += 1) {
      if (!w[i]) continue;
      const label = hands[i].size >= 3
        ? `${NAME[hands[i].ranks[0]]}-high ${SIZE[hands[i].size]}`
        : `${SIZE[hands[i].size]} ${hands[i].ranks.map((r) => NAME[r]).reverse().join('')}`;
      rows.set(label, (rows.get(label) ?? 0) + w[i]);
      all += w[i];
    }
    const sized = new Map();
    for (let i = 0; i < hands.length; i += 1) {
      if (!w[i]) continue;
      sized.set(hands[i].size, (sized.get(hands[i].size) ?? 0) + w[i]);
    }
    console.log(`\n  ${names[seat]} holds:`);
    for (const size of [4, 3, 2, 1]) {
      if (!sized.has(size)) continue;
      console.log(`    ${`${SIZE[size]}s`.padEnd(12)} ${(100 * sized.get(size) / all).toFixed(1).padStart(5)}%`);
    }
    const top = [...rows.entries()].sort((a, b) => b[1] - a[1]).slice(0, Number(flag('rows', 8)));
    console.log(`    holdings, commonest first:`);
    for (const [label, share] of top) {
      console.log(`      ${label.padEnd(18)} ${(100 * share / all).toFixed(1).padStart(5)}%`);
    }
  }
}
