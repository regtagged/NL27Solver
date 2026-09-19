# NL27Solver

A solver and hand browser for **No Limit 2-7 Single Draw**, and two smaller
games that are here so the machinery has something to be checked against.

Two tools over one engine:

- **Ranked starting hands** — all 7,462 of them by equity, in a four-colour
  deck, showing what each hand draws and which cards it throws.
- **Pre-draw strategy** — walk the betting tree a decision at a time and read
  the range at whatever depth the question is asked, priced in big blinds.

Two other games run on the same tree and the same evaluator: **all-in or fold
hold'em**, which has published solutions to disagree with, and **fixed limit
badugi**, which is small enough to solve with no hand abstraction at all. Both
are under "The other two games" below, and both are there for the same reason —
everywhere else in this repo the solver is the only thing with an opinion.

`docs/design.md` is the design and the reasoning. `HANDOFF.md` is the state of
play: what is settled, what is known to be wrong, and what is worth doing next.

No build step and no dependencies. Node 18+ is the only requirement.

## Running it

Build the hand table once (about two minutes):

```bash
npm run rank
```

Then serve it. The first solve is stored, so later starts load in seconds:

```bash
npm run browse -- --joint --players 6 --ante 0.25
```

- `http://localhost:43195/` — ranked starting hands
- `http://localhost:43195/strategy.html` — the pre-draw strategy browser

Useful flags: `--players`, `--stack`, `--sb`, `--bb`, `--ante`, `--ante-mode`,
`--iterations`, `--joint` (solve the draw and the post-draw street rather than
ending at the draw), `--algorithm cfr+|dcfr` (CFR+ by default, or Discounted
CFR), and `--fresh` (ignore a stored solve).

Two knobs on Discounted CFR, both of which change the answer rather than just
the speed, so each writes its own stored solve. `--beta` is how much of a
negative regret survives a discount step: at the paper's `0` a buried action
halves its debt every step for ever, so hands that should never be played keep
coming back at a few percent; the default here is `1`, which keeps the debt and
takes that residue to zero. `--explore 0.02` makes the sampler take a uniform
legal action 2% of the time, so a line the strategy avoids still gets trained —
without it a hand that opens 0% never learns how to play after opening, and so
prices opening as playing randomly and stays folded for the wrong reason.

Sizing: `--open 2.5` sets the open, and `--three-bet 7,9` adds a 3-bet short of
all-in — to 7bb from a seat in position and to 9bb from the blinds, beside the
jam rather than instead of it. The same size is used whether or not the open was
flatted. It costs: a sized 3-bet takes the six-handed tree from 65k nodes to
518k, nearly all of it after the draw.

`--also <stored solve>` serves a second structure beside the first — a comma
separated list for more — and the viewer switches between them. Each is its own
game with its own tree and its own sizes; switching keeps your place in the hand
by walking the same line, who acted and what kind of action, rather than by node
id, and says so when the other structure has no such line:

```bash
npm run browse -- --joint --players 6 --ante 0.25 --open 2.5 --three-bet 7,9 \
  --algorithm dcfr --iterations 10000000 \
  --also 6p-40bb-0.5_1-a0.25each-joint-dcfr-10M
```

In the viewer, a seat's box is a link back to that seat's own decision, and
every seat lists the whole of what it could do there — the action it took in
this line is marked, and the ones it passed up are still links, so a hand can be
walked back and sent down the other road. Colours say what an action is: grey
folds, green calls, amber opens, **red a 3-bet that is not all-in**, and
**purple all-in**.

## Checking it

```bash
npm test
```

```bash
npm run measure          # the hand space, recounted from the deck
npm run measure:tree     # the betting tree, and what a solve over it costs
npm run measure:buckets  # the hand abstraction, priced at each level of detail
npm run measure:triple   # what fixed limit triple draw would cost, before trying
npm run measure:badugi   # what each badugi prune is worth, and what a run costs
```

Every measurement script recomputes the numbers quoted in the design, so none of
them can quietly go stale.

```bash
node --max-old-space-size=8000 scripts/rfi.mjs --players 6 --ante 0.25 --joint
node --max-old-space-size=8000 scripts/converge.mjs --players 6
```

`rfi` reports raise-first-in by position — the number a player can check by eye —
and what snow candidates do at the draw. With `--stored 10000000 --algorithm dcfr`
it reads a solve the server saved instead of running its own. `converge` reads the same decision back
at rising iteration counts, which is how you tell a strategy that has settled
from one that is still moving.

```bash
node --max-old-space-size=8000 scripts/exploitability.mjs --players 6 --ante 0.25 --joint --algorithm dcfr
node --max-old-space-size=8000 scripts/exploitability.mjs --players 6 --ante 0.25 --joint --stored 3000000
```

`exploitability` is the measurement `converge` stands in for: how much each seat
could win by best-responding to the others' average strategy, summed over seats
(NashConv, in bb/100). The first form solves and measures at rising iteration
counts; `--stored` measures a solve the server already saved. It is a lower
bound, found on sampled deals and priced on fresh ones, and its deals are seeded
identically on every run, so two algorithms are compared on the same cards.

## The game as modelled

Seven- or six-handed, 40bb, blinds and ante configurable. Pre-draw an unopened
pot is raised 3x or folded — no limping and no open-shoving. The only 3-bet is
all-in, at most two players may flat an open, and a 3-bet shove cannot be
cold-called. After the draw: b25 / b100 / all-in out of position, b100 / all-in
in position, with all-in the only raise. Draws are pat, one or two.

Each of those is a deliberate pruning, and together they are what makes the tree
fit: unpruned it needed 204 GB, pruned it needs under one.

**Fixed limit 2-7 triple draw** is started but not finished. `tripleDrawConfig()`
builds its tree — four betting rounds around three draws, one bet size a round
with a cap, and the size stepping up for the last two — and `npm run
measure:triple` prices it. Nothing solves it *for 2-7* yet: `lib/solve.js` still
assumes a hand is drawn to once, and the hand abstraction has no
draws-remaining dimension. The tree itself is solved, by badugi, which needs no
abstraction to rebuild. `HANDOFF.md` has the numbers and what is left.

## The rules that make this game

All are in the tests, because all are easy to write wrong:

- **The ace is high only.** 5-4-3-2-A is not a straight — it is an ace-high
  hand, and a bad one. Nine straights in this game, not ten.
- **A flush counts against you.** 7-5-4-3-2 of one suit loses to every no-pair
  hand in the deck. The same ranks offsuit are the nuts.
- **Straights count against you too, and that changes which cards you keep.**
  8-5-4-3 makes an eight or better 12 times in 48 and cannot make a straight;
  7-5-4-3 manages 8 and bricks with any six.
- **A four-flush only counts against you if the card you are throwing is the
  offsuit one.** K-7-5-4-3 with the king in the suit is still drawing one to
  four of a suit, because the king goes in the muck either way.

## The other two games

Both are here for the same reason, and it is not that they are interesting to
play. Everywhere in the 2-7 solver, a strange answer has two possible causes —
the game is like that, or the abstraction is talking — and there is no way to
tell them apart. These two are built so that there is.

### All-in or fold hold'em

Every seat shoves or folds, and facing a shove calls or folds. That is 126
decisions over the 169 starting hand classes, and **nothing is abstracted**:
before a board is dealt, AhKh and AsKs differ only in which flushes they can
make, so the 169 classes are exact and the tree is the whole game.

It is the one place in this repo the machinery can be held against an answer
somebody else reached independently — push-fold at fifteen blinds has published
solutions, so **a disagreement with a published range is a bug**, not an
artifact.

```bash
npm run pushfold -- --players 7 --stack 15 --ante 0.6 --iterations 2000000
```

That writes `data/pushfold.json`, which `http://localhost:43195/pushfold.html`
reads — ranges as the 13x13 matrix, red for shoving and green for calling. The
page gets the same seat strip as the 2-7 strategy browser rather than a pair of
dropdowns, which is what reaches all 126 decisions including the multiway ones.

Hold'em hand strength was mostly here already: `eval27` scores five cards as a
high hand and 2-7 reads it backwards. The one real difference is the wheel,
which is the lowest straight there and deliberately not a straight here.
`lib/holdem.js` adds that case and the best five of seven, and the test that
pins it is the category counts over all 2,598,960 five-card hands — a wheel
filed in the wrong place moves two of those numbers.

Unlike `lib/solve.js`, this walks the whole betting tree rather than sampling
the opponents' actions. With 126 nodes that costs 16% more an iteration, because
seven hold'em evaluations already dominate, and what it buys is that every
decision sees every deal.

### Fixed limit badugi

Four cards a seat, three draws, and the lowest four cards of distinct rank and
distinct suit wins. It runs on the fixed limit triple draw tree — the same
`tripleDrawConfig()` 2-7 cannot yet use — because badugi is the game that fits
in it.

**It needs no hand abstraction at all.** All 270,725 four-card hands collapse to
1,092 distinct values, which is fewer than a hold'em preflop solver's 1,326
combinations, so the solver runs on the hand itself. Not the hands, not the
draw, not the end of the hand: nothing here is approximated.

```bash
node --max-old-space-size=12000 scripts/badugi.mjs --players 3 --iterations 10000000
```

or `npm run badugi -- --players 3`, which is the same thing with the heap flag
already set. It writes `data/badugi-<n>p.json` at every milestone rather than at
the end, so a run that is stopped early is still worth something, and prints the
decisions a player actually looks up — who opens what, who continues against it,
and what each seat does on the first draw.

How *many* cards to draw is the decision; *which* is not, and is settled by
keeping the subset whose own badugi is best. Measured over 4,000 hands drawing
one, that rule is never wrong when two keeps score differently.

#### Reducing, and why it decides a tie

**A hand can improve without making a badugi.** Holding A♠ 2♥ 6♦, ten clubs
complete a badugi — and the 3♦, 4♦ and 5♦ each replace the six with a lower
diamond, for a better three-card hand. That is *reducing*, and it means what a
keep can become is not the same question as what it is worth now.

It matters where two keeps tie, which is 18% of hands drawing one. Holding
A♥ 3♦ A♦ 3♠ every keep of three is a two-card A-3 and the score cannot separate
them — but A♥ A♦ 3♠ covers hearts, diamonds and spades and either ace can play,
so 33 cards make it a tri, against 22 for A♥ 3♦ A♦. The duplicate ace is dead to
the hand's value and live to its future. Ties break on distinct suits, then
distinct ranks.

This is badugi's version of what `lib/draws.js` does for 2-7, where a keep is
scored by what it draws to — the same reason 8-5-4-3 beats 7-5-4-3 there.

There is no badugi page yet. The 1,092 values already carry their labels and
combination counts, so ranking them is a page over data that is already
computed; it is in `HANDOFF.md` as backlog rather than as a plan.

```bash
npm run measure:badugi   # what each pruning is worth, and what a run would cost
```

Six-handed is affordable, which took a pruning nobody had applied to this game —
see `HANDOFF.md`.

#### Checking a badugi solve

```bash
npm run badugi:exploitability -- --players 6 --marks 500000,1500000
```

The same NashConv measurement `scripts/exploitability.mjs` makes for 2-7, and
it matters more here: the solver runs on the hand itself, so a number it reports
is the solve's own and not an abstraction's. Nothing else in this repo can say
that.

It prints opening frequency by seat beside the exploitability, because the two
answer a question neither answers alone. **Opens should widen from UTG to the
button** — that is what position is — and when they do not there are two
explanations that want opposite responses. A NashConv still falling steeply says
the information sets are starved and more iterations will fix it; one that has
settled while the ordering is still wrong says something is modelled wrong and
they will not.

For scale it also prints one published teaching range priced over the deck —
roughly 9 / 14 / 24 / 32 for UTG / HJ / CO / BTN. **That is one author's range,
not ground truth**; other published ranges disagree, and nobody has solved this
game. Read it as an order of magnitude. What every range set agrees on is the
direction, which is why the ordering is what the report asserts and the
percentages are only a band around it.

Two things to know before reading its output. The responder decides per *hand*,
and there are 1,092 of them, so it needs training deals in the tens of thousands
before it deviates anywhere at all — below that it reports a confident NashConv
of zero, which is a search that never started rather than a solve with nothing
to give away. And the seats run one after another rather than one to a thread,
because the strategy tables are 5.59 GB six-handed and a worker would need its
own copy.
