/**
 * Hands to strategy buckets, and the draw options.
 *
 * A player draws one, draws two, or stands pat. Drawing three or more is not
 * offered: in practice players stand pat or take one, and take two only from
 * the big blind or as a late-position opener in a single-raised pot, so the
 * third card buys a large abstraction for a line that is rarely correct.
 *
 * That restriction is what makes the bucketing fall out of the game rather than
 * out of a clustering algorithm. With only three options, everything a hand is
 * worth pre-draw is what those three options yield:
 *
 * - **pat** - the five cards as they stand, which is a hand only if it is a
 *   no-pair, no-straight, no-flush low; otherwise standing pat is a snow.
 * - **draw one** - the best four ranks to keep.
 * - **draw two** - the best three.
 *
 * "Best" is measured, not assumed, and that matters more here than it would in
 * any other game: straights count against you, so the lowest four cards in a
 * hand are often the wrong four to keep. 8-5-4-3 makes an eight or better 12
 * times in 48 and cannot make a straight; 7-5-4-3 manages it 8 times and bricks
 * into a straight with any six. `lib/draws.js` picks the keep by score.
 */

import { rankOf, suitOf, RANKS, parseHand } from './cards.js';
import {
  score, categoryOf, handIndex, rank27, distinctHandValues, HAND_COUNT, HIGH_CARD,
} from './eval27.js';
import { bestKeep } from './draws.js';

export const PAT = 0;
export const DRAW_ONE = 1;
export const DRAW_TWO = 2;
export const DRAW_OPTIONS = [PAT, DRAW_ONE, DRAW_TWO];
export const DRAW_LABELS = ['pat', 'd1', 'd2'];

/** How many cards each option keeps. */
export const KEEP_COUNT = [5, 4, 3];

/**
 * Everything about a hand that the three options can see.
 *
 * `made` is the one that decides whether standing pat is a hand or a bluff: a
 * pair, a straight or a flush all mean the same thing here, which is that this
 * hand does not win a showdown by standing pat.
 */
export function analyse(cards) {
  const suitsByRank = new Map();
  for (const card of cards) {
    const rank = rankOf(card);
    const suits = suitsByRank.get(rank);
    if (suits) suits.push(suitOf(card));
    else suitsByRank.set(rank, [suitOf(card)]);
  }

  const distinct = [...suitsByRank.keys()].sort((a, b) => a - b);
  const made = categoryOf(score(cards)) === HIGH_CARD;

  // A keep is stuck in one suit only when every rank in it appears once and all
  // of those cards share that suit. Any duplicated rank lets the flush be
  // broken by choosing the other copy, so it is not a risk at all.
  const forcedMonotone = (ranks) => {
    let suit = -1;
    for (const rank of ranks) {
      const suits = suitsByRank.get(rank);
      if (suits.length !== 1) return false;
      if (suit === -1) suit = suits[0];
      else if (suit !== suits[0]) return false;
    }
    return true;
  };

  const keep4 = bestKeep(distinct, 4);
  const keep3 = bestKeep(distinct, 3);

  return {
    distinct,
    made,
    patRanks: made ? distinct : null,
    keep4,
    keep3,
    keep4Monotone: keep4 ? forcedMonotone(keep4) : false,
    keep3Monotone: keep3 ? forcedMonotone(keep3) : false,
  };
}

/**
 * The cards to hold for an option, choosing suits so a flush is broken wherever
 * the hand allows it. Returns null when the option is not available - drawing
 * one needs four distinct ranks, drawing two needs three, and keeping a pair
 * back is never the play.
 */
function pickCards(cards, ranks) {
  const choices = ranks.map((rank) => Array.from(cards).filter((card) => rankOf(card) === rank));

  // One card per rank, preferring a suit that is not shared by everything else.
  const kept = choices.map((options) => options[0]);
  const allOneSuit = () => kept.every((card) => suitOf(card) === suitOf(kept[0]));
  if (allOneSuit()) {
    for (let i = 0; i < choices.length; i += 1) {
      const other = choices[i].find((card) => suitOf(card) !== suitOf(kept[i]));
      if (other) {
        kept[i] = other;
        break;
      }
    }
  }
  return kept;
}

export function keepFor(cards, option) {
  if (option === PAT) return [...cards];
  const info = analyse(cards);
  const ranks = option === DRAW_ONE ? info.keep4 : info.keep3;
  return ranks ? pickCards(cards, ranks) : null;
}

/**
 * Both keeps in one pass, for the solver's inner loop.
 *
 * Every iteration needs a seat's one-card and two-card keeps together, and
 * calling `keepFor` twice analyses the same five cards twice.
 */
export function keepsFor(cards) {
  const info = analyse(cards);
  return {
    info,
    four: info.keep4 ? pickCards(cards, info.keep4) : null,
    three: info.keep3 ? pickCards(cards, info.keep3) : null,
  };
}

/** The options a hand can actually take. */
export function optionsFor(cards) {
  const { distinct } = analyse(cards);
  const options = [PAT];
  if (distinct.length >= 4) options.push(DRAW_ONE);
  if (distinct.length >= 3) options.push(DRAW_TWO);
  return options;
}

/**
 * Where a dimension stops being worth spelling out, as a rank index.
 *
 * A pat queen-high is not a made hand in this game - you break it and draw -
 * and it plays exactly like a pat king-high, which plays exactly like a pat
 * ace-high. There are 1,482 distinct ace-high pat hands and they share one
 * strategy, so above the ceiling only the high card is carried. The detail is
 * kept where hands are actually played differently and dropped where they are
 * not, which is a different thing from clustering hands by similarity.
 */
export const DEFAULT_LIMITS = {
  pat: RANKS.indexOf('J'),
  keep4: RANKS.indexOf('T'),
  keep3: RANKS.indexOf('9'),
};

/**
 * Rejects ceilings that are not three rank indices.
 *
 * A malformed limits object would otherwise compare every high card against
 * `undefined`, quietly collapse every dimension and build a whole different
 * abstraction that still looks like a working one. Callers get an error rather
 * than a wrong table.
 */
function checkLimits(limits) {
  for (const field of ['pat', 'keep4', 'keep3']) {
    const value = limits?.[field];
    if (!Number.isInteger(value) || value < 0 || value > 12) {
      throw new Error(`limits.${field} must be a rank index 0-12, got ${JSON.stringify(value)}`);
    }
  }
  return limits;
}

/**
 * The bucket key: what the three options yield, and nothing else.
 *
 * Hands that are not made lows collapse together on the pat dimension. A pair
 * of deuces and a pair of kings both stand pat as bluffs and neither expects to
 * win a showdown, so the exact wreckage is not carried. That is the one place
 * this key is lossy other than the ceilings.
 */
export function signature(cards, limits = DEFAULT_LIMITS) {
  checkLimits(limits);
  const info = analyse(cards);

  let pat = '-';
  if (info.patRanks) {
    const high = info.patRanks[4];
    pat = high <= limits.pat ? info.patRanks.join('.') : `P${high}`;
  }

  let one = '-';
  if (info.keep4) {
    const high = info.keep4[3];
    one = high <= limits.keep4 ? info.keep4.join('.') + (info.keep4Monotone ? 'm' : '') : `O${high}`;
  }

  let two = '-';
  if (info.keep3) {
    const high = info.keep3[2];
    two = high <= limits.keep3 ? info.keep3.join('.') + (info.keep3Monotone ? 'm' : '') : `T${high}`;
  }

  return `${pat}|${one}|${two}`;
}

/**
 * A signature in the notation a player would use: "8752 pat", "7543 d1".
 *
 * A made low above the pat ceiling is not described as pat, because it is not
 * played that way - a pat king is broken and drawn to, so what it is worth is
 * the draw underneath it, and that is what gets shown.
 */
export function describe(cards, limits = DEFAULT_LIMITS) {
  const info = analyse(cards);
  const show = (ranks) => ranks.map((rank) => RANKS[rank]).join('');
  if (info.made && info.patRanks[4] <= limits.pat) {
    return `${show([...info.patRanks].reverse())} pat`;
  }
  if (info.keep4) return `${show([...info.keep4].reverse())}${info.keep4Monotone ? ' (suited)' : ''} d1`;
  if (info.keep3) return `${show([...info.keep3].reverse())}${info.keep3Monotone ? ' (suited)' : ''} d2`;
  return 'unplayable';
}

let table = null;
let descriptors = null;
let builtFor = null;

/**
 * Builds (once) the map from every hand in the deck to its bucket.
 *
 * Returns a `Uint32Array` of 2,598,960 bucket indices, addressed by
 * `handIndex`, alongside one descriptor per bucket. This is the table the
 * solver reads in its inner loop, so it is built flat and kept.
 */
export function buckets(limits = DEFAULT_LIMITS) {
  checkLimits(limits);
  const stamp = `${limits.pat}/${limits.keep4}/${limits.keep3}`;
  if (table && builtFor === stamp) return { table, descriptors };

  const index = new Map();
  const list = [];
  const assigned = new Uint32Array(HAND_COUNT);
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
            const key = signature(hand, limits);
            let bucket = index.get(key);
            if (bucket === undefined) {
              bucket = list.length;
              index.set(key, bucket);
              list.push({ key, example: [a, b, c, d, e], hands: 0 });
            }
            list[bucket].hands += 1;
            assigned[handIndex(hand)] = bucket;
          }
        }
      }
    }
  }

  table = assigned;
  descriptors = list;
  builtFor = stamp;
  return { table, descriptors };
}

/** The bucket a hand falls in. Forces the table build. */
export function bucketOf(cards, limits = DEFAULT_LIMITS) {
  return buckets(limits).table[handIndex(cards)];
}

// ---------------------------------------------------------------------------
// After the draw, a hand is worth what it shows down for, and nothing else -
// what it could have drawn to stopped mattering the moment it drew. So the
// post-draw buckets are a different abstraction over the same cards: the pure
// strength ladder, spelled out where the rungs are close together.
// ---------------------------------------------------------------------------

/**
 * The worst made low of each high card, then the worst pair.
 *
 * These are the bucket boundaries, and they are read off the evaluator rather
 * than counted out by hand - the worst seven is 7-6-5-4-2 and not 7-6-5-4-3,
 * because that is a straight, and every rung has the same trap in it.
 */
const SHOWDOWN_LADDER = [
  '7c6d5h4s2c', '8c7d6h5s3c', '9c8d7h6s4c', 'Tc9d8h7s5c', 'Jc Td 9h 8s 6c',
  'Qc Jd Th 9s 7c', 'Kc Qd Jh Ts 8c', 'Ac Kd Qh Js 9c', 'AcAdKhQsJc',
];

/** Lows through a jack are spelled out; anything worse is a handful of rungs. */
const DETAIL_THROUGH = 4; // index into the ladder: jack-high

let showdownTable = null;
let showdownCount = 0;

export function showdownBuckets() {
  if (showdownTable) return { table: showdownTable, count: showdownCount };

  const bounds = SHOWDOWN_LADDER.map((text) => rank27(parseHand(text)));
  const detail = bounds[DETAIL_THROUGH];
  const coarse = bounds.slice(DETAIL_THROUGH + 1); // queen, king, ace, pair

  const table = new Uint16Array(distinctHandValues());
  for (let rank = 0; rank < table.length; rank += 1) {
    if (rank <= detail) {
      table[rank] = rank;
      continue;
    }
    let step = coarse.findIndex((bound) => rank <= bound);
    if (step < 0) step = coarse.length; // two pair or worse: all equally lost
    table[rank] = detail + 1 + step;
  }

  showdownTable = table;
  showdownCount = detail + 1 + coarse.length + 1;
  return { table: showdownTable, count: showdownCount };
}

/** How a finished hand reads: "87653" for a made low, else what it is. */
export function showdownName(rank) {
  const bounds = SHOWDOWN_LADDER.map((text) => rank27(parseHand(text)));
  if (rank <= bounds[DETAIL_THROUGH]) return null; // caller has the cards
  const names = ['queen-high', 'king-high', 'ace-high', 'a pair', 'two pair or worse'];
  const step = bounds.slice(DETAIL_THROUGH + 1).findIndex((bound) => rank <= bound);
  return names[step < 0 ? names.length - 1 : step];
}
