import test from 'node:test';
import assert from 'node:assert/strict';

import { parseHand } from '../lib/cards.js';
import { categoryOf, STRAIGHT, STRAIGHT_FLUSH, HIGH_CARD, PAIR, FLUSH, QUADS } from '../lib/eval27.js';
import {
  scoreHigh, best7, handClass, HAND_CLASS_LABELS, HAND_CLASS_COMBOS, HAND_CLASS_COUNT,
} from '../lib/holdem.js';
import { TWO_PAIR, TRIPS, FULL_HOUSE } from '../lib/eval27.js';

const hand = (text) => parseHand(text);
const beats = (a, b) => scoreHigh(hand(a)) > scoreHigh(hand(b));

test('the wheel is a straight here, and the lowest one', () => {
  const wheel = scoreHigh(hand('Ah 5d 4c 3s 2h'));
  assert.equal(categoryOf(wheel), STRAIGHT);
  // Below every other straight, and above every no-pair hand.
  assert.ok(scoreHigh(hand('6h 5d 4c 3s 2h')) > wheel, 'a six-high straight is better');
  assert.ok(wheel > scoreHigh(hand('Ah Kd Qc Js 9h')), 'and ace-high is worse');

  // This is exactly what 2-7 refuses to do, which is why it could not be reused.
  assert.equal(categoryOf(scoreHigh(hand('Ah Kd Qc Js Th'))), STRAIGHT, 'broadway still counts');
});

test('a wheel in one suit is a straight flush', () => {
  assert.equal(categoryOf(scoreHigh(hand('Ah 5h 4h 3h 2h'))), STRAIGHT_FLUSH);
  assert.ok(scoreHigh(hand('6h 5h 4h 3h 2h')) > scoreHigh(hand('Ah 5h 4h 3h 2h')));
});

test('the ordinary hand ranks are the ones everybody knows', () => {
  assert.ok(beats('Ah Ad Ac As Kh', 'Kh Kd Kc Ks Ah'), 'quad aces over quad kings');
  assert.ok(beats('2h 2d 2c 3s 3h', 'Ah Kd Qc Js 9h'), 'a full house over ace high');
  assert.ok(beats('Ah Kh Qh Jh 9h', '2h 2d 2c 3s 4h'), 'a flush over trips');
  assert.ok(beats('9h 8d 7c 6s 5h', '2h 2d 3c 3s 4h'), 'a straight over two pair');
  assert.equal(categoryOf(scoreHigh(hand('Ah Ad Ac As Kh'))), QUADS);
  assert.equal(categoryOf(scoreHigh(hand('Ah Kd Qc Js 9h'))), HIGH_CARD);
  assert.equal(categoryOf(scoreHigh(hand('Ah Ad Qc Js 9h'))), PAIR);
  assert.equal(categoryOf(scoreHigh(hand('Ah Kh Qh Jh 9h'))), FLUSH);
});

test('seven cards play the best five of them', () => {
  // The board alone is a straight; the hand cannot do better than play it.
  const board = 'Th 9d 8c 7s 6h';
  const withJunk = best7(hand(`2h 3d ${board}`));
  const withNine = best7(hand(`Jh 2d ${board}`));
  assert.equal(categoryOf(withJunk), STRAIGHT);
  assert.ok(withNine > withJunk, 'a jack makes a bigger straight out of the same board');

  // A third ten in the hole makes a set out of a board that pairs it.
  const set = best7(hand('Td Tc Th 9d 2s 4h Ah'));
  assert.ok(categoryOf(set) > PAIR, 'three tens beat any one pair');
});

test('a class is the hand before any card is dealt', () => {
  assert.equal(HAND_CLASS_LABELS[handClass(...hand('Ah As'))], 'AA');
  assert.equal(HAND_CLASS_LABELS[handClass(...hand('Ah Kh'))], 'AKs');
  assert.equal(HAND_CLASS_LABELS[handClass(...hand('Ah Ks'))], 'AKo');
  assert.equal(HAND_CLASS_LABELS[handClass(...hand('3h 2s'))], '32o');
  assert.equal(HAND_CLASS_LABELS[handClass(...hand('2h 2s'))], '22');
  // Order of the two cards cannot matter.
  assert.equal(handClass(...hand('Kh Ah')), handClass(...hand('Ah Kh')));
});

test('the classes cover all 1,326 holdings exactly once', () => {
  assert.equal(HAND_CLASS_COMBOS.length, HAND_CLASS_COUNT);
  let total = 0;
  for (const n of HAND_CLASS_COMBOS) total += n;
  assert.equal(total, 1326, '52 choose 2');
  // Six ways to make a pair, four to make a suited hand, twelve an offsuit one.
  assert.equal(HAND_CLASS_COMBOS[handClass(...hand('Ah As'))], 6);
  assert.equal(HAND_CLASS_COMBOS[handClass(...hand('Ah Kh'))], 4);
  assert.equal(HAND_CLASS_COMBOS[handClass(...hand('Ah Ks'))], 12);
});

test('every five-card hand in the deck lands in the right category', () => {
  // The counts every poker book prints. Nothing else pins an evaluator down
  // this hard: a wheel misfiled as a high card moves two of these numbers, and
  // they have to come out exact.
  const expected = [
    [HIGH_CARD, 1302540], [PAIR, 1098240], [TWO_PAIR, 123552], [TRIPS, 54912],
    [STRAIGHT, 10200], [FLUSH, 5108], [FULL_HOUSE, 3744], [QUADS, 624],
    [STRAIGHT_FLUSH, 40],
  ];
  const seen = new Int32Array(9);
  const five = new Array(5);
  for (let a = 0; a < 52; a += 1)
   for (let b = a + 1; b < 52; b += 1)
    for (let c = b + 1; c < 52; c += 1)
     for (let d = c + 1; d < 52; d += 1)
      for (let e = d + 1; e < 52; e += 1) {
        five[0] = a; five[1] = b; five[2] = c; five[3] = d; five[4] = e;
        seen[categoryOf(scoreHigh(five))] += 1;
      }
  for (const [category, count] of expected) assert.equal(seen[category], count);
});

test('a wheel found among seven cards is still a wheel', () => {
  // The ace is in the hole and the rest is board: the straight only exists
  // because the ace plays low, which is the case 2-7 deliberately refuses.
  const made = best7(hand('Ah Kd 5c 4s 3h 2d 9c'));
  assert.equal(categoryOf(made), STRAIGHT);
  assert.equal(made, scoreHigh(hand('Ah 5c 4s 3h 2d')), 'and it is scored as the wheel');

  // With a six about, the six-high straight is the better five.
  const better = best7(hand('Ah 6d 5c 4s 3h 2d 9c'));
  assert.ok(better > made);
});

test('the same hand from different cards ties exactly', () => {
  // Both players play the board, so the pot is split and the scores must be
  // equal rather than merely close - the solver splits on equality.
  const board = 'Ah Kh Qh Jh Th';
  assert.equal(best7(hand(`2c 3d ${board}`)), best7(hand(`7s 8s ${board}`)));
  // A kicker that cannot play changes nothing.
  assert.equal(
    best7(hand('Ac Ad Kh Qs 7c 4d 2h')),
    best7(hand('As Ah Kh Qs 7c 4d 2h')),
  );
});
