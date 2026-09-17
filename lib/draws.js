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

import { handIndex, handRanks, rank27, index5 } from './eval27.js';

/**
 * The ladder: the worst made low of every high card from eight to ace. Each is
 * the worst because the smooth version is a straight - 8-7-6-5-4 and 9-8-7-6-5
 * are straights here, and so not lows at all.
 *
 * It stops at the jack because nothing worse is a hand worth measuring against,
 * which is also its limit: past the last rung every hand scores zero and the
 * ladder cannot rank two bad draws against each other. Where that matters -
 * ranking the whole deck, where most hands are bad - `setScoreTable` replaces
 * it with measured equity. The solver keeps the ladder.
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

const scoreCache = new Map();
const bestCache = new Map();

let scoreTable = null;

/**
 * Replaces the ladder with what a finished hand is actually worth.
 *
 * The ladder is a proxy, and a coarse one: it cannot tell two hands apart once
 * both are past its last rung, so the choice between two bad draws fell to
 * whichever was tested first. `table[rank]` is the equity of holding that
 * finished hand against one opponent who has also drawn - the same quantity the
 * viewer displays - so the draw a hand is shown taking is the draw that
 * maximises the equity it is shown having.
 *
 * Every cached score is derived from this, so both caches are dropped.
 */
export function setScoreTable(table) {
  scoreTable = table;
  scoreCache.clear();
  bestCache.clear();
}

export const hasScoreTable = () => scoreTable !== null;

/** What a finished hand is worth: its equity, or the ladder before calibration. */
export function scoreOf(rank) {
  if (scoreTable) return scoreTable[rank];
  const ladder = benchmarkRanks();
  let beaten = 0;
  for (let i = 0; i < ladder.length; i += 1) if (rank <= ladder[i]) beaten += 1;
  return beaten / ladder.length;
}

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
  if (kept.length + draws !== 5) {
    throw new Error(`a keep of ${kept.length} drawing ${draws} is not five cards`);
  }

  const held = new Set(kept);
  const live = [];
  for (let card = 0; card < 52; card += 1) if (!held.has(card)) live.push(card);

  const hand = new Int32Array(5);
  for (let i = 0; i < kept.length; i += 1) hand[i] = kept[i];
  let total = 0;
  let count = 0;

  // Every way the replacements can come, in order. Drawing five is the whole
  // deck less nothing, which is 2.6 million hands and still under a second.
  const walk = (start, depth) => {
    if (depth === draws) {
      total += scoreOf(table[index5(hand[0], hand[1], hand[2], hand[3], hand[4])]);
      count += 1;
      return;
    }
    const last = live.length - (draws - depth);
    for (let i = start; i <= last; i += 1) {
      hand[kept.length + depth] = live[i];
      walk(i + 1, depth + 1);
    }
  };
  walk(0, 0);

  const score = total / count;
  scoreCache.set(key, score);
  return score;
}

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
  // Keeping five is standing pat, which is the hand itself rather than a
  // choice of subset, and is scored elsewhere.
  if (!Number.isInteger(size) || size < 0 || size > 4) {
    throw new Error(`a keep is nought to four cards, not ${size}`);
  }
  if (size === 0) return [];
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
