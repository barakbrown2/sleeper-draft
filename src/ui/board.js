// src/ui/board.js - Board screen: filter chips + ranked list of available
// players with value, points, tier, injury and survival to the next turns,
// the "likely there" card and the pre-draft plan.
import { esc, n0, n1, pct, posClass, survClass, fmtAge, ageClass } from './dom.js';

export const BOARD_FILTERS = ['ALL', 'QB', 'RB', 'WR', 'TE', 'FLEX'];

const val = (p) => (p.adjValue != null ? p.adjValue : p.value);

function fileStatusLine(state) {
  const parts = [];
  const pf = state.files.projections;
  parts.push(pf ? `projections <span class="${ageClass(pf.uploadedAt)}">${fmtAge(pf.uploadedAt)}</span>` : '<span class="status-bad">no projections</span>');
  const rk = state.activeRankingsKey;
  const rf = rk ? state.files[rk] : null;
  const label = rk === 'rankings1qb' ? '1QB rankings' : 'superflex rankings';
  parts.push(rf ? `${label} <span class="${ageClass(rf.uploadedAt)}">${fmtAge(rf.uploadedAt)}</span>` : `<span class="status-warn">no ${label}</span>`);
  return `<p class="muted small">Files: ${parts.join(', ')}. Manage in Settings.</p>`;
}

export function availablePlayers(state, filter) {
  const model = state.model;
  if (!model) return [];
  const taken = state.taken || new Set();
  let list = model.pool.filter((p) => !taken.has(p.player_id));
  if (filter === 'FLEX') list = list.filter((p) => p.pos === 'RB' || p.pos === 'WR' || p.pos === 'TE');
  else if (filter && filter !== 'ALL') list = list.filter((p) => p.pos === filter);
  return list.sort((a, b) => val(b) - val(a));
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

function needTag(p) {
  if (p.needMult == null || p.needMult >= 0.9) return '';
  return ' <span class="tag depth">depth</span>';
}

export function playerRow(state, p) {
  const rank = p.blendedRank != null ? Math.round(p.blendedRank) : '-';
  return `<div class="prow" data-action="detail" data-id="${esc(p.player_id)}">
    <div class="tier">T${p.tier || '-'}</div>
    <div class="grow">
      <div class="pname">${esc(p.name)}${injuryBadge(p)}</div>
      <div class="psub"><span class="${posClass(p.pos)}">${esc(p.pos)}${p.posRank || ''}</span> ${esc(p.team || 'FA')} <span class="muted">analysts #${rank} &middot; ${n1(p.lgPts)} pts</span>${waitTag(state, p)}${needTag(p)}</div>
    </div>
    ${survivalCells(state, p)}
    <div class="pnums"><div class="big">${n1(val(p))}</div><div class="muted small">VORP ${n1(p.vorpProj)}</div></div>
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
    .map((pos) => `<div class="row"><div class="slotname ${posClass(pos)}">${pos}</div><div class="grow"><div class="pname">${esc(w[pos].player.name)}</div><div class="psub">value ${n1(val(w[pos].player))}</div></div><div class="${survClass(w[pos].p)} surv">${pct(w[pos].p)}</div></div>`)
    .join('');
  if (!items) return '';
  const info = sim.horizonsInfo && sim.horizonsInfo[0] ? sim.horizonsInfo[0].join('/') : sim.horizons[0];
  return `<section class="card"><h3>Likely there at your next turn (#${esc(String(info))})</h3>${items}<p class="muted small">Sim N=${sim.N}, ${sim.ms} ms${sim.stale ? ', updating' : ''}.</p></section>`;
}

// Pre-draft plan: expected best available at each of the next turns, and
// how the top tiers at each position are expected to drain.
function planCard(state) {
  if (!state.live) return '';
  const plan = state.plan;
  const busy = state.planBusy;
  const isOpen = state.planOpen != null ? state.planOpen : !state.live.picks.length;
  const head = `<summary data-action="toggle-plan">Plan: your next turns${plan ? ` (from pick #${plan.atPick})` : ''}</summary>`;
  if (!plan) {
    return `<details class="card plan" ${isOpen ? 'open' : ''}>${head}<p class="muted small">${busy ? 'Simulating the whole draft' : 'Expected best available at each of your upcoming turns.'}</p><button class="btn" data-action="run-plan" ${busy ? 'disabled' : ''}>Run plan</button></details>`;
  }
  const hs = plan.horizons;
  const rows = ['QB', 'RB', 'WR', 'TE']
    .filter((pos) => plan.byPos[pos])
    .map(
      (pos) =>
        `<tr><th class="${posClass(pos)}">${pos}</th>${plan.byPos[pos]
          .map((c) => `<td><b>${n0(c.expBest)}</b><br><span class="muted small">${c.likely[0] ? esc(c.likely[0].name.split(' ').slice(-1)[0]) : '-'}</span></td>`)
          .join('')}</tr>`,
    )
    .join('');
  const table = `<div class="tablewrap"><table class="plantable"><thead><tr><th></th>${hs.map((h) => `<th>#${h}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>`;
  const tiers = ['QB', 'RB', 'WR', 'TE']
    .filter((pos) => plan.tiers[pos] && plan.tiers[pos].length)
    .map((pos) =>
      plan.tiers[pos]
        .map((t) => {
          const names = t.members
            .slice(0, 3)
            .map((m) => esc(m.name.split(' ').slice(-1)[0]))
            .join(', ');
          const more = t.members.length > 3 ? ` +${t.members.length - 3}` : '';
          const cells = hs.map((h, i) => `#${h} <b class="${survClass(t.pAny[i])}">${t.expectedLeft[i].toFixed(1)}</b>`).join(' &middot; ');
          const drop = t.dropToNext != null ? ` <span class="muted">then ${Math.round(t.dropToNext)} pts lower</span>` : '';
          return `<div class="tierline small"><span class="${posClass(pos)}">${pos}</span> T${t.tier} (${names}${more}): ${cells}${drop}</div>`;
        })
        .join(''),
    )
    .join('');
  return `<details class="card plan" ${isOpen ? 'open' : ''}>${head}
    <p class="muted small">Top row per position: expected best value at that turn and the most likely name (50%+ to be there). Tier lines: expected players left from each top tier at each turn, then the value drop behind it.</p>
    ${table}${tiers}
    <p class="muted small">N=${plan.N}, ${plan.ms} ms${busy ? ', updating' : ''}. <button class="btn" data-action="run-plan" ${busy ? 'disabled' : ''}>Re-run</button></p>
  </details>`;
}

export function renderBoard(state) {
  if (!state.model) {
    if (!state.leagueId) return '<div class="placeholder">Select a league in Settings.</div>';
    if (!state.parsed.projections) {
      const hasSite = (state.siteFiles || []).some((f) => f.kind === 'projections');
      return `<div class="placeholder">No projections loaded in this browser.${hasSite ? '<br><br><button class="btn primary" data-action="load-site-file" data-kind="projections">Load projections from the site</button><br>' : ''}<br>Or upload the CSV in Settings.</div>`;
    }
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
  const needNote = state.need && state.need.hasRoster ? ` Values are scaled by your roster need (open starters: ${state.need.open.length ? esc(state.need.open.join(', ').replace(/SUPER_FLEX/g, 'SF')) : 'none'}).` : '';
  return `${state.banner || ''}${planCard(state)}<div class="chips">${BOARD_FILTERS.map((f) => `<button class="chip" data-action="board-filter" data-pos="${f}" aria-pressed="${f === filter}">${f}</button>`).join('')}</div>
    ${legend}
    <div class="card list">${rows || '<div class="placeholder">No players</div>'}</div>
    ${list.length > limit ? '<button class="btn block" data-action="board-more">Show more</button>' : ''}
    ${waitOnCard(state)}
    <p class="muted small">Value = blended VORP over replacement (${esc(bl)}).${needNote} Tap a row for details.</p>
    ${fileStatusLine(state)}`;
}
