import test from 'node:test';
import assert from 'node:assert/strict';

import { freshDeck, makeRng, deal, parseHand } from '../lib/cards.js';
import { rank27 } from '../lib/eval27.js';
import { buildTree, defaultConfig, BB } from '../lib/tree.js';
import { DRAW_LABELS, PAT, DRAW_ONE, DRAW_TWO, buckets, describe } from '../lib/abstraction.js';
import { rollout, distribute, drawPolicy, benchmarkRanks } from '../lib/rollout.js';
import { handIndex } from '../lib/eval27.js';

const zeros = (n) => new Uint8Array(n);

test('a two-way pot goes to the better hand', () => {
  const payouts = distribute(Int32Array.from([100, 100]), zeros(2), Int32Array.from([3, 9]));
  assert.deepEqual(Array.from(payouts), [200, 0]);
});

test('a tie splits it', () => {
  const payouts = distribute(Int32Array.from([100, 100]), zeros(2), Int32Array.from([3, 3]));
  assert.deepEqual(Array.from(payouts), [100, 100]);
});

test('a short all-in wins the main pot but not the side pot', () => {
  // Seat 0 is in for 50 and holds the best hand; seats 1 and 2 play on for 100.
  const payouts = distribute(
    Int32Array.from([50, 100, 100]), zeros(3), Int32Array.from([0, 5, 10]),
  );
  assert.deepEqual(Array.from(payouts), [150, 100, 0]);
});

test('the side pot follows the best hand that paid for it', () => {
  const payouts = distribute(
    Int32Array.from([50, 100, 100]), zeros(3), Int32Array.from([10, 0, 5]),
  );
  assert.deepEqual(Array.from(payouts), [0, 250, 0]);
});

test('chips nobody could win come back to whoever put them in', () => {
  // Seat 0 bet 100 and folded; seat 1 called only 20 of it.
  const folded = Uint8Array.from([1, 0]);
  const payouts = distribute(Int32Array.from([100, 20]), folded, Int32Array.from([0, 4]));
  assert.deepEqual(Array.from(payouts), [80, 40]);
  assert.equal(payouts[0] + payouts[1], 120, 'the pot is conserved');
});

test('every pot pays out exactly what went into it', () => {
  const rng = makeRng(99);
  for (let trial = 0; trial < 500; trial += 1) {
    const players = 2 + Math.floor(rng() * 5);
    const contributions = new Int32Array(players);
    const folded = new Uint8Array(players);
    const ranks = new Int32Array(players);
    let live = 0;
    for (let seat = 0; seat < players; seat += 1) {
      contributions[seat] = Math.floor(rng() * 400);
      folded[seat] = rng() < 0.3 ? 1 : 0;
      ranks[seat] = Math.floor(rng() * 7462);
      if (!folded[seat]) live += 1;
    }
    if (live === 0) folded[0] = 0;
    const payouts = distribute(contributions, folded, ranks);
    let paid = 0;
    let won = 0;
    for (let seat = 0; seat < players; seat += 1) {
      paid += contributions[seat];
      won += payouts[seat];
    }
    assert.ok(Math.abs(paid - won) < 1e-9, `paid ${paid} but paid out ${won}`);
  }
});

test('a rollout is zero sum, whatever the deal', () => {
  const config = { ...defaultConfig(), players: 3, stopAtDraw: true, nodeLimit: 2e6 };
  const tree = buildTree(config);
  const draws = tree.nodes.filter((node) => node.kind === 'draw');
  assert.ok(draws.length > 0);

  const rng = makeRng(4242);
  const startStack = config.stack * BB;
  for (let trial = 0; trial < 300; trial += 1) {
    const node = draws[Math.floor(rng() * draws.length)];
    const deck = freshDeck();
    deal(deck, config.players * 7, rng);
    const hands = [];
    for (let seat = 0; seat < config.players; seat += 1) {
      hands.push(deck.subarray(seat * 5, seat * 5 + 5));
    }
    const reserve = deck.subarray(config.players * 5, config.players * 7);
    const { payoffs } = rollout(node.state, hands, reserve, { startStack });
    let total = 0;
    for (const value of payoffs) total += value;
    assert.ok(Math.abs(total) < 1e-9, `payoffs summed to ${total}`);
  }
});

test('nobody draws a card another player is holding', () => {
  const config = { ...defaultConfig(), players: 7, stopAtDraw: true, nodeLimit: 5e6 };
  const tree = buildTree(config);
  // Whichever draw node keeps the most players in, since that is where the
  // deck is at its tightest and a repeated card would show up first.
  let node = null;
  let most = 0;
  for (const candidate of tree.nodes) {
    if (candidate.kind !== 'draw') continue;
    const live = Array.from(candidate.state.status).filter((s) => s !== 1).length;
    if (live > most) {
      most = live;
      node = candidate;
    }
  }
  assert.ok(node && most >= 3, `expected a multiway draw node, most seen was ${most}`);

  const rng = makeRng(2026);
  for (let trial = 0; trial < 200; trial += 1) {
    const deck = freshDeck();
    deal(deck, 49, rng);
    const hands = [];
    for (let seat = 0; seat < 7; seat += 1) hands.push(deck.subarray(seat * 5, seat * 5 + 5));
    const reserve = deck.subarray(35, 49);
    const { finals } = rollout(node.state, hands, reserve, { startStack: config.stack * BB });
    const seen = new Set();
    let cards = 0;
    // A seat that folded never drew, so it has no finished hand to check.
    for (const final of finals) {
      if (!final) continue;
      assert.equal(final.length, 5);
      for (const card of final) seen.add(card);
      cards += final.length;
    }
    assert.equal(cards, most * 5, 'every player still in finishes with five cards');
    assert.equal(seen.size, cards, 'a card appeared in two hands');
  }
});

test('the draw policy stands pat on a made nine and breaks a jack', () => {
  const policy = drawPolicy();
  const { table } = buckets();
  const choice = (text) => policy[table[handIndex(parseHand(text))]];

  assert.equal(choice('7c5d4h3s2c'), PAT, '75432 stands pat');
  assert.equal(choice('9c8d7h5s2c'), PAT, 'a made nine stands pat');
  assert.equal(choice('Jc9d7h5s2c'), DRAW_ONE, 'a pat jack breaks to a nine draw');
  assert.equal(choice('Kc8d7h5s3c'), DRAW_ONE, 'a pat king is not a hand');
  assert.equal(choice('9c8d5h5s5c'), DRAW_TWO, 'trips draws two');
});

test('the benchmark ladder is four made lows, best first', () => {
  const ladder = benchmarkRanks();
  assert.equal(ladder.length, 4);
  for (let i = 1; i < ladder.length; i += 1) {
    assert.ok(ladder[i - 1] < ladder[i], 'the ladder should run from the eight upward');
  }
  assert.equal(ladder[0], rank27(parseHand('8c7d6h5s3c')));
});
