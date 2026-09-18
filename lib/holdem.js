/**
 * Hold'em hand strength, and the 169 starting hands.
 *
 * This game is the other way up from the one the rest of the repo plays, and
 * almost none of that matters: `eval27.score` already scores five cards as a
 * high hand, and 2-7 wins by reading it backwards. So the work here is two
 * things it does not do.
 *
 * **The wheel is a straight.** A-5-4-3-2 is the lowest straight in hold'em and
 * is deliberately not one in 2-7, where the ace is high only and there are nine
 * straights rather than ten. `eval27` says so in its header and asserts it in
 * its tests, so it cannot simply be borrowed - this file adds the case back.
 *
 * **Seven cards, not five.** A hand is the best five of two down and five up,
 * which is twenty-one five-card hands to score and the largest to keep.
 *
 * Higher is better everywhere in this file, which is the opposite of everywhere
 * else in this repo. That inversion is the thing to keep hold of when reading
 * both at once.
 */

import {
  score, HIGH_CARD, STRAIGHT, STRAIGHT_FLUSH, FLUSH, categoryOf,
} from './eval27.js';
import { RANKS } from './cards.js';

const RANK_BASE = 371293; // 13^5, as in eval27

/** Ace, five, four, three, two - as rank indices, with the ace high at 12. */
const WHEEL = [12, 3, 2, 1, 0];

/**
 * Five cards, scored as hold'em scores them.
 *
 * Everything but the wheel is what `eval27` already computes. The wheel has to
 * be recognised here and ranked as a five-high straight, which is the weakest
 * straight there is - below six-high, and above every no-pair hand.
 */
export function scoreHigh(cards) {
  const plain = score(cards);
  const category = categoryOf(plain);
  // Only a hand of five distinct ranks can be a straight, and `eval27` scores
  // those as a flush or a high card when they are not consecutive.
  if (category !== HIGH_CARD && category !== FLUSH) return plain;

  const ranks = new Set();
  for (const card of cards) ranks.add(card % 13);
  if (ranks.size !== 5) return plain;
  for (const rank of WHEEL) if (!ranks.has(rank)) return plain;

  // A five-high straight, or a five-high straight flush. Its slot is the five,
  // which is rank index 3, and nothing else: a straight is named by its top
  // card and the rest follows from it.
  const made = category === FLUSH ? STRAIGHT_FLUSH : STRAIGHT;
  return made * RANK_BASE + 3 * 13 * 13 * 13 * 13;
}

/** Every way to leave two of seven cards out, as index pairs. */
const OMIT = (() => {
  const out = [];
  for (let i = 0; i < 7; i += 1) for (let j = i + 1; j < 7; j += 1) out.push([i, j]);
  return out;
})();

const five = new Array(5);

/**
 * The best five-card hand out of seven.
 *
 * Twenty-one subsets, which is small enough to walk and much simpler than
 * anything clever. The scratch array is reused because this is the inner loop
 * of every showdown in a solve.
 */
export function best7(cards) {
  let best = -1;
  for (let k = 0; k < OMIT.length; k += 1) {
    const [skipA, skipB] = OMIT[k];
    let at = 0;
    for (let i = 0; i < 7; i += 1) {
      if (i === skipA || i === skipB) continue;
      five[at] = cards[i];
      at += 1;
    }
    const value = scoreHigh(five);
    if (value > best) best = value;
  }
  return best;
}

/**
 * The 169 starting hands: a pair, or two ranks suited or offsuit.
 *
 * This is not an abstraction in the sense the rest of the repo means one. Two
 * hands in the same class are the same hand before any card is dealt - AhKh and
 * AsKs differ only in which flushes they can make, and by symmetry that is
 * worth nothing when no board is out. It is exact, which is why push-fold is a
 * game worth solving here: nothing is being approximated except the tree.
 */
export const HAND_CLASS_COUNT = 169;

/** A class index from two cards, 0 for AA and 168 for 32o. */
export function handClass(a, b) {
  const rankA = a % 13;
  const rankB = b % 13;
  const suited = ((a / 13) | 0) === ((b / 13) | 0);
  const high = Math.max(rankA, rankB);
  const low = Math.min(rankA, rankB);
  // A grid read from the ace down: pairs on the diagonal, suited above it.
  const row = 12 - high;
  const column = 12 - low;
  return suited || row === column ? row * 13 + column : column * 13 + row;
}

/** "AA", "AKs", "AKo" - the names people actually use. */
export const HAND_CLASS_LABELS = (() => {
  const labels = new Array(HAND_CLASS_COUNT);
  for (let row = 0; row < 13; row += 1) {
    for (let column = 0; column < 13; column += 1) {
      const high = RANKS[12 - Math.min(row, column)];
      const low = RANKS[12 - Math.max(row, column)];
      labels[row * 13 + column] = row === column
        ? `${high}${high}`
        : `${high}${low}${row < column ? 's' : 'o'}`;
    }
  }
  return labels;
})();

/** How many of the 1,326 two-card holdings fall in each class: 6, 4 or 12. */
export const HAND_CLASS_COMBOS = (() => {
  const combos = new Int32Array(HAND_CLASS_COUNT);
  for (let a = 0; a < 52; a += 1) {
    for (let b = a + 1; b < 52; b += 1) combos[handClass(a, b)] += 1;
  }
  return combos;
})();
