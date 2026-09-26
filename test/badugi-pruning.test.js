/**
 * Regret-based pruning, and the two ways it could be wrong without saying so.
 *
 * It could skip an action the strategy is actually playing, which changes the
 * value of every node above it. Or it could skip an action and then *update* its
 * regret anyway with a value that was never computed, which is worse - the
 * regret drifts toward whatever `values` happened to hold and the action's
 * frequency becomes an artefact of scratch memory.
 *
 * So what is pinned here is exactly the mechanism: which actions get skipped,
 * that nothing else does, and that a skipped action's regret comes out of the
 * iteration byte for byte as it went in.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { BadugiSolver, badugiConfig } from '../lib/badugi-solve.js';

/** The smallest badugi game that still has a draw and a raise in it. */
function tiny(options = {}) {
  const config = badugiConfig({
    players: 2,
    maxToDraw: null,
    coldCallSeats: null,
    allowLimp: false,
    maxDraw: [1, 1, 1],
    maxDrawBySeat: null,
    limit: { smallBet: 1, bigBet: 2, bigBetFrom: 2, cap: 2 },
    nodeLimit: 2e6,
  });
  return new BadugiSolver({ config, seed: 5, trackEv: false, explore: 0, ...options });
}

/** Counts which actions a walk descends into, keyed by node and action. */
function watch(solver) {
  const walked = new Map();
  const real = solver.descend.bind(solver);
  solver.descend = (node, action, traverser, seat, drawing, depth) => {
    const key = `${node.id}:${action}`;
    walked.set(key, (walked.get(key) ?? 0) + 1);
    return real(node, action, traverser, seat, drawing, depth);
  };
  return walked;
}

test('a solver without pruning walks every action of its own decisions', () => {
  const solver = tiny();
  assert.equal(solver.pruning, false);
  const root = solver.nodes[solver.tree.root];
  const walked = watch(solver);
  solver.run(1);
  for (let a = 0; a < root.actions.length; a += 1) {
    assert.ok(walked.get(`${root.id}:${a}`) >= 1, `action ${a} was walked`);
  }
});

test('the threshold is the widest pot in the tree, which is what one iteration can move', () => {
  const solver = tiny({ prune: {} });
  assert.equal(solver.pruning, true);
  let widest = 0;
  for (const node of solver.nodes) {
    if (solver.potAt[node.id] > widest) widest = solver.potAt[node.id];
  }
  assert.ok(widest > 0);
  assert.equal(solver.pruneBelow, -widest);
  // An explicit threshold overrides it, and is taken as a magnitude either way
  // round so a caller cannot accidentally prune everything with a positive one.
  assert.equal(tiny({ prune: { threshold: 40 } }).pruneBelow, -40);
  assert.equal(tiny({ prune: { threshold: -40 } }).pruneBelow, -40);
});

test('an action buried far below zero is not walked, and its neighbours are', () => {
  const solver = tiny({ prune: { revisit: 0 } });
  const root = solver.nodes[solver.tree.root];
  const width = root.actions.length;
  assert.ok(width >= 2);

  // One iteration to bring the blocks into being, then bury the first action for
  // every hand by more than a single iteration could recover.
  solver.run(1);
  const regrets = solver.regret[root.id];
  const deep = solver.pruneBelow - 1;
  for (let hand = 0; hand < solver.handCount; hand += 1) {
    regrets[hand * width] = deep;
    for (let a = 1; a < width; a += 1) regrets[hand * width + a] = 100;
  }

  const walked = watch(solver);
  solver.run(1);
  assert.equal(walked.get(`${root.id}:0`), undefined, 'the buried action was skipped');
  for (let a = 1; a < width; a += 1) {
    assert.ok(walked.get(`${root.id}:${a}`) >= 1, `action ${a} was still walked`);
  }
});

test('a skipped action\'s regret is left exactly as it was, where walking it would move it', () => {
  // Run the same buried position twice from the same seed: once pruning, once
  // revisiting everything. The control is the point - it shows the regret *would*
  // have moved, so "untouched" is pruning doing its job rather than an iteration
  // that happened to be worth nothing.
  const bury = (solver) => {
    solver.run(1);
    const root = solver.nodes[solver.tree.root];
    const width = root.actions.length;
    const regrets = solver.regret[root.id];
    for (let hand = 0; hand < solver.handCount; hand += 1) {
      regrets[hand * width] = solver.pruneBelow - 7.5;
      for (let a = 1; a < width; a += 1) regrets[hand * width + a] = 100;
    }
    return { root, width, regrets, before: Float32Array.from(regrets) };
  };

  const pruning = tiny({ prune: { revisit: 0 } });
  const buried = bury(pruning);
  pruning.run(3);
  for (let hand = 0; hand < pruning.handCount; hand += 1) {
    assert.equal(buried.regrets[hand * buried.width], buried.before[hand * buried.width],
      `hand ${hand}'s pruned regret is untouched`);
  }

  const walking = tiny({ prune: { revisit: 1 } });
  const control = bury(walking);
  walking.run(3);
  let moved = 0;
  for (let hand = 0; hand < walking.handCount; hand += 1) {
    if (control.regrets[hand * control.width] !== control.before[hand * control.width]) moved += 1;
  }
  assert.ok(moved > 0, 'walking the same buried action does move its regret');
});

test('a buried action is still walked on a revisiting iteration', () => {
  // `revisit: 1` means every iteration ignores pruning, which is the setting
  // that proves the escape hatch is wired to the same decision the walk reads.
  const solver = tiny({ prune: { revisit: 1 } });
  const root = solver.nodes[solver.tree.root];
  const width = root.actions.length;
  solver.run(1);
  const regrets = solver.regret[root.id];
  for (let hand = 0; hand < solver.handCount; hand += 1) {
    regrets[hand * width] = solver.pruneBelow - 1000;
  }
  const walked = watch(solver);
  solver.run(1);
  assert.ok(walked.get(`${root.id}:0`) >= 1, 'the buried action was walked anyway');
});

test('pruning never skips an action the strategy is playing', () => {
  // The dangerous case: a regret far below zero but a strategy that is not zero,
  // which happens when nothing at the node is positive and the mix falls back to
  // uniform. Skipping then would change the node's value.
  const solver = tiny({ prune: { revisit: 0 } });
  const root = solver.nodes[solver.tree.root];
  const width = root.actions.length;
  solver.run(1);
  const regrets = solver.regret[root.id];
  for (let hand = 0; hand < solver.handCount; hand += 1) {
    for (let a = 0; a < width; a += 1) regrets[hand * width + a] = solver.pruneBelow - 1;
  }
  const walked = watch(solver);
  solver.run(1);
  // Every action is buried, so regret matching hands back a uniform mix and
  // every action has a non-zero probability. None may be skipped.
  for (let a = 0; a < width; a += 1) {
    assert.ok(walked.get(`${root.id}:${a}`) >= 1,
      `action ${a} is played ${(100 / width).toFixed(0)}% of the time and was walked`);
  }
});

test('exploration fades when it is told to, and not otherwise', () => {
  const flat = tiny({ explore: 0.02 });
  flat.pace(1);
  assert.equal(flat.exploreNow, 0.02);
  flat.pace(10000);
  assert.equal(flat.exploreNow, 0.02, 'no decay unless asked for');

  const fading = tiny({ explore: 0.02, exploreDecay: 200, exploreFloor: 0 });
  fading.pace(0);
  assert.equal(fading.exploreNow, 0.02);
  fading.pace(200);
  assert.ok(Math.abs(fading.exploreNow - 0.01) < 1e-12, 'halved after its own many steps');
  fading.pace(600);
  assert.ok(Math.abs(fading.exploreNow - 0.005) < 1e-12, 'quartered after three times as many');
  // It never reaches zero, so every line goes on being explored infinitely often.
  fading.pace(1e9);
  assert.ok(fading.exploreNow > 0);
});

test('the decay stops at its floor, and the floor is not optional', () => {
  // Without one, epsilon reaches nothing and the death spiral it exists to
  // prevent comes back permanently: DCFR barely discounts positive regret late
  // in a run, so regret banked early for folding a hand is never overturned
  // once there is no exploration left to overturn it with.
  const floored = tiny({ explore: 0.02, exploreDecay: 200, exploreFloor: 0.005 });
  floored.pace(0);
  assert.equal(floored.exploreNow, 0.02);
  floored.pace(200);
  assert.ok(Math.abs(floored.exploreNow - 0.01) < 1e-12, 'still halving while above the floor');
  floored.pace(1e9);
  assert.equal(floored.exploreNow, 0.005, 'and never below it');
  // The default is the floor rather than zero, so a caller that asks for decay
  // and says nothing else does not get the broken version.
  assert.equal(tiny({ explore: 0.02, exploreDecay: 200 }).exploreFloor, 0.005);
});
