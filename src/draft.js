// src/draft.js
// Pure draft math: snake order, pick ownership, turn detection. No network,
// no DOM, so node tests can import it. The live polling loop lives in
// src/live.js and only calls into these functions.

// Which draft slot (1-based) owns a given overall pick number.
// reversalRound > 0 means "third round reversal" style drafts: from that
// round on, the direction pattern is inverted (round 3 repeats round 2's
// direction), which is how Sleeper's settings.reversal_round behaves.
export function slotForPick(pickNo, teams, { type = 'snake', reversalRound = 0 } = {}) {
  const round = Math.ceil(pickNo / teams);
  const idx = (pickNo - 1) % teams; // 0-based position within the round
  if (type === 'linear') return idx + 1;
  let forward = round % 2 === 1;
  if (reversalRound > 0 && round >= reversalRound) forward = !forward;
  return forward ? idx + 1 : teams - idx;
}

export function roundOf(pickNo, teams) {
  return Math.ceil(pickNo / teams);
}

export function pickInRound(pickNo, teams) {
  return ((pickNo - 1) % teams) + 1;
}

// All overall pick numbers owned by a slot.
export function picksForSlot(slot, teams, rounds, opts) {
  const out = [];
  const total = teams * rounds;
  for (let p = 1; p <= total; p++) if (slotForPick(p, teams, opts) === slot) out.push(p);
  return out;
}

// Group consecutive pick numbers into "turns" (snake pairs like 20 & 21).
export function groupTurns(pickNos) {
  const turns = [];
  for (const p of pickNos) {
    const last = turns[turns.length - 1];
    if (last && last[last.length - 1] === p - 1) last.push(p);
    else turns.push([p]);
  }
  return turns;
}

// Draft config summary from the Sleeper draft object (authoritative for
// rounds / timer / type per plan section 3).
export function draftConfig(draft) {
  const s = (draft && draft.settings) || {};
  const teams = Number(s.teams || (draft && draft.draft_order ? Object.keys(draft.draft_order).length : 0)) || 0;
  return {
    teams,
    rounds: Number(s.rounds || 0),
    pickTimer: Number(s.pick_timer || 0),
    type: (draft && draft.type) || 'snake',
    reversalRound: Number(s.reversal_round || 0),
    status: (draft && draft.status) || 'unknown',
    startTime: draft && draft.start_time ? Number(draft.start_time) : null,
    lastPicked: draft && draft.last_picked ? Number(draft.last_picked) : null,
    totalPicks: teams * Number(s.rounds || 0),
  };
}

export function userSlot(draft, userId) {
  if (!draft || !draft.draft_order || !userId) return null;
  const s = draft.draft_order[String(userId)];
  return s != null ? Number(s) : null;
}

// The current open pick is the smallest pick number not yet in the picks
// list. This handles keepers that pre-fill later pick numbers.
export function nextOpenPick(picks, totalPicks) {
  const taken = new Set(picks.map((p) => Number(p.pick_no)));
  for (let p = 1; p <= totalPicks; p++) if (!taken.has(p)) return p;
  return null; // draft complete
}

// Everything the UI needs to know about "whose turn is it".
export function turnInfo({ picks, draft, userId }) {
  const cfg = draftConfig(draft);
  const slot = userSlot(draft, userId);
  const opts = { type: cfg.type, reversalRound: cfg.reversalRound };
  const current = nextOpenPick(picks, cfg.totalPicks);
  const userPicks = slot ? picksForSlot(slot, cfg.teams, cfg.rounds, opts) : [];
  const upcoming = current ? userPicks.filter((p) => p >= current) : [];
  const isUserTurn = current != null && slot != null && slotForPick(current, cfg.teams, opts) === slot;
  // Next user turns strictly after the current pick (used by the survival sim).
  const futureTurns = groupTurns(current ? userPicks.filter((p) => p > current) : []);
  return {
    cfg,
    slot,
    current,
    currentRound: current ? roundOf(current, cfg.teams) : null,
    currentSlot: current ? slotForPick(current, cfg.teams, opts) : null,
    isUserTurn,
    userPicks,
    nextUserPick: upcoming.length ? upcoming[0] : null,
    picksUntilUser: upcoming.length && current ? upcoming[0] - current : null,
    futureTurns,
    complete: current == null,
  };
}

// Build per-slot rosters from picks: { [slot]: { roster_id, picked_by, players: [pick...] } }
export function rostersFromPicks(picks, draft) {
  const out = {};
  const s2r = (draft && draft.slot_to_roster_id) || {};
  const order = (draft && draft.draft_order) || {};
  const slotToUser = {};
  for (const uid in order) slotToUser[order[uid]] = uid;
  const teams = draftConfig(draft).teams;
  for (let slot = 1; slot <= teams; slot++) {
    out[slot] = { slot, roster_id: s2r[slot] != null ? s2r[slot] : null, user_id: slotToUser[slot] || null, players: [] };
  }
  for (const p of picks) {
    const slot = Number(p.draft_slot);
    if (!out[slot]) out[slot] = { slot, roster_id: p.roster_id, user_id: p.picked_by || null, players: [] };
    out[slot].players.push(p);
  }
  return out;
}

// Diff two pick lists by pick_no; returns the picks that are new.
export function newPicks(prev, next) {
  const seen = new Set(prev.map((p) => Number(p.pick_no)));
  return next.filter((p) => !seen.has(Number(p.pick_no)));
}
