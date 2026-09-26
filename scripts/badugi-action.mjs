/**
 * What each action at the first decision is actually worth, for one hand.
 *
 *   node --max-old-space-size=24000 scripts/badugi-action.mjs --spot btn-bb \
 *        --hand "monotone A" [--deals 20000]
 *
 * A solved strategy that says "raise 51%" is making a claim that can be wrong
 * in two different ways, and the frequency alone does not say which. It can
 * mean the two actions are worth the same, which is what an equilibrium looks
 * like from the inside. Or it can mean the solve has not settled: a hand dealt
 * 0.3% of the time is sampled 0.3% of the time, and a regret difference smaller
 * than the noise in those samples leaves the average strategy wandering.
 *
 * So this takes the action out of the strategy's hands. Deal until the seat
 * holds the hand asked about, force each action in turn, play the rest of the
 * hand out of the average strategies, and see what the pot pays. The same cards
 * are played under every action - the deck, including the replacements each
 * draw will take - so the deal variance cancels and what is left is the actions
 * disagreeing.
 *
 * **This is EV against the strategy as solved, not against a best response.**
 * That is the right question here: CFR's whole job is to make these numbers
 * equal, so a gap between them is a statement about the solve, and a gap that
 * clears its error bar means the frequency above it has not converged.
 */

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { stateAfter, positionNames, DRAWING } from '../lib/tree.js';
import { BadugiSolver, badugiConfig } from '../lib/badugi-solve.js';
import { buttonOpeningRange, handFacts } from '../lib/badugi-benchmark.js';
import { loadBadugi } from '../lib/badugi-checkpoint.js';
import { SPOTS, presetFor } from '../lib/badugi-spots.js';
import { makeRng, deal } from '../lib/cards.js';

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

const btnRange = buttonOpeningRange();
// Null where the spot presets nobody, and then the deal below must not filter
// on a range the solve never applied.
const preset = presetFor(key, btn, btnRange);
const solver = new BadugiSolver({
  config,
  from: stateAfter(config, spot.line),
  seed: Number(flag('seed', 21)),
  trackEv: false,
  explore: Number(flag('explore', 0.02)),
  presetRanges: preset,
});

const label = flag('label', null);
const slug = label ? `${key}-${label}` : key;
const head = loadBadugi(solver, resolve(here, '..', 'solves', `badugi-${slug}`));
if (!head) throw new Error(`no checkpoint for ${slug}; solve it first`);
if (head.mismatch) throw new Error(`the checkpoint describes a different game (${head.mismatch})`);

const { hands } = handFacts();
const NAME = ['A', '2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K'];
const SIZE = { 4: 'badugi', 3: 'tri', 2: 'two-card' };
const nameOf = (h) => (h.size >= 3
  ? `${NAME[h.ranks[0]]}-high ${SIZE[h.size]}`
  : h.size === 2 ? `two-card ${h.ranks.map((r) => NAME[r]).reverse().join('')}`
    : h.ranks[0] <= 9 ? `monotone ${NAME[h.ranks[0]]}` : `quads ${NAME[h.ranks[0]]}`);

const wanted = String(flag('hand', 'monotone A')).toLowerCase();
const target = new Uint8Array(solver.handCount);
let targetCombos = 0;
hands.forEach((h, i) => {
  if (nameOf(h).toLowerCase() !== wanted) return;
  target[i] = 1;
  targetCombos += h.combos;
});
if (!targetCombos) throw new Error(`no hand is called "${flag('hand', 'monotone A')}"`);

const hero = solver.nodes[solver.tree.root].seat;
const villain = solver.live.find((seat) => seat !== hero);
const root = solver.nodes[solver.tree.root];

const handNow = (seat) => solver.handTable[
  solver.handAfter[seat * solver.slotsPerSeat + solver.slotFor(seat)]];

/**
 * Deals until the hero holds the hand in question.
 *
 * The rejection is on the hole values alone, which are four array reads - the
 * expensive part of a deal is laying out every hand each seat could hold after
 * every draw, and that is only done once a deal is kept.
 */
function dealUntilHeld(rng) {
  for (let tries = 0; tries < 2e7; tries += 1) {
    deal(solver.deck, solver.cardsNeeded, rng);
    if (!target[solver.holeValue(hero)]) continue;
    if (preset && !preset[btn][solver.holeValue(btn)]) continue;
    solver.drawn.fill(-1);
    for (const seat of solver.live) solver.prepareSeat(seat);
    return true;
  }
  throw new Error('that hand never came up');
}

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

const deals = Number(flag('deals', 20000));
const cards = makeRng(Number(flag('seed-ev', 99)));
const acting = root.actions.map((_, i) => makeRng(31 + i));
const tally = root.actions.map(() => ({ sum: 0, squares: 0, folds: 0, shown: 0 }));

for (let n = 0; n < deals; n += 1) {
  dealUntilHeld(cards);
  root.actions.forEach((action, a) => {
    solver.drawn.fill(-1);
    const end = playFrom(action.child, acting[a]);
    const value = solver.payoff(end, hero);
    tally[a].sum += value;
    tally[a].squares += value * value;
    if (end.kind === 'fold') {
      if (solver.foldedAt[end.id][villain]) tally[a].folds += 1;
    } else tally[a].shown += 1;
  });
}

const mix = (() => {
  // The strategy's own answer, for comparison with what the actions are worth.
  const out = new Float64Array(root.actions.length);
  let total = 0;
  hands.forEach((h, i) => {
    if (!target[i]) return;
    const strategy = solver.averageAt(solver.tree.root, i);
    for (let a = 0; a < out.length; a += 1) out[a] += h.combos * strategy[a];
    total += h.combos;
  });
  return Array.from(out, (v) => 100 * v / total);
})();

console.log(`${slug}: ${head.iterations.toLocaleString()} iterations`);
console.log(`  ${names[hero]} holding a ${flag('hand', 'monotone A')} `
  + `(${targetCombos.toLocaleString()} combinations, `
  + `${(100 * targetCombos / 270725).toFixed(2)}% of the deck)`);
console.log(`  ${deals.toLocaleString()} deals, every action played out on the same cards.\n`);

console.log(`  ${'action'.padEnd(10)} ${'solved at'.padStart(9)} ${'bb/100'.padStart(14)} `
  + `${'they fold'.padStart(10)} ${'showdown'.padStart(9)}`);
console.log(`  ${'-'.repeat(10)} ${'-'.repeat(9)} ${'-'.repeat(14)} ${'-'.repeat(10)} ${'-'.repeat(9)}`);
const means = [];
const errors = [];
root.actions.forEach((action, a) => {
  const mean = tally[a].sum / deals;
  const spread = Math.max(0, tally[a].squares / deals - mean * mean);
  const error = Math.sqrt(spread / deals);
  means.push(mean);
  errors.push(error);
  console.log(`  ${action.label.padEnd(10)} ${`${mix[a].toFixed(1)}%`.padStart(9)} `
    + `${`${mean.toFixed(0)} ± ${error.toFixed(0)}`.padStart(14)} `
    + `${`${(100 * tally[a].folds / deals).toFixed(1)}%`.padStart(10)} `
    + `${`${(100 * tally[a].shown / deals).toFixed(1)}%`.padStart(9)}`);
});

const best = means.indexOf(Math.max(...means));
console.log(`\n  best: ${root.actions[best].label} at ${means[best].toFixed(0)} bb/100`);
root.actions.forEach((action, a) => {
  if (a === best) return;
  const gap = means[best] - means[a];
  const bar = 2 * Math.sqrt(errors[best] ** 2 + errors[a] ** 2);
  console.log(`    ${action.label.padEnd(10)} costs ${gap.toFixed(0)} ± ${(bar / 2).toFixed(0)}`
    + `  ${gap > bar ? 'which clears its error bar' : 'which is inside its error bar'}`);
});
console.log('\n  Against the solved strategies, not a best response: CFR is trying to make');
console.log('  these equal, so a gap that clears its bar is a frequency that has not settled.');
