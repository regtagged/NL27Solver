/**
 * Cards, as the solver wants them.
 *
 * A card is an integer 0-51. Rank is `card % 13` and runs 0 (deuce) to 12
 * (ace); suit is `(card / 13) | 0`. The rank order is the point: in
 * deuce-to-seven the ace is always high, and therefore always the worst card to
 * hold, so an ascending rank index is also an ascending badness index and no
 * code downstream has to carry a special case for aces the way an ace-to-five
 * evaluator would.
 */

export const RANKS = '23456789TJQKA';
export const SUITS = 'cdhs';
export const DECK_SIZE = 52;

export const rankOf = (card) => card % 13;
export const suitOf = (card) => (card / 13) | 0;
export const makeCard = (rank, suit) => suit * 13 + rank;

export function formatCard(card) {
  return RANKS[rankOf(card)] + SUITS[suitOf(card)];
}

export function formatHand(cards) {
  return [...cards].sort((a, b) => rankOf(b) - rankOf(a)).map(formatCard).join(' ');
}

/** Parses "Th" or "7c". Throws rather than returning a wrong card. */
export function parseCard(text) {
  const trimmed = String(text).trim();
  if (trimmed.length !== 2) throw new Error(`Not a card: "${text}"`);
  const rank = RANKS.indexOf(trimmed[0].toUpperCase());
  const suit = SUITS.indexOf(trimmed[1].toLowerCase());
  if (rank < 0 || suit < 0) throw new Error(`Not a card: "${text}"`);
  return makeCard(rank, suit);
}

/** Parses "7c 5d 4h 3s 2c" or "7c5d4h3s2c" into five cards, rejecting duplicates. */
export function parseHand(text) {
  const compact = String(text).replace(/[\s,]+/g, '');
  if (compact.length % 2 !== 0) throw new Error(`Not a hand: "${text}"`);
  const cards = [];
  for (let i = 0; i < compact.length; i += 2) cards.push(parseCard(compact.slice(i, i + 2)));
  if (new Set(cards).size !== cards.length) throw new Error(`Duplicate card in "${text}"`);
  return cards;
}

export function freshDeck() {
  return Uint8Array.from({ length: DECK_SIZE }, (_, i) => i);
}

/**
 * A seeded generator, because a solve has to be reproducible.
 *
 * Monte Carlo CFR converges to a different strategy on every run unless the
 * deals are repeatable, and "the numbers moved" then cannot be told apart from
 * "the change moved the numbers". mulberry32 is small, fast and good enough for
 * dealing cards; it is not used for anything that needs cryptographic quality.
 */
export function makeRng(seed = 1) {
  let state = seed >>> 0;
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Deals `count` cards off `deck` in place by partial Fisher-Yates.
 *
 * Dealing in place is what keeps card removal honest: seven five-card hands and
 * their draws all come out of one deck, so a card another player holds is a
 * card this one cannot draw, without any of the callers having to track it.
 */
export function deal(deck, count, rng, offset = 0) {
  for (let i = 0; i < count; i += 1) {
    const from = offset + i;
    const to = from + Math.floor(rng() * (deck.length - from));
    const swap = deck[from];
    deck[from] = deck[to];
    deck[to] = swap;
  }
  return deck.subarray(offset, offset + count);
}
