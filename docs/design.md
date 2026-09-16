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
one at 40bb, where a 3-bet-to-9bb-and-fold line barely exists in this game. An
open grows by a big blind for each limper already in, so 3x over two limpers is
5bb — that is a convention, and `perLimper` in the config turns it off.

After the draw the sizes are **b25**, **b100** and **bAI** — a quarter pot, pot,
and the remaining stack. Facing a bet the only raise is all-in, which is the
same rule the 3-bet follows, and it is not a cosmetic restriction: see below.

## Why this is not a hold'em preflop solver

A hold'em preflop solver reasons about 1,326 starting combinations per player.
This one reasons about **2,598,960** — a five-card hand instead of a two-card
one, nearly two thousand times the space. Two further problems have no hold'em
equivalent:

- **The draw is a decision, not a card.** A player choosing which of 32 subsets
  to discard is making a strategic choice on private information, so the draw is
  another decision node and not a chance node that can be averaged out.
- **Card removal is heavy.** Seven players take 35 cards before anybody draws.

## The hand abstraction

Suits in 2-7 matter for exactly one reason: flushes are bad hands. That makes
most of the suit information in a hand strategically dead, and the deck says how
much. `npm run measure` recomputes every count below from all 2,598,960 hands:

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

So 16,757 classes is the finest grouping worth keeping: rank multiset, plus
which ranks sit in the flush suit whenever four or five share one. It is
lossless except that a three-flush kept on a two-card draw backs into a flush
about 4% of the time, and is scored as though it could not.

Sixteen thousand classes is not, however, what the solver can afford to hold.

## What the tree actually costs

`npm run measure:tree` builds the seven-handed 40bb tree and counts it. As
specified it is **1,208,412 nodes** and takes about four seconds:

| Node kind | Count |
| --- | --- |
| decision | 759,635 |
| showdown | 306,807 |
| fold | 118,355 |
| draw | 23,615 |

Those decisions are very unevenly split: **49,796 pre-draw and 709,839 after the
draw.** A player only holds strategy where that player acts, so the memory a
solve needs is decisions times actions times hand buckets times the two float
accumulators CFR keeps per action:

| Buckets | Pre-draw | Post-draw | Both |
| --- | --- | --- | --- |
| 200 | 166 MB | 2.3 GB | 2.4 GB |
| 1,000 | 830 MB | 11.4 GB | 12.2 GB |
| 1,500 | 1.2 GB | 17.1 GB | 18.3 GB |
| 6,175 | 5.0 GB | 70.3 GB | 75.3 GB |
| 16,757 | 13.6 GB | 190.7 GB | **204.2 GB** |

**Solving both streets at once does not fit, and no amount of bucketing rescues
it.** At 200 buckets it still wants 2.4 GB, and 200 buckets is far too coarse to
tell a pat 8 from a one-card draw to a 7.

Two findings got the tree even this small, and both were measured rather than
foreseen:

- **Re-raising is what explodes a tree, not bet sizes.** Letting b25 and b100
  raise each other multiway took the tree from 907,667 nodes past five million
  and then out of memory. Restricting the raise over a bet to all-in is what
  makes seven-handed buildable at all.
- **Over half the draw nodes have no betting after them.** The median post-draw
  subgame has *zero* decision nodes, because with all-in as the only 3-bet and
  equal stacks, most contested pots are already all-in before the draw.

## The architecture that follows: solve the streets apart

The same table shows the way out. Post-draw subgames are individually tiny —
**23,615 of them, averaging 30 decision nodes, the largest 14,280**, which is
65 MB at 200 buckets. Holding all of them at once is what is impossible, not
solving any one of them.

So the solve splits in two:

1. **The pre-draw solve** is the main run: the full seven-handed tree down to the
   draw, at roughly 1,000–1,500 buckets, with everything past the draw resolved
   by rollout under a fixed post-draw policy. That is 830 MB to 1.2 GB — it fits
   on a desktop.
2. **Post-draw subgames are solved on demand**, one line at a time, when there is
   a question about one. Each is seconds of work, at a bucketing far finer than
   the pre-draw solve could afford.

This is the answer ICM DB arrived at for a different reason: solving what
somebody has a question about beats precomputing an exhaustive grid. Here it is
not a preference but the only thing that fits. The post-draw street is still
solved, with b25, b100 and bAI exactly as specified — in its own run rather than
jointly, which is also what lets it be solved *better* than a joint solve could
have afforded.

## The draw: pat, one, or two

Thirty-two discard subsets per hand is far more than a player considers, and
most are dominated outright. Three options are offered:

- **Stand pat.** Always available to every hand, which is what makes snowing
  fall out of the solve rather than needing to be hand-coded — if standing pat
  with a broken hand shows a profit, CFR will find it.
- **Draw one**, keeping the four lowest distinct ranks.
- **Draw two**, keeping the three lowest distinct ranks.

**Drawing three or more is not offered.** Players stand pat or take one, and
take two only from the big blind or as a late-position opener in a single-raised
pot; the third card would buy a large abstraction for a line that is rarely
correct. The cost is real and worth naming: a hand like A-K-Q-8-6 would draw
three in a real game and here cannot, so it is simply a fold.

Keeping the *lowest* distinct ranks is not a shortcut, it is the play. Holding
8-7-5-4-2 and pitching the eight leaves 7-5-4-3-2 and 7-6-5-4-2 live; pitching
the seven cannot make better than an eight-five. A pair is never held back, so a
duplicated rank is simply skipped. Where a hand holds two copies of a rank the
keep takes the copy that breaks a flush — which is why flush risk survives only
on the four or five cards that are genuinely stuck in one suit.

The draw does not branch the betting tree: each survivor picks from their own
options at their own information set, so it is one node saying "this happens
here" rather than a fan of every combination of seven draws.

## The buckets, measured

Restricting the draw to three options is what lets the bucketing be derived from
the game instead of clustered by similarity. With only pat, d1 and d2 available,
everything a hand is worth pre-draw is what those three yield — its made low if
it has one, its four-card keep, its three-card keep, and whether either keep is
stuck in one suit. `npm run measure:buckets` counts the result.

Spelled out in full that is **6,046 buckets**, and at 108,748 pre-draw action
slots it wants 4.90 GB. Most of that detail is on hands nobody plays: there are
1,482 distinct ace-high pat hands, and they share one strategy. So each
dimension has a ceiling, above which only the high card is carried:

| pat | d1 | d2 | Buckets | Pre-draw strategy | |
| --- | --- | --- | --- | --- | --- |
| A | A | A | 6,046 | 4.90 GB | every hand spelled out |
| K | Q | J | 5,180 | 4.20 GB | barely collapsed |
| **J** | **T** | **9** | **3,452** | **2.80 GB** | the default |
| J | 9 | 8 | 2,559 | 2.07 GB | tighter one-card draws |
| 9 | 8 | 7 | 1,710 | 1.39 GB | only what gets played |

The default keeps pat hands through a jack, one-card draws through a ten and
two-card draws through a nine — the hands that are actually played differently —
and collapses the rest to their high card. **3,452 buckets, 2.80 GB.**

This is not clustering. Two hands merge only when all three of their options are
above the ceiling, which is to say when neither is a hand and neither has a
draw. A pat A-K-Q-J-9 and a pat A-K-Q-8-6 are one bucket because both are pat
ace-highs that draw one to a king and two to a queen — with d3 unavailable there
is nothing left to tell them apart. Two draws to a nine stay separate.

The earlier estimate in this document was 1,000–1,500 buckets. That was wrong:
the honest count at a defensible ceiling is 3,452, and the pre-draw solve needs
2.80 GB rather than 830 MB. It still fits, with room to tighten to 2.07 GB by
dropping one-card detail from a ten to a nine.

## The algorithm

**Monte Carlo CFR, external sampling.** Each iteration shuffles one deck, deals
seven hands and every draw out of it, walks the tree and updates regrets.

The deal is what makes this the right fit. Card removal across seven five-card
hands is hopeless to compute in closed form and free to sample: if another
player holds the 5c, this player cannot draw it, and no bookkeeping is required
to make that true. It also gives anytime results — the solve can be stopped,
checkpointed and resumed, so a rough answer in minutes and a sharp one overnight
are the same run.

## What is built

- `lib/cards.js` — cards, parsing, the four-colour deck, a seeded RNG, and
  in-place dealing so card removal is correct by construction.
- `lib/eval27.js` — 2-7 hand strength, direct and table-backed. The table scores
  every hand in the deck once into a 5 MB `Uint16Array` of dense ranks.
- `lib/tree.js` — the betting tree from a config, as a DAG so that two action
  sequences reaching the same chips are one node.
- `lib/abstraction.js` — hand to bucket and the draw options, with the ceilings
  that decide how much detail is carried.
- `test/` — the rules that are easy to get wrong, pinned.

## What is next

1. `lib/rollout.js` — the fixed post-draw policy that terminates the pre-draw
   solve.
2. `lib/solve.js` — MCCFR over the pre-draw tree, with checkpoints.
3. `lib/subgame.js` — solving one post-draw subgame on demand.
4. `serve.js` and `public/` — entering a configuration and browsing the result.

## The open risks, honestly

- **Seven-handed convergence is unproven here.** Multiway CFR converges to
  something, but "something" is not guaranteed to be the equilibrium in a game
  with more than two players. Results want reading as a strong strategy, not as
  a proof.
- **The rollout policy biases the pre-draw solve.** Terminating pre-draw lines
  under a fixed post-draw policy means the pre-draw strategy is only as good as
  that policy. The fix is to iterate — solve subgames, feed their values back as
  the rollout, re-run — and whether that converges usefully is untested.
- **2.80 GB is a lot to ask of a desktop.** The pre-draw solve needs Node run
  with a raised heap, and the ceilings are the dial if it will not fit. What has
  not been tried is varying detail by depth: the opening decision wants every
  bucket, while a player facing an all-in four seats later is choosing between
  folding and calling and needs far fewer.
- **No-draw-three is a real restriction, not just an abstraction.** Hands that
  would take three in a live game fold here. That was a deliberate call, and it
  is the one place the solve answers a slightly different game than the one
  being played.
