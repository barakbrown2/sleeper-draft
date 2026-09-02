// src/ui/board.js - Board screen: filter chips + ranked list of available players.
import { esc, n1, posClass } from './dom.js';

export const BOARD_FILTERS = ['ALL', 'QB', 'RB', 'WR', 'TE', 'FLEX'];

export function availablePlayers(state, filter) {
  const model = state.model;
  if (!model) return [];
  const taken = state.taken || new Set();
  let list = model.pool.filter((p) => !taken.has(p.player_id));
  if (filter === 'FLEX') list = list.filter((p) => p.pos === 'RB' || p.pos === 'WR' || p.pos === 'TE');
  else if (filter && filter !== 'ALL') list = list.filter((p) => p.pos === filter);
  return list.sort((a, b) => b.value - a.value);
}

export function injuryBadge(p) {
  if (!p.injury) return '';
  const short = { Questionable: 'Q', Doubtful: 'D', Out: 'O', IR: 'IR', PUP: 'PUP', Sus: 'SUS', NA: 'NA', COV: 'COV' }[p.injury] || p.injury;
  return ` <span class="inj">${esc(short)}</span>`;
}

export function playerRow(p, extra = '') {
  const rank = p.blendedRank != null ? Math.round(p.blendedRank) : '-';
  return `<div class="prow" data-action="detail" data-id="${esc(p.player_id)}">
    <div class="tier">T${p.tier || '-'}</div>
    <div class="grow">
      <div class="pname">${esc(p.name)}${injuryBadge(p)}</div>
      <div class="psub"><span class="${posClass(p.pos)}">${esc(p.pos)}${p.posRank || ''}</span> ${esc(p.team || 'FA')} <span class="muted">rank ${rank}</span></div>
    </div>
    ${extra}
    <div class="pnums"><div class="big">${n1(p.value)}</div><div class="muted small">${n1(p.lgPts)} pts</div></div>
  </div>`;
}

export function renderBoard(state) {
  if (!state.model) {
    if (!state.leagueId) return '<div class="placeholder">Select a league in Settings.</div>';
    if (!state.parsed.projections) return '<div class="placeholder">Upload the projections CSV in Settings.</div>';
    return '<div class="placeholder">Building the board</div>';
  }
  const filter = state.boardFilter || 'ALL';
  const limit = state.boardLimit || 12;
  const list = availablePlayers(state, filter);
  const rows = list
    .slice(0, limit)
    .map((p) => playerRow(p))
    .join('');
  const b = state.model.baselines;
  const bl = Object.keys(b)
    .map((k) => `${k}${b[k]}`)
    .join(' ');
  return `<div class="chips">${BOARD_FILTERS.map((f) => `<button class="chip" data-action="board-filter" data-pos="${f}" aria-pressed="${f === filter}">${f}</button>`).join('')}</div>
    <div class="card list">${rows || '<div class="placeholder">No players</div>'}</div>
    ${list.length > limit ? '<button class="btn block" data-action="board-more">Show more</button>' : ''}
    <p class="muted small">Value = blended VORP over replacement (${esc(bl)}). Tap a row for details.</p>`;
}
