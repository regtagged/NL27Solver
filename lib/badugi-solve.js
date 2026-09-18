/**
 * Badugi, solved whole.
 *
 * Monte Carlo CFR over the fixed-limit triple draw tree, with the draw as a
 * decision rather than a policy, and **no hand abstraction at all**: the solver
 * runs on the 1,092 distinct four-card values, which is every hand badugi has.
 * That is the point of doing this game - everywhere else in this repo a strange
 * answer could be the abstraction talking, and here it cannot be.
 *
 * ## What one deal contains
 *
 * Four cards a seat, then the replacements a seat could need across three
 * draws, all dealt before the walk. Branches of one iteration therefore compare
 * against the same future rather than each drawing its own, which is the whole
 * reason the cards come out in advance. Three-handed at a 2,1,1 ceiling that is
 * twenty-four cards of fifty-two.
 *
 * ## Which cards a draw throws
 *
 * Deciding *how many* to draw is the strategy; deciding *which* is not, and is
 * settled here: keep the subset of that size whose own badugi is best. Keeping
 * three from a hand whose best badugi is two means keeping a dead card, which
 * the scoring already rates as bad, so nothing needs special-casing.
 */

import { freshDeck, makeRng, deal } from './cards.js';
import { badugiTable, score, handIndex } from './badugi.js';
import { discountRegrets, DCFR_DEFAULTS } from './solve.js';
import {
  buildTree, drawActionsFor, positionNames, DRAWING, POST_DRAW, FOLDED, BB,
} from './tree.js';

// Deep enough for four betting rounds and three draws at any seat count the
// deck can deal, and wide enough for the most actions a node ever offers.
const MAX_DEPTH = 256;
const MAX_ACTIONS = 8;

/** Every subset of four cards, as index lists, grouped by how many it keeps. */
const SUBSETS = (() => {
  const bySize = [[], [], [], [], []];
  for (let mask = 0; mask < 16; mask += 1) {
    const pick = [];
    for (let i = 0; i < 4; i += 1) if (mask & (1 << i)) pick.push(i);
    bySize[pick.length].push(pick);
  }
  return bySize;
})();

/**
 * The cards to keep when drawing `drawing` of them.
 *
 * Scored by what the kept cards are worth as a badugi in their own right, which
 * is the same comparison the showdown uses, so a keep is never rated by a rule
 * the game does not have.
 */
export function keepFor(cards, drawing, into) {
  const keeping = 4 - drawing;
  let best = Infinity;
  let bestAt = null;
  for (const pick of SUBSETS[keeping]) {
    // Score the subset by padding it out - a shorter hand is scored as itself.
    const held = pick.map((i) => cards[i]);
    const value = score(held.length ? held : [cards[0]]);
    if (value < best) { best = value; bestAt = pick; }
  }
  for (let i = 0; i < keeping; i += 1) into[i] = cards[bestAt[i]];
  return keeping;
}

export class BadugiSolver {
  constructor(options = {}) {
    this.config = options.config;
    this.players = this.config.players;
    this.names = positionNames(this.players);
    this.rounds = this.config.drawRounds ?? 3;

    const { table, count, combos, labels } = badugiTable();
    this.handTable = table;
    this.handCount = count;
    this.handCombos = combos;
    this.handLabels = labels;

    this.rng = makeRng(options.seed ?? 1);
    this.deck = freshDeck();
    this.iterations = 0;
    this.discount = options.algorithm === 'cfr+'
      ? null
      : { ...DCFR_DEFAULTS, ...(options.discount ?? {}) };
    this.weight = 1;
    this.explore = options.explore ?? 0;
    // The EV tables are what the viewer's per-hand price column reads. They are
    // another random write into another big block at every visit, so a solve
    // that is only after the strategy can leave them out: 11% of the time and
    // a quarter of the memory.
    this.trackEv = options.trackEv !== false;

    // How many a seat may take each round, which is what makes the big blind's
    // ceiling different from everybody else's.
    this.ceilings = [];
    for (let seat = 0; seat < this.players; seat += 1) {
      const rounds = [];
      for (let round = 0; round < this.rounds; round += 1) {
        rounds.push(drawActionsFor(this.config, round, seat).map((a) => a.option));
      }
      this.ceilings.push(rounds);
    }

    // The deck's layout: hole cards, then each seat's replacements.
    this.reserveAt = new Int32Array(this.players);
    let at = this.players * 4;
    this.reserveSize = new Int32Array(this.players);
    this.roundOffset = [];
    for (let seat = 0; seat < this.players; seat += 1) {
      this.reserveAt[seat] = at;
      const offsets = [];
      let size = 0;
      for (let round = 0; round < this.rounds; round += 1) {
        offsets.push(size);
        size += Math.max(...this.ceilings[seat][round]);
      }
      this.roundOffset.push(offsets);
      this.reserveSize[seat] = size;
      at += size;
    }
    this.cardsNeeded = at;
    // Checked before the tree is built, because a configuration the deck
    // cannot deal is one nobody should wait for a tree to find out about.
    if (this.cardsNeeded > 52) {
      throw new Error(`A deal wants ${this.cardsNeeded} cards; the deck has 52.`);
    }

    this.tree = buildTree(this.config);
    this.nodes = this.tree.nodes;

    const count2 = this.nodes.length;
    this.regret = new Array(count2).fill(null);
    this.average = new Array(count2).fill(null);
    this.evSum = new Array(count2).fill(null);
    this.evHits = new Array(count2).fill(null);
    this.bytes = 0;

    // Terminals, priced once: who put in what, and who is still in.
    this.paidAt = new Array(count2).fill(null);
    this.foldedAt = new Array(count2).fill(null);
    this.potAt = new Float64Array(count2);
    const start = Math.round(this.config.stack * BB);
    for (const node of this.nodes) {
      if (node.kind !== 'fold' && node.kind !== 'showdown') continue;
      const paid = new Float64Array(this.players);
      const folded = new Uint8Array(this.players);
      let pot = 0;
      for (let seat = 0; seat < this.players; seat += 1) {
        paid[seat] = start - node.state.stack[seat];
        folded[seat] = node.state.status[seat] === FOLDED ? 1 : 0;
        pot += paid[seat];
      }
      this.paidAt[node.id] = paid;
      this.foldedAt[node.id] = folded;
      this.potAt[node.id] = pot;
    }

    // Scratch for the walk. A node visit used to allocate two arrays - the
    // strategy and the values of its actions - and at a million visits a second
    // that is all the time there is. One buffer per depth costs nothing and the
    // walk never allocates.
    this.strategyScratch = [];
    this.valueScratch = [];
    for (let depth = 0; depth < MAX_DEPTH; depth += 1) {
      this.strategyScratch.push(new Float64Array(MAX_ACTIONS));
      this.valueScratch.push(new Float64Array(MAX_ACTIONS));
    }

    // Scratch. A draw sequence is packed radix six, so a seat's hand after any
    // history is one lookup.
    this.handAfter = new Int32Array(this.players * 216).fill(-1);
    this.valueAfter = new Float64Array(this.players * 216);
    this.drawn = new Int8Array(this.players * this.rounds).fill(-1);
    this.keep = new Array(4);
  }

  /**
   * Where a seat's history so far sits in its table.
   *
   * Keyed on how many draws have happened as well as what they were, so that a
   * seat which has drawn once and one which has drawn twice never collide -
   * "pat" then nothing is a different hand from "pat" then "pat".
   */
  slotFor(seat) {
    const base = seat * this.rounds;
    let depth = 0;
    let packed = 0;
    for (let round = 0; round < this.rounds; round += 1) {
      const taken = this.drawn[base + round];
      if (taken < 0) break;
      packed = packed * 6 + taken;
      depth += 1;
    }
    return depth * 36 + packed;
  }

  /** Every hand a seat could be holding, for every draw history it could have. */
  prepareSeat(seat) {
    const base = seat * 216;
    this.handAfter.fill(-1, base, base + 216);
    const hole = [];
    for (let i = 0; i < 4; i += 1) hole.push(this.deck[seat * 4 + i]);

    const walk = (round, cards, depth, packed) => {
      const slot = base + depth * 36 + packed;
      const sorted = [...cards].sort((x, y) => x - y);
      this.handAfter[slot] = handIndex(sorted);
      this.valueAfter[slot] = score(cards);
      if (round >= this.rounds) return;
      for (const option of this.ceilings[seat][round]) {
        const next = cards.slice();
        if (option > 0) {
          const kept = keepFor(cards, option, this.keep);
          for (let i = 0; i < kept; i += 1) next[i] = this.keep[i];
          const from = this.reserveAt[seat] + this.roundOffset[seat][round];
          for (let i = 0; i < option; i += 1) next[kept + i] = this.deck[from + i];
        }
        walk(round + 1, next, depth + 1, packed * 6 + option);
      }
    };
    walk(0, hole, 0, 0);
  }

  store(which, nodeId, actions) {
    let block = which[nodeId];
    if (!block) {
      block = new Float32Array(this.handCount * actions);
      which[nodeId] = block;
      this.bytes += block.byteLength;
    }
    return block;
  }

  /** Regret matching into a buffer the caller owns, so the walk allocates none. */
  fillStrategy(nodeId, hand, actions, out) {
    const regrets = this.regret[nodeId];
    const share = 1 / actions;
    if (!regrets) {
      for (let a = 0; a < actions; a += 1) out[a] = share;
      return;
    }
    const base = hand * actions;
    let total = 0;
    for (let a = 0; a < actions; a += 1) {
      const value = regrets[base + a];
      const positive = value > 0 ? value : 0;
      out[a] = positive;
      total += positive;
    }
    if (total <= 0) {
      for (let a = 0; a < actions; a += 1) out[a] = share;
      return;
    }
    for (let a = 0; a < actions; a += 1) out[a] /= total;
  }

  /** The same, for callers outside the walk, where one array does not matter. */
  strategyAt(nodeId, hand) {
    const actions = this.nodes[nodeId].actions.length;
    const out = new Float64Array(actions);
    this.fillStrategy(nodeId, hand, actions, out);
    return out;
  }

  averageAt(nodeId, hand) {
    const node = this.nodes[nodeId];
    const actions = node.actions.length;
    const out = new Float64Array(actions);
    const block = this.average[nodeId];
    if (!block) return out.fill(1 / actions);
    const base = hand * actions;
    let total = 0;
    for (let a = 0; a < actions; a += 1) total += block[base + a];
    if (total <= 0) return out.fill(1 / actions);
    for (let a = 0; a < actions; a += 1) out[a] = block[base + a] / total;
    return out;
  }

  evAt(nodeId, hand) {
    const sum = this.evSum[nodeId];
    const hits = this.evHits[nodeId];
    if (!sum || !hits || !hits[hand]) return null;
    return sum[hand] / hits[hand];
  }

  /** What the traverser takes home at a terminal. */
  payoff(node, traverser) {
    const paid = this.paidAt[node.id];
    const folded = this.foldedAt[node.id];
    if (node.kind === 'fold') {
      // One player left, and it is whoever has not folded.
      for (let seat = 0; seat < this.players; seat += 1) {
        if (!folded[seat]) {
          return seat === traverser ? this.potAt[node.id] - paid[seat] : -paid[traverser];
        }
      }
      return -paid[traverser];
    }
    // A showdown: lowest badugi value wins, split on a tie.
    let best = Infinity;
    let winners = 0;
    for (let seat = 0; seat < this.players; seat += 1) {
      if (folded[seat]) continue;
      const value = this.valueAfter[seat * 216 + this.slotFor(seat)];
      if (value < best) { best = value; winners = 1; } else if (value === best) winners += 1;
    }
    const mine = this.valueAfter[traverser * 216 + this.slotFor(traverser)];
    if (!folded[traverser] && mine === best) {
      return this.potAt[node.id] / winners - paid[traverser];
    }
    return -paid[traverser];
  }

  traverse(nodeId, traverser, depth = 0) {
    const node = this.nodes[nodeId];
    if (node.kind !== 'decision') return this.payoff(node, traverser);

    const seat = node.seat;
    const hand = this.handTable[this.handAfter[seat * 216 + this.slotFor(seat)]];
    const actions = node.actions.length;
    const strategy = this.strategyScratch[depth];
    this.fillStrategy(nodeId, hand, actions, strategy);
    const drawing = node.street === DRAWING;
    const base = hand * actions;

    if (seat !== traverser) {
      const block = this.store(this.average, nodeId, actions);
      for (let a = 0; a < actions; a += 1) block[base + a] += this.weight * strategy[a];
      let picked = -1;
      if (this.explore > 0 && this.rng() < this.explore) {
        picked = Math.floor(this.rng() * actions);
      } else {
        let roll = this.rng();
        for (let a = 0; a < actions; a += 1) {
          roll -= strategy[a];
          if (roll < 0) { picked = a; break; }
        }
      }
      if (picked < 0) picked = actions - 1;
      return this.descend(node, picked, traverser, seat, drawing, depth);
    }

    const values = this.valueScratch[depth];
    let value = 0;
    for (let a = 0; a < actions; a += 1) {
      values[a] = this.descend(node, a, traverser, seat, drawing, depth);
      value += strategy[a] * values[a];
    }

    const regrets = this.store(this.regret, nodeId, actions);
    const floor = this.discount === null;
    for (let a = 0; a < actions; a += 1) {
      const updated = regrets[base + a] + (values[a] - value);
      regrets[base + a] = updated > 0 || !floor ? updated : 0;
    }
    if (this.trackEv) {
      this.store(this.evSum, nodeId, 1)[hand] += value;
      this.store(this.evHits, nodeId, 1)[hand] += 1;
    }
    return value;
  }

  /** One action, remembering and then forgetting what it drew. */
  descend(node, action, traverser, seat, drawing, depth) {
    if (!drawing) return this.traverse(node.actions[action].child, traverser, depth + 1);
    const at = seat * this.rounds + this.roundOf(node);
    const before = this.drawn[at];
    this.drawn[at] = node.actions[action].option;
    const value = this.traverse(node.actions[action].child, traverser, depth + 1);
    this.drawn[at] = before;
    return value;
  }

  /** Which draw a node belongs to: the first round this seat has not drawn. */
  roundOf(node) {
    const base = node.seat * this.rounds;
    for (let round = 0; round < this.rounds; round += 1) {
      if (this.drawn[base + round] < 0) return round;
    }
    return this.rounds - 1;
  }

  run(iterations, onProgress) {
    for (let i = 0; i < iterations; i += 1) {
      deal(this.deck, this.cardsNeeded, this.rng);
      this.drawn.fill(-1);
      for (let seat = 0; seat < this.players; seat += 1) this.prepareSeat(seat);

      this.iterations += 1;
      const t = this.discount
        ? Math.floor(this.iterations / this.discount.every) + 1
        : this.iterations;
      this.weight = this.discount ? t ** this.discount.gamma : this.iterations;

      for (let seat = 0; seat < this.players; seat += 1) {
        this.drawn.fill(-1);
        this.traverse(this.tree.root, seat, 0);
      }
      if (this.discount && this.iterations % this.discount.every === 0) {
        discountRegrets(this.regret, this.iterations / this.discount.every, this.discount);
      }
      if (onProgress) onProgress(this);
    }
    return this;
  }

  /** Where a seat first acts, everyone before it folding. */
  openingNode(seat) {
    let id = this.tree.root;
    for (let guard = 0; guard < this.players * 4; guard += 1) {
      const node = this.nodes[id];
      if (!node || node.kind !== 'decision') return -1;
      if (node.seat === seat) return id;
      const fold = node.actions.find((a) => a.kind === 'fold');
      if (!fold) return -1;
      id = fold.child;
    }
    return -1;
  }

  /** How much of all hands a node does something other than fold. */
  frequency(nodeId) {
    const node = this.nodes[nodeId];
    const fold = node.actions.findIndex((a) => a.kind === 'fold');
    let plays = 0;
    let total = 0;
    for (let hand = 0; hand < this.handCount; hand += 1) {
      const mix = this.averageAt(nodeId, hand);
      let on = 0;
      for (let a = 0; a < mix.length; a += 1) if (a !== fold) on += mix[a];
      plays += this.handCombos[hand] * on;
      total += this.handCombos[hand];
    }
    return 100 * plays / total;
  }

  memory() {
    return this.bytes;
  }
}
