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
7. **A hand ranking page for badugi**, the way `index.html` ranks the 7,462 2-7
   hands. Shelved on purpose rather than forgotten: the 1,092 values already
   exist in `lib/badugi.js` with their labels and combination counts, so this is
   a page over data that is already computed, and the solve is worth having
   first. Badugi is easier to rank than 2-7 - size then lowness, with no draw
   policy to agree on - so most of `lib/ranking.js` has no counterpart here.
