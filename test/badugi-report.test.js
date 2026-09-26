import test from 'node:test';
import assert from 'node:assert/strict';

import { BadugiSolver, badugiConfig } from '../lib/badugi-solve.js';
import { walkSpots, buildReport } from '../lib/badugi-report.js';
import { rangeOf } from '../lib/badugi-benchmark.js';
import { badugiTable } from '../lib/badugi.js';
import { positionNames, stateAfter } from '../lib/tree.js';

// Heads up after an open, one draw: the smallest thing shaped like the spots
// this reports on - somebody facing a raise, a draw, and a round of betting.
const config = badugiConfig({
  players: 2,
  drawRounds: 1,
  maxDraw: [1],
  maxDrawBySeat: null,
  limit: { smallBet: 1, bigBet: 2, bigBetFrom: 1, cap: 4 },
});
const names = positionNames(2);
const SB = 0;

function solved(options = {}, iterations = 600) {
  const solver = new BadugiSolver({
    config,
    from: stateAfter(config, ['raise']),
    seed: 5,
    trackEv: false,
    explore: 0.02,
    ...options,
  });
  solver.run(iterations);
  return solver;
}

// BB raises, SB calls, SB pats, BB draws one, SB bets, BB calls.
const BRANCH = { name: 'the raise', steps: ['raise', 'call', 'pat', 'd1', 'bet', 'call'] };

const report = (solver, watched) => {
  const { labels, combos } = badugiTable();
  return buildReport(solver, {
    key: 'test',
    what: 'a test',
    line: ['raise'],
    config,
    preset: { seat: SB, share: 100 },
    labels,
    combos,
    names,
    watched,
    final: true,
  });
};

test('the main line is walked from the root, following whatever continues', () => {
  const spots = walkSpots(solved(), { names });

  assert.ok(spots.length >= 4, `a line of decisions, not ${spots.length}`);
  assert.equal(spots[0].path, '', 'nothing has happened at the first decision');
  assert.ok(spots.every((s) => s.branch === null), 'the main line is not a branch');
  assert.ok(spots.slice(1).every((s) => s.path.length > 0), 'the rest say how they were reached');
  // Draws are named by which one they are, not all called the first.
  const draws = spots.filter((s) => s.drawing);
  assert.ok(draws.length > 0 && draws.every((s) => /first draw$/.test(s.what)), 'one draw round');
});

test('a branch is walked by name, and shares the root with the main line', () => {
  const solver = solved();
  const spots = walkSpots(solver, { names, branches: [BRANCH] });
  const branch = spots.filter((s) => s.branch === BRANCH.name);

  assert.ok(branch.length >= 4, 'the branch reports its own decisions');
  assert.equal(spots.filter((s) => s.id === solver.tree.root).length, 1,
    'the root belongs to the main line and is not written twice');
  assert.ok(branch.every((s) => s.path.startsWith(`${names[branch[0].seat]} raise`)
    || s.path.includes('raise')), 'a branch decision says the raise led to it');
  // No decision is reported twice, whichever line found it.
  const ids = spots.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('a branch step that is not legal is refused rather than followed elsewhere', () => {
  assert.throws(() => walkSpots(solved(), {
    names,
    branches: [{ name: 'nonsense', steps: ['d9'] }],
  }), /not legal/);
});

test('reach starts at the preset range, so a hand the seat folded weighs nothing', () => {
  const range = rangeOf((hand) => hand.size === 4);
  const solver = solved({ presetRanges: { [SB]: range } });
  const spots = walkSpots(solver, { names, branches: [BRANCH] });

  const theirs = spots.find((s) => s.seat === SB && s.reach);
  assert.ok(theirs, 'the preset seat acts somewhere on these lines');
  for (let h = 0; h < solver.handCount; h += 1) {
    if (!range[h]) assert.equal(theirs.reach[h], 0, 'a hand outside the range cannot be here');
  }
  assert.ok(theirs.reach.some((v) => v > 0), 'the hands inside it can');
});

test('reach survives a pat and is dropped by a draw', () => {
  const solver = solved();
  const spots = walkSpots(solver, { names, branches: [BRANCH] });
  const branch = spots.filter((s) => s.branch === BRANCH.name);

  // The seat that pats keeps the hand it was dealt, so its later decisions are
  // still about that hand; the seat that drew one does not.
  const patted = branch.find((s) => s.drawing && s.seat === SB);
  assert.ok(patted && patted.reach, 'the pat itself is a decision about the dealt hand');
  const afterPat = branch.filter((s) => s.seat === SB && !s.drawing && s.path.includes('pat'));
  assert.ok(afterPat.every((s) => s.reach), 'patting does not cost reach');

  const drew = branch.filter((s) => s.path.includes('d1') && s.seat !== SB);
  assert.ok(drew.length > 0 && drew.every((s) => s.reach === null),
    'once a seat has taken a card, reach for that seat is gone');
});

test('a spot carries reach or the traffic the solve measured, never both', () => {
  const solver = solved();
  const out = report(solver, walkSpots(solver, { names, branches: [BRANCH] }));

  for (const spot of out.spots) {
    assert.ok((spot.reach === null) !== (spot.traffic === null),
      `${spot.what} should be weighted by reach or by measured traffic, not both`);
    if (spot.traffic) {
      assert.ok(spot.traffic.every((v) => v >= 0), 'traffic is a mass, never negative');
      assert.ok(spot.traffic.some((v) => v > 0), 'some hand was there');
    }
  }
});

test('traffic is how often a hand was there, not whether it ever was', () => {
  const solver = solved({}, 4000);
  const out = report(solver, walkSpots(solver, { names, branches: [BRANCH] }));
  const sampled = out.spots.find((s) => s.traffic);
  if (!sampled) return;

  // The point of the change: a flag cannot tell the hand that arrives constantly
  // from the one the solver brushed against once, and both were being shown as
  // equally present.
  const live = sampled.traffic.filter((v) => v > 0);
  assert.ok(live.length > 1, 'more than one hand reaches this node');
  const most = Math.max(...live);
  const least = Math.min(...live);
  assert.ok(most > least, 'and they do not all arrive equally often');
});

test('a draw action keeps how many cards it takes, which is what the viewer colours by', () => {
  const solver = solved();
  const out = report(solver, walkSpots(solver, { names }));
  const draw = out.spots.find((s) => s.drawing);
  assert.ok(draw.actions.every((a) => typeof a.option === 'number'));
  assert.deepEqual(draw.actions.map((a) => a.option), [0, 1]);
});

test('the overall mix is weighted by what arrives, not by what is dealt', () => {
  const range = rangeOf((hand) => hand.size === 4);
  const solver = solved({ presetRanges: { [SB]: range } });
  const { combos } = badugiTable();
  const out = report(solver, walkSpots(solver, { names, branches: [BRANCH] }));

  const theirs = out.spots.find((s) => s.seat === SB && s.reach);
  assert.ok(theirs);
  let deck = 0;
  let deckAll = 0;
  for (let h = 0; h < solver.handCount; h += 1) {
    deck += combos[h] * solver.averageAt(theirs.id, h)[0];
    deckAll += combos[h];
  }
  assert.ok(Math.abs(theirs.overall[0] - (100 * deck / deckAll)) > 0.01,
    'weighting by the deck should give a different answer, or reach is doing nothing');
});

test('an unopened pot follows the raise, not the fold, or the report is one line long', () => {
  // Folded to a seat that may not limp, the only actions are fold and raise.
  // Taking the first one walks straight into a terminal, and `sb-bb` shipped a
  // report with a single decision in it because of exactly that.
  const solver = new BadugiSolver({ config, seed: 5, trackEv: false, explore: 0.02 });
  solver.run(400);
  const root = solver.nodes[solver.tree.root];
  assert.deepEqual(root.actions.map((a) => a.kind), ['fold', 'raise'],
    'this test is only meaningful while the root has no call and no check');

  const spots = walkSpots(solver, { names });
  assert.ok(spots.length > 1, `the walk stopped after ${spots.length} decision(s)`);
  assert.ok(spots.some((s) => s.drawing), 'and it should reach the draw');
});
