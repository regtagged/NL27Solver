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

export const SUIT_SYMBOL = { c: '♣', d: '♦', h: '♥', s: '♠' };
export const SUIT_NAME = { c: 'clubs', d: 'diamonds', h: 'hearts', s: 'spades' };

/**
 * The four-colour deck: spades black, hearts red, diamonds blue, clubs green,
 * on a face that stays light in both themes so a card reads as a card rather
 * than as a tinted chip. These are the values the other tools here already
 * display, so a hand looks the same wherever it is shown.
 */
export const SUIT_COLOUR = { c: '#12823f', d: '#1565c0', h: '#c62828', s: '#16161a' };

/** Spoken rank names, for descriptions like "a pair of Sixes". */
export const RANK_NAME = {
  2: 'Deuce', 3: 'Three', 4: 'Four', 5: 'Five', 6: 'Six', 7: 'Seven', 8: 'Eight',
  9: 'Nine', T: 'Ten', J: 'Jack', Q: 'Queen', K: 'King', A: 'Ace',
};

/** Only Six takes -es. */
export function rankPlural(rank) {
  const name = RANK_NAME[rank];
  return name === 'Six' ? 'Sixes' : `${name}s`;
}

export const rankOf = (card) => card % 13;
export const suitOf = (card) => (card / 13) | 0;
export const makeCard = (rank, suit) => suit * 13 + rank;

export const rankChar = (card) => RANKS[rankOf(card)];
export const suitChar = (card) => SUITS[suitOf(card)];

export function formatCard(card) {
  return rankChar(card) + suitChar(card);
}

export function formatHand(cards) {
  return [...cards].sort((a, b) => rankOf(b) - rankOf(a)).map(formatCard).join(' ');
}

/**
 * Parses "Th", "7c", "10h" or "AH". Throws rather than returning a wrong card,
 * because a silently misread card is the one bug this code cannot have.
 */
export function parseCard(text) {
  const trimmed = String(text).trim();
  if (trimmed.length < 2) throw new Error(`Not a card: "${text}"`);
  let face = trimmed.slice(0, -1).toUpperCase();
  if (face === '10') face = 'T';
  const rank = face.length === 1 ? RANKS.indexOf(face) : -1;
  const suit = SUITS.indexOf(trimmed.slice(-1).toLowerCase());
  if (rank < 0 || suit < 0) throw new Error(`Not a card: "${text}"`);
  return makeCard(rank, suit);
}

/** Parses "7c 5d 4h 3s 2c", "7c5d4h3s2c" or "[Th 7c 5d 4s 2c]", rejecting duplicates. */
export function parseHand(text) {
  const compact = String(text)
    .replace(/[[\]]/g, ' ')
    .replace(/10/g, 'T')
    .replace(/[\s,]+/g, '');
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
 * dealing cards; it is not used for anything needing cryptographic quality.
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
