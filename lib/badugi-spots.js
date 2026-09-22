/**
 * The badugi spots this repository solves, in one place.
 *
 * Five scripts build the same three games - the solver, the report, the EV
 * run, the line reader, the paired comparison - and every one of them has to
 * agree about the line that leads there and the ceilings that apply, or they
 * are quietly describing different trees. They used to hold their own copies.
 *
 * **`sb-3bet` starts before the small blind acts**, so its 3-betting range is
 * solved rather than assumed - what it 3-bets is the point of the spot, and a
 * line beginning after the 3-bet can never say. That leaves three seats live,
 * which does not fit uncapped: over 25 million nodes against 974,539 with the
 * entry cap at two. **The cap is doing something real to that answer.** Once
 * the small blind comes in the big blind may not, so the range is solved as
 * though nobody can come along behind, which makes it wider than one facing a
 * live big blind. That is the price of having the decision in the tree at all,
 * and it is worth paying only because the alternative is not having it.
 *
 * `btn-bb` needs no cap - folded to the big blind, two seats are left - and it
 * **already contains the big blind's 3-betting range**: the raise at its first
 * decision is that 3-bet. `bb-3bet` is the other side of the same thing, the
 * button answering it.
 */

export const SPOTS = {
  'btn-bb': {
    what: 'BTN vs BB, single raised pot',
    line: ['fold', 'fold', 'fold', 'raise', 'fold'],
    over: {},
    /**
     * Lines nobody continues on, which is why they have to be asked for.
     *
     * The walk that finds the main decisions follows the calls, so it never
     * reaches a hand that three-bets and then stands pat - and that hand is a
     * snow, the one line in badugi where what a player holds and what they are
     * representing have nothing to do with each other. A monotone hand cannot
     * be a badugi and cannot become one without drawing, so every pat it makes
     * is a snow by definition; these two branches are where it makes them.
     *
     * The first is the pure version - three-bet, pat straight away - and the
     * second is the one the hands actually take more often: three-bet, draw
     * one, miss, and pat the miss.
     */
    branches: [
      {
        name: 'three-bet and pat',
        steps: ['raise', 'call', 'pat', 'd1', 'bet', 'call', 'pat'],
      },
      {
        name: 'three-bet, draw one, then pat',
        steps: ['raise', 'call', 'd1', 'd1', 'bet', 'call', 'pat'],
      },
    ],
  },
  'sb-3bet': {
    what: 'SB vs BTN, from the small blind\'s own decision',
    line: ['fold', 'fold', 'fold', 'raise'],
    over: { maxToDraw: 2 },
    // Follow the 3-bet rather than the flat: it is the line the spot is for.
    follow: 'raise',
  },
  'bb-3bet': {
    what: 'BTN facing the BB\'s 3-bet',
    line: ['fold', 'fold', 'fold', 'raise', 'fold', 'raise'],
    over: {},
  },
};

/** The one asked for, or a message naming the ones there are. */
export function spotNamed(key) {
  const spot = SPOTS[key];
  if (!spot) throw new Error(`--spot wants one of ${Object.keys(SPOTS).join(', ')}; got "${key}"`);
  return spot;
}
