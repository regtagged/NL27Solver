import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BB, FOLDED, PRE_DRAW, POST_DRAW, DRAWING,
  tripleDrawConfig, initialState, legalActions, applyAction, buildTree, potOf,
  drawActionsFor, roundStreet,
} from '../lib/tree.js';

// Heads-up, and no more of the draw than a test needs: the tree grows about
// ninetyfold per draw round, so a three-draw tree is not something to build
// inside a test.
const heads = (over = {}) => tripleDrawConfig({ players: 2, nodeLimit: 2e6, ...over });

const labels = (state, config) => legalActions(state, config).map((a) => a.label);
const take = (state, config, label) => {
  const action = legalActions(state, config).find((a) => a.label === label);
  assert.ok(action, `no "${label}" available, only ${labels(state, config).join(', ')}`);
  return applyAction(state, config, action);
};

test('a limit round offers one bet size, and a raise of the same size', () => {
  const config = heads();
  let state = initialState(config);
  // Heads-up the small blind acts first before the draw, owing half a blind.
  assert.deepEqual(labels(state, config), ['fold', 'call', 'raise 1bb']);

  state = take(state, config, 'raise 1bb');
  assert.equal(state.betLevel, 2 * BB, 'a raise makes it two blinds, not three');
  assert.deepEqual(labels(state, config), ['fold', 'call', 'raise 1bb']);
});

test('the cap closes the betting however much money is behind', () => {
  const config = heads();
  let state = initialState(config);
  // The blind is the first bet, so three raises cap it.
  for (const _ of [0, 1, 2]) state = take(state, config, 'raise 1bb');
  assert.equal(state.bets, config.limit.cap);
  assert.deepEqual(labels(state, config), ['fold', 'call'],
    'capped: the only things left are paying and quitting');
  // And nobody is anywhere near all-in.
  assert.ok(state.stack[0] > 190 * BB && state.stack[1] > 190 * BB);
});

test('the bet doubles for the rounds after the second draw', () => {
  const config = heads();
  const tree = buildTree({ ...config, drawRounds: 1 });
  const sizeIn = (round) => {
    const wanted = roundStreet(round);
    for (const node of tree.nodes) {
      if (node.kind !== 'decision' || node.street !== wanted) continue;
      const bet = node.actions.find((a) => a.kind === 'bet' || a.kind === 'raise');
      if (bet) return bet.label;
    }
    return null;
  };
  // With one draw both rounds are small-bet rounds; `bigBetFrom` is what says
  // when the size steps up, and it is a round number, not a street.
  assert.equal(sizeIn(0), 'raise 1bb');
  assert.equal(sizeIn(1), 'bet 1bb');

  const late = buildTree({ ...config, drawRounds: 1, limit: { ...config.limit, bigBetFrom: 1 } });
  const after = late.nodes.find((n) => n.kind === 'decision' && n.street === POST_DRAW
    && n.actions.some((a) => a.kind === 'bet'));
  assert.equal(after.actions.find((a) => a.kind === 'bet').label, 'bet 2bb');
});

test('three draws means four betting rounds, in the right order', () => {
  const config = heads({ drawRounds: 3, maxDraw: 2 });
  let state = initialState(config);
  assert.equal(state.round, 0);
  assert.equal(state.street, PRE_DRAW);

  const tree = buildTree(config);
  const rounds = new Set();
  let draws = 0;
  for (const node of tree.nodes) {
    if (node.kind !== 'decision') continue;
    if (node.street === DRAWING) draws += 1;
    else rounds.add(node.street);
  }
  assert.ok(draws > 0, 'the draws are decisions of their own');
  assert.deepEqual([...rounds].sort(), [PRE_DRAW, POST_DRAW]);

  // Every showdown has had three draws from everyone still in.
  const shown = tree.nodes.filter((n) => n.kind === 'showdown');
  assert.ok(shown.length > 0);
  for (const node of shown) {
    for (let seat = 0; seat < config.players; seat += 1) {
      if (node.state.status[seat] === FOLDED) continue;
      for (let round = 0; round < 3; round += 1) {
        assert.ok(node.state.draws[seat * 3 + round] >= 0,
          `seat ${seat} never drew in round ${round}`);
      }
    }
  }
});

test('a draw ceiling is a configuration, not a constant', () => {
  assert.deepEqual(drawActionsFor({ maxDraw: 2 }).map((a) => a.label), ['pat', 'd1', 'd2']);
  assert.deepEqual(drawActionsFor({ maxDraw: 5 }).map((a) => a.label),
    ['pat', 'd1', 'd2', 'd3', 'd4', 'd5']);
});

test('no chips are created or destroyed in a limit tree', () => {
  const config = heads({ drawRounds: 2, maxDraw: 2 });
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

test('a short stack calls off rather than raising short', () => {
  // Two big blinds behind: enough to call a raise, never enough to make one.
  const config = heads({ stack: 2 });
  let state = initialState(config);
  state = take(state, config, 'raise 1bb');
  assert.deepEqual(labels(state, config), ['fold', 'call'],
    'the big blind has a blind left, which does not cover another bet');
});
