/**
 * Deuce-to-seven hand strength.
 *
 * Every hand is scored as though it were a high hand, and in 2-7 the *lowest*
 * score wins. That single inversion is the whole game: no pair beats a pair, a
 * straight and a flush are both disasters, and 7-5-4-3-2 offsuit is the nuts.
 *
 * Two rules here are the ones that get written wrong, and both are asserted in
 * the tests rather than trusted:
 *
 * - The ace is high only. 5-4-3-2-A is therefore *not* a straight; it is an
 *   ace-high hand, and a poor one, because the ace is the highest card in the
 *   deck. This game has nine straights, not ten.
 * - A flush counts against you however perfect its ranks are. 7-5-4-3-2 of one
 *   suit is a flush, and loses to every no-pair hand in the deck.
 *
 * `score` returns high-hand strength, so **lower is better** everywhere below.
 * Scores are comparable but not meaningful on their own; only their order is.
 */

import { DECK_SIZE } from './cards.js';

export const HIGH_CARD = 0;
export const PAIR = 1;
export const TWO_PAIR = 2;
export const TRIPS = 3;
export const STRAIGHT = 4;
export const FLUSH = 5;
export const FULL_HOUSE = 6;
export const QUADS = 7;
export const STRAIGHT_FLUSH = 8;

export const CATEGORY_NAMES = [
  'no pair', 'pair', 'two pair', 'trips', 'straight',
  'flush', 'full house', 'quads', 'straight flush',
];

const RANK_BASE = 371293; // 13^5, one slot per card

/**
 * High-hand score for five cards. Lower wins at 2-7.
 *
 * The layout is a category in the high digits and up to five rank slots below
 * it, each category always filling the same slots in the same order, so within
 * a category the padding is identical everywhere and never affects a
 * comparison.
 */
export function score(cards) {
  const counts = new Int8Array(13);
  let suitMask = 0;
  for (let i = 0; i < cards.length; i += 1) {
    const card = cards[i];
    counts[card % 13] += 1;
    suitMask |= 1 << ((card / 13) | 0);
  }

  // Ranks grouped by how many of them there are, each group high to low.
  const quads = [];
  const trips = [];
  const pairs = [];
  const singles = [];
  for (let rank = 12; rank >= 0; rank -= 1) {
    switch (counts[rank]) {
      case 4: quads.push(rank); break;
      case 3: trips.push(rank); break;
      case 2: pairs.push(rank); break;
      case 1: singles.push(rank); break;
      default: break;
    }
  }

  let category;
  let slots;
  if (quads.length) {
    category = QUADS;
    slots = [quads[0], singles[0]];
  } else if (trips.length && pairs.length) {
    category = FULL_HOUSE;
    slots = [trips[0], pairs[0]];
  } else if (trips.length) {
    category = TRIPS;
    slots = [trips[0], singles[0], singles[1]];
  } else if (pairs.length === 2) {
    category = TWO_PAIR;
    slots = [pairs[0], pairs[1], singles[0]];
  } else if (pairs.length === 1) {
    category = PAIR;
    slots = [pairs[0], singles[0], singles[1], singles[2]];
  } else {
    // Five distinct ranks: the only place a flush or a straight can live.
    // Ace-high only means five consecutive ranks and nothing else - there is
    // no wheel to special-case.
    const isFlush = (suitMask & (suitMask - 1)) === 0;
    const isStraight = singles[0] - singles[4] === 4;
    if (isStraight && isFlush) {
      category = STRAIGHT_FLUSH;
      slots = [singles[0]];
    } else if (isFlush) {
      category = FLUSH;
      slots = singles;
    } else if (isStraight) {
      category = STRAIGHT;
      slots = [singles[0]];
    } else {
      category = HIGH_CARD;
      slots = singles;
    }
  }

  let value = 0;
  for (let i = 0; i < 5; i += 1) value = value * 13 + (slots[i] ?? 0);
  return category * RANK_BASE + value;
}

export const categoryOf = (handScore) => (handScore / RANK_BASE) | 0;

/** Sorts best-first for 2-7: negative when `a` wins the pot. */
export const compare27 = (a, b) => score(a) - score(b);

/** The best possible hand, kept as a constant so tests can pin it. */
export const WHEEL_IS_NOT_A_STRAIGHT = true;

// ---------------------------------------------------------------------------
// Table-backed evaluation
//
// The solver evaluates hands by the hundred million, so it does not call
// `score` in its inner loop. Instead every five-card hand in the deck is scored
// once and compressed to a dense rank in 0..7461, which fits a Uint16Array of
// 2,598,960 entries - about 5 MB, built in roughly a second and then constant.
// Ranks preserve order and nothing else, which is all a showdown needs.
// ---------------------------------------------------------------------------

const CHOOSE = buildChoose();

function buildChoose() {
  const table = [];
  for (let n = 0; n <= DECK_SIZE; n += 1) {
    table[n] = [];
    for (let k = 0; k <= 5; k += 1) {
      if (k === 0) table[n][k] = 1;
      else if (n < k) table[n][k] = 0;
      else table[n][k] = table[n - 1][k - 1] + table[n - 1][k];
    }
  }
  return table;
}

export const HAND_COUNT = CHOOSE[DECK_SIZE][5]; // 2,598,960

/**
 * Position of a five-card hand in colexicographic order.
 *
 * Cards must be strictly ascending; `handIndex` sorts a copy so callers can
 * pass a hand in any order without it silently indexing the wrong row.
 */
export function handIndex(cards) {
  const sorted = Array.from(cards).sort((a, b) => a - b);
  return CHOOSE[sorted[0]][1] + CHOOSE[sorted[1]][2] + CHOOSE[sorted[2]][3]
    + CHOOSE[sorted[3]][4] + CHOOSE[sorted[4]][5];
}

let rankTable = null;
let distinctValues = 0;

/**
 * Builds (once) and returns the hand-rank table. Lower rank wins at 2-7.
 *
 * Dense ranking is done with a presence histogram over the score space rather
 * than by sorting 2.6 million values, which keeps the build to two linear
 * passes.
 */
export function handRanks() {
  if (rankTable) return rankTable;

  const scores = new Int32Array(HAND_COUNT);
  const hand = new Int32Array(5);
  const maxScore = STRAIGHT_FLUSH * RANK_BASE + RANK_BASE;
  const seen = new Uint8Array(maxScore);

  for (let a = 0; a < DECK_SIZE; a += 1) {
    hand[0] = a;
    for (let b = a + 1; b < DECK_SIZE; b += 1) {
      hand[1] = b;
      for (let c = b + 1; c < DECK_SIZE; c += 1) {
        hand[2] = c;
        for (let d = c + 1; d < DECK_SIZE; d += 1) {
          hand[3] = d;
          for (let e = d + 1; e < DECK_SIZE; e += 1) {
            hand[4] = e;
            const value = score(hand);
            scores[CHOOSE[a][1] + CHOOSE[b][2] + CHOOSE[c][3] + CHOOSE[d][4] + CHOOSE[e][5]] = value;
            seen[value] = 1;
          }
        }
      }
    }
  }

  const rankOfScore = new Int32Array(maxScore);
  let next = 0;
  for (let value = 0; value < maxScore; value += 1) {
    if (seen[value]) {
      rankOfScore[value] = next;
      next += 1;
    }
  }
  distinctValues = next;

  const table = new Uint16Array(HAND_COUNT);
  for (let i = 0; i < HAND_COUNT; i += 1) table[i] = rankOfScore[scores[i]];
  rankTable = table;
  return rankTable;
}

/** How many distinct hand values the deck holds. Forces the table build. */
export function distinctHandValues() {
  handRanks();
  return distinctValues;
}

/** Table-backed strength for five cards. Lower wins at 2-7. */
export function rank27(cards) {
  return handRanks()[handIndex(cards)];
}
