import test from 'node:test';
import assert from 'node:assert/strict';

import {
  pushFoldConfig, buildPushFoldTree, potAt, PushFoldSolver, SHOVE, FOLD,
} from '../lib/pushfold.js';
import { handClass, HAND_CLASS_LABELS, HAND_CLASS_COUNT } from '../lib/holdem.js';
import { parseHand } from '../lib/cards.js';
import { positionNames } from '../lib/tree.js';

const classOf = (text) => handClass(...parseHand(text));

test('fifteen big blinds is what is behind after the ante', () => {
  const config = pushFoldConfig();
  const { allIn } = potAt(config, []);
  assert.equal(allIn, 1500, 'a shove puts in fifteen, not fourteen and a bit');

  // Folded round to the big blind: it wins the antes and the small blind.
  assert.equal(potAt(config, []).pot, 570, '4.2 in antes plus the two blinds');
  // One shove through: that seat has fifteen in, and the blinds are dead.
  assert.equal(potAt(config, [6]).pot, 2070);
  // Two all-in: thirty between them, plus antes, plus the small blind.
  assert.equal(potAt(config, [6, 1]).pot, 3470);
});

test('the big blind gets no decision when nobody has shoved', () => {
  const config = pushFoldConfig();
  const tree = buildPushFoldTree(config);
  const bb = 1;
  // Fold all the way round and the hand is over without the big blind acting.
  let id = tree.root;
  const seen = [];
  while (id >= 0) {
    seen.push(tree.nodes[id].seat);
    id = tree.nodes[id].actions[FOLD].child;
  }
  assert.ok(!seen.includes(bb), 'the big blind never acts on a walkover');
  const result = tree.terminals[-id - 1];
  assert.equal(result.kind, 'walkover');
  assert.equal(result.winner, bb);
});

test('no chips are created or destroyed at any terminal', () => {
  for (const players of [2, 3, 7]) {
    const solver = new PushFoldSolver({ config: { players } });
    // Give every seat a distinct hand strength, including a tie to split.
    for (let seat = 0; seat < players; seat += 1) solver.ranks[seat] = 1000 + seat;
    if (players >= 2) solver.ranks[0] = solver.ranks[1];

    for (const result of solver.tree.terminals) {
      let total = 0;
      for (let seat = 0; seat < players; seat += 1) total += solver.payoffs(result, seat);
      assert.equal(total, 0,
        `${players}-handed ${result.kind} with [${result.live}] leaks ${total / 100}bb`);
    }
  }
});

test('a walkover pays the big blind what everyone else lost', () => {
  const solver = new PushFoldSolver();
  const walkover = solver.tree.terminals.find((t) => t.kind === 'walkover');
  // Six others lose 0.6 each, the small blind loses 0.6 + 0.5.
  assert.equal(solver.payoffs(walkover, 2), -60, 'a folded seat is out its ante');
  assert.equal(solver.payoffs(walkover, 0), -110, 'the small blind loses its post too');
  // Six other antes and the small blind: 3.6 + 0.5. Its own ante and blind
  // come back to it, so they are not winnings.
  assert.equal(solver.payoffs(walkover, 1), 410, 'the big blind takes the rest');
});

test('an uncontested shove wins the antes and the blinds, not a stack', () => {
  const solver = new PushFoldSolver();
  const config = solver.config;
  const button = config.players - 1;
  const uncontested = solver.tree.terminals.find(
    (t) => t.kind === 'uncontested' && t.live.length === 1 && t.live[0] === button,
  );
  assert.ok(uncontested, 'the button shoving through is a terminal');
  // It risked fifteen to win six antes and a blind and a half.
  assert.equal(solver.payoffs(uncontested, button), 60 * 6 + 150);
});

test('solving finds the hands anyone would shove, and the ones nobody would', () => {
  const solver = new PushFoldSolver({ config: { players: 3 }, seed: 5 }).run(120000);
  const button = solver.openingNode(2);
  const shoves = (text) => solver.averageAt(button, classOf(text))[SHOVE];

  assert.ok(shoves('Ah As') > 0.99, `aces should always shove, got ${shoves('Ah As')}`);
  assert.ok(shoves('Kh Ks') > 0.99, 'kings too');
  assert.ok(shoves('7h 2d') < shoves('Ah As'), 'seven-deuce is not aces');

  // And the range is a range: not everything, not nothing.
  const frequency = solver.frequency(button);
  assert.ok(frequency > 20 && frequency < 95, `a button range of ${frequency.toFixed(0)}% is not a range`);
});

test('every class is reachable and named', () => {
  assert.equal(HAND_CLASS_LABELS.length, HAND_CLASS_COUNT);
  assert.equal(HAND_CLASS_LABELS[classOf('Ah As')], 'AA');
  const solver = new PushFoldSolver({ config: { players: 2 } });
  assert.equal(solver.names.join(' '), positionNames(2).join(' '));
});
