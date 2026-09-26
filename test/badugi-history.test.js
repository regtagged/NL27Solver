/**
 * Reading a hand history is a translation, and the failures of a translation
 * are silent: a card read as the wrong suit still deals, still has a badugi
 * value, and still gets priced - as a hand nobody held. So the two places the
 * export and the solve disagree about how to spell something are pinned here.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  valueOf, parseHand, classify, deckCard, card, showCards, NAMES,
} from '../lib/badugi-history.js';
import { badugiTable } from '../lib/badugi.js';
import { formatCard, rankOf, suitOf, RANKS, SUITS } from '../lib/cards.js';

const { labels } = badugiTable();
const four = (text) => text.split(' ').map(card);

test('the badugi value of four cards is the biggest subset, then the lowest', () => {
  assert.equal(labels[valueOf(four('As 2h 3d 4c'), labels)], '4-card 432A');
  // The fourth card pairs a suit, so the hand is the three that do not.
  assert.equal(labels[valueOf(four('As 2h 3d 4d'), labels)], '3-card 32A');
  // Two clubs and two spades: one of each, the lowest pair of them.
  assert.equal(labels[valueOf(four('Ac 5c 7s Ks'), labels)], '2-card 7A');
  assert.equal(labels[valueOf(four('Ah 4d Th Jc'), labels)], '3-card J4A');
});

test('an exported card and a deck card are the same card', () => {
  // The export writes a rank from the ace and a suit from spades; the deck
  // writes a rank from the deuce and a suit from clubs. Every one of the
  // fifty-two has to survive the trip.
  for (const rank of NAMES) {
    for (const suit of 'shdc') {
      const spelled = `${rank}${suit}`;
      const deck = deckCard(card(spelled));
      assert.equal(RANKS[rankOf(deck)], rank, `${spelled} kept its rank`);
      assert.equal(SUITS[suitOf(deck)], suit, `${spelled} kept its suit`);
      assert.equal(formatCard(deck), spelled);
    }
  }
});

test('the ace is the low card of the deck and the king is the high one', () => {
  // The one that would go unnoticed: badugi's ace sorts below the deuce, and
  // the deck's ace sorts above the king.
  const ace = deckCard(card('Ah'));
  const king = deckCard(card('Kh'));
  assert.equal(rankOf(ace), 12);
  assert.equal(rankOf(king), 11);
  assert.equal(labels[valueOf(four('As 2h 3d 4c'), labels)], '4-card 432A');
});

const HAND = `Phenom Poker Hand #abc123: Badugi Limit ($1.00/$2.00) - 2026/09/01 12:00:00
Table 'Test' 6-max Seat #3 is the button
Seat 1: alice ($100.00 in chips)
Seat 2: bob ($100.00 in chips)
Seat 3: carol ($100.00 in chips)
Seat 4: dave ($100.00 in chips)
dave: posts small blind $1.00
alice: posts big blind $2.00
*** HOLE CARDS ***
Dealt to alice [Ah 4d Th Jc]
bob: folds
carol: raises $2.00 to $4.00
dave: folds
alice: calls $2.00
*** FIRST DRAW ***
alice: discards 2 cards
alice: draws 2 cards
carol: stands pat
alice: checks
carol: bets $2.00
alice: calls $2.00
*** SECOND DRAW ***
alice: discards 1 card
carol: stands pat
alice: folds
*** SUMMARY ***
`;

test('a hand is read down to the cards, the seats and every action', () => {
  const hand = parseHand(HAND, labels);
  assert.equal(hand.id, 'abc123');
  assert.equal(hand.bigBlind, 2);
  assert.equal(hand.hero, 'alice');
  assert.equal(hand.sb, 'dave');
  assert.equal(hand.bb, 'alice');
  // The button is whoever is dealt last before the small blind, which is the
  // seat in front of it in the listed order.
  assert.equal(hand.btn, 'carol');
  assert.equal(showCards(hand.cards), 'A♥ 4♦ T♥ J♣');
  assert.equal(labels[hand.value], '3-card J4A');
  assert.deepEqual(hand.streets.pre.map((a) => `${a.who} ${a.what}`),
    ['bob folds', 'carol raises', 'dave folds', 'alice calls']);
  // The "draws N cards" line is the pair of the discard and must not be
  // counted twice, or every draw would be made two of.
  assert.deepEqual(hand.streets.first,
    [{ who: 'alice', what: 'draw', drew: 2 }, { who: 'carol', what: 'pat', drew: 0 },
      { who: 'alice', what: 'checks' }, { who: 'carol', what: 'bets' },
      { who: 'alice', what: 'calls' }]);
  assert.deepEqual(hand.streets.second.map((a) => `${a.who} ${a.what}`),
    ['alice draw', 'carol pat', 'alice folds']);
});

test('a hand folded around to the button is the button-versus-blind spot', () => {
  assert.deepEqual(classify(parseHand(HAND, labels)), { spot: 'btn-bb', seat: 'BB' });
});

test('a hand the big blind acted in before the small blind is not that spot', () => {
  // The solves start from a fixed prefix, and a hand that got where it got by
  // another route is a different game however similar it looks.
  const raised = HAND.replace('bob: folds', 'bob: raises $2.00 to $4.00');
  assert.equal(classify(parseHand(raised, labels)), null);
});
