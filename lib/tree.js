/**
 * The betting tree, built from a configuration.
 *
 * Money is integer hundredths of a big blind throughout. Chip amounts get
 * compared and summed on every node of every iteration, and a pot that is
 * 4.800000000000001 instead of 4.8 turns two identical states into two
 * different ones, which silently doubles the tree.
 *
 * The tree is a DAG, not a tree: two action sequences that arrive at the same
 * chips, the same folds and the same player to act are the same decision, and
 * sharing them is what keeps seven-handed tractable. Action order is fixed by
 * seat, so a state very nearly determines its own history - the merging does
 * not throw away anything a player at the table could have seen.
 *
 * The draw does not branch the betting tree. Each survivor picks from their own
 * discard options at their own information set, so the draw is one node saying
 * "this happens here" rather than a fan of every combination of seven draws,
 * which would not be enumerable at all.
 */

export const BB = 100;

export const ACTIVE = 0;
export const FOLDED = 1;
export const ALLIN = 2;

export const PRE_DRAW = 0;
export const POST_DRAW = 1;

const LATE_POSITIONS = ['CO', 'HJ', 'LJ', 'MP', 'UTG+2', 'UTG+1'];

/**
 * Seats run in post-draw order: 0 is the small blind, 1 the big blind, and the
 * last seat is the button. Pre-draw order is the same ring started at seat 2,
 * so the blinds act last before the draw and first after it.
 */
export function positionNames(players) {
  if (players === 2) return ['SB', 'BB'];
  const names = new Array(players);
  names[0] = 'SB';
  names[1] = 'BB';
  names[players - 1] = 'BTN';
  for (let seat = players - 2, i = 0; seat >= 2; seat -= 1, i += 1) {
    names[seat] = LATE_POSITIONS[i] ?? `UTG+${seat - 2}`;
  }
  names[2] = 'UTG';
  return names;
}

export function preDrawOrder(players) {
  if (players === 2) return [0, 1];
  return Array.from({ length: players }, (_, i) => (i + 2) % players);
}

export const postDrawOrder = (players) => Array.from({ length: players }, (_, i) => i);

export function defaultConfig() {
  return {
    players: 7,
    stack: 40,
    smallBlind: 0.5,
    bigBlind: 1,
    ante: 0,
    anteMode: 'none', // 'none' | 'each' | 'button'
    openTo: 3, // the 3x
    perLimper: 1, // added to the open for each limper already in
    postDrawBets: [0.25, 1], // fractions of the pot; all-in is always offered too
  };
}

const units = (bb) => Math.round(bb * BB);

/** The blinds, antes and stacks a hand starts from. */
export function initialState(config) {
  const { players } = config;
  const stack = new Int32Array(players).fill(units(config.stack));
  const committed = new Int32Array(players);
  const status = new Uint8Array(players);
  let dead = 0;

  const ante = units(config.ante);
  if (ante > 0 && config.anteMode === 'each') {
    for (let seat = 0; seat < players; seat += 1) {
      const posted = Math.min(ante, stack[seat]);
      stack[seat] -= posted;
      dead += posted;
    }
  } else if (ante > 0 && config.anteMode === 'button') {
    const button = players - 1;
    const posted = Math.min(ante, stack[button]);
    stack[button] -= posted;
    dead += posted;
  }

  const post = (seat, amount) => {
    const posted = Math.min(amount, stack[seat]);
    stack[seat] -= posted;
    committed[seat] = posted;
    if (stack[seat] === 0) status[seat] = ALLIN;
  };
  post(0, units(config.smallBlind));
  post(1, units(config.bigBlind));

  const state = {
    committed,
    stack,
    status,
    acted: new Uint8Array(players),
    dead,
    betLevel: units(config.bigBlind),
    raised: false,
    street: PRE_DRAW,
    toAct: -1,
  };
  state.toAct = firstToAct(state, preDrawOrder(players));
  return state;
}

export function potOf(state) {
  let total = state.dead;
  for (let i = 0; i < state.committed.length; i += 1) total += state.committed[i];
  return total;
}

const owes = (state, seat) => state.betLevel - state.committed[seat];

/** A player still has a decision if they have not acted, or owe chips. */
const pending = (state, seat) =>
  state.status[seat] === ACTIVE && (state.acted[seat] === 0 || owes(state, seat) > 0);

function firstToAct(state, order) {
  for (const seat of order) if (pending(state, seat)) return seat;
  return -1;
}

function nextToAct(state, config) {
  const { players } = config;
  const order = state.street === PRE_DRAW ? preDrawOrder(players) : postDrawOrder(players);
  const at = order.indexOf(state.toAct);
  for (let i = 1; i <= players; i += 1) {
    const seat = order[(at + i) % players];
    if (pending(state, seat)) return seat;
  }
  return -1;
}

function countBy(status, want) {
  let n = 0;
  for (let i = 0; i < status.length; i += 1) if (status[i] === want) n += 1;
  return n;
}

const clone = (state) => ({
  committed: Int32Array.from(state.committed),
  stack: Int32Array.from(state.stack),
  status: Uint8Array.from(state.status),
  acted: Uint8Array.from(state.acted),
  dead: state.dead,
  betLevel: state.betLevel,
  raised: state.raised,
  street: state.street,
  toAct: state.toAct,
});

/** Moves more of a seat's stack into the pot, marking it all-in if emptied. */
function put(state, seat, amount) {
  const paid = Math.min(amount, state.stack[seat]);
  state.stack[seat] -= paid;
  state.committed[seat] += paid;
  if (state.stack[seat] === 0) state.status[seat] = ALLIN;
  if (state.committed[seat] > state.betLevel) state.betLevel = state.committed[seat];
  return paid;
}

function reopen(state, raiser) {
  for (let seat = 0; seat < state.acted.length; seat += 1) {
    state.acted[seat] = seat === raiser ? 1 : 0;
  }
}

/** How many players have voluntarily matched the big blind without raising. */
function limpers(state, config) {
  const bb = units(config.bigBlind);
  if (state.betLevel !== bb) return 0;
  let n = 0;
  for (let seat = 0; seat < state.committed.length; seat += 1) {
    if (seat !== 1 && state.committed[seat] === bb && state.status[seat] !== FOLDED) n += 1;
  }
  return n;
}

/**
 * The legal actions for the player to act.
 *
 * The narrowness here is the specification, not a shortcut: pre-draw the only
 * raise is the 3x open and the only re-raise is all-in, and after the draw the
 * only raise is all-in. Everything else the tree could offer is left out on
 * purpose.
 */
export function legalActions(state, config) {
  const seat = state.toAct;
  if (seat < 0) return [];
  const toCall = owes(state, seat);
  const behind = state.stack[seat];
  const actions = [];

  if (toCall > 0) actions.push({ label: 'fold', kind: 'fold', amount: 0 });
  else actions.push({ label: 'check', kind: 'check', amount: 0 });

  // Calling for everything is an all-in call, and is offered once, as all-in.
  if (toCall > 0 && toCall < behind) {
    const isLimp = state.street === PRE_DRAW && !state.raised && toCall <= units(config.bigBlind);
    actions.push({ label: isLimp ? 'limp' : 'call', kind: 'call', amount: toCall });
  }

  if (state.street === PRE_DRAW) {
    if (!state.raised) {
      const target = units(config.openTo) + units(config.perLimper) * limpers(state, config);
      const extra = target - state.committed[seat];
      if (extra > 0 && extra < behind) {
        actions.push({ label: `raise ${config.openTo}x`, kind: 'raise', amount: extra });
      }
    }
  } else if (toCall === 0) {
    // Sized bets open the betting only. Facing one, the sole raise is all-in -
    // the same rule the 3-bet follows pre-draw, and the one thing holding the
    // tree down: letting two sizes re-raise each other multiway took it from
    // 900 thousand nodes past five million.
    const pot = potOf(state);
    for (const fraction of config.postDrawBets) {
      const size = Math.round(pot * fraction);
      if (size > 0 && size < behind) {
        actions.push({ label: `b${Math.round(fraction * 100)}`, kind: 'bet', amount: size });
      }
    }
  }

  // Putting the last chip in is only a raise if it raises. When a shove is for
  // no more than the price of calling - which at equal stacks is every call of
  // an all-in - it is a call, and labelling it otherwise would report a player
  // three-betting when they only called.
  if (behind > 0) {
    if (behind <= toCall) actions.push({ label: 'call', kind: 'call', amount: behind });
    else actions.push({ label: 'all-in', kind: 'allin', amount: behind });
  }
  return actions;
}

export function applyAction(state, config, action) {
  const next = clone(state);
  const seat = next.toAct;
  next.acted[seat] = 1;

  if (action.kind === 'fold') {
    next.status[seat] = FOLDED;
  } else if (action.kind === 'check' || action.kind === 'call') {
    put(next, seat, action.amount);
  } else {
    const before = next.betLevel;
    put(next, seat, action.amount);
    if (next.betLevel > before) {
      reopen(next, seat);
      if (action.kind === 'raise') next.raised = true;
    }
  }

  next.toAct = nextToAct(next, config);
  return next;
}

/** Everyone left is all-in, or only one player still has chips to bet with. */
const noOneLeftToBet = (state) => countBy(state.status, ACTIVE) <= 1;

const stateKey = (state) =>
  `${state.street}|${state.toAct}|${state.betLevel}|${state.raised ? 1 : 0}|${state.dead}`
  + `|${state.committed.join(',')}|${state.stack.join(',')}`
  + `|${state.status.join('')}|${state.acted.join('')}`;

/**
 * Builds the whole tree and returns its nodes.
 *
 * Node kinds: `decision` (a player acts), `draw` (every survivor discards, with
 * no branching), `fold` (everyone but one gave up) and `showdown`.
 */
export function buildTree(config = defaultConfig()) {
  const nodes = [];
  const seen = new Map();
  const limit = config.nodeLimit ?? 40_000_000;

  const add = (node) => {
    node.id = nodes.length;
    nodes.push(node);
    if (nodes.length > limit) {
      throw new Error(`Tree passed ${limit.toLocaleString()} nodes; it will not fit.`);
    }
    return node.id;
  };

  const stillIn = (state) => state.status.length - countBy(state.status, FOLDED);

  function afterDraw(state) {
    const next = clone(state);
    next.street = POST_DRAW;
    next.betLevel = 0;
    next.raised = false;
    next.dead = potOf(state);
    next.committed.fill(0);
    next.acted.fill(0);
    // Nobody left with chips means the draw runs straight into a showdown.
    next.toAct = noOneLeftToBet(next) ? -1 : firstToAct(next, postDrawOrder(config.players));
    return next;
  }

  function visit(state) {
    const key = stateKey(state);
    const hit = seen.get(key);
    if (hit !== undefined) return hit;

    // Everyone folded to one player: the hand ends without a draw.
    if (stillIn(state) === 1) {
      const id = add({ kind: 'fold', state, pot: potOf(state) });
      seen.set(key, id);
      return id;
    }

    // The betting round has closed.
    if (state.toAct < 0) {
      if (state.street === POST_DRAW) {
        const id = add({ kind: 'showdown', state, pot: potOf(state) });
        seen.set(key, id);
        return id;
      }
      const id = add({ kind: 'draw', state, pot: potOf(state), next: -1 });
      seen.set(key, id);
      nodes[id].next = config.stopAtDraw ? -1 : visit(afterDraw(state));
      return id;
    }

    // Decision nodes keep no state: only terminals and draws need one later, and
    // four typed arrays per node is what puts a big tree into swap.
    const actions = legalActions(state, config);
    const node = { kind: 'decision', seat: state.toAct, street: state.street, actions: [] };
    const id = add(node);
    seen.set(key, id);
    node.actions = actions.map((action) => ({
      ...action,
      child: visit(applyAction(state, config, action)),
    }));
    return id;
  }

  const root = visit(initialState(config));
  return { root, nodes, config };
}

/** Counts that say whether a configuration is going to fit. */
export function treeStats(tree) {
  const byKind = new Map();
  const decisions = new Map();
  let actionEdges = 0;

  for (const node of tree.nodes) {
    byKind.set(node.kind, (byKind.get(node.kind) ?? 0) + 1);
    if (node.kind !== 'decision') continue;
    actionEdges += node.actions.length;
    const key = `${node.seat}:${node.street}`;
    decisions.set(key, (decisions.get(key) ?? 0) + 1);
  }

  return { total: tree.nodes.length, byKind, decisions, actionEdges };
}
