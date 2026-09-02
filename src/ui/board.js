// src/ui/board.js - Board screen: filter chips + ranked list of available
// players with value, points, tier, injury and survival to the next turns.
import { esc, n1, pct, posClass, survClass } from './dom.js';

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

function survivalCells(state, p) {
  const sim = state.sim;
  if (!sim || !sim.survival) return '';
  const s = sim.survival[p.player_id];
  if (!s) return '<div class="surv muted">-</div>';
  const second = sim.horizons.length > 1 ? `<div class="${survClass(s[1])} small">${pct(s[1])}</div>` : '';
  return `<div class="surv"><div class="${survClass(s[0])}">${pct(s[0])}</div>${second}</div>`;
}

// Row tag from the survival sim: gone before your next turn, or safe to wait on.
function waitTag(state, p) {
  const sim = state.sim;
  if (!sim || !sim.survival || !sim.survival[p.player_id]) return '';
  const s0 = sim.survival[p.player_id][0];
  if (s0 < 0.4) return ` <span class="tag gone">gone by #${sim.horizons[0]}</span>`;
  if (s0 >= 0.7) return ` <span class="tag wait">likely there at #${sim.horizons[0]}</span>`;
  return '';
}

export function playerRow(state, p) {
  const rank = p.blendedRank != null ? Math.round(p.blendedRank) : '-';
  return `<div class="prow" data-action="detail" data-id="${esc(p.player_id)}">
    <div class="tier">T${p.tier || '-'}</div>
    <div class="grow">
      <div class="pname">${esc(p.name)}${injuryBadge(p)}</div>
      <div class="psub"><span class="${posClass(p.pos)}">${esc(p.pos)}${p.posRank || ''}</span> ${esc(p.team || 'FA')} <span class="muted">rank ${rank} &middot; ${n1(p.lgPts)} pts</span>${waitTag(state, p)}</div>
    </div>
    ${survivalCells(state, p)}
    <div class="pnums"><div class="big">${n1(p.value)}</div><div class="muted small">VORP ${n1(p.vorpProj)}</div></div>
  </div>`;
}

// "You can wait on X": best player per position likely (>= 50%) to reach the next turn.
function waitOnCard(state) {
  const w = state.waitOn;
  const sim = state.sim;
  if (!w || !sim) return '';
  const order = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF'];
  const items = order
    .filter((pos) => w[pos])
    .map((pos) => `<div class="row"><div class="slotname ${posClass(pos)}">${pos}</div><div class="grow"><div class="pname">${esc(w[pos].player.name)}</div><div class="psub">value ${n1(w[pos].player.value)}</div></div><div class="${survClass(w[pos].p)} surv">${pct(w[pos].p)}</div></div>`)
    .join('');
  if (!items) return '';
  const info = sim.horizonsInfo && sim.horizonsInfo[0] ? sim.horizonsInfo[0].join('/') : sim.horizons[0];
  return `<section class="card"><h3>Likely there at your next turn (#${esc(String(info))})</h3>${items}<p class="muted small">Sim N=${sim.N}, ${sim.ms} ms${sim.stale ? ', updating' : ''}.</p></section>`;
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
    .map((p) => playerRow(state, p))
    .join('');
  const b = state.model.baselines;
  const bl = Object.keys(b)
    .map((k) => `${k}${b[k]}`)
    .join(' ');
  const sim = state.sim;
  const legend = sim
    ? `<div class="muted small legend">Available at your next turn (#${sim.horizons[0]})${sim.horizons.length > 1 ? ` / the one after (#${sim.horizons[1]})` : ''}${sim.stale ? ', updating' : ''}</div>`
    : '';
  return `${state.banner || ''}<div class="chips">${BOARD_FILTERS.map((f) => `<button class="chip" data-action="board-filter" data-pos="${f}" aria-pressed="${f === filter}">${f}</button>`).join('')}</div>
    ${legend}
    <div class="card list">${rows || '<div class="placeholder">No players</div>'}</div>
    ${list.length > limit ? '<button class="btn block" data-action="board-more">Show more</button>' : ''}
    ${waitOnCard(state)}
    <p class="muted small">Value = blended VORP over replacement (${esc(bl)}). Tap a row for details.</p>`;
}
