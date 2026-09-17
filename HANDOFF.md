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
| `lib/solve.js` | Monte Carlo CFR — external sampling, CFR+, linear averaging |
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
   Remaining candidates, in order: the benchmark is a proxy from other games and
   may be loose; the single 3x sizing gives no small 3-bet, so opening invites
   only call-or-jam; the tree has one raise size where a real game has several.
2. **Snowing is not demonstrated.** The joint solve makes it *possible* — the
   draw is a decision and the post-draw street is solved, which a rollout could
   never express. But the hands tested were the wrong ones: 2-2-5-5-8 and
   3-3-3-2-8 have three distinct ranks and simply draw two. The right candidates
   are full houses of low cards like 8-8-3-3-3, which have two distinct ranks
   and so can only fold or snow. **This has not been measured.** `scripts/rfi.mjs`
   now prints visit counts beside each line, which is what tells a learned
   strategy from an information set still sitting on its uniform start.
3. **Calling ranges facing a shove looked far too wide** at seven-handed, 27% of
   all hands against a 40bb jam. That was measured before several fixes and has
   not been re-checked. If it is still true, it inflates everything downstream.
4. **Convertibility is modelled but unverified.** J-5-4-3-2 can pat or draw one
   depending on what the seats before it did; the tree makes draws public and in
   order, so the solve *can* see it. Whether it does has not been measured.
5. **`setScoreTable` is process-global.** Calibrating the ranking changes what a
   finished hand is worth for anything else in the same process. The draw policy
   cache key now includes whether calibration has happened, which closes the
   trap that existed, but the coupling is still there and wants a parameter
   rather than module state.
6. **No 6-max / 7-max switching in the viewer.** One solve per server start.
   Both configurations store fine; the UI just cannot swap between them.

## How to trust a number

Do not read a strategy without checking it has converged. `scripts/converge.mjs`
reads the same decision back at rising iteration counts; a figure still moving
between checkpoints is not an answer. Seven-handed with the fine abstraction
never settled at all — 679 nodes against 3,463 buckets is 2.35 million
information sets — which is why the solver has its own coarse one.

The invariants worth keeping, all in the tests:

- Average equity over the whole deck is 50% heads-up and 33.3% three-way. Both
  players draw the same way from the same deck, so a random hand is a coin flip
  against another one. If the draw policy, the card removal, the showdown or the
  tie handling were wrong, neither number would land.
- Every pot pays out exactly what went into it. 400,027 showdowns were checked
  in the joint solver with zero deviation.
- The hand classes cover all 2,598,960 hands exactly once.

## What I would do next

1. **Measure the snow.** Run `rfi.mjs --joint` and look at 8-8-3-3-3 with its
   visit count. It is the cheapest open question and the answer is interesting
   either way.
2. **Re-measure the call-off width** facing a shove, now that open-shoving is
   gone and the ante is in. If it is still 27%, find out why before trusting any
   range.
3. **Add a second 3-bet size.** It is the most likely remaining explanation for
   the RFI gap, and the tree already supports sizes being a list.
4. **6-max / 7-max switching**, which is now mostly plumbing since solves store.
