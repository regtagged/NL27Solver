/**
 * Heads-up badugi, with nothing taken out of it.
 *
 * Every other solve in this repository is a *subgame*: a six-handed tree with a
 * fixed prefix, two seats left live, and four seats' hole cards dealt and
 * discarded. That is the right shape for "how should the big blind play against
 * a button open", and it is not the heads-up game. Two differences, and both
 * are real:
 *
 * - **The deck.** A six-handed subgame deals twenty-four hole cards, so
 *   sixteen cards that a heads-up table would leave live are gone. Card removal
 *   is most of what a badugi hand is worth, and this is the bigger of the two.
 * - **The button completes.** `allowLimp: false` is the single largest prune in
 *   the repository, and heads-up it removes an option a third of the range
 *   wants. The small blind *is* the button here; folding or raising is not the
 *   whole of its choice.
 *
 * ## What is exact here, and what is not
 *
 * Exact: all 1,092 badugi values with no buckets; the first draw uncapped at
 * four, which is every draw the game has; four bets a round, which is the rule
 * and not a pruning; one shuffled deck with replacements dealt before the walk;
 * played to showdown with no rollout and no expert continuation.
 *
 * Two prunings, both chosen for time rather than because they are free:
 *
 * - **No completing.** `allowLimp: false` puts the tree at 1.35M nodes against
 *   2.60M. It is the largest prune available and it is a real one: a 300,000
 *   iteration smoke run of blind-versus-blind took the limp 37.6% of the time,
 *   so a tree without it forces about a third of the button's range into a
 *   raise. **Read the opening frequency knowing that.**
 * - **Later draws capped at three and two.** The first draw is uncapped, which
 *   is where it matters - drawing four is only ever right for quads and the high
 *   monotone hands, and those are one-card values that have to throw the kept
 *   card away to improve. By the second draw a hand that would take four has
 *   already taken its four.
 *
 * ## What it costs
 *
 * 1,351,651 nodes and 626,647 decisions, which at 1,092 values a decision is
 * **13.5 GB** of regret and average. The dials, measured, if that has to move:
 *
 * | draws   | limp | nodes     | tables  |
 * | ---     | ---  | ---       | ---     |
 * | 3,2,2   | no   | 487,271   | 4.9 GB  |
 * | 4,3,2   | no   | 1,351,651 | 13.5 GB |
 * | 4,3,3   | no   | 2,331,651 | 23.3 GB |
 * | 4,3,2   | yes  | 2,604,220 | 25.9 GB |
 * | 3,3,3   | yes  | 2,878,616 | 28.6 GB |
 * | 4,4,4   | no   | 5,604,251 | 56.0 GB |
 *
 * Raising the betting cap is the other lever and the most expensive one: on the
 * 3,3,3-with-limp tree, five bets a round was 43.6 GB and six was 61.7.
 */

import { positionNames } from './tree.js';
import { BadugiSolver, badugiConfig } from './badugi-solve.js';

/** The game, in one place, so the solve and every reader of it agree. */
export const HEADS_UP = {
  key: 'hu',
  what: 'Heads-up badugi, first draw uncapped, raise or fold',
  players: 2,
  draws: [4, 3, 2],
  cap: 4,
  allowLimp: false,
  /**
   * Epsilon fades over two hundred discount steps, which is ten million
   * iterations to halve it.
   *
   * Coverage is worth most while a line nobody plays is a line nobody has
   * learned, and the O(epsilon) bias it is bought with is worth least then -
   * two per cent is the same order as the leak these solves exist to measure,
   * and a run of hundreds of millions has no reason to carry it to the end.
   */
  exploreDecay: 200,
  /** And never below this, which is what stops the decay undoing itself. */
  exploreFloor: 0.005,
  /**
   * Pruning, with one iteration in fifty walking everything anyway.
   *
   * The threshold is left to the solver, which takes the widest pot in the tree:
   * a regret further below zero than that cannot be lifted to zero by the single
   * iteration being skipped. The revisit rate is what keeps the pruned subtrees
   * trained, and it does not fade with epsilon - the reason to keep walking them
   * lasts as long as the run does.
   */
  prune: { revisit: 0.02 },
};

/**
 * The options `badugiConfig` wants, rather than the config itself.
 *
 * A worker is handed these and builds its own config from them, so the main
 * thread and every thread pass the same input through the same function. Handing
 * over a *built* config instead would send it through `badugiConfig` a second
 * time as a bag of overrides, and a game that differs between threads differs
 * silently - the rate looks right and the answer is to a question nobody asked.
 */
export function headsUpOptions(over = {}) {
  return {
    players: HEADS_UP.players,
    // None of these mean anything with two seats: there is nobody to cold-call
    // and nobody to cap out of the pot.
    maxToDraw: null,
    coldCallSeats: null,
    coldCallThreeBets: true,
    allowLimp: over.allowLimp ?? HEADS_UP.allowLimp,
    maxDraw: over.draws ?? HEADS_UP.draws,
    maxDrawBySeat: null,
    limit: { smallBet: 1, bigBet: 2, bigBetFrom: 2, cap: over.cap ?? HEADS_UP.cap },
    // Well clear of the 2.9M this builds, and low enough that a configuration
    // which would not fit in memory is refused by the builder rather than
    // discovered by the allocator.
    nodeLimit: 12e6,
  };
}

/** The configuration, with the parts a caller may reasonably vary. */
export const headsUpConfig = (over = {}) => badugiConfig(headsUpOptions(over));

/**
 * The solver for the heads-up game.
 *
 * No `from` and no preset ranges: the hand starts where a hand starts and both
 * strategies come out of the solve. That is the whole point of solving this
 * rather than a subgame - there is no inherited range to be wrong about.
 */
export function headsUpSolver(over = {}) {
  const config = headsUpConfig(over);
  const solver = new BadugiSolver({
    config,
    seed: over.seed ?? 21,
    trackEv: false,
    explore: over.explore ?? 0.02,
    exploreDecay: over.exploreDecay ?? HEADS_UP.exploreDecay,
    exploreFloor: over.exploreFloor ?? HEADS_UP.exploreFloor,
    prune: over.prune === null ? null : { ...HEADS_UP.prune, ...(over.prune ?? {}) },
    shared: over.shared ?? false,
  });
  return { solver, config, names: positionNames(HEADS_UP.players) };
}

/**
 * What a worker needs to build the same game for itself.
 *
 * No `line` and no `preset`, which the worker reads as "start at the start" and
 * "nobody's range is given" - the two things that make this the whole game.
 */
export const headsUpBuild = (over = {}) => ({
  config: headsUpOptions(over),
  line: null,
  preset: null,
  explore: over.explore ?? 0.02,
  exploreDecay: over.exploreDecay ?? HEADS_UP.exploreDecay,
  exploreFloor: over.exploreFloor ?? HEADS_UP.exploreFloor,
  prune: over.prune === null ? null : { ...HEADS_UP.prune, ...(over.prune ?? {}) },
});

/** How much memory the strategy tables want, in bytes. */
export function tableBytes(solver) {
  let edges = 0;
  for (const node of solver.nodes) {
    if (node.kind === 'decision') edges += node.actions.length;
  }
  return 2 * edges * solver.handCount * 4;
}
