/**
 * Things a badugi strategy cannot be right about, whatever the solve says.
 *
 * Exploitability tells you how much a strategy gives away in total, in hours.
 * These tell you *where* it is wrong, in seconds, and they are checkable rather
 * than arguable - which is what makes them worth having beside it. The first
 * one is the reason this file exists.
 *
 * ## Standing pat on an incomplete hand is dominated
 *
 * A hand's value is its best badugi subset. If that subset uses `k` cards, then
 * drawing exactly `4 - k` throws away only the cards that were not playing, and
 * the `k` that were are kept intact - so the hand after the draw is **never
 * worse than the hand before it**, and is better whenever a replacement lands
 * clean. Holding A-2-3 and a dead card, drawing one improves 10 times in 48 and
 * is worse zero times.
 *
 * So for any hand short of a complete badugi, patting is weakly dominated in
 * showdown value by the draw that replaces its dead cards. **It is not strictly
 * dominated in the game**, because draws are public and standing pat represents
 * a badugi - that is a snow, and it is a real play. But a snow is a bluff, and
 * a bluff wants the hand that cannot win otherwise. The best tri in the game
 * standing pat every time is not a snow; it is an information set nobody
 * visited, purified onto the one action that cannot be right.
 *
 * That is the shape of the check: not "pat must be zero", which would call a
 * legitimate snow a bug, but "a hand that is *good* for its size should not be
 * patting at high frequency", which nothing but a starved node does.
 *
 * Drawing *more* than `4 - k` is not covered. That throws away a playing card
 * and can genuinely be right - breaking a bad badugi, or a rough tri whose low
 * cards are worth more than its high one.
 */

import { badugiTable, sizeOf } from './badugi.js';
import { handFacts } from './badugi-benchmark.js';

/**
 * How many cards a holding must draw to replace only its dead ones.
 *
 * Zero for a complete badugi, which has none - and which is why patting a
 * badugi is never flagged here.
 */
export function deadCards(hand) {
  return 4 - hand.size;
}

/**
 * Where a hand sits among the hands of its own size, as a fraction.
 *
 * Zero is the best tri there is, one the worst. The check is about hands that
 * are *good for their size*, because those are the ones with something to lose
 * by patting: the worst tri in the game has no showdown value to give up and
 * snowing it is a real play.
 */
export function standingWithinSize() {
  const { hands } = handFacts();
  const bySize = new Map();
  hands.forEach((hand, i) => {
    if (!bySize.has(hand.size)) bySize.set(hand.size, []);
    bySize.get(hand.size).push(i);
  });
  const standing = new Float64Array(hands.length);
  for (const list of bySize.values()) {
    // `hands` is already best-first, so position in the list is the ranking.
    let seen = 0;
    const total = list.reduce((sum, i) => sum + hands[i].combos, 0);
    for (const i of list) {
      standing[i] = total > 0 ? seen / total : 0;
      seen += hands[i].combos;
    }
  }
  return standing;
}

export const DOMINANCE_DEFAULTS = {
  // How often a hand may pat before it is worth reporting. A snow is real, so
  // this is not zero; it is high enough that only a purified node trips it.
  frequency: 0.5,
  // How good a hand must be for its size before patting it is suspicious. The
  // best third of tris have showdown value worth keeping; the worst third are
  // exactly what a snow is made of.
  standing: 0.35,
};

/**
 * Hands standing pat on an incomplete holding, where that cannot be a snow.
 *
 * `spot` is one decision as `scripts/badugi-subgame.mjs` writes it: `actions`
 * and a per-hand strategy. Returns one row per offending hand, worst first, so
 * a caller can print them or fail on them.
 */
export function dominatedPatting(spot, options = {}) {
  const { frequency, standing } = { ...DOMINANCE_DEFAULTS, ...options };
  const { hands, total } = handFacts();
  const { labels } = badugiTable();
  const rank = standingWithinSize();

  const patAt = spot.actions.findIndex((a) => a.label === 'pat' || a.option === 0);
  if (patAt < 0) return [];

  const found = [];
  for (let i = 0; i < hands.length; i += 1) {
    const hand = hands[i];
    // A complete badugi has no dead cards, so nothing dominates patting it.
    if (deadCards(hand) === 0) continue;
    // The draw that replaces exactly the dead cards has to be on offer; a
    // ceiling that forbids it means the dominance has nothing to point at.
    const replaces = spot.actions.findIndex((a) => a.label === `d${deadCards(hand)}`);
    if (replaces < 0) continue;

    const pat = spot.hands[i][patAt];
    if (pat < frequency) continue;
    if (rank[i] > standing) continue; // a weak hand for its size: a real snow

    found.push({
      hand: i,
      label: labels[i],
      size: hand.size,
      combos: hand.combos,
      share: 100 * hand.combos / total,
      standing: rank[i],
      pat,
      dominatedBy: spot.actions[replaces].label,
    });
  }
  return found.sort((a, b) => b.pat - a.pat || a.standing - b.standing);
}

/**
 * Which action continues the reported line at each decision.
 *
 * The report walks one line and saves the decisions along it, following a call,
 * else a check, else the first action - so the action taken can be recovered
 * rather than stored. `took` is written into newer reports; this is the fallback
 * for the ones without it.
 */
function tookAt(spot) {
  if (Number.isInteger(spot.took)) return spot.took;
  const call = spot.actions.findIndex((a) => a.kind === 'call');
  if (call >= 0) return call;
  const check = spot.actions.findIndex((a) => a.kind === 'check');
  return check >= 0 ? check : 0;
}

/**
 * How likely a hand is to *arrive* at each decision, per hand.
 *
 * **This is the difference between a strategy and a number.** A decision is
 * reported for all 1,092 values, including the ones whose own earlier play
 * never brings them there: 8-6-4 draws one at the first draw every time, so its
 * entry at the *second* draw describes a hand that has stood pat with a tri -
 * something it does 0% of the time. The solver still has a number there,
 * trained on whatever the 2% exploration sent through, and that number means
 * nothing about how the hand is played.
 *
 * Reach is the product of the seat's own choices along the line. Weighting by
 * it is what the other half of this repo learned the hard way about reporting:
 * a frequency read off a node the hand never reaches is the uniform start with
 * noise on top.
 */
export function reachOf(data, at) {
  const { hands } = handFacts();
  const spot = data.spots[at];
  const reach = new Float64Array(hands.length).fill(1);
  for (let j = 0; j < at; j += 1) {
    const earlier = data.spots[j];
    // Only this seat's own decisions gate its arrival; what the other seat did
    // is already fixed by the line.
    if (earlier.seat !== spot.seat) continue;
    const took = tookAt(earlier);
    for (let h = 0; h < hands.length; h += 1) reach[h] *= earlier.hands[h][took];
  }
  return reach;
}

/**
 * Every draw decision in a solved spot, checked.
 *
 * `minimumReach` drops the hands that do not get there. Without it the check
 * reports the deepest decisions as broken in every solve, because the deepest
 * decisions are where the unreachable entries pile up - and being loudest about
 * the part of the file that means least is the opposite of useful.
 */
export function checkDraws(data, options = {}) {
  const { minimumReach = 0.02, ...rest } = options;
  const reports = [];
  data.spots.forEach((spot, at) => {
    if (!spot.drawing) return;
    const reach = reachOf(data, at);
    const all = dominatedPatting(spot, rest);
    const violations = all.filter((row) => reach[row.hand] >= minimumReach)
      .map((row) => ({ ...row, reach: reach[row.hand] }));
    reports.push({
      at,
      what: spot.what,
      seat: spot.seat,
      violations,
      unreachable: all.length - violations.length,
    });
  });
  return reports;
}

/**
 * The lemma itself, checked against the evaluator rather than asserted.
 *
 * Returns how many of the replacement cards make the hand worse, which for a
 * draw that replaces only dead cards must be zero. `draw` is the function that
 * chooses the keep, passed in so this file does not depend on the solver.
 */
export function worseAfterDrawing(cards, keepFor, score, drawing) {
  const into = new Array(4);
  const kept = keepFor(cards, drawing, into);
  const before = score(cards);
  const held = into.slice(0, kept);
  let worse = 0;
  let better = 0;
  // One replacement card only: enough to establish the direction, and the
  // multi-card case follows by adding them one at a time.
  for (let card = 0; card < 52; card += 1) {
    if (cards.includes(card)) continue;
    const after = score([...held, card]);
    if (after > before) worse += 1;
    else if (after < before) better += 1;
  }
  return { worse, better, sizeOf: sizeOf(before) };
}
