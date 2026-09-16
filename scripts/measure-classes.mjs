/**
 * The hand-space counts quoted in docs/design.md, recomputed from the deck.
 *
 * The abstraction argument rests entirely on how much suit information is dead
 * in 2-7, so the numbers behind it are produced here rather than quoted from
 * anywhere. Takes a few seconds; run it after touching anything it counts.
 *
 *   node scripts/measure-classes.mjs
 */

const popcount = (x) => { let n = 0; while (x) { x &= x - 1; n += 1; } return n; };

const ranksOnly = new Set();
const flushWhen4 = new Set();
const flushWhen3 = new Set();
const suitIsomorphic = new Set();
const shapes = new Map();

for (let a = 0; a < 52; a += 1)
for (let b = a + 1; b < 52; b += 1)
for (let c = b + 1; c < 52; c += 1)
for (let d = c + 1; d < 52; d += 1)
for (let e = d + 1; e < 52; e += 1) {
  const masks = [0, 0, 0, 0];
  const counts = new Int8Array(13);
  for (const card of [a, b, c, d, e]) {
    masks[(card / 13) | 0] |= 1 << (card % 13);
    counts[card % 13] += 1;
  }

  // At most four of a rank, so base 6 per rank is a faithful key.
  let multiset = 0;
  for (let rank = 0; rank < 13; rank += 1) multiset = multiset * 6 + counts[rank];

  // Permuting suits permutes the four rank-masks, so the sorted masks are the
  // canonical form and two hands share one exactly when they are isomorphic.
  const sorted = masks.slice().sort((x, y) => popcount(y) - popcount(x) || y - x);
  const widest = popcount(sorted[0]);

  ranksOnly.add(multiset);
  flushWhen4.add(widest >= 4 ? `${multiset}/${sorted[0]}` : String(multiset));
  flushWhen3.add(widest >= 3 ? `${multiset}/${sorted[0]}` : String(multiset));
  suitIsomorphic.add(
    sorted[0] * 549755813888 + sorted[1] * 67108864 + sorted[2] * 8192 + sorted[3],
  );

  const shape = sorted.map(popcount).join('-');
  shapes.set(shape, (shapes.get(shape) ?? 0) + 1);
}

const n = (value) => value.toLocaleString();
console.log('Grouping                                          Classes');
console.log(`  rank multiset only                              ${n(ranksOnly.size)}`);
console.log(`  + suited ranks when 4 or 5 share a suit          ${n(flushWhen4.size)}`);
console.log(`  + suited ranks when 3 or more share a suit       ${n(flushWhen3.size)}`);
console.log(`  full suit isomorphism                            ${n(suitIsomorphic.size)}`);
console.log('\nSuit shape        Hands');
let flushRelevant = 0;
let total = 0;
for (const [shape, count] of [...shapes].sort((p, q) => q[1] - p[1])) {
  console.log(`  ${shape}          ${n(count).padStart(9)}`);
  total += count;
  if (Number(shape[0]) >= 4) flushRelevant += count;
}
console.log(`\n  ${n(total)} hands, of which ${n(flushRelevant)} `
  + `(${(100 * flushRelevant / total).toFixed(1)}%) hold four or five of a suit.`);
