/**
 * The tree counts quoted in docs/design.md, rebuilt from the configuration.
 *
 * The question this answers is not "how many nodes" but "does the solve fit in
 * memory", and that is nodes multiplied by hand buckets multiplied by the two
 * float accumulators CFR keeps per action. The node count alone is comfortable
 * and says nothing; the product is what decides the architecture.
 *
 *   node --max-old-space-size=6000 scripts/measure-tree.mjs
 */

import { buildTree, treeStats, defaultConfig, positionNames, PRE_DRAW, POST_DRAW } from '../lib/tree.js';

const n = (value) => value.toLocaleString();
const gb = (bytes) => `${(bytes / 1024 ** 3).toFixed(1)} GB`;
const mb = (bytes) => `${(bytes / 1024 ** 2).toFixed(0)} MB`;

const config = { ...defaultConfig(), nodeLimit: 2e7 };
const started = Date.now();
const tree = buildTree(config);
const stats = treeStats(tree);
const names = positionNames(config.players);

console.log(`Tree built in ${Date.now() - started} ms`);
console.log(`  ${n(stats.total)} nodes, ${n(stats.actionEdges)} action edges`);
for (const [kind, count] of [...stats.byKind].sort((a, b) => b[1] - a[1])) {
  console.log(`    ${kind.padEnd(9)} ${n(count).padStart(10)}`);
}

// Decision nodes and their actions, split by street: a player only holds
// strategy where that player acts.
let preNodes = 0;
let preActions = 0;
let postNodes = 0;
let postActions = 0;
for (const node of tree.nodes) {
  if (node.kind !== 'decision') continue;
  if (node.street === PRE_DRAW) {
    preNodes += 1;
    preActions += node.actions.length;
  } else {
    postNodes += 1;
    postActions += node.actions.length;
  }
}

console.log('\nDecision nodes by seat');
console.log('  seat    pre-draw    post-draw');
for (let seat = 0; seat < config.players; seat += 1) {
  const pre = stats.decisions.get(`${seat}:${PRE_DRAW}`) ?? 0;
  const post = stats.decisions.get(`${seat}:${POST_DRAW}`) ?? 0;
  console.log(`  ${names[seat].padEnd(5)} ${n(pre).padStart(9)} ${n(post).padStart(12)}`);
}
console.log(`  ${'all'.padEnd(5)} ${n(preNodes).padStart(9)} ${n(postNodes).padStart(12)}`);

// CFR keeps a regret and a strategy sum per action, four bytes each.
const cost = (actions, buckets) => actions * buckets * 2 * 4;

console.log('\nWhat it costs to hold a strategy (regret + strategy sum, Float32)');
console.log('  buckets      pre-draw     post-draw         both');
for (const buckets of [200, 1000, 1500, 6175, 16757]) {
  const pre = cost(preActions, buckets);
  const post = cost(postActions, buckets);
  console.log(
    `  ${n(buckets).padStart(7)}  ${(pre > 2 ** 30 ? gb(pre) : mb(pre)).padStart(12)}`
    + `  ${(post > 2 ** 30 ? gb(post) : mb(post)).padStart(12)}`
    + `  ${gb(pre + post).padStart(11)}`,
  );
}

// Each draw node opens a post-draw subgame. Their sizes decide whether those
// can be solved one at a time instead of all at once.
const subgames = [];
for (const node of tree.nodes) {
  if (node.kind !== 'draw' || node.next < 0) continue;
  subgames.push(countFrom(node.next));
}
subgames.sort((a, b) => a - b);
const total = subgames.reduce((sum, value) => sum + value, 0);

function countFrom(rootId) {
  const seen = new Set();
  const stack = [rootId];
  let count = 0;
  while (stack.length) {
    const id = stack.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    const node = tree.nodes[id];
    if (node.kind !== 'decision') continue;
    count += 1;
    for (const action of node.actions) stack.push(action.child);
  }
  return count;
}

console.log('\nPost-draw subgames, one per draw node');
console.log(`  count          ${n(subgames.length)}`);
console.log(`  mean nodes     ${(total / subgames.length).toFixed(1)}`);
console.log(`  median nodes   ${n(subgames[subgames.length >> 1])}`);
console.log(`  largest        ${n(subgames.at(-1))}`);
console.log(`  largest at 200 buckets, 3 actions: ${mb(cost(subgames.at(-1) * 3, 200))}`);
