// src/app.js - app shell: state, init, tab routing, event delegation, live loop wiring.
import * as api from './api.js';
import { KEYS, loadJSON, saveJSON, migrate, clearAll } from './storage.js';
import { parseProjections, parseRankings, buildPlayerIndex, matchRows, searchPlayers } from './csv.js';
import { buildPool } from './model.js';
import { DEFAULT_VALUE_SETTINGS } from './value.js';
import { DEFAULT_CVS, DEFAULT_FUMBLES } from './scoring.js';
import { turnInfo, rostersFromPicks, userSlot, pickInRound } from './draft.js';
import { LiveSource, ReplaySource, DraftLoop } from './live.js';
import { esc, $, fmtDateTime, fmtAgo } from './ui/dom.js';
import { renderSettings, renderFixResults } from './ui/settings.js';
import { renderBoard } from './ui/board.js';
import { renderDraftLog, teamName } from './ui/draftlog.js';
import { renderTeam } from './ui/team.js';
import { renderDetail } from './ui/detail.js';
import { checkForUpdate, VERSION } from './update.js';
import { SimClient, buildSimInput, DEFAULT_SIM_SETTINGS } from './sim.js';
import { computePlan, tierWatch, tierAlarms, optimizeWithAlternatives } from './plan.js';
import { userNeedMultipliers } from './lineup.js';
import { myPlayers } from './ui/team.js';
import { esc as escHtml } from './ui/dom.js';

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
  sim: {},
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
  draftView: 'picks',
  draftFilter: 'ALL',
  draftSort: 'pick',
  live: null,
  userDrafts: [],
  siteFiles: null,
  storageInfo: null,
  detailId: null,
  sim: null,
  simClient: null,
  simSettings: null,
  simSeq: 0,
  plan: null,
  planClient: null,
  planBusy: false,
  planSeq: 0,
  need: null,
  banner: '',
  waitOn: null,
  version: VERSION,
  busy: {},
  log: [],
};

function currentUserId() {
  return state.user ? state.user.user_id : state.settings.userId;
}

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

// ---- header: league + pick status + countdown ----
function countdownText() {
  const live = state.live;
  if (!live || !live.draft || live.turn.complete) return '';
  const cfg = live.turn.cfg;
  const last = live.draft.last_picked;
  if (!cfg.pickTimer || !last || live.draft.status !== 'drafting') return '';
  const remain = Math.round((cfg.pickTimer * 1000 - (Date.now() - last)) / 1000);
  if (remain <= 0) return '0:00';
  return `${Math.floor(remain / 60)}:${String(remain % 60).padStart(2, '0')}`;
}

function renderHeader() {
  if (!state.bundle) return '<h1>Sleeper Draft Assistant</h1><div class="muted">Pick a league in Settings</div>';
  const name = state.bundle.league.name;
  const live = state.live;
  if (!live) {
    const d = state.bundle.draft;
    return `<h1>${esc(name)}</h1><div class="muted">${d ? esc(d.status) : 'no draft'}</div>`;
  }
  const t = live.turn;
  const cfg = t.cfg;
  const attachedName = live.attached ? (live.draft.metadata && live.draft.metadata.name ? live.draft.metadata.name : live.draft.draft_id) : '';
  const badge =
    live.mode === 'replay'
      ? `<span class="badge">REPLAY ${esc(live.replay.season)} ${live.source.n}/${live.source.total}</span>`
      : live.attached
        ? `<span class="badge">ATTACHED ${esc(attachedName)}</span>`
        : live.errors > 1
          ? '<span class="badge bad">offline?</span>'
          : '';
  let main;
  let sub;
  if (t.complete) {
    main = 'Draft complete';
    sub = `${live.picks.length} picks`;
  } else if (live.draft.status === 'pre_draft' && !live.picks.length) {
    main = `Pre-draft, starts ${fmtDateTime(cfg.startTime)}`;
    sub = `You are slot ${t.slot != null ? t.slot : '?'} of ${cfg.teams}, ${cfg.rounds} rounds, ${cfg.pickTimer} s clock`;
  } else {
    const onClock = teamName(state, live.rosters[t.currentSlot] ? live.rosters[t.currentSlot].user_id : null, t.currentSlot);
    const pos = `R${t.currentRound}.${pickInRound(t.current, cfg.teams)}`;
    if (t.isUserTurn) {
      main = `<span class="yourpick">YOUR PICK</span> #${t.current} (${pos})`;
      const pair = t.userPicks.filter((p) => p > t.current && p <= t.current + 1);
      sub = pair.length ? `You also pick #${pair[0]} next. Then ${t.futureTurns[0] ? t.futureTurns[0].join('/') : '-'}.` : `Then ${t.futureTurns[0] ? t.futureTurns[0].join('/') : '-'}.`;
    } else {
      main = `Pick #${t.current} (${pos}): ${esc(onClock)}`;
      sub = t.nextUserPick ? `Your next: #${t.nextUserPick}, ${t.picksUntilUser} pick${t.picksUntilUser === 1 ? '' : 's'} away` : 'No picks left for you';
    }
  }
  const cd = countdownText();
  return `<div class="hdr"><div class="grow"><div class="hdr-main">${main}</div><div class="hdr-sub muted">${sub} ${badge}</div></div>${cd ? `<div class="countdown" id="countdown">${cd}</div>` : '<div id="countdown"></div>'}</div>
    <div class="hdr-league muted">${esc(name)} <span id="updated">${live.lastFetch ? `updated ${fmtAgo(live.lastFetch)}` : ''}</span></div>`;
}

function renderHeaderOnly() {
  $('header').innerHTML = renderHeader();
}

setInterval(() => {
  const cd = $('countdown');
  if (cd) cd.textContent = countdownText();
  const up = $('updated');
  if (up && state.live && state.live.lastFetch) up.textContent = `updated ${fmtAgo(state.live.lastFetch)}`;
}, 1000);

// ---- rendering ----
export function render() {
  const y = window.scrollY;
  renderHeaderOnly();
  const screen = $('screen');
  if (state.tab === 'settings') screen.innerHTML = renderSettings(state);
  else if (state.tab === 'board') screen.innerHTML = renderBoard(state);
  else if (state.tab === 'draft') screen.innerHTML = renderDraftLog(state);
  else if (state.tab === 'team') screen.innerHTML = renderTeam(state);
  $('tabbar').innerHTML = TABS.map(([id, label]) => `<button role="tab" data-tab="${id}" aria-selected="${state.tab === id}">${label}</button>`).join('');
  window.scrollTo(0, y);
  renderSheet();
}

function renderSheet() {
  const el = $('sheet');
  const p = state.detailId && state.model ? state.model.byId.get(state.detailId) : null;
  el.innerHTML = p && !p.rankOnly ? renderDetail(state, p) : '';
  document.body.classList.toggle('noscroll', !!(p && !p.rankOnly));
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

// Copies of the CSVs committed in docs/ (listed by tools/stamp.mjs). They let
// a fresh browser container load the files without the Files app.
async function loadSiteManifest() {
  try {
    const r = await fetch('./docs/files.json', { cache: 'no-store' });
    if (!r.ok) return;
    const j = await r.json();
    state.siteFiles = Array.isArray(j.files) ? j.files : [];
  } catch (e) {
    log(`site file list failed: ${e.message}`);
  }
  render();
}

async function loadSiteFile(kind) {
  const entry = (state.siteFiles || []).find((f) => f.kind === kind);
  if (!entry || !FILE_KEYS[kind]) return;
  state.busy.site = `Loading ${entry.name} from the site`;
  render();
  try {
    const r = await fetch(`./${encodeURI(entry.file)}`, { cache: 'no-store' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const text = await r.text();
    const dataAt = Date.parse(entry.mtime) || Date.now();
    state.files[kind] = { v: 1, text, name: entry.name, uploadedAt: dataAt, loadedAt: Date.now(), size: text.length, source: 'site' };
    saveJSON(FILE_KEYS[kind], state.files[kind]);
    parseFile(kind);
    const p = state.parsed[kind];
    log(`loaded ${kind} from site: ${entry.name}, ${p ? `${p.count} rows` : 'parse failed'}`);
    rebuild();
  } catch (e) {
    log(`site load failed: ${e.message}`);
    toast(`Could not load ${entry.name}: ${e.message}`);
  }
  state.busy.site = null;
  render();
}

// Where the page is running. iOS keeps separate storage for Safari, the Home
// Screen app, and other apps' built-in browsers, which looks like "lost files".
function detectStorage() {
  const nav = navigator;
  const ua = nav.userAgent || '';
  const standalone = nav.standalone === true || (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
  const ios = /iPhone|iPad|iPod/.test(ua);
  const inApp = ios && !standalone && !/Safari\//.test(ua);
  return { standalone, ios, inApp, persisted: null };
}

async function requestPersistentStorage() {
  try {
    if (nav_has_storage()) {
      const already = await navigator.storage.persisted();
      const granted = already || (await navigator.storage.persist());
      state.storageInfo.persisted = granted;
      log(`storage persistent: ${granted}${already ? ' (already)' : ''}`);
    }
  } catch (e) {
    log(`storage persist check failed: ${e.message}`);
  }
}

function nav_has_storage() {
  return typeof navigator !== 'undefined' && navigator.storage && typeof navigator.storage.persist === 'function' && typeof navigator.storage.persisted === 'function';
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
  const ss = s.sim || {};
  state.simSettings = { ...DEFAULT_SIM_SETTINGS, ...ss, positionLimits: { ...(ss.positionLimits || {}) } };
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
  applyNeed();
  if (state.live) {
    runSim('model');
    if (state.live.draft && state.live.draft.status !== 'complete') runPlan('model');
  }
}

// Roster-need multipliers for the user's own roster (plan section 9.1):
// adjValue = blended value x need. Tiers stay on the raw value.
function applyNeed() {
  const model = state.model;
  if (!model) {
    state.need = null;
    return;
  }
  const rp = (state.bundle && state.bundle.league.roster_positions) || [];
  const mine = state.live ? myPlayers(state) : [];
  const { mult, open, needPositions } = userNeedMultipliers(rp, mine);
  state.need = { mult, open, needPositions, hasRoster: !!state.live && mine.length > 0 };
  for (const p of model.pool) {
    p.needMult = state.need.hasRoster && mult[p.pos] != null ? mult[p.pos] : 1;
    p.adjValue = p.value * p.needMult;
  }
}

const adjValueOf = (p) => (p.adjValue != null ? p.adjValue : p.value);

// ---- pre-draft plan (plan section 7): expected best at each of the next turns ----
async function runPlan(reason) {
  const live = state.live;
  if (!live || !state.model || !state.planClient) {
    state.plan = null;
    return;
  }
  const input = buildSimInput({
    model: state.model,
    picks: live.picks,
    draft: live.draft,
    userId: currentUserId(),
    taken: state.taken,
    settings: state.simSettings,
    seed: (Date.now() ^ 0x5bd1e995) & 0x7fffffff,
    horizonsCount: 9,
  });
  if (!input) {
    state.plan = null;
    return;
  }
  state.planBusy = true;
  if (state.tab === 'board') render();
  const model = state.model;
  const seq = ++state.planSeq;
  const result = await state.planClient.run(input, { N: 300, adapt: false });
  // Drop the result if a newer plan was requested or the league/draft/model
  // changed meanwhile (a model rebuild always queues a fresh plan).
  if (seq !== state.planSeq || state.live !== live || state.model !== model) {
    if (seq === state.planSeq) state.planBusy = false;
    return;
  }
  state.planBusy = false;
  if (!result) return;
  const taken = state.taken;
  const plan = computePlan({ model, taken, survival: result.survival, horizons: result.horizons, valueFn: adjValueOf });
  const tiers = {};
  for (const pos of ['QB', 'RB', 'WR', 'TE']) tiers[pos] = tierWatch({ model, taken, survival: result.survival, horizons: result.horizons, pos, maxTiers: 2 });
  // Draft-path optimizer: the current turn (if it is ours) plus the simulated future turns.
  let path = null;
  try {
    const t = live.turn;
    const nextStart = t.futureTurns[0] ? t.futureTurns[0][0] : Infinity;
    const nowPicks = t.isUserTurn ? t.userPicks.filter((p) => p >= t.current && p < nextStart) : [];
    const turns = (nowPicks.length ? [{ picks: nowPicks, h: null }] : []).concat(input.horizonsInfo.map((picks, h) => ({ picks, h })));
    const t0 = performance.now();
    path = optimizeWithAlternatives({ model, taken, survival: result.survival, turns, rosterPositions: state.bundle.league.roster_positions || [], myPlayers: myPlayers(state) });
    if (path) path.ms = Math.round(performance.now() - t0);
  } catch (e) {
    log(`path optimizer failed: ${e.message}`);
  }
  state.plan = { ...plan, tiers, path, horizonsInfo: input.horizonsInfo, atPick: input.currentPick, N: result.N, ms: result.ms, at: Date.now() };
  log(`plan (${reason}): N=${result.N} ${result.ms} ms, ${input.picks.length} picks, turns ${result.horizons.join('/')}${path ? `; path ${path.path.map((x) => x.pos).join('')} = ${path.total.toFixed(0)} pts (${path.ms} ms)` : ''}`);
  if (state.tab === 'board') render();
}

// ---- survival sim (plan section 7) and the signals derived from it ----
async function runSim(reason) {
  const live = state.live;
  if (!live || !state.model || !state.simClient) {
    state.sim = null;
    return;
  }
  const input = buildSimInput({
    model: state.model,
    picks: live.picks,
    draft: live.draft,
    userId: currentUserId(),
    taken: state.taken,
    settings: state.simSettings,
    seed: (Date.now() ^ (live.picks.length * 7919)) & 0x7fffffff,
  });
  if (!input) {
    state.sim = null;
    deriveSignals();
    return;
  }
  if (state.sim) state.sim.stale = true;
  const seq = ++state.simSeq;
  const model = state.model;
  const result = await state.simClient.run(input);
  if (!result || seq !== state.simSeq || state.live !== live || state.model !== model) return; // superseded or league changed
  state.sim = { survival: result.survival, horizons: result.horizons, horizonsInfo: input.horizonsInfo, N: result.N, ms: result.ms, at: Date.now(), stale: false, players: input.players.length };
  log(`sim (${reason}): N=${result.N} ${result.ms} ms, ${input.picks.length} picks to #${result.horizons[result.horizons.length - 1]}`);
  deriveSignals();
  if (state.tab === 'board' || state.detailId) render();
}

// Banner (QB run + tier cliffs at every position you can still start),
// per-position "you can wait on X", and cost of waiting. Uses need-adjusted value.
function deriveSignals() {
  state.banner = '';
  state.waitOn = null;
  const live = state.live;
  if (!live || !state.model) return;
  const picks = live.picks;
  const last5 = picks.slice(-5);
  const qbs = last5.filter((p) => p.metadata && p.metadata.position === 'QB').length;
  const msgs = [];
  if (last5.length === 5 && qbs >= 3) msgs.push(`QB run: ${qbs} of the last 5 picks were QBs.`);
  const sim = state.sim;
  const taken = state.taken;
  if (sim && sim.survival) {
    const avail = state.model.pool.filter((p) => !taken.has(p.player_id));
    const byPos = {};
    for (const p of avail) (byPos[p.pos] = byPos[p.pos] || []).push(p);
    const expBest = {};
    const waitOn = {};
    for (const pos in byPos) {
      const list = byPos[pos].sort((a, b) => adjValueOf(b) - adjValueOf(a));
      let remainProb = 1;
      let exp = 0;
      let best = null;
      for (const p of list) {
        const s = sim.survival[p.player_id];
        const sp = s ? s[0] : 0;
        exp += adjValueOf(p) * sp * remainProb;
        remainProb *= 1 - sp;
        if (!best && sp >= 0.5) best = { player: p, p: sp };
        if (remainProb < 0.001) break;
      }
      expBest[pos] = exp;
      if (best) waitOn[pos] = best;
    }
    for (const p of avail) p.costOfWaiting = expBest[p.pos] != null ? adjValueOf(p) - expBest[p.pos] : null;
    state.waitOn = waitOn;
    // Tier cliffs: current top tier at each startable position that will not last to the next turn.
    const needPositions = state.need && state.need.hasRoster ? state.need.needPositions : null;
    const alarms = tierAlarms({ model: state.model, taken, survival: sim.survival, nextPick: sim.horizons[0], needPositions });
    for (const a of alarms.slice(0, 3)) {
      const left = a.left === 1 ? `only ${a.last.name} left` : `${a.left} left, last is ${a.last.name}`;
      const drop = a.dropToNext != null ? ` Next tier is ${Math.round(a.dropToNext)} pts lower.` : '';
      msgs.push(`${a.pos} tier ${a.tier} will not last to #${a.nextPick} (${left}, ${Math.round(a.pLast * 100)}%).${drop}`);
    }
  }
  if (msgs.length) state.banner = `<div class="banner">${msgs.map((m) => escHtml(m)).join('<br>')}</div>`;
}

// ---- live loop / replay ----
function stopLive() {
  if (state.live) {
    if (state.live.loop) state.live.loop.stop();
    if (state.live.replay && state.live.replay.timer) clearInterval(state.live.replay.timer);
  }
  state.live = null;
  state.taken = new Set();
  state.sim = null;
  state.plan = null;
  state.planBusy = false;
  state.banner = '';
  state.waitOn = null;
}

function makeLive(mode, source, draft, extra = {}) {
  const userId = currentUserId();
  const loop = new DraftLoop({
    source,
    intervalMs: 3000,
    onPicks: applyPicks,
    onError: (e, reason, fromLoop) => {
      if (!state.live || (fromLoop && state.live.loop !== fromLoop)) return;
      state.live.errors++;
      log(`picks fetch failed (${reason}): ${e.message}`);
      renderHeaderOnly();
    },
    log,
  });
  state.live = {
    mode,
    source,
    loop,
    picks: [],
    draft,
    turn: turnInfo({ picks: [], draft, userId }),
    rosters: rostersFromPicks([], draft),
    lastFetch: null,
    errors: 0,
    isUserTurn: false,
    ...extra,
  };
  loop.start();
}

function startLive() {
  stopLive();
  const d = state.bundle && state.bundle.draft;
  if (!d) return;
  makeLive('live', new LiveSource(d.draft_id), d);
  log(`live loop started for draft ${d.draft_id} (${d.status})`);
}

// Attach the live loop to any draft id (a Sleeper mock draft, for the
// end-to-end test in plan section 13). Values keep using the selected
// league's scoring and roster; turn detection uses the attached draft's order.
async function attachDraft(draftId) {
  const id = String(draftId || '')
    .trim()
    .replace(/\D/g, '');
  if (!id) return;
  state.busy.attach = `Loading draft ${id}`;
  render();
  try {
    const d = await api.getDraft(id);
    if (!d || !d.draft_id) throw new Error('draft not found');
    stopLive();
    makeLive('live', new LiveSource(d.draft_id), d, { attached: true });
    const slot = userSlot(d, currentUserId());
    log(`attached to draft ${d.draft_id} (${d.metadata && d.metadata.name ? d.metadata.name : d.type}, ${d.status}), your slot ${slot == null ? 'unknown' : slot}`);
    if (slot == null) toast('You are not in this draft order yet; turn detection starts once the order is set.', 'info', 6000);
    state.tab = 'board';
  } catch (e) {
    log(`attach failed: ${e.message}`);
    toast(`Could not attach: ${e.message}`);
  }
  state.busy.attach = null;
  render();
}

async function startReplay() {
  const league = state.bundle && state.bundle.league;
  const prev = league && league.previous_league_id;
  if (!prev) {
    toast('This league has no previous season to replay.');
    return;
  }
  state.busy.replay = 'Loading last season draft';
  render();
  try {
    const drafts = await api.getLeagueDrafts(prev);
    const d = (drafts || []).find((x) => x.status === 'complete') || (drafts || [])[0];
    if (!d) throw new Error('no draft found for the previous league');
    const picks = await api.getDraftPicks(d.draft_id);
    stopLive();
    makeLive('replay', new ReplaySource(picks, d), d, { replay: { season: d.season, auto: false, timer: null } });
    log(`replay loaded: ${d.season} draft ${d.draft_id}, ${picks.length} picks, your slot ${userSlot(d, currentUserId())}`);
    state.tab = 'board';
  } catch (e) {
    log(`replay load failed: ${e.message}`);
    toast(`Replay failed: ${e.message}`);
  }
  state.busy.replay = null;
  render();
}

function replayStep(k) {
  const live = state.live;
  if (!live || live.mode !== 'replay') return;
  live.source.step(k);
  live.loop.refresh('replay');
}

function replayAuto(on) {
  const live = state.live;
  if (!live || live.mode !== 'replay') return;
  if (live.replay.timer) clearInterval(live.replay.timer);
  live.replay.timer = null;
  live.replay.auto = on;
  if (on) {
    live.replay.timer = setInterval(() => {
      if (!state.live || state.live.mode !== 'replay' || state.live.source.n >= state.live.source.total) {
        replayAuto(false);
        render();
        return;
      }
      replayStep(1);
    }, 1200);
  }
}

// Called by the loop after every fetch; re-renders when picks changed.
function applyPicks({ picks, fresh, changed, reason, draft, loop }) {
  const live = state.live;
  if (!live || (loop && live.loop !== loop)) return; // stale callback from a replaced loop
  const d = draft || live.draft;
  live.draft = d;
  live.picks = picks;
  live.lastFetch = Date.now();
  live.errors = 0;
  const userId = currentUserId();
  live.turn = turnInfo({ picks, draft: d, userId });
  live.rosters = rostersFromPicks(picks, d);
  state.taken = new Set(picks.map((p) => String(p.player_id)));
  const first = !live.seen;
  live.seen = true;
  if (changed || first) {
    const wasTurn = live.isUserTurn;
    live.isUserTurn = live.turn.isUserTurn;
    if (fresh.length) {
      const last = fresh.slice(-3).map((p) => `#${p.pick_no} ${p.metadata ? `${p.metadata.first_name} ${p.metadata.last_name}` : p.player_id}`);
      log(`${fresh.length} new pick(s) via ${reason}: ${last.join(', ')}`);
    }
    if (live.turn.isUserTurn && !wasTurn && picks.length) toast(`Your pick: #${live.turn.current}`, 'info', 4000);
    applyNeed();
    deriveSignals();
    render();
    runSim(reason);
    if (first && d.status !== 'complete') runPlan('start');
  } else {
    renderHeaderOnly();
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
    stopLive();
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
    stopLive();
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
  'reset-sim'() {
    state.settings.sim = {};
    saveSettings();
    rebuild();
    render();
  },
  'rerun-sim'() {
    runSim('manual');
  },
  'run-plan'() {
    runPlan('manual');
  },
  'toggle-plan'(btn) {
    // <details> toggles itself; remember the state so re-renders keep it.
    const det = btn.closest('details');
    state.planOpen = det ? !det.open : !state.planOpen;
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
  detail(btn) {
    state.detailId = btn.dataset.id;
    renderSheet();
  },
  'close-detail'() {
    state.detailId = null;
    renderSheet();
  },
  async 'check-update'() {
    const updating = await checkForUpdate(log);
    if (!updating) toast(`Up to date (build ${VERSION})`, 'info', 3000);
    render();
  },
  'draft-view'(btn) {
    state.draftView = btn.dataset.view;
    render();
  },
  'draft-filter'(btn) {
    state.draftFilter = btn.dataset.pos;
    render();
  },
  'draft-sort'(btn) {
    state.draftSort = btn.dataset.sort;
    render();
  },
  async 'live-refresh'() {
    if (state.live) await state.live.loop.refresh('manual');
    else startLive();
    render();
  },
  'live-start'() {
    startLive();
    render();
  },
  async 'replay-start'() {
    await startReplay();
  },
  'replay-step'(btn) {
    replayStep(Number(btn.dataset.k || 1));
  },
  'replay-auto'() {
    replayAuto(!(state.live && state.live.replay && state.live.replay.auto));
    render();
  },
  'replay-reset'() {
    if (!state.live || state.live.mode !== 'replay') return;
    replayAuto(false);
    state.live.source.jumpTo(0);
    state.live.loop.refresh('replay');
  },
  'replay-exit'() {
    startLive();
    render();
  },
  async 'load-site-file'(btn) {
    await loadSiteFile(btn.dataset.kind);
  },
  async 'find-drafts'() {
    const uid = currentUserId();
    if (!uid) return;
    state.busy.drafts = 'Loading your drafts';
    render();
    try {
      const list = await api.getUserDrafts(uid, state.season || new Date().getFullYear());
      const leagueDraftId = state.bundle && state.bundle.draft ? state.bundle.draft.draft_id : null;
      state.userDrafts = (list || []).filter((d) => d.draft_id !== leagueDraftId);
      log(`user drafts this season: ${(list || []).length}`);
    } catch (e) {
      toast(`Drafts lookup failed: ${e.message}`);
    }
    state.busy.drafts = null;
    render();
  },
  async 'attach-draft'(btn) {
    await attachDraft(btn.dataset.id);
  },
  'detach-draft'() {
    startLive();
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
  async attach(form) {
    await attachDraft(new FormData(form).get('draftId'));
  },
};

function bindEvents() {
  const app = $('app');
  app.addEventListener('click', (e) => {
    const tabBtn = e.target.closest('[data-tab]');
    if (tabBtn) {
      state.tab = tabBtn.dataset.tab;
      window.scrollTo(0, 0);
      render();
      return;
    }
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const fn = actions[btn.dataset.action];
    if (!fn) return;
    if (btn.tagName !== 'SUMMARY') e.preventDefault();
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
  // (Re)start the live loop unless a replay is running or the same draft is already live.
  const d = state.bundle && state.bundle.draft;
  const sameDraft = state.live && state.live.mode === 'live' && d && state.live.draft && state.live.draft.draft_id === d.draft_id;
  const busyElsewhere = state.live && (state.live.mode === 'replay' || state.live.attached);
  if (d && !sameDraft && !busyElsewhere) startLive();
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
  state.simClient = new SimClient({ log });
  state.planClient = new SimClient({ log });
  state.storageInfo = detectStorage();
  rebuild();
  if (state.bundle && state.bundle.draft) startLive();
  render();
  log(`app start ${location.href} build ${VERSION} (${state.storageInfo.standalone ? 'home screen app' : state.storageInfo.inApp ? 'in-app browser' : 'browser tab'}; files: ${Object.keys(FILE_KEYS).filter((k) => state.files[k]).join(', ') || 'none'})`);
  requestPersistentStorage();
  loadSiteManifest();
  // Pull a newer build if one was deployed (never mid-draft: only when not drafting).
  const drafting = state.bundle && state.bundle.draft && state.bundle.draft.status === 'drafting';
  if (!drafting) checkForUpdate(log);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    const busy = state.live && state.live.draft && state.live.draft.status === 'drafting';
    if (!busy) checkForUpdate(log);
  });
  await Promise.all([connect(), loadPlayers(false)]);
}

init().catch((e) => {
  log(`init failed: ${e.message}`);
  toast(`Init failed: ${e.message}`);
});
