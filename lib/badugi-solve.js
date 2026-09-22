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
import {
  badugiTable, score, handIndex, lowRank, suitOf as badugiSuit,
} from './badugi.js';
import { discountRegrets, DCFR_DEFAULTS } from './solve.js';
import {
  buildTree, tripleDrawConfig, drawActionsFor, positionNames,
  DRAWING, POST_DRAW, FOLDED, BB,
} from './tree.js';

/**
 * The game every badugi script solves, so that a strategy and the measurement
 * of it are never describing two different games.
 *
 * `maxToDraw` is the cap on how many seats may voluntarily enter, and it is
 * what decides whether a seat count fits at all: six-handed uncapped is over
 * six million nodes, and capped at two it is 534,848. Heads-up and three-handed
 * there is nothing to cap, so it stays off and the game is the whole game.
 * `npm run measure:badugi` prints what every other prune is worth beside it.
 */
export function badugiConfig({ players = 2, maxToDraw, ...overrides } = {}) {
  return tripleDrawConfig({
    players,
    allowLimp: false,
    coldCallSeats: ['BTN', 'BB'],
    coldCallThreeBets: false,
    maxToDraw: maxToDraw === undefined ? (players > 3 ? 2 : null) : maxToDraw,
    maxDraw: [2, 1, 1],
    maxDrawBySeat: { BB: [3, 1, 1] },
    limit: { smallBet: 1, bigBet: 2, bigBetFrom: 2, cap: 3 },
    nodeLimit: 9e6,
    ...overrides,
  });
}

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
 * How much a keep can still become, for breaking a tie between equal keeps.
 *
 * Distinct suits first, then distinct ranks. A badugi grows by adding a card
 * that clashes with nothing it already holds, so a keep covering three suits
 * has more ways to improve than one covering two - **even when the extra card
 * plays no part in the hand's current value.**
 *
 * That is what makes this worth doing rather than arbitrary. Holding
 * A♥ 3♦ A♦ 3♠ every keep of three is a two-card A-3, so `score` cannot choose
 * between them. But A♥ A♦ 3♠ covers hearts, diamonds and spades, and either
 * ace can play, so 33 cards make it a tri; A♥ 3♦ A♦ covers only two suits and
 * 22 do. The duplicate ace is dead to the hand's value and live to its future.
 */
function reach(held) {
  let suits = 0;
  let ranks = 0;
  for (let i = 0; i < held.length; i += 1) {
    suits |= 1 << badugiSuit(held[i]);
    ranks |= 1 << lowRank(held[i]);
  }
  // Suits dominate: four is the most a rank count can add, so it can never
  // outvote a suit.
  return bits(suits) * 5 + bits(ranks);
}

const bits = (mask) => {
  let n = 0;
  for (let m = mask; m; m &= m - 1) n += 1;
  return n;
};

/**
 * The cards to keep when drawing `drawing` of them.
 *
 * Scored by what the kept cards are worth as a badugi in their own right, which
 * is the same comparison the showdown uses, so a keep is never rated by a rule
 * the game does not have. **Measured, that rule is never wrong when the scores
 * differ** - over 4,000 random hands drawing one, the lowest-scoring keep was
 * also the best draw every time two keeps scored differently.
 *
 * What it could not do is break a tie, and ties are common: 18% of hands
 * drawing one have two keeps of equal value and unequal future, because a card
 * that is dead to the hand's value can still cover a suit. Taking the first
 * such keep in subset order cost 1.9 rank places of 1,092 on average and up to
 * 50; breaking by `reach` costs 0.4. The exact tie-break - playing all 48
 * unseen cards out for every candidate - would cost nothing and is fifty times
 * the work at a point the walk reaches millions of times, so this is the
 * cheap 79% of it.
 */
export function keepFor(cards, drawing, into) {
  const keeping = 4 - drawing;
  let best = Infinity;
  let bestReach = -1;
  let bestAt = null;
  for (const pick of SUBSETS[keeping]) {
    // Score the subset by padding it out - a shorter hand is scored as itself.
    const held = pick.map((i) => cards[i]);
    const value = score(held.length ? held : [cards[0]]);
    if (value > best) continue;
    const spread = reach(held);
    if (value < best || spread > bestReach) {
      best = value;
      bestReach = spread;
      bestAt = pick;
    }
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

    // A subgame: the state to build from, and therefore who is still in it.
    //
    // This is what makes the interesting spots affordable. A seat that has
    // already folded never draws, so reserving replacements for it is what puts
    // a 3,2,2 ceiling over the 52 cards there are - six-handed that reservation
    // is 42 cards for four seats who will not use one. Live seats only, and the
    // same ceiling costs 14.
    //
    // Hole cards are still dealt to everybody. The folded seats' cards are gone
    // from the deck at a real table whatever they were, and dealing them keeps
    // that removal rather than handing those cards back to the two players who
    // are still in.
    this.from = options.from ?? null;
    this.live = [];
    for (let seat = 0; seat < this.players; seat += 1) {
      if (!this.from || this.from.status[seat] !== FOLDED) this.live.push(seat);
    }

    // The deck's layout: hole cards, then each live seat's replacements.
    this.reserveAt = new Int32Array(this.players);
    let at = this.players * 4;
    this.reserveSize = new Int32Array(this.players);
    this.roundOffset = [];
    for (let seat = 0; seat < this.players; seat += 1) {
      this.reserveAt[seat] = at;
      const offsets = [];
      let size = 0;
      const plays = this.live.includes(seat);
      for (let round = 0; round < this.rounds; round += 1) {
        offsets.push(size);
        if (plays) size += Math.max(...this.ceilings[seat][round]);
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

    /**
     * Hands the seats that have already acted are allowed to hold.
     *
     * `{ seat: Uint8Array }` over the 1,092 values, one meaning the hand is in
     * that seat's range. **A subgame without this is the wrong game**: built
     * after the button opens, it would have the big blind defending against a
     * button holding anything at all, and the answer would look perfectly
     * reasonable. Deals are rejected until every preset seat holds something
     * its range contains, which keeps card removal exact - the alternative,
     * drawing a hand from the range and then the rest of the deck around it,
     * does not.
     */
    /**
     * Decisions held to a fixed strategy while everything else solves.
     *
     * `{ [nodeId]: { applies: Uint8Array(hands), mix: Float32Array(hands x actions) } }`
     * - null when nothing is locked, which is the common case and is checked
     * before anything else in `fillStrategy`, so an ordinary solve pays one
     * null test for the feature.
     *
     * A locked decision still *accumulates* an average, and it accumulates the
     * lock, so a report of a locked solve shows what was imposed rather than
     * what would have been chosen. That is the honest thing for it to show.
     */
    this.locks = options.locks ?? null;

    this.presetRanges = options.presetRanges ?? null;
    this.presetSeats = this.presetRanges ? Object.keys(this.presetRanges).map(Number) : [];
    this.rejected = 0;
    this.preallocated = false;

    this.tree = buildTree(this.config, this.from);
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
    //
    // The stride has to be `6 ** rounds` and not less. A history of `depth`
    // draws packs to a number below `6 ** depth`, so the deepest one alone
    // needs the full width, and the table holds one such block per depth:
    // "pat" then nothing has to be a different slot from "pat" then "pat".
    //
    // This was `depth * 36 + packed` in a 216-wide block, which is only wide
    // enough while no seat draws more than two. The big blind may draw three,
    // and 3-1-1 packs to 115, which at depth three addresses slot 223 - past
    // the end of its own block and into the next seat's hand, or off the end of
    // the array entirely for the last seat. Every read of that slot was another
    // seat's hand or `undefined`, silently, on the one line the exception
    // exists to model.
    this.packStride = 6 ** this.rounds;
    this.slotsPerSeat = (this.rounds + 1) * this.packStride;
    this.handAfter = new Int32Array(this.players * this.slotsPerSeat).fill(-1);
    this.valueAfter = new Float64Array(this.players * this.slotsPerSeat);
    this.drawn = new Int8Array(this.players * this.rounds).fill(-1);
    this.keep = new Array(4);

    // Opt-in, because the tables are gigabytes and a test that solves a few
    // hundred iterations over a small tree wants the lazy path. `shared` is
    // either `true` to lay them out here, or another solver's buffers to solve
    // into the same memory from another thread.
    if (options.shared) {
      this.allocateTables(options.shared === true ? null : options.shared);
    }
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
    return depth * this.packStride + packed;
  }

  /** Every hand a seat could be holding, for every draw history it could have. */
  prepareSeat(seat) {
    const base = seat * this.slotsPerSeat;
    this.handAfter.fill(-1, base, base + this.slotsPerSeat);
    const hole = [];
    for (let i = 0; i < 4; i += 1) hole.push(this.deck[seat * 4 + i]);

    const walk = (round, cards, depth, packed) => {
      const slot = base + depth * this.packStride + packed;
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

  /**
   * Lays the strategy tables out in one block of memory, shared or not.
   *
   * Two things follow from this that lazy allocation cannot give. The blocks
   * can live in a `SharedArrayBuffer`, so several threads solve into the *same*
   * tables - which is what makes this one solve going faster rather than N
   * solves that cannot be added up, because CFR's regrets do not combine across
   * runs. And nothing allocates during the walk, which is worth having on its
   * own: the first few thousand iterations of a lazy run go at a third of the
   * settled rate, all of it in the allocator.
   *
   * The layout is by node id, width `hands x actions`, which is exactly what
   * `store` handed out before - so `traverse` and `fillStrategy` see the same
   * Float32Arrays they always did and do not change.
   */
  allocateTables(shared = null) {
    const widths = new Int32Array(this.nodes.length);
    const offsets = new Float64Array(this.nodes.length);
    let floats = 0;
    for (const node of this.nodes) {
      if (node.kind !== 'decision') continue;
      widths[node.id] = this.handCount * node.actions.length;
      offsets[node.id] = floats;
      floats += widths[node.id];
    }
    this.tableFloats = floats;
    this.tableOffsets = offsets;

    const make = () => (typeof SharedArrayBuffer === 'function'
      ? new SharedArrayBuffer(floats * 4)
      : new ArrayBuffer(floats * 4));
    this.buffers = {
      regret: shared?.regret ?? make(),
      average: shared?.average ?? make(),
    };
    for (const layer of ['regret', 'average']) {
      const buffer = this.buffers[layer];
      if (buffer.byteLength !== floats * 4) {
        throw new Error(`a ${layer} buffer of ${buffer.byteLength} bytes cannot hold ${floats * 4}`);
      }
      for (const node of this.nodes) {
        if (node.kind !== 'decision') continue;
        this[layer][node.id] = new Float32Array(buffer, offsets[node.id] * 4, widths[node.id]);
      }
    }
    this.bytes = floats * 8;
    this.preallocated = true;
    return this.buffers;
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
    // A locked decision plays what it was told to, and the rest of the tree
    // solves against it. That is what makes "what if the blind three-bet every
    // badugi" answerable rather than arguable: the button gets to adapt, which
    // is the half of the question a fixed strategy on both sides cannot see.
    if (this.locks !== null) {
      const lock = this.locks[nodeId];
      if (lock && lock.applies[hand]) {
        const base = hand * actions;
        for (let a = 0; a < actions; a += 1) out[a] = lock.mix[base + a];
        return;
      }
    }

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
      const value = this.valueAfter[seat * this.slotsPerSeat + this.slotFor(seat)];
      if (value < best) { best = value; winners = 1; } else if (value === best) winners += 1;
    }
    const mine = this.valueAfter[traverser * this.slotsPerSeat + this.slotFor(traverser)];
    if (!folded[traverser] && mine === best) {
      return this.potAt[node.id] / winners - paid[traverser];
    }
    return -paid[traverser];
  }

  traverse(nodeId, traverser, depth = 0) {
    const node = this.nodes[nodeId];
    if (node.kind !== 'decision') return this.payoff(node, traverser);

    const seat = node.seat;
    const hand = this.handTable[this.handAfter[seat * this.slotsPerSeat + this.slotFor(seat)]];
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

  /** The value of a seat's four hole cards, before it has drawn anything. */
  holeValue(seat) {
    const at = seat * 4;
    return this.handTable[handIndex([
      this.deck[at], this.deck[at + 1], this.deck[at + 2], this.deck[at + 3],
    ])];
  }

  /** Deals until every seat with a preset range holds a hand inside it. */
  dealWithinRanges(rng) {
    for (let tries = 0; tries < 10000; tries += 1) {
      deal(this.deck, this.cardsNeeded, rng);
      let ok = true;
      for (const seat of this.presetSeats) {
        if (!this.presetRanges[seat][this.holeValue(seat)]) { ok = false; break; }
      }
      if (ok) return;
      this.rejected += 1;
    }
    throw new Error('a preset range is too narrow to deal in ten thousand tries');
  }

  /**
   * One deal and everything that follows from it: the cards, the draw history
   * cleared, and each live seat's hand for every draw history it could have.
   *
   * Takes the generator rather than using its own, so that a measurement can
   * replay the same deals from a seed while the solve goes on using another -
   * and so that both get the preset ranges and the live-seat layout without a
   * second copy of either. A best response dealing its own cards is how a
   * measurement ends up describing a different game from the solve.
   */
  dealHands(rng = this.rng) {
    if (this.presetSeats.length) this.dealWithinRanges(rng);
    else deal(this.deck, this.cardsNeeded, rng);
    this.drawn.fill(-1);
    for (const seat of this.live) this.prepareSeat(seat);
  }

  /**
   * Iterations with no discount step and no progress callback, for a worker.
   *
   * `at` is the *solve's* iteration count, not this thread's. The averaging
   * weight is `t^gamma` over how far the solve has got, so a worker computing
   * it from its own count would weight its contributions as though the run had
   * only just started - eight threads each thinking they were the whole solve,
   * and an average that never settles.
   */
  runBatch(iterations, at = this.iterations) {
    this.iterations = at;
    for (let i = 0; i < iterations; i += 1) {
      this.dealHands();
      this.iterations += 1;
      const t = this.discount
        ? Math.floor(this.iterations / this.discount.every) + 1
        : this.iterations;
      this.weight = this.discount ? t ** this.discount.gamma : this.iterations;
      for (const seat of this.live) {
        this.drawn.fill(-1);
        this.traverse(this.tree.root, seat, 0);
      }
    }
    return this;
  }

  run(iterations, onProgress) {
    for (let i = 0; i < iterations; i += 1) {
      this.dealHands();

      this.iterations += 1;
      const t = this.discount
        ? Math.floor(this.iterations / this.discount.every) + 1
        : this.iterations;
      this.weight = this.discount ? t ** this.discount.gamma : this.iterations;

      // Only the seats still in the hand have anything to learn; a folded one
      // has no decision in this tree and traversing for it is a walk to the
      // same terminals for a payoff nothing reads.
      for (const seat of this.live) {
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
