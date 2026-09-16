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
 */

import { freshDeck, makeRng, deal } from './cards.js';
import { handIndex } from './eval27.js';
import { buildTree, defaultConfig, positionNames, BB, FOLDED } from './tree.js';
import { buckets, DEFAULT_LIMITS } from './abstraction.js';
import { rollout } from './rollout.js';

const MAX_DEPTH = 64;
const MAX_ACTIONS = 8;

export class Solver {
  constructor(options = {}) {
    this.config = { ...defaultConfig(), ...options.config, stopAtDraw: true };
    this.limits = options.limits ?? DEFAULT_LIMITS;
    this.players = this.config.players;
    this.startStack = Math.round(this.config.stack * BB);
    this.rng = makeRng(options.seed ?? 1);
    this.names = positionNames(this.players);

    this.tree = buildTree(this.config);
    this.nodes = this.tree.nodes;
    this.bucketTable = buckets(this.limits).table;
    this.bucketCount = buckets(this.limits).descriptors.length;

    this.rolloutOptions = {
      startStack: this.startStack,
      limits: this.limits,
      postDraw: options.postDraw ?? 'threshold',
    };

    // Regret and average-strategy stores, allocated per node on first visit.
    this.regret = new Array(this.nodes.length).fill(null);
    this.average = new Array(this.nodes.length).fill(null);
    this.bytes = 0;

    // A fold-out pays the same however the cards fell, so it is worked out once.
    this.foldPayoffs = new Array(this.nodes.length).fill(null);
    for (const node of this.nodes) {
      if (node.kind === 'fold') this.foldPayoffs[node.id] = this.payoffsForFold(node);
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

  store(which, nodeId, actions) {
    let block = which[nodeId];
    if (!block) {
      block = new Float32Array(this.bucketCount * actions);
      which[nodeId] = block;
      this.bytes += block.byteLength;
    }
    return block;
  }

  /** Regret matching: positive regret in proportion, uniform when there is none. */
  static match(regrets, base, actions, out) {
    let total = 0;
    for (let a = 0; a < actions; a += 1) {
      const value = regrets[base + a];
      out[a] = value > 0 ? value : 0;
      total += out[a];
    }
    if (total > 0) {
      for (let a = 0; a < actions; a += 1) out[a] /= total;
    } else {
      for (let a = 0; a < actions; a += 1) out[a] = 1 / actions;
    }
  }

  /** One iteration per seat, so every seat traverses equally often. */
  run(iterations, onProgress) {
    const needed = this.players * 7;
    for (let i = 0; i < iterations; i += 1) {
      deal(this.deck, needed, this.rng);
      const hands = [];
      for (let seat = 0; seat < this.players; seat += 1) {
        const hand = this.deck.subarray(seat * 5, seat * 5 + 5);
        hands.push(hand);
        // The bucket cannot change during an iteration, so it is looked up once
        // per seat rather than once per node visited.
        this.seatBuckets[seat] = this.bucketTable[handIndex(hand)];
      }
      const reserve = this.deck.subarray(this.players * 5, needed);

      this.traverse(this.tree.root, this.iterations % this.players, hands, reserve, 0);
      this.iterations += 1;
      if (onProgress && this.iterations % 100000 === 0) onProgress(this);
    }
    return this;
  }

  traverse(nodeId, traverser, hands, reserve, depth) {
    const node = this.nodes[nodeId];

    if (node.kind === 'fold') return this.foldPayoffs[nodeId][traverser];
    if (node.kind === 'draw') {
      return rollout(node.state, hands, reserve, this.rolloutOptions).payoffs[traverser];
    }

    const actions = node.actions.length;
    const base = this.seatBuckets[node.seat] * actions;
    const strategy = this.strategyScratch[depth];
    const regrets = this.store(this.regret, nodeId, actions);
    Solver.match(regrets, base, actions, strategy);

    if (node.seat === traverser) {
      const values = this.valueScratch[depth];
      let value = 0;
      for (let a = 0; a < actions; a += 1) {
        values[a] = this.traverse(node.actions[a].child, traverser, hands, reserve, depth + 1);
        value += strategy[a] * values[a];
      }
      // CFR+: regret never goes below zero. An action that was bad early stops
      // dragging a debt behind it and can be picked up again the moment it
      // starts looking good, which is most of why this converges in millions of
      // iterations rather than hundreds of millions.
      for (let a = 0; a < actions; a += 1) {
        const updated = regrets[base + a] + (values[a] - value);
        regrets[base + a] = updated > 0 ? updated : 0;
      }
      return value;
    }

    // Linear averaging: later iterations count for more, because they come from
    // a strategy that has had more chance to be right.
    const average = this.store(this.average, nodeId, actions);
    const weight = this.iterations + 1;
    for (let a = 0; a < actions; a += 1) average[base + a] += weight * strategy[a];

    let roll = this.rng();
    let picked = actions - 1;
    for (let a = 0; a < actions; a += 1) {
      roll -= strategy[a];
      if (roll < 0) {
        picked = a;
        break;
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
