# NL27Solver

A solver and hand browser for **No Limit 2-7 Single Draw**.

Two tools over one engine:

- **Ranked starting hands** — all 7,462 of them by equity, in a four-colour
  deck, showing what each hand draws and which cards it throws.
- **Pre-draw strategy** — walk the betting tree a decision at a time and read
  the range at whatever depth the question is asked, priced in big blinds.

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

**Fixed limit triple draw** is started but not finished. `tripleDrawConfig()`
builds its tree — four betting rounds around three draws, one bet size a round
with a cap, and the size stepping up for the last two — and `npm run
measure:triple` prices it. Nothing solves it yet: the solver still assumes a hand
is drawn to once. `HANDOFF.md` has the numbers and what is left.

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
