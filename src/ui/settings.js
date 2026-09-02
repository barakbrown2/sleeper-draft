// src/ui/settings.js - Settings screen (league picker, connection, player map, debug).
import { esc, fmtDateTime, fmtAgo } from './dom.js';
import { draftConfig, userSlot, picksForSlot, groupTurns } from '../draft.js';

export function renderSettings(state) {
  return [
    connectionCard(state),
    leagueCard(state),
    state.bundle ? leagueSummaryCard(state) : '',
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
  const turns = groupTurns(picks).map((t) => t.join('/')).join(', ');
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
  const lines = (state.log || []).slice(-60).map((l) => esc(l)).join('\n');
  return `<section class="card"><h2>Debug log</h2><pre class="log">${lines || '(empty)'}</pre>
    <button class="btn" data-action="clear-log">Clear log</button></section>`;
}

function dangerCard() {
  return `<section class="card"><button class="btn danger block" data-action="clear-all">Clear all app data</button>
    <p class="muted">Removes settings, uploaded files, cached league data, and the player map from this browser. Nothing is sent to Sleeper.</p></section>`;
}
