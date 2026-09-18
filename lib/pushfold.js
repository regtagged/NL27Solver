/**
 * All-in or fold hold'em, solved.
 *
 * The simplest game in this repo by a distance, and worth having for exactly
 * that reason: push-fold at fifteen blinds has published solutions, so this is
 * the one place the machinery can be checked against an answer somebody else
 * arrived at independently. Everywhere else - 2-7 single draw, triple draw -
 * the solver is the only thing that has an opinion.
 *
 * ## The game
 *
 * Every seat may shove its stack or fold. Facing a shove a seat may call all-in
 * or fold, and more than one may call. Nothing else exists: no raise sizes, no
 * flop decisions, no draws. The hand ends at a showdown with five board cards,
 * or when everybody but one has folded.
 *
 * ## What fifteen big blinds means
 *
 * It is what is **behind after the ante is posted**, which is how a player
 * counts their own stack at the table: the ante is gone before the hand starts
 * and shoving means putting fifteen in. So a seat brings `stack + ante` and
 * commits `stack`. A blind is part of that fifteen rather than extra, so the
 * small blind shoves for fourteen and a half more.
 *
 * ## Why there are no side pots
 *
 * Every seat that gets all-in has therefore put in exactly the same `stack`, so
 * the pot is flat and never has to be layered. That is a property of equal
 * stacks and an equal ante rather than of the game, and the tests pin it:
 * make the stacks differ and it stops being true.
 *
 * ## The abstraction, which is not one
 *
 * A hand is its 169 classes. Before a board is dealt, AhKh and AsKs differ only
 * in which flushes they can make, and by symmetry that is worth nothing. So
 * unlike the 2-7 solver, nothing here is approximated except the tree, and the
 * tree is the whole game. A disagreement with a published range is a bug, not
 * an abstraction artifact.
 */

import { freshDeck, makeRng, deal } from './cards.js';
import { best7, handClass, HAND_CLASS_COUNT, HAND_CLASS_COMBOS } from './holdem.js';
import { discountRegrets, DCFR_DEFAULTS } from './solve.js';
import { positionNames, preDrawOrder } from './tree.js';

const BB = 100;
const units = (bb) => Math.round(bb * BB);

export function pushFoldConfig(overrides = {}) {
  return {
    players: 7,
    stack: 15, // behind after the ante, which is what a shove is for
    smallBlind: 0.5,
    bigBlind: 1,
    ante: 0.6, // from every player
    ...overrides,
  };
}

export const SHOVE = 1;
export const FOLD = 0;

/**
 * The tree, which is small enough to hold in one array.
 *
 * A node is a seat to act, plus who is still live and whether anyone has shoved
 * yet. Nobody acts twice - a seat that folds is out and a seat that shoves or
 * calls is all-in - so the tree is a chain of at most `players` decisions and
 * needs no merging to stay small.
 */
export function buildPushFoldTree(config) {
  const { players } = config;
  const order = preDrawOrder(players);
  const nodes = [];

  /**
   * @param at      how far down the action order we are
   * @param live    seats that have shoved, in order
   * @param folded  how many have folded
   */
  const walk = (at, live) => {
    if (at >= players) {
      return { kind: live.length >= 2 ? 'showdown' : 'uncontested', live };
    }
    const seat = order[at];
    const facing = live.length > 0;
    // The big blind acts last. With nothing shoved in front of it there is
    // nothing to decide: it already has the best hand at the table by default,
    // and the antes and the small blind are its.
    if (!facing && at === players - 1) return { kind: 'walkover', live: [], winner: seat };
    const node = {
      kind: 'decision',
      seat,
      facing, // is this a call decision or an open shove decision
      live: [...live],
      actions: [],
      id: nodes.length,
    };
    nodes.push(node);
    // Folding, then committing. The order is fixed so an action index means the
    // same thing at every node in the tree.
    node.actions = [
      { label: 'fold', kind: 'fold', child: -1 },
      { label: facing ? 'call' : 'all-in', kind: facing ? 'call' : 'allin', child: -1 },
    ];
    const foldTo = walk(at + 1, live);
    const shoveTo = walk(at + 1, [...live, seat]);
    node.actions[FOLD].child = register(foldTo);
    node.actions[SHOVE].child = register(shoveTo);
    return node;
  };

  const terminals = [];
  const register = (result) => {
    if (result.kind === 'decision') return result.id;
    // Terminals are appended after the decisions so a decision's id is stable.
    const id = -(terminals.length + 1);
    terminals.push(result);
    return id;
  };

  const root = walk(0, []);
  return { root: root.id, nodes, terminals, config, order };
}

/**
 * What each seat has put in, and what is dead, at a terminal.
 *
 * Antes are dead money with no owner. A blind that folds forfeits what it
 * posted. Everyone all-in has put in the same amount, which is what makes the
 * pot flat.
 */
export function potAt(config, live) {
  const { players } = config;
  const ante = units(config.ante);
  // `stack` is what is behind once the ante is posted, so it is the whole of
  // what a shove puts in.
  const allIn = units(config.stack);
  const inFor = new Int32Array(players);
  let pot = ante * players;
  for (const seat of live) {
    inFor[seat] = allIn;
    pot += allIn;
  }
  // A blind that folded still loses what it posted.
  const blinds = [units(config.smallBlind), units(config.bigBlind)];
  for (let seat = 0; seat < Math.min(2, players); seat += 1) {
    if (inFor[seat] === 0) pot += blinds[seat];
  }
  return { pot, inFor, allIn };
}

/**
 * Monte Carlo CFR with external sampling, over the 169 classes.
 *
 * The same shape as `lib/solve.js`, and deliberately its own file: that solver
 * knows about draws and rollouts and a hand abstraction with a few hundred
 * buckets, and none of it applies. Discounted CFR is the default here because
 * the tree is tiny and the only thing worth tuning is how fast a dominated
 * shove gets buried.
 */
export class PushFoldSolver {
  constructor(options = {}) {
    this.config = pushFoldConfig(options.config);
    this.tree = buildPushFoldTree(this.config);
    this.players = this.config.players;
    this.names = positionNames(this.players);
    this.rng = makeRng(options.seed ?? 1);
    this.deck = freshDeck();
    this.iterations = 0;

    this.discount = options.algorithm === 'cfr+'
      ? null
      : { ...DCFR_DEFAULTS, ...(options.discount ?? {}) };
    this.weight = 1;

    const count = this.tree.nodes.length;
    this.regret = new Array(count).fill(null);
    this.average = new Array(count).fill(null);
    this.evSum = new Array(count).fill(null);
    this.evHits = new Array(count).fill(null);

    // Scratch, so an iteration allocates nothing.
    this.classes = new Int32Array(this.players);
    this.ranks = new Int32Array(this.players);
    this.seven = new Array(7);
  }

  store(which, id) {
    let block = which[id];
    if (!block) {
      block = new Float64Array(HAND_CLASS_COUNT * 2);
      which[id] = block;
    }
    return block;
  }

  strategyAt(id, hand) {
    const regrets = this.regret[id];
    const out = new Float64Array(2);
    if (!regrets) return out.fill(0.5);
    const base = hand * 2;
    const a = Math.max(regrets[base], 0);
    const b = Math.max(regrets[base + 1], 0);
    const total = a + b;
    if (total <= 0) return out.fill(0.5);
    out[0] = a / total;
    out[1] = b / total;
    return out;
  }

  /** The average strategy, which is what converges and what gets read. */
  averageAt(id, hand) {
    const block = this.average[id];
    const out = new Float64Array(2);
    if (!block) return out.fill(0.5);
    const base = hand * 2;
    const total = block[base] + block[base + 1];
    if (total <= 0) return out.fill(0.5);
    out[0] = block[base] / total;
    out[1] = block[base + 1] / total;
    return out;
  }

  evAt(id, hand) {
    const sum = this.evSum[id];
    const hits = this.evHits[id];
    if (!sum || !hits || !hits[hand]) return null;
    return sum[hand] / hits[hand];
  }

  /** Who wins, and what each seat's stack change is, at a terminal. */
  payoffs(result, traverser) {
    const { config } = this;
    const { inFor, pot } = potAt(config, result.live);
    const ante = units(config.ante);
    let mine = -ante - inFor[traverser];
    // A blind that did not get all-in still loses what it posted.
    if (traverser < 2 && inFor[traverser] === 0) {
      mine -= traverser === 0 ? units(config.smallBlind) : units(config.bigBlind);
    }

    // Folded round to the big blind: it gets back its own blind and takes
    // everybody's ante and the small blind with it.
    if (result.kind === 'walkover') {
      return traverser === result.winner ? mine + pot : mine;
    }
    if (!result.live.includes(traverser)) return mine;
    if (result.live.length === 1) return mine + pot;

    // A showdown: best hand takes it, split on a tie.
    let best = -1;
    let winners = 0;
    for (const seat of result.live) {
      if (this.ranks[seat] > best) {
        best = this.ranks[seat];
        winners = 1;
      } else if (this.ranks[seat] === best) {
        winners += 1;
      }
    }
    if (this.ranks[traverser] === best) return mine + pot / winners;
    return mine;
  }

  /**
   * One player's pass over the whole tree, for one deal.
   *
   * The cards are sampled and the betting is not. External sampling - picking
   * one action for each opponent - is what the 2-7 solver has to do, because
   * its tree is half a million nodes and walking it per deal is not on the
   * table. Here the tree is 126 nodes, and walking all of it costs a fraction
   * of what evaluating seven hold'em hands already costs.
   *
   * It buys the thing sampling cannot give: **every decision sees every deal.**
   * Under sampling, a seat's opening decision is only reached when everyone
   * before it happens to fold, so the small blind's opening range trains on
   * about a tenth of the hands the first seat's does, and comes out that much
   * noisier. That showed up as a better kicker shoving less often than a worse
   * one, which is not a strategy, it is a sample size.
   *
   * `mine` and `theirs` are the reach probabilities that make this ordinary
   * CFR: regret is weighted by how likely the opponents were to let us get
   * here, and the average strategy by how likely we were to play into it.
   */
  traverse(id, traverser, mine, theirs) {
    if (id < 0) return this.payoffs(this.tree.terminals[-id - 1], traverser);
    const node = this.tree.nodes[id];
    const hand = this.classes[node.seat];
    const strategy = this.strategyAt(id, hand);
    const base = hand * 2;

    if (node.seat !== traverser) {
      // Somebody else's decision: take both, weighted by what they would do.
      const foldValue = strategy[0] > 0
        ? this.traverse(node.actions[FOLD].child, traverser, mine, theirs * strategy[0]) : 0;
      const shoveValue = strategy[1] > 0
        ? this.traverse(node.actions[SHOVE].child, traverser, mine, theirs * strategy[1]) : 0;
      return strategy[0] * foldValue + strategy[1] * shoveValue;
    }

    const foldValue = this.traverse(node.actions[FOLD].child, traverser, mine * strategy[0], theirs);
    const shoveValue = this.traverse(node.actions[SHOVE].child, traverser, mine * strategy[1], theirs);
    const value = strategy[0] * foldValue + strategy[1] * shoveValue;

    // The average strategy is what converges, and it is weighted by how often
    // this seat actually plays its way here.
    const block = this.store(this.average, id);
    block[base] += this.weight * mine * strategy[0];
    block[base + 1] += this.weight * mine * strategy[1];

    const regrets = this.store(this.regret, id);
    const floor = this.discount === null;
    const updatedFold = regrets[base] + theirs * (foldValue - value);
    const updatedShove = regrets[base + 1] + theirs * (shoveValue - value);
    regrets[base] = updatedFold > 0 || !floor ? updatedFold : 0;
    regrets[base + 1] = updatedShove > 0 || !floor ? updatedShove : 0;

    this.store(this.evSum, id)[hand] += value;
    this.store(this.evHits, id)[hand] += 1;
    return value;
  }

  run(iterations, onProgress) {
    const { players } = this;
    const needed = players * 2 + 5;
    for (let i = 0; i < iterations; i += 1) {
      deal(this.deck, needed, this.rng);
      for (let seat = 0; seat < players; seat += 1) {
        this.classes[seat] = handClass(this.deck[seat * 2], this.deck[seat * 2 + 1]);
      }
      // One board for the table, which is what makes hands correlated.
      const boardAt = players * 2;
      for (let seat = 0; seat < players; seat += 1) {
        this.seven[0] = this.deck[seat * 2];
        this.seven[1] = this.deck[seat * 2 + 1];
        for (let k = 0; k < 5; k += 1) this.seven[2 + k] = this.deck[boardAt + k];
        this.ranks[seat] = best7(this.seven);
      }

      this.iterations += 1;
      const t = this.discount ? Math.floor(this.iterations / this.discount.every) + 1 : this.iterations;
      this.weight = this.discount ? t ** this.discount.gamma : this.iterations;

      for (let seat = 0; seat < players; seat += 1) this.traverse(this.tree.root, seat, 1, 1);

      if (this.discount && this.iterations % this.discount.every === 0) {
        discountRegrets(this.regret, this.iterations / this.discount.every, this.discount);
      }
      if (onProgress) onProgress(this);
    }
    return this;
  }

  /** Where a seat decides whether to open-shove, everyone before it folding. */
  openingNode(seat) {
    let id = this.tree.root;
    for (let guard = 0; guard < this.players * 2; guard += 1) {
      const node = this.tree.nodes[id];
      if (!node) return -1;
      if (node.seat === seat) return id;
      id = node.actions[FOLD].child;
      if (id < 0) return -1;
    }
    return -1;
  }

  /** How much of all hands a node shoves, weighted by how many combos each is. */
  frequency(id) {
    let plays = 0;
    let total = 0;
    for (let hand = 0; hand < HAND_CLASS_COUNT; hand += 1) {
      const combos = HAND_CLASS_COMBOS[hand];
      plays += combos * this.averageAt(id, hand)[SHOVE];
      total += combos;
    }
    return 100 * plays / total;
  }
}
