// src/app.js - app shell: state, init, tab routing, event delegation.
import * as api from './api.js';
import { KEYS, loadJSON, saveJSON, migrate, clearAll } from './storage.js';
import { esc, $ } from './ui/dom.js';
import { renderSettings } from './ui/settings.js';

const DEFAULT_SETTINGS = {
  v: 1,
  username: 'barakbrown2',
  userId: null,
  leagueId: null,
};

const TABS = [
  ['board', 'Board'],
  ['team', 'My Team'],
  ['draft', 'Draft'],
  ['settings', 'Settings'],
];

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
  busy: {},
  log: [],
};

// ---- logging (visible in Settings; persisted so phone crashes are debuggable) ----
export function log(msg) {
  const line = `${new Date().toLocaleTimeString()} ${msg}`;
  state.log.push(line);
  if (state.log.length > 200) state.log.splice(0, state.log.length - 200);
  saveJSON(KEYS.log, state.log.slice(-100));
  if (state.tab === 'settings') render();
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
  return `<div class="placeholder">${esc(label)} arrives in a later step.</div>`;
}

export function render() {
  $('header').innerHTML = renderHeader();
  const screen = $('screen');
  if (state.tab === 'settings') screen.innerHTML = renderSettings(state);
  else screen.innerHTML = renderPlaceholder(state.tab);
  $('tabbar').innerHTML = TABS.map(([id, label]) => `<button role="tab" data-tab="${id}" aria-selected="${state.tab === id}">${label}</button>`).join('');
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
};

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
  document.getElementById('app').addEventListener('click', (e) => {
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
  document.getElementById('app').addEventListener('submit', (e) => {
    const form = e.target.closest('[data-form]');
    if (!form) return;
    e.preventDefault();
    const fn = forms[form.dataset.form];
    if (fn) Promise.resolve(fn(form)).catch((err) => toast(String(err)));
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
    state.playersMeta = { count: rec.count, fetchedAt: rec.fetchedAt, fromCache: rec.fromCache, stale: rec.stale };
    log(`players: ${rec.count} (${rec.fromCache ? 'cache' : 'network'}${rec.stale ? ', stale' : ''})`);
  } catch (e) {
    log(`players load failed: ${e.message}`);
    toast(`Player map failed: ${e.message}`);
  }
  state.busy.players = null;
  render();
}

async function init() {
  migrate();
  state.settings = { ...DEFAULT_SETTINGS, ...(loadJSON(KEYS.settings, {}) || {}) };
  state.log = loadJSON(KEYS.log, []) || [];
  state.leagueId = state.settings.leagueId;
  state.tab = state.leagueId ? 'board' : 'settings';
  if (state.leagueId) state.bundle = api.cachedLeagueBundle(state.leagueId);
  if (state.settings.userId) state.user = { user_id: state.settings.userId, username: state.settings.username };
  bindEvents();
  render();
  log(`app start ${location.href}`);
  await Promise.all([connect(), loadPlayers(false)]);
}

init().catch((e) => {
  log(`init failed: ${e.message}`);
  toast(`Init failed: ${e.message}`);
});
