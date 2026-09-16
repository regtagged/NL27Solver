/**
 * What a draw is worth, and therefore which cards to keep.
 *
 * The rule this replaces was "keep the lowest distinct ranks", which is wrong,
 * and wrong for a reason that is particular to this game: **straights count
 * against you**, so the smoothest-looking four cards can be the worst keep in
 * the hand. Enumerated over every replacement card:
 *
 *   7-5-4-3   makes an eight or better  8 of 48   and hits a straight  4 of 48
 *   8-5-4-3   makes an eight or better 12 of 48   and cannot make a straight
 *   7-6-5-4   makes an eight or better  4 of 48   and hits a straight  8 of 48
 *
 * 8-5-4-3 makes a good hand half again as often as 7-5-4-3 and has no straight
 * to brick into; all 7-5-4-3 has over it is the four deuces that make the nuts.
 * So the keep is chosen by score, not by position, and 7-6-5-4 - which looks
 * like the best four cards a hand could hold - is correctly treated as a trap.
 *
 * Scores are the fraction of a benchmark ladder a draw is expected to beat.
 */

import { handIndex, handRanks, rank27 } from './eval27.js';

/**
 * The ladder: the worst made low of each high card from eight to jack. Each is
 * the worst because the smooth version is a straight - 8-7-6-5-4 and 9-8-7-6-5
 * are straights here, and so not lows at all.
 */
const BENCHMARK_HANDS = [
  [6, 5, 4, 3, 1], // 8 7 6 5 3
  [7, 6, 5, 4, 2], // 9 8 7 6 4
  [8, 7, 6, 5, 3], // T 9 8 7 5
  [9, 8, 7, 6, 4], // J T 9 8 6
];

/** Alternating suits, so nothing built here is accidentally a flush. */
export const spread = (ranks, monotone = false) =>
  ranks.map((rank, i) => rank + 13 * (monotone ? 0 : i % 2));

let benchmarks = null;

export function benchmarkRanks() {
  if (!benchmarks) benchmarks = BENCHMARK_HANDS.map((ranks) => rank27(spread(ranks)));
  return benchmarks;
}

/** What fraction of the ladder a finished hand beats. */
export function scoreOf(rank) {
  const ladder = benchmarkRanks();
  let beaten = 0;
  for (let i = 0; i < ladder.length; i += 1) if (rank <= ladder[i]) beaten += 1;
  return beaten / ladder.length;
}

const scoreCache = new Map();

/**
 * Expected score of drawing to a keep, enumerated over every replacement card.
 *
 * A keep not already in one suit cannot make a flush at all, so one
 * alternating-suit representative stands for every such keep.
 */
export function keepScore(ranks, monotone, draws) {
  const key = `${ranks.join('.')}${monotone ? 'm' : ''}/${draws}`;
  const hit = scoreCache.get(key);
  if (hit !== undefined) return hit;

  const table = handRanks();
  const kept = spread(ranks, monotone);
  const held = new Set(kept);
  const live = [];
  for (let card = 0; card < 52; card += 1) if (!held.has(card)) live.push(card);

  const hand = new Array(kept.length + draws);
  for (let i = 0; i < kept.length; i += 1) hand[i] = kept[i];
  let total = 0;
  let count = 0;

  if (draws === 1) {
    for (let i = 0; i < live.length; i += 1) {
      hand[kept.length] = live[i];
      total += scoreOf(table[handIndex(hand)]);
      count += 1;
    }
  } else {
    for (let i = 0; i < live.length; i += 1) {
      hand[kept.length] = live[i];
      for (let j = i + 1; j < live.length; j += 1) {
        hand[kept.length + 1] = live[j];
        total += scoreOf(table[handIndex(hand)]);
        count += 1;
      }
    }
  }

  const score = total / count;
  scoreCache.set(key, score);
  return score;
}

const bestCache = new Map();

/**
 * The highest-scoring `size` ranks to keep out of the distinct ranks held.
 *
 * Flush risk is deliberately not part of *choosing* the keep, only of scoring
 * it afterwards. A three-flush kept on a two-card draw backs into a flush about
 * 4% of the time, which almost never changes which subset is best, and leaving
 * it out lets the choice be cached per rank-set instead of per hand - a few
 * thousand decisions rather than 2.6 million.
 */
export function bestKeep(distinct, size) {
  // Only one- and two-card draws exist, so only keeps of four and three do.
  // Anything else would ask keepScore to enumerate a draw it cannot, and it
  // would return a number rather than complain.
  if (size !== 3 && size !== 4) {
    throw new Error(`a keep is four cards or three, not ${size}`);
  }
  if (distinct.length < size) return null;
  const key = `${distinct.join('.')}/${size}`;
  const hit = bestCache.get(key);
  if (hit !== undefined) return hit;

  const draws = 5 - size;
  let best = null;
  let bestScore = -1;

  const subset = new Array(size);
  const walk = (start, depth) => {
    if (depth === size) {
      const score = keepScore(subset, false, draws);
      if (score > bestScore) {
        bestScore = score;
        best = subset.slice();
      }
      return;
    }
    for (let i = start; i <= distinct.length - (size - depth); i += 1) {
      subset[depth] = distinct[i];
      walk(i + 1, depth + 1);
    }
  };
  walk(0, 0);

  bestCache.set(key, best);
  return best;
}
