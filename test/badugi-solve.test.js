import test from 'node:test';
import assert from 'node:assert/strict';

import {
  tripleDrawConfig, positionNames, drawActionsFor, buildTree, preDrawOrder, PRE_DRAW,
  stateAfter,
} from '../lib/tree.js';
import { BadugiSolver, keepFor, badugiConfig } from '../lib/badugi-solve.js';
import { score, sizeOf, describe, suitOf } from '../lib/badugi.js';
import { standardsFor, rangeOf } from '../lib/badugi-benchmark.js';
import { parseHand, makeRng } from '../lib/cards.js';

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
    // The stride is the solver's, not a constant here: a table wide enough for
    // three draws is not the one a single-draw game uses, and hardcoding either
    // is how this test came to read across into the next seat's block.
    for (let slot = 0; slot < solver.slotsPerSeat; slot += 1) {
      const at = solver.handAfter[seat * solver.slotsPerSeat + slot];
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

test('a seat that draws three has its own slot, not the next seat\'s hand', () => {
  // The big blind is the one seat allowed three on the first draw, and a
  // 3-1-1 history packs to 115. Under the old `depth * 36 + packed` scheme in
  // a 216-wide block that addressed slot 223 - past the end of the seat's own
  // block, so the lookup returned the next seat's hand, or `undefined` for the
  // last seat. Silently, and only on the line the exception exists to model.
  const solver = new BadugiSolver({ config: config({ players: 2 }), seed: 3, trackEv: false });
  const stride = solver.packStride;
  assert.equal(stride, 6 ** 3, 'three draws pack radix six, so the stride is 6^3');

  const deepest = 3 * stride + ((3 * 6 + 1) * 6 + 1); // the big blind drawing 3, 1, 1
  assert.ok(
    deepest < solver.slotsPerSeat,
    `slot ${deepest} does not fit in ${solver.slotsPerSeat} per seat`,
  );

  // And every slot the walk can actually reach holds a real hand.
  solver.run(1);
  for (let seat = 0; seat < solver.players; seat += 1) {
    solver.drawn.fill(-1);
    for (const first of solver.ceilings[seat][0]) {
      for (const second of solver.ceilings[seat][1]) {
        for (const third of solver.ceilings[seat][2]) {
          solver.drawn[seat * 3] = first;
          solver.drawn[seat * 3 + 1] = second;
          solver.drawn[seat * 3 + 2] = third;
          const at = seat * solver.slotsPerSeat + solver.slotFor(seat);
          const hand = solver.handTable[solver.handAfter[at]];
          assert.ok(
            Number.isInteger(hand) && hand >= 0 && hand < solver.handCount,
            `seat ${seat} drawing ${first},${second},${third} reads hand ${hand}`,
          );
        }
      }
    }
    solver.drawn.fill(-1);
  }
});

test('no two draw histories share a slot', () => {
  const solver = new BadugiSolver({ config: config({ players: 2 }), seed: 3, trackEv: false });
  const seen = new Map();
  for (const first of [...solver.ceilings[1][0], -1]) {
    for (const second of [...solver.ceilings[1][1], -1]) {
      for (const third of [...solver.ceilings[1][2], -1]) {
        solver.drawn.fill(-1);
        // A history is a prefix: a gap ends it, which is what `slotFor` reads.
        if (first >= 0) solver.drawn[3] = first;
        if (first >= 0 && second >= 0) solver.drawn[4] = second;
        if (first >= 0 && second >= 0 && third >= 0) solver.drawn[5] = third;
        const history = [first, second, third]
          .slice(0, first < 0 ? 0 : second < 0 ? 1 : third < 0 ? 2 : 3).join(',');
        const slot = solver.slotFor(1);
        const already = seen.get(slot);
        assert.ok(
          already === undefined || already === history,
          `"${history}" and "${already}" both land on slot ${slot}`,
        );
        seen.set(slot, history);
      }
    }
  }
  solver.drawn.fill(-1);
});

test('a tie between equal keeps is broken by what they can still become', () => {
  const into = new Array(4);
  // Every keep of three from A-3-A-3 is a two-card A-3, so `score` cannot
  // choose. The keeps are not equal though: one covering three suits has 33
  // cards that make it a tri, one covering two has 22. The card that is dead
  // to the hand's value is live to its future, which is the whole point.
  keepFor(parseHand('Ah 3d Ad 3s'), 1, into);
  const kept = into.slice(0, 3);
  assert.equal(score(kept), score(parseHand('Ah 3d')), 'still a two-card A-3');
  assert.equal(new Set(kept.map(suitOf)).size, 3, 'and it covers three suits, not two');
});

test('breaking a tie never costs a keep that scores better', () => {
  // The tie-break only runs among keeps already tied on score, so the rule it
  // is layered on top of - lowest badugi wins - has to survive it intact.
  const into = new Array(4);
  const rng = makeRng(31);
  const subsets = [[0, 1, 2], [0, 1, 3], [0, 2, 3], [1, 2, 3]];
  for (let n = 0; n < 500; n += 1) {
    const cards = [];
    while (cards.length < 4) {
      const card = Math.floor(rng() * 52);
      if (!cards.includes(card)) cards.push(card);
    }
    keepFor(cards, 1, into);
    const chosen = score(into.slice(0, 3));
    const lowest = Math.min(...subsets.map((pick) => score(pick.map((i) => cards[i]))));
    assert.equal(chosen, lowest, `kept ${chosen} when ${lowest} was available`);
  }
});

test('a posted blind can be barred from defending the pot it is already in', () => {
  // The cap counts voluntary entries, so once two cold seats are in, a blind
  // that has posted may neither call nor raise. That is not a rare line: it is
  // most of the fold-only decisions in the tree.
  //
  // **This pins a fact, not a cause.** The count falls away by position because
  // a seat's open can only be locked this way by a *cold* seat behind it, and
  // the button has none - but so does every quantity indexed by position, and
  // HANDOFF.md records why that is not evidence the cap inverts the opening
  // ranges. What it is evidence of is that a blind with money in the pot can be
  // barred from defending it, which is worth knowing whatever it causes.
  const tree = buildTree(badugiConfig({ players: 6 }));
  const names = positionNames(6);
  const order = preDrawOrder(6);

  const openingNode = (seat) => {
    let id = tree.root;
    for (let guard = 0; guard < 24; guard += 1) {
      const node = tree.nodes[id];
      if (!node || node.kind !== 'decision') return -1;
      if (node.seat === seat) return id;
      const fold = node.actions.find((a) => a.kind === 'fold');
      if (!fold) return -1;
      id = fold.child;
    }
    return -1;
  };

  const forcedOut = (seat) => {
    const open = openingNode(seat);
    const raise = tree.nodes[open].actions.find((a) => a.kind === 'raise');
    let found = 0;
    const seen = new Set();
    (function walk(id) {
      if (id < 0 || seen.has(id)) return;
      seen.add(id);
      const node = tree.nodes[id];
      if (!node || node.kind !== 'decision' || node.street !== PRE_DRAW) return;
      if (node.actions.length === 1 && node.actions[0].kind === 'fold'
        && ['SB', 'BB'].includes(names[node.seat])) found += 1;
      for (const action of node.actions) walk(action.child);
    })(raise.child);
    return found;
  };

  const opens = order.filter((seat) => !['SB', 'BB'].includes(names[seat]));
  const counts = opens.map(forcedOut);
  for (let i = 1; i < counts.length; i += 1) {
    assert.ok(
      counts[i] < counts[i - 1],
      `${names[opens[i]]} forces a blind out in ${counts[i]} lines against `
        + `${names[opens[i - 1]]}'s ${counts[i - 1]} - fewer cold seats behind, fewer such lines`,
    );
  }
  assert.ok(counts[counts.length - 1] <= 1, 'the button has no cold seat behind it');
});

test('a subgame reserves cards only for the seats still in it', () => {
  // Six-handed at a 3,2,2 ceiling wants 66 cards if every seat is given
  // replacements it will never draw. Folded to the button, only two seats can
  // draw, and the same ceiling costs 38 - hole cards for all six, because those
  // cards are gone from the deck at a real table however the hand went.
  const cfg = badugiConfig({
    players: 6, maxToDraw: null, maxDraw: [3, 2, 2], maxDrawBySeat: null,
    limit: { smallBet: 1, bigBet: 2, bigBetFrom: 2, cap: 4 }, nodeLimit: 40e6,
  });
  assert.throws(() => new BadugiSolver({ config: cfg }), /the deck has 52/);

  const from = stateAfter(cfg, ['fold', 'fold', 'fold', 'raise', 'fold']);
  const solver = new BadugiSolver({ config: cfg, from, trackEv: false });
  assert.equal(solver.cardsNeeded, 38);
  assert.deepEqual(solver.live.map((s) => positionNames(6)[s]), ['BB', 'BTN']);
});

test('a preset range is what the other seats are actually playing against', () => {
  // Without this a subgame built after the button opens has the big blind
  // defending against a button holding anything, which is a different game and
  // does not look like one.
  const cfg = badugiConfig({
    players: 6, maxToDraw: null, maxDraw: [2, 1, 1], maxDrawBySeat: null, nodeLimit: 40e6,
  });
  const from = stateAfter(cfg, ['fold', 'fold', 'fold', 'raise', 'fold']);
  const btn = positionNames(6).indexOf('BTN');
  const range = rangeOf(standardsFor(3).BTN);

  const solver = new BadugiSolver({
    config: cfg, from, seed: 5, trackEv: false, presetRanges: { [btn]: range },
  });
  solver.run(400);

  // Every deal the walk saw had the button inside its range, and the rejected
  // ones are roughly the range's complement.
  assert.ok(range[solver.holeValue(btn)], 'the button is holding a hand it would open');
  const kept = solver.iterations / (solver.iterations + solver.rejected);
  assert.ok(Math.abs(100 * kept - range.share) < 8,
    `kept ${(100 * kept).toFixed(1)}% of deals for a ${range.share.toFixed(1)}% range`);
});
