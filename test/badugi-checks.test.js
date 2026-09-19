import test from 'node:test';
import assert from 'node:assert/strict';

import {
  deadCards, standingWithinSize, dominatedPatting, checkDraws, worseAfterDrawing,
} from '../lib/badugi-checks.js';
import { keepFor } from '../lib/badugi-solve.js';
import { score, sizeOf } from '../lib/badugi.js';
import { handFacts } from '../lib/badugi-benchmark.js';
import { makeRng, parseHand } from '../lib/cards.js';

test('drawing away only the dead cards can never make a hand worse', () => {
  // The lemma the whole check rests on, checked against the evaluator over a
  // sample of real hands rather than asserted. If this ever fails, the check
  // below is reporting a fiction.
  const rng = makeRng(2026);
  let checked = 0;
  let improvedSomewhere = 0;
  for (let n = 0; n < 1500; n += 1) {
    const cards = [];
    while (cards.length < 4) {
      const card = Math.floor(rng() * 52);
      if (!cards.includes(card)) cards.push(card);
    }
    const size = sizeOf(score(cards));
    if (size === 4) continue; // a complete badugi has no dead cards to throw
    const { worse, better } = worseAfterDrawing(cards, keepFor, score, 4 - size);
    assert.equal(worse, 0, `${cards} got worse by drawing ${4 - size}`);
    if (better > 0) improvedSomewhere += 1;
    checked += 1;
  }
  assert.ok(checked > 800, `only ${checked} incomplete hands in the sample`);
  assert.ok(improvedSomewhere > checked / 2, 'and most of them can improve');
});

test('A-2-3 drawing one improves ten times in forty-eight and never worsens', () => {
  // The worked example the check's documentation quotes, pinned.
  const { worse, better } = worseAfterDrawing(parseHand('Ah 2d 3c 3s'), keepFor, score, 1);
  assert.equal(worse, 0);
  assert.equal(better, 10);
});

test('a complete badugi has no dead cards, so patting it is never flagged', () => {
  const { hands } = handFacts();
  for (const hand of hands) {
    if (hand.size === 4) assert.equal(deadCards(hand), 0);
    else assert.equal(deadCards(hand), 4 - hand.size);
  }
});

test('standing is measured within a size, best first', () => {
  const standing = standingWithinSize();
  const { hands } = handFacts();
  const best = hands.findIndex((h) => h.size === 3);
  assert.ok(standing[best] < 0.01, 'the best tri sits at the top of the tris');
  // Every size starts near zero and ends near one, independently.
  for (const size of [4, 3, 2]) {
    const inSize = hands.map((h, i) => ({ h, i })).filter(({ h }) => h.size === size);
    const first = standing[inSize[0].i];
    const last = standing[inSize[inSize.length - 1].i];
    assert.ok(first < 0.02, `size ${size} starts at ${first}`);
    assert.ok(last > 0.9, `size ${size} ends at ${last}`);
  }
});

/** One decision, as the report writes it: actions plus a strategy per hand. */
function spotWhere(pick) {
  const { hands } = handFacts();
  return {
    drawing: true,
    what: 'test draw',
    seat: 1,
    actions: [{ label: 'pat' }, { label: 'd1' }, { label: 'd2' }, { label: 'd3' }],
    hands: hands.map((hand, i) => pick(hand, i)),
  };
}

test('a good hand patting is flagged and a weak one snowing is not', () => {
  const { hands } = handFacts();
  const bestTri = hands.findIndex((h) => h.size === 3);
  let worstTri = -1;
  hands.forEach((h, i) => { if (h.size === 3) worstTri = i; });

  // The best tri in the game, patting every time: nothing to draw to would be
  // worse, and it has the most showdown value of any tri, so this is starved.
  const flagged = dominatedPatting(spotWhere((hand, i) => (i === bestTri
    ? [1, 0, 0, 0] : [0, 1, 0, 0])));
  assert.equal(flagged.length, 1, 'exactly the one hand');
  assert.equal(flagged[0].hand, bestTri);
  assert.equal(flagged[0].dominatedBy, 'd1');

  // The worst tri doing the same is a snow, which is a real play.
  const snow = dominatedPatting(spotWhere((hand, i) => (i === worstTri
    ? [1, 0, 0, 0] : [0, 1, 0, 0])));
  assert.equal(snow.length, 0, 'a weak hand standing pat is a snow, not a bug');
});

test('a badugi patting is never flagged, however often', () => {
  const { hands } = handFacts();
  const everyBadugiPats = spotWhere((hand) => (hand.size === 4 ? [1, 0, 0, 0] : [0, 1, 0, 0]));
  assert.equal(dominatedPatting(everyBadugiPats).length, 0,
    'standing pat on a made badugi is the whole point of having one');
});

test('the check skips a draw the ceiling does not offer', () => {
  const { hands } = handFacts();
  const bestTwoCard = hands.findIndex((h) => h.size === 2);
  const spot = spotWhere((hand, i) => (i === bestTwoCard ? [1, 0] : [0, 1]));
  // A two-card hand needs to draw two; a round capped at one cannot, so there
  // is nothing for the dominance to point at and nothing to report.
  spot.actions = [{ label: 'pat' }, { label: 'd1' }];
  assert.equal(dominatedPatting(spot).length, 0);
});

test('checkDraws looks at draw decisions and leaves betting alone', () => {
  const { hands } = handFacts();
  const draw = spotWhere((hand, i) => (i === hands.findIndex((h) => h.size === 3)
    ? [1, 0, 0, 0] : [0, 1, 0, 0]));
  const betting = {
    drawing: false,
    what: 'facing the bet',
    seat: 1,
    actions: [{ label: 'fold', kind: 'fold' }, { label: 'call', kind: 'call' }],
    hands: hands.map(() => [0.5, 0.5]),
  };
  const reports = checkDraws({ spots: [betting, draw] });
  assert.equal(reports.length, 1, 'only the draw decision is checked');
  assert.equal(reports[0].at, 1);
  assert.ok(reports[0].violations.length > 0);
});
