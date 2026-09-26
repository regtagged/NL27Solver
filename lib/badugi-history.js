/**
 * Real badugi hands, read out of a Phenom Poker export and lined up with a solve.
 *
 * ## What can honestly be said about a real hand
 *
 * The export shows one player's cards - whoever the tracker belongs to - and
 * everyone else's only at a showdown. So a hand can be priced for the hero and
 * nobody else, and only while the hero still holds what it was dealt: the
 * moment it draws, the hand it is playing is four cards nobody wrote down.
 *
 * That leaves two decisions on almost every hand - the one before the draw and
 * the first draw itself - and the whole hand whenever the hero stood pat
 * throughout. Those are the ones callers may price; the rest is reported as
 * unknown rather than guessed at, because a strategy table will answer for a
 * hand the player did not have as confidently as for one they did.
 *
 * ## Matching a hand to a spot
 *
 * The solves start from a fixed prefix: folded to the button who raised and the
 * small blind out, or folded to the small blind. A hand qualifies when its
 * betting reaches the same place - which happens at any table size, because the
 * seats that folded contribute nothing but the cards they took. That last part
 * is a real difference and not a rounding one: the solve deals all six seats,
 * so a three-handed table leaves more of the deck live than the solve thinks.
 */

import { DRAWING } from './tree.js';
import { makeCard } from './cards.js';

export const RANK = { A: 0, 2: 1, 3: 2, 4: 3, 5: 4, 6: 5, 7: 6, 8: 7, 9: 8, T: 9, J: 10, Q: 11, K: 12 };
export const SUIT = { s: 0, h: 1, d: 2, c: 3 };
export const NAMES = ['A', '2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K'];
export const PIPS = ['♠', '♥', '♦', '♣'];

export const card = (text) => ({ rank: RANK[text[0].toUpperCase()], suit: SUIT[text[1].toLowerCase()] });

/**
 * A parsed card as the deck numbers it.
 *
 * Two orderings meet here. A hand history counts ranks from the ace, because
 * badugi does, and names suits `shdc`; the deck counts from the deuce with the
 * ace on top and names them `cdhs`. Getting this wrong does not throw - it
 * quietly deals a different hand from the one the export named - so it is one
 * line, and it is tested.
 */
export const deckCard = (c) => makeCard((c.rank + 12) % 13, 3 - c.suit);
export const showCards = (cards) => [...cards].sort((a, b) => a.rank - b.rank)
  .map((c) => NAMES[c.rank] + PIPS[c.suit]).join(' ');

/** The badugi value of four cards: the biggest subset that works, then the lowest. */
export function valueOf(cards, labels) {
  let best = null;
  for (let mask = 1; mask < 16; mask += 1) {
    const pick = cards.filter((_, i) => mask & (1 << i));
    if (new Set(pick.map((c) => c.rank)).size !== pick.length) continue;
    if (new Set(pick.map((c) => c.suit)).size !== pick.length) continue;
    const order = pick.map((c) => c.rank).sort((a, b) => b - a);
    if (!best || order.length > best.length) { best = order; continue; }
    if (order.length < best.length) continue;
    for (let i = 0; i < order.length; i += 1) {
      if (order[i] === best[i]) continue;
      if (order[i] < best[i]) best = order;
      break;
    }
  }
  return labels.indexOf(`${best.length}-card ${best.map((r) => NAMES[r]).join('')}`);
}

/** One hand of the export, as far as it can be read. */
export function parseHand(text, labels) {
  const head = /^Phenom Poker Hand #(\w+): Badugi Limit \(\$([\d.]+)\/\$([\d.]+)/.exec(text);
  if (!head) return null;

  const seats = [];
  for (const line of text.split('\n')) {
    const seat = /^Seat (\d+): (\S+) \(\$([\d.]+) in chips\)/.exec(line);
    if (seat) seats.push({ no: Number(seat[1]), who: seat[2] });
  }
  const sb = (/^(\S+): posts small blind/m.exec(text) ?? [])[1];
  const bb = (/^(\S+): posts big blind/m.exec(text) ?? [])[1];
  if (!sb || !bb || seats.length < 2) return null;

  // The button is whoever is dealt last before the small blind, which in the
  // seat order is simply the one in front of it.
  const at = seats.findIndex((s) => s.who === sb);
  const btn = seats[(at - 1 + seats.length) % seats.length].who;

  const hero = (/^Dealt to (\S+) \[([^\]]+)\]/m.exec(text) ?? [])[1];
  const dealt = (/^Dealt to \S+ \[([^\]]+)\]/m.exec(text) ?? [])[1];
  if (!hero || !dealt) return null;
  const cards = dealt.trim().split(/\s+/).map(card);
  if (cards.length !== 4 || cards.some((c) => c.rank === undefined || c.suit === undefined)) {
    return null;
  }

  // Everything that happened, street by street.
  const streets = { pre: [], first: [], second: [], third: [] };
  let where = 'pre';
  for (const line of text.split('\n')) {
    if (/^\*\*\* FIRST DRAW/.test(line)) { where = 'first'; continue; }
    if (/^\*\*\* SECOND DRAW/.test(line)) { where = 'second'; continue; }
    if (/^\*\*\* THIRD DRAW/.test(line)) { where = 'third'; continue; }
    if (/^\*\*\* (SHOW DOWN|SUMMARY)/.test(line)) { where = 'done'; continue; }
    if (where === 'done') continue;
    const act = /^(\S+): (folds|checks|calls|bets|raises|stands pat|discards (\d) cards?|draws \d cards?)/
      .exec(line);
    if (!act) continue;
    const who = act[1];
    const what = act[2];
    if (/^draws/.test(what)) continue;              // the pair of the discard line
    if (where === 'pre') streets.pre.push({ who, what });
    else if (/^stands pat/.test(what)) streets[where].push({ who, what: 'pat', drew: 0 });
    else if (/^discards/.test(what)) streets[where].push({ who, what: 'draw', drew: Number(act[3]) });
    else streets[where].push({ who, what });
  }

  return {
    id: head[1],
    bigBlind: Number(head[3]),
    seats,
    sb,
    bb,
    btn,
    hero,
    cards,
    value: valueOf(cards, labels),
    streets,
    showdown: /\*\*\* SHOW DOWN/.test(text),
  };
}

/**
 * Which solved spot a hand belongs to, if any.
 *
 * `btn-bb` is folded to the button, the button raises, the small blind folds,
 * and the big blind plays on. `sb-bb` is folded to the small blind with the big
 * blind behind it. In both the hero has to be one of the two left, or there is
 * nothing here that can be priced.
 */
export function classify(hand) {
  const pre = hand.streets.pre;
  if (!pre.length) return null;
  const order = pre.map((a) => a.who);

  const beforeBtn = pre.slice(0, pre.findIndex((a) => a.who === hand.btn));
  const btnAt = pre.findIndex((a) => a.who === hand.btn);
  const sbAt = pre.findIndex((a) => a.who === hand.sb);
  const bbAt = pre.findIndex((a) => a.who === hand.bb);

  if (btnAt >= 0 && beforeBtn.every((a) => a.what === 'folds')
    && /^raises/.test(pre[btnAt].what)
    && sbAt > btnAt && pre[sbAt].what === 'folds'
    && bbAt > sbAt && pre[bbAt].what !== 'folds') {
    return { spot: 'btn-bb', seat: hand.hero === hand.bb ? 'BB' : (hand.hero === hand.btn ? 'BTN' : null) };
  }

  if (sbAt >= 0 && pre.slice(0, sbAt).every((a) => a.what === 'folds')
    && /^raises/.test(pre[sbAt].what)
    && bbAt > sbAt && pre[bbAt].what !== 'folds'
    && !order.slice(0, sbAt).includes(hand.bb)) {
    return { spot: 'sb-bb', seat: hand.hero === hand.sb ? 'SB' : (hand.hero === hand.bb ? 'BB' : null) };
  }
  return null;
}

/** Every hand in an export that reaches one of the solved spots. */
export function handsFrom(text, labels) {
  const blocks = text.split(/\n(?=Phenom Poker Hand #)/);
  const found = { 'btn-bb': [], 'sb-bb': [] };
  let badugis = 0;
  for (const block of blocks) {
    if (!/: Badugi Limit/.test(block)) continue;
    badugis += 1;
    const hand = parseHand(block, labels);
    if (!hand || hand.value < 0) continue;
    const kind = classify(hand);
    if (!kind || !kind.seat) continue;
    found[kind.spot].push({ ...hand, ...kind });
  }
  return { blocks: blocks.length, badugis, found };
}

/**
 * The two live players' actions, queued the way the tree will ask for them.
 *
 * A player's bets come in one order and their draws in another, and the tree
 * visits each in that order, so two queues per player is all the bookkeeping
 * needed - no tracking of which street anything belongs to.
 *
 * The opening raise is dropped for `btn-bb`: the solve *starts* after it, so
 * leaving it in the queue would have the big blind's first decision answered
 * with the button's raise.
 */
export function queues(hand, spot) {
  const bets = new Map();
  const draws = new Map();
  const push = (map, who, act) => {
    if (!map.has(who)) map.set(who, []);
    map.get(who).push(act);
  };
  for (const act of hand.streets.pre) push(bets, act.who, act);
  for (const street of ['first', 'second', 'third']) {
    for (const act of hand.streets[street]) {
      if (act.what === 'pat' || act.what === 'draw') push(draws, act.who, act);
      else push(bets, act.who, act);
    }
  }
  if (spot === 'btn-bb') {
    // The button's open is the prefix the subgame begins after.
    const mine = bets.get(hand.btn);
    if (mine && mine.length) mine.shift();
  }
  return { bets, draws };
}

/** What the solve calls the action a player took. */
export function asAction(node, act) {
  if (act.what === 'pat') return node.actions.findIndex((a) => a.option === 0);
  if (act.what === 'draw') return node.actions.findIndex((a) => a.option === act.drew);
  if (act.what === 'folds') return node.actions.findIndex((a) => a.kind === 'fold');
  if (act.what === 'checks') return node.actions.findIndex((a) => a.kind === 'check');
  if (/^calls/.test(act.what)) return node.actions.findIndex((a) => a.kind === 'call');
  if (/^(bets|raises)/.test(act.what)) {
    return node.actions.findIndex((a) => a.kind === 'bet' || a.kind === 'raise');
  }
  return -1;
}

/**
 * Replays a real hand through the tree, one decision at a time.
 *
 * Both players' actions are followed - the opponent's because the line has to
 * get where it went, the hero's because they are the point. Each step carries
 * the line that *reaches* it, so a caller can hand that line straight to
 * `browse`, or measure what a different action there would have been worth.
 *
 * Nothing is priced here and no strategy is read: this is where the hand went,
 * and what that was worth is a separate question with a separate answer.
 */
export function follow(solver, names, hand, spot) {
  const seatOf = { [hand.bb]: 'BB' };
  if (spot === 'btn-bb') seatOf[hand.btn] = 'BTN'; else seatOf[hand.sb] = 'SB';
  const whoIs = Object.fromEntries(Object.entries(seatOf).map(([who, seat]) => [seat, who]));

  const { bets, draws } = queues(hand, spot);
  const line = [];
  const steps = [];
  const drew = new Set();
  let id = solver.tree.root;
  let stop = null;

  for (let guard = 0; guard < 40; guard += 1) {
    const node = solver.nodes[id];
    if (!node) { stop = 'that line leads nowhere'; break; }
    if (node.kind !== 'decision') { stop = node.kind; break; }

    const who = whoIs[names[node.seat]];
    if (!who) { stop = `no player for ${names[node.seat]}`; break; }
    const drawing = node.street === DRAWING;
    const queue = drawing ? draws.get(who) : bets.get(who);
    if (!queue || !queue.length) { stop = 'the export stops here'; break; }
    const act = queue.shift();
    const at = asAction(node, act);
    if (at < 0) { stop = `"${act.what}" is not offered to ${names[node.seat]} here`; break; }

    steps.push({
      nodeId: node.id,
      seat: node.seat,
      who,
      seatName: names[node.seat],
      hero: who === hand.hero,
      drawing,
      // Read before the draw lands: the decision was made holding the cards the
      // export named, and it is everything after it that is about a hand nobody
      // wrote down.
      known: !drew.has(node.seat),
      at,
      label: node.actions[at].label,
      actions: node.actions.map((a) => a.label),
      line: line.slice(),
    });
    if (drawing && node.actions[at].option > 0) drew.add(node.seat);
    line.push(at);
    id = node.actions[at].child;
  }
  return { steps, stop, line };
}
