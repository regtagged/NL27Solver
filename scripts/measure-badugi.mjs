/**
 * What a six-handed badugi solve costs, and which pruning is paying for it.
 *
 * The question this answers is why six-handed badugi is affordable when the
 * `HANDOFF.md` table said four-handed ran out of memory at 11GB. That table was
 * measured without `maxToDraw`, the cap on how many seats may voluntarily enter
 * - which the same file calls the most powerful lever there is, for 2-7, and
 * which nobody had turned on for this game. It is worth more here than every
 * other prune put together.
 *
 * Two costs are printed, because they are bounded by different things. The tree
 * is what the builder has to hold; the strategy is `1,092 hands x actions x 4
 * bytes`, twice, at every decision node, and that is the number that decides
 * whether a run fits in a heap.
 *
 *   node --max-old-space-size=12000 scripts/measure-badugi.mjs
 *
 * The rates at the end are measured after the blocks are allocated. The first
 * few thousand iterations of any run are two to three times slower, because
 * allocating a block costs more than using one, and quoting that rate would put
 * the estimates out by a factor of three in the pessimistic direction.
 */

import { buildTree, tripleDrawConfig, treeStats } from '../lib/tree.js';
import { BadugiSolver } from '../lib/badugi-solve.js';
import { badugiTable } from '../lib/badugi.js';

const LIMIT = 6e6;
const { count: HANDS } = badugiTable();

/** The game `scripts/badugi.mjs` solves, at whatever seat count is asked. */
const badugi = (overrides = {}) => tripleDrawConfig({
  players: 6,
  allowLimp: false,
  coldCallSeats: ['BTN', 'BB'],
  coldCallThreeBets: false,
  maxToDraw: 2,
  maxDraw: [2, 1, 1],
  maxDrawBySeat: { BB: [3, 1, 1] },
  limit: { smallBet: 1, bigBet: 2, bigBetFrom: 2, cap: 3 },
  nodeLimit: LIMIT,
  ...overrides,
});

/**
 * What a deal wants off the deck: four cards a seat, plus the most each could
 * draw in each round. The replacements come out before the walk so that a hand
 * comparing its actions compares them against one future.
 */
function cardsFor(config) {
  let needed = config.players * 4;
  const names = ['SB', 'BB', 'BTN'];
  for (let seat = 0; seat < config.players; seat += 1) {
    const name = config.players === 2 ? names[seat] : (seat === 1 ? 'BB' : null);
    const ceiling = (name && config.maxDrawBySeat?.[name]) ?? config.maxDraw;
    for (let round = 0; round < config.drawRounds; round += 1) {
      needed += Array.isArray(ceiling)
        ? ceiling[Math.min(round, ceiling.length - 1)]
        : ceiling;
    }
  }
  return needed;
}

/** Nodes, action edges, and the memory the strategy tables want. */
function price(config) {
  let tree;
  try {
    tree = buildTree(config);
  } catch {
    return null;
  }
  const stats = treeStats(tree);
  // Regret and average, one Float32 per hand per action, at every decision.
  const strategy = 2 * HANDS * stats.actionEdges * 4;
  // The per-hand EV columns the viewer reads: one float and one count a hand,
  // a decision. `trackEv: false` is what leaves these out.
  const ev = 2 * HANDS * (stats.byKind.get('decision') ?? 0) * 4;
  return { nodes: stats.total, edges: stats.actionEdges, strategy, ev };
}

const gb = (bytes) => `${(bytes / 1e9).toFixed(2)} GB`;
const row = (label, p, cards) => {
  if (!p) {
    console.log(`  ${label.padEnd(34)} ${`over ${(LIMIT / 1e6)}M`.padStart(11)}`);
    return;
  }
  console.log(`  ${label.padEnd(34)} ${p.nodes.toLocaleString().padStart(11)}  `
    + `${gb(p.strategy).padStart(8)}${cards === undefined ? '' : `  ${String(cards).padStart(2)} cards`}`);
};

console.log('Fixed limit badugi: 200bb, 0.5/1 blinds, 1bb and 2bb bets, three draws,');
console.log('ceiling 2,1,1 with the big blind taking three on the first draw.');
console.log(`${HANDS} distinct hand values, so nothing is abstracted.\n`);

console.log('Seat count, with every prune on and at most two seats entering:\n');
console.log('  players                                  nodes    memory');
for (const players of [2, 3, 4, 5, 6]) {
  const config = badugi({ players });
  row(`  ${players}-handed`, price(config), cardsFor(config));
}

console.log('\nWhat each prune is worth six-handed. Each line turns exactly one');
console.log('thing off, so the numbers are what that thing is paying for:\n');
console.log('  six-handed                               nodes    memory');
row('  everything on', price(badugi()));
row('  limping allowed', price(badugi({ allowLimp: true })));
row('  anyone may cold call', price(badugi({ coldCallSeats: null })));
row('  cold calling a 3-bet allowed', price(badugi({ coldCallThreeBets: true })));
row('  no cap on who enters', price(badugi({ maxToDraw: null })));

console.log('\n  Two of these are load-bearing and two are not. Barring the limp and');
console.log('  capping who enters are each worth more than eleven times, and without');
console.log('  either one six-handed does not fit. The two cold-calling rules are');
console.log('  worth 5% and nothing at all: once at most two seats may enter, there');
console.log('  is nobody left to cold call a 3-bet, so that rule never fires.\n');

console.log('How far the cap can be pushed, and what the other knobs do to it:\n');
console.log('  six-handed                               nodes    memory');
for (const cap of [1, 2, 3]) row(`  maxToDraw ${cap}`, price(badugi({ maxToDraw: cap })));
console.log('  maxToDraw 1 is not a game: a seat barred from entering is barred from');
console.log('  raising too, so the big blind cannot even defend.\n');
for (const cap of [2, 3, 4]) {
  row(`  ${cap} bets a round`, price(badugi({
    limit: { smallBet: 1, bigBet: 2, bigBetFrom: 2, cap },
  })));
}
console.log('');
for (const rounds of [1, 2, 3]) {
  row(`  ${rounds} draw${rounds === 1 ? '' : 's'}`, price(badugi({ drawRounds: rounds })));
}

console.log('\nThroughput, measured after the blocks are allocated:\n');
console.log('  players     it/s   10M iterations');
for (const players of [3, 6]) {
  const solver = new BadugiSolver({ config: badugi({ players }), seed: 21, trackEv: false });
  solver.run(20000); // allocate; the rate during this is not the rate
  const started = Date.now();
  solver.run(5000);
  const rate = Math.round(5000 / ((Date.now() - started) / 1000));
  console.log(`  ${String(players).padStart(7)}  ${String(rate).padStart(7)}   `
    + `${(1e7 / rate / 3600).toFixed(1)} hours`);
}
