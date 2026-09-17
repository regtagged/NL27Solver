import test from 'node:test';
import assert from 'node:assert/strict';

import { parseHand, rankOf, RANKS } from '../lib/cards.js';
import { score, categoryOf, STRAIGHT, HIGH_CARD } from '../lib/eval27.js';
import { keepScore, bestKeep, benchmarkRanks } from '../lib/draws.js';

const at = (text) => text.split('').map((ch) => RANKS.indexOf(ch));

/** Counts, over every replacement card, what a four-card keep turns into. */
function outcomes(keepText) {
  const kept = parseHand(keepText);
  const held = new Set(kept);
  let eightOrBetter = 0;
  let straights = 0;
  let live = 0;
  for (let card = 0; card < 52; card += 1) {
    if (held.has(card)) continue;
    live += 1;
    const hand = [...kept, card];
    const category = categoryOf(score(hand));
    if (category === STRAIGHT) straights += 1;
    else if (category === HIGH_CARD && Math.max(...hand.map(rankOf)) <= RANKS.indexOf('8')) {
      eightOrBetter += 1;
    }
  }
  return { eightOrBetter, straights, live };
}

test('8-5-4-3 outdraws 7-5-4-3, because a straight counts against you', () => {
  const seven = outcomes('7c5d4h3s');
  const eight = outcomes('8c5d4h3s');

  assert.equal(seven.live, 48);
  assert.equal(seven.eightOrBetter, 8);
  assert.equal(seven.straights, 4, 'any six ruins 7-5-4-3');

  assert.equal(eight.eightOrBetter, 12, 'half again as often');
  assert.equal(eight.straights, 0, '8-5-4-3 cannot make a straight');

  assert.ok(keepScore(at('8543'), false, 1) > keepScore(at('7543'), false, 1),
    'the score has to agree with the enumeration');
});

test('7-6-5-4 is a trap: the smoothest four cards are the worst keep', () => {
  const smooth = outcomes('7c6d5h4s');
  assert.equal(smooth.straights, 8, 'both a three and an eight make a straight');
  assert.equal(smooth.eightOrBetter, 4);
  assert.ok(keepScore(at('7654'), false, 1) < keepScore(at('8543'), false, 1));
  assert.ok(keepScore(at('7654'), false, 1) < keepScore(at('7543'), false, 1));
});

test('the best keep skips a card to dodge a straight', () => {
  // Holding 4-5-6-7-9: keeping 4-5-6-7 is four to a straight from both ends.
  assert.deepEqual(bestKeep(at('45679'), 4), at('4569'));
  // Holding 2-3-4-5-7 and drawing two, 2-3-4 can complete; 2-3-7 cannot.
  assert.deepEqual(bestKeep(at('23457'), 3), at('237'));
});

test('a keep stuck in one suit scores worse than the same ranks spread out', () => {
  assert.ok(keepScore(at('7542'), true, 1) < keepScore(at('7542'), false, 1),
    'four to a flush can brick into one');
  assert.ok(keepScore(at('752'), true, 2) < keepScore(at('752'), false, 2),
    'three to a flush can too, more rarely');
});

test('the benchmark ladder runs from the eight upward', () => {
  const ladder = benchmarkRanks();
  assert.equal(ladder.length, 4);
  for (let i = 1; i < ladder.length; i += 1) assert.ok(ladder[i - 1] < ladder[i]);
});

test('a keep that cannot be made is refused rather than guessed at', () => {
  assert.equal(bestKeep(at('72'), 4), null, 'two ranks cannot fill a four-card keep');
  assert.equal(bestKeep(at('72'), 3), null);
  // Keeping five is standing pat, which is the hand rather than a subset, so
  // asking for it is a programming error rather than a strategy.
  assert.throws(() => bestKeep(at('75432'), 5), /nought to four/);
  assert.deepEqual(bestKeep(at('7532'), 0), [], 'keeping nothing is drawing five');
});
