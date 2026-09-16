/**
 * How often a starting hand wins, once everybody has drawn.
 *
 * Pre-draw equity in a draw game is not a property of the five cards - it is a
 * property of the five cards *plus what they become*. So this deals opponents
 * out of the same deck, lets every hand draw under the fixed policy in
 * `lib/rollout.js`, and counts showdowns. Ties split.
 *
 * It is Monte Carlo because it has to be: a heads-up pot is one hand against
 * C(47,5) opponents, each of which then draws, and that is not a sum anybody
 * finishes. A fixed seed makes it repeatable.
 *
 * Card removal is real throughout. The hero's five cards are out of the deck
 * before an opponent is dealt, which is why holding four low cards makes it
 * measurably harder for anyone else to.
 */

import { deal } from './cards.js';
import { handRanks, index5 } from './eval27.js';
import { buckets, analyse, DEFAULT_LIMITS, PAT, DRAW_ONE } from './abstraction.js';
import { drawPolicy } from './rollout.js';

/**
 * What each bucket keeps, as ranks, decided once.
 *
 * The draw policy already works per bucket, so the keep does too - it is the
 * same decision read off the same descriptor, and doing it per hand would mean
 * re-analysing five cards tens of millions of times.
 */
function keepRanksByBucket(limits) {
  const { descriptors } = buckets(limits);
  const policy = drawPolicy(limits);
  const keeps = new Array(descriptors.length);
  for (let bucket = 0; bucket < descriptors.length; bucket += 1) {
    const option = policy[bucket];
    if (option === PAT) {
      keeps[bucket] = null;
      continue;
    }
    const info = analyse(descriptors[bucket].example);
    keeps[bucket] = option === DRAW_ONE ? info.keep4 : info.keep3;
  }
  return keeps;
}

let cached = null;
let cachedStamp = null;

function tables(limits) {
  const stamp = `${limits.pat}/${limits.keep4}/${limits.keep3}`;
  if (cached && cachedStamp === stamp) return cached;
  cached = {
    ranks: handRanks(),
    bucketOf: buckets(limits).table,
    keeps: keepRanksByBucket(limits),
  };
  cachedStamp = stamp;
  return cached;
}

const held = new Int32Array(5);
const kept = new Int32Array(5);

/**
 * Plays five cards through the draw and returns what they finish as.
 *
 * `source` holds the five cards at `from`; replacements come off `deck` at
 * `at`. Where a rank appears twice the keep takes the copy that breaks a flush,
 * which is the only reason suits are looked at here at all.
 */
function finish(source, from, deck, at, table) {
  for (let i = 0; i < 5; i += 1) held[i] = source[from + i];

  const bucket = table.bucketOf[index5(held[0], held[1], held[2], held[3], held[4])];
  const wanted = table.keeps[bucket];
  if (!wanted) return table.ranks[index5(held[0], held[1], held[2], held[3], held[4])];

  let n = 0;
  for (let w = 0; w < wanted.length; w += 1) {
    const rank = wanted[w];
    let chosen = -1;
    for (let i = 0; i < 5; i += 1) {
      if (held[i] % 13 === rank) {
        chosen = held[i];
        break;
      }
    }
    // A hand can lack a rank the bucket's example had, where the bucket
    // collapsed several keeps together. Standing pat is the honest fallback.
    if (chosen < 0) return table.ranks[index5(held[0], held[1], held[2], held[3], held[4])];
    kept[n] = chosen;
    n += 1;
  }

  // Break a flush if the hand allows it: look for a rank with a second copy.
  let monotone = true;
  for (let i = 1; i < n; i += 1) {
    if ((kept[i] / 13 | 0) !== (kept[0] / 13 | 0)) {
      monotone = false;
      break;
    }
  }
  if (monotone) {
    for (let i = 0; i < n && monotone; i += 1) {
      for (let j = 0; j < 5; j += 1) {
        if (held[j] % 13 === kept[i] % 13 && held[j] !== kept[i]) {
          kept[i] = held[j];
          monotone = false;
          break;
        }
      }
    }
  }

  for (let i = n; i < 5; i += 1) {
    kept[i] = deck[at + (i - n)];
  }
  return table.ranks[index5(kept[0], kept[1], kept[2], kept[3], kept[4])];
}

/**
 * Equity of one holding against `opponents` random hands, over `trials` deals.
 *
 * Every opponent is dealt two reserve cards whether they draw or not, so a
 * player standing pat does not change which cards the next one receives.
 */
export function equityOf(cards, opponents, trials, rng, limits = DEFAULT_LIMITS) {
  const table = tables(limits);

  const mine = new Set(cards);
  const live = [];
  for (let card = 0; card < 52; card += 1) if (!mine.has(card)) live.push(card);
  const deck = Uint8Array.from(live);

  const heroCards = Int32Array.from(cards);
  const heroReserve = 0;
  const oppAt = 2; // hero takes two reserve cards first
  const need = 2 + opponents * 7;

  let won = 0;
  for (let trial = 0; trial < trials; trial += 1) {
    deal(deck, need, rng);
    const heroRank = finish(heroCards, 0, deck, heroReserve, table);

    let better = 0;
    let equal = 0;
    for (let o = 0; o < opponents; o += 1) {
      const handAt = oppAt + o * 5;
      const reserveAt = oppAt + opponents * 5 + o * 2;
      const rank = finish(deck, handAt, deck, reserveAt, table);
      if (rank < heroRank) better += 1;
      else if (rank === heroRank) equal += 1;
    }

    if (better === 0) won += 1 / (1 + equal);
  }
  return won / trials;
}
