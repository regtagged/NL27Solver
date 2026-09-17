/**
 * Walking the pre-draw tree, one decision at a time.
 *
 * The question people ask is "what does the button do here", not "what is node
 * 431", so a node is presented as a table: who is in, what each seat has done,
 * and what the seat to act can do. Every action is a link to where it leads, so
 * the tree is stepped through rather than looked up - which is the whole of the
 * navigation.
 *
 * Strategies come back already grouped, because a range of 7,462 rows is not
 * something to send to a browser and re-add on every click. The grouping is the
 * same tree `lib/grouping.js` builds, with an action mix hung on every level.
 */

import { parseHand } from './cards.js';
import { handIndex } from './eval27.js';

import { PRE_DRAW, positionNames } from './tree.js';
import { groupRows } from './grouping.js';

/**
 * Every pre-draw decision, with the line that reaches it.
 *
 * The tree is a DAG, so a node can be arrived at more than one way; the first
 * route found is the one reported. Two lines that meet at the same node have
 * put the same chips in from the same seats, so either description is true of
 * it - what would be wrong is claiming there is only one.
 */
export function indexNodes(tree, players) {
  const names = positionNames(players);
  const found = new Map();

  const walk = (id, sequence) => {
    const node = tree.nodes[id];
    if (!node || node.kind !== 'decision' || node.street !== PRE_DRAW) return;
    if (found.has(id)) return;
    found.set(id, {
      id,
      seat: node.seat,
      seatName: names[node.seat],
      sequence,
      actions: node.actions.map((action) => ({ label: action.label, child: action.child })),
    });
    for (const action of node.actions) {
      // `at` is where the action was taken, so a seat that has already acted
      // offers a way back to the decision rather than only a record of it.
      walk(action.child, [
        ...sequence,
        { seat: node.seat, name: names[node.seat], label: action.label, at: id },
      ]);
    }
  };

  walk(tree.root, []);
  return found;
}

/**
 * Where a seat's own decision lives, assuming everyone between it folds.
 *
 * This is the line people think in - "what does the button do if it folds
 * round" - so a seat not yet in the hand still offers its actions rather than
 * nothing at all.
 */
export function foldRoundTo(tree, from, seat) {
  let id = from;
  for (let guard = 0; guard < 32; guard += 1) {
    const node = tree.nodes[id];
    if (!node || node.kind !== 'decision') return -1;
    if (node.seat === seat) return id;
    const fold = node.actions.find((action) => action.kind === 'fold');
    if (!fold) return -1;
    id = fold.child;
  }
  return -1;
}

let bucketCache = null;

/**
 * Each display row's bucket in whatever abstraction the solver is using.
 *
 * The two are deliberately different - the viewer shows every hand, the solver
 * groups them into a few hundred decisions - so the lookup has to come off the
 * solver's own table rather than be recomputed from the finer one.
 */
function bucketsForRows(solver, rows) {
  if (bucketCache && bucketCache.rows === rows && bucketCache.table === solver.bucketTable) {
    return bucketCache.at;
  }
  const at = rows.map((row) => solver.bucketTable[handIndex(parseHand(row.cards.join(' ')))]);
  bucketCache = { rows, at, table: solver.bucketTable };
  return at;
}

/**
 * The strategy at one node, grouped.
 *
 * Each level carries the combination-weighted mix of the rows beneath it, so a
 * group reads as what that whole range does and a leaf as what one hand does.
 * They are the same number at different depths.
 */
export function strategyTree(solver, nodeId, rows) {
  const node = solver.nodes[nodeId];
  if (!node || node.kind !== 'decision') return null;

  const at = bucketsForRows(solver, rows);
  const actions = node.actions.map((action) => action.label);

  // One lookup per row, then everything above is addition.
  const mixes = rows.map((row, i) => solver.strategyAt(nodeId, at[i]));
  const evs = rows.map((row, i) => solver.evAt(nodeId, at[i]));

  const index = new Map(rows.map((row, i) => [row, i]));
  const decorate = (group) => {
    const total = new Float64Array(actions.length);
    let combos = 0;
    let ev = 0;
    let priced = 0;
    for (const row of group.rows) {
      const i = index.get(row);
      const mix = mixes[i];
      for (let a = 0; a < actions.length; a += 1) total[a] += row.combos * mix[a];
      combos += row.combos;
      // A hand never dealt here has no EV, and averaging it in as zero would
      // drag a group's figure toward nothing for no reason.
      if (evs[i] !== null) {
        ev += row.combos * evs[i];
        priced += row.combos;
      }
    }
    return {
      label: group.label,
      kind: group.kind,
      combos,
      mix: Array.from(total, (value) => (combos ? value / combos : 0)),
      ev: priced ? ev / priced : null,
      children: group.children.map(decorate),
    };
  };

  return { actions, seat: node.seat, tree: groupRows(rows).map(decorate) };
}
