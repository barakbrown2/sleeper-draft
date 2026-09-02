// src/ui/settings.js - Settings screen: connection, league picker, files,
// name matching, player map, debug log.
import { esc, fmtDateTime, fmtAgo, posClass } from './dom.js';
import { draftConfig, userSlot, picksForSlot, groupTurns } from '../draft.js';

export function renderSettings(state) {
  return [
    connectionCard(state),
    leagueCard(state),
    state.bundle ? leagueSummaryCard(state) : '',
    filesCard(state),
    unmatchedCard(state),
    playersCard(state),
    debugCard(state),
    dangerCard(),
  ].join('');
}

function connectionCard(state) {
  const c = state.conn;
  let cls = '';
  let body;
  if (!c) {
    body = '<p class="muted">Checking api.sleeper.app from this page</p>';
  } else if (c.ok) {
    cls = 'good';
    body = `<div class="kv">
      <div>CORS from</div><div>${esc(c.origin)}</div>
      <div>Status</div><div class="status-ok">OK (${c.ms} ms)</div>
      <div>User</div><div>${esc(c.username)} (${esc(c.user_id)})</div>
      <div>Season</div><div>${esc(state.season || '-')}</div>
      <div>Leagues found</div><div>${state.leagues.length}</div>
      <div>Checked</div><div>${fmtAgo(c.checkedAt)}</div>
    </div>`;
  } else {
    cls = 'bad';
    body = `<div class="kv">
      <div>CORS from</div><div>${esc(c.origin)}</div>
      <div>Status</div><div class="status-bad">FAILED</div>
      <div>Error</div><div>${esc(c.error)}</div>
    </div>
    <p class="muted">If this keeps failing from the deployed page, the plan's contingency is a GET-only Cloudflare Worker proxy.</p>`;
  }
  return `<section class="card ${cls}">
    <h2>Sleeper connection</h2>
    ${body}
    <form data-form="username" class="row">
      <input type="text" name="username" value="${esc(state.settings.username)}" autocapitalize="none" autocorrect="off" aria-label="Sleeper username">
      <button class="btn" type="submit">Set</button>
    </form>
    <button class="btn" data-action="recheck">Re-check API</button>
  </section>`;
}

function rosterSummary(rp) {
  const counts = {};
  for (const p of rp || []) counts[p] = (counts[p] || 0) + 1;
  return Object.entries(counts)
    .filter(([k]) => k !== 'BN' && k !== 'IR' && k !== 'TAXI')
    .map(([k, v]) => (v > 1 ? `${v}${k}` : k))
    .join(' ')
    .replace(/SUPER_FLEX/g, 'SF');
}

function leagueCard(state) {
  const list = state.leagues || [];
  let body = '';
  if (!list.length) {
    body = state.conn && state.conn.ok ? '<p class="muted">No leagues found for this season.</p>' : '<p class="muted">Waiting for connection</p>';
  } else {
    body = list
      .map(
        (l) => `<button class="league-opt" data-action="select-league" data-id="${esc(l.league_id)}" aria-pressed="${l.league_id === state.leagueId}">
        <div class="name">${esc(l.name)}</div>
        <div class="sub">${l.total_rosters} teams - ${esc(l.status)} - ${esc(rosterSummary(l.roster_positions))}</div>
      </button>`,
      )
      .join('');
  }
  return `<section class="card"><h2>League</h2>${body}</section>`;
}

function fmtScoring(ss) {
  if (!ss) return '-';
  const keys = ['pass_yd', 'pass_td', 'pass_int', 'rush_yd', 'rush_td', 'rec', 'rec_yd', 'rec_td', 'fum_lost', 'bonus_rec_te'];
  const parts = keys.filter((k) => ss[k] != null && ss[k] !== 0).map((k) => `${k} ${ss[k]}`);
  const bonuses = Object.keys(ss)
    .filter((k) => k.startsWith('bonus_') && ss[k] && !keys.includes(k))
    .map((k) => `${k} ${ss[k]}`);
  return parts.concat(bonuses).join(', ');
}

function leagueSummaryCard(state) {
  const { league, draft, users, fetchedAt } = state.bundle;
  const cfg = draftConfig(draft);
  const uid = state.user ? state.user.user_id : state.settings.userId;
  const slot = userSlot(draft, uid);
  const picks = slot ? picksForSlot(slot, cfg.teams, cfg.rounds, { type: cfg.type, reversalRound: cfg.reversalRound }) : [];
  const turns = groupTurns(picks)
    .map((t) => t.join('/'))
    .join(', ');
  const rp = league.roster_positions || [];
  const hasK = rp.includes('K');
  const hasDef = rp.includes('DEF');
  const me = (users || []).find((u) => u.user_id === uid);
  return `<section class="card">
    <h2>${esc(league.name)}</h2>
    <div class="kv">
      <div>Teams</div><div>${league.total_rosters}</div>
      <div>Roster</div><div>${esc((league.roster_positions || []).join(', ').replace(/SUPER_FLEX/g, 'SF'))}</div>
      <div>K / DEF slots</div><div>${hasK ? 'K' : 'no K'}, ${hasDef ? 'DEF' : 'no DEF'}</div>
      <div>Draft</div><div>${esc(cfg.type)}, ${cfg.rounds} rounds, ${cfg.pickTimer} s clock${cfg.reversalRound ? `, reversal round ${cfg.reversalRound}` : ''}</div>
      <div>Draft status</div><div>${esc(cfg.status)}</div>
      <div>Start</div><div>${fmtDateTime(cfg.startTime)}</div>
      <div>Your team</div><div>${esc(me && me.metadata && me.metadata.team_name ? me.metadata.team_name : me ? me.display_name : '-')}</div>
      <div>Your slot</div><div>${slot != null ? slot : 'not in draft order yet'}</div>
      <div>Your picks</div><div>${esc(turns || '-')}</div>
      <div>Keepers max</div><div>${league.settings && league.settings.max_keepers != null ? league.settings.max_keepers : '-'}</div>
      <div>Scoring</div><div>${esc(fmtScoring(league.scoring_settings))}</div>
      <div>Refreshed</div><div>${fmtAgo(fetchedAt)}</div>
    </div>
    <button class="btn" data-action="refresh-league">Refresh league</button>
  </section>`;
}

const FILE_LABELS = [
  ['projections', 'Projections CSV (season totals)'],
  ['rankings1qb', 'Rankings CSV (1QB)'],
  ['rankingsSuperflex', 'Rankings CSV (Superflex)'],
];

function filesCard(state) {
  const items = FILE_LABELS.map(([k, label]) => {
    const f = state.files[k];
    const p = state.parsed[k];
    const err = state.parseErrors[k];
    let sub;
    if (!f) sub = '<span class="muted">Not uploaded</span>';
    else if (err) sub = `<span class="status-bad">Parse error: ${esc(err)}</span>`;
    else if (k === 'projections')
      sub = `${p.count} rows: ${Object.entries(p.counts)
        .map(([a, b]) => `${b} ${a}`)
        .join(', ')}`;
    else {
      const expect = k === 'rankingsSuperflex' ? 'superflex' : '1qb';
      const warn = p.format !== 'unknown' && p.format !== expect ? ` <span class="status-warn">looks like a ${esc(p.format)} export</span>` : '';
      sub = `${p.count} players; analysts ${esc(p.analysts.join(', '))}${p.duplicates.length ? `; ${p.duplicates.length} duplicate merged` : ''}${warn}`;
    }
    const active = k !== 'projections' && state.activeRankingsKey === k && f ? ' <span class="status-ok">in use</span>' : '';
    return `<div class="filerow">
      <div class="grow"><div><b>${label}</b>${active}</div><div class="muted small">${sub}</div>${f ? `<div class="muted small">${esc(f.name)}, ${fmtAgo(f.uploadedAt)} (${fmtDateTime(f.uploadedAt)})</div>` : ''}</div>
      <div class="filebtns"><label class="btn">${f ? 'Replace' : 'Upload'}<input type="file" accept=".csv,text/csv,text/plain" data-file="${k}" hidden></label>${f ? `<button class="btn" data-action="remove-file" data-file="${k}">Remove</button>` : ''}</div>
    </div>`;
  }).join('');
  let sel = '';
  if (state.leagueId) {
    const forced = state.settings.rankingsFileByLeague[state.leagueId] || 'auto';
    const rp = (state.bundle && state.bundle.league.roster_positions) || [];
    const auto = rp.includes('SUPER_FLEX') ? 'Superflex' : '1QB';
    const opt = (v, label) => `<option value="${v}" ${forced === v ? 'selected' : ''}>${label}</option>`;
    sel = `<div class="row"><div class="grow">Rankings file for this league</div><select data-select="rankingsFile">${opt('auto', `Auto (${auto})`)}${opt('rankings1qb', '1QB')}${opt('rankingsSuperflex', 'Superflex')}</select></div>`;
  }
  return `<section class="card"><h2>Files</h2><p class="muted small">Upload from the Files app. Files stay in this browser and are re-parsed on every load.</p>${items}${sel}</section>`;
}

function unmatchedCard(state) {
  const m = state.match;
  if (!m) {
    return state.parsed.projections ? '<section class="card"><h2>Name matching</h2><p class="muted">Waiting for the player map</p></section>' : '';
  }
  if (!state.parsed.projections && !m.hasRank) return '';
  const summary = `<div class="kv">
    <div>Projections</div><div>${state.parsed.projections ? `${m.proj.matched.length} / ${m.projTotal} matched` : 'not uploaded'}</div>
    <div>Rankings (${m.rankKey === 'rankingsSuperflex' ? 'superflex' : '1QB'})</div><div>${m.hasRank ? `${m.rank.matched.length} / ${m.rankTotal} matched` : 'not uploaded'}</div>
  </div>`;
  const un = [...m.proj.unmatched.map((x) => ({ ...x, src: 'projections' })), ...m.rank.unmatched.map((x) => ({ ...x, src: 'rankings' }))];
  const amb = [...m.proj.ambiguous.map((x) => ({ ...x, src: 'projections' })), ...m.rank.ambiguous.map((x) => ({ ...x, src: 'rankings' }))];
  const rowHtml = (x, extra) => `<div class="row">
    <div class="grow"><b>${esc(x.row.name)}</b> <span class="${posClass(x.row.pos)}">${esc(x.row.pos)}</span> <span class="muted small">${esc(x.row.teamRaw || '-')}, ${x.src}${extra || ''}</span></div>
    <button class="btn" data-action="fix" data-key="${esc(x.row.key)}" data-pos="${esc(x.row.pos)}" data-name="${esc(x.row.name)}">Fix</button>
    <button class="btn" data-action="ignore" data-key="${esc(x.row.key)}" data-pos="${esc(x.row.pos)}">Ignore</button>
  </div>`;
  const unHtml = un.length ? `<h3>Unmatched (${un.length})</h3>${un.map((x) => rowHtml(x)).join('')}` : '<p class="status-ok">All names matched.</p>';
  const ambHtml = amb.length ? `<h3>Check these (${amb.length})</h3>${amb.map((x) => rowHtml(x, ` matched to ${esc(x.player.full_name)} ${esc(x.player.team || 'FA')}`)).join('')}` : '';
  const nOv = Object.keys(state.settings.nameOverrides || {}).length;
  const ov = nOv ? `<div class="row"><div class="grow muted small">${nOv} manual fix${nOv > 1 ? 'es' : ''} saved</div><button class="btn" data-action="reset-overrides">Reset fixes</button></div>` : '';
  return `<section class="card ${un.length ? 'warn' : ''}"><h2>Name matching</h2>${summary}${fixPanel(state)}${unHtml}${ambHtml}${ov}</section>`;
}

function fixPanel(state) {
  const f = state.fixing;
  if (!f) return '';
  return `<div class="fixpanel">
    <div><b>Match "${esc(f.name)}" (${esc(f.pos)}) to a Sleeper player</b></div>
    <input type="search" data-search="fix" value="${esc(f.query)}" placeholder="Search Sleeper players" autocapitalize="none" autocorrect="off">
    <div id="fix-results">${renderFixResults(state)}</div>
    <button class="btn" data-action="cancel-fix">Cancel</button>
  </div>`;
}

export function renderFixResults(state) {
  const f = state.fixing;
  if (!f) return '';
  if (!f.results.length) return '<p class="muted small">No players found.</p>';
  return f.results
    .map(
      (p) => `<button class="league-opt" data-action="pick" data-id="${esc(p.player_id)}">
      <div class="name">${esc(p.full_name)}</div>
      <div class="sub">${esc(p.position)} ${esc(p.team || 'FA')} ${esc(p.status || '')}</div>
    </button>`,
    )
    .join('');
}

function playersCard(state) {
  const m = state.playersMeta;
  let body;
  if (state.busy.players) body = `<p class="muted">${esc(state.busy.players)}</p>`;
  else if (!m) body = '<p class="muted">Not loaded</p>';
  else
    body = `<div class="kv">
      <div>Players cached</div><div>${m.count}</div>
      <div>Fetched</div><div>${fmtAgo(m.fetchedAt)}${m.stale ? ' <span class="status-warn">(stale, refresh failed)</span>' : ''}</div>
      <div>Source</div><div>${m.fromCache ? 'IndexedDB' : 'network'}</div>
    </div>`;
  return `<section class="card"><h2>Sleeper player map</h2>${body}<button class="btn" data-action="refresh-players">Refresh player map</button></section>`;
}

function debugCard(state) {
  const lines = (state.log || [])
    .slice(-60)
    .map((l) => esc(l))
    .join('\n');
  return `<section class="card"><h2>Debug log</h2><pre class="log">${lines || '(empty)'}</pre>
    <button class="btn" data-action="clear-log">Clear log</button></section>`;
}

function dangerCard() {
  return `<section class="card"><button class="btn danger block" data-action="clear-all">Clear all app data</button>
    <p class="muted">Removes settings, uploaded files, cached league data, and the player map from this browser. Nothing is sent to Sleeper.</p></section>`;
}
