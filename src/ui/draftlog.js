// src/ui/draftlog.js - Draft screen: full pick log (newest first or grouped
// by position) and per-team rosters. Read-only.
import { esc, posClass, fmtAgo } from './dom.js';
import { roundOf, pickInRound } from '../draft.js';

export const DRAFT_FILTERS = ['ALL', 'QB', 'RB', 'WR', 'TE'];

export function teamName(state, userId, slot) {
  const users = (state.bundle && state.bundle.users) || [];
  const u = users.find((x) => x.user_id === userId);
  if (u) return (u.metadata && u.metadata.team_name) || u.display_name || `Slot ${slot}`;
  return `Slot ${slot}`;
}

function pickName(p) {
  const m = p.metadata || {};
  return `${m.first_name || ''} ${m.last_name || ''}`.trim() || p.player_id;
}

function pickRow(state, p, teams) {
  const m = p.metadata || {};
  const mine = state.live && state.live.turn && Number(p.draft_slot) === state.live.turn.slot;
  const rnd = roundOf(p.pick_no, teams);
  const pir = pickInRound(p.pick_no, teams);
  return `<div class="prow ${mine ? 'mine' : ''}">
    <div class="tier">${p.pick_no}</div>
    <div class="grow">
      <div class="pname">${esc(pickName(p))}${p.is_keeper ? ' <span class="muted small">keeper</span>' : ''}</div>
      <div class="psub"><span class="${posClass(m.position)}">${esc(m.position || '')}</span> ${esc(m.team || 'FA')} <span class="muted">R${rnd}.${pir} ${esc(teamName(state, p.picked_by, p.draft_slot))}</span></div>
    </div>
    ${mine ? '<div class="you">YOU</div>' : ''}
  </div>`;
}

export function renderDraftLog(state) {
  const live = state.live;
  if (!live) return '<div class="placeholder">Start the live draft or a replay in Settings.</div>';
  const teams = live.turn.cfg.teams;
  const view = state.draftView || 'picks';
  const filter = state.draftFilter || 'ALL';
  const sort = state.draftSort || 'pick';
  const picks = live.picks;
  const t = live.turn;
  const status = t.complete
    ? 'Draft complete'
    : `Pick ${t.current} (R${t.currentRound}.${pickInRound(t.current, teams)}) on the clock: ${esc(teamName(state, slotUser(live, t.currentSlot), t.currentSlot))}`;
  const controls = `<div class="chips">
    <button class="chip" data-action="draft-view" data-view="picks" aria-pressed="${view === 'picks'}">Picks</button>
    <button class="chip" data-action="draft-view" data-view="teams" aria-pressed="${view === 'teams'}">Teams</button>
    ${view === 'picks' ? `<button class="chip" data-action="draft-sort" data-sort="${sort === 'pick' ? 'pos' : 'pick'}" aria-pressed="${sort === 'pos'}">By position</button>` : ''}
  </div>
  ${view === 'picks' ? `<div class="chips">${DRAFT_FILTERS.map((f) => `<button class="chip" data-action="draft-filter" data-pos="${f}" aria-pressed="${f === filter}">${f}</button>`).join('')}</div>` : ''}`;
  const head = `<div class="card"><div><b>${status}</b></div><div class="muted small">${picks.length} of ${t.cfg.totalPicks} picks made${live.lastFetch ? `, updated ${fmtAgo(live.lastFetch)}` : ''}${live.mode === 'replay' ? ' (replay)' : ''}</div></div>`;
  if (view === 'teams') return controls + head + renderTeams(state, teams);
  let list = filter === 'ALL' ? [...picks] : picks.filter((p) => (p.metadata && p.metadata.position) === filter);
  if (sort === 'pos') {
    const order = { QB: 0, RB: 1, WR: 2, TE: 3, K: 4, DEF: 5 };
    list.sort((a, b) => (order[a.metadata.position] ?? 9) - (order[b.metadata.position] ?? 9) || a.pick_no - b.pick_no);
  } else list.sort((a, b) => b.pick_no - a.pick_no);
  const rows = list.map((p) => pickRow(state, p, teams)).join('');
  return controls + head + `<div class="card list">${rows || '<div class="placeholder">No picks yet</div>'}</div>`;
}

function slotUser(live, slot) {
  const r = live.rosters && live.rosters[slot];
  return r ? r.user_id : null;
}

function renderTeams(state, teams) {
  const live = state.live;
  const out = [];
  for (let slot = 1; slot <= teams; slot++) {
    const r = live.rosters[slot] || { players: [] };
    const counts = {};
    for (const p of r.players) {
      const pos = (p.metadata && p.metadata.position) || '?';
      counts[pos] = (counts[pos] || 0) + 1;
    }
    const mine = slot === live.turn.slot;
    const countLine = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF']
      .filter((k) => counts[k])
      .map((k) => `<span class="${posClass(k)}">${k}</span> ${counts[k]}`)
      .join(' &middot; ');
    const players = [...r.players]
      .sort((a, b) => a.pick_no - b.pick_no)
      .map((p) => `<div class="teamrow"><span class="muted small">R${roundOf(p.pick_no, teams)}</span> ${esc(pickName(p))} <span class="${posClass(p.metadata && p.metadata.position)} small">${esc((p.metadata && p.metadata.position) || '')}</span></div>`)
      .join('');
    out.push(`<section class="card ${mine ? 'good' : ''}">
      <h3>${slot}. ${esc(teamName(state, r.user_id, slot))}${mine ? ' (you)' : ''}</h3>
      <div class="small">${countLine || '<span class="muted">no picks yet</span>'}</div>
      ${players}
    </section>`);
  }
  return out.join('');
}
