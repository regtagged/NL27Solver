/**
 * The starting hands of 2-7 single draw, as a player would list them.
 *
 * A "hand" here is a set of five ranks, with flushes split out — 7-5-4-3-2 is
 * one row of 1,020 combinations and 7-5-4-3-2 all in one suit is a different
 * row of 4, because in this game that is a different hand entirely. Suits carry
 * no other information, so nothing else is split.
 *
 * That gives every row a combination count that adds up: the 2,598,960 hands in
 * the deck, counted once each.
 */

import { RANKS, makeCard, suitOf } from './cards.js';

const CHOOSE_4 = [1, 4, 6, 4, 1]; // ways to pick c cards of one rank

/**
 * A representative holding for a class.
 *
 * The k-th copy of a rank takes the k-th suit, which keeps the cards distinct.
 * Five distinct ranks would then all land in one suit and be a flush by
 * accident, so the last card moves suit unless a flush is what was asked for.
 */
function representative(counts, flush) {
  const cards = [];
  for (let rank = 12; rank >= 0; rank -= 1) {
    for (let copy = 0; copy < counts[rank]; copy += 1) {
      cards.push(makeCard(rank, flush ? 0 : copy));
    }
  }
  if (!flush && cards.every((card) => suitOf(card) === suitOf(cards[0]))) {
    cards[cards.length - 1] += 13;
  }
  return cards;
}

/**
 * Every starting hand class, unranked.
 *
 * Each carries the five ranks high to low, whether it is a flush, how many
 * combinations it stands for, and a representative holding to evaluate.
 */
export function handClasses() {
  const classes = [];
  const counts = new Int8Array(13);

  const walk = (start, depth) => {
    if (depth === 5) {
      let combos = 1;
      let distinct = 0;
      const ranks = [];
      for (let rank = 12; rank >= 0; rank -= 1) {
        if (!counts[rank]) continue;
        combos *= CHOOSE_4[counts[rank]];
        distinct += 1;
        for (let copy = 0; copy < counts[rank]; copy += 1) ranks.push(rank);
      }
      // Only five distinct ranks can be a flush, and exactly four of the
      // combinations are - one per suit.
      if (distinct === 5) {
        classes.push({ ranks, flush: false, combos: combos - 4, cards: representative(counts, false) });
        classes.push({ ranks, flush: true, combos: 4, cards: representative(counts, true) });
      } else {
        classes.push({ ranks, flush: false, combos, cards: representative(counts, false) });
      }
      return;
    }
    for (let rank = start; rank < 13; rank += 1) {
      if (counts[rank] === 4) continue; // no five of a kind
      counts[rank] += 1;
      walk(rank, depth + 1);
      counts[rank] -= 1;
    }
  };

  walk(0, 0);
  return classes;
}

/** "75432", or "75432s" for the flush. */
export function classLabel(entry) {
  return entry.ranks.map((rank) => RANKS[rank]).join('') + (entry.flush ? 's' : '');
}
