import test from 'node:test';
import assert from 'node:assert/strict';

import { buildTree, defaultConfig, positionNames } from '../lib/tree.js';
import { indexNodes, foldRoundTo, followLine } from '../lib/browse.js';

// Three-handed pre-draw is a few hundred nodes and has all the shapes that
// matter: a seat that has acted, a seat not yet in, and a seat that acts twice.
const config = { ...defaultConfig(), players: 3, preDrawOnly: true };
const tree = buildTree(config);
const names = positionNames(3);
const nodes = indexNodes(tree, 3);

/** Walk a line by what each seat did, the way the viewer's buttons do. */
function walk(kinds) {
  let id = tree.root;
  for (const kind of kinds) {
    const action = tree.nodes[id].actions.find((step) => step.kind === kind);
    id = action.child;
  }
  return id;
}

test('a line says where each action was taken and which one it was', () => {
  const at = walk(['raise', 'allin']);
  const { sequence } = nodes.get(at);
  assert.deepEqual(sequence.map((entry) => entry.kind), ['raise', 'allin']);

  // `at` and `index` are what let a seat be sent back to its own decision with
  // the rest of what it could have done there, rather than only what it did.
  for (const entry of sequence) {
    const decision = tree.nodes[entry.at];
    assert.equal(decision.seat, entry.seat);
    assert.equal(decision.actions[entry.index].label, entry.label);
  }
});

test('a seat that acts twice is found again at its later decision', () => {
  // Opened, 3-bet by the next seat, folded by the last: it comes back round.
  const at = walk(['raise', 'allin', 'fold']);
  const { sequence, seat } = nodes.get(at);
  const opener = sequence[0].seat;
  assert.equal(seat, opener, 'the opener is the one now facing the shove');

  // The last time it acted is the one to go back to: the opener raised, and
  // then faced a 3-bet, and the second is the decision it is in the middle of.
  const last = [...sequence].reverse().find((entry) => entry.seat === opener);
  assert.equal(last.kind, 'raise');
  assert.notEqual(last.at, at, 'and it is not the decision it is facing now');
});

test('a seat not yet in the hand is found where the line would reach it', () => {
  const button = names.indexOf('BTN') >= 0 ? names.indexOf('BTN') : 2;
  const at = foldRoundTo(tree, tree.root, button);
  assert.ok(at >= 0);
  assert.equal(tree.nodes[at].seat, button);
  // Everyone between folded to get there, so nothing has gone in but blinds
  // and antes - which is what makes it the hand people actually ask about.
  assert.deepEqual(nodes.get(at).sequence.map((entry) => entry.kind), []);
});

test('a line lands in another tree by what was done, not by node id', () => {
  const sized = buildTree({ ...config, openTo: 2.5 });
  const at = walk(['raise', 'allin']);
  const there = followLine(sized, nodes.get(at).sequence);
  assert.ok(there >= 0, 'a 2.5x open is still an open');
  assert.equal(sized.nodes[there].seat, tree.nodes[at].seat);

  // The labels are what differ - that is the whole point of matching on kind.
  const opened = (of) => of.nodes[of.root].actions.find((a) => a.kind === 'raise').label;
  assert.notEqual(opened(sized), opened(tree));
});
