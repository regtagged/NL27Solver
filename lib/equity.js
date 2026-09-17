/**
 * How often a starting hand wins, once everybody has drawn.
 *
 * Pre-draw equity in a draw game is not a property of the five cards - it is a
 * property of the five cards *plus what they become*. So this deals opponents
 * out of the same deck, lets every hand take the draw `lib/ranking.js` says it
 * takes, and counts showdowns. Ties split.
 *
 * It uses the same draw table the viewer displays, which matters: a hand shown
 * throwing all five must have its equity worked out as a hand that threw all
 * five, or the two columns are answering different questions.
 *
 * It is Monte Carlo because it has to be: a heads-up pot is one hand against
 * C(47,5) opponents, each of which then draws, and that is not a sum anybody
 * finishes. A fixed seed makes it repeatable.
 *
 * Card removal is real throughout. The hero's five cards are out of the deck
 * before an opponent is dealt, which is why holding four low cards makes it
 * measurably harder for anyone else to.
 */

import { deal } from './cards.js';
import { handRanks, index5 } from './eval27.js';
import { drawTable, KEEP_SIZE } from './ranking.js';

const held = new Int32Array(5);
const kept = new Int32Array(5);

let tables = null;

function ready() {
  if (!tables) {
    const { optionByHand, keeps } = drawTable();
    tables = { optionByHand, keeps, ranks: handRanks() };
  }
  return tables;
}

/**
 * Plays five cards through the draw and returns what they finish as.
 *
 * `source` holds the five cards at `from`; replacements come off `deck` at
 * `at`. Where a rank appears twice the keep takes the copy that breaks a flush,
 * which is the only reason suits are looked at here at all.
 */
function finish(source, from, deck, at, t) {
  for (let i = 0; i < 5; i += 1) held[i] = source[from + i];
  const index = index5(held[0], held[1], held[2], held[3], held[4]);

  const size = KEEP_SIZE[t.optionByHand[index]];
  if (size === 5) return t.ranks[index];

  let mask = 0;
  for (let i = 0; i < 5; i += 1) mask |= 1 << (held[i] % 13);
  const wanted = t.keeps[size][mask];
  if (!wanted) return t.ranks[index];

  let n = 0;
  for (let w = 0; w < wanted.length; w += 1) {
    const rank = wanted[w];
    let chosen = -1;
    for (let i = 0; i < 5; i += 1) {
      if (held[i] % 13 !== rank) continue;
      // Prefer the copy that breaks a flush.
      if (chosen < 0) chosen = held[i];
      else if (n > 0 && ((held[i] / 13) | 0) !== ((kept[0] / 13) | 0)) chosen = held[i];
    }
    if (chosen < 0) return t.ranks[index];
    kept[n] = chosen;
    n += 1;
  }

  for (let i = n; i < 5; i += 1) kept[i] = deck[at + (i - n)];
  return t.ranks[index5(kept[0], kept[1], kept[2], kept[3], kept[4])];
}

/**
 * Equity of one holding against `opponents` random hands, over `trials` deals.
 *
 * Every player is dealt five reserve cards whether they draw that many or not,
 * so a player standing pat does not change which cards the next one receives.
 */
export function equityOf(cards, opponents, trials, rng) {
  const t = ready();

  const mine = new Set(cards);
  const live = [];
  for (let card = 0; card < 52; card += 1) if (!mine.has(card)) live.push(card);
  const deck = Uint8Array.from(live);

  const heroCards = Int32Array.from(cards);
  const handsAt = 5; // the hero's five reserve cards come first
  const reservesAt = handsAt + opponents * 5;
  const need = reservesAt + opponents * 5;

  let won = 0;
  for (let trial = 0; trial < trials; trial += 1) {
    deal(deck, need, rng);
    const heroRank = finish(heroCards, 0, deck, 0, t);

    let better = 0;
    let equal = 0;
    for (let o = 0; o < opponents; o += 1) {
      const rank = finish(deck, handsAt + o * 5, deck, reservesAt + o * 5, t);
      if (rank < heroRank) better += 1;
      else if (rank === heroRank) equal += 1;
    }

    if (better === 0) won += 1 / (1 + equal);
  }
  return won / trials;
}
