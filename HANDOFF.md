# Handoff

Where this stands, what is known to be wrong with it, and what is worth doing
next. `README.md` is how to run it; `docs/design.md` is why it is shaped as it
is. This file is the honest state of play.

## What the pieces are

| File | What it does |
| --- | --- |
| `lib/cards.js` | Cards, parsing, the four-colour deck, seeded dealing |
| `lib/eval27.js` | 2-7 hand strength, direct and table-backed |
| `lib/draws.js` | What a draw is worth, and therefore which cards to keep |
| `lib/abstraction.js` | Hands to buckets for the viewer, and the draw options |
| `lib/ranking.js` | The 7,462 display rows, and which draw each hand takes |
| `lib/grouping.js` | The hierarchy a range is read in |
| `lib/coarse.js` | The abstraction the **solver** runs on — a few hundred |
| `lib/tree.js` | The betting tree: rounds, draws between them, no limit or fixed limit |
| `lib/rollout.js` | Fixed policy for a pre-draw-only solve |
| `lib/solve.js` | Monte Carlo CFR — external sampling, CFR+ or Discounted CFR |
| `lib/exploitability.js` | Best response per seat, and NashConv — how much a solve gives away |
| `lib/checkpoint.js` | Storing a solve so it is not paid for twice |
| `lib/browse.js` | Walking the tree, and grouping a node's range |
| `lib/equity.js` | Monte Carlo equity for the hand table |
| `lib/badugi.js` | Badugi hand strength, and all 1,092 values of it |
| `lib/badugi-solve.js` | Badugi solved on the hand itself, no abstraction |
| `lib/holdem.js` | Hold'em strength: the wheel, and the best five of seven |
| `lib/pushfold.js` | All-in or fold, walked exactly rather than sampled |

Two abstractions on purpose. The viewer wants every hand spelled out; the solver
wants as few distinct decisions as it can get, because each is an information
set needing thousands of visits. Reconciling them is one lookup: a display row
asks the solver's table which bucket it is in.

## Things that are settled, and why

- **The pruning is what makes it fit.** Unpruned the tree wanted 204 GB; pruned
  it wants under one. No limping, no open-shoving, at most two flat-callers, no
  cold-calling a 3-bet, draws capped at two cards. These came from the player
  the tool is for and should not be widened without a reason.
- **Suits only matter for the cards a hand keeps.** A four-flush only hurts if
  the offsuit card is the one being discarded. That is why K-7-5-4-3 splits
  1,008 / 16 and 7-5-4-3-2 splits 1,020 / 4.
- **Straights count against you, so the lowest four cards are often the wrong
  four.** 8-5-4-3 beats 7-5-4-3 as a draw. Keeps are chosen by measured score.
- **Standing pat is only offered with a queen or better**, in the *ranking*.
  The solver's tree still offers pat to everything, which is what allows a snow.

## Known to be wrong or unfinished

1. **RFI runs tighter than a strong human's estimate.** Six-handed, 40bb, 1.5bb
   dead: mine gives 18 / 22 / 27 / 39 for LJ / HJ / CO / BTN against a high
   stakes player's 25 / 32 / 39 / 50. The shape is right and the level is not.
   The joint solve did *not* close it, which killed the obvious explanation.
   Convergence did not close it either: a 10M-iteration Discounted CFR solve,
   measured at NashConv 22.0 bb/100 against 144.5 for a 3M CFR+ one, opens
   19 / 21 / 27 / 38 (SB 71%). Neither did sizing: a 2.5x open with a 3-bet to
   7bb in position and 9bb from the blinds, solved the same way, opens
   18 / 21 / 27 / 37 (SB 69%) at NashConv 25.5. The sized 3-bet is used - 4.3%
   of hands from the HJ, 4.8% squeezing, and UTG facing one folds 48%, calls 34%
   and jams 18% - so the tree was exercised and the ranges still did not widen.
   That leaves the benchmark itself as the first candidate: it is a proxy from
   other games, and nobody has solved the spot it describes. Below it: this is a
   40bb game where a real one is deeper, and the coarse abstraction shares one
   strategy across every hand in a bucket.

   Both of those solves were made at β=0. β=1 is now the default and reads a few
   points wider - mostly from marginal groups purifying rather than from new
   hands - so the numbers above are the old knob's, and the gap they describe is
   smaller than it was. Re-measure before quoting them.

   Reading those two NashConv figures against each other is weaker than reading
   them within one tree. The measure is a lower bound from a fixed search budget,
   and the sized tree is eight times the size, so the same budget finds
   proportionally less of what is there.
2. **Snowing is not demonstrated.** The joint solve makes it *possible* — the
   draw is a decision and the post-draw street is solved, which a rollout could
   never express. But the hands tested were the wrong ones: 2-2-5-5-8 and
   3-3-3-2-8 have three distinct ranks and simply draw two. The right candidates
   are full houses of low cards like 8-8-3-3-3, which have two distinct ranks
   and so can only fold or snow. **This has not been measured.** `scripts/rfi.mjs`
   now prints visit counts beside each line, which is what tells a learned
   strategy from an information set still sitting on its uniform start.
   Until September 17 its strategy columns printed `NaN` whatever the solve
   said - `Float64Array.map` coerced the formatted strings back to numbers - so
   no earlier reading of that table was a reading. Reading it now needs care:
   the solver strategy is per coarse bucket, 2-2-5-5-8 and 3-3-3-2-8 are the
   same bucket (`D2 85`), and 8-8-3-3-3 sits in `D3 38` with 7,568 hands that can
   draw, so at the draw it has no choice and its numbers are theirs.
3. **Calling ranges facing a shove looked far too wide** at seven-handed, 27% of
   all hands against a 40bb jam. That was measured before several fixes and has
   not been re-checked. If it is still true, it inflates everything downstream.
4. **Convertibility is modelled but unverified.** J-5-4-3-2 can pat or draw one
   depending on what the seats before it did; the tree makes draws public and in
   order, so the solve *can* see it. Whether it does has not been measured.
5. **Ten million iterations is not enough for the rarest buckets.** A bucket
   labelled with a low second card - `Pat J5` is J-5-4-3-2 and nothing else -
   holds one rank pattern, 1,020 hands, 0.039% of the deck. Six-handed at 10M
   the button faces it about 300 times, and 300 samples do not resolve a
   decision. J-5-4-3-2 read 78% / 100% / 75% / 100% across four solves; at 100M,
   with 3,124 visits, it reads 100% and Q-5-4-3-2 settles at 99% after bouncing
   16 / 0 / 43 / 77. Visits scale linearly with iterations, so this is a price
   rather than a puzzle: **70 minutes a sim instead of 8, for the best hands in
   the game to be right.** Exploitability will not tell you - at 0.04% of the
   range these hands cost nothing to get wrong, which is exactly why the solver
   leaves them and exactly why a reader notices.

   Not everything thin is starved. The jack-high *draws* get 5,000 to 24,000
   visits and are still unordered, because they are worth what folding is worth:
   -26 to -30 bb/100 against -25 for folding. That is indifference, not noise,
   and no amount of solving will order a tie.
6. **`setScoreTable` is process-global.** Calibrating the ranking changes what a
   finished hand is worth for anything else in the same process. The draw policy
   cache key now includes whether calibration has happened, which closes the
   trap that existed, but the coupling is still there and wants a parameter
   rather than module state.
7. **No 6-max / 7-max switching in the viewer.** `--also` switches between
   sizings of one game, but not between player counts: every view in a server
   has to have the same seats.

## How to trust a number

Do not read a strategy without checking how exploitable it is.
`scripts/exploitability.mjs` finds a best response for every seat against the
others' average strategy and reports what they could win by it, summed (NashConv,
bb/100). `--stored` measures a solve the server saved. `scripts/converge.mjs`
still reads the same decision back at rising iteration counts, but that is the
proxy this replaced, and a figure can stop moving while still being beatable.

The exploitability figure is a lower bound, and only comparable at the same
`--train` and `--evaluate`. The responder is trained on one seeded set of deals
and priced on another, and it deviates from the average strategy only where an
action beats it by more than two standard errors - without that gate it chased
noise and lost to the strategy it was responding to. More training deals find
more. Seven-handed with the fine abstraction never settled at all — 679 nodes
against 3,463 buckets is 2.35 million information sets — which is why the solver
has its own coarse one.

The invariants worth keeping, all in the tests:

- Average equity over the whole deck is 50% heads-up and 33.3% three-way. Both
  players draw the same way from the same deck, so a random hand is a coin flip
  against another one. If the draw policy, the card removal, the showdown or the
  tie handling were wrong, neither number would land.
- Every pot pays out exactly what went into it. 400,027 showdowns were checked
  in the joint solver with zero deviation.
- The hand classes cover all 2,598,960 hands exactly once.

## The algorithm, and what else could be tried

Monte Carlo CFR, external sampling. One iteration picks a traverser, deals a
table off a single deck, computes the value of every action at the traverser's
own decisions and samples one action everywhere else. Regrets accumulate at the
traverser; the average strategy accumulates at the other seats, which is what
converges. How regrets and the average accumulate is `--algorithm`: `cfr+`
(regret floored at zero, linear averaging - the default, unchanged) or `dcfr`.

**Discounted CFR is built and measured, and it is the better choice.** Six-handed,
40bb, 1.5bb ante, joint, same seed, NashConv in bb/100 (100,000 training deals a
pass, 300,000 to price):

| Iterations | CFR+ | DCFR, step every 10k | DCFR, step every 50k |
| --- | --- | --- | --- |
| 500k | 454.3 | 277.6 | 126.8 |
| 1M | 306.1 | 177.5 | 87.4 |
| 2M | 192.8 | 112.3 | 57.6 |
| 3M | 144.5 | 89.7 | **47.0** |

A third of the exploitability at 3M, at the same ~50 seconds a million. The step
size matters nearly as much as the algorithm: MCCFR has no full iterations, so a
DCFR "step" is `every` sampled iterations, and halving negative regret every 10k
forgets what a rarely-reached decision learned before it is visited again. 50k is
now the default. Larger steps have not been tried and the trend says they might
help. Heads-up told the same story (800k iterations: 17.5 vs 4.5).

**β is 1 here, not the paper's 0.** β decides how much of a negative regret
survives a discount step, which decides whether an action that should never be
played can climb back on a lucky sample. At β=0 it halves every step for ever, so
the debt is capped and the noise of a sampled iteration keeps beating it: hands
drawing three cards or more - never opens - stayed at 2.7% on the button at 10M.
At β=1 they go to 0.0%. It costs nothing in convergence. Six-handed 10M, same
solve, priced at 100,000 training deals: β=0 is 22.0 ± 0.5 bb/100 exploitable and
β=1 is -0.3 ± 0.7, which is a search that found nothing rather than a proof; with
three times the search β=1 prices at 3.3 ± 0.7. Exploitability here is a lower
bound and only means anything against another number found with the same budget.

Removing the residue also moves RFI, in both directions and for two different
reasons: junk leaving the range narrows it, and marginal groups purifying - a
74% open becoming 95% - widens it more. Six-handed the button went up by 2-6
points. That is a knob being turned, not the game being different; see the
caveat.

**Exploration, `--explore`, is the other half of it.** The average strategy only
accumulates where play actually goes, so a bucket that opens 0% never trains its
own post-draw decisions. Opening then gets priced as opening and playing
randomly, which is worse than folding, so it stays at 0% - and it stays there
whichever way round it should have been, which is how jack-high draws came out
unordered on the button. Post-open training weight for a never-opened bucket was
~10² against ~10⁸ for an opened one. `--explore 0.02` makes the sampler take a
uniform legal action 2% of the time, so every line keeps getting traffic while
the average still reports a clean 0% for the hands that fold. It is deliberately
not importance-weighted: the correct weighting gives an explored line weight
zero, which is the whole thing it is there to fix. The bias is O(ε).

What has *not* been checked is whether the lower exploitability moves any
number a player reads - RFI, the call-off width, the snow. The caveat below still
applies.

**The caveat first: an algorithm change makes this converge faster, it does not
make it a different game.** Nothing below will move RFI from 18% to 25%. That
gap is a question about the tree and about the benchmark, not about the solver.
Do not spend effort here expecting it to close.

Ranked by what they are worth against what they cost:

1. ~~**Discounted CFR.**~~ Done - see above. Positives discounted by
   `t^α/(t^α+1)`, negatives by `t^β/(t^β+1)`, the average weighted by `t^γ`,
   α=1.5, β=1, γ=2.
2. ~~**Exploitability.**~~ Done - `scripts/exploitability.mjs`. It is what
   made item 1 a measurement instead of a hope.
3. **Vectorised CFR instead of Monte Carlo.** The reason for sampling was 2.6
   million hands. The solver no longer reasons about 2.6 million hands; it
   reasons about 146 buckets, which is fewer than a hold'em preflop solver's
   1,326 combinations - and those run exact CFR, carrying a distribution over
   hands at every node and computing counterfactual values directly. No sampling
   variance, deterministic, typically far faster. The work is a 146x146
   bucket-against-bucket equity matrix with card-removal corrections. The coarse
   abstraction is what put this within reach; it was not an option before.
4. **Regret-based pruning.** Between 80% and 99% of hands fold here, so much of
   the tree is reached almost never. Skipping subtrees whose actions carry
   heavily negative regret, and revisiting them periodically, fits this game in
   a way it would not fit one with flatter ranges.

Considered and not worth it: outcome sampling (cheaper iterations, far higher
variance - external sampling is right at this size); public chance sampling (the
draw *counts* are public but the cards are not, so it does not fit); average
strategy sampling (helps with wide branching, and this has two to four actions).

Deep CFR would dissolve the abstraction problem entirely by generalising across
hands with a network rather than bucketing them. It is also a different runtime
and much harder to verify, and three silent modelling bugs in this project were
caught by checking invariants that a learned approximator would blur.

## Fixed limit triple draw, so far

The betting tree builds; nothing solves it yet. `lib/tree.js` now describes
betting *rounds* rather than two hardcoded streets - `drawRounds: 3` gives four
rounds around three draws, and `roundStreet(round)` says only which order a
round runs in. `betting: 'limit'` swaps the sizing model for one bet size a
round, a raise of the same size, a step up for the last two rounds, and a cap.
`tripleDrawConfig()` is the whole game in one object. The single draw game is
untouched: same 115,072 nodes seven-handed, same tree fingerprints, so every
stored solve still loads.

The cap is what bounds a limit tree, where stacks running out is what bounds a
no limit one - which is why the config is 200bb rather than 40bb. Depth costs a
limit tree nothing.

**Two walls, both measured** - `npm run measure:triple` prints them:

| draws | most drawn | nodes | growth |
| --- | --- | --- | --- |
| 1 | 2 | 1,070 | |
| 2 | 2 | 25,964 | 24x |
| 3 | 2 | **528,002** | 20x |
| 3 | 3 | **2,878,616** | 36x |
| 3 | 5 | over 3,000,000 | out of memory at 12GB |

Each draw round multiplies the tree by twenty to ninety times, because what
everyone drew is public and a state that forgets it is a different game. A
two-card ceiling heads-up is 528 thousand nodes, the same order as the sized
six-handed single draw tree that already solves.

The second wall is the deck. Replacements are dealt before the walk, so that a
hand comparing its actions compares them against one future rather than several,
and that needs `5 + 3 x maxDraw` cards a player: 40 heads-up at five cards a
draw, 60 three-handed, 66 six-handed even at two. **Triple draw is a heads-up
game for this solver, and that is the deck's decision rather than anyone's.**

What is not built is everything that solves it. `lib/solve.js` indexes a
post-draw hand as `optionBucket[seat * 3 + draws[seat]]` - one draw round, three
options, hardcoded - and `ranking.js`, `coarse.js` and `draws.js` all assume a
hand is drawn to once. The draw ceiling decides how much of that work there is.

## Six-handed triple draw, and why it is not a pruning problem

The tree builds and the game is described; what is missing is everything that
solves it. Before starting, know what it costs, because the measurements say it
is expensive in a way more pruning will not fix.

**The prunings that work, measured six-handed with one draw:**

| what | nodes |
| --- | --- |
| everything on | over 9,000,000 |
| no limping | over 9,000,000 |
| no limp, and cold calls from BTN/BB only | over 9,000,000 |
| **+ no cold calling a 3-bet: four-bet or fold** | **567,956** |
| and three bets a round instead of four | 32,523 |

**The third rule is the one that does the work**, and the first two are worth
almost nothing without it. That is not what an earlier version of this section
said: it claimed the first two were worth ninety times together, which was
measured against a tree where barring a seat from cold calling also barred it
from raising. That is not the rule - a seat that may not flat may still 3-bet,
which is the whole point of it - and fixing it moved the number from 97,933 to
over nine million. The prune that matters is the one that stops a *reraised*
pot going multiway, because that is the pot with the most money and the most
streets left.

It is still not enough for 2-7. Each draw round multiplies what is left by
about ninety, so three draws projects to hundreds of millions of nodes.
**Six-handed triple draw cannot be one exact tree**, and no further pruning
closes that.

**Badugi is the version of this that fits.** Four cards rather than five, and a
draw ceiling that is genuinely lower - three cards is a big-blind defence and
little else - so `2,1,1` covers the game where 2-7 wanted `3,2,2` or worse. With
all three rules above and three bets a round:

| players | nodes | cards of 52 |
| --- | --- | --- |
| 2 | 33,674 | 16 |
| 3 | 97,253 | 24 |
| 4 | out of memory at 11GB | 32 |

Three-handed badugi is smaller than the six-handed 2-7 tree that already solves.
And it needs no hand abstraction at all: all 270,725 four-card hands collapse to
**1,092 distinct values** (13 one-card, 78 two-card, 286 three-card, 715
badugis; only 6.3% of hands are a complete badugi). So like push-fold, and
unlike everything else here, a disagreement with a known answer would be a bug
rather than an artifact - which is what makes it worth solving.

Two things to fix before doing it. `positionNames(3)` calls the button UTG, so
a rule keyed on seat names - `coldCallSeats: ['BTN','BB']` - silently bars the
three-handed button from cold calling. And the draw ceiling is per round but not
per seat, which is what "only the big blind draws three" wants.

**Both of those are done**, and the table above is superseded by the one in the
next section - it was measured before the big blind got its own ceiling, which
costs a card and a branch and makes every number in it low.

**So the pre-draw and the draws have to be solved separately, and that costs
accuracy.** `lib/rollout.js` already does this for single draw: a fixed policy
plays the hand out so the pre-draw solve has a value at its leaves. The same
six-handed game solved both ways, 10M iterations with exploration:

| seat | draw played out | draw rolled out | difference |
| --- | --- | --- | --- |
| UTG | 19.4 | 19.5 | +0.1 |
| HJ | 23.9 | 22.1 | -1.8 |
| CO | 26.7 | 25.7 | -1.0 |
| **BTN** | **42.8** | **36.6** | **-6.2** |
| SB | 73.7 | 72.2 | -1.5 |

Early seats barely notice, because they fold nearly everything either way and
their value is decided before the draw. The button loses six points, because it
is the seat whose hands are worth what they are worth *for how they play after*
the draw, and a frozen script is exactly what takes that away. **That is with
one draw to approximate.** Triple draw would have the script covering three
draws and three betting rounds, so six points is a floor.

The honest route is the one `rollout.js` names in its own header: solve the
subgame, feed its values back, re-run, and watch whether the ranges stop moving.
Heads-up triple draw is affordable as an exact solve - 938,648 nodes at a 3,2,2
ceiling - so it can be the thing that produces those values instead of a
threshold table.

**What it would take.** The tree is done; the solver is not. `lib/solve.js`
indexes a post-draw hand as `optionBucket[seat * 3 + draws[seat]]` - one round,
three options, hardcoded - and needs to index a hand by its whole draw
*sequence*. Replacements for three rounds have to come off one deck. And the
hand abstraction has to describe a hand at four points in a hand rather than
one, which is the part nobody can cost until someone reads `ranking.js` and
`coarse.js` and decides whether a bucket can carry a draw stage. **Settle that
question first**: it is half an hour of reading, and it is the difference
between a first pass that is large and one that is twice as large.

## Six-handed badugi, priced

**It fits, and it took a prune nobody had applied to this game.** Six-handed
badugi is 534,848 nodes and 5.59 GB of strategy tables, which is the same order
as the sized six-handed 2-7 tree that already solves. `npm run measure:badugi`
prints everything below and recomputes it, so none of it can go stale.

The missing lever was `maxToDraw`, the cap on how many seats may voluntarily
enter. This file already calls it the most powerful lever there is - for 2-7 -
and it had simply never been turned on for badugi: `scripts/badugi.mjs` set
`maxToDraw: null`, which is why four-handed looked impossible. It now defaults
to 2 past three-handed, and takes `--max-to-draw`.

| players | nodes | strategy | cards of 52 |
| --- | --- | --- | --- |
| 2 | 44,894 | 0.47 GB | 17 |
| 3 | 119,695 | 1.25 GB | 25 |
| 4 | 228,171 | 2.39 GB | 33 |
| 5 | 366,555 | 3.83 GB | 41 |
| 6 | **534,848** | **5.59 GB** | **49** |

Capped at two entrants the tree grows **roughly with the square of the seat
count, not exponentially** - six-handed is twelve times heads-up, where each
extra seat at 2-7 multiplied. That is the whole reason this works: the cap fixes
how multiway the pot can get, so a seventh seat only adds the branch where it
folds. The cap does not bind below four-handed, so those two rows are the whole
game.

**The deck is not the wall here, unlike 2-7 triple draw.** Six-handed wants 49
of 52 cards - four a seat, plus 2,1,1 replacements and three for the big blind's
first draw. 2-7 needed 66 at the same seat count and that is what made it
heads-up only. Badugi's fourth card is the entire difference.

### What each prune is actually worth

Each line turns exactly one thing off, six-handed, so the number is what that
thing is paying for:

| six-handed | nodes | against baseline |
| --- | --- | --- |
| everything on | 534,848 | |
| anyone may cold call | 561,224 | +5% |
| cold calling a 3-bet allowed | 534,848 | **nothing at all** |
| limping allowed | over 6,000,000 | 11x or worse |
| no cap on who enters | over 6,000,000 | 11x or worse |

**Two of the three rules this file credits are worth nothing once the cap is
on.** `coldCallThreeBets: false` is worth *exactly* zero - not approximately,
identically - because with at most two voluntary entrants there is nobody left
to cold call a 3-bet, so the rule never fires. `coldCallSeats` is worth 5%. The
section above says the cold-calling rule "is the one that does the work", and
that was measured uncapped; capped, the cap has already done it. Keep them
anyway - they cost nothing and they are the right description of the game - but
do not go looking for savings there.

The knobs that do move it, all six-handed:

| knob | nodes | strategy |
| --- | --- | --- |
| 2 bets a round instead of 3 | 148,229 | 1.51 GB |
| 3 bets a round | 534,848 | 5.59 GB |
| 4 bets a round | 948,147 | 10.07 GB |
| one draw | 4,448 | 0.05 GB |
| two draws | 55,808 | 0.57 GB |
| three draws | 534,848 | 5.59 GB |

`maxToDraw: 1` builds 26 nodes and is **not a game**: a seat barred from
entering is barred from raising too, so with no limping the big blind cannot
even defend and every hand is a walk. That is `mayEnter` gating the raise as
well as the call, which is deliberate - if you want the pot you have to put it
up - but it means the cap has exactly one usable value here, and it is 2.

### What it costs to run

The memory is `2 x 1,092 hands x action edges x 4 bytes` - regret and average,
one float per hand per action at every decision - which is 639,598 edges and so
5.59 GB. `trackEv: true` adds another `2 x 1,092 x decisions x 4`, or 2.30 GB,
for the viewer's per-hand price column. `scripts/badugi.mjs` already passes
`trackEv: false`, and at this size that is not optional.

Measured after the blocks are allocated: **643 iterations a second six-handed,
so 10M iterations is 4.3 hours**, and 759/s three-handed. The rate during
the first few thousand iterations is two to three times lower, because
allocating a block costs more than using one - the run starts at ~200/s and
climbs as the tree fills in. Do not estimate from the first minute.

### The walls past this, and which is which

This file previously reported four-handed badugi as "out of memory at 11GB",
which conflated two different limits:

- **Building** four-handed uncapped is fine given a heap: 12,926,216 nodes in 67
  seconds at `--max-old-space-size=70000`. The old number was the builder
  hitting a 11GB *flag*, not a machine.
- **Solving** it is not, and never will be on one box: 12.9M nodes is **138 GB**
  of strategy tables. The tree fitting says nothing about the solve fitting, and
  at 1,092 hands a node the second number is the one that decides.
- **Six-handed at `maxToDraw: 3` cannot be built at all**, at any heap size. It
  fails with `Map maximum size exceeded` after 82 seconds - V8 caps a `Map` at
  2^24 entries, and `buildTree`'s `seen` map holds one per distinct state. So
  there is a hard ceiling of 16.7 million states in the builder that no amount
  of RAM moves, and going past it means sharding that map across several.

That last one is worth knowing before anyone tries to widen this game: the next
step up is not expensive, it is unreachable without a change to `buildTree`.

### The big blind's three-card draw was reading the wrong hand

**Fixed, and every badugi solve made before it is wrong on that line.** Worth
reading before trusting any earlier output, because it is silent and it lands
on exactly the line the big blind's exception exists to model.

`BadugiSolver` addresses a seat's hand-after-drawing as `depth * 36 + packed`,
where `packed` is the draw history in radix six, in a block 216 wide a seat. A
history of three draws packs to a number below `6 ** 3 = 216`, so depth three
alone needs the full 216 - and `3 * 36 + 115` is **223**, past the end of the
seat's own block.

Only one line reaches it: the big blind drawing **three** on the first draw,
which is the only seat allowed to, and then any legal second and third draw.
What that read depended on the seat count, and neither answer was a hand:

- **Heads-up**, the big blind is the last seat, so slot 223 is index 439 of an
  array 432 long. `handAfter[439]` is `undefined`, so the hand index is
  `undefined`, the regret and average offsets are `NaN`, and **every write to
  them was silently dropped** - that decision never learned anything and
  returned a uniform strategy for ever. Worse, `valueAfter[439]` is `undefined`
  too, and `payoff` compares `undefined < best`, which is false. A big blind
  that drew three **lost every showdown it ever reached, by construction.**
- **Three-handed and up**, it lands inside the *next* seat's block and reads
  that seat's hand instead.

So a solve will have learned that drawing three is close to the worst thing
available, and any reading of "the big blind almost never draws three" is the
bug talking rather than the game. The stride is now `6 ** rounds` with one block
a depth, and `test/badugi-solve.test.js` pins both that no reachable history
overflows and that no two of them collide.

Three things follow. Any stored `data/badugi-*.json` predating this is wrong on
the draw-three line and should be re-run rather than re-read. The fix changes
what the solver learns, so it is not comparable with earlier numbers. And the
general lesson is the one `lib/tree.js` already states about integer chips: an
index scheme whose bound is not asserted anywhere is one that will quietly go
out of range, and typed arrays return `undefined` rather than throwing.

### Which cards to throw was a tie-break away from right

`keepFor` settles which cards a draw throws - the strategy decides *how many* -
by keeping the subset whose own badugi is best. **Measured, that rule is never
wrong when two keeps score differently**: over 4,000 random hands drawing one,
the lowest-scoring keep was also the best draw every single time the scores
disagreed. The rule is sound.

What it could not do is break a tie, and ties are 18% of hands drawing one.
They happen because **a hand can improve without making a badugi** - the play
badugi calls *reducing*. Holding A♠ 2♥ 6♦, ten clubs make a badugi, and the
3♦, 4♦ and 5♦ each replace the six with a lower diamond for a better tri. So
what a keep can *become* is not what it is worth now, and `score` only sees the
second.

The clearest case is A♥ 3♦ A♦ 3♠. Every keep of three is a two-card A-3, so
`score` cannot separate them - but A♥ A♦ 3♠ covers hearts, diamonds and spades
and either ace can play, so 33 cards make it a tri, while A♥ 3♦ A♦ covers two
suits and 22 do. **The duplicate ace is dead to the hand's value and live to its
future.** Taking the first keep in subset order, as it did, cost 1.9 rank places
of 1,092 on average and up to 50.

Now broken by `reach` - distinct suits first, then distinct ranks - which costs
0.4 places. The exact tie-break, playing all 48 unseen cards out for every
candidate, costs nothing and is fifty times the work at a point the walk reaches
millions of times, so this is the cheap 79% of it. If the draw ever looks wrong
in a way this could explain, the exact version is a drop-in for `reach`.

This is the badugi counterpart of what `lib/draws.js` does for 2-7, where a keep
is scored by what it draws to rather than by what it is - the README's
"8-5-4-3 beats 7-5-4-3 as a draw". Badugi never got that treatment because its
keeps looked obvious, and 82% of the time they are.

### Opening ranges, and the one thing to check before the level

**Opens must widen from first position to the button.** That is what position
is, and it is the first thing to check about any badugi solve, before any
argument about level. A solve that opens the button tighter than UTG is wrong
whatever its exploitability says.

`lib/badugi-benchmark.js` prices one published teaching range over the deck for
scale - countingouts.com's - giving roughly 9% / 14% / 24% / 32% for
UTG / HJ / CO / BTN. **It is not ground truth.** It is one author among several,
other published ranges disagree in both directions, and nobody has solved this
game. It is also a six-handed cash standard where this is a 200bb limit game
with its own prunings, so even a perfect solve should not reproduce it.

Use it the way an order of magnitude is used. A solve opening 38% under the gun
is wrong on any reading; one opening 11% where this says 9% is a conversation.
What every range set agrees on is the direction, so the direction is what the
measurement asserts and the percentages are a band around it.

The deck is why the numbers are low at all: only 6.3% of hands are dealt a
complete badugi, 57% are three-card hands and 36% are two-card.

### Opens still run backwards six-handed, and the cause is not yet known

Six-handed on fixed code, exploring 2%, opening frequency by seat:

| iterations | UTG | HJ | CO | BTN | SB |
| --- | --- | --- | --- | --- | --- |
| 0.25M | 41 | 40 | 38 | 24 | 89 |
| 0.75M | 34 | 28 | 27 | 22 | 77 |
| 1.50M | 33 | 29 | 25 | 20 | 76 |
| 3.00M | 34 | 32 | 27 | 22 | 74 |
| 5.00M | 32 | 33 | 31 | 26 | 71 |

**Opens must widen from the first seat to the button**, and these do not. The
level is also about three times any published range. Both are open.

**Read the trend, not the last row.** Every seat behind the first is rising over
the last three marks - HJ 29 → 32 → 33, CO 25 → 27 → 31, BTN 20 → 22 → 26 -
while UTG is flat to falling and the small blind is falling steadily. The hijack
has already passed UTG by 5M. That is what a strategy converging towards the
right ordering looks like from below, and the button rising slowest is the
lesson this file already records for 2-7: the button is the seat whose hands are
worth what they are worth *for how they play after the draw*, and that is the
part that trains last.

**A four-handed NashConv reading was taken and is not strong enough to settle
it.** It falls 4.9 → -0.1 → -0.2 bb/100 by two million iterations while the
ordering stays inverted, which would ordinarily say "converged and still wrong".
But every seat in that run reported **still moving** at the six-pass cap - the
best response was changing its mind when it ran out of passes - and a search
that never settled reporting a gain of zero is a weak search, not a converged
game. `minimumDeals` is 30 against 1,092 hand values, so at 40,000 training
deals the root sees about 37 a hand and everything below it sees far less. Rerun
with more passes and more training deals before quoting that figure.

#### What the cap does, and it is not what was first written here

**The cap makes every pot heads-up, and that is worth four opponents to the
first seat and one to the button.** Counted off the tree - the most seats that
can still be in the hand at a showdown under each seat's open:

| opener | capped at two entrants | seats behind it | the cap removes |
| --- | --- | --- | --- |
| UTG | 1 | 5 | **4** |
| HJ | 1 | 4 | 3 |
| CO | 1 | 3 | 2 |
| BTN | 1 | 2 | **1** |

Multiway risk is most of what makes early position tight: an open that can be
called in four places needs a hand that is still good four ways. Take that away
and the first seat is being priced as though it had the button's problem, while
the button's own problem barely changes. **So the flat thirty-percent ranges are
what this game should produce**, and the seat the cap distorts least is the
button - which is also the one whose number looks most sensible against a range
a player would actually use.

That is a different argument from the one first written here, which said the cap
inverted position by leaving posted blinds unable to defend, and counted the
lines where that happens: 9 for UTG, 7, 5, 1 for the button. **That count is
real and it is not a mechanism.** Any quantity indexed by position is monotone
in position, and the dead money those lines create is shared by whoever is in
the pot rather than collected by the opener. The test in
`test/badugi-solve.test.js` pins the count as a fact about the tree.

The cap also does *not* reduce how many seats get a **chance** to contest an
open - it only bites once somebody has entered - so five can still answer UTG
and two the button. It is the size of the pot they can build, not the number of
them, that the cap takes away.

An earlier version of this section claimed the cap inverted position, on the
grounds that the lines where a posted blind is left unable to defend fall away
monotonically by opener - 9 for UTG, 7, 5, and 1 for the button. That count is
real and the test in `test/badugi-solve.test.js` pins it. **It is not evidence of
a mechanism.** Any quantity indexed by position is monotone in position, and the
dead money those lines create is shared by whoever is in the pot rather than
collected by the opener. The argument was a correlation dressed as a cause.

**Not ruled out: that barring a posted blind from defending is wrong anyway.**
Six-handed, 26 of 61 pre-draw decisions are a seat facing a bet with fold as its
only legal action, and 22 of those are a blind that has money in the pot
involuntarily. `mayEnter`'s own comment says a blind "is still owed its option",
and it is owed that only while fewer than `maxToDraw` seats have entered. That
is a modelling defect on its own terms, whatever it does or does not do to the
ordering.

The fix as written does not fit: `capExemptsBlinds` in `lib/tree.js`, default
off, lets a posted blind always answer a raise, and it is over nine million
nodes at four- and six-handed both, against 228,171 and 534,848. Worth pricing
instead: **cap cold entries only** - count the seats that chose to come in, so a
blind defending never counts against the cap. There are only two blinds, so the
pot stays bounded, and it may fit where full exemption does not.

#### What to do next, in order

1. **Checkpoint badugi solves.** `lib/checkpoint.js` is written against
   `lib/solve.js`, so a five-hour run cannot be measured afterwards without
   being redone. Everything below is gated on this.
2. **Run the exploitability properly** - more passes, more training deals - so
   "converged" and "still moving" can be told apart at all.
3. **Then take the ordering seriously.** If the later seats are still climbing,
   it is iterations. If NashConv has genuinely settled with the ordering still
   inverted, the modelling questions above are where to look.

### Badugi is a much tighter game than 2-7, and the deck says why

Half of 2-7 is dealt made. Badugi is dealt made one hand in sixteen.

| dealt | 2-7 (no pair, no flush, no straight) | badugi (a complete four-card badugi) |
| --- | --- | --- |
| any made hand | **50.16%** | **6.34%** |
| nine high or better | 2.04% | 1.12% |
| eight high or better | 0.71% | 0.62% |

Both numbers are recomputed from the deck by enumeration, not quoted. The top
of each game is comparably rare - a pat nine and a nine-high badugi are both
about one hand in fifty to a hundred - but **the base is eight times apart.**
In 2-7 a coin flip says you have already made something, however bad. In badugi
you are drawing 94% of the time, and drawing to a badugi is ten outs of 48,
about 21% a draw.

That is the whole reason a badugi opening range is a list rather than a
threshold. Two-card hands are 35.6% of the deck and the button opens **seven of
them** - A2, A3, 23, A4, A5, 24, 25 - which is 22% of the two-card hands and
7.8% of all hands. A holding that needs two more cards is close to unplayable
here, where in 2-7 the equivalent is a routine draw.

It also predicts the shape the solver could not produce. A game where most hands
are drawing and draws are thin is a game where position and pot size matter
more than usual, because a drawing hand needs to get paid when it hits and to
fold cheaply when it does not - which is exactly what the entry cap flattens by
making every pot heads-up.

### Presetting the opens buys exact subgames, up to two seats deep

If the opening ranges are fixed rather than solved, the spots after them can be
solved **with no entry cap at all** - which is worth doing, because the cap is
the one prune in this game whose effect on the answer nobody can characterise.

`buildTree(config, from)` now takes a state to build from, and `stateAfter`
produces one from a named line, checked against the same `legalActions` the tree
would have offered. Six-handed, uncapped, by how many seats still have a
decision once the opener has raised:

| seats still to act | line | nodes | strategy |
| --- | --- | --- | --- |
| 1 | folds to the big blind | 44,894 | 0.5 GB |
| 2 | folds to the small blind | 74,800 | 0.8 GB |
| 3 | folds to the button | 12,806,520 | 136.9 GB |
| 4 | folds to the cut-off | 12,836,428 | 137.2 GB |

**The cliff is between two seats and three, and it is a factor of 171.** A
looser cap does not soften it: `maxToDraw: 3` gives the identical numbers at
three and four seats, because with three behind the pot can only get four-way
anyway and a cap of three barely binds.

So, concretely:

- **Big blind defence: yes, exactly, against any opener.** 44,894 nodes and
  0.5 GB is the size of the whole heads-up game, which already solves in minutes.
- **The small blind's 3-bet: yes.** 74,800 nodes, 0.8 GB.
- **A 3-bet from the button, cut-off or hijack: no.** Three or more seats still
  behind is 137 GB of strategy tables, which is more than the machine has, and
  removing the cap is what caused that.

Those two affordable cases are not a small slice. Every "folded around to the
blinds" spot is in them, and that is where most of the hands that reach a draw
actually come from once opens are this tight.

**The piece that is missing, and it is not optional.** `BadugiSolver.run` deals
every seat uniformly from a full deck. A subgame built after "UTG opens" would
therefore have the big blind defending against a *random* hand rather than
against an opening range, and the answer would look entirely reasonable while
being about a different game. Solving from a fixed line requires dealing the
seats that have already acted from the range that action implies - weighted
sampling over the 1,092 values, or rejection sampling against the preset - and
that has to exist before any of the numbers above are worth computing.

The order of work, then: range-conditioned dealing first, then the big blind
defence subgame as the cheapest exact thing this repo can produce, then the
small blind's 3-bet. The three-seat spots stay capped, or wait for values fed
back from the subgames below them - which is the iterate-the-subgames route
`lib/rollout.js` names in its own header for 2-7, and is the same answer here.

### Before trusting a number out of it

A six-handed smoke run, opening frequency for UTG / HJ / CO / BTN / SB:

| iterations | UTG | HJ | CO | BTN | SB |
| --- | --- | --- | --- | --- | --- |
| 100,000 | 53 | 57 | 56 | 31 | 82 |
| 200,000 | 38 | 38 | 34 | 23 | 90 |

**Those are not results**, and the table is here to show why rather than to be
read. Every number moved by fifteen to twenty points on one doubling, and the
button is tighter than UTG in both rows, which is backwards. That is the
signature this file already names: an information set that has not been visited
enough still sits on its uniform start, and a few hundred thousand iterations
over 534,848 nodes is a handful of visits each. The run was a smoke test that
the six-handed config solves at all, and that is all it established.

So the same discipline as 2-7 applies before any of it is read: exploitability
rather than eyeballing, `--explore` so lines the strategy avoids still train,
and visit counts printed beside any strategy that gets quoted. There is no
`exploitability.mjs` for badugi yet - `lib/exploitability.js` is written against
the 2-7 solver - and that, not more iterations, is the thing to build first.

### A mixed frequency is a claim, and it is checkable

The 40M btn-bb solve plays a monotone ace - four cards of one suit - as a
51/49 three-bet. Standing at the table that reads as a mix. It is not one: the
button folds to a three-bet **0%** of the time, so the extra bets go in dead
with a one-card hand, and forcing the action to see what each is worth gives
call **-87**, raise **-104**, a gap of 16 +/- 7 bb/100. The frequency had not
converged. A hand dealt 0.3% of the time is sampled 0.3% of the time, and where
the regret difference is smaller than the noise in those samples the average
strategy never settles - it wanders, and the wandering is what gets printed.

`scripts/badugi-action.mjs` prices one hand: deal until the seat holds it, force
each action, play the rest out of the average strategies on the same cards.
`scripts/badugi-sweep.mjs` does the whole first decision in one pass - deal, play
every action, file the result under whatever the big blind was dealt. Two million
deals is under four minutes. Differences are paired through the covariance rather
than treated as independent, which would overstate the error by about half.

At the root, of 112 classes: **83 settled, 13 measurably off, 16 too rare to
judge**. Weighted by how often they are dealt, the thirteen give up **0.9 bb/100**
of a decision worth -55.4 - so the shape is right and the boundary is not. The
sweep reconstructs -55.4 against `badugi-ev.mjs`'s independent -55.7 +/- 0.9,
which is the check that the two code paths describe the same game.

The errors have a direction. High tris **over-fold** (J-high folds 27% where
calling is better by 8, Q-high 34% by 3); three junk two-card holdings
**over-call** (29, 49, 4K, losing 12 to 19 against folding); a few hands raise
where they should call (6- and 7-high tri, J-high badugi, A3). The genuine mixes
look different and survive: Q-high badugi at 34/66 and K-high at 43/57 measure
2 +/- 8 apart, which is what indifference looks like from the inside.

**This retracts something.** The composition of the three-bet-and-pat range is
sound - 97.5% real badugis, with J-K-high badugis doing the fold-equity work at
59% of it - but the pure bluffs in it were reported as two-card 29/39/4T, and
those hands measure as losing defends before they ever get to pat. The tail was
a frequency that had not settled, quoted as strategy.

The discipline that follows: **do not read a rare class's frequency without
pricing it.** Exploitability says a strategy is close overall; it does not say
which rows in the table are real, and the thin rows are exactly the ones a
reader finds interesting.

### What the reports carry now, and the snow

`lib/badugi-report.js` holds the walk and the file shape, so a report can be
regenerated from a checkpoint without re-solving - `scripts/badugi-report.mjs`,
which never writes a checkpoint. Two things came with it.

**Reach.** Every spot carries the weight each hand has when the line arrives:
the preset range it had to be in, times that seat's own choices along the way.
Without it the class summaries average in strategies the seat never plays - the
button folded every queen-high tri before the first card was drawn, and those
rows were trained on exploration traffic. It moved the first draw from
`pat 8.3%` to `pat 1.8%`. The product is only sound while the seat has not
drawn: a hand's strategy is indexed by its value and drawing changes the value,
so reach is dropped at the first card taken and the viewer says so. What is left
there is which hands the solve ever saw at that node, which still removes the
impossible ones.

**Branches.** The walk follows the calls, so it never reaches a hand that
three-bets and then stands pat - and that hand is the snow. `lib/badugi-spots.js`
names two of them for `btn-bb`, and `scripts/badugi-snow.mjs` finds the hands by
playing deals out.

Measured over 250,000 deals: the big blind three-bets 10.4%, draws one half the
time, misses 79% of those, and pats 7.3% of the misses. **Which misses pat is
the finding.** A ten-high tri pats 49% and a jack-high 74%, and once they pat
they never draw again (519 of 540); a four- or five-high tri pats under 2%. The
rule is that a hand snows when its *draw* is worthless, not when its *hand* is:
a ten-high tri that hits makes a ten-high badugi that loses to the calling range
anyway, while a five-high tri that hits wins the pot. A monotone hand - which
can never be a badugi, and is the hand a player would guess snows - pats **0%**
of the time at every node where it is live, because an ace with three fresh
cards is the best draw in the deck.

## What I would do next

1. **Measure the snow.** Run `rfi.mjs --joint` and look at 8-8-3-3-3 with its
   visit count. It is the cheapest open question and the answer is interesting
   either way.
2. **Re-measure the call-off width** facing a shove, now that open-shoving is
   gone and the ante is in. If it is still 27%, find out why before trusting any
   range.
3. ~~**Re-read RFI on a DCFR solve.**~~ Done: 19 / 21 / 27 / 38 at NashConv 22,
   so the gap is not convergence.
4. ~~**Add a second 3-bet size.**~~ Done, and it did not move RFI - see above.
   `--open` and `--three-bet` set the sizing, and `--also` serves a second
   structure beside the first, which the viewer switches between - the way to
   see what a sizing changed, a line at a time.
5. **Try a larger DCFR step** (100k, 200k) with `--every`; 10k to 50k was worth
   more than CFR+ to DCFR.
6. **6-max / 7-max switching**, which is now mostly plumbing since solves store.
7. **Re-key the draw buckets on outs, not on the best hand they could make.**
   A draw bucket is named for the best hand its keep could finish as, which is
   not how often it finishes. `D1 76` spans 4 to 12 outs of 48, because 7-6-5-4
   makes a seven only with a deuce - the three and the eight are both straights -
   while 7-6-3-2 has the full twelve. They share a bucket and therefore a
   strategy. 14% of draw-one combos sit in a bucket whose keeps disagree like
   that, and it is why the EV column reads backwards: `D1 85`, whose four keeps
   all have twelve outs, prices above `D1 76`, whose name sounds better. The
   readme already says the same thing about single hands - 8-5-4-3 beats 7-5-4-3
   as a draw - so the abstraction is disagreeing with the design.

   Adding the outs to the key is a **strict refinement**: it splits the six
   buckets that were lying and merges nothing, so every distinction that exists
   today survives. Measured, draw-one goes from 26 buckets to 32 and the total
   from 146 to 152.

   Draw-two has the same key and the same fault, more widely and far less badly:
   29% of its combos are in a mixed bucket, but the worst is `D2 76` at 3 to 6
   rank pairs of 45 - a 2x spread against draw-one's 3x - and most are 1.2x.
   Splitting those as well is 26 buckets to 34. Worth doing for draw-one; for
   draw-two, only where the spread reaches 2x.

   It invalidates every stored solve, which is safe rather than dangerous -
   `load` already refuses on a bucket count mismatch, so nothing silently
   mis-reads - and re-solving the four that are actually served is about an hour
   and forty minutes, most of it the 100M one. `HANDOFF.md` quotes 146 twice in
   the vectorised CFR argument, where the number is the size of an equity matrix
   and would become 152.
8. **A hand ranking page for badugi**, the way `index.html` ranks the 7,462 2-7
   hands. Shelved on purpose rather than forgotten: the 1,092 values already
   exist in `lib/badugi.js` with their labels and combination counts, so this is
   a page over data that is already computed, and the solve is worth having
   first. Badugi is easier to rank than 2-7 - size then lowness, with no draw
   policy to agree on - so most of `lib/ranking.js` has no counterpart here.
9. **Exploitability for badugi**, before six-handed is run for real. Four hours
   of solving produces a strategy nothing can currently check: the smoke run
   above opens the button tighter than UTG, which is either a starved
   information set or a bug, and there is no measurement in the repo that tells
   those apart for this game. `lib/exploitability.js` is written against
   `lib/solve.js` - coarse buckets, one draw, `optionBucket[seat * 3 + draws]` -
   so this is a second implementation against `BadugiSolver`, not a parameter.
   It is the one thing worth building before the long run rather than after it,
   because badugi is the game whose whole purpose is being checkable.
10. **Sweep the later decisions the way the first one is swept.** `badugi-sweep.mjs`
   prices the root only, and the root is the decision with the most traffic - the
   draws and the post-draw betting are thinner and have had no such check. The
   walk generalises: force the action at any node and play the rest out. What it
   needs is a way to condition the deal on arriving there, which for anything
   past a draw is rejection sampling and therefore slow.
11. **Shard `buildTree`'s `seen` map** if the game ever needs to be wider than
   `maxToDraw: 2`. V8 caps a `Map` at 2^24 entries and six-handed at
   `maxToDraw: 3` hits that ceiling after 82 seconds, at any heap size. This is
   only worth doing if something actually needs it - and note that the tree
   fitting is not the question, since 12.9M nodes is 138 GB of strategy tables
   at 1,092 hands a node, so the solve would not fit on one machine anyway.
