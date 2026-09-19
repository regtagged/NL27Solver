/**
 * One published opening standard for badugi, priced over the deck.
 *
 * **This is a reference point, not ground truth.** It is one author's teaching
 * range - countingouts.com's badugi rules and basic strategy - and other
 * published ranges disagree with it, in both directions. Nobody has solved this
 * game, so there is no range here that could be the answer. Treat a
 * disagreement in *level* as a question worth asking rather than as a fault.
 *
 * What is worth holding the solver to is **the shape, not the level**. Every
 * reasonable range set widens from first position to the button, because that
 * is what position is; the exact percentage a given author opens is a matter of
 * their assumptions about the game and the field. So the ordering is the
 * invariant, and the percentages below are a sanity band - if a solve opens
 * 38% under the gun, something is wrong whichever standard you prefer; if it
 * opens 11% where this says 9.4%, that is a conversation and not a bug.
 *
 * The 2-7 solver has the same kind of reference point and cannot be held even
 * to the shape, because a disagreement there could always be the abstraction
 * talking. Here the solver runs on all 1,092 hand values with nothing
 * abstracted, so a disagreement is about the game or about the solve - and
 * `scripts/badugi-exploitability.mjs` is what tells those two apart.
 *
 * The standards, as this one is written:
 *
 * | position | opens with |
 * | --- | --- |
 * | Early | ten high or better badugis; smooth 7 high tris or better |
 * | Hijack | jack high or better badugis; smooth 8 high tris or better |
 * | Cut-off | all badugis; 8 high tris or better; A2 and A3 |
 * | Button | all badugis; 9 high tris or better; A2, A3, 23, A4 |
 *
 * **"Smooth" is not defined numerically there**, and it moves the early
 * positions by a few points, so both readings are computed: `tight` takes a
 * smooth seven to mean its second card is a four or lower, `loose` takes it to
 * mean any seven-high tri. Quote the range, not one end of it.
 *
 * Two more things this is not. It is a six-handed cash standard and the
 * solver's game is a 200bb limit game with its own prunings - no limping, at
 * most two seats entering - so even a perfect solve of *this* game should not
 * reproduce it exactly. And the blinds are not covered by it at all: they are
 * closing the action rather than opening it.
 */

import { badugiTable, sizeOf } from './badugi.js';

/** Ace low, as badugi ranks them: A is 0 and king is 12. */
const R = { A: 0, 2: 1, 3: 2, 4: 3, 5: 4, 6: 5, 7: 6, 8: 7, 9: 8, T: 9, J: 10, Q: 11, K: 12 };
const PLACES = [13 ** 3, 13 ** 2, 13, 1];

/** A value's playing cards, high to low. */
export function ranksOf(value) {
  const size = sizeOf(value);
  let rest = value % 13 ** 4;
  const ranks = [];
  for (let i = 0; i < size; i += 1) {
    const rank = Math.floor(rest / PLACES[i]);
    rest -= rank * PLACES[i];
    ranks.push(rank);
  }
  return ranks;
}

/** A two-card holding of exactly these ranks, given high then low. */
const pair = (hand, high, low) => hand.size === 2 && hand.ranks[0] === high && hand.ranks[1] === low;

/**
 * The standards as predicates. `smooth` is the second card a tri may have and
 * still count as smooth, which is the reading the caller chose.
 */
export function standardsFor(smooth) {
  return {
    UTG: (hand) => (hand.size === 4 && hand.ranks[0] <= R.T)
      || (hand.size === 3 && (hand.ranks[0] < R[7]
        || (hand.ranks[0] === R[7] && hand.ranks[1] <= smooth))),
    HJ: (hand) => (hand.size === 4 && hand.ranks[0] <= R.J)
      || (hand.size === 3 && (hand.ranks[0] < R[8]
        || (hand.ranks[0] === R[8] && hand.ranks[1] <= smooth))),
    CO: (hand) => hand.size === 4
      || (hand.size === 3 && hand.ranks[0] <= R[8])
      || pair(hand, R[2], R.A) || pair(hand, R[3], R.A),
    BTN: (hand) => hand.size === 4
      || (hand.size === 3 && hand.ranks[0] <= R[9])
      || pair(hand, R[2], R.A) || pair(hand, R[3], R.A)
      || pair(hand, R[3], R[2]) || pair(hand, R[4], R.A),
  };
}

let cached = null;

/** Every hand value with its size, its cards and how many combinations it is. */
export function handFacts() {
  if (cached) return cached;
  const { combos, values, count } = badugiTable();
  const hands = [];
  let total = 0;
  for (let i = 0; i < count; i += 1) {
    hands.push({ size: sizeOf(values[i]), ranks: ranksOf(values[i]), combos: combos[i] });
    total += combos[i];
  }
  cached = { hands, total };
  return cached;
}

/**
 * What each position's standard opens, as a percentage of all 270,725 hands.
 *
 * Returns `{ UTG: { tight, loose }, ... }` - the two readings of "smooth". The
 * two agree from the cut-off down, where the standard names ranks outright.
 */
export function benchmarkOpens() {
  const { hands, total } = handFacts();
  const out = {};
  for (const [reading, smooth] of [['tight', R[4]], ['loose', R[6]]]) {
    for (const [position, fits] of Object.entries(standardsFor(smooth))) {
      let combos = 0;
      for (const hand of hands) if (fits(hand)) combos += hand.combos;
      out[position] ??= {};
      out[position][reading] = 100 * combos / total;
    }
  }
  return out;
}

/**
 * A range as the solver wants it: one byte per hand value, one meaning in.
 *
 * `fits` is a predicate over `{ size, ranks, combos }`, so a published standard
 * from `standardsFor` drops straight in - but so does anything else, which
 * matters, because **the preset decides the answer.** A subgame solved after
 * the button opens is a study of whatever range the button was given, and
 * nothing in the solve will notice if that range is wrong.
 */
export function rangeOf(fits) {
  const { hands } = handFacts();
  const range = new Uint8Array(hands.length);
  let combos = 0;
  let total = 0;
  for (let i = 0; i < hands.length; i += 1) {
    total += hands[i].combos;
    if (!fits(hands[i])) continue;
    range[i] = 1;
    combos += hands[i].combos;
  }
  range.share = 100 * combos / total;
  return range;
}

/**
 * The button's opening range, as the player this tool is for plays it.
 *
 * Given rather than derived, and it is not the best 32.7% of hands by showdown
 * strength - which is the point of stating it rather than computing it. It
 * opens A2, A3, 23, A4, A5, 24 and 25, two-card hands needing two more, while
 * folding every tri above a nine. A ten-high tri is a made three-card hand and
 * a one-card draw; A2 is neither, and gets opened ahead of it, because what a
 * hand draws to is worth more here than what it currently is. No ordering by
 * hand value produces that, which is why `rangeByShare` is the wrong tool for
 * a real range and this is written out by hand.
 *
 * Tris: everything 965 or better. That is all eight-high tris - 876 is the
 * worst eight-high there is - and the nine-high ones whose second card is a
 * six or lower.
 */
export function buttonOpeningRange() {
  const R = { A: 0, 2: 1, 3: 2, 4: 3, 5: 4, 6: 5, 7: 6, 8: 7, 9: 8 };
  const twos = [
    [R[2], R.A], [R[3], R.A], [R[3], R[2]], [R[4], R.A],
    [R[5], R.A], [R[4], R[2]], [R[5], R[2]],
  ];
  return rangeOf((hand) => {
    if (hand.size === 4) return true;
    if (hand.size === 3) {
      if (hand.ranks[0] <= R[8]) return true;
      return hand.ranks[0] === R[9] && hand.ranks[1] <= R[6];
    }
    if (hand.size === 2) {
      return twos.some(([high, low]) => hand.ranks[0] === high && hand.ranks[1] === low);
    }
    return false;
  });
}

const SIZE_NAME = { 4: 'badugis', 3: 'tris', 2: 'two-card hands', 1: 'one-card hands' };
const RANK_NAME = ['A', '2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K'];

/**
 * The best `percent` of hands, by the strength they would show down.
 *
 * Hand values are already sorted best first, so this is a walk down that order
 * until the combinations add up. It takes every badugi before any three-card
 * hand and every three-card hand before any two-card one, which is a *choice*
 * and not the only one: published ranges typically open A2 and A3 - two cards
 * that need two more - ahead of a jack-high tri that needs one, because what
 * those hands draw to is worth more than what they are. This ordering does not
 * know that.
 *
 * So use it as a stated assumption rather than as a definition of "45%". If a
 * range is meant to include the low two-card hands, build it with `rangeOf` and
 * a predicate that says so.
 */
export function rangeByShare(percent) {
  const { hands, total } = handFacts();
  const want = total * percent / 100;
  const range = new Uint8Array(hands.length);
  let combos = 0;
  for (let i = 0; i < hands.length && combos < want; i += 1) {
    range[i] = 1;
    combos += hands[i].combos;
  }
  range.share = 100 * combos / total;
  return range;
}

/**
 * What a range actually contains, in the terms a player would use: how much of
 * each holding size, and the worst hand of each that made it in.
 */
export function describeRange(range) {
  const { hands, total } = handFacts();
  const parts = [];
  for (const size of [4, 3, 2, 1]) {
    let combos = 0;
    let all = 0;
    let worst = null;
    for (let i = 0; i < hands.length; i += 1) {
      if (hands[i].size !== size) continue;
      all += hands[i].combos;
      if (!range[i]) continue;
      combos += hands[i].combos;
      worst = hands[i];
    }
    if (!combos) continue;
    const share = 100 * combos / total;
    const whole = combos === all;
    const edge = worst.ranks.map((r) => RANK_NAME[r]).join('');
    parts.push(`${share.toFixed(1)}% ${SIZE_NAME[size]}`
      + (whole ? ' (all of them)' : ` (down to ${edge})`));
  }
  return parts.join(', ');
}

/** How much of the deck is dealt as a badugi, a tri, and so on. */
export function dealtShape() {
  const { hands, total } = handFacts();
  const shape = {};
  for (const hand of hands) shape[hand.size] = (shape[hand.size] ?? 0) + hand.combos;
  for (const size of Object.keys(shape)) shape[size] = 100 * shape[size] / total;
  return shape;
}
