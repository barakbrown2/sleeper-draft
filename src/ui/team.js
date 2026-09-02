// src/ui/team.js - My Team screen: roster slots filled vs open, projected
// starter total, positional needs.
import { esc, posClass, n1 } from './dom.js';
import { computeLineup } from '../lineup.js';

export { computeLineup, SLOT_ELIGIBLE, starterSlots } from '../lineup.js';

// Players on the user's roster as pool entries (or stubs for unprojected picks).
export function myPlayers(state) {
  const live = state.live;
  if (!live || !live.turn.slot) return [];
  const r = live.rosters[live.turn.slot];
  if (!r) return [];
  return r.players.map((pick) => {
    const p = state.model && state.model.byId.get(String(pick.player_id));
    if (p) return { ...p, pick };
    const m = pick.metadata || {};
    return { player_id: String(pick.player_id), name: `${m.first_name || ''} ${m.last_name || ''}`.trim(), pos: m.position || '?', team: m.team || null, lgPts: 0, value: 0, pick, stub: true };
  });
}

export function renderTeam(state) {
  if (!state.live) return '<div class="placeholder">Start the live draft or a replay in Settings.</div>';
  const rp = state.bundle.league.roster_positions || [];
  const mine = myPlayers(state);
  const { lineup, bench } = computeLineup(rp, mine);
  const starters = lineup.filter((l) => l.player);
  const total = starters.reduce((s, l) => s + (l.player.lgPts || 0), 0);
  const open = lineup.filter((l) => !l.player).map((l) => l.slot.replace('SUPER_FLEX', 'SF'));
  const openCounts = {};
  for (const s of open) openCounts[s] = (openCounts[s] || 0) + 1;
  const needs = Object.keys(openCounts)
    .map((s) => (openCounts[s] > 1 ? `${openCounts[s]} ${s}` : s))
    .join(', ');
  const slotRow = (l) => `<div class="row"><div class="slotname">${esc(l.slot.replace('SUPER_FLEX', 'SF'))}</div>
    <div class="grow">${l.player ? `<div class="pname">${esc(l.player.name)}</div><div class="psub"><span class="${posClass(l.player.pos)}">${esc(l.player.pos)}</span> ${esc(l.player.team || 'FA')}${l.player.pick ? ` <span class="muted">pick ${l.player.pick.pick_no}</span>` : ''}</div>` : '<span class="muted">open</span>'}</div>
    <div class="val">${l.player && !l.player.stub ? n1(l.player.lgPts) : ''}</div></div>`;
  const benchRows = bench.length
    ? bench.map((p) => `<div class="row"><div class="slotname">BN</div><div class="grow"><div class="pname">${esc(p.name)}</div><div class="psub"><span class="${posClass(p.pos)}">${esc(p.pos)}</span> ${esc(p.team || 'FA')}</div></div><div class="val">${p.stub ? '' : n1(p.lgPts)}</div></div>`).join('')
    : '<p class="muted">No bench players yet.</p>';
  return `<section class="card">
    <h2>Starters</h2>
    <div class="kv"><div>Projected starters (season)</div><div><b>${n1(total)}</b></div><div>Per week</div><div>${n1(total / 17)}</div><div>Open starting slots</div><div>${needs ? `<span class="status-warn">${esc(needs)}</span>` : '<span class="status-ok">none</span>'}</div></div>
    ${lineup.map(slotRow).join('')}
  </section>
  <section class="card"><h2>Bench (${bench.length})</h2>${benchRows}</section>
  <section class="card"><h2>Your picks</h2>${
    state.live.turn.userPicks.length
      ? `<p class="small">${state.live.turn.userPicks
          .map((p) => (p < (state.live.turn.current || Infinity) ? `<span class="muted">${p}</span>` : `<b>${p}</b>`))
          .join(', ')}</p>`
      : '<p class="muted">Not in the draft order yet.</p>'
  }</section>`;
}
