/**
 * The decisions a solve writes out for the viewer, and what arrives at them.
 *
 * Two things live here rather than in the script that solves, because a report
 * is worth regenerating without a forty-hour run behind it: the walk that picks
 * which decisions to report, and the shape of the file itself.
 *
 * **Reach is the part that matters.** A decision's table is a strategy - what
 * each hand does *given that it is here* - and the row above it, the class
 * summary, is an average over hands. Averaging by how often a hand is dealt
 * answers a question nobody asked: the button cannot hold a queen-high tri at
 * any of these nodes, because it folded that hand before the first card was
 * drawn, so weighting its rows by the deck mixes a strategy it never plays into
 * the number a player reads. So every spot carries the weight each hand has
 * when the line arrives - the preset range it had to be in, times this seat's
 * own choices along the way.
 *
 * That product is only sound while the seat has not drawn. A hand's strategy is
 * indexed by its *value*, and drawing changes the value: multiplying "this
 * value raised" by "this value patted" after a draw multiplies together two
 * numbers about different hands. So reach is carried until the seat draws a
 * card and is dropped from then on - `reach: null`, and the viewer says the
 * table is weighted by the deck instead of guessing.
 */

import { DRAWING } from './tree.js';

/** Matches an action the way a player names it: `call`, `bet`, `pat`, `d1`. */
function actionIndex(node, want) {
  return node.actions.findIndex((a) => a.kind === want || a.label === want
    // `bet` and `raise` are the same act at different points in a round.
    || (want === 'bet' && (a.kind === 'bet' || a.kind === 'raise')));
}

const ORDINAL = ['first', 'second', 'third', 'fourth'];

/**
 * What to call a decision, in the terms the line is discussed in.
 *
 * A betting node with a fold in it is one facing a bet; one without is a seat
 * opening the round. They are different decisions and were both called "facing
 * the bet" before there were branches to tell them apart.
 */
function describe(node, names, drawsSoFar) {
  if (node.street === DRAWING) {
    return `${names[node.seat]} ${ORDINAL[drawsSoFar] ?? `draw ${drawsSoFar + 1}`} draw`;
  }
  return node.actions.some((a) => a.kind === 'fold')
    ? `${names[node.seat]} facing the bet`
    : `${names[node.seat]} first to act`;
}

/**
 * Where each hand stands when the line arrives, per seat.
 *
 * Starts at the seat's preset range - zero for a hand it would have folded
 * before the subgame began - and is multiplied by the seat's own action
 * probabilities as the walk passes its decisions.
 */
function newReach(solver) {
  const reach = new Map();
  for (const seat of solver.live) {
    const start = new Float64Array(solver.handCount).fill(1);
    const preset = solver.presetRanges ? solver.presetRanges[seat] : null;
    if (preset) for (let h = 0; h < solver.handCount; h += 1) start[h] = preset[h] ? 1 : 0;
    reach.set(seat, start);
  }
  return reach;
}

/**
 * Walks one line from the root, reporting every decision on it.
 *
 * `choose` picks the action at each node and returns -1 to stop, which is how
 * the main line follows whatever continues and a branch follows what it was
 * asked for. A node already reported is walked through rather than written
 * twice: the two snow branches share their first two decisions, and a decision
 * is the same decision whichever line arrived at it.
 */
function walkLine(solver, { choose, limit, names, branch = null, seen, found }) {
  const reach = newReach(solver);
  const drew = new Set();
  const drawsBySeat = new Map();
  const path = [];
  let id = solver.tree.root;

  for (let step = 0; step < limit && id >= 0; step += 1) {
    const node = solver.nodes[id];
    if (!node || node.kind !== 'decision') break;
    const at = choose(node, step);
    if (at < 0) break;

    if (!seen.has(id)) {
      seen.add(id);
      found.push({
        id,
        what: describe(node, names, drawsBySeat.get(node.seat) ?? 0),
        seat: node.seat,
        drawing: node.street === DRAWING,
        branch,
        path: path.join(' · '),
        // Null once this seat has drawn: see the note at the top.
        reach: drew.has(node.seat) ? null : Array.from(reach.get(node.seat),
          (v) => Number(v.toFixed(4))),
      });
    }

    const action = node.actions[at];
    const mine = reach.get(node.seat);
    if (mine && !drew.has(node.seat)) {
      for (let h = 0; h < solver.handCount; h += 1) mine[h] *= solver.averageAt(id, h)[at];
    }
    if (node.street === DRAWING) {
      drawsBySeat.set(node.seat, (drawsBySeat.get(node.seat) ?? 0) + 1);
      // Patting keeps the hand it had, so the product above still holds; taking
      // a card does not, and reach stops here for this seat.
      if (action.option > 0) drew.add(node.seat);
    }
    path.push(`${names[node.seat]} ${action.label}`);
    id = action.child;
  }
}

/**
 * The decisions worth writing down.
 *
 * The main line is the one everybody continues on - call, check, whatever the
 * first action is - because that is where the reads are. `branches` are lines
 * asked for by name, for the spots that are interesting precisely because
 * nobody continues on them: a hand that three-bets and then stands pat is
 * telling a story about a hand it does not have, and no walk that follows the
 * calls will ever arrive there.
 */
export function walkSpots(solver, { follow = null, branches = [], names }) {
  const seen = new Set();
  const found = [];

  walkLine(solver, {
    names,
    seen,
    found,
    limit: 8,
    choose: (node, step) => {
      const first = step === 0 && follow ? actionIndex(node, follow) : -1;
      if (first >= 0) return first;
      const call = actionIndex(node, 'call');
      if (call >= 0) return call;
      const check = actionIndex(node, 'check');
      return check >= 0 ? check : 0;
    },
  });

  for (const branch of branches) {
    walkLine(solver, {
      names,
      seen,
      found,
      branch: branch.name,
      limit: branch.steps.length,
      choose: (node, step) => {
        const at = actionIndex(node, branch.steps[step]);
        if (at < 0) {
          throw new Error(`"${branch.steps[step]}" is not legal for ${names[node.seat]} `
            + `in "${branch.name}"; offered ${node.actions.map((a) => a.label).join(', ')}`);
        }
        return at;
      },
    });
  }
  return found;
}

/** The file the viewer reads: the spots, and enough context to read them by. */
export function buildReport(solver, { key, what, line, config, preset, labels, combos,
  names, watched, final }) {
  return {
    built: new Date().toISOString(),
    spot: key,
    what,
    line,
    config,
    preset,
    iterations: solver.iterations,
    complete: final,
    names,
    labels,
    combos: Array.from(combos),
    spots: watched.map(({ id, what: title, seat, drawing, branch, path, reach }) => {
      const node = solver.nodes[id];
      const width = node.actions.length;
      const block = solver.average[id];
      const mix = new Float64Array(width);
      let total = 0;
      const perHand = [];
      /**
       * Which hands were ever actually here, for the nodes where reach cannot
       * say.
       *
       * A hand with nothing in the average table was never dealt into this
       * decision in forty million iterations, and the strategy shown for it is
       * the uniform one the solver returns when it has nothing - not a read.
       * Past a draw this is all that is left of reach: the button opened A2,
       * drew, and now holds a tri, so the range it was dealt cannot be applied
       * to the hand it holds, but "this value never occurred here" still can.
       */
      const seen = reach ? null : new Uint8Array(solver.handCount);
      for (let hand = 0; hand < solver.handCount; hand += 1) {
        const strategy = solver.averageAt(id, hand);
        if (seen) {
          let mass = 0;
          if (block) for (let a = 0; a < width; a += 1) mass += block[hand * width + a];
          seen[hand] = mass > 0 ? 1 : 0;
        }
        // The overall line is what the table sees, so it is weighted by what
        // arrives rather than by what is dealt.
        const weight = combos[hand] * (reach ? reach[hand] : (seen ? seen[hand] : 1));
        for (let a = 0; a < width; a += 1) mix[a] += weight * strategy[a];
        total += weight;
        perHand.push(Array.from(strategy, (v) => Number(v.toFixed(4))));
      }
      return {
        id,
        what: title,
        seat,
        drawing,
        branch,
        path,
        reach,
        seen: seen ? Array.from(seen) : null,
        // `option` is how many cards a draw takes, which the viewer colours by;
        // without it every draw arrives looking like the same action.
        actions: node.actions.map((a) => (a.kind === 'draw'
          ? { label: a.label, kind: a.kind, option: a.option }
          : { label: a.label, kind: a.kind })),
        overall: Array.from(mix, (v) => Number((100 * v / (total || 1)).toFixed(2))),
        hands: perHand,
      };
    }),
  };
}
