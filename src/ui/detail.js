// src/ui/detail.js - player detail sheet: component projection, scoring
// breakdown, per-analyst ranks, value, survival, best alternative.
import { esc, n1, pct, posClass, survClass } from './dom.js';
import { injuryBadge } from './board.js';

function statLine(label, v, digits = 1) {
  if (v == null || (typeof v === 'number' && !v)) return '';
  return `<div>${label}</div><div>${typeof v === 'number' ? (digits ? n1(v) : Math.round(v)) : esc(v)}</div>`;
}

export function survivalCell(state, p, i) {
  const sim = state.sim;
  if (!sim || !sim.survival || !sim.survival[p.player_id] || sim.horizons[i] == null) return null;
  return { pick: sim.horizons[i], p: sim.survival[p.player_id][i] };
}

// Best same-position player likely (>= 50%) to be available at the user's next turn.
export function bestAlternative(state, p) {
  const sim = state.sim;
  if (!sim || !state.model) return null;
  const taken = state.taken || new Set();
  let best = null;
  for (const q of state.model.pool) {
    if (q.pos !== p.pos || q.player_id === p.player_id || taken.has(q.player_id)) continue;
    const s = sim.survival[q.player_id];
    if (!s || s[0] < 0.5) continue;
    if (!best || q.value > best.value) best = q;
  }
  return best;
}

export function renderDetail(state, p) {
  const proj = p.proj || {};
  const s = p.score || {};
  const isQB = p.pos === 'QB';
  const comp = isQB
    ? [statLine('Completions / attempts', proj.PaCom && proj.PaAtt ? `${Math.round(proj.PaCom)} / ${Math.round(proj.PaAtt)}` : null), statLine('Pass yards', proj.PaYds, 0), statLine('Pass TD', proj.PaTD), statLine('INT', proj.PaINT), statLine('Rush att', proj.RuAtt, 0), statLine('Rush yards', proj.RuYds, 0), statLine('Rush TD', proj.RuTD)]
    : [statLine('Rush att', proj.RuAtt, 0), statLine('Rush yards', proj.RuYds, 0), statLine('Rush TD', proj.RuTD), statLine('Targets', proj.Tar, 0), statLine('Receptions', proj.Rec), statLine('Rec yards', proj.ReYds, 0), statLine('Rec TD', proj.ReTD)];
  const bonusLines = (s.bonuses || []).map((b) => statLine(esc(b.key), b.pts)).join('');
  const ranks = p.ranks
    ? Object.keys(p.ranks)
        .map((a) => `<div>${esc(a)}</div><div>${p.ranks[a] == null ? '<span class="muted">unranked</span>' : p.ranks[a]}</div>`)
        .join('')
    : '<div class="muted">No rankings row for this player</div><div></div>';
  const s0 = survivalCell(state, p, 0);
  const s1 = survivalCell(state, p, 1);
  const alt = bestAlternative(state, p);
  return `<div class="scrim" data-action="close-detail"></div>
  <div class="sheet" role="dialog" aria-label="${esc(p.name)}">
    <div class="sheet-head">
      <div class="grow"><h2>${esc(p.name)}${injuryBadge(p)}</h2>
      <div class="muted"><span class="${posClass(p.pos)}">${esc(p.pos)}${p.posRank || ''}</span> ${esc(p.team || 'FA')} &middot; tier ${p.tier || '-'} &middot; value ${n1(p.value)}</div></div>
      <button class="btn" data-action="close-detail">Close</button>
    </div>
    ${state.taken && state.taken.has(p.player_id) ? '<p class="status-bad">Already drafted.</p>' : ''}
    <h3>Availability</h3>
    <div class="kv">
      <div>At your next turn${s0 ? ` (#${s0.pick})` : ''}</div><div class="${survClass(s0 && s0.p)}">${s0 ? pct(s0.p) : '-'}</div>
      <div>At the turn after${s1 ? ` (#${s1.pick})` : ''}</div><div class="${survClass(s1 && s1.p)}">${s1 ? pct(s1.p) : '-'}</div>
      <div>Best ${esc(p.pos)} likely there at your next turn</div><div>${alt ? `${esc(alt.name)} (${n1(alt.value)})` : state.sim ? 'none above 50%' : '-'}</div>
    </div>
    <h3>Value</h3>
    <div class="kv">
      <div>League points</div><div>${n1(p.lgPts)}</div>
      <div>Replacement (${esc(p.pos)}${state.model ? state.model.baselines[p.pos] : ''})</div><div>${n1(p.baselinePts)}</div>
      <div>VORP from projections</div><div>${n1(p.vorpProj)}</div>
      <div>Blended rank</div><div>${p.blendedRank != null ? n1(p.blendedRank) : '-'}</div>
      <div>VORP from rank</div><div>${p.vorpRank != null ? n1(p.vorpRank) : '-'}</div>
      <div>Blended value</div><div><b>${n1(p.value)}</b></div>
    </div>
    <h3>Analyst ranks</h3>
    <div class="kv">${ranks}${p.consensus != null ? `<div>Consensus</div><div>${p.consensus}</div>` : ''}</div>
    <h3>Projection</h3>
    <div class="kv">${comp.join('')}</div>
    <h3>Scoring breakdown</h3>
    <div class="kv">
      ${statLine('Base points', s.base)}
      ${bonusLines}
      ${s.fumLostEst ? `<div>Fumbles lost est. (${n1(s.fumLostEst)})</div><div>${n1(s.fumPts)}</div>` : ''}
      <div><b>Total</b></div><div><b>${n1(s.total)}</b></div>
    </div>
  </div>`;
}
