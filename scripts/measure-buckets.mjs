/**
 * What the hand abstraction costs, at each level of detail.
 *
 * The bucket count is not a free parameter. It multiplies every pre-draw action
 * slot in the tree, so the choice of where to stop spelling hands out is the
 * choice of whether the solve fits in memory. This prints both halves of that
 * trade so it can be made on the numbers.
 *
 *   node --max-old-space-size=6000 scripts/measure-buckets.mjs
 */

import { RANKS } from '../lib/cards.js';
import { buildTree, defaultConfig, PRE_DRAW } from '../lib/tree.js';
import { buckets, DEFAULT_LIMITS } from '../lib/abstraction.js';

const n = (value) => value.toLocaleString();

// Exact, not estimated: the tree says how many action slots pre-draw holds.
const tree = buildTree({ ...defaultConfig(), stopAtDraw: true, nodeLimit: 5e6 });
let preNodes = 0;
let preActions = 0;
for (const node of tree.nodes) {
  if (node.kind !== 'decision' || node.street !== PRE_DRAW) continue;
  preNodes += 1;
  preActions += node.actions.length;
}

console.log(`Pre-draw tree: ${n(preNodes)} decision nodes, ${n(preActions)} action slots`);
console.log('CFR keeps a regret and a strategy sum per slot per bucket, Float32.\n');

const at = (ch) => RANKS.indexOf(ch);
const gb = (bytes) => `${(bytes / 1024 ** 3).toFixed(2)} GB`;

const levels = [
  ['A', 'A', 'A', 'every hand spelled out in full'],
  ['K', 'Q', 'J', 'barely collapsed'],
  ['J', 'T', '9', 'the default'],
  ['J', '9', '8', 'tighter one-card draws'],
  ['9', '8', '7', 'only what gets played'],
];

console.log('  pat  d1  d2    buckets     strategy   ');
for (const [pat, keep4, keep3, note] of levels) {
  const limits = { pat: at(pat), keep4: at(keep4), keep3: at(keep3) };
  const { descriptors } = buckets(limits);
  const bytes = preActions * descriptors.length * 2 * 4;
  const mark = limits.pat === DEFAULT_LIMITS.pat
    && limits.keep4 === DEFAULT_LIMITS.keep4
    && limits.keep3 === DEFAULT_LIMITS.keep3 ? ' <-' : '   ';
  console.log(
    `   ${pat}   ${keep4}   ${keep3}   ${n(descriptors.length).padStart(7)}`
    + `   ${gb(bytes).padStart(10)}${mark}  ${note}`,
  );
}

// Where the detail actually goes, at the default.
const { descriptors } = buckets(DEFAULT_LIMITS);
const byShape = new Map();
for (const descriptor of descriptors) {
  const [pat, one, two] = descriptor.key.split('|');
  // "made" is a made low, not merely the option of standing pat - every hand
  // can stand pat, which is what makes snowing available to all of them.
  const shape = `${pat === '-' ? '.' : 'made'} ${one === '-' ? '.' : 'd1'} ${two === '-' ? '.' : 'd2'}`;
  byShape.set(shape, (byShape.get(shape) ?? 0) + 1);
}

console.log('\nBuckets by what a hand has, at the default');
for (const [shape, count] of [...byShape].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${shape.padEnd(12)} ${n(count).padStart(6)}`);
}

const hands = descriptors.reduce((sum, d) => sum + d.hands, 0);
const biggest = [...descriptors].sort((a, b) => b.hands - a.hands)[0];
console.log(`\n  ${n(descriptors.length)} buckets covering ${n(hands)} hands`);
console.log(`  largest holds ${n(biggest.hands)} hands (${biggest.key})`);
