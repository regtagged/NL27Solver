/**
 * What each action at one decision is worth, for one named hand.
 *
 * The solves run with `trackEv: false` - per-hand EV tables are another random
 * write into another big block at every visit, and a solve that is only after
 * the strategy does not need them. So nothing on disk says what an action is
 * worth, and a frequency on its own is not an argument: a 30% action might be
 * worth a tenth of a bet less than the alternative or a whole one.
 *
 * This measures instead. Deal the rest of the deck around the four cards the
 * hand holds, weight the deal by how often the opponent would have played the
 * prefix holding what it was dealt, then take each action in turn and play the
 * hand out with both seats drawing from their average strategies. The mean
 * payoff is what that action is worth from where the hand actually stands.
 *
 * Two things make the comparison sharper than the noise it swims in:
 *
 * - **The deck is dealt once per trial.** Replacement cards come off the deck
 *   before the walk, so drawing one and drawing two on the same trial receive
 *   the *same* cards. Nobody gets lucky in one arm and not the other.
 * - **The difference is paired.** Every arm is played on the same deal with the
 *   same random stream, so what is reported is the mean of per-trial
 *   differences and its own standard error - a much smaller number than the
 *   error on either arm alone, and the only one the comparison needs.
 *
 * Money is hundredths of a big blind counted from the start of the hand, the
 * same convention as `badugi-ev.mjs`, so a difference of 10 is a tenth of a big
 * blind.
 *
 * The opponent is the *solve's* opponent, not the one at the table. This says
 * which action is better against a player who is playing the solve, which is
 * the question worth asking about one's own decision and not a read on anybody.
 *
 * **It is not free.** Every arm is a full play-out per deal, so the cost is
 * `deals x actions` hands. Fifty thousand deals is about eleven seconds and
 * gives errors under three hundredths of a bet; two thousand is under half a
 * second and gives about fifteen, which is enough to catch a blunder and not
 * enough to rank two close actions. Callers that answer to a person should say
 * which of those they bought.
 */

import { DRAWING } from './tree.js';
import { makeRng, deal } from './cards.js';

/** Which hand a seat is holding right now, given what it has drawn. */
export const handNow = (solver, seat) => solver.handTable[
  solver.handAfter[seat * solver.slotsPerSeat + solver.slotFor(seat)]];

/**
 * Deals the whole table, then puts the hero's four cards back where they belong.
 *
 * The deck is a full 52 either way, so a card the hero must hold is somewhere
 * in it and swapping it into place is a permutation - no duplicate, nothing
 * dropped. What the swap can disturb is another seat's preset range, when the
 * card it displaces lands in that seat's hand, so that is re-checked and the
 * deal thrown away if it no longer qualifies.
 */
export function dealAround(solver, rng, seat, cards) {
  for (let tries = 0; tries < 500; tries += 1) {
    deal(solver.deck, solver.cardsNeeded, rng);
    for (let i = 0; i < 4; i += 1) {
      const want = cards[i];
      let at = -1;
      for (let d = 0; d < solver.deck.length; d += 1) {
        if (solver.deck[d] === want) { at = d; break; }
      }
      solver.deck[at] = solver.deck[seat * 4 + i];
      solver.deck[seat * 4 + i] = want;
    }
    let ok = true;
    for (const other of solver.presetSeats) {
      if (other === seat) continue;
      if (!solver.presetRanges[other][solver.holeValue(other)]) { ok = false; break; }
    }
    if (!ok) continue;
    solver.drawn.fill(-1);
    for (const live of solver.live) solver.prepareSeat(live);
    return true;
  }
  return false;
}

/** Applies an action to the draw record, for the nodes where that means something. */
const applyDraw = (solver, node, at) => {
  if (node.street !== DRAWING) return;
  solver.drawn[node.seat * solver.rounds + solver.roundOf(node)] = node.actions[at].option;
};

/**
 * Walks the prefix, returning how much this deal counts for.
 *
 * The hero's own actions are the thing being conditioned on, so they cost
 * nothing. The opponent's are what decides whether this deal belongs here at
 * all: a deal where the opponent would rarely have played the prefix it played
 * is rare traffic at this node and is weighted as such, rather than thrown away
 * and re-rolled. Weighting uses every deal; rejection would burn most of them.
 */
export function prefixWeight(solver, line, heroSeat) {
  let id = solver.tree.root;
  let weight = 1;
  for (const at of line) {
    const node = solver.nodes[id];
    if (node.kind !== 'decision') return { weight: 0, id: -1 };
    if (node.seat !== heroSeat) {
      weight *= solver.averageAt(id, handNow(solver, node.seat))[at];
      if (weight <= 0) return { weight: 0, id: -1 };
    }
    applyDraw(solver, node, at);
    id = node.actions[at].child;
  }
  return { weight, id };
}

/** Plays out from a node, both seats drawing from their average strategies. */
export function playFrom(solver, start, rng) {
  let id = start;
  for (let guard = 0; guard < 512; guard += 1) {
    const node = solver.nodes[id];
    if (node.kind !== 'decision') return node;
    const mix = solver.averageAt(id, handNow(solver, node.seat));
    let roll = rng();
    let at = mix.length - 1;
    for (let a = 0; a < mix.length; a += 1) {
      roll -= mix[a];
      if (roll < 0) { at = a; break; }
    }
    applyDraw(solver, node, at);
    id = node.actions[at].child;
  }
  throw new Error('the walk did not end');
}

/**
 * Every action at one decision, priced against each other on the same deals.
 *
 * `line` reaches the decision and `cards` is what the hero holds there, as deck
 * numbers. Returns a mean and a standard error for each action, and for each the
 * paired difference against `baseline` - which is the one that carries the
 * argument, because the errors on two arms measured on the same deals are almost
 * entirely the same error twice.
 *
 * `value` is the hand's badugi class, and it is checked rather than trusted: the
 * deck and a hand history disagree about how to number a card, and a mistake
 * there does not throw, it quietly prices a hand nobody held.
 */
export function priceActions(solver, {
  line, seat, cards, value = null, deals = 20000, seed = 4242, baseline = 0,
}) {
  let id = solver.tree.root;
  for (const step of line) id = solver.nodes[id].actions[step].child;
  const spot = solver.nodes[id];
  if (!spot || spot.kind !== 'decision') throw new Error('that line does not end at a decision');
  const width = spot.actions.length;

  const sum = new Float64Array(width);
  const squares = new Float64Array(width);
  const diff = new Float64Array(width);
  const diffSquares = new Float64Array(width);
  const rng = makeRng(seed);
  const held = new Int8Array(solver.drawn.length);
  const pays = new Float64Array(width);
  let weightSum = 0;
  let weightSquares = 0;
  let used = 0;

  for (let n = 0; n < deals; n += 1) {
    if (!dealAround(solver, rng, seat, cards)) continue;
    if (n === 0 && value !== null && solver.holeValue(seat) !== value) {
      throw new Error(`dealt ${solver.handLabels[solver.holeValue(seat)]}, `
        + `wanted ${solver.handLabels[value]}`);
    }
    const { weight, id: reached } = prefixWeight(solver, line, seat);
    if (weight <= 0) continue;
    if (reached !== id) throw new Error('the prefix did not arrive where it should');
    held.set(solver.drawn);
    used += 1;
    weightSum += weight;
    weightSquares += weight * weight;

    for (let a = 0; a < width; a += 1) {
      solver.drawn.set(held);
      // One stream per arm, seeded the same, so the arms differ by the action
      // and not by the dice.
      const inner = makeRng(seed + n * 977 + 1);
      applyDraw(solver, spot, a);
      const end = playFrom(solver, spot.actions[a].child, inner);
      pays[a] = solver.payoff(end, seat);
      sum[a] += weight * pays[a];
      squares[a] += weight * pays[a] * pays[a];
    }
    for (let a = 0; a < width; a += 1) {
      const d = pays[a] - pays[baseline];
      diff[a] += weight * d;
      diffSquares[a] += weight * d * d;
    }
  }
  solver.drawn.fill(-1);

  // The effective sample size of a weighted mean, which is what its error is
  // really built on - a thousand deals of which one carries half the weight is
  // not a thousand deals.
  const effective = weightSum > 0 ? (weightSum * weightSum) / weightSquares : 0;
  const stat = (total, sq) => {
    const mean = weightSum > 0 ? total / weightSum : 0;
    const spread = Math.max(0, (sq / weightSum) - mean * mean);
    return { mean, error: effective > 1 ? Math.sqrt(spread / effective) : Infinity };
  };
  return {
    node: spot,
    used,
    effective,
    arms: spot.actions.map((action, a) => ({
      at: a,
      label: action.label,
      kind: action.kind,
      option: action.option ?? null,
      ...stat(sum[a], squares[a]),
      versus: stat(diff[a], diffSquares[a]),
    })),
  };
}
