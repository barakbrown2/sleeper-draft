// src/app.js - app shell: state, init, tab routing, event delegation.
import * as api from './api.js';
import { KEYS, loadJSON, saveJSON, migrate, clearAll } from './storage.js';
import { parseProjections, parseRankings, buildPlayerIndex, matchRows, searchPlayers } from './csv.js';
import { buildPool } from './model.js';
import { DEFAULT_VALUE_SETTINGS } from './value.js';
import { DEFAULT_CVS, DEFAULT_FUMBLES } from './scoring.js';
import { esc, $ } from './ui/dom.js';
import { renderSettings, renderFixResults } from './ui/settings.js';
import { renderBoard } from './ui/board.js';

const DEFAULT_SETTINGS = {
  v: 1,
  username: 'barakbrown2',
  userId: null,
  leagueId: null,
  nameOverrides: {},
  rankingsFileByLeague: {},
  value: {},
  cvs: {},
  fumbles: {},
};

const TABS = [
  ['board', 'Board'],
  ['team', 'My Team'],
  ['draft', 'Draft'],
  ['settings', 'Settings'],
];

const FILE_KEYS = {
  projections: KEYS.projections,
  rankings1qb: KEYS.rankings1qb,
  rankingsSuperflex: KEYS.rankingsSuperflex,
};

export const state = {
  settings: null,
  tab: 'settings',
  conn: null,
  user: null,
  season: null,
  leagues: [],
  leagueId: null,
  bundle: null,
  playersMeta: null,
  players: null,
  playerIndex: null,
  files: { projections: null, rankings1qb: null, rankingsSuperflex: null },
  parsed: { projections: null, rankings1qb: null, rankingsSuperflex: null },
  parseErrors: {},
  activeRankingsKey: null,
  match: null,
  fixing: null,
  model: null,
  valueSettings: null,
  cvs: null,
  fumbles: null,
  taken: new Set(),
  boardFilter: 'ALL',
  boardLimit: 12,
  busy: {},
  log: [],
};

// ---- logging (visible in Settings; persisted so phone crashes are debuggable) ----
export function log(msg) {
  const line = `${new Date().toLocaleTimeString()} ${msg}`;
  state.log.push(line);
  if (state.log.length > 200) state.log.splice(0, state.log.length - 200);
  saveJSON(KEYS.log, state.log.slice(-100));
}

let toastTimer = null;
export function toast(msg, kind = 'error', ms = 5000) {
  const t = $('toast');
  if (!t) return;
  t.textContent = msg;
  t.className = kind;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    t.hidden = true;
  }, ms);
}

function saveSettings() {
  saveJSON(KEYS.settings, state.settings);
}

// ---- rendering ----
function renderHeader() {
  const name = state.bundle ? state.bundle.league.name : 'Sleeper Draft Assistant';
  const sub = state.bundle ? `${esc(state.bundle.draft ? state.bundle.draft.status : 'no draft')}` : 'Pick a league in Settings';
  return `<h1>${esc(name)}</h1><div class="muted">${sub}</div>`;
}

function renderPlaceholder(tab) {
  const label = TABS.find((t) => t[0] === tab)[1];
  if (!state.leagueId) return `<div class="placeholder">Select a league in Settings to use ${esc(label)}.</div>`;
  if (!state.parsed.projections) return `<div class="placeholder">Upload the projections CSV in Settings to use ${esc(label)}.</div>`;
  return `<div class="placeholder">${esc(label)} arrives in a later step.</div>`;
}

export function render() {
  $('header').innerHTML = renderHeader();
  const screen = $('screen');
  if (state.tab === 'settings') screen.innerHTML = renderSettings(state);
  else if (state.tab === 'board') screen.innerHTML = renderBoard(state);
  else screen.innerHTML = renderPlaceholder(state.tab);
  $('tabbar').innerHTML = TABS.map(([id, label]) => `<button role="tab" data-tab="${id}" aria-selected="${state.tab === id}">${label}</button>`).join('');
}

// ---- files: upload, persist, parse ----
function loadFiles() {
  for (const k in FILE_KEYS) {
    const f = loadJSON(FILE_KEYS[k]);
    state.files[k] = f && f.v === 1 && typeof f.text === 'string' ? f : null;
    parseFile(k);
  }
}

function parseFile(k) {
  const f = state.files[k];
  state.parsed[k] = null;
  delete state.parseErrors[k];
  if (!f) return;
  try {
    state.parsed[k] = k === 'projections' ? parseProjections(f.text) : parseRankings(f.text);
  } catch (e) {
    state.parseErrors[k] = e.message;
    log(`parse ${k} failed: ${e.message}`);
  }
}

async function onFileChosen(input) {
  const file = input.files && input.files[0];
  if (!file) return;
  const k = input.dataset.file;
  if (!FILE_KEYS[k]) return;
  const text = await file.text();
  state.files[k] = { v: 1, text, name: file.name, uploadedAt: Date.now(), size: text.length };
  saveJSON(FILE_KEYS[k], state.files[k]);
  parseFile(k);
  const p = state.parsed[k];
  log(`uploaded ${k}: ${file.name}, ${text.length} chars, ${p ? `${p.count} rows` : 'parse failed'}`);
  if (p && k !== 'projections') {
    const expect = k === 'rankingsSuperflex' ? 'superflex' : '1qb';
    if (p.format !== 'unknown' && p.format !== expect) toast(`This file looks like a ${p.format} rankings export but was uploaded as ${expect}.`, 'error', 8000);
  }
  rebuild();
  render();
}

export function activeRankingsKey() {
  const forced = state.leagueId && state.settings.rankingsFileByLeague[state.leagueId];
  if (forced && FILE_KEYS[forced]) return forced;
  const rp = state.bundle && state.bundle.league.roster_positions;
  return rp && rp.includes('SUPER_FLEX') ? 'rankingsSuperflex' : 'rankings1qb';
}

function leaguePositions() {
  const rp = (state.bundle && state.bundle.league.roster_positions) || [];
  const pos = ['QB', 'RB', 'WR', 'TE'];
  if (rp.includes('K')) pos.push('K');
  if (rp.includes('DEF')) pos.push('DEF');
  return pos;
}

// Effective scoring/value settings = defaults overlaid with the user's edits.
function effectiveSettings() {
  const s = state.settings;
  const dv = DEFAULT_VALUE_SETTINGS;
  const sv = s.value || {};
  const flexShare = {};
  for (const ft in dv.flexShare) flexShare[ft] = { ...dv.flexShare[ft], ...((sv.flexShare && sv.flexShare[ft]) || {}) };
  state.valueSettings = {
    ...dv,
    ...sv,
    flexShare,
    cushion: { ...dv.cushion, ...(sv.cushion || {}) },
    baselineOverrides: { ...(sv.baselineOverrides || {}) },
    analystOverrides: { ...(sv.analystOverrides || {}) },
  };
  state.cvs = { ...DEFAULT_CVS, ...(s.cvs || {}) };
  state.fumbles = { ...DEFAULT_FUMBLES, ...(s.fumbles || {}) };
}

function setSetting(path, raw) {
  const parts = path.split('.');
  let obj = state.settings;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!obj[parts[i]] || typeof obj[parts[i]] !== 'object') obj[parts[i]] = {};
    obj = obj[parts[i]];
  }
  const leaf = parts[parts.length - 1];
  if (raw === '' || raw == null) delete obj[leaf];
  else {
    const n = Number(raw);
    if (!Number.isFinite(n)) return;
    obj[leaf] = n;
  }
  saveSettings();
  rebuild();
  render();
}

// Re-match CSV rows to Sleeper players and rebuild the scored/valued pool.
// Cheap (tens of ms); runs after any file, league, setting, override, or
// player-map change.
export function rebuild() {
  effectiveSettings();
  state.activeRankingsKey = activeRankingsKey();
  state.model = null;
  if (!state.players || !state.playerIndex) {
    state.match = null;
    return;
  }
  const positions = new Set(leaguePositions());
  const overrides = state.settings.nameOverrides || {};
  const proj = state.parsed.projections;
  const rank = state.parsed[state.activeRankingsKey];
  const projRows = proj ? proj.rows.filter((r) => positions.has(r.pos)) : [];
  const rankRows = rank ? rank.rows.filter((r) => positions.has(r.pos)) : [];
  state.match = {
    proj: matchRows(projRows, state.playerIndex, { overrides }),
    rank: matchRows(rankRows, state.playerIndex, { overrides }),
    projTotal: projRows.length,
    rankTotal: rankRows.length,
    rankKey: state.activeRankingsKey,
    hasRank: !!rank,
  };
  log(`match: proj ${state.match.proj.matched.length}/${projRows.length} (${state.match.proj.unmatched.length} unmatched), rank ${state.match.rank.matched.length}/${rankRows.length} (${state.match.rank.unmatched.length} unmatched)`);
  if (state.bundle && proj) {
    const t0 = performance.now();
    try {
      state.model = buildPool({
        matchProj: state.match.proj,
        matchRank: state.match.rank,
        rankAnalysts: rank ? rank.analysts : [],
        league: state.bundle.league,
        draft: state.bundle.draft,
        settings: { value: state.valueSettings, cvs: state.cvs, fumbles: state.fumbles },
      });
      log(`model: ${state.model.pool.length} players, baselines ${JSON.stringify(state.model.baselines)}, ${Math.round(performance.now() - t0)} ms`);
    } catch (e) {
      log(`model failed: ${e.message}`);
      toast(`Value model failed: ${e.message}`);
    }
  }
}

// ---- actions ----
const actions = {
  async recheck() {
    state.conn = null;
    render();
    await connect();
  },
  async 'select-league'(btn) {
    const id = btn.dataset.id;
    state.leagueId = id;
    state.settings.leagueId = id;
    saveSettings();
    state.bundle = api.cachedLeagueBundle(id);
    rebuild();
    render();
    await refreshLeague();
  },
  async 'refresh-league'() {
    await refreshLeague();
  },
  async 'refresh-players'() {
    await loadPlayers(true);
  },
  'clear-log'() {
    state.log = [];
    saveJSON(KEYS.log, []);
    render();
  },
  async 'clear-all'() {
    if (!confirm('Clear all app data on this device?')) return;
    await clearAll();
    location.reload();
  },
  fix(btn) {
    state.fixing = { key: btn.dataset.key, pos: btn.dataset.pos, name: btn.dataset.name, query: btn.dataset.name, results: [] };
    state.fixing.results = searchPlayers(state.players, state.fixing.query, { pos: state.fixing.pos });
    render();
    const inp = document.querySelector('[data-search="fix"]');
    if (inp) inp.focus();
  },
  'cancel-fix'() {
    state.fixing = null;
    render();
  },
  ignore(btn) {
    setOverride(`${btn.dataset.key}|${btn.dataset.pos}`, 'ignore');
  },
  pick(btn) {
    if (!state.fixing) return;
    setOverride(`${state.fixing.key}|${state.fixing.pos}`, btn.dataset.id);
    state.fixing = null;
    render();
  },
  'reset-overrides'() {
    state.settings.nameOverrides = {};
    saveSettings();
    rebuild();
    render();
  },
  'board-filter'(btn) {
    state.boardFilter = btn.dataset.pos;
    state.boardLimit = 12;
    render();
  },
  'board-more'() {
    state.boardLimit = (state.boardLimit || 12) + 24;
    render();
  },
  'reset-value'() {
    state.settings.value = {};
    state.settings.cvs = {};
    state.settings.fumbles = {};
    saveSettings();
    rebuild();
    render();
  },
  'remove-file'(btn) {
    const k = btn.dataset.file;
    if (!FILE_KEYS[k] || !confirm('Remove this file from the app?')) return;
    state.files[k] = null;
    saveJSON(FILE_KEYS[k], null);
    parseFile(k);
    rebuild();
    render();
  },
};

function setOverride(key, value) {
  state.settings.nameOverrides = { ...(state.settings.nameOverrides || {}), [key]: value };
  saveSettings();
  rebuild();
  render();
}

const forms = {
  async username(form) {
    const v = new FormData(form).get('username').toString().trim();
    if (!v) return;
    state.settings.username = v;
    saveSettings();
    await actions.recheck();
  },
};

function bindEvents() {
  const app = $('app');
  app.addEventListener('click', (e) => {
    const tabBtn = e.target.closest('[data-tab]');
    if (tabBtn) {
      state.tab = tabBtn.dataset.tab;
      render();
      return;
    }
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const fn = actions[btn.dataset.action];
    if (!fn) return;
    e.preventDefault();
    Promise.resolve(fn(btn)).catch((err) => {
      log(`action ${btn.dataset.action} failed: ${err && err.message ? err.message : err}`);
      toast(String(err && err.message ? err.message : err));
    });
  });
  app.addEventListener('submit', (e) => {
    const form = e.target.closest('[data-form]');
    if (!form) return;
    e.preventDefault();
    const fn = forms[form.dataset.form];
    if (fn) Promise.resolve(fn(form)).catch((err) => toast(String(err)));
  });
  app.addEventListener('change', (e) => {
    const input = e.target;
    if (input.matches('input[type="file"][data-file]')) {
      onFileChosen(input).catch((err) => {
        log(`upload failed: ${err.message}`);
        toast(`Upload failed: ${err.message}`);
      });
    } else if (input.matches('[data-setting]')) {
      setSetting(input.dataset.setting, input.value);
    } else if (input.matches('select[data-select="rankingsFile"]')) {
      const v = input.value;
      if (v === 'auto') delete state.settings.rankingsFileByLeague[state.leagueId];
      else state.settings.rankingsFileByLeague[state.leagueId] = v;
      saveSettings();
      rebuild();
      render();
    }
  });
  app.addEventListener('input', (e) => {
    const input = e.target;
    if (input.matches('[data-search="fix"]') && state.fixing) {
      state.fixing.query = input.value;
      state.fixing.results = searchPlayers(state.players, input.value, { pos: state.fixing.pos });
      const box = $('fix-results');
      if (box) box.innerHTML = renderFixResults(state);
    }
  });
  window.addEventListener('error', (e) => {
    log(`error: ${e.message}`);
    toast(`Error: ${e.message}`);
  });
  window.addEventListener('unhandledrejection', (e) => {
    const m = e.reason && e.reason.message ? e.reason.message : String(e.reason);
    log(`unhandled: ${m}`);
    toast(`Error: ${m}`);
  });
}

// ---- data flows ----
async function connect() {
  state.conn = await api.corsCheck(state.settings.username);
  log(`CORS check from ${state.conn.origin}: ${state.conn.ok ? `ok ${state.conn.ms} ms` : `FAILED ${state.conn.error}`}`);
  render();
  if (!state.conn.ok) return;
  state.user = { user_id: state.conn.user_id, username: state.conn.username };
  state.settings.userId = state.conn.user_id;
  saveSettings();
  try {
    const { season, leagues } = await api.getUserLeaguesSmart(state.user.user_id);
    state.season = season;
    state.leagues = leagues;
    log(`leagues ${season}: ${leagues.map((l) => l.name).join(' | ')}`);
  } catch (e) {
    log(`leagues fetch failed: ${e.message}`);
  }
  render();
  if (state.leagueId) await refreshLeague();
}

async function refreshLeague() {
  if (!state.leagueId) return;
  try {
    state.bundle = await api.fetchLeagueBundle(state.leagueId);
    const d = state.bundle.draft;
    log(`league ${state.bundle.league.name}: draft ${d ? `${d.status} ${d.type} ${d.settings.rounds}r ${d.settings.pick_timer}s` : 'none'}`);
  } catch (e) {
    log(`league refresh failed: ${e.message}`);
    toast(`League refresh failed: ${e.message}`);
  }
  rebuild();
  render();
}

async function loadPlayers(force = false) {
  state.busy.players = force ? 'Refreshing player map' : 'Loading player map';
  render();
  try {
    const rec = await api.getPlayers({
      force,
      onProgress: (m) => {
        state.busy.players = m;
        render();
      },
    });
    state.players = rec.players;
    state.playerIndex = buildPlayerIndex(rec.players);
    state.playersMeta = { count: rec.count, fetchedAt: rec.fetchedAt, fromCache: rec.fromCache, stale: rec.stale };
    log(`players: ${rec.count} (${rec.fromCache ? 'cache' : 'network'}${rec.stale ? ', stale' : ''})`);
  } catch (e) {
    log(`players load failed: ${e.message}`);
    toast(`Player map failed: ${e.message}`);
  }
  state.busy.players = null;
  rebuild();
  render();
}

async function init() {
  migrate();
  state.settings = { ...DEFAULT_SETTINGS, ...(loadJSON(KEYS.settings, {}) || {}) };
  if (!state.settings.nameOverrides) state.settings.nameOverrides = {};
  if (!state.settings.rankingsFileByLeague) state.settings.rankingsFileByLeague = {};
  state.log = loadJSON(KEYS.log, []) || [];
  state.leagueId = state.settings.leagueId;
  state.tab = state.leagueId ? 'board' : 'settings';
  if (state.leagueId) state.bundle = api.cachedLeagueBundle(state.leagueId);
  if (state.settings.userId) state.user = { user_id: state.settings.userId, username: state.settings.username };
  loadFiles();
  bindEvents();
  render();
  log(`app start ${location.href}`);
  await Promise.all([connect(), loadPlayers(false)]);
}

init().catch((e) => {
  log(`init failed: ${e.message}`);
  toast(`Init failed: ${e.message}`);
});
