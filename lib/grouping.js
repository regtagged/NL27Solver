/**
 * Hands, grouped the way a draw player talks about them.
 *
 * A 13x13 matrix is the right shape for hold'em because a hold'em hand is two
 * cards and there are 169 of them. A 2-7 hand is five cards and there are
 * thousands, so a grid is the wrong instrument - there is no axis to put them
 * on. What there is instead is a hierarchy, because nobody thinks
 * "7-6-5-3-2", they think "a seven, and specifically a seven-six":
 *
 *   Pat
 *     7          every pat seven
 *       75
 *         75432
 *       76
 *         76432  76532  76542
 *     8 …
 *   Draw one
 *     7          every one-card draw to a seven
 *       75       drawing at a seven-five
 *         5432   7543
 *
 * A draw is filed under **the best hand it can complete**, which is how they
 * are spoken about: 5-4-3-2 and 7-5-4-3 are both sevens-five draws, because a
 * seven completes the first and a deuce completes the second. Filing them by
 * the cards held instead would put them in different places and call neither of
 * them a seven.
 *
 * Past two cards drawn that stops meaning anything - keeping 3-2 and taking
 * three can make almost any hand - so from three cards up the grouping is what
 * the hand is holding, which by then is the only thing there is to say.
 *
 * Every level is a real range with a real combination count, so a strategy can
 * be read at whatever depth the question is asked: "how often do we open a
 * seven" and "how often do we open 7-6-5-4-2" are one lookup at two depths.
 */

import { RANKS } from './cards.js';
import { score, categoryOf, HIGH_CARD } from './eval27.js';

const show = (path) => path.map((rank) => RANKS[rank]).join('');

/** Alternating suits, so nothing built here is accidentally a flush. */
const asCards = (ranks) => ranks.map((rank, i) => rank + 13 * (i % 2));

const completions = new Map();

/**
 * The best hand a keep can finish as, ranks high to low.
 *
 * Enumerated rather than reasoned about, because the obvious answer is wrong
 * often enough to matter: 5-4-3-2 looks like it completes to 6-5-4-3-2 and does
 * not, since that is a straight.
 */
export function bestCompletion(keepRanks) {
  const key = keepRanks.join('.');
  const hit = completions.get(key);
  if (hit) return hit;

  const held = new Set(keepRanks);
  const spare = [];
  for (let rank = 0; rank < 13; rank += 1) if (!held.has(rank)) spare.push(rank);

  const draws = 5 - keepRanks.length;
  let best = null;
  let bestScore = Infinity;
  const pick = new Array(draws);

  const walk = (start, depth) => {
    if (depth === draws) {
      const ranks = [...keepRanks, ...pick].sort((a, b) => b - a);
      const value = score(asCards(ranks));
      // Pairs are impossible here and flushes are dodged by construction, so
      // the only thing to rule out is a straight.
      if (categoryOf(value) === HIGH_CARD && value < bestScore) {
        bestScore = value;
        best = ranks;
      }
      return;
    }
    for (let i = start; i <= spare.length - (draws - depth); i += 1) {
      pick[depth] = spare[i];
      walk(i + 1, depth + 1);
    }
  };
  walk(0, 0);

  const answer = best ?? [...keepRanks].sort((a, b) => b - a);
  completions.set(key, answer);
  return answer;
}

const keepRanksOf = (row) =>
  (row.keep ? row.keep.split('').map((letter) => RANKS.indexOf(letter)) : []);

/**
 * Where a row files: the two levels above it, and what it is called.
 *
 * Pat hands and draws of one or two cards are filed under the hand they are
 * trying to have. Deeper draws are filed under what they are holding.
 */
function placeOf(row) {
  if (row.draw === 0) {
    // A pat hand's leaf is already all five cards.
    return { levels: row.ranks.slice(0, 2), keep: null, leaf: row.hand, full: row.ranks };
  }
  const keep = keepRanksOf(row);
  if (keep.length === 0) return { levels: [], keep: null, leaf: row.hand, full: [] };
  if (row.draw <= 2) {
    const target = bestCompletion(keep);
    return { levels: target.slice(0, 2), keep: show(keep), leaf: row.hand, full: target };
  }
  return { levels: keep.slice(0, Math.min(2, keep.length)), keep: null, leaf: row.hand, full: keep };
}

/** Best-first, because that is the order a range is read in. */
const byStrength = (a, b) => {
  const n = Math.min(a.path.length, b.path.length);
  for (let i = 0; i < n; i += 1) if (a.path[i] !== b.path[i]) return a.path[i] - b.path[i];
  if (a.path.length !== b.path.length) return a.path.length - b.path.length;
  return a.label.localeCompare(b.label);
};

export function groupRows(rows) {
  const categories = new Map();

  for (const row of rows) {
    let category = categories.get(row.drawLabel);
    if (!category) {
      category = {
        label: row.drawLabel,
        kind: 'category',
        order: row.draw,
        path: [],
        combos: 0,
        rows: [],
        children: new Map(),
      };
      categories.set(row.drawLabel, category);
    }
    category.combos += row.combos;
    category.rows.push(row);

    const { levels, keep, leaf, full } = placeOf(row);
    let level = category;

    const descend = (key, kind, sortPath) => {
      let node = level.children.get(key);
      if (!node) {
        node = { label: key, kind, path: sortPath, combos: 0, rows: [], children: new Map() };
        level.children.set(key, node);
      }
      node.combos += row.combos;
      node.rows.push(row);
      level = node;
    };

    for (let depth = 1; depth <= levels.length; depth += 1) {
      descend(show(full.slice(0, depth)), 'group', full.slice(0, depth));
    }

    // The keep is a level of its own for a draw, because underneath it the
    // fifth card still matters: 7-4-3-2-2 and 7-4-3-2-A both draw to 7-4-3-2,
    // and the spare deuce blocks a card that would pair the hand while taking a
    // low card away from everybody else. The ace blocks nothing worth blocking.
    if (keep) descend(keep, 'group', keepRanksOf(row));

    if (leaf) descend(leaf, 'hand', row.ranks);
  }

  const settle = (node) => {
    const children = [...node.children.values()].sort(byStrength);
    for (const child of children) settle(child);
    node.children = children;
    // A level whose only child repeats it is a step to nowhere.
    if (children.length === 1 && children[0].label === node.label) {
      node.children = children[0].children;
    }
    // Nothing below it means it is a hand, whatever it was filed as - the
    // deeper draws have no completion to be grouped under, so their last
    // level is the hand itself.
    if (node.children.length === 0 && node.kind === 'group') node.kind = 'hand';
    return node;
  };

  return [...categories.values()].sort((a, b) => a.order - b.order).map(settle);
}

/**
 * Flattens a tree into display rows, honouring which groups are open.
 *
 * Ids are the path from the root, so they survive a rebuild and a reorder.
 */
export function flatten(tree, open, depth = 0, prefix = '') {
  const out = [];
  for (const node of tree) {
    const id = prefix ? `${prefix}/${node.label}` : node.label;
    const expandable = node.children.length > 0;
    out.push({ id, depth, label: node.label, kind: node.kind, combos: node.combos, node, expandable });
    if (expandable && open.has(id)) out.push(...flatten(node.children, open, depth + 1, id));
  }
  return out;
}
