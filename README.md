# DrawSolver

Tools for **No Limit 2-7 Single Draw**: a ranked starting-hand viewer, and a
pre-draw solver for the seven-handed 40bb game — 3x opens with all-in as the
only 3-bet, and b25 / b100 / bAI after the draw.

`docs/design.md` is the design and the reasoning — in particular what pruning
the tree to how the game is actually played did to the cost of solving it:
204 GB to 0.9 GB. This file is what works today and how to run it.

No build step and no dependencies. Node is the only requirement.

## The hand viewer

Build the ranked table once (about two minutes), then serve it:

```bash
npm run rank
```

```bash
npm start
```

Every one of the 7,947 starting hands, ranked by equity, in a four-colour deck,
with how many combinations it stands for, what it draws, and which cards it
throws. Filter by percentile band, by ranks held, by how many cards are drawn,
by what the draw is drawing to, and by whether it can brick into a straight.

A hand is split by **whether the cards it keeps are all one suit** — 75432 keeps
all five and splits 1,020 plain against 4 flushes; K7543 throws the king and
splits 1,008 against 16. That is worth 40 points of equity on the first and 14
on the second, so the two are never one row.

The equity is measured, not modelled: each hand is dealt opponents out of the
same deck, everything draws under the policy in `lib/draws.js`, and showdowns
are counted. Two numbers say it is calibrated — **average equity over the whole
deck is 50.2% heads-up and 33.4% three-way**, against a theoretical 50% and
33.3%.

## The solver

```bash
npm run solve -- --players 7 --iterations 20000000
```

Monte Carlo CFR over the pre-draw tree. Seven-handed, twenty million iterations
take about seven minutes and hold 30 MB, and the opening ranges come out
monotone in hand strength.

## Checking it

```bash
npm test
```

```bash
npm run measure
```

```bash
npm run measure:tree
```

```bash
npm run measure:buckets
```

`measure` recounts the hand space from the deck, `measure:tree` builds the
seven-handed tree and reports what a solve over it would cost, and
`measure:buckets` prices the hand abstraction at each level of detail. All three
print numbers quoted in the design, so none of them can quietly go stale.

## Where it is

- **Cards and dealing** — one deck deals seven hands and their draws, so card
  removal is correct by construction rather than by bookkeeping.
- **Hand strength** — a full 2-7 evaluator, with a table that scores every hand
  in the deck into 5 MB of dense ranks in about a quarter of a second.
- **The betting tree** — 6,392 nodes pre-draw, 151,588 with the draw and the
  post-draw street played out. No limping, at most two callers of an open, and
  no cold-calling a 3-bet; all three are config switches.
- **The abstraction** — 3,463 pre-draw buckets, derived from what pat, draw-one
  and draw-two are each worth, plus 251 showdown buckets for after the draw.
- **The solver** — MCCFR with CFR+ and linear averaging, over the pre-draw tree.
- **The viewer** — the ranked hand table, served from `public/`.

Solving both streets in one run is next: the tree and the buckets for it are
built, the solver still stops at the draw and lets a rollout finish the hand.

## The three rules that make this game

All are in the tests, because all are easy to write wrong:

- **The ace is high only.** 5-4-3-2-A is not a straight — it is an ace-high
  hand, and a bad one. There are nine straights in this game, not ten.
- **A flush counts against you.** 7-5-4-3-2 of one suit is a flush and loses to
  every no-pair hand in the deck. The same ranks offsuit are the nuts.
- **Straights count against you too, and that changes which cards you keep.**
  8-5-4-3 makes an eight or better 12 times in 48 and cannot make a straight;
  7-5-4-3 manages 8 and bricks with any six. The lowest four cards in a hand are
  often the wrong four.
