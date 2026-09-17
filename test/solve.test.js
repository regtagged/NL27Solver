import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Solver, discountRegrets, DCFR_DEFAULTS } from '../lib/solve.js';
import { BestResponse, exploitability } from '../lib/exploitability.js';
import { save, load, solveKey } from '../lib/checkpoint.js';

// Heads-up keeps the tree to a couple of hundred nodes, so a solve takes a
// second; the bucket table is the slow part, and it is built once per file.
const headsUp = { players: 2, stack: 40, smallBlind: 0.5, bigBlind: 1, ante: 0.25, anteMode: 'each' };
const solver = (algorithm) => new Solver({
  config: headsUp, joint: true, abstraction: 'coarse', seed: 3, algorithm,
});
const regretsOf = (s) => s.regret.filter(Boolean).flatMap((block) => Array.from(block));

test('a Discounted CFR step discounts regret less the longer a solve runs', () => {
  const early = [Float32Array.from([8, -8, 0]), null];
  discountRegrets(early, 1, DCFR_DEFAULTS);
  assert.deepEqual(Array.from(early[0]), [4, -4, 0]);

  // A hundred steps in, both sides keep nearly all of themselves: positive
  // regret 1000/1001, negative 100/101 at β=1. Keeping the negative side is
  // what stops a dominated action climbing back on a lucky sample, which at the
  // paper's β=0 - halving it every step, for ever - it never stops doing.
  const late = [Float32Array.from([8, -8])];
  discountRegrets(late, 100, DCFR_DEFAULTS);
  assert.ok(late[0][0] > 7.99 && late[0][0] < 8);
  assert.ok(late[0][1] < -7.9 && late[0][1] > -8);

  const paper = [Float32Array.from([8, -8])];
  discountRegrets(paper, 100, { ...DCFR_DEFAULTS, beta: 0 });
  assert.equal(paper[0][1], -4);
});

test('CFR+ is the default and never holds a negative regret; Discounted CFR does', () => {
  const plus = solver().run(20000);
  assert.equal(plus.algorithm, 'cfr+');
  assert.ok(regretsOf(plus).every((regret) => regret >= 0));

  const discounted = solver('dcfr').run(20000);
  assert.ok(regretsOf(discounted).some((regret) => regret < 0));
});

test('exploration is off unless asked for, and off changes nothing', () => {
  assert.equal(solver().explore, 0);
  const asked = new Solver({
    config: headsUp, joint: true, abstraction: 'coarse', seed: 3, explore: 0,
  }).run(20000);
  assert.deepEqual(regretsOf(asked), regretsOf(solver().run(20000)));
});

test('exploration puts traffic down lines the strategy would not take', () => {
  const explored = new Solver({
    config: headsUp, joint: true, abstraction: 'coarse', seed: 3, explore: 0.25,
  }).run(20000);
  // Counting decisions reached is too coarse - heads-up reaches all of them
  // either way. What exploration adds is traffic for the hands that would not
  // have gone there, so the count is of decisions a hand has actually learned:
  // a line nobody plays is a line nobody learns.
  const trained = (s) => s.average.reduce((sum, block) => {
    if (!block) return sum;
    let count = 0;
    for (let i = 0; i < block.length; i += 1) if (block[i] > 0) count += 1;
    return sum + count;
  }, 0);
  assert.ok(trained(explored) > trained(solver().run(20000)));
});

test('an algorithm it does not know is refused rather than ignored', () => {
  assert.throws(() => solver('cfr'), /Unknown algorithm/);
});

test('a responder that never deviates wins exactly what the average strategy wins', () => {
  const result = new BestResponse(solver().run(20000), 0).play(2000, 5, false);
  assert.equal(result.gain, 0);
  assert.equal(result.best, result.average);
});

test('solving shrinks what a best response can take from the average strategy', () => {
  const settings = { train: 10000, evaluate: 10000 };
  const unsolved = exploitability(solver(), settings);
  const solved = exploitability(solver('dcfr').run(200000), settings);

  // A uniform strategy folds the nuts a third of the time; anything can beat it.
  assert.ok(unsolved.seats.every((seat) => seat.gain > 10 * seat.error));
  assert.ok(unsolved.nashConv > 200);
  assert.ok(solved.nashConv < unsolved.nashConv / 5);
});

test('a stored solve says which algorithm made it, and will not load into another', () => {
  assert.equal(solveKey(headsUp, true, 3e6), '2p-40bb-0.5_1-a0.25each-joint-3M');
  assert.equal(solveKey(headsUp, true, 3e6, 'dcfr'), '2p-40bb-0.5_1-a0.25each-joint-dcfr-3M');
  assert.equal(
    solveKey({ ...headsUp, openTo: 2.5, threeBetTo: { inPosition: 7, blinds: 9 } }, true, 1e7, 'dcfr'),
    '2p-40bb-0.5_1-a0.25each-o2.5-3b7_9-joint-dcfr-10M',
    'a different sizing is a different file',
  );
  assert.equal(
    solveKey(headsUp, true, 1e7, 'dcfr', { beta: 0 }),
    '2p-40bb-0.5_1-a0.25each-joint-dcfr-b0-10M',
    'and so is a different discount',
  );
  assert.equal(
    solveKey(headsUp, true, 1e7, 'dcfr', null, 0.02),
    '2p-40bb-0.5_1-a0.25each-joint-dcfr-e0.02-10M',
    'and so is exploring',
  );

  const dir = mkdtempSync(join(tmpdir(), 'nl27-'));
  try {
    const file = join(dir, 'solve');
    save(solver('dcfr').run(5000), file);
    assert.equal(load(solver('cfr+'), file), false);
    assert.equal(load(solver('dcfr'), file).algorithm, 'dcfr');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
