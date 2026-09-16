# Design

What this solver is, and why it is shaped the way it is. The README is how to
run it.

## The game being solved

No Limit **deuce-to-seven** Single Draw, seven-handed, stacks capped at 40bb.
Blinds and ante are inputs.

Pre-draw the action set is deliberately narrow:

| Facing | Actions |
| --- | --- |
| Nobody in | fold, raise to 3x, all-in |
| An open, fewer than two callers | fold, call, all-in |
| An open, two callers already | fold, all-in |
| A 3-bet shove, having already put money in | fold, call |
| A 3-bet shove, cold | fold (or 4-bet jam, with chips to do it) |

The only 3-bet size is all-in. That is a real simplification but not a damaging
one at 40bb, where a 3-bet-to-9bb-and-fold line barely exists in this game.

Limping, unlimited callers and cold-calling a 3-bet are all switched off by
`allowLimp`, `maxOpenCalls` and `coldCallShoves` in the config. They are not
cosmetic: turning them back on is the difference between a tree that fits in
0.9 GB and one that needs 204 GB.

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

On the unpruned tree that was far more detail than a solve could hold, and the
whole of the next two sections was about getting round it. On the pruned tree it
is affordable outright.

## What the tree costs, and what pruning did to it

Two measurements, and the second overturns the first.

**As first specified** — limping allowed, any number of callers, cold calls of
3-bets permitted — the seven-handed 40bb tree was **1,208,412 nodes**. Node count
was never the problem; the memory a solve needs is decisions times actions times
buckets times the two float accumulators CFR keeps per action, and at the 16,757
classes the hand space supports that came to **204 GB**. Nothing rescued it: even
200 buckets wanted 2.4 GB, and 200 buckets cannot tell a pat eight from a
one-card draw to a seven.

**Then the tree was pruned** to how the game is actually played, by three rules:

- **No limping.** An unopened pot is raised or folded. Limping is the branchiest
  action in the game — it keeps every player in and hands the next seat the same
  decision over again.
- **At most two callers of the open**, which bounds how multiway a pot can get,
  and multiway is what the post-draw street costs the most on.
- **No cold calls of a 3-bet.** The only 3-bet is a shove, so a player with no
  money in voluntarily may 4-bet jam or fold. The opener — and anyone who already
  called the open — is not cold, and may still call.

|  | Unpruned | Pruned |
| --- | --- | --- |
| Nodes | 1,208,412 | **6,392** |
| Pre-draw decisions | 49,796 | **679** |
| Post-draw decisions | 709,839 | **2,562** |
| Both streets, 16,757 classes | 204.2 GB | **0.9 GB** |
| Build time | 4.2 s | 22 ms |

A 227-fold reduction in what a solve has to hold, and the 0.9 GB is at the
*finest* grouping the hand space supports — no detail ceilings at all.

## The streets no longer have to be solved apart

Splitting the solve — pre-draw over the whole tree with a rollout standing in
for everything after the draw, post-draw subgames solved singly on demand — was
the only thing that fit in 204 GB. It is not needed at 0.9 GB.

That matters for more than memory. A split solve pays for itself twice: the
rollout policy biases the pre-draw strategy, and the subgames are then solved
against a pre-draw range that was shaped by that bias. Solving both streets
together removes the bootstrap and with it the bias, and it is what was asked
for in the first place.

The rollout in `lib/rollout.js` still earns its place as the terminator for a
pre-draw-only run, which is what the solver does today. Making the draw a
decision rather than a policy, and running CFR through the post-draw street, is
the next piece of work.

## The draw: pat, one, or two

Thirty-two discard subsets per hand is far more than a player considers, and
most are dominated outright. Three options are offered:

- **Stand pat.** Always available to every hand, which is what makes snowing
  fall out of the solve rather than needing to be hand-coded — if standing pat
  with a broken hand shows a profit, CFR will find it.
- **Draw one**, keeping the best four ranks.
- **Draw two**, keeping the best three. Which four, and which three, is measured
  rather than assumed — see below.

**Drawing three or more is not offered.** Players stand pat or take one, and
take two only from the big blind or as a late-position opener in a single-raised
pot; the third card would buy a large abstraction for a line that is rarely
correct. The cost is real and worth naming: a hand like A-K-Q-8-6 would draw
three in a real game and here cannot, so it is simply a fold.

### Which four cards to keep

The obvious rule — keep the lowest distinct ranks — is **wrong**, and wrong for
a reason peculiar to this game. Straights count against you, so the smoothest
four cards in a hand can be the worst four to hold. Enumerated over all 48
replacements:

| Keep | Makes an 8 or better | Straight outs |
| --- | --- | --- |
| 7-5-4-3 | 8 / 48 | **4** — any six |
| **8-5-4-3** | **12 / 48** | **0** — cannot make one |
| 7-6-5-4 | 4 / 48 | **8** — any three or eight |

8-5-4-3 makes a good hand half again as often as 7-5-4-3 and has no straight to
brick into; all 7-5-4-3 holds over it is the four deuces that make the nuts. And
7-6-5-4, which looks like the best four cards a hand could contain, is a trap:
it makes an eight twice as rarely as it makes a straight.

So the keep is **chosen by score** in `lib/draws.js`, not by position. A hand
holding 4-5-6-7-9 keeps 4-5-6-9 and throws the seven. A pair is never held back.
Where a rank is duplicated the keep takes the copy that breaks a flush, which is
why flush risk survives only on cards genuinely stuck in one suit.

Choosing is done on ranks alone and flush risk is scored afterwards. A
three-flush kept on a two-card draw backs into a flush about 4% of the time,
which almost never changes which subset is best, and leaving it out of the
choice lets the decision be cached per rank-set instead of per hand.

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
- `lib/draws.js` — what a draw is worth, and therefore which cards to keep.
- `lib/rollout.js` — the draw, one round of post-draw betting under a fixed
  policy, and the pot split, side pots included.
- `lib/solve.js` — MCCFR over the pre-draw tree, with CFR+ regret flooring and
  linear averaging.
- `test/` — the rules that are easy to get wrong, pinned.

## Where the solver actually is

`npm run solve` runs it. Seven-handed at 40bb, twenty million iterations take
about seven minutes at ~45,000 a second and hold **30 MB**.

Opening ranges come out monotone in hand strength and read like poker: from the
small blind the nuts never folds, a pat nine folds 3%, a pat ten 18%, and
K-Q-J-9 — which is a pat king with no draw under it — folds 96%.

Before the pruning this did not work at all. The unpruned tree had 49,796
pre-draw decisions against 3,463 buckets, or 172 million information sets, and
the opening seats are reached only when everyone before them folds; a million
iterations left most of their buckets never visited and still showing the
uniform strategy they started with. Pruning cut the pre-draw decisions to 679,
which is what made seven-handed converge in minutes instead of hours.

Two standard improvements did the rest, and neither is tuning: **CFR+ regret
flooring**, so an action that looked bad early stops dragging a debt behind it,
and **linear averaging**, so later iterations count for more. Before them the
same run gave strategies that were not monotone in hand strength, with the worst
hand in the ladder limping 81%.

## What is next

1. **Solve both streets together**, now that they fit. The draw becomes a
   decision rather than a fixed policy, and CFR runs through the post-draw
   betting instead of a rollout standing in for it. This is the piece that makes
   the b25 / b100 / bAI sizes real rather than modelled.
2. `serve.js` and `public/` — entering a configuration and browsing the result.
3. Checkpointing, which is no longer urgent at seven minutes a run but will be
   once the post-draw street is in the same solve.

## The open risks, honestly

- **Seven-handed convergence is unproven here.** Multiway CFR converges to
  something, but "something" is not guaranteed to be the equilibrium in a game
  with more than two players. Results want reading as a strong strategy, not as
  a proof.
- **The rollout policy biases the pre-draw solve.** Terminating pre-draw lines
  under a fixed post-draw policy means the pre-draw strategy is only as good as
  that policy. The fix is to iterate — solve subgames, feed their values back as
  the rollout, re-run — and whether that converges usefully is untested.
- **The pruned game is a narrower game than the one being played.** No limping,
  at most two callers, no cold-calling a 3-bet: each is defensible and each
  removes lines that occur at a real table. This is the largest single
  assumption in the project, and it is the one that bought everything else.
- **The keep is chosen by a heads-up-ish yardstick.** `bestKeep` scores a draw by
  how often it beats a ladder of benchmark lows, which says nothing about how
  many players it has to beat. Multiway, nut potential is worth more than the
  ladder credits — 7-5-4-3 makes the nuts with a deuce where 8-5-4-3 can never
  do better than an eight. The seven-handed solve does appear to value 7-5-4-3
  above 8-5-4-3 despite the ladder scoring them the other way round, which is
  either that effect showing up or noise, and is worth telling apart.
- **No-draw-three is a real restriction, not just an abstraction.** Hands that
  would take three in a live game fold here. That was a deliberate call, and it
  is the one place the solve answers a slightly different game than the one
  being played.
