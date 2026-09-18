import test from 'node:test';
import assert from 'node:assert/strict';

import { tripleDrawConfig, positionNames, drawActionsFor } from '../lib/tree.js';
import { BadugiSolver, keepFor } from '../lib/badugi-solve.js';
import { score, sizeOf, describe } from '../lib/badugi.js';
import { parseHand } from '../lib/cards.js';

const config = (over = {}) => tripleDrawConfig({
  players: 2,
  allowLimp: false,
  coldCallSeats: ['BTN', 'BB'],
  coldCallThreeBets: false,
  maxToDraw: null,
  maxDraw: [2, 1, 1],
  maxDrawBySeat: { BB: [3, 1, 1] },
  limit: { smallBet: 1, bigBet: 2, bigBetFrom: 2, cap: 3 },
  nodeLimit: 9e6,
  ...over,
});

// A solver allocates 1,092 hand values at every decision it touches, so the
// real tree is hundreds of megabytes and three of them will not share a test
// process. The invariants do not need the real tree: one draw and two bets is
// the same machinery over a few hundred nodes.
const small = (over = {}) => config({
  drawRounds: 1, maxDraw: [1], maxDrawBySeat: null,
  limit: { smallBet: 1, bigBet: 2, bigBetFrom: 1, cap: 2 },
  ...over,
});

test('a draw keeps the cards that make the best hand, not the lowest ones', () => {
  const into = new Array(4);
  // 2h is dead behind 3h. Drawing one keeps the three that play together.
  keepFor(parseHand('Ah 3h 2d 4c'), 1, into);
  assert.equal(describe(score(into.slice(0, 3))), '3-card 42A');

  // Drawing two off a one-card hand keeps two that do not clash.
  keepFor(parseHand('Ah 2h 3h 4h'), 2, into);
  assert.equal(sizeOf(score(into.slice(0, 2))), 1, 'all one suit, so only one plays');
});

test('a deal fits the deck, and says so when it would not', () => {
  assert.equal(new BadugiSolver({ config: config() }).cardsNeeded, 17);
  assert.equal(new BadugiSolver({ config: config({ players: 3 }) }).cardsNeeded, 25);
  // Five cards a seat across three draws does not fit six-handed.
  assert.throws(
    () => new BadugiSolver({ config: config({ players: 6, maxDraw: [4, 4, 4], maxDrawBySeat: null }) }),
    /the deck has 52/,
  );
});

test('no chips are created or destroyed at any terminal', () => {
  const solver = new BadugiSolver({ config: small(), seed: 9 });
  solver.run(40); // deals, so the draw histories are populated

  let checked = 0;
  for (const node of solver.nodes) {
    if (node.kind !== 'fold' && node.kind !== 'showdown') continue;
    let total = 0;
    for (let seat = 0; seat < solver.players; seat += 1) total += solver.payoff(node, seat);
    assert.ok(Math.abs(total) < 1e-9,
      `${node.kind} node ${node.id} leaks ${(total / 100).toFixed(4)}bb`);
    checked += 1;
  }
  assert.ok(checked > 20, `expected many terminals, saw ${checked}`);
});

test('every draw history a seat can have resolves to a real hand', () => {
  const solver = new BadugiSolver({ config: small({ players: 3 }), seed: 4 });
  solver.run(20);
  // After a run the scratch is left at the end of an iteration; re-prepare and
  // walk every reachable history to be sure none is a hole.
  for (let seat = 0; seat < solver.players; seat += 1) {
    solver.prepareSeat(seat);
    let found = 0;
    for (let slot = 0; slot < 216; slot += 1) {
      const at = solver.handAfter[seat * 216 + slot];
      if (at < 0) continue;
      found += 1;
      assert.ok(solver.handTable[at] < solver.handCount, 'maps into the value table');
    }
    // Pat or one card, over one draw, plus the history of having drawn nothing.
    assert.ok(found >= 3, `seat ${seat} had only ${found} histories`);
  }
});

test('the big blind is the seat that may draw three', () => {
  // Read off the config rather than off a solve: no tree needs building to
  // know what a seat is allowed to do.
  const cfg = config({ players: 3 });
  const names = positionNames(3);
  const options = (seat, round) => drawActionsFor(cfg, round, seat).map((a) => a.option);
  assert.ok(options(names.indexOf('BB'), 0).includes(3), 'the blind may take three first');
  assert.ok(!options(names.indexOf('BTN'), 0).includes(3), 'and nobody else may');
  assert.ok(!options(names.indexOf('BB'), 1).includes(3), 'not on the later draws either');
});

test('solving moves the opening frequency off its uniform start', () => {
  const solver = new BadugiSolver({ config: small(), seed: 7 }).run(600);
  const id = solver.openingNode(0);
  assert.ok(id >= 0);
  const frequency = solver.frequency(id);
  assert.ok(frequency > 50 && frequency <= 100,
    `heads-up the button should open wide, got ${frequency.toFixed(1)}%`);
});
