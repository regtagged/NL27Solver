import test from 'node:test';
import assert from 'node:assert/strict';

import { parseHand, formatHand, rankOf, suitOf } from '../lib/cards.js';
import {
  PAT, DRAW_ONE, DRAW_TWO, DRAW_LABELS,
  analyse, keepFor, optionsFor, signature, describe, bucketOf, buckets,
} from '../lib/abstraction.js';

const of = (text) => parseHand(text);
const ranksOf = (cards) => [...cards].map(rankOf).sort((a, b) => a - b);
const options = (cards) => optionsFor(cards).map((o) => DRAW_LABELS[o]);

test('a made low is recognised, and a straight or flush is not one', () => {
  assert.equal(analyse(of('7c5d4h3s2c')).made, true);
  assert.equal(analyse(of('6c5d4h3s2c')).made, false, 'a straight is not a made low');
  assert.equal(analyse(of('7c5c4c3c2c')).made, false, 'a flush is not a made low');
  assert.equal(analyse(of('7c5d4h4s2c')).made, false, 'a pair is not a made low');
  assert.equal(analyse(of('Ac9d7h4s2c')).made, true, 'ace-high is still a made low, just a bad one');
});

test('the keep is chosen by what it draws to, not by which cards are lowest', () => {
  // Holding 7-5-4-3-2 and drawing two, the lowest three is 2-3-4 - which needs
  // a 5 and a 6 and so can back into a straight. 2-3-7 cannot, and wins.
  assert.deepEqual(ranksOf(keepFor(of('7c5d4h3s2c'), DRAW_TWO)), [0, 1, 5]);
  // With no eight in the hand, 7-5-4-3 is the best four available and is kept.
  assert.deepEqual(ranksOf(keepFor(of('Kc7d5h4s3c'), DRAW_ONE)), [1, 2, 3, 5]);
});

test('a pair is never kept back, so the pair rank is simply skipped', () => {
  const kept = keepFor(of('7c5d4h4s2c'), DRAW_ONE);
  assert.deepEqual(ranksOf(kept), ranksOf(of('7c5d4h2c')));
  assert.equal(new Set(ranksOf(kept)).size, 4, 'four distinct ranks kept');
});

test('a flush is broken whenever the hand holds another copy of a rank', () => {
  // 7c 5c 4c 2c 2d - the deuce can come from the other suit, so the keep is safe.
  const kept = keepFor(of('7c5c4c2c2d'), DRAW_ONE);
  assert.equal(new Set([...kept].map(suitOf)).size > 1, true, `${formatHand(kept)} is still monotone`);
  assert.equal(analyse(of('7c5c4c2c2d')).keep4Monotone, false);
});

test('a flush that cannot be broken is flagged', () => {
  // Every kept rank appears once and all in clubs, so drawing one risks a flush.
  const info = analyse(of('9c7c5c4c2c'));
  assert.equal(info.keep4Monotone, true);
  assert.equal(info.keep3Monotone, true);
  assert.equal(info.made, false, 'it is a flush already');
});

test('options follow how many distinct ranks a hand holds', () => {
  assert.deepEqual(options(of('7c5d4h3s2c')), ['pat', 'd1', 'd2']);
  assert.deepEqual(options(of('7c5d4h4s2c')), ['pat', 'd1', 'd2'], 'four distinct ranks');
  assert.deepEqual(options(of('7c5d5h5s2c')), ['pat', 'd2'], 'three distinct ranks, no d1');
  assert.deepEqual(options(of('AcAdAhAsKc')), ['pat'], 'two distinct ranks, pat only');
});

test('describe reads the way a player would say it', () => {
  assert.equal(describe(of('7c5d4h3s2c')), '75432 pat');
  assert.equal(describe(of('7c5d4h4s2c')), '7542 d1');
  assert.equal(describe(of('9c7c5c4c2c')), '7542 (suited) d1');
  assert.equal(describe(of('7c5d5h5s2c')), '752 d2');
  assert.equal(describe(of('AcAdAhAsKc')), 'unplayable');
});

test('the same hand buckets the same however the cards are ordered', () => {
  const hand = of('8c7d5h4s2c');
  assert.equal(bucketOf(hand), bucketOf([...hand].reverse()));
  assert.equal(signature(hand), signature([...hand].reverse()));
});

test('hands that play differently are kept apart', () => {
  const nuts = bucketOf(of('7c5d4h3s2c'));
  const second = bucketOf(of('7c6d4h3s2c'));
  const eight = bucketOf(of('8c7d5h4s2c'));
  assert.notEqual(nuts, second, '7-5 and 7-6 are not the same hand');
  assert.notEqual(second, eight);
});

test('hands with no playable option merge, however different they look', () => {
  // All three are pat ace-highs, which is not a hand; all three draw one to a
  // king and two to a queen, which are not draws. With d3 not offered there is
  // nothing left to tell them apart, and one strategy covers all of them.
  const hands = ['AcKdQhJs9c', 'AcKdQhTs9c', 'AcKdQh8s6c'].map(of);
  const first = bucketOf(hands[0]);
  for (const hand of hands) {
    assert.equal(bucketOf(hand), first, `${describe(hand)} should merge`);
  }
});

test('a malformed set of ceilings is refused, not quietly honoured', () => {
  assert.throws(() => signature(of('7c5d4h3s2c'), {}), /limits\.pat/);
  assert.throws(() => signature(of('7c5d4h3s2c'), { pat: 9, keep4: 8, keep3: 99 }), /limits\.keep3/);
  assert.throws(() => buckets({ pat: 1.5, keep4: 8, keep3: 7 }), /limits\.pat/);
});

test('detail is kept below the ceilings and dropped above them', () => {
  // Two one-card draws to a nine differ; two to a king do not.
  assert.notEqual(bucketOf(of('Kc9d7h4s2c')), bucketOf(of('Kc9d7h5s2c')),
    'draws to a nine are spelled out');
  assert.equal(signature(of('AcKdQhJs9c')).split('|')[1], 'O11',
    'a draw topping at a king keeps only its high card');
});

test('every hand in the deck lands in a bucket, and the buckets cover it exactly', () => {
  const { table, descriptors } = buckets();
  assert.equal(table.length, 2598960);
  const covered = descriptors.reduce((sum, d) => sum + d.hands, 0);
  assert.equal(covered, 2598960);
  assert.ok(descriptors.length > 1000 && descriptors.length < 6000,
    `expected a few thousand buckets, got ${descriptors.length}`);
});
