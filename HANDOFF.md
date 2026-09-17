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
| `lib/tree.js` | The betting tree, pre-draw through showdown |
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
