import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

import { RANKS } from '../lib/cards.js';
import { groupRows, flatten, bestCompletion } from '../lib/grouping.js';

const at = (text) => text.split('').map((ch) => RANKS.indexOf(ch));

test('a keep is measured by the best hand it can finish as', () => {
  // A deuce completes 7-5-4-3 to the nuts.
  assert.deepEqual(bestCompletion(at('7543')), at('75432'));
  // A seven completes 5-4-3-2 to the same hand - which is why both are
  // seven-five draws, however different they look.
  assert.deepEqual(bestCompletion(at('5432')), at('75432'));
  // 6-4-3-2 cannot make a seven-five, because the five would need a seven and
  // 7-6-5-4-3... is not what it makes. Its best is a seven-six.
  assert.deepEqual(bestCompletion(at('6432')), at('76432'));
});

test('a completion is never a straight', () => {
  // 5-4-3-2 looks like it completes to 6-5-4-3-2, and does not.
  const best = bestCompletion(at('5432'));
  assert.notDeepEqual(best, at('65432'));
  assert.equal(RANKS[best[0]], '7');
});

const dataFile = new URL('../data/ranked.json', import.meta.url);

test('the tree files hands where a player would look for them', { skip: !existsSync(dataFile) }, () => {
  const data = JSON.parse(readFileSync(dataFile));
  const tree = groupRows(data.rows);

  const pat = tree.find((node) => node.label === 'Pat');
  const sevens = pat.children.find((node) => node.label === '7');
  assert.deepEqual(sevens.children.map((n) => n.label), ['75', '76']);
  assert.deepEqual(sevens.children[0].children.map((n) => n.label), ['75432']);
  assert.deepEqual(sevens.children[1].children.map((n) => n.label),
    ['76432', '76532', '76542']);

  // Every pat seven, and only the four of them.
  assert.equal(sevens.combos, 4 * 1020);

  const d1 = tree.find((node) => node.label === 'D1');
  const d1sevens = d1.children.find((node) => node.label === '7');
  const sevenFives = d1sevens.children.find((node) => node.label === '75');
  const keeps = sevenFives.children.map((n) => n.label);
  assert.ok(keeps.includes('5432'), 'a 5-4-3-2 draw is a seven-five draw');
  assert.ok(keeps.includes('7543'), 'and so is a 7-5-4-3 draw');
});

test('a group adds up to the rows beneath it', { skip: !existsSync(dataFile) }, () => {
  const data = JSON.parse(readFileSync(dataFile));
  const tree = groupRows(data.rows);

  const check = (node) => {
    if (node.children.length === 0) return;
    const below = node.children.reduce((sum, child) => sum + child.combos, 0);
    assert.equal(below, node.combos, `${node.label} disagrees with its children`);
    for (const child of node.children) check(child);
  };
  for (const category of tree) check(category);

  const total = tree.reduce((sum, node) => sum + node.combos, 0);
  assert.equal(total, 2598960, 'the tree covers the deck');
});

test('flattening shows a closed group as one row and an open one as many', () => {
  const rows = [
    { drawLabel: 'Pat', draw: 0, ranks: at('75432'), combos: 1020, keep: null },
    { drawLabel: 'Pat', draw: 0, ranks: at('76432'), combos: 1020, keep: null },
  ];
  const tree = groupRows(rows);
  assert.equal(flatten(tree, new Set()).length, 1, 'just the category');
  const open = new Set(['Pat', 'Pat/7']);
  const shown = flatten(tree, open).map((line) => line.label);
  assert.deepEqual(shown, ['Pat', '7', '75', '76']);
});
