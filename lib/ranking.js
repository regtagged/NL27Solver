/**
 * The starting hands of 2-7 single draw, as a player would list them.
 *
 * Every hand draws whatever suits it - pat through five. That is not the
 * restriction the solver works under: its tree offers pat, one and two only,
 * because a wider tree does not fit. A *ranking* has no tree to fit into, and a
 * full house has no one-card or two-card draw worth anything. It throws all
 * five, and calling it pat would rank it as a hand it is not.
 *
 * A row is a set of five ranks **split by whether the cards it keeps are all
 * one suit**, which is the only thing suits decide in this game. Which cards
 * those are depends on what the hand does, so the split moves with it:
 *
 *   75432   keeps all five, standing pat     1,020 plain +  4 suited
 *   K7543   keeps 7-5-4-3, throws the king   1,008 plain + 16 suited
 *
 * Both add to 1,024, the suit arrangements of five distinct ranks.
 *
 * Rows are found by walking the whole deck rather than by reasoning about it,
 * so the combination counts are what the deck actually holds.
 */

import { RANKS, rankOf, formatCard, makeRng, freshDeck, deal, parseHand } from './cards.js';
import { index5, handRanks, rank27, distinctHandValues } from './eval27.js';
import { bestKeep, keepScore, scoreOf, setScoreTable } from './draws.js';

/** Pat, then drawing one through five. A keep of `5 - option` cards. */
export const DRAW_LABELS = ['Pat', 'D1', 'D2', 'D3', 'D4', 'D5'];
export const KEEP_SIZE = [5, 4, 3, 2, 1, 0];

/**
 * Standing pat is only on offer with a queen or better.
 *
 * Not an abstraction - a rule of the game as it is played. A pat king is far
 * too weak to keep; a pat queen is situational and rare, but it is a hand, and
 * one that gets opened from the button. Below the queen the line has to be
 * drawn somewhere, because without it the equity arithmetic will happily sit on
 * a king-high rather than draw one to four of a suit, which nobody does.
 *
 * Whether a pat queen is *opened* is left to the solve, and the solve knows
 * what seat it is in - so it can be a button hand and an under-the-gun fold
 * without either being written down here.
 */
const patCeiling = () => rank27(parseHand('Qc Jd Th 9s 7c'));

/**
 * Keeps and their scores for every set of distinct ranks, by rank bitmask.
 *
 * There are at most 8,192 such sets and the deck asks about one on every hand,
 * so both are worked out once and read by number rather than rebuilt from a
 * string key 2.6 million times.
 */
function tablesByMask() {
  const keeps = [];
  const scores = [];
  for (let size = 0; size <= 4; size += 1) {
    keeps[size] = new Array(1 << 13).fill(null);
    scores[size] = [new Float64Array(1 << 13), new Float64Array(1 << 13)];
  }

  for (let mask = 0; mask < (1 << 13); mask += 1) {
    const ranks = [];
    for (let rank = 0; rank < 13; rank += 1) if (mask & (1 << rank)) ranks.push(rank);
    if (ranks.length < 1 || ranks.length > 5) continue;

    for (let size = 0; size <= 4; size += 1) {
      const kept = bestKeep(ranks, size);
      keeps[size][mask] = kept;
      if (!kept) continue;
      // A keep of nought or one card cannot be "all one suit" in any way that
      // changes anything, so both flags hold the same score.
      const plain = keepScore(kept, false, 5 - size);
      scores[size][0][mask] = plain;
      scores[size][1][mask] = size >= 2 ? keepScore(kept, true, 5 - size) : plain;
    }
  }

  const ceiling = patCeiling();
  const patScore = new Float64Array(distinctHandValues());
  for (let rank = 0; rank < patScore.length; rank += 1) {
    patScore[rank] = rank <= ceiling ? scoreOf(rank) : -Infinity;
  }

  return { keeps, scores, patScore, ranks: handRanks() };
}

const counts = new Int8Array(13);
const suits = new Int32Array(13);

/**
 * The draw a hand takes, and whether the cards it keeps are stuck in one suit.
 *
 * Stuck means every kept rank appears once and all of them share that suit; a
 * duplicated rank always offers a way out, because the player picks the copy
 * that breaks the flush.
 */
function chooseDraw(a, b, c, d, e, ctx) {
  counts.fill(0);
  suits.fill(0);
  let mask = 0;
  for (const card of [a, b, c, d, e]) {
    const rank = card % 13;
    counts[rank] += 1;
    suits[rank] |= 1 << ((card / 13) | 0);
    mask |= 1 << rank;
  }

  const index = index5(a, b, c, d, e);
  let option = 0;
  let best = ctx.patScore[ctx.ranks[index]];
  let monotone = false;

  for (let opt = 1; opt <= 5; opt += 1) {
    const size = KEEP_SIZE[opt];
    const kept = ctx.keeps[size][mask];
    if (!kept) continue;

    let mono = size >= 2;
    if (mono) {
      let suit = -1;
      for (const rank of kept) {
        if (counts[rank] !== 1 || (suit >= 0 && suits[rank] !== suit)) {
          mono = false;
          break;
        }
        suit = suits[rank];
      }
    }

    const score = ctx.scores[size][mono ? 1 : 0][mask];
    if (score > best) {
      best = score;
      option = opt;
      monotone = mono;
    }
  }

  // Standing pat keeps all five, so its keep is monotone exactly when the hand
  // is a flush.
  if (option === 0) {
    const suit = (a / 13) | 0;
    monotone = [b, c, d, e].every((card) => ((card / 13) | 0) === suit);
  }

  return { option, monotone, mask, index };
}

/**
 * Works out what a finished hand is worth, and feeds it back into the draw.
 *
 * A benchmark ladder is a proxy: past its last rung every hand scores the same,
 * so the choice between two bad draws fell to whichever was tested first. What
 * a finished hand is *actually* worth is its equity against an opponent who has
 * also drawn - so opponents are dealt and drawn under the current policy, their
 * finished hands counted, and the resulting distribution becomes the score.
 *
 * That is circular, so it is iterated: the ladder picks the first policy, the
 * policy produces a distribution, the distribution picks a better policy. Three
 * rounds is enough that the draws stop moving.
 */
export function calibrate({ rounds = 3, trials = 600000, seed = 20260916 } = {}) {
  let ctx = tablesByMask();
  const size = distinctHandValues();

  for (let round = 0; round < rounds; round += 1) {
    const histogram = new Float64Array(size);
    const rng = makeRng(seed + round);
    const deck = freshDeck();

    for (let trial = 0; trial < trials; trial += 1) {
      deal(deck, 10, rng);
      const { option, mask } = chooseDraw(deck[0], deck[1], deck[2], deck[3], deck[4], ctx);
      const keep = KEEP_SIZE[option];

      let final;
      if (option === 0) {
        final = ctx.ranks[index5(deck[0], deck[1], deck[2], deck[3], deck[4])];
      } else {
        const wanted = ctx.keeps[keep][mask];
        const hand = new Int32Array(5);
        let n = 0;
        for (const rank of wanted) {
          for (let i = 0; i < 5; i += 1) {
            if (deck[i] % 13 === rank) {
              hand[n] = deck[i];
              n += 1;
              break;
            }
          }
        }
        for (let i = n; i < 5; i += 1) hand[i] = deck[5 + (i - n)];
        final = ctx.ranks[index5(hand[0], hand[1], hand[2], hand[3], hand[4])];
      }
      histogram[final] += 1;
    }

    // Holding `rank`, equity is the chance the opponent finished worse, plus
    // half the chance they finished level.
    const equity = new Float64Array(size);
    let worse = 0;
    for (let rank = size - 1; rank >= 0; rank -= 1) {
      equity[rank] = (worse + 0.5 * histogram[rank]) / trials;
      worse += histogram[rank];
    }

    setScoreTable(equity);
    ctx = tablesByMask();
  }

  return ctx;
}

/**
 * What every option is worth to *this* hand, with its own cards out of the deck.
 *
 * The canonical score table takes a keep and removes only the kept cards, which
 * quietly leaves the discards available to be drawn again. They are not: they
 * are in the muck. The error grows with the size of the draw, so it flatters
 * big draws, and it is large enough to change the answer - A-K-K-T-T scores
 * 0.2938 for keeping the ten against 0.2966 for throwing everything, and the
 * moment the four dead cards come out of the deck that reverses to 0.3334
 * against 0.3193.
 *
 * Small draws are enumerated exactly; the big ones are sampled, sharing one
 * stream of shuffles so that the comparison between them is sharper than any
 * one of them.
 */
function optionScores(cards, ctx, mask, seed, trials) {
  const scores = new Float64Array(6).fill(-Infinity);
  const monotone = new Array(6).fill(false);

  // -Infinity for anything worse than a pat jack, so it is never chosen.
  scores[0] = ctx.patScore[ctx.ranks[index5(...cards)]];
  monotone[0] = cards.every((card) => ((card / 13) | 0) === ((cards[0] / 13) | 0));

  const held = new Set(cards);
  const live = [];
  for (let card = 0; card < 52; card += 1) if (!held.has(card)) live.push(card);

  for (let opt = 1; opt <= 5; opt += 1) {
    const size = KEEP_SIZE[opt];
    const wanted = ctx.keeps[size][mask];
    if (!wanted) continue;

    const kept = [];
    for (const rank of wanted) {
      // Take the copy that breaks a flush where the hand offers one.
      const copies = cards.filter((card) => card % 13 === rank);
      const other = copies.find((card) => kept.length === 0
        || ((card / 13) | 0) !== ((kept[0] / 13) | 0));
      kept.push(other ?? copies[0]);
    }
    monotone[opt] = kept.length >= 2
      && kept.every((card) => ((card / 13) | 0) === ((kept[0] / 13) | 0));

    const hand = new Int32Array(5);
    for (let i = 0; i < kept.length; i += 1) hand[i] = kept[i];
    const draws = 5 - size;
    let total = 0;
    let count = 0;

    if (draws <= 2) {
      const walk = (start, depth) => {
        if (depth === draws) {
          total += scoreOf(ctx.ranks[index5(hand[0], hand[1], hand[2], hand[3], hand[4])]);
          count += 1;
          return;
        }
        for (let i = start; i <= live.length - (draws - depth); i += 1) {
          hand[size + depth] = live[i];
          walk(i + 1, depth + 1);
        }
      };
      walk(0, 0);
    } else {
      const rng = makeRng(seed); // the same shuffles for every option
      const pool = Uint8Array.from(live);
      for (let trial = 0; trial < trials; trial += 1) {
        deal(pool, draws, rng);
        for (let i = 0; i < draws; i += 1) hand[size + i] = pool[i];
        total += scoreOf(ctx.ranks[index5(hand[0], hand[1], hand[2], hand[3], hand[4])]);
        count += 1;
      }
    }
    scores[opt] = total / count;
  }

  return { scores, monotone };
}

/**
 * Every starting hand class, unranked.
 *
 * Found in three passes. The first groups hands by their ranks and the suit
 * structure that could matter - which keeps are stuck in one suit, and whether
 * the hand is a flush - none of which depends on the draw. The second works out
 * what each of those groups draws, with its own cards out of the deck. The
 * third merges any that ended up playing identically.
 */
let cachedTable = null;

/**
 * The draw every hand in the deck takes, addressed by `index5`.
 *
 * The equity loop needs this: a hand's equity has to be worked out from the
 * draw it is shown taking, or the two columns of the viewer are answering
 * different questions.
 */
export function drawTable() {
  if (!cachedTable) handClasses();
  return cachedTable;
}


/**
 * One rainbow holding per set of ranks, for deciding what that set draws.
 *
 * Rainbow because the decision is made on the ranks: suits change what a draw
 * is worth, not what the draw is. Cycling the suits keeps at most two cards in
 * any one of them, so nothing here has a flush or a flush draw to be swayed by.
 */
function* rainbowRepresentatives() {
  const shape = new Int8Array(13);

  const walk = function* walk(start, depth) {
    if (depth === 5) {
      const cards = [];
      let mask = 0;
      let key = 0;
      let at = 0;
      for (let rank = 12; rank >= 0; rank -= 1) {
        for (let copy = 0; copy < shape[rank]; copy += 1) {
          cards.push(rank + 13 * (at % 4));
          at += 1;
        }
        if (shape[rank]) mask |= 1 << rank;
      }
      for (let rank = 0; rank < 13; rank += 1) key = key * 5 + shape[rank];
      yield [key, cards, mask];
      return;
    }
    for (let rank = start; rank < 13; rank += 1) {
      if (shape[rank] === 4) continue; // no five of a kind
      shape[rank] += 1;
      yield* walk(rank, depth + 1);
      shape[rank] -= 1;
    }
  };

  yield* walk(0, 0);
}

let cachedClasses = null;
let cachedFor = null;

/**
 * Every starting hand class, unranked.
 *
 * Two passes. The first decides what each *set of ranks* draws, on the ranks
 * alone, with its own five cards out of the deck - twice over, because a flush
 * cannot stand pat and so needs a second answer with pat unavailable. The
 * second walks the deck and files every hand under its ranks, its draw, and
 * whether the suits matter.
 *
 * Suits matter in exactly one of two ways, and which one depends on the draw:
 *
 * - **Drawing one**, what counts is whether the four cards kept share a suit,
 *   because those are the four that can back into a flush. K-7-5-4-3 splits
 *   1,008 and 16 - and the all-one-suit version belongs in the 16, not on its
 *   own, because the king is thrown away either way.
 * - **Otherwise**, what counts is whether the hand is a flush, which is a
 *   different hand rather than a different draw. 7-5-4-3-2 splits 1,020 and 4.
 */
export function handClasses(options = {}) {
  const stamp = JSON.stringify(options);
  if (cachedClasses && cachedFor === stamp) return cachedClasses;

  const ctx = calibrate(options);
  const trials = options.drawTrials ?? 6000;

  const plans = new Map();
  for (const [key, cards, mask] of rainbowRepresentatives()) {
    const { scores } = optionScores(cards, ctx, mask, key, trials);
    let plain = 0;
    for (let opt = 1; opt <= 5; opt += 1) if (scores[opt] > scores[plain]) plain = opt;
    let drawn = 1;
    for (let opt = 2; opt <= 5; opt += 1) if (scores[opt] > scores[drawn]) drawn = opt;
    plans.set(key, { plain, drawn });
  }

  const groups = new Map();
  const optionByHand = new Uint8Array(2598960);

  for (let a = 0; a < 52; a += 1) {
    for (let b = a + 1; b < 52; b += 1) {
      for (let c = b + 1; c < 52; c += 1) {
        for (let d = c + 1; d < 52; d += 1) {
          for (let e = d + 1; e < 52; e += 1) {
            counts.fill(0);
            suits.fill(0);
            let mask = 0;
            for (const card of [a, b, c, d, e]) {
              const rank = card % 13;
              counts[rank] += 1;
              suits[rank] |= 1 << ((card / 13) | 0);
              mask |= 1 << rank;
            }
            let key = 0;
            for (let rank = 0; rank < 13; rank += 1) key = key * 5 + counts[rank];

            const suit = (a / 13) | 0;
            const flush = [b, c, d, e].every((card) => ((card / 13) | 0) === suit);
            const plan = plans.get(key);
            const option = flush ? plan.drawn : plan.plain;

            let suited = flush;
            if (option === 1) {
              const kept = ctx.keeps[4][mask];
              suited = Boolean(kept);
              if (suited) {
                let only = -1;
                for (const rank of kept) {
                  if (counts[rank] !== 1 || (only >= 0 && suits[rank] !== only)) {
                    suited = false;
                    break;
                  }
                  only = suits[rank];
                }
              }
            }

            optionByHand[index5(a, b, c, d, e)] = option;
            const id = `${key}|${option}|${suited ? 1 : 0}`;

            let group = groups.get(id);
            if (!group) {
              const ranks = [];
              for (let rank = 12; rank >= 0; rank -= 1) {
                for (let copy = 0; copy < counts[rank]; copy += 1) ranks.push(rank);
              }
              group = {
                ranks,
                option,
                monotone: suited,
                keep: option === 0 ? null : ctx.keeps[KEEP_SIZE[option]][mask],
                combos: 0,
                cards: null,
                variety: -1,
              };
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

  cachedTable = { optionByHand, keeps: ctx.keeps };
  cachedClasses = [...groups.values()];
  cachedFor = stamp;
  return cachedClasses;
}

/** "75432", or "75432s" when the suits are what set this row apart. */
export function classLabel(entry) {
  return entry.ranks.map((rank) => RANKS[rank]).join('') + (entry.monotone ? 's' : '');
}

/** The representative holding, high to low, as "7s 5h 4c 3d 2s". */
export function classCards(entry) {
  return [...entry.cards].sort((x, y) => rankOf(y) - rankOf(x)).map(formatCard);
}
