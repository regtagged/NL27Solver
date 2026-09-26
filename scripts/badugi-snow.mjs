/**
 * Hands where the big blind three-bets, draws one, misses, and pats anyway.
 *
 *   node --max-old-space-size=24000 scripts/badugi-snow.mjs --spot btn-bb \
 *        [--deals 300000] [--show 12] [--label lock3b]
 *
 * A snow is a hand played as a badugi that is not one. The strategy tables
 * cannot show it: a table says "6-high tri pats 12% at the second draw", which
 * is a frequency, not a story. What a player wants is the hand - these four
 * cards, this button, this betting - and whether it got paid.
 *
 * So this deals, plays both seats out of their average strategies, and keeps
 * the deals that took the line: three-bet, draw one at the first draw, and then
 * pat holding three cards. Rejection sampling, which is wasteful and the only
 * honest way to do it - the snows that come out appear exactly as often as the
 * solver plays them, so a line that shows up twice in 300,000 deals is visibly
 * a line that shows up twice in 300,000 deals.
 *
 * Cards are reconstructed the way `prepareSeat` deals them: `keepFor` picks
 * what a draw keeps, and the replacements come off this seat's reserved block.
 * That is the same code the solve ran on, so the cards printed here are the
 * cards it was holding, not a plausible reconstruction of them.
 */

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { stateAfter, positionNames } from '../lib/tree.js';
import { BadugiSolver, badugiConfig, keepFor } from '../lib/badugi-solve.js';
import { buttonOpeningRange, handFacts } from '../lib/badugi-benchmark.js';
import { loadBadugi } from '../lib/badugi-checkpoint.js';
import { makeRng, rankOf, rankChar, suitChar, SUIT_SYMBOL } from '../lib/cards.js';
import { DRAWING } from '../lib/tree.js';
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

const { hands } = handFacts();
const NAME = ['A', '2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K'];
const SIZE = { 4: 'badugi', 3: 'tri', 2: 'two-card', 1: 'one-card' };

// Badugi counts the ace low; the deck does not, so ordering for display has to
// say so rather than sorting by the deck's rank.
const low = (card) => (rankOf(card) + 1) % 13;
const show = (card) => rankChar(card) + SUIT_SYMBOL[suitChar(card)];
const showAll = (cards) => [...cards].sort((a, b) => low(a) - low(b)).map(show).join(' ');
const nameOf = (i) => (hands[i].size >= 3
  ? `${NAME[hands[i].ranks[0]]}-high ${SIZE[hands[i].size]}`
  : `${SIZE[hands[i].size]} ${hands[i].ranks.map((r) => NAME[r]).reverse().join('')}`);

const handNow = (seat) => solver.handTable[
  solver.handAfter[seat * solver.slotsPerSeat + solver.slotFor(seat)]];

const deals = Number(flag('deals', 300000));
const rng = makeRng(Number(flag('seed-ev', 7)));
const hero = solver.nodes[solver.tree.root].seat;
const villain = solver.live.find((seat) => seat !== hero);

/** One hand out of the average strategies, keeping everything that happened. */
function playOut() {
  const held = new Map(solver.live.map((seat) => [seat, [
    solver.deck[seat * 4], solver.deck[seat * 4 + 1],
    solver.deck[seat * 4 + 2], solver.deck[seat * 4 + 3]]]));
  const dealt = new Map([...held].map(([seat, cards]) => [seat, cards.slice()]));
  const start = new Map(solver.live.map((seat) => [seat, handNow(seat)]));
  const story = [];
  const keep = new Array(4);
  let id = solver.tree.root;
  for (let guard = 0; guard < 512; guard += 1) {
    const node = solver.nodes[id];
    if (node.kind !== 'decision') return { end: node, story, held, dealt, start };

    const mix = solver.averageAt(id, handNow(node.seat));
    let roll = rng();
    let at = mix.length - 1;
    for (let a = 0; a < mix.length; a += 1) {
      roll -= mix[a];
      if (roll < 0) { at = a; break; }
    }
    const action = node.actions[at];
    const step = {
      seat: node.seat,
      label: action.label,
      kind: action.kind,
      drawing: node.street === DRAWING,
      chance: mix[at],
    };
    if (step.drawing) {
      const round = solver.roundOf(node);
      step.round = round;
      step.option = action.option;
      const cards = held.get(node.seat);
      if (action.option > 0) {
        // Exactly what `prepareSeat` does: keep the best subset, then take the
        // replacements off this seat's reserved block for this round.
        const kept = keepFor(cards, action.option, keep);
        const keeping = keep.slice(0, kept);
        step.tossed = cards.filter((c) => !keeping.includes(c));
        const from = solver.reserveAt[node.seat] + solver.roundOffset[node.seat][round];
        step.caught = [];
        for (let i = 0; i < action.option; i += 1) step.caught.push(solver.deck[from + i]);
        held.set(node.seat, keeping.concat(step.caught));
      }
      solver.drawn[node.seat * solver.rounds + round] = action.option;
      step.after = handNow(node.seat);
    }
    story.push(step);
    id = action.child;
  }
  throw new Error('the walk did not end');
}

const found = [];
let threeBets = 0;
let drewOne = 0;
let missed = 0;
let snowed = 0;
// Which missed hands pat, and whether the button was pat when they did. Both
// only mean anything as a share of the misses in the same class - "T-high tris
// are most of the snows" is true of the deck as much as of the strategy.
const byClass = new Map();
let intoPat = 0;
let intoDrawing = 0;

for (let n = 0; n < deals; n += 1) {
  solver.dealHands(rng);
  const { end, story, held, dealt, start } = playOut();

  const opening = story.find((s) => s.seat === hero && !s.drawing);
  const isThreeBet = opening && (opening.kind === 'raise' || opening.kind === 'threebet');
  if (isThreeBet) threeBets += 1;

  const draws = story.filter((s) => s.seat === hero && s.drawing);
  const first = draws.find((s) => s.round === 0);
  const second = draws.find((s) => s.round === 1);

  if (isThreeBet && first && first.option === 1) {
    drewOne += 1;
    // Missed: still only three working cards after the draw.
    if (hands[first.after].size < 4) {
      missed += 1;
      const label = nameOf(first.after);
      if (!byClass.has(label)) byClass.set(label, { label, misses: 0, snows: 0, stayed: 0, at: hands[first.after] });
      byClass.get(label).misses += 1;
      if (second && second.option === 0) {
        snowed += 1;
        byClass.get(label).snows += 1;
        // A pat that draws again later was never a snow: it was a break with a
        // street of pretence in front of it, and counting it as one would put
        // the good tris in a table about giving up on the hand.
        const broke = draws.some((s) => s.round > 1 && s.option > 0);
        if (!broke) byClass.get(label).stayed += 1;
        // What the button had just done, which is what a snow is aimed at.
        const theirs = story.filter((s) => s.seat === villain && s.drawing && s.round === 0)[0];
        if (theirs && theirs.option === 0) intoPat += 1; else intoDrawing += 1;
        found.push({
          story,
          end,
          dealt,
          held,
          start,
          value: solver.payoff(end, hero),
          at: n,
        });
      }
    }
  }
  solver.drawn.fill(-1);
}

console.log(`${slug}: ${head.iterations.toLocaleString()} iterations, `
  + `${deals.toLocaleString()} deals played out.\n`);
console.log(`  ${names[hero]} three-bets           ${threeBets.toLocaleString()}`
  + `  (${(100 * threeBets / deals).toFixed(1)}% of deals)`);
console.log(`  ... and draws one            ${drewOne.toLocaleString()}`
  + `  (${(100 * drewOne / Math.max(1, threeBets)).toFixed(1)}% of three-bets)`);
console.log(`  ... and misses               ${missed.toLocaleString()}`
  + `  (${(100 * missed / Math.max(1, drewOne)).toFixed(1)}% of those draws)`);
console.log(`  ... and pats it anyway       ${snowed.toLocaleString()}`
  + `  (${(100 * snowed / Math.max(1, missed)).toFixed(1)}% of the misses)`);

if (!found.length) {
  console.log('\n  No snows in this sample.');
  process.exit(0);
}

// Who folded matters for the story and the tally alike: a snow that ends in a
// fold is only a won pot when the fold was the other seat's.
const folder = (f) => {
  if (f.end.kind !== 'fold') return -1;
  const folded = solver.foldedAt[f.end.id];
  return solver.live.find((seat) => folded[seat]) ?? -1;
};
const gaveUp = (f) => f.story.some((s) => s.seat === hero && s.drawing
  && s.round > 1 && s.option > 0);

const won = found.filter((f) => f.value > 0).length;
const bluffedOut = found.filter((f) => folder(f) === villain).length;
const foldedOut = found.filter((f) => folder(f) === hero).length;
const stuckWithIt = found.filter((f) => !gaveUp(f)).length;
const mean = found.reduce((sum, f) => sum + f.value, 0) / found.length;
console.log(`\n  Of those ${found.length} snows: ${bluffedOut} ended with ${names[villain]} folding,`
  + ` ${foldedOut} with ${names[hero]} folding, ${found.length - bluffedOut - foldedOut} at showdown.`);
console.log(`  ${stuckWithIt} stayed pat to the end; ${found.length - stuckWithIt} broke and drew again later.`);
console.log(`  ${won} won the pot. They averaged ${mean >= 0 ? '+' : ''}${mean.toFixed(0)} bb/100`
  + ` - which is what this line made, not what snowing was worth against drawing on.`);
console.log(`  ${intoPat} were aimed at a ${names[villain]} that stood pat at the first draw,`
  + ` ${intoDrawing} at one that drew.`);

console.log(`\n  Which misses pat, by what ${names[hero]} held after drawing one:\n`);
console.log(`  ${'hand'.padEnd(16)} ${'misses'.padStart(8)} ${'pats'.padStart(6)} ${'rate'.padStart(7)} ${'stay pat'.padStart(9)}`);
console.log(`  ${'-'.repeat(16)} ${'-'.repeat(8)} ${'-'.repeat(6)} ${'-'.repeat(7)} ${'-'.repeat(9)}`);
const classes = [...byClass.values()]
  .filter((row) => row.misses >= Math.max(20, missed / 400))
  .sort((a, b) => (b.at.size - a.at.size) || (a.at.ranks[0] - b.at.ranks[0]));
for (const row of classes) {
  console.log(`  ${row.label.padEnd(16)} ${row.misses.toLocaleString().padStart(8)} `
    + `${row.snows.toLocaleString().padStart(6)} `
    + `${`${(100 * row.snows / row.misses).toFixed(1)}%`.padStart(7)} `
    + `${`${row.stayed}/${row.snows}`.padStart(9)}`);
}

/** The betting and the draws, in the order they happened. */
function tell(f) {
  const lines = [];
  let round = -1;
  let bets = [];
  const flush = () => {
    if (bets.length) lines.push(`      ${bets.join('   ')}`);
    bets = [];
  };
  for (const step of f.story) {
    if (step.drawing) {
      if (step.round !== round) {
        flush();
        round = step.round;
        lines.push(`    draw ${round + 1}`);
      }
      const what = step.option === 0
        ? 'pat'
        : `${step.label}  (out ${showAll(step.tossed)}, in ${showAll(step.caught)})`;
      const after = step.seat === hero ? `  ->  ${nameOf(step.after)}` : '';
      lines.push(`      ${names[step.seat].padEnd(4)} ${what}${after}`);
    } else {
      bets.push(`${names[step.seat]} ${step.label}`);
    }
  }
  flush();
  return lines;
}

const showing = Number(flag('show', 12));
console.log(`\n  ${Math.min(showing, found.length)} of them:\n`);
for (const f of found.slice(0, showing)) {
  console.log(`  ${'-'.repeat(70)}`);
  console.log(`    ${names[hero]} dealt  ${showAll(f.dealt.get(hero))}   `
    + `${nameOf(f.start.get(hero))}`);
  console.log(`    ${names[villain]} dealt ${showAll(f.dealt.get(villain))}   `
    + `${nameOf(f.start.get(villain))}`);
  for (const line of tell(f)) console.log(line);
  const gone = folder(f);
  const ending = gone >= 0
    ? `${names[gone]} folds`
    : `showdown: ${names[hero]} ${showAll(f.held.get(hero))}  vs  `
      + `${names[villain]} ${showAll(f.held.get(villain))}`;
  console.log(`    ${ending}`);
  console.log(`    ${names[hero]} ${f.value >= 0 ? 'wins' : 'loses'} `
    + `${Math.abs(f.value / 100).toFixed(2)} bb`);
}
