import test from 'node:test';
import assert from 'node:assert/strict';

import { parseHand, makeRng, freshDeck, deal } from '../lib/cards.js';
import { handClasses, classLabel } from '../lib/ranking.js';
import { PAT, DRAW_ONE } from '../lib/abstraction.js';
import { equityOf } from '../lib/equity.js';

const of = (text) => parseHand(text);

test('the classes cover the deck exactly once', () => {
  const classes = handClasses();
  const total = classes.reduce((sum, entry) => sum + entry.combos, 0);
  assert.equal(total, 2598960);
  assert.ok(classes.length > 7000 && classes.length < 9000, `${classes.length} rows`);
});

test('a hand is split by whether the cards it keeps are all one suit', () => {
  const classes = handClasses();
  const find = (label) => classes.find((entry) => classLabel(entry) === label);

  // 7-5-4-3-2 stands pat, so the keep is all five cards and the split is the
  // flush: 4 of the 1,024 arrangements.
  assert.equal(find('75432').combos, 1020);
  assert.equal(find('75432s').combos, 4);
  assert.equal(find('75432').option, PAT);
  assert.equal(find('75432s').option, DRAW_ONE, 'a flush cannot stand pat');

  // K-7-5-4-3 throws the king, so the keep is four cards and the split is four
  // suits for the keep times four for the discard.
  assert.equal(find('K7543').combos, 1008);
  assert.equal(find('K7543s').combos, 16);

  // Both hands account for the same 1,024 arrangements either way.
  assert.equal(find('75432').combos + find('75432s').combos, 1024);
  assert.equal(find('K7543').combos + find('K7543s').combos, 1024);
});

test('a suited keep is worth markedly less than the same ranks spread out', () => {
  const classes = handClasses();
  const find = (label) => classes.find((entry) => classLabel(entry) === label);
  const plain = equityOf(find('K7543').cards, 1, 6000, makeRng(31));
  const suited = equityOf(find('K7543s').cards, 1, 6000, makeRng(31));
  assert.ok(plain - suited > 0.05,
    `drawing one to four of a suit should cost real equity: ${plain.toFixed(3)} vs ${suited.toFixed(3)}`);
});

test('the nuts cannot lose, and a flush of the same ranks is not the nuts', () => {
  assert.ok(equityOf(of('7c5d4h3s2c'), 1, 4000, makeRng(11)) > 0.999);
  assert.ok(equityOf(of('7c5c4c3c2c'), 1, 4000, makeRng(11)) < 0.8,
    'the same five ranks in one suit are a flush, and a flush is a bad hand');
});

test('equity follows the made-hand ladder', () => {
  const ladder = ['7c6d5h4s2c', '8c7d6h5s3c', '9c8d7h6s4c', 'Tc9d8h7s5c', 'Jc Td 9h 8s 6c'];
  // One seed for all of them: the ordering is the claim, not the levels.
  const equities = ladder.map((text) => equityOf(of(text), 1, 6000, makeRng(4242)));
  for (let i = 1; i < equities.length; i += 1) {
    assert.ok(equities[i - 1] > equities[i],
      `${ladder[i - 1]} (${equities[i - 1].toFixed(3)}) should beat `
      + `${ladder[i]} (${equities[i].toFixed(3)})`);
  }
});

test('a draw with no straight in it beats the smoother-looking one', () => {
  // K-8-5-4-3 draws to 8-5-4-3, which cannot make a straight. K-7-5-4-3 draws
  // to 7-5-4-3, which bricks with any six.
  const eight = equityOf(of('Kc8d5h4s3c'), 1, 8000, makeRng(909));
  const seven = equityOf(of('Kc7d5h4s3c'), 1, 8000, makeRng(909));
  assert.ok(eight > seven, `8-5-4-3 ${eight.toFixed(3)} vs 7-5-4-3 ${seven.toFixed(3)}`);
});

/**
 * The calibration that catches almost anything.
 *
 * Both players draw under the same policy out of the same deck, so a hand
 * picked at random is a coin flip against another one. If the draw policy, the
 * card removal, the showdown or the tie handling were wrong, this would not
 * land on a half.
 */
test('a random hand is a coin flip against a random hand', () => {
  const rng = makeRng(2026);
  const deck = freshDeck();
  let total = 0;
  const samples = 400;
  for (let i = 0; i < samples; i += 1) {
    const hand = Array.from(deal(deck, 5, rng));
    total += equityOf(hand, 1, 500, makeRng(50000 + i));
  }
  const mean = total / samples;
  assert.ok(Math.abs(mean - 0.5) < 0.03, `mean equity was ${(mean * 100).toFixed(2)}%, expected 50%`);
});

test('three-handed, a random hand wins a third of the time', () => {
  const rng = makeRng(77);
  const deck = freshDeck();
  let total = 0;
  const samples = 400;
  for (let i = 0; i < samples; i += 1) {
    const hand = Array.from(deal(deck, 5, rng));
    total += equityOf(hand, 2, 500, makeRng(60000 + i));
  }
  const mean = total / samples;
  assert.ok(Math.abs(mean - 1 / 3) < 0.03, `mean equity was ${(mean * 100).toFixed(2)}%, expected 33.3%`);
});
