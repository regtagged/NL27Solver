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

import { HEADS_UP } from './badugi-headsup.js';

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
  /**
   * The one spot here that assumes nothing.
   *
   * Every other spot begins after the button has opened, so it inherits a
   * range that was given rather than solved, and the answer is only as good as
   * that guess. Folded to the small blind there is no such range: both seats
   * are still to act, so both strategies come out of the solve, and the only
   * approximation left is that the four folded seats are dealt uniformly
   * rather than out of the hands they would actually fold.
   *
   * **`sb-bb` is raise-or-fold and `sb-bb-limp` is not, and the difference is
   * not a detail.** Everywhere else in this repo the unopened pot is
   * raise-or-fold, which is the single biggest prune in the tree and costs
   * little when raising is what a hand wants anyway. Blind versus blind that
   * stops being true: completing for half a bet, against one opponent who has
   * to act first for the rest of the hand, is a real option, and a 300,000
   * iteration smoke run took it 37.6% of the time. A tree without the limp
   * forces that third of the range into a raise.
   *
   * It is left out of the default because of what it costs. The limp doubles
   * the tree - 938,648 nodes against 487,271, 10 GB of tables against 5.2 -
   * and the deeper lines against colder memory cut the rate from about 3,000
   * iterations a second to about 850, so the same 40 million iterations go
   * from three and a half hours to thirteen. `sb-bb` is the affordable answer
   * to a slightly different game; `sb-bb-limp` is the expensive answer to this
   * one. **Read the opening frequency out of `sb-bb` knowing that.**
   */
  'sb-bb': {
    what: 'SB vs BB, folded around (raise or fold)',
    line: ['fold', 'fold', 'fold', 'fold'],
    over: {},
    preset: null,
    // The blind-versus-blind three-bet pot, which the main line misses because
    // it follows the call.
    branches: [
      {
        name: 'the BB three-bets',
        steps: ['raise', 'raise', 'call', 'd1', 'd1', 'check', 'bet', 'call'],
      },
    ],
  },
  'sb-bb-limp': {
    what: 'SB vs BB, folded around, completing allowed',
    line: ['fold', 'fold', 'fold', 'fold'],
    over: { allowLimp: true },
    preset: null,
  },
};

/**
 * The opening range a spot inherits, or none.
 *
 * A spot that starts after an open has to be told what was opened - it is the
 * assumption the whole solve rests on. A spot that starts before anyone has
 * acted must **not** be: presetting a seat's range there would be restricting
 * hands the solve is supposed to be working out, and presetting a folded seat's
 * range would be asserting that the seat folded the hands it opens with.
 */
export function presetFor(key, btnSeat, range) {
  const spot = SPOTS[key];
  if (!spot) throw new Error(`no spot called "${key}"`);
  return spot.preset === null ? null : { [btnSeat]: range };
}

/**
 * Whether a spot is a whole hand rather than a middle of one.
 *
 * Most spots here start after somebody has acted - `btn-bb` begins with the
 * button's raise already made, `bb-3bet` with the three-bet already in. That is
 * the right shape for studying a decision and the wrong one for playing a hand
 * out, because the player is handed a spot they did not choose to be in.
 *
 * The test is the prefix: a line of nothing but folds leaves the hand where it
 * started for everybody still in it, and anything else does not. Read off the
 * spot rather than the tree, so asking costs nothing - a caller listing what is
 * on disk should not have to build six games to answer it.
 */
export function startsWhole(slug) {
  const key = baseSpot(slug);
  if (key === null) return false;
  // The heads-up game, which has no prefix at all by construction.
  if (key === HEADS_UP.key) return true;
  return (SPOTS[key].line ?? []).every((action) => action === 'fold');
}

/**
 * The game a checkpoint's name belongs to, label and all.
 *
 * A run writes itself as `<key>` or `<key>-<label>`, so `btn-bb-lock3b` is the
 * button-versus-blind game and `hu-200M` is the heads-up one. Matching the
 * longest key first is what keeps `sb-bb-limp` from being read as `sb-bb` with a
 * label of "limp" - it is its own spot and a different tree.
 */
export function baseSpot(slug) {
  if (SPOTS[slug]) return slug;
  if (slug === HEADS_UP.key || slug.startsWith(`${HEADS_UP.key}-`)) return HEADS_UP.key;
  for (const key of Object.keys(SPOTS).sort((a, b) => b.length - a.length)) {
    if (slug.startsWith(`${key}-`)) return key;
  }
  return null;
}

/** The one asked for, or a message naming the ones there are. */
export function spotNamed(key) {
  const spot = SPOTS[key];
  if (!spot) throw new Error(`--spot wants one of ${Object.keys(SPOTS).join(', ')}; got "${key}"`);
  return spot;
}
