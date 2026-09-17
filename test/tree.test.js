import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BB, ACTIVE, FOLDED, ALLIN, PRE_DRAW, POST_DRAW, DRAWING, postDrawOrder,
  defaultConfig, positionNames, preDrawOrder, initialState, legalActions,
  applyAction, buildTree, potOf,
} from '../lib/tree.js';

const labels = (state, config) => legalActions(state, config).map((a) => a.label);
const take = (state, config, label) => {
  const action = legalActions(state, config).find((a) => a.label === label);
  assert.ok(action, `no "${label}" available, only ${labels(state, config).join(', ')}`);
  return applyAction(state, config, action);
};

test('seats are named from the button backwards, with UTG first to act', () => {
  assert.deepEqual(positionNames(7), ['SB', 'BB', 'UTG', 'LJ', 'HJ', 'CO', 'BTN']);
  assert.deepEqual(preDrawOrder(7).map((s) => positionNames(7)[s]),
    ['UTG', 'LJ', 'HJ', 'CO', 'BTN', 'SB', 'BB']);
});

test('blinds come out of stacks, and the big blind is the bet to match', () => {
  // No ante here, so the blinds are the only thing taken.
  const config = { ...defaultConfig(), ante: 0, anteMode: 'none' };
  const state = initialState(config);
  assert.equal(state.committed[0], 50);
  assert.equal(state.committed[1], 100);
  assert.equal(state.stack[0], 40 * BB - 50);
  assert.equal(state.stack[1], 40 * BB - 100);
  assert.equal(state.betLevel, 100);
  assert.equal(state.toAct, 2, 'UTG acts first');
  assert.equal(potOf(state), 150);
});

test('an opener raises or folds, and cannot limp or shove', () => {
  const config = defaultConfig();
  assert.deepEqual(labels(initialState(config), config), ['fold', 'raise 3x']);
});

test('an opening shove comes back when it is switched on', () => {
  const config = { ...defaultConfig(), allowOpenShove: true };
  assert.deepEqual(labels(initialState(config), config), ['fold', 'raise 3x', 'all-in']);
});

test('limping comes back when it is switched on', () => {
  const config = { ...defaultConfig(), allowLimp: true };
  assert.deepEqual(labels(initialState(config), config), ['fold', 'limp', 'raise 3x']);
});

test('the open grows by a big blind for every limper already in', () => {
  const config = { ...defaultConfig(), allowLimp: true };
  let state = initialState(config);
  state = take(state, config, 'limp'); // UTG
  state = take(state, config, 'limp'); // LJ
  const raise = legalActions(state, config).find((a) => a.kind === 'raise');
  // Two limpers, so 3x + 2 = 5bb, and HJ has nothing in yet.
  assert.equal(raise.amount, 5 * BB);
});

test('the big blind gets an option when the pot is limped to it', () => {
  const config = { ...defaultConfig(), allowLimp: true };
  let state = initialState(config);
  for (let i = 0; i < 5; i += 1) state = take(state, config, 'fold');
  state = take(state, config, 'limp'); // SB completes
  assert.equal(state.toAct, 1, 'the big blind is to act');
  assert.deepEqual(labels(state, config), ['check', 'raise 3x']);
});

test('facing a raise, the only raise back is all-in', () => {
  const config = defaultConfig();
  let state = initialState(config);
  state = take(state, config, 'raise 3x');
  assert.deepEqual(labels(state, config), ['fold', 'call', 'all-in']);
});

test('the open may be flat-called twice, and no more', () => {
  const config = defaultConfig();
  let state = initialState(config);
  state = take(state, config, 'raise 3x');
  state = take(state, config, 'call');
  assert.ok(labels(state, config).includes('call'), 'one caller still leaves room');
  state = take(state, config, 'call');
  assert.deepEqual(labels(state, config), ['fold', 'all-in'], 'two callers is the cap');
});

test('a 3-bet shove cannot be cold-called, but the opener may call it', () => {
  const config = defaultConfig();
  let state = initialState(config);
  state = take(state, config, 'raise 3x'); // UTG opens
  state = take(state, config, 'all-in'); // LJ 3-bets
  assert.deepEqual(labels(state, config), ['fold'],
    'the next seat is cold and has nothing to jam over an all-in');

  // Round to the opener, who has money in and so is not cold-calling.
  for (let i = 0; i < 5; i += 1) state = take(state, config, 'fold');
  assert.deepEqual(labels(state, config), ['fold', 'call']);
});

test('an opening shove is not a 3-bet, so calling it is not a cold call', () => {
  const config = { ...defaultConfig(), allowOpenShove: true };
  let state = initialState(config);
  state = take(state, config, 'all-in');
  assert.deepEqual(labels(state, config), ['fold', 'call']);
});

test('a raise has to raise: an opening shove cannot be re-raised to 3bb', () => {
  const config = { ...defaultConfig(), allowOpenShove: true };
  let state = initialState(config);
  state = take(state, config, 'all-in');
  assert.ok(!labels(state, config).includes('raise 3x'),
    'raising to less than the price of calling is not a raise');
});

test('after the draw the small blind acts first and may bet b25, b100 or all-in', () => {
  const config = { ...defaultConfig(), players: 3, nodeLimit: 2e6 };
  const tree = buildTree(config);
  assert.deepEqual(postDrawOrder(3), [0, 1, 2], 'the small blind leads after the draw');
  const after = tree.nodes.find((node) => node.kind === 'decision'
    && node.street === POST_DRAW && node.seat === 0);
  assert.ok(after, 'expected the small blind to get a post-draw decision');
  assert.deepEqual(after.actions.map((a) => a.label), ['check', 'b25', 'b100', 'all-in']);
});

test('the draw is a chain of decisions, one per survivor, three options each', () => {
  const config = { ...defaultConfig(), players: 3, nodeLimit: 2e6 };
  const tree = buildTree(config);
  const draws = tree.nodes.filter((node) => node.kind === 'decision' && node.street === DRAWING);
  assert.ok(draws.length > 0, 'expected draw decisions in the full tree');
  for (const node of draws) {
    assert.deepEqual(node.actions.map((a) => a.label), ['pat', 'd1', 'd2']);
  }
});

test('a pre-draw-only tree stops at the draw instead of playing it out', () => {
  const config = { ...defaultConfig(), players: 3, stopAtDraw: true, nodeLimit: 2e6 };
  const tree = buildTree(config);
  assert.ok(tree.nodes.some((node) => node.kind === 'draw'), 'the draw is a leaf here');
  assert.ok(!tree.nodes.some((node) => node.street === DRAWING), 'and is never played out');
});

test('facing a bet after the draw, the only raise is all-in', () => {
  const config = { ...defaultConfig(), players: 3, nodeLimit: 2e6 };
  const tree = buildTree(config);
  const facing = tree.nodes.find((node) =>
    node.kind === 'decision' && node.street === POST_DRAW
    && node.actions.some((a) => a.label === 'call'));
  assert.deepEqual(facing.actions.map((a) => a.label), ['fold', 'call', 'all-in']);
});

test('no chips are created or destroyed anywhere in the tree', () => {
  const config = { ...defaultConfig(), players: 3, nodeLimit: 2e6 };
  const tree = buildTree(config);
  const start = config.stack * BB;
  let checked = 0;
  for (const node of tree.nodes) {
    if (node.kind !== 'fold' && node.kind !== 'showdown') continue;
    let paid = 0;
    for (let seat = 0; seat < config.players; seat += 1) paid += start - node.state.stack[seat];
    assert.equal(potOf(node.state), paid, `pot disagrees with stacks at node ${node.id}`);
    checked += 1;
  }
  assert.ok(checked > 100, `expected many terminals, saw ${checked}`);
});

test('a fold-out leaves exactly one player who has not folded', () => {
  const config = { ...defaultConfig(), players: 3, nodeLimit: 2e6 };
  const tree = buildTree(config);
  for (const node of tree.nodes) {
    if (node.kind !== 'fold') continue;
    let left = 0;
    for (const status of node.state.status) if (status !== FOLDED) left += 1;
    assert.equal(left, 1);
  }
});

test('the default game antes three fifths of a blind from everybody', () => {
  const config = defaultConfig();
  const state = initialState(config);
  assert.equal(config.ante, 0.6);
  assert.equal(config.anteMode, 'each');
  // Seven-handed that is 4.2bb dead before a card is dealt, and 5.7bb to win.
  assert.equal(state.dead, 7 * 60);
  assert.equal(potOf(state), 7 * 60 + 150);
});

test('an ante is dead money and changes nobody what they owe', () => {
  const plain = defaultConfig();
  const anted = { ...plain, ante: 0.125, anteMode: 'each' };
  const state = initialState(anted);
  assert.equal(state.dead, 7 * Math.round(0.125 * BB));
  assert.equal(state.committed[2], 0, 'the ante is not a contribution toward the bet');
  assert.equal(state.betLevel, BB, 'the ante does not raise the price of entry');
  assert.equal(state.stack[2], 40 * BB - Math.round(0.125 * BB));
  assert.equal(potOf(state), state.dead + 150);
});

test('a button ante is posted by the button alone', () => {
  const config = { ...defaultConfig(), ante: 1, anteMode: 'button' };
  const state = initialState(config);
  assert.equal(state.dead, BB);
  assert.equal(state.stack[6], 40 * BB - BB, 'the button posted it');
  assert.equal(state.stack[5], 40 * BB, 'the cutoff did not');
});

test('all-in is capped at the stack, and empties it', () => {
  const config = { ...defaultConfig(), allowOpenShove: true, ante: 0, anteMode: 'none' };
  let state = initialState(config);
  state = take(state, config, 'all-in');
  assert.equal(state.stack[2], 0);
  assert.equal(state.committed[2], 40 * BB);
  assert.equal(state.status[2], ALLIN);
  assert.equal(state.betLevel, 40 * BB);
});
