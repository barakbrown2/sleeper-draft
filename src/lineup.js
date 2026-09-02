// src/lineup.js - pure lineup helpers shared by My Team, the need model and the plan.

export const SLOT_ELIGIBLE = {
  QB: ['QB'],
  RB: ['RB'],
  WR: ['WR'],
  TE: ['TE'],
  K: ['K'],
  DEF: ['DEF'],
  FLEX: ['RB', 'WR', 'TE'],
  SUPER_FLEX: ['QB', 'RB', 'WR', 'TE'],
  REC_FLEX: ['WR', 'TE'],
  WRRB_FLEX: ['RB', 'WR'],
  WRRB_TE_FLEX: ['RB', 'WR', 'TE'],
  IDP_FLEX: ['DL', 'LB', 'DB'],
  DL: ['DL'],
  LB: ['LB'],
  DB: ['DB'],
};

export function starterSlots(rosterPositions) {
  return (rosterPositions || []).filter((s) => s !== 'BN' && s !== 'IR' && s !== 'TAXI');
}

// Greedy lineup: dedicated slots first by projected points, then flex slots.
export function computeLineup(rosterPositions, players) {
  const slots = starterSlots(rosterPositions);
  const remaining = [...players].sort((a, b) => (b.lgPts || 0) - (a.lgPts || 0));
  const lineup = slots.map((s) => ({ slot: s, player: null }));
  for (const l of lineup) {
    const el = SLOT_ELIGIBLE[l.slot] || [];
    if (el.length !== 1) continue;
    const i = remaining.findIndex((p) => el.includes(p.pos));
    if (i >= 0) l.player = remaining.splice(i, 1)[0];
  }
  for (const l of lineup) {
    if (l.player) continue;
    const el = SLOT_ELIGIBLE[l.slot] || [];
    const i = remaining.findIndex((p) => el.includes(p.pos));
    if (i >= 0) l.player = remaining.splice(i, 1)[0];
  }
  return { lineup, bench: remaining };
}

// Roster-need multiplier for the user's own roster (plan section 9.1):
// 1.0 while a dedicated starting slot for the position is open, 0.9 when only
// a flex-type slot could start it, 0.55 once it would be bench depth.
export function userNeedMultipliers(rosterPositions, myPlayers) {
  const { lineup } = computeLineup(rosterPositions, myPlayers || []);
  const open = lineup.filter((l) => !l.player).map((l) => l.slot);
  const mult = {};
  const needPositions = new Set();
  for (const pos of ['QB', 'RB', 'WR', 'TE', 'K', 'DEF']) {
    const dedicated = open.includes(pos);
    const flex = open.some((s) => (SLOT_ELIGIBLE[s] || []).length > 1 && SLOT_ELIGIBLE[s].includes(pos));
    mult[pos] = dedicated ? 1.0 : flex ? 0.9 : 0.55;
    if (dedicated || flex) needPositions.add(pos);
  }
  return { mult, open, needPositions };
}
