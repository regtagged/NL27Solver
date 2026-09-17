/**
 * What fixed limit triple draw costs, before anyone tries to solve it.
 *
 * Two walls, and this prints both of them. The tree grows by roughly ninety
 * times per draw round, because the draw history is public and a state that
 * forgets it is a different game. And the deck runs out: replacement cards are
 * dealt before the walk, so that a hand comparing its actions compares them
 * against one future rather than several, and three draws of up to five cards
 * wants fifteen replacements a player.
 *
 *   node --max-old-space-size=8000 scripts/measure-triple.mjs
 */

import { buildTree, tripleDrawConfig, treeStats } from '../lib/tree.js';

const CEILING = 3e6;

console.log('Fixed limit 2-7 triple draw: 200bb, 0.5/1 blinds, 1bb and 2bb bets, cap 4.\n');

console.log('How the tree grows, heads-up. Three million nodes is the ceiling here:');
console.log('past it the builder runs out of memory before it runs out of states.\n');
console.log('  draws  most drawn          nodes   growth');
let previous = new Map();
for (const drawRounds of [1, 2, 3]) {
  for (const maxDraw of [2, 3, 5]) {
    const config = tripleDrawConfig({ players: 2, drawRounds, maxDraw, nodeLimit: CEILING });
    let nodes = null;
    try {
      nodes = buildTree(config).nodes.length;
    } catch {
      nodes = null;
    }
    const was = previous.get(maxDraw);
    const growth = nodes && was ? `${(nodes / was).toFixed(0)}x` : '';
    console.log(`  ${String(drawRounds).padStart(5)}  ${String(maxDraw).padStart(10)}  `
      + `${(nodes === null ? `over ${CEILING.toLocaleString()}` : nodes.toLocaleString()).padStart(13)}   ${growth}`);
    if (nodes !== null) previous.set(maxDraw, nodes);
  }
}

console.log('\nWhat one deal needs off a 52-card deck. Replacements are dealt up front,');
console.log('so a seat needs its five cards plus the most it could ever draw.\n');
console.log('  players  most drawn   cards needed   fits');
for (const players of [2, 3, 4, 6]) {
  for (const maxDraw of [2, 5]) {
    const needed = players * (5 + maxDraw * 3);
    console.log(`  ${String(players).padStart(7)}  ${String(maxDraw).padStart(10)}  `
      + `${String(needed).padStart(13)}   ${needed <= 52 ? 'yes' : 'no'}`);
  }
}

console.log('\nThe smallest triple draw tree worth calling one, in full:\n');
const config = tripleDrawConfig({ players: 2, maxDraw: 2, nodeLimit: 5e6 });
const tree = buildTree(config);
const stats = treeStats(tree);
console.log(`  ${tree.nodes.length.toLocaleString()} nodes, ${stats.actionEdges.toLocaleString()} action edges`);
for (const [kind, count] of stats.byKind) console.log(`  ${kind.padEnd(9)} ${count.toLocaleString()}`);
