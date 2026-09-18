import test from 'node:test';
import assert from 'node:assert/strict';

import { parseHand } from '../lib/cards.js';
import {
  score, sizeOf, describe, badugiTable, handIndex, index4, lowRank,
} from '../lib/badugi.js';

const hand = (text) => parseHand(text);
const beats = (a, b) => score(hand(a)) < score(hand(b));

test('the ace plays low, and is the best card there is', () => {
  assert.equal(lowRank(...hand('Ah')), 0);
  assert.equal(lowRank(...hand('2h')), 1);
  assert.equal(lowRank(...hand('Kh')), 12);
  assert.ok(beats('Ah 2d 3c 4s', '2h 3d 4c 5s'), 'A234 is the nuts');
});

test('size beats everything, however low the cards', () => {
  // A four-card king-high badugi beats the lowest possible three-card hand.
  assert.ok(beats('Kh Qd Jc Ts', 'Ah 2h 3d 4c'),
    'any badugi beats any three-card hand');
  assert.equal(sizeOf(score(hand('Kh Qd Jc Ts'))), 4);
  assert.equal(sizeOf(score(hand('Ah 2h 3d 4c'))), 3, 'two hearts, so one is dead');
  assert.equal(sizeOf(score(hand('Ah 2h 3h 4h'))), 1, 'one suit plays one card');
  assert.equal(sizeOf(score(hand('Ah Ad As Ac'))), 1, 'one rank plays one card');
});

test('within a size the lowest cards win, compared from the top', () => {
  assert.ok(beats('5h 4d 3c 2s', '6h 4d 3c 2s'), 'a five beats a six');
  assert.ok(beats('6h 4d 3c 2s', '6h 5d 3c 2s'), 'and the next card breaks it');
  // A three-card hand made from a four-card holding plays its best three.
  assert.ok(beats('Ah 2h 3d 4c', 'Kh Kd 2c 3s'));
});

test('a hand plays its best subset, not the one dealt', () => {
  // 2h is dead against 3h; the hand is the three-card A-2-3 using the other
  // three suits... which here means A, 3, and the club.
  const value = score(hand('Ah 3h 2d 4c'));
  assert.equal(sizeOf(value), 3);
  assert.equal(describe(value), '3-card 42A', 'the lowest three that fit');
});

test('the labels read the way the hand is spoken', () => {
  assert.equal(describe(score(hand('Ah 2d 3c 4s'))), '4-card 432A');
  assert.equal(describe(score(hand('Ah 2h 3h 4h'))), '1-card A');
});

test('the hand space is 1,092 values over every four-card holding', () => {
  const { table, count, combos, labels } = badugiTable();
  assert.equal(count, 1092);
  assert.equal(labels.length, 1092);

  let total = 0;
  for (const n of combos) total += n;
  assert.equal(total, 270725, '52 choose 4');

  // Index 0 is the best hand, and it is the one everybody would name.
  assert.equal(labels[0], '4-card 432A');
  assert.equal(table[handIndex(hand('Ah 2d 3c 4s'))], 0);
  assert.equal(labels[count - 1], '1-card K', 'and the worst is a lone king');

  // Only a small share of holdings are a complete badugi.
  let badugis = 0;
  for (let i = 0; i < count; i += 1) if (labels[i].startsWith('4-card')) badugis += combos[i];
  assert.equal(badugis, 17160);
});

test('the index is dense and order does not matter', () => {
  assert.equal(index4(0, 1, 2, 3), 0);
  assert.equal(index4(48, 49, 50, 51), 270724, 'the last of 270,725');
  assert.equal(handIndex(hand('4s 3c 2d Ah')), handIndex(hand('Ah 2d 3c 4s')));
});

test('a better hand always has a lower index in the table', () => {
  const { table } = badugiTable();
  const at = (text) => table[handIndex(hand(text))];
  assert.ok(at('Ah 2d 3c 4s') < at('Ah 2d 3c 5s'));
  assert.ok(at('Kh Qd Jc Ts') < at('Ah 2h 3d 4c'), 'a badugi outranks a three-card hand');
});
