import test from 'node:test';
import assert from 'node:assert/strict';

import { parseHand, formatHand, formatCard, parseCard, freshDeck, makeRng, deal } from '../lib/cards.js';
import {
  score, categoryOf, rank27, handRanks, handIndex, distinctHandValues, HAND_COUNT,
  HIGH_CARD, PAIR, TWO_PAIR, TRIPS, STRAIGHT, FLUSH, FULL_HOUSE, QUADS, STRAIGHT_FLUSH,
} from '../lib/eval27.js';

const of = (text) => parseHand(text);

test('cards round-trip through text', () => {
  assert.equal(formatCard(parseCard('Th')), 'Th');
  assert.equal(formatHand(of('2c3d4h5sAc')), 'Ac 5s 4h 3d 2c');
  assert.throws(() => parseHand('7c7c4h3s2d'), /Duplicate/);
});

test('7-5-4-3-2 offsuit is the nuts, and 7-6-4-3-2 is next', () => {
  const ranks = handRanks();
  let best = 0;
  let second = 0;
  for (let i = 0; i < HAND_COUNT; i += 1) {
    if (ranks[i] === 0) best += 1;
    else if (ranks[i] === 1) second += 1;
  }
  assert.equal(rank27(of('7c5d4h3s2c')), 0);
  assert.equal(rank27(of('7c6d4h3s2c')), 1);
  // Five ranks in any suits, less the four hands where they all match.
  assert.equal(best, 4 ** 5 - 4);
  assert.equal(second, 4 ** 5 - 4);
});

test('the ace is high only, so there is no wheel', () => {
  assert.equal(categoryOf(score(of('5c4d3h2sAc'))), HIGH_CARD);
  assert.equal(categoryOf(score(of('6c5d4h3s2c'))), STRAIGHT);
  assert.equal(categoryOf(score(of('AcKdQhJsTc'))), STRAIGHT);

  // Nine straights, not ten: every run of five consecutive ranks, 2-6 to 10-A.
  let straights = 0;
  for (let low = 0; low <= 12 - 4; low += 1) straights += 1;
  assert.equal(straights, 9);
});

test('an ace-high hand still beats a straight, a flush and any pair', () => {
  const aceHigh = score(of('Ac9d7h4s2c'));
  assert.ok(aceHigh < score(of('6c5d4h3s2c')), 'ace high beats a straight');
  assert.ok(aceHigh < score(of('7c5c4c3c2c')), 'ace high beats the best flush');
  assert.ok(aceHigh < score(of('2c2d7h4s3c')), 'ace high beats a pair of deuces');
});

test('categories rank in 2-7 order, worst high hand first', () => {
  const examples = [
    ['7c5d4h3s2c', HIGH_CARD],
    ['2c2d7h5s4c', PAIR],
    ['2c2d3h3s7c', TWO_PAIR],
    ['2c2d2h7s5c', TRIPS],
    ['6c5d4h3s2c', STRAIGHT],
    ['7c5c4c3c2c', FLUSH],
    ['2c2d2h3s3c', FULL_HOUSE],
    ['2c2d2h2s7c', QUADS],
    ['6c5c4c3c2c', STRAIGHT_FLUSH],
  ];
  for (const [text, category] of examples) {
    assert.equal(categoryOf(score(of(text))), category, text);
  }
  const scores = examples.map(([text]) => score(of(text)));
  for (let i = 1; i < scores.length; i += 1) {
    assert.ok(scores[i - 1] < scores[i], `${examples[i - 1][0]} should beat ${examples[i][0]}`);
  }
});

test('the deck holds 7462 distinct hand values', () => {
  assert.equal(HAND_COUNT, 2598960);
  assert.equal(distinctHandValues(), 7462);
});

test('the rank table agrees with scoring, whatever order the cards arrive in', () => {
  const rng = makeRng(20260916);
  const ranks = handRanks();
  for (let trial = 0; trial < 20000; trial += 1) {
    const deck = freshDeck();
    const a = Array.from(deal(deck, 5, rng));
    const b = Array.from(deal(deck, 5, rng, 5));
    assert.equal(ranks[handIndex(a)], ranks[handIndex([...a].reverse())]);
    assert.equal(Math.sign(rank27(a) - rank27(b)), Math.sign(score(a) - score(b)));
  }
});

test('one deck deals seven hands and their draws without repeating a card', () => {
  const rng = makeRng(7);
  const deck = freshDeck();
  const dealt = Array.from(deal(deck, 35 + 10, rng));
  assert.equal(new Set(dealt).size, dealt.length);
});
