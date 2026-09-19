import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BadugiSolver, badugiConfig } from '../lib/badugi-solve.js';
import { saveBadugi, loadBadugi, inspectBadugi, rangeStamp } from '../lib/badugi-checkpoint.js';
import { buttonOpeningRange } from '../lib/badugi-benchmark.js';
import { stateAfter, positionNames } from '../lib/tree.js';
import { makeRng } from '../lib/cards.js';

const small = (over = {}) => badugiConfig({
  players: 2,
  drawRounds: 1,
  maxDraw: [1],
  maxDrawBySeat: null,
  limit: { smallBet: 1, bigBet: 2, bigBetFrom: 1, cap: 2 },
  ...over,
});

const build = (over = {}, options = {}) => new BadugiSolver({
  config: small(over), seed: 11, trackEv: false, explore: 0.02, ...options,
});

/** The average strategy at every node that has one, for comparing two solvers. */
function snapshot(solver) {
  const out = [];
  for (let id = 0; id < solver.nodes.length; id += 1) {
    const block = solver.average[id];
    if (!block) continue;
    out.push([id, Array.from(block.subarray(0, Math.min(block.length, 40)))]);
  }
  return out;
}

test('the generator can be read and set, so deals carry on', () => {
  const rng = makeRng(7);
  for (let i = 0; i < 25; i += 1) rng();
  const at = rng.state;
  const next = [rng(), rng(), rng()];

  const other = makeRng(1);
  other.state = at;
  assert.deepEqual([other(), other(), other()], next,
    'a generator set to a saved state produces the same numbers');
});

test('stopping and continuing is the same run as never stopping', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'badugi-ckpt-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'spot');

  // One solver runs 600 straight through.
  const straight = build();
  straight.run(600);

  // Another runs 250, is written out, is read back onto a fresh solver, and
  // runs the remaining 350. The two must agree - which they only can if the
  // regrets and the deal sequence both survived the trip.
  const first = build();
  first.run(250);
  saveBadugi(first, file, 'test');

  const second = build();
  const head = loadBadugi(second, file);
  assert.ok(head && !head.mismatch, `did not load: ${head && head.mismatch}`);
  assert.equal(second.iterations, 250);
  second.run(350);

  assert.equal(second.iterations, straight.iterations);
  const a = snapshot(straight);
  const b = snapshot(second);
  assert.equal(a.length, b.length, 'the same nodes have strategies');
  for (let i = 0; i < a.length; i += 1) {
    assert.equal(a[i][0], b[i][0], 'the same node ids');
    for (let j = 0; j < a[i][1].length; j += 1) {
      assert.ok(Math.abs(a[i][1][j] - b[i][1][j]) < 1e-6,
        `node ${a[i][0]} slot ${j}: ${a[i][1][j]} against ${b[i][1][j]}`);
    }
  }
});

test('a resumed run without the regrets would not be a continuation', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'badugi-ckpt-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'spot');

  const first = build();
  first.run(400);
  saveBadugi(first, file, 'test');

  // Regrets are the half that makes this resumable, so they have to be in the
  // file. This is what `lib/checkpoint.js` deliberately leaves out.
  const second = build();
  loadBadugi(second, file);
  let restored = 0;
  for (let id = 0; id < second.nodes.length; id += 1) if (second.regret[id]) restored += 1;
  assert.ok(restored > 0, 'no regrets came back, so the next iteration starts over');
});

test('a file for another game is refused rather than half-read', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'badugi-ckpt-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'spot');

  const first = build();
  first.run(120);
  saveBadugi(first, file, 'test');

  // A different tree: strategies are addressed by node id, so reading this
  // would make the same index mean a different decision, silently.
  const other = build({ limit: { smallBet: 1, bigBet: 2, bigBetFrom: 1, cap: 3 } });
  const result = loadBadugi(other, file);
  assert.ok(result && result.mismatch, 'a different tree must be refused');
  assert.equal(other.iterations, 0, 'and nothing may be loaded from it');

  // And a different exploration rate is a different answer, not a slower one.
  const explored = build({}, { explore: 0.1 });
  assert.ok(loadBadugi(explored, file).mismatch === 'explore');
});

test('a preset range is part of what a file describes', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'badugi-ckpt-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'spot');

  const cfg = small({ players: 6, maxToDraw: null });
  const from = stateAfter(cfg, ['fold', 'fold', 'fold', 'raise', 'fold']);
  const btn = positionNames(6).indexOf('BTN');
  const range = buttonOpeningRange();

  const withRange = new BadugiSolver({
    config: cfg, from, seed: 5, trackEv: false, presetRanges: { [btn]: range },
  });
  withRange.run(60);
  saveBadugi(withRange, file, 'btn-bb');

  // The same subgame with no preset is a different game: the button holds
  // anything, so the strategy trained against it is about something else.
  const without = new BadugiSolver({ config: cfg, from, seed: 5, trackEv: false });
  assert.equal(loadBadugi(without, file).mismatch, 'ranges');

  const matching = new BadugiSolver({
    config: cfg, from, seed: 5, trackEv: false, presetRanges: { [btn]: range },
  });
  assert.ok(!loadBadugi(matching, file).mismatch, 'the same preset loads');
  assert.equal(rangeStamp({ [btn]: range }), rangeStamp({ [btn]: buttonOpeningRange() }));
});

test('a checkpoint can be inspected without reading the blocks', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'badugi-ckpt-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'spot');

  assert.equal(inspectBadugi(build(), file), null, 'nothing there yet');
  const solver = build();
  solver.run(90);
  const written = saveBadugi(solver, file, 'a label');
  assert.ok(existsSync(`${file}.bin`) && existsSync(`${file}.json`));
  assert.equal(written.iterations, 90);

  const seen = inspectBadugi(build(), file);
  assert.equal(seen.mismatch, null);
  assert.equal(seen.head.iterations, 90);
  assert.equal(seen.head.label, 'a label');
});

test('loading onto a shared solver keeps it attached to the shared memory', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'badugi-ckpt-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'spot');

  const first = build({}, { shared: true });
  first.run(80);
  saveBadugi(first, file, 'test');

  const second = build({}, { shared: true });
  const id = second.nodes.findIndex((node) => node.kind === 'decision');
  loadBadugi(second, file);

  // The failure this guards is silent and total: replacing a shared view with
  // a private array leaves every number coming out of the main thread while the
  // workers solve into memory nothing reads. A forty-million-iteration run was
  // lost to it, reporting the checkpoint it had loaded.
  assert.equal(second.average[id].buffer, second.buffers.average,
    'the table is still a view into the shared buffer');
  assert.equal(second.regret[id].buffer, second.buffers.regret);

  // And a write through the buffer - which is what a worker does - is seen.
  const through = new Float32Array(second.buffers.average, second.average[id].byteOffset, 1);
  through[0] = 1234;
  assert.equal(second.average[id][0], 1234, 'a worker\'s write reaches the main thread');

  // The loaded values are the ones that were saved, not zeros.
  const straight = build({}, { shared: true });
  loadBadugi(straight, file);
  let same = 0;
  for (let i = 0; i < straight.average[id].length; i += 1) {
    if (straight.average[id][i] === first.average[id][i]) same += 1;
  }
  assert.equal(same, straight.average[id].length, 'and they came back intact');
});
