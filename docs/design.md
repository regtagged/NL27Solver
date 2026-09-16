# Design

What this solver is, and why it is shaped the way it is. The README is how to
run it.

## The game being solved

No Limit **deuce-to-seven** Single Draw, seven-handed, stacks capped at 40bb.
Blinds and ante are inputs.

Pre-draw the action set is deliberately narrow:

| Facing | Actions |
| --- | --- |
| No raise | fold, limp, raise to 3x, all-in |
| A raise | fold, call, all-in |
| An all-in | fold, call |

The only 3-bet size is all-in. That is a real simplification but not a damaging
one at 40bb, where a 3-bet-to-9bb-and-fold line barely exists in this game.

After the draw the sizes are **b25**, **b100** and **bAI** — a quarter pot, pot,
and the remaining stack — plus check, fold and call.

## Why this is not a hold'em preflop solver

A hold'em preflop solver reasons about 1,326 starting combinations per player.
This one reasons about **2,598,960** — a five-card hand instead of a two-card
one, nearly two thousand times the space. Two further problems have no hold'em
equivalent:

- **The draw is a decision, not a card.** A player choosing which of 32 subsets
  to discard is making a strategic choice on private information, so the draw is
  another decision node in the tree and not a chance node that can be averaged
  out.
- **Card removal is heavy.** Seven players take 35 cards before anybody draws.
  What the opponents hold moves the deck enough that it cannot be ignored the
  way a hold'em solver can mostly ignore it.

So the whole design is about getting 2.6 million hands down to something that
converges, without abstracting away anything that changes a decision.

## The hand abstraction

Suits in 2-7 matter for exactly one reason: flushes are bad hands. That makes
most of the suit information in a hand strategically dead, and the deck says how
much. Every count below was measured by enumerating all 2,598,960 hands
(`npm run measure` recomputes every one of them):

| Grouping | Classes |
| --- | --- |
| Rank multiset only | 6,175 |
| Rank multiset + which ranks are suited, when 4 or 5 share a suit | **16,757** |
| Rank multiset + which ranks are suited, when 3 or more share a suit | 42,783 |
| Full suit isomorphism (loses nothing) | 134,459 |

The suit shapes themselves:

| Shape | Hands |
| --- | --- |
| 2-2-1-0 | 949,104 |
| 2-1-1-1 | 685,464 |
| 3-1-1-0 | 580,008 |
| 3-2-0-0 | 267,696 |
| 4-1-0-0 | 111,540 |
| 5-0-0-0 | 5,148 |

**Only 4.5% of hands hold four or five cards of one suit** — and those are the
only hands where a flush is either already made or one card away. For the other
95.5%, suits cannot change a decision and carrying them is pure cost.

So the working abstraction is the **16,757-class** row: rank multiset, plus
which ranks sit in the flush suit whenever four or five cards share one. It is
lossless except for one thing — a three-flush kept on a two-card draw backs into
a flush about 4% of the time, and that hand is scored as though it could not.
The 42,783-class row exists to buy that back if it ever proves to matter, which
is a question to settle by measurement rather than now.

## The draw

Thirty-two discard subsets per hand is far more than a player ever considers,
and most of them are dominated outright. The option set offered at a draw node
is the small family that is actually in tension:

- **Stand pat.** Always available, which is also what makes snowing fall out of
  the solve rather than needing to be hand-coded — if standing pat with a broken
  hand shows a profit, CFR will find it.
- **Draw one**, keeping the best four low cards. Where two keeps are genuinely
  close — 8-7-5-4-2 can pitch the eight or the seven — both are offered.
- **Draw two**, keeping the best three.
- **Draw three**, keeping the best two.

Drawing four or five is never offered. That is an assumption, and a cheap one to
revisit.

## The algorithm

**Monte Carlo CFR, external sampling.** Each iteration shuffles one deck, deals
seven hands and every draw out of it, walks the tree and updates regrets on the
abstract classes.

The deal is what makes this the right fit. Card removal across seven five-card
hands is hopeless to compute in closed form and free to sample: if another
player holds the 5c, this player cannot draw it, and no bookkeeping is required
to make that true. It also gives anytime results — the solve can be stopped,
checkpointed and resumed, so a rough answer in minutes and a sharp one overnight
are the same run.

## What is built

- `lib/cards.js` — cards, parsing, a seeded RNG and in-place dealing.
- `lib/eval27.js` — 2-7 hand strength, direct and table-backed. The table scores
  every hand in the deck once into a 5 MB `Uint16Array` of dense ranks, built in
  about a quarter of a second.
- `test/eval27.test.js` — the rules that are easy to get wrong, pinned.

## What is next

1. `lib/abstraction.js` — hand to class, and the draw option set.
2. `lib/tree.js` — the betting tree from a config: players, blinds, ante, stack,
   sizes.
3. `lib/solve.js` — MCCFR over the tree, with checkpoints.
4. `serve.js` and `public/` — entering a configuration and browsing the result.

## The open risks, honestly

- **Info sets are classes times histories, and only the classes are measured.**
  16,757 classes is comfortable; 16,757 multiplied by every betting history a
  player can face may not be. This is the number that decides whether the solve
  fits in memory, and it cannot be known until the tree exists. If it is too
  large the answer is coarser classes deep in the tree, not a coarser deck.
- **Seven-handed convergence is unproven here.** Multiway CFR converges to
  something, but "something" is not guaranteed to be the equilibrium in a game
  with more than two players. The results need reading as a strong strategy, not
  as a proof.
- **The two-street tree with three post-draw sizes is the expensive choice.** It
  was picked over a checkdown model because limping is in the tree and a limp
  that cannot be bet after the draw is not a limp. The cost lands in solve time.
