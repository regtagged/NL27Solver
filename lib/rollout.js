/**
 * Everything that happens after the pre-draw betting closes.
 *
 * The pre-draw solve needs a value for reaching the draw, and this produces
 * one: each survivor draws under a fixed policy, cards come off the same deck,
 * a single round of post-draw betting runs under a fixed policy, and the pot is
 * split. None of it is solved - that is the point. The post-draw street is
 * solved properly as its own subgame, and this is the bootstrap that lets the
 * pre-draw run happen first.
 *
 * The bias is real and named in docs/design.md: a pre-draw strategy is only as
 * good as the policy terminating it, and the intended cure is to iterate -
 * solve subgames, feed their values back here, re-run.
 *
 * What is *not* arbitrary is the draw choice. An option is scored by how often
 * it ends up beating a ladder of benchmark lows, which is derived from the hand
 * ranking rather than asserted.
 */

import { rank27, handIndex, handRanks } from './eval27.js';
import {
  PAT, DRAW_ONE, DRAW_TWO, analyse, keepFor, buckets, DEFAULT_LIMITS,
} from './abstraction.js';
import { benchmarkRanks, scoreOf, keepScore } from './draws.js';
import { FOLDED } from './tree.js';

export { benchmarkRanks };

let policyTable = null;
let policyStamp = null;

/**
 * The draw each bucket takes, decided once.
 *
 * The choice depends only on what the three options are worth, which is exactly
 * what a bucket records, so it is settled per bucket rather than per hand -
 * a few thousand decisions instead of 2.6 million. Scores are computed against
 * a full deck; the cards actually drawn come off the real one, so card removal
 * stays honest even though the policy that picked the draw ignored it.
 */
export function drawPolicy(limits = DEFAULT_LIMITS) {
  const stamp = `${limits.pat}/${limits.keep4}/${limits.keep3}`;
  if (policyTable && policyStamp === stamp) return policyTable;

  const { descriptors } = buckets(limits);
  const chosen = new Uint8Array(descriptors.length);

  for (let bucket = 0; bucket < descriptors.length; bucket += 1) {
    const example = descriptors[bucket].example;
    const info = analyse(example);

    // Standing pat is worth what the hand already is - which is nothing unless
    // it is a made low, because a pair wins no showdown.
    let best = PAT;
    let bestScore = info.made ? scoreOf(rank27(example)) : 0;

    if (info.keep4) {
      const score = keepScore(info.keep4, info.keep4Monotone, 1);
      if (score > bestScore) {
        bestScore = score;
        best = DRAW_ONE;
      }
    }
    if (info.keep3) {
      const score = keepScore(info.keep3, info.keep3Monotone, 2);
      if (score > bestScore) {
        bestScore = score;
        best = DRAW_TWO;
      }
    }
    chosen[bucket] = best;
  }

  policyTable = chosen;
  policyStamp = stamp;
  return policyTable;
}

/**
 * Runs the draw and the post-draw round, returning what each seat wins or loses
 * over the whole hand.
 *
 * `reserve` holds two pre-dealt replacement cards per seat, off the same deck
 * the hands came from. Dealing them up front rather than on demand is what lets
 * the solver walk several branches of one iteration without them eating each
 * other's cards, and it costs nothing in fidelity: an unused reserve card is
 * just a card that stayed in the stub.
 *
 * What each seat has put in is measured as `startStack - stack`, so antes are
 * counted without anyone having to remember they exist.
 */
export function rollout(state, hands, reserve, options) {
  const {
    startStack,
    limits = DEFAULT_LIMITS,
    postDraw = 'threshold',
    betThreshold = benchmarkRanks()[1], // a made nine
    callThreshold = benchmarkRanks()[2], // a made ten
  } = options;

  const players = hands.length;
  const table = handRanks();
  const bucketTable = buckets(limits).table;
  const policy = drawPolicy(limits);

  const finals = new Array(players);
  const ranks = new Int32Array(players).fill(0x7fffffff);

  for (let seat = 0; seat < players; seat += 1) {
    if (state.status[seat] === FOLDED) continue;
    const hand = hands[seat];
    const option = policy[bucketTable[handIndex(hand)]];
    // A bucket never picks an option its hands do not have, but a null keep
    // would silently become a four-card hand, so this falls back rather than
    // trusting that.
    const kept = option === PAT ? Array.from(hand) : (keepFor(hand, option) ?? Array.from(hand));
    const needed = 5 - kept.length;
    for (let i = 0; i < needed; i += 1) kept.push(reserve[seat * 2 + i]);
    finals[seat] = kept;
    ranks[seat] = table[handIndex(kept)];
  }

  const paid = new Int32Array(players);
  for (let seat = 0; seat < players; seat += 1) paid[seat] = startStack - state.stack[seat];
  const folded = Uint8Array.from(state.status, (status) => (status === FOLDED ? 1 : 0));

  if (postDraw === 'threshold') {
    runBetting(state, paid, folded, ranks, players, { betThreshold, callThreshold });
  }

  const payouts = distribute(paid, folded, ranks);
  const payoffs = new Float64Array(players);
  for (let seat = 0; seat < players; seat += 1) {
    payoffs[seat] = payouts[seat] - paid[seat];
  }
  return { payoffs, ranks, finals };
}

/**
 * One round of post-draw betting, with no raises.
 *
 * The first seat holding better than the betting threshold bets the pot;
 * everyone else calls with better than the calling threshold and folds
 * otherwise. It is deliberately crude - an invented betting policy carries an
 * unknown bias, so this one is kept small enough to reason about.
 */
function runBetting(state, paid, folded, ranks, players, thresholds) {
  const stacks = Int32Array.from(state.stack);
  // `paid` already carries antes and blinds, so it is the whole pot.
  let pot = 0;
  for (let seat = 0; seat < players; seat += 1) pot += paid[seat];

  let bettor = -1;
  let wager = 0;
  for (let seat = 0; seat < players; seat += 1) {
    if (folded[seat] || stacks[seat] <= 0) continue;
    if (ranks[seat] > thresholds.betThreshold) continue;
    wager = Math.min(pot, stacks[seat]);
    if (wager <= 0) continue;
    stacks[seat] -= wager;
    paid[seat] += wager;
    bettor = seat;
    break;
  }
  if (bettor < 0) return;

  for (let i = 1; i < players; i += 1) {
    const seat = (bettor + i) % players;
    if (folded[seat]) continue;
    // Already all-in pre-draw: cannot fold, cannot add chips, still shows down.
    if (stacks[seat] <= 0) continue;
    if (ranks[seat] <= thresholds.callThreshold) {
      const call = Math.min(wager, stacks[seat]);
      stacks[seat] -= call;
      paid[seat] += call;
    } else {
      folded[seat] = 1;
    }
  }
}

/** The best hand among those still in, as a list so ties can split. */
function bestAmong(folded, ranks, eligible) {
  let best = Infinity;
  let winners = [];
  for (let seat = 0; seat < folded.length; seat += 1) {
    if (folded[seat] || (eligible && !eligible(seat))) continue;
    if (ranks[seat] < best) {
      best = ranks[seat];
      winners = [seat];
    } else if (ranks[seat] === best) {
      winners.push(seat);
    }
  }
  return winners;
}

/**
 * Splits the pot, side pots included.
 *
 * Equal stacks make side pots rare here but not impossible - a seat all-in for
 * its blind creates one - and a pot that quietly fails to add up is the kind of
 * bug that never announces itself, so the general case is done properly. Chips
 * nobody was eligible to win go back to whoever put them in.
 *
 * Antes are dead money with no owner, so they ride with the main pot, which
 * every player still in is eligible for.
 */
export function distribute(contributions, folded, ranks, dead = 0) {
  const players = contributions.length;
  const payouts = new Float64Array(players);

  const levels = [...new Set(Array.from(contributions))]
    .filter((value) => value > 0)
    .sort((a, b) => a - b);

  let previous = 0;
  for (const level of levels) {
    let layer = 0;
    const contributors = [];
    for (let seat = 0; seat < players; seat += 1) {
      const share = Math.min(contributions[seat], level) - Math.min(contributions[seat], previous);
      if (share > 0) {
        layer += share;
        contributors.push(seat);
      }
    }

    let winners = bestAmong(folded, ranks, (seat) => contributions[seat] >= level);
    if (winners.length === 0) winners = contributors; // uncalled, returned
    const share = layer / winners.length;
    for (const seat of winners) payouts[seat] += share;
    previous = level;
  }

  if (dead > 0) {
    const winners = bestAmong(folded, ranks, null);
    const share = dead / winners.length;
    for (const seat of winners) payouts[seat] += share;
  }

  return payouts;
}
