/**
 * The abstraction the solver runs on, which is not the one the viewer shows.
 *
 * Those are two different jobs. The viewer wants every hand spelled out,
 * because the question "what do I do with 7-6-5-4-2" deserves an answer about
 * 7-6-5-4-2. The solver wants as few distinct decisions as it can get away
 * with, because every one of them is an information set that has to be visited
 * thousands of times before it means anything - and 679 nodes against 3,463
 * buckets is 2.35 million of them, which is why seven-handed would not settle.
 *
 * So the solver buckets at the level the range is *read* at: what the hand is
 * doing, and the top two cards of what it is trying to have. "A seven-six
 * drawing one" is one decision. That is the same hierarchy `lib/grouping.js`
 * displays, one level up from the leaves, so nothing has to be reconciled - a
 * displayed row and the bucket it was solved in are the same idea at two
 * depths.
 *
 * Hands drawing three or more are not split by what they are drawing at,
 * because keeping 3-2 and taking three can make nearly anything. They are
 * grouped by what they hold, which by then is all there is to say, and they all
 * fold anyway.
 */

import { RANKS } from './cards.js';
import { index5 } from './eval27.js';
import { drawTable, KEEP_SIZE, DRAW_LABELS } from './ranking.js';
import { bestCompletion } from './grouping.js';

let cached = null;

/**
 * Every hand in the deck mapped to a solver bucket, addressed by `index5`.
 *
 * Returns the table, how many buckets there are, and a readable label per
 * bucket, which is what makes a solved strategy explicable rather than a
 * number attached to an index.
 */
export function coarseBuckets() {
  if (cached) return cached;

  const { optionByHand, keeps } = drawTable();
  const table = new Uint16Array(optionByHand.length);
  const index = new Map();
  const labels = [];

  const targets = new Map();
  const targetFor = (option, keep, ranks) => {
    if (option === 0) return ranks;
    if (!keep || keep.length === 0) return [];
    if (option <= 2) {
      const key = keep.join('.');
      let hit = targets.get(key);
      if (!hit) {
        hit = bestCompletion(keep);
        targets.set(key, hit);
      }
      return hit;
    }
    return keep;
  };

  const ranks = new Array(5);
  for (let a = 0; a < 52; a += 1) {
    for (let b = a + 1; b < 52; b += 1) {
      for (let c = b + 1; c < 52; c += 1) {
        for (let d = c + 1; d < 52; d += 1) {
          for (let e = d + 1; e < 52; e += 1) {
            const at = index5(a, b, c, d, e);
            const option = optionByHand[at];

            let mask = 0;
            ranks[0] = a % 13; ranks[1] = b % 13; ranks[2] = c % 13;
            ranks[3] = d % 13; ranks[4] = e % 13;
            for (let i = 0; i < 5; i += 1) mask |= 1 << ranks[i];

            const size = KEEP_SIZE[option];
            const keep = size === 5 ? null : keeps[size][mask];
            const sorted = option === 0
              ? [...ranks].sort((x, y) => y - x)
              : null;
            const target = targetFor(option, keep, sorted);

            const top = target.slice(0, 2).map((rank) => RANKS[rank]).join('');
            const key = `${option}|${top}`;
            let bucket = index.get(key);
            if (bucket === undefined) {
              bucket = labels.length;
              index.set(key, bucket);
              labels.push(top ? `${DRAW_LABELS[option]} ${top}` : DRAW_LABELS[option]);
            }
            table[at] = bucket;
          }
        }
      }
    }
  }

  cached = { table, count: labels.length, labels };
  return cached;
}
