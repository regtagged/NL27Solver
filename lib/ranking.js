/**
 * The starting hands of 2-7 single draw, as a player would list them.
 *
 * A row is a set of five ranks **split by whether the cards it keeps are all
 * one suit**, because that is the only thing suits decide in this game. Which
 * cards those are depends on what the hand does, so the split moves with it:
 *
 *   75432   keeps all five (it stands pat)   1,020 plain + 4 suited
 *   K7543   keeps 7-5-4-3 and throws the K   1,008 plain + 16 suited
 *
 * Both add to 1,024, the suit arrangements of five distinct ranks. The suited
 * 75432 is a flush and so cannot stand pat - it draws instead, and its equity
 * collapses from 99.9% to 40%. The suited K7543 is drawing one to four cards of
 * a suit, and can brick into a flush. Neither is the same hand as its plain
 * twin, and neither should share a row with it.
 *
 * Rows are found by walking the whole deck rather than by reasoning about it,
 * so the combination counts are what the deck actually holds.
 */

import { RANKS, makeCard, suitOf, rankOf, formatCard } from './cards.js';
import { index5, handRanks } from './eval27.js';
import { buckets, DEFAULT_LIMITS, PAT, DRAW_ONE } from './abstraction.js';
import { drawPolicy } from './rollout.js';
import { bestKeep } from './draws.js';

/**
 * The best keeps for every set of distinct ranks, indexed by rank bitmask.
 *
 * There are at most 8,192 such sets and the deck asks for one on every hand, so
 * they are worked out once and looked up by a number rather than rebuilt from a
 * string key 2.6 million times.
 */
function keepsByMask() {
  const four = new Array(1 << 13).fill(null);
  const three = new Array(1 << 13).fill(null);
  for (let mask = 0; mask < (1 << 13); mask += 1) {
    const ranks = [];
    for (let rank = 0; rank < 13; rank += 1) if (mask & (1 << rank)) ranks.push(rank);
    if (ranks.length < 3 || ranks.length > 5) continue;
    four[mask] = bestKeep(ranks, 4);
    three[mask] = bestKeep(ranks, 3);
  }
  return { four, three };
}

/**
 * Every starting hand class, unranked.
 *
 * A class is keyed by its ranks, what it does with them, and whether the cards
 * it keeps are stuck in one suit. Keying on the draw as well means a class
 * never holds two hands that play differently - the plain 75432 stands pat and
 * the suited one draws, and they are separate rows because of it.
 */
export function handClasses(limits = DEFAULT_LIMITS) {
  const bucketTable = buckets(limits).table;
  const policy = drawPolicy(limits);
  const keeps = keepsByMask();

  const groups = new Map();
  const counts = new Int8Array(13);
  const suits = new Int32Array(13);
  const hand = new Int32Array(5);

  for (let a = 0; a < 52; a += 1) {
    hand[0] = a;
    for (let b = a + 1; b < 52; b += 1) {
      hand[1] = b;
      for (let c = b + 1; c < 52; c += 1) {
        hand[2] = c;
        for (let d = c + 1; d < 52; d += 1) {
          hand[3] = d;
          for (let e = d + 1; e < 52; e += 1) {
            hand[4] = e;

            counts.fill(0);
            suits.fill(0);
            let mask = 0;
            for (let i = 0; i < 5; i += 1) {
              const rank = hand[i] % 13;
              counts[rank] += 1;
              suits[rank] |= 1 << ((hand[i] / 13) | 0);
              mask |= 1 << rank;
            }

            const option = policy[bucketTable[index5(a, b, c, d, e)]];
            const wanted = option === PAT ? null
              : (option === DRAW_ONE ? keeps.four[mask] : keeps.three[mask]);

            // Stuck in one suit: every kept rank appears once, all in that
            // suit. A duplicated rank always offers a way out.
            let monotone = true;
            if (wanted) {
              let suit = -1;
              for (const rank of wanted) {
                if (counts[rank] !== 1 || (suit >= 0 && suits[rank] !== suit)) {
                  monotone = false;
                  break;
                }
                suit = suits[rank];
              }
            } else {
              const first = (a / 13) | 0;
              monotone = [b, c, d, e].every((card) => ((card / 13) | 0) === first);
            }

            let key = 0;
            for (let rank = 0; rank < 13; rank += 1) key = key * 5 + counts[rank];
            const id = `${key}|${option}|${monotone ? 1 : 0}`;

            let group = groups.get(id);
            if (!group) {
              const ranks = [];
              for (let rank = 12; rank >= 0; rank -= 1) {
                for (let copy = 0; copy < counts[rank]; copy += 1) ranks.push(rank);
              }
              group = { ranks, option, monotone, combos: 0, cards: null, variety: -1 };
              groups.set(id, group);
            }
            group.combos += 1;

            // Show the most colourful example, so a plain row looks plain.
            const variety = new Set([a, b, c, d, e].map((card) => (card / 13) | 0)).size;
            if (variety > group.variety) {
              group.variety = variety;
              group.cards = [a, b, c, d, e];
            }
          }
        }
      }
    }
  }

  return [...groups.values()];
}

/** "75432", or "75432s" when the cards it keeps are all one suit. */
export function classLabel(entry) {
  return entry.ranks.map((rank) => RANKS[rank]).join('') + (entry.monotone ? 's' : '');
}

/** The representative holding, high to low, as "7s 5h 4c 3d 2s". */
export function classCards(entry) {
  return [...entry.cards]
    .sort((x, y) => rankOf(y) - rankOf(x))
    .map(formatCard);
}
