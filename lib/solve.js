/**
 * Monte Carlo CFR over the pre-draw tree.
 *
 * External sampling: one iteration picks a traverser, deals a table, walks
 * every action the traverser could take and samples a single action for
 * everyone else. Regrets accumulate at the traverser's own decisions; the
 * average strategy accumulates at the other seats, which is where it converges
 * from, and cycling the traverser means every seat gets both treatments.
 *
 * Two things make the deal honest. Hands and replacement cards come off one
 * shuffled deck, so a card another player holds is a card this one cannot draw.
 * And the replacements are dealt *before* the walk, not during it - the same
 * iteration explores several branches, and if each branch drew its own cards
 * the traverser would be comparing actions against different futures instead of
 * against each other.
 *
 * Everything past the draw is the rollout's problem, not this file's.
 *
 * Two ways to accumulate, chosen by `algorithm`. 'cfr+' floors regret at zero
 * and weights the average linearly. 'dcfr' is Brown and Sandholm's Discounted
 * CFR: regret is never floored, but every so often positive regret is scaled by
 * t^α/(t^α+1) and negative regret by t^β/(t^β+1), and the average weights the
 * t-th step by t^γ. Negative regret halving each step is what lets a bad early
 * read be forgotten without CFR+'s hard floor throwing the information away.
 *
 * The paper discounts after every full iteration. A sampled iteration touches a
 * handful of information sets, so here a step is `every` iterations, and t
 * counts steps rather than deals. The step size matters: six-handed at 40bb,
 * a step every 10,000 left the solve 89.7 bb/100 exploitable at 3M iterations
 * and a step every 50,000 left it 47.0 (CFR+: 144.5), because halving negative
 * regret more often than a rarely-reached decision is visited forgets what it
 * learned before it is used.
 */

export const ALGORITHMS = ['cfr+', 'dcfr'];
export const DCFR_DEFAULTS = { alpha: 1.5, beta: 0, gamma: 2, every: 50000 };

/** One Discounted CFR step, in place, over every regret store that exists. */
export function discountRegrets(blocks, t, { alpha, beta }) {
  const positive = t ** alpha / (t ** alpha + 1);
  const negative = t ** beta / (t ** beta + 1);
  for (const block of blocks) {
    if (!block) continue;
    for (let i = 0; i < block.length; i += 1) {
      block[i] *= block[i] > 0 ? positive : negative;
    }
  }
}

import { freshDeck, makeRng, deal } from './cards.js';
import { handIndex, handRanks } from './eval27.js';
import {
  buildTree, defaultConfig, positionNames, BB, FOLDED, PRE_DRAW, DRAWING, POST_DRAW,
} from './tree.js';
import { buckets, keepsFor, DEFAULT_LIMITS } from './abstraction.js';
import { rollout, distribute } from './rollout.js';
import { coarseBuckets, coarseShowdown } from './coarse.js';

const MAX_DEPTH = 64;
const MAX_ACTIONS = 8;

export class Solver {
  constructor(options = {}) {
    /**
     * A joint solve plays the hand out instead of handing it to a rollout.
     *
     * The draw stops being a policy and becomes a decision, which is what
     * convertibility needs - J-5-4-3-2 can stand pat or draw one depending on
     * what the seats before it did, and how many cards each took is public.
     * It is also what snowing needs: standing pat on 2-2-2-5-5 wins nothing at
     * showdown and everything from a fold, so it only exists if there is a
     * street to bet on afterwards.
     */
    this.joint = options.joint === true;
    this.config = { ...defaultConfig(), ...options.config, stopAtDraw: !this.joint };
    this.limits = options.limits ?? DEFAULT_LIMITS;
    this.players = this.config.players;
    this.startStack = Math.round(this.config.stack * BB);
    this.rng = makeRng(options.seed ?? 1);
    this.names = positionNames(this.players);

    this.algorithm = options.algorithm ?? 'cfr+';
    if (!ALGORITHMS.includes(this.algorithm)) {
      throw new Error(`Unknown algorithm "${this.algorithm}"; expected ${ALGORITHMS.join(' or ')}.`);
    }
    this.discount = this.algorithm === 'dcfr' ? { ...DCFR_DEFAULTS, ...options.discount } : null;
    this.weight = 1;

    this.tree = buildTree(this.config);
    this.nodes = this.tree.nodes;

    // The solver does not want the abstraction the viewer shows. Every bucket
    // is an information set that has to be visited thousands of times before it
    // means anything, and 679 nodes against 3,463 buckets is 2.35 million of
    // them - which is why seven-handed would not settle. The coarse one is a
    // few hundred, grouped at the level a range is actually read at.
    if (options.abstraction === 'coarse') {
      const coarse = coarseBuckets();
      this.bucketTable = coarse.table;
      this.bucketCount = coarse.count;
      this.bucketLabels = coarse.labels;
    } else {
      this.bucketTable = buckets(this.limits).table;
      this.bucketCount = buckets(this.limits).descriptors.length;
      this.bucketLabels = null;
    }

    this.rolloutOptions = {
      startStack: this.startStack,
      limits: this.limits,
      postDraw: options.postDraw ?? 'threshold',
    };

    // Regret and average-strategy stores, allocated per node on first visit.
    this.regret = new Array(this.nodes.length).fill(null);
    this.average = new Array(this.nodes.length).fill(null);

    /**
     * What a hand is worth here, in chips, and how often it has been asked.
     *
     * Money is hundredths of a big blind, so the running average is already
     * big blinds per hundred hands - the unit a player quotes - without any
     * conversion. It is the value of the decision given the hand and given
     * reaching this node, which is what a solver means by the EV of a hand.
     */
    this.evSum = new Array(this.nodes.length).fill(null);
    this.evHits = new Array(this.nodes.length).fill(null);
    this.bytes = 0;

    // A fold-out pays the same however the cards fell, so it is worked out once.
    this.foldPayoffs = new Array(this.nodes.length).fill(null);
    for (const node of this.nodes) {
      if (node.kind === 'fold') this.foldPayoffs[node.id] = this.payoffsForFold(node);
    }

    if (this.joint) {
      const showdown = coarseShowdown();
      this.showdownTable = showdown.table;
      this.showdownCount = showdown.count;
      this.showdownLabels = showdown.labels;
      this.ranks = handRanks();

      // What each seat put in, and who is still in, are fixed by the node; only
      // the cards change between iterations.
      this.paidAt = new Array(this.nodes.length).fill(null);
      this.foldedAt = new Array(this.nodes.length).fill(null);
      for (const node of this.nodes) {
        if (node.kind !== 'showdown') continue;
        const paid = new Int32Array(this.players);
        const folded = new Uint8Array(this.players);
        for (let seat = 0; seat < this.players; seat += 1) {
          paid[seat] = this.startStack - node.state.stack[seat];
          folded[seat] = node.state.status[seat] === FOLDED ? 1 : 0;
        }
        this.paidAt[node.id] = paid;
        this.foldedAt[node.id] = folded;
      }

      // Per seat and per draw option: what it finishes as, and whether it can.
      const slots = this.players * 3;
      this.optionRank = new Int32Array(slots);
      this.optionBucket = new Int32Array(slots);
      this.optionLegal = new Uint8Array(slots);
      this.showRanks = new Int32Array(this.players);
      this.payoutScratch = new Float64Array(this.players);
      this.maskScratch = Array.from({ length: MAX_DEPTH }, () => new Uint8Array(MAX_ACTIONS));
    }

    // Per-depth scratch, so the walk allocates nothing.
    this.strategyScratch = Array.from({ length: MAX_DEPTH }, () => new Float64Array(MAX_ACTIONS));
    this.valueScratch = Array.from({ length: MAX_DEPTH }, () => new Float64Array(MAX_ACTIONS));
    this.seatBuckets = new Int32Array(this.players);

    this.deck = freshDeck();
    this.iterations = 0;
  }

  /** Who wins what when everybody but one seat gives up. */
  payoffsForFold(node) {
    const payoffs = new Float64Array(this.players);
    let pot = 0;
    let winner = -1;
    for (let seat = 0; seat < this.players; seat += 1) {
      pot += this.startStack - node.state.stack[seat];
      if (node.state.status[seat] !== FOLDED) winner = seat;
    }
    for (let seat = 0; seat < this.players; seat += 1) {
      payoffs[seat] = -(this.startStack - node.state.stack[seat]);
    }
    payoffs[winner] += pot;
    return payoffs;
  }

  store(which, nodeId, actions, buckets) {
    let block = which[nodeId];
    if (!block) {
      block = new Float32Array(buckets * actions);
      which[nodeId] = block;
      this.bytes += block.byteLength;
    }
    return block;
  }

  /**
   * Regret matching: positive regret in proportion, uniform when there is none.
   *
   * `mask` rules actions out entirely - a hand with three distinct ranks cannot
   * draw one, and the tree offers the action to every hand because the branch
   * has to exist for the hands that can.
   */
  static match(regrets, base, actions, out, mask = null) {
    let total = 0;
    let available = 0;
    for (let a = 0; a < actions; a += 1) {
      if (mask && !mask[a]) {
        out[a] = 0;
        continue;
      }
      available += 1;
      const value = regrets[base + a];
      out[a] = value > 0 ? value : 0;
      total += out[a];
    }
    if (total > 0) {
      for (let a = 0; a < actions; a += 1) out[a] /= total;
    } else {
      for (let a = 0; a < actions; a += 1) {
        out[a] = (mask && !mask[a]) ? 0 : 1 / (available || actions);
      }
    }
  }

  /**
   * What a seat finishes as under each draw, worked out once per iteration.
   *
   * The draw is a decision, so every branch of it has to be priced - but the
   * cards are the same down all three, so the three finished hands are computed
   * here rather than at each of the thousands of nodes that ask about them.
   *
   * An option a hand cannot take is marked, not guessed at: three distinct
   * ranks cannot draw one, and the tree offers the branch anyway because the
   * hands that *can* need it to exist.
   */
  finishAll(seat, hand, reserve) {
    const { four, three } = keepsFor(hand);
    for (let option = 0; option < 3; option += 1) {
      const slot = seat * 3 + option;
      let final = hand;
      if (option > 0) {
        const kept = option === 1 ? four : three;
        if (!kept) {
          this.optionLegal[slot] = 0;
          continue;
        }
        final = kept.slice();
        for (let i = final.length; i < 5; i += 1) final.push(reserve[seat * 2 + (i - kept.length)]);
      }
      this.optionLegal[slot] = 1;
      const rank = this.ranks[handIndex(final)];
      this.optionRank[slot] = rank;
      this.optionBucket[slot] = this.showdownTable[rank];
    }
  }

  /**
   * Who wins the pot once everybody has drawn and the betting is done.
   *
   * What each seat put in and who is still in are fixed by the node; the only
   * thing the cards decide is the order they finish in.
   */
  showdownPayoff(node, traverser) {
    const paid = this.paidAt[node.id];
    const folded = this.foldedAt[node.id];
    const draws = node.state.draws;
    for (let seat = 0; seat < this.players; seat += 1) {
      this.showRanks[seat] = folded[seat]
        ? 0x7fffffff
        : this.optionRank[seat * 3 + draws[seat]];
    }
    distribute(paid, folded, this.showRanks, 0, this.payoutScratch);
    return this.payoutScratch[traverser] - paid[traverser];
  }

  /** One iteration per seat, so every seat traverses equally often. */
  run(iterations, onProgress) {
    const needed = this.players * 7;
    for (let i = 0; i < iterations; i += 1) {
      deal(this.deck, needed, this.rng);
      const hands = [];
      const reserve = this.deck.subarray(this.players * 5, needed);
      for (let seat = 0; seat < this.players; seat += 1) {
        const hand = this.deck.subarray(seat * 5, seat * 5 + 5);
        hands.push(hand);
        // The bucket cannot change during an iteration, so it is looked up once
        // per seat rather than once per node visited.
        this.seatBuckets[seat] = this.bucketTable[handIndex(hand)];
        if (this.joint) this.finishAll(seat, hand, reserve);
      }

      // What this iteration's strategy counts for in the average: linearly for
      // CFR+, and by the step number to the power γ for Discounted CFR.
      this.weight = this.discount
        ? (Math.floor(this.iterations / this.discount.every) + 1) ** this.discount.gamma
        : this.iterations + 1;

      this.traverse(this.tree.root, this.iterations % this.players, hands, reserve, 0);
      this.iterations += 1;
      if (this.discount && this.iterations % this.discount.every === 0) {
        discountRegrets(this.regret, this.iterations / this.discount.every, this.discount);
      }
      if (onProgress && this.iterations % 100000 === 0) onProgress(this);
    }
    return this;
  }

  traverse(nodeId, traverser, hands, reserve, depth) {
    const node = this.nodes[nodeId];

    if (node.kind === 'fold') return this.foldPayoffs[nodeId][traverser];
    if (node.kind === 'showdown') return this.showdownPayoff(node, traverser);
    if (node.kind === 'draw') {
      return rollout(node.state, hands, reserve, this.rolloutOptions).payoffs[traverser];
    }

    const actions = node.actions.length;
    const seat = node.seat;

    // Before the draw a seat is its starting hand; after it, the hand it drew,
    // which the node knows because how many cards each took is public.
    let bucket;
    let buckets;
    let mask = null;
    if (node.street === POST_DRAW) {
      bucket = this.optionBucket[seat * 3 + node.draws[seat]];
      buckets = this.showdownCount;
    } else {
      bucket = this.seatBuckets[seat];
      buckets = this.bucketCount;
      if (node.street === DRAWING) {
        mask = this.maskScratch[depth];
        for (let a = 0; a < actions; a += 1) {
          mask[a] = this.optionLegal[seat * 3 + node.actions[a].option];
        }
      }
    }

    const base = bucket * actions;
    const strategy = this.strategyScratch[depth];
    const regrets = this.store(this.regret, nodeId, actions, buckets);
    Solver.match(regrets, base, actions, strategy, mask);

    if (seat === traverser) {
      const values = this.valueScratch[depth];
      let value = 0;
      for (let a = 0; a < actions; a += 1) {
        if (mask && !mask[a]) {
          values[a] = 0;
          continue;
        }
        values[a] = this.traverse(node.actions[a].child, traverser, hands, reserve, depth + 1);
        value += strategy[a] * values[a];
      }
      // CFR+: regret never goes below zero. An action that was bad early stops
      // dragging a debt behind it and can be picked up again the moment it
      // starts looking good, which is most of why this converges in millions of
      // iterations rather than hundreds of millions. Discounted CFR keeps the
      // debt and shrinks it instead, in `discountRegrets`.
      const floor = this.discount === null;
      for (let a = 0; a < actions; a += 1) {
        if (mask && !mask[a]) continue;
        const updated = regrets[base + a] + (values[a] - value);
        regrets[base + a] = updated > 0 || !floor ? updated : 0;
      }

      this.store(this.evSum, nodeId, 1, buckets)[bucket] += value;
      this.store(this.evHits, nodeId, 1, buckets)[bucket] += 1;
      return value;
    }

    // Later iterations count for more, because they come from a strategy that
    // has had more chance to be right. `run` sets how much more.
    const average = this.store(this.average, nodeId, actions, buckets);
    const weight = this.weight;
    for (let a = 0; a < actions; a += 1) average[base + a] += weight * strategy[a];

    let roll = this.rng();
    let picked = -1;
    for (let a = 0; a < actions; a += 1) {
      roll -= strategy[a];
      if (roll < 0) {
        picked = a;
        break;
      }
    }
    // Rounding can leave the roll unspent; fall back to something legal.
    if (picked < 0) {
      for (let a = actions - 1; a >= 0; a -= 1) {
        if (strategy[a] > 0) {
          picked = a;
          break;
        }
      }
    }
    return this.traverse(node.actions[picked].child, traverser, hands, reserve, depth + 1);
  }

  /**
   * The average strategy at a node for one bucket - the thing that converges.
   *
   * A bucket never visited falls back to the node's uniform strategy, which is
   * honest: nothing has been learned about it.
   */
  /**
   * What a hand is worth at this decision, in big blinds per hundred.
   *
   * Null where the hand has never been dealt into this node, which is honest -
   * an average of nothing is not zero, it is nothing.
   */
  evAt(nodeId, bucket) {
    const sum = this.evSum[nodeId];
    const hits = this.evHits[nodeId];
    if (!sum || !hits || !hits[bucket]) return null;
    return sum[bucket] / hits[bucket];
  }

  strategyAt(nodeId, bucket) {
    const node = this.nodes[nodeId];
    const actions = node.actions.length;
    const average = this.average[nodeId];
    const out = new Float64Array(actions);
    if (!average) return out.fill(1 / actions);

    const base = bucket * actions;
    let total = 0;
    for (let a = 0; a < actions; a += 1) total += average[base + a];
    if (total <= 0) return out.fill(1 / actions);
    for (let a = 0; a < actions; a += 1) out[a] = average[base + a] / total;
    return out;
  }

  /**
   * The node where a seat acts first with the pot folded to it - its opening
   * decision, and the one people mean by a range.
   */
  openingNode(seat) {
    let nodeId = this.tree.root;
    for (let guard = 0; guard < this.players * 4; guard += 1) {
      const node = this.nodes[nodeId];
      if (node.kind !== 'decision') return -1;
      if (node.seat === seat) return nodeId;
      const fold = node.actions.find((action) => action.kind === 'fold');
      if (!fold) return -1;
      nodeId = fold.child;
    }
    return -1;
  }

  memory() {
    return this.bytes;
  }
}

export function solve(options) {
  return new Solver(options);
}
