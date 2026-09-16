# DrawSolver

A solver for **No Limit 2-7 Single Draw**: seven-handed, 40bb, limp and 3x
opens with all-in as the only 3-bet, and b25 / b100 / bAI after the draw.

`docs/design.md` is the design and the reasoning — in particular why 2.6 million
five-card hands collapse to 16,757 strategy classes without losing a decision.
This file is what works today and how to run it.

No build step and no dependencies. Node is the only requirement.

## Running the tests

```bash
npm test
```

## Where it is

Early. The foundation is in place and tested:

- **Cards and dealing** — one deck deals seven hands and their draws, so card
  removal is correct by construction rather than by bookkeeping.
- **Hand strength** — a full 2-7 evaluator, with a table that scores every hand
  in the deck into 5 MB of dense ranks in about a quarter of a second.

The abstraction, the betting tree, the solver and the interface are next, in
that order. `docs/design.md` lists them and the risks each one carries.

## The two rules that make this game

Both are in the tests, because both are easy to write wrong:

- **The ace is high only.** 5-4-3-2-A is not a straight — it is an ace-high
  hand, and a bad one. There are nine straights in this game, not ten.
- **A flush counts against you.** 7-5-4-3-2 of one suit is a flush and loses to
  every no-pair hand in the deck. The same ranks offsuit are the nuts.
