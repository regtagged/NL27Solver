# DrawSolver

A solver for **No Limit 2-7 Single Draw**: seven-handed, 40bb, 3x opens with
all-in as the only 3-bet, and b25 / b100 / bAI after the draw.

`docs/design.md` is the design and the reasoning — in particular what pruning
the tree to how the game is actually played did to the cost of solving it:
204 GB to 0.9 GB. This file is what works today and how to run it.

No build step and no dependencies. Node is the only requirement.

## Running it

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

```bash
npm run solve -- --players 7 --iterations 20000000
```

`measure` recounts the hand space from the deck, `measure:tree` builds the
seven-handed tree and reports what a solve over it would cost, and
`measure:buckets` prices the hand abstraction at each level of detail. All three
print numbers quoted in the design, so none of them can quietly go stale.

## Where it is

The foundation is in place and tested:

- **Cards and dealing** — one deck deals seven hands and their draws, so card
  removal is correct by construction rather than by bookkeeping. Four-colour
  deck, matching the other tools here.
- **Hand strength** — a full 2-7 evaluator, with a table that scores every hand
  in the deck into 5 MB of dense ranks in about a quarter of a second.
- **The betting tree** — 6,392 nodes for the seven-handed 40bb game, built as a
  DAG in 22 milliseconds. No limping, at most two callers of an open, and no
  cold-calling a 3-bet; all three are config switches.
- **The hand abstraction** — every hand in the deck mapped to one of 3,452
  strategy buckets, derived from what pat, draw-one and draw-two are each worth
  rather than clustered by similarity.

- **The solver** — Monte Carlo CFR with CFR+ and linear averaging. Seven-handed,
  twenty million iterations run in about seven minutes and hold 30 MB, and the
  opening ranges come out monotone in hand strength.

Solving both streets together, and then the interface, are next. `docs/design.md` lists them and the risk each one carries.

## The two rules that make this game

Both are in the tests, because both are easy to write wrong:

- **The ace is high only.** 5-4-3-2-A is not a straight — it is an ace-high
  hand, and a bad one. There are nine straights in this game, not ten.
- **A flush counts against you.** 7-5-4-3-2 of one suit is a flush and loses to
  every no-pair hand in the deck. The same ranks offsuit are the nuts.
