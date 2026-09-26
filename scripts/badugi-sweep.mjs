/**
 * Every class at the first decision, priced action by action.
 *
 *   node --max-old-space-size=24000 scripts/badugi-sweep.mjs --spot btn-bb
 *        [--deals 600000] [--label lock3b]
 *
 * `scripts/badugi-action.mjs` answers this for one hand and reloads five
 * gigabytes of checkpoint to do it. This walks the whole first decision at
 * once: deal, play *every* action out on the same cards, and file the result
 * under whatever the big blind was dealt. One pass, and every class gets
 * samples in proportion to how often it is dealt - which is also why the rare
 * ones come back with error bars too wide to judge, and are said to be rather
 * than guessed at.
 *
 * ## What it is for
 *
 * A mixed frequency is a claim that two actions are worth the same. That claim
 * is checkable, and it is not always true: a hand dealt 0.3% of the time is
 * sampled 0.3% of the time, and where the regret difference is smaller than the
 * noise in those samples the average strategy never settles. Reading such a
 * frequency as strategy is reading the solver's uncertainty as advice.
 *
 * So each class gets a verdict. **settled** - every action it plays is worth
 * the same, within the error. **off** - it plays an action that is measurably
 * worse than another one, by more than twice the paired error. **thin** - too
 * few deals to say, which is a fact about the sample and not about the hand.
 *
 * Differences are paired: both actions are played out on the same cards, and
 * the variance of the difference is taken from the covariance rather than by
 * treating the two as independent, which would overstate it by about half.
 */

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { stateAfter, positionNames, DRAWING } from '../lib/tree.js';
import { BadugiSolver, badugiConfig } from '../lib/badugi-solve.js';
import { buttonOpeningRange, handFacts } from '../lib/badugi-benchmark.js';
import { loadBadugi } from '../lib/badugi-checkpoint.js';
import { SPOTS, presetFor } from '../lib/badugi-spots.js';
import { makeRng } from '../lib/cards.js';

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

const solver = new BadugiSolver({
  config,
  from: stateAfter(config, spot.line),
  seed: Number(flag('seed', 21)),
  trackEv: false,
  explore: Number(flag('explore', 0.02)),
  presetRanges: presetFor(key, btn, buttonOpeningRange()),
});

const label = flag('label', null);
const slug = label ? `${key}-${label}` : key;
const head = loadBadugi(solver, resolve(here, '..', 'solves', `badugi-${slug}`));
if (!head) throw new Error(`no checkpoint for ${slug}; solve it first`);
if (head.mismatch) throw new Error(`the checkpoint describes a different game (${head.mismatch})`);

const { hands, total: allCombos } = handFacts();
const NAME = ['A', '2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K'];
const SIZE = { 4: 'badugi', 3: 'tri', 2: 'two-card' };
const nameOf = (h) => (h.size >= 3
  ? `${NAME[h.ranks[0]]}-high ${SIZE[h.size]}`
  : h.size === 2 ? `two-card ${h.ranks.map((r) => NAME[r]).reverse().join('')}`
    : h.ranks[0] <= 9 ? `monotone ${NAME[h.ranks[0]]}` : `quads ${NAME[h.ranks[0]]}`);

const hero = solver.nodes[solver.tree.root].seat;
const root = solver.nodes[solver.tree.root];
const width = root.actions.length;

const handNow = (seat) => solver.handTable[
  solver.handAfter[seat * solver.slotsPerSeat + solver.slotFor(seat)]];

/** The rest of the hand, from the average strategies, after a forced start. */
function playFrom(id, rng) {
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
    const action = node.actions[at];
    if (node.street === DRAWING) {
      solver.drawn[node.seat * solver.rounds + solver.roundOf(node)] = action.option;
    }
    id = action.child;
  }
  throw new Error('the walk did not end');
}

const deals = Number(flag('deals', 600000));
const cards = makeRng(Number(flag('seed-ev', 99)));
const acting = root.actions.map((_, i) => makeRng(41 + i));

/** Per class: the strategy it plays, and the sample moments of each action. */
const rows = new Map();
function rowFor(handIndex) {
  const label = nameOf(hands[handIndex]);
  if (!rows.has(label)) {
    rows.set(label, {
      label,
      size: hands[handIndex].size,
      ranks: hands[handIndex].ranks,
      combos: 0,
      n: 0,
      sum: new Float64Array(width),
      // Cross moments, so the variance of a difference comes from the pairing
      // rather than from pretending the two runs were independent.
      cross: new Float64Array(width * width),
    });
  }
  return rows.get(label);
}
// Dealt weight and the strategy are exact, so they come from the tables rather
// than from the sample.
hands.forEach((h, i) => {
  const row = rowFor(i);
  row.combos += h.combos;
  const mixed = solver.averageAt(solver.tree.root, i);
  if (!row.mix) row.mix = new Float64Array(width);
  for (let a = 0; a < width; a += 1) row.mix[a] += h.combos * mixed[a];
});
for (const row of rows.values()) for (let a = 0; a < width; a += 1) row.mix[a] /= row.combos;

const value = new Float64Array(width);
const started = Date.now();
for (let n = 0; n < deals; n += 1) {
  solver.dealHands(cards);
  const row = rowFor(handNow(hero));
  for (let a = 0; a < width; a += 1) {
    solver.drawn.fill(-1);
    value[a] = solver.payoff(playFrom(root.actions[a].child, acting[a]), hero);
  }
  row.n += 1;
  for (let a = 0; a < width; a += 1) {
    row.sum[a] += value[a];
    for (let b = 0; b < width; b += 1) row.cross[a * width + b] += value[a] * value[b];
  }
  solver.drawn.fill(-1);
}

/** Mean, and the standard error of the difference between two actions. */
const meanOf = (row, a) => row.sum[a] / row.n;
function errorOfDifference(row, a, b) {
  const ma = meanOf(row, a);
  const mb = meanOf(row, b);
  const va = row.cross[a * width + a] / row.n - ma * ma;
  const vb = row.cross[b * width + b] / row.n - mb * mb;
  const cov = row.cross[a * width + b] / row.n - ma * mb;
  return Math.sqrt(Math.max(0, va + vb - 2 * cov) / row.n);
}

console.log(`${slug}: ${head.iterations.toLocaleString()} iterations`);
console.log(`  ${names[hero]}'s first decision, ${root.actions.map((a) => a.label).join(' / ')}`);
console.log(`  ${deals.toLocaleString()} deals, every action played out on the same cards `
  + `(${((Date.now() - started) / 1000 / 60).toFixed(1)} min)\n`);

const PLAYED = 0.05;
const order = [...rows.values()].sort((x, y) => (y.size - x.size)
  || (x.ranks[0] - y.ranks[0]) || ((x.ranks[1] ?? 0) - (y.ranks[1] ?? 0)));

let leak = 0;
let leakCombos = 0;
const verdicts = { settled: 0, off: 0, thin: 0 };
const offenders = [];

for (const row of order) {
  if (!row.n) { row.verdict = 'thin'; verdicts.thin += 1; continue; }
  let best = 0;
  for (let a = 1; a < width; a += 1) if (meanOf(row, a) > meanOf(row, best)) best = a;
  row.best = best;

  let worst = 0;
  let worstAt = -1;
  let widest = 0;
  for (let a = 0; a < width; a += 1) {
    if (a === best || row.mix[a] < PLAYED) continue;
    const gap = meanOf(row, best) - meanOf(row, a);
    const bar = 2 * errorOfDifference(row, a, best);
    widest = Math.max(widest, bar);
    if (gap > bar && gap > worst) { worst = gap; worstAt = a; }
  }
  // How much the class gives up by playing its mix rather than the best action.
  let cost = 0;
  for (let a = 0; a < width; a += 1) cost += row.mix[a] * (meanOf(row, best) - meanOf(row, a));
  row.cost = cost;
  row.worst = worst;
  row.worstAt = worstAt;
  row.bar = widest || 2 * errorOfDifference(row, best, (best + 1) % width);

  // A gap measured on a handful of deals is not a gap. Four hundred is where
  // the paired error on this tree comes down to single figures; below it the
  // honest answer is that the sample cannot say, however large the difference
  // between two noisy means happens to look.
  if (row.n < Number(flag('least', 400))) {
    row.verdict = 'thin';
    verdicts.thin += 1;
  } else if (worstAt >= 0) {
    row.verdict = 'off';
    verdicts.off += 1;
    offenders.push(row);
    leak += row.combos * cost;
    leakCombos += row.combos;
  } else if (row.bar > 30) {
    row.verdict = 'thin';
    verdicts.thin += 1;
  } else {
    row.verdict = 'settled';
    verdicts.settled += 1;
  }
}

const MARK = { settled: ' ', off: '<', thin: '?' };
console.log(`  ${'hand'.padEnd(15)} ${'% deck'.padStart(7)} ${'deals'.padStart(7)}   `
  + `${root.actions.map((a) => `${a.label}`.padStart(13)).join(' ')}   ${'plays'.padStart(16)}  verdict`);
console.log(`  ${'-'.repeat(15)} ${'-'.repeat(7)} ${'-'.repeat(7)}   `
  + `${root.actions.map(() => '-'.repeat(13)).join(' ')}   ${'-'.repeat(16)}  -------`);

let lastSize = null;
for (const row of order) {
  if (lastSize !== null && row.size !== lastSize) console.log('');
  lastSize = row.size;
  const cells = root.actions.map((_, a) => {
    if (!row.n) return ''.padStart(13);
    const star = a === row.best ? '*' : ' ';
    return `${star}${meanOf(row, a).toFixed(0)}`.padStart(13);
  }).join(' ');
  const plays = root.actions.map((a, i) => (row.mix[i] >= 0.005
    ? `${a.label.replace(/ .*/, '')[0]}${(100 * row.mix[i]).toFixed(0)}` : null))
    .filter(Boolean).join(' ');
  const note = row.verdict === 'off'
    ? `${root.actions[row.worstAt].label} costs ${row.worst.toFixed(0)}`
    : row.verdict === 'thin' ? `±${(row.bar / 2).toFixed(0)}, too few` : '';
  console.log(`  ${row.label.padEnd(15)} ${`${(100 * row.combos / allCombos).toFixed(2)}%`.padStart(7)} `
    + `${String(row.n).padStart(7)}   ${cells}   ${plays.padStart(16)}  `
    + `${MARK[row.verdict]} ${note}`);
}

console.log(`\n  * marks the best action measured. < marks a class that plays something worse.\n`);
console.log(`  ${verdicts.settled} classes settled, ${verdicts.off} off, ${verdicts.thin} too thin to judge.`);
if (offenders.length) {
  console.log(`\n  The ones that are off, worst first:\n`);
  offenders.sort((a, b) => b.combos * b.cost - a.combos * a.cost);
  for (const row of offenders.slice(0, 20)) {
    console.log(`    ${row.label.padEnd(15)} plays ${root.actions[row.worstAt].label} `
      + `${(100 * row.mix[row.worstAt]).toFixed(0)}% of the time, which costs `
      + `${row.worst.toFixed(0)} bb/100; better: ${root.actions[row.best].label}`);
  }
  console.log(`\n  Weighted by how often they are dealt, those classes give up `
    + `${(leak / allCombos).toFixed(1)} bb/100`);
  console.log(`  of ${names[hero]}'s whole first decision - they are `
    + `${(100 * leakCombos / allCombos).toFixed(1)}% of the deck.`);
}
console.log('\n  Measured against the solved strategies, not a best response: CFR is trying to');
console.log('  make these equal, so a gap that clears its bar is a frequency still moving.');
