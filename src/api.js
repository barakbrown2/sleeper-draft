// src/api.js
// Sleeper public API client. READ-ONLY BY DESIGN.
//
// Every request in this module is a plain HTTP GET to https://api.sleeper.app/v1.
// There is no function here, or anywhere else in this app, that can create,
// submit, or queue a draft pick, or send any non-GET request to Sleeper.
// Keep it that way (plan section 1, CLAUDE.md).

import { KEYS, loadJSON, saveJSON, idbGet, idbSet } from './storage.js';

export const BASE = 'https://api.sleeper.app/v1';
const PLAYERS_KEY = 'players_nfl';
const PLAYERS_TTL_MS = 24 * 60 * 60 * 1000;
const FANTASY_POS = new Set(['QB', 'RB', 'WR', 'TE', 'K', 'DEF']);

export class ApiError extends Error {
  constructor(status, path) {
    super(`Sleeper API ${status} for ${path}`);
    this.status = status;
    this.path = path;
  }
}

// The single network primitive. GET only.
export async function get(path, { timeoutMs = 10000 } = {}) {
  if (typeof path !== 'string' || !path.startsWith('/')) {
    throw new Error('api.get: path must start with /');
  }
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
  try {
    const res = await fetch(BASE + path, {
      method: 'GET',
      cache: 'no-store',
      signal: ctrl ? ctrl.signal : undefined,
    });
    if (!res.ok) throw new ApiError(res.status, path);
    return await res.json();
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ---- Endpoints (plan section 2) ----
export const getUser = (username) => get(`/user/${encodeURIComponent(username)}`);
export const getUserLeagues = (userId, season) => get(`/user/${userId}/leagues/nfl/${season}`);
export const getLeague = (leagueId) => get(`/league/${leagueId}`);
export const getLeagueUsers = (leagueId) => get(`/league/${leagueId}/users`);
export const getLeagueRosters = (leagueId) => get(`/league/${leagueId}/rosters`);
export const getLeagueDrafts = (leagueId) => get(`/league/${leagueId}/drafts`);
export const getDraft = (draftId) => get(`/draft/${draftId}`);
export const getDraftPicks = (draftId) => get(`/draft/${draftId}/picks`, { timeoutMs: 8000 });
export const getTradedPicks = (draftId) => get(`/draft/${draftId}/traded_picks`);

// Leagues for the current season, falling back to the previous season early
// in the calendar year.
export async function getUserLeaguesSmart(userId, now = new Date()) {
  const year = now.getFullYear();
  for (const season of [year, year - 1]) {
    const leagues = await getUserLeagues(userId, season);
    if (Array.isArray(leagues) && leagues.length) return { season, leagues };
  }
  return { season: year, leagues: [] };
}

// Day-1 CORS check from whatever origin the page is served from.
export async function corsCheck(username = 'barakbrown2') {
  const origin = (globalThis.location && globalThis.location.origin) || 'node';
  const t0 = Date.now();
  try {
    const u = await get(`/user/${encodeURIComponent(username)}`);
    return { ok: true, ms: Date.now() - t0, origin, user_id: u.user_id, username: u.username, checkedAt: Date.now() };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, origin, error: String(e && e.message ? e.message : e), checkedAt: Date.now() };
  }
}

// ---- League bundle: league + draft + users, cached in localStorage ----
export function cachedLeagueBundle(leagueId) {
  const b = loadJSON(KEYS.league(leagueId));
  return b && b.v === 1 ? b : null;
}

export async function fetchLeagueBundle(leagueId) {
  const league = await getLeague(leagueId);
  const [draft, users] = await Promise.all([
    league.draft_id ? getDraft(league.draft_id) : Promise.resolve(null),
    getLeagueUsers(leagueId),
  ]);
  const bundle = { v: 1, fetchedAt: Date.now(), league, draft, users };
  saveJSON(KEYS.league(leagueId), bundle);
  return bundle;
}

// ---- Player map: ~5 MB, trimmed to fantasy positions, IndexedDB, 24 h TTL ----
export function trimPlayers(raw) {
  const out = {};
  for (const id in raw) {
    const p = raw[id];
    if (!p) continue;
    const fp = Array.isArray(p.fantasy_positions) ? p.fantasy_positions : [];
    const pos = p.position;
    if (!FANTASY_POS.has(pos) && !fp.some((x) => FANTASY_POS.has(x))) continue;
    out[id] = {
      player_id: String(p.player_id != null ? p.player_id : id),
      full_name: p.full_name || `${p.first_name || ''} ${p.last_name || ''}`.trim(),
      first_name: p.first_name || '',
      last_name: p.last_name || '',
      position: pos || null,
      fantasy_positions: fp,
      team: p.team || null,
      status: p.status || null,
      active: !!p.active,
      injury_status: p.injury_status || null,
      search_full_name: p.search_full_name || null,
      search_rank: p.search_rank != null ? p.search_rank : null,
      years_exp: p.years_exp != null ? p.years_exp : null,
      depth_chart_order: p.depth_chart_order != null ? p.depth_chart_order : null,
      number: p.number != null ? p.number : null,
    };
  }
  return out;
}

export async function getCachedPlayers() {
  const cached = await idbGet(PLAYERS_KEY);
  return cached && cached.v === 1 ? cached : null;
}

export async function getPlayers({ force = false, onProgress } = {}) {
  const cached = await getCachedPlayers();
  if (!force && cached && Date.now() - cached.fetchedAt < PLAYERS_TTL_MS) {
    return { ...cached, fromCache: true, stale: false };
  }
  if (onProgress) onProgress('Downloading Sleeper player map (about 5 MB)');
  try {
    const raw = await get('/players/nfl', { timeoutMs: 90000 });
    const players = trimPlayers(raw);
    const rec = { v: 1, fetchedAt: Date.now(), count: Object.keys(players).length, players };
    await idbSet(PLAYERS_KEY, rec);
    return { ...rec, fromCache: false, stale: false };
  } catch (e) {
    if (cached) return { ...cached, fromCache: true, stale: true, error: String(e) };
    throw e;
  }
}
