import test from 'node:test';
import assert from 'node:assert/strict';

import {
  benchmarkOpens, dealtShape, ranksOf, handFacts, standardsFor, buttonOpeningRange,
} from '../lib/badugi-benchmark.js';
import { score, sizeOf } from '../lib/badugi.js';
import { parseHand } from '../lib/cards.js';

test('a value\'s cards read back high to low, ace low', () => {
  // A-2-3 in three suits: a three-card hand, ace low, so 3 is the high card.
  assert.deepEqual(ranksOf(score(parseHand('Ah 2d 3c'))), [2, 1, 0]);
  // The nuts: A-2-3-4 in four suits.
  assert.deepEqual(ranksOf(score(parseHand('Ah 2d 3c 4s'))), [3, 2, 1, 0]);
  // A king-high badugi, which is the worst four-card hand there is.
  assert.deepEqual(ranksOf(score(parseHand('Kh Qd Jc Ts'))), [12, 11, 10, 9]);
});

test('the deck deals a complete badugi 6.3% of the time', () => {
  const shape = dealtShape();
  // The number quoted in HANDOFF and the README, recomputed from the deck.
  assert.ok(Math.abs(shape[4] - 6.3) < 0.05, `badugis are ${shape[4].toFixed(2)}%`);
  assert.ok(shape[3] > shape[2], 'three-card hands are the commonest holding');
  const total = Object.values(shape).reduce((sum, part) => sum + part, 0);
  assert.ok(Math.abs(total - 100) < 1e-9, `the sizes sum to ${total}`);
});

test('the published standard widens from UTG to the button', () => {
  const opens = benchmarkOpens();
  const order = ['UTG', 'HJ', 'CO', 'BTN'];
  for (let i = 1; i < order.length; i += 1) {
    const before = opens[order[i - 1]].tight;
    const after = opens[order[i]].tight;
    assert.ok(
      after > before,
      `${order[i]} opens ${after.toFixed(1)}% against ${order[i - 1]}'s ${before.toFixed(1)}%`,
    );
  }
  // This is the shape a solve has to reproduce before its level is worth
  // arguing about, so the numbers are pinned rather than merely ordered.
  assert.ok(Math.abs(opens.UTG.tight - 9.4) < 0.1, `UTG ${opens.UTG.tight.toFixed(1)}%`);
  assert.ok(Math.abs(opens.BTN.tight - 32.4) < 0.1, `BTN ${opens.BTN.tight.toFixed(1)}%`);
});

test('"smooth" only moves the seats whose standard uses the word', () => {
  const opens = benchmarkOpens();
  // The cut-off and button name their ranks outright - "all badugis, 8 high
  // tris or better" - so no reading of "smooth" can change them.
  assert.equal(opens.CO.tight, opens.CO.loose);
  assert.equal(opens.BTN.tight, opens.BTN.loose);
  // The two early seats are the ones the ambiguity costs, which is why both
  // readings are reported rather than one.
  assert.ok(opens.UTG.loose > opens.UTG.tight, 'a looser smooth opens more from UTG');
  assert.ok(opens.HJ.loose > opens.HJ.tight, 'a looser smooth opens more from the hijack');
});

test('every hand value is counted exactly once', () => {
  const { hands, total } = handFacts();
  assert.equal(total, 270725, 'the 52-choose-4 hands');
  assert.equal(hands.length, 1092, 'the distinct values');
  for (const hand of hands) {
    assert.equal(hand.ranks.length, hand.size, 'a hand has as many cards as it plays');
    assert.ok(hand.combos > 0, 'a value nothing makes is not a value');
    for (let i = 1; i < hand.ranks.length; i += 1) {
      assert.ok(hand.ranks[i] < hand.ranks[i - 1], 'cards read high to low, no repeats');
    }
  }
});

test('the standards accept the hands the article names and refuse the ones it does not', () => {
  // A smooth seven is one whose second card is a four or lower: the tight
  // reading, which is what the headline numbers use.
  const standards = standardsFor(3);
  const facts = (text) => {
    const value = score(parseHand(text));
    return { size: sizeOf(value), ranks: ranksOf(value) };
  };
  const opens = (position, text) => standards[position](facts(text));

  // Button: "A2, A3, 23, A4" are named two-card holdings; A5 is not.
  assert.ok(opens('BTN', 'Ah 2d 2s 2c'), 'A2 opens the button');
  assert.ok(!opens('BTN', 'Ah 5d 5s 5c'), 'A5 does not');
  // Early position: a ten-high badugi opens, a jack-high one does not.
  assert.ok(opens('UTG', 'Ah 2d 3c Ts'), 'a ten high badugi opens UTG');
  assert.ok(!opens('UTG', 'Ah 2d 3c Js'), 'a jack high badugi does not');
  // The hijack takes the jack-high badugi the earlier seat folded.
  assert.ok(opens('HJ', 'Ah 2d 3c Js'), 'a jack high badugi opens the hijack');
});

test('the button range is the one it was given, not the top of the deck', () => {
  const range = buttonOpeningRange();
  const { hands } = handFacts();
  const at = (size, ranks) => hands.findIndex((h) => h.size === size
    && h.ranks.length === ranks.length && h.ranks.every((r, i) => r === ranks[i]));
  const opens = (size, ranks) => Boolean(range[at(size, ranks)]);
  const R = { A: 0, 2: 1, 3: 2, 4: 3, 5: 4, 6: 5, 7: 6, 8: 7, 9: 8, T: 9 };

  // Every badugi, however bad.
  assert.ok(opens(4, [R.T, R[3], R[2], R.A]), 'a ten high badugi opens');
  assert.ok(opens(4, [12, 11, 10, 9]), 'so does K-Q-J-T');

  // Tris down to 965, which is all eight-highs and the smooth nine-highs.
  assert.ok(opens(3, [R[9], R[6], R[5]]), '965 is the worst nine-high opened');
  assert.ok(!opens(3, [R[9], R[7], R[5]]), '975 is not');
  assert.ok(opens(3, [R[8], R[7], R[6]]), '876 is the worst eight-high there is');
  assert.ok(!opens(3, [R.T, R[3], R[2]]), 'nothing over a nine');

  // The named two-card hands, and nothing beside them.
  for (const [high, low] of [[R[2], R.A], [R[3], R.A], [R[3], R[2]],
    [R[4], R.A], [R[5], R.A], [R[4], R[2]], [R[5], R[2]]]) {
    assert.ok(opens(2, [high, low]), 'a named two-card hand opens');
  }
  assert.ok(!opens(2, [R[6], R[2]]), '26 is not on the list');
  assert.ok(!opens(2, [R[4], R[3]]), 'nor is 34');

  // The shape is the point: it opens A2 and folds a ten-high tri, which no
  // ordering by hand value does.
  assert.ok(opens(2, [R[2], R.A]) && !opens(3, [R.T, R[3], R[2]]),
    'A2 over T32 is what makes this a range rather than a cutoff');
});
