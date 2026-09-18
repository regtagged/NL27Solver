/**
 * Badugi hand strength, and the whole of its hand space.
 *
 * A badugi hand is the largest subset of your four cards with no repeated rank
 * and no repeated suit. Size beats everything: any four-card badugi beats any
 * three-card hand, however low. Within a size, the lowest cards win, compared
 * from the top down. The ace plays low, so A-2-3-4 in four suits is the nuts.
 *
 * Four cards means at most sixteen subsets, so the best one is found by walking
 * them rather than by anything clever.
 *
 * **Lower is better here**, as in 2-7 and unlike `lib/holdem.js`. A hand is
 * scored as a single integer so a showdown is a comparison.
 *
 * ## Why this game is worth solving
 *
 * All 270,725 four-card hands hold only 1,092 distinct values, so the solver
 * can run on the hand itself rather than on a bucketing of it. Nothing is
 * approximated: no abstraction, and a tree small enough to solve whole. That
 * makes a disagreement with a known answer a bug rather than an artifact, which
 * is not true of the 2-7 solver and is the reason this exists.
 */

import { RANKS } from './cards.js';

/** Ace low: A is 0 and king is 12, which is the order badugi ranks them in. */
export const lowRank = (card) => (card % 13 + 1) % 13;
export const suitOf = (card) => (card / 13) | 0;

/** The ace-low name of a rank, so a label reads the way players say it. */
const LOW_NAMES = ['A', ...RANKS.slice(0, 12)];

/**
 * The value of a four-card holding, lower being better.
 *
 * Packed as one integer: the number of cards *missing* from a badugi in the top
 * digits, then the playing cards from high to low. Comparing the integers is
 * therefore comparing size first and cards after, which is the rule.
 */
export function score(cards) {
  let best = Infinity;
  for (let mask = 1; mask < 16; mask += 1) {
    let ranks = 0;
    let suits = 0;
    let count = 0;
    let ok = true;
    for (let i = 0; i < 4; i += 1) {
      if (!(mask & (1 << i))) continue;
      const rank = lowRank(cards[i]);
      const suit = suitOf(cards[i]);
      if ((ranks & (1 << rank)) || (suits & (1 << suit))) { ok = false; break; }
      ranks |= 1 << rank;
      suits |= 1 << suit;
      count += 1;
    }
    if (!ok) continue;

    // The playing cards, high to low, in four slots. Slots a short hand does
    // not use are left at zero, which cannot make it beat a longer one because
    // the size sits above them.
    let value = (4 - count) * 13 * 13 * 13 * 13;
    let place = 13 * 13 * 13;
    for (let rank = 12; rank >= 0 && place >= 1; rank -= 1) {
      if (!(ranks & (1 << rank))) continue;
      value += rank * place;
      place /= 13;
    }
    if (value < best) best = value;
  }
  return best;
}

/** How many cards of the holding actually play. */
export const sizeOf = (value) => 4 - Math.floor(value / (13 * 13 * 13 * 13));

/** "4-card 5432", "3-card A32" - what the hand would be called. */
export function describe(value) {
  const size = sizeOf(value);
  let rest = value % (13 * 13 * 13 * 13);
  const places = [13 * 13 * 13, 13 * 13, 13, 1];
  const ranks = [];
  for (let i = 0; i < size; i += 1) {
    const rank = Math.floor(rest / places[i]);
    rest -= rank * places[i];
    ranks.push(LOW_NAMES[rank]);
  }
  return `${size}-card ${ranks.join('')}`;
}

let cached = null;

/**
 * Every four-card holding mapped to its value's index, plus what each is worth.
 *
 * The table is addressed by `index4`, and the values are sorted best first, so
 * a lower index is a better hand. This is the solver's whole hand model: not a
 * bucketing of the game but the game itself, at 1,092 decisions wide.
 */
export function badugiTable() {
  if (cached) return cached;

  const table = new Uint16Array(index4(48, 49, 50, 51) + 1);
  const values = new Map();
  const cards = [0, 0, 0, 0];
  for (cards[0] = 0; cards[0] < 52; cards[0] += 1) {
    for (cards[1] = cards[0] + 1; cards[1] < 52; cards[1] += 1) {
      for (cards[2] = cards[1] + 1; cards[2] < 52; cards[2] += 1) {
        for (cards[3] = cards[2] + 1; cards[3] < 52; cards[3] += 1) {
          const value = score(cards);
          if (!values.has(value)) values.set(value, 0);
          values.set(value, values.get(value) + 1);
        }
      }
    }
  }

  const sorted = [...values.keys()].sort((a, b) => a - b);
  const rank = new Map(sorted.map((value, i) => [value, i]));
  const combos = new Int32Array(sorted.length);
  for (cards[0] = 0; cards[0] < 52; cards[0] += 1) {
    for (cards[1] = cards[0] + 1; cards[1] < 52; cards[1] += 1) {
      for (cards[2] = cards[1] + 1; cards[2] < 52; cards[2] += 1) {
        for (cards[3] = cards[2] + 1; cards[3] < 52; cards[3] += 1) {
          const at = rank.get(score(cards));
          table[index4(cards[0], cards[1], cards[2], cards[3])] = at;
          combos[at] += 1;
        }
      }
    }
  }

  cached = {
    table,
    count: sorted.length,
    combos,
    labels: sorted.map((value) => describe(value)),
    values: sorted,
  };
  return cached;
}

/**
 * A four-card holding's index, for cards given in ascending order.
 *
 * The same combinatorial numbering `eval27.index5` uses, one card shorter: it
 * is dense, so the lookup table has no holes in it.
 */
export function index4(a, b, c, d) {
  return choose(a, 1) + choose(b, 2) + choose(c, 3) + choose(d, 4);
}

const CHOOSE = (() => {
  const table = [];
  for (let n = 0; n < 53; n += 1) {
    table.push([1, n, (n * (n - 1)) / 2, (n * (n - 1) * (n - 2)) / 6,
      (n * (n - 1) * (n - 2) * (n - 3)) / 24]);
  }
  return table;
})();

const choose = (n, k) => (n >= k ? CHOOSE[n][k] : 0);

/** A holding's index, however the cards are ordered. */
export function handIndex(cards) {
  const sorted = [...cards].sort((x, y) => x - y);
  return index4(sorted[0], sorted[1], sorted[2], sorted[3]);
}
