// src/csv.js
// CSV parsing for the projections and rankings exports, name normalization,
// the manual alias map, and matching CSV rows to the Sleeper player map.
// Pure functions only (node-testable). See plan section 4.

// ---- Generic RFC-4180-ish parser: BOM, CRLF, quoted fields, "" escapes ----
export function parseCSV(text) {
  let s = String(text || '');
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  const rows = [];
  let row = [];
  let field = '';
  let inQ = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQ) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else inQ = false;
      } else field += c;
      continue;
    }
    if (c === '"') inQ = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  // Drop fully empty rows.
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

function num(v) {
  if (v == null) return 0;
  const t = String(v).trim();
  if (t === '' || t === '-') return 0;
  const n = Number(t.replace(/[,$%]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

function numOrNull(v) {
  if (v == null) return null;
  const t = String(v).trim();
  if (t === '' || t === '-') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

// ---- Team / position normalization ----
export const TEAM_ALIASES = {
  ARZ: 'ARI',
  HST: 'HOU',
  BLT: 'BAL',
  LA: 'LAR',
  JAC: 'JAX',
  WSH: 'WAS',
  OAK: 'LV',
  LVR: 'LV',
  SD: 'LAC',
  STL: 'LAR',
  CLV: 'CLE',
  INA: null,
  FA: null,
  '': null,
};

export function normTeam(t) {
  const u = String(t == null ? '' : t)
    .trim()
    .toUpperCase();
  return u in TEAM_ALIASES ? TEAM_ALIASES[u] : u || null;
}

export function normPos(p) {
  const u = String(p == null ? '' : p)
    .trim()
    .toUpperCase();
  if (u === 'DST' || u === 'D/ST' || u === 'D' || u === 'DEF') return 'DEF';
  if (u === 'PK') return 'K';
  return u;
}

// ---- Name normalization (plan 4c) ----
const SUFFIXES = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'v']);

export function normalizeName(name) {
  let s = String(name == null ? '' : name)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
  s = s.replace(/[^a-z0-9\s]/g, ' ');
  const parts = s.split(/\s+/).filter(Boolean);
  while (parts.length > 1 && SUFFIXES.has(parts[parts.length - 1])) parts.pop();
  return parts.join('');
}

// Sleeper's search_full_name keeps suffixes in some records ("kennethwalkeriii").
function stripSearchSuffix(s) {
  let k = String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  for (const suf of ['iii', 'ii', 'iv', 'jr', 'sr']) {
    if (k.length > suf.length + 3 && k.endsWith(suf)) {
      k = k.slice(0, -suf.length);
      break;
    }
  }
  return k;
}

// CSV name -> Sleeper name, both normalized with normalizeName().
// Keep this small; the app also supports per-user overrides from Settings.
export const NAME_ALIASES = {
  hollywoodbrown: 'marquisebrown',
  chigokonkwo: 'chigoziemokonkwo',
  camward: 'cameronward',
  kennygainwell: 'kennethgainwell',
  bamknight: 'zonovanknight',
  mikewashington: 'michaelwashington',
  joshuapalmer: 'joshpalmer',
  jacorycroskeymerritt: 'jacorycroskeymerritt',
  chrisrodriguez: 'chrisrodriguez',
  demarcusrobinson: 'demarcusrobinson',
  tankbigsby: 'tankbigsby',
  tankdell: 'tankdell',
  cjstroud: 'cjstroud',
  jjmccarthy: 'jjmccarthy',
  ajbrown: 'ajbrown',
  ajbarner: 'ajbarner',
  djmoore: 'djmoore',
  djgiddens: 'djgiddens',
  rjharvey: 'rjharvey',
  kcconcepcion: 'kcconcepcion',
  cjdaniels: 'cjdaniels',
  tjhockenson: 'tjhockenson',
  jkdobbins: 'jkdobbins',
  dkmetcalf: 'dkmetcalf',
};

// ---- Projections CSV (plan 4a) ----
const PROJ_NUMERIC = ['Auction', 'Opp.', 'PaCom', 'PaAtt', 'PaYds', 'PaTD', 'PaINT', 'RuAtt', 'RuYds', 'RuTD', 'Fum.', 'Tar', 'Rec', 'ReYds', 'ReTD', 'FPTS'];

function fieldKey(h) {
  return h.replace(/[^A-Za-z0-9]/g, '');
}

export function parseProjections(text) {
  const rows = parseCSV(text);
  const hi = rows.findIndex((r) => r.some((c) => c.trim() === 'Player') && r.some((c) => c.trim() === 'Position'));
  if (hi < 0) throw new Error('Projections CSV: no header row with Player and Position columns');
  const header = rows[hi].map((c) => c.trim());
  const col = (name) => header.indexOf(name);
  const iName = col('Player');
  const iPos = col('Position');
  const iTeam = col('Team');
  const missing = PROJ_NUMERIC.filter((k) => col(k) < 0);
  const warnings = [];
  if (missing.length) warnings.push(`Missing columns: ${missing.join(', ')}`);
  const out = [];
  for (let i = hi + 1; i < rows.length; i++) {
    const r = rows[i];
    const name = (r[iName] || '').trim();
    if (!name) continue;
    const rec = {
      name,
      key: normalizeName(name),
      pos: normPos(r[iPos]),
      team: normTeam(r[iTeam]),
      teamRaw: (r[iTeam] || '').trim(),
    };
    for (const k of PROJ_NUMERIC) {
      const c = col(k);
      rec[fieldKey(k)] = c >= 0 ? num(r[c]) : 0;
    }
    out.push(rec);
  }
  const counts = {};
  for (const r of out) counts[r.pos] = (counts[r.pos] || 0) + 1;
  return { rows: out, header, warnings, count: out.length, counts };
}

// ---- Rankings CSV (plan 4b) ----
export function parseRankings(text) {
  const rows = parseCSV(text);
  const hi = rows.findIndex((r) => r.some((c) => c.trim() === 'Player'));
  if (hi < 0) throw new Error('Rankings CSV: no header row with a Player column');
  const header = rows[hi].map((c) => c.trim());
  const iName = header.indexOf('Player');
  const iTeam = header.indexOf('Team');
  const iPos = header.indexOf('Position');
  const iCons = header.indexOf('Consensus');
  if (iPos < 0) throw new Error('Rankings CSV: no Position column');
  const end = iCons > iPos ? iCons : header.length;
  const analysts = [];
  for (let c = iPos + 1; c < end; c++) if (header[c]) analysts.push({ name: header[c], col: c });
  const map = new Map();
  const duplicates = [];
  for (let i = hi + 1; i < rows.length; i++) {
    const r = rows[i];
    const name = (r[iName] || '').trim();
    if (!name) continue;
    const pos = normPos(r[iPos]);
    const key = `${normalizeName(name)}|${pos}`;
    const ranks = {};
    for (const a of analysts) ranks[a.name] = numOrNull(r[a.col]);
    const consensus = iCons >= 0 ? numOrNull(r[iCons]) : null;
    const rec = { name, key: normalizeName(name), pos, team: normTeam(iTeam >= 0 ? r[iTeam] : ''), teamRaw: iTeam >= 0 ? (r[iTeam] || '').trim() : '', ranks, consensus };
    const prev = map.get(key);
    if (prev) {
      duplicates.push(name);
      for (const a of analysts) {
        const x = prev.ranks[a.name];
        const y = ranks[a.name];
        prev.ranks[a.name] = x == null ? y : y == null ? x : Math.min(x, y);
      }
      if (prev.consensus == null || (consensus != null && consensus < prev.consensus)) prev.consensus = consensus;
      if (!prev.team && rec.team) prev.team = rec.team;
    } else map.set(key, rec);
  }
  const out = [...map.values()];
  return { rows: out, analysts: analysts.map((a) => a.name), header, duplicates, count: out.length, format: guessRankingsFormat(out, analysts.map((a) => a.name)) };
}

// Superflex exports rank several QBs inside the top 12 overall; 1QB exports do not.
export function guessRankingsFormat(rows, analysts) {
  const top = rows
    .filter((r) => r.consensus != null)
    .sort((a, b) => a.consensus - b.consensus)
    .slice(0, 12);
  const qbs = top.filter((r) => r.pos === 'QB').length;
  const hasHerms = (analysts || []).some((a) => /herms/i.test(a));
  if (qbs >= 4) return 'superflex';
  if (qbs <= 1 || hasHerms) return '1qb';
  return 'unknown';
}

// ---- Sleeper player index + matching ----
export function playerHasPos(p, pos) {
  if (!p) return false;
  if (p.position === pos) return true;
  return Array.isArray(p.fantasy_positions) && p.fantasy_positions.includes(pos);
}

export function buildPlayerIndex(players) {
  const byKey = new Map();
  const byLast = new Map();
  const defByNick = new Map();
  const defByTeam = new Map();
  const add = (m, k, p) => {
    if (!k) return;
    if (!m.has(k)) m.set(k, []);
    const arr = m.get(k);
    if (!arr.includes(p)) arr.push(p);
  };
  for (const id in players) {
    const p = players[id];
    if (!p) continue;
    if (p.position === 'DEF' || playerHasPos(p, 'DEF')) {
      const team = p.team || p.player_id;
      defByTeam.set(team, p);
      defByNick.set(normalizeName(p.last_name), p);
      defByNick.set(normalizeName(p.full_name), p);
      continue;
    }
    add(byKey, normalizeName(p.full_name), p);
    add(byKey, stripSearchSuffix(p.search_full_name), p);
    add(byLast, normalizeName(p.last_name), p);
  }
  return { byKey, byLast, defByNick, defByTeam, players };
}

function candidateScore(p, row) {
  let s = 0;
  if (row.team && p.team === row.team) s += 100;
  if (p.active) s += 10;
  if (p.status === 'Active') s += 5;
  if (p.team) s += 2;
  const sr = p.search_rank != null ? p.search_rank : 9999999;
  s += (9999999 - sr) / 1e7;
  return s;
}

function best(cands, row) {
  if (!cands.length) return null;
  const scored = cands.map((p) => ({ p, s: candidateScore(p, row) })).sort((a, b) => b.s - a.s);
  const top = scored[0];
  const ambiguous = scored.length > 1 && scored[1].s >= top.s - 0.5 && !(row.team && top.p.team === row.team && scored[1].p.team !== row.team);
  return { player: top.p, ambiguous, candidates: scored.map((x) => x.p) };
}

// Resolve one CSV row to a Sleeper player.
// overrides: { "<normalizedName>|<POS>": player_id | "ignore" }
export function matchRow(row, index, { aliases = NAME_ALIASES, overrides = {} } = {}) {
  const pos = row.pos;
  const okey = `${row.key}|${pos}`;
  if (overrides[okey]) {
    if (overrides[okey] === 'ignore') return { row, player: null, method: 'ignored' };
    const p = index.players[overrides[okey]];
    if (p) return { row, player: p, method: 'override' };
  }
  if (pos === 'DEF') {
    const p = (row.team && index.defByTeam.get(row.team)) || index.defByNick.get(row.key);
    return p ? { row, player: p, method: 'def' } : { row, player: null, method: 'unmatched', reason: 'no DEF match' };
  }
  const tryKey = (k, method) => {
    const cands = (index.byKey.get(k) || []).filter((p) => playerHasPos(p, pos));
    const b = best(cands, row);
    return b ? { row, player: b.player, method: b.ambiguous ? `${method}-ambiguous` : method, candidates: b.candidates } : null;
  };
  let m = tryKey(row.key, 'exact');
  if (m) return m;
  if (aliases[row.key]) {
    m = tryKey(aliases[row.key], 'alias');
    if (m) return m;
  }
  // Same position and team, same last name, first initial agrees (Ken vs Kenneth).
  const parts = String(row.name)
    .replace(/[^A-Za-z\s'-]/g, ' ')
    .trim()
    .split(/\s+/);
  if (parts.length >= 2 && row.team) {
    const lastKey = normalizeName(parts.slice(1).join(' '));
    const first = normalizeName(parts[0]);
    const cands = (index.byLast.get(lastKey) || []).filter((p) => playerHasPos(p, pos) && p.team === row.team && normalizeName(p.first_name)[0] === first[0]);
    if (cands.length === 1) return { row, player: cands[0], method: 'fuzzy' };
    if (cands.length > 1) {
      const b = best(cands, row);
      return { row, player: b.player, method: 'fuzzy-ambiguous', candidates: b.candidates };
    }
  }
  // Same position, any team, exact name key but position mismatch (RB listed as WR etc).
  const anyPos = index.byKey.get(row.key) || [];
  if (anyPos.length) {
    const b = best(anyPos, row);
    return { row, player: b.player, method: 'pos-mismatch', candidates: b.candidates };
  }
  return { row, player: null, method: 'unmatched', reason: 'no name match' };
}

export function matchRows(rows, index, opts = {}) {
  const matched = [];
  const unmatched = [];
  const ambiguous = [];
  for (const row of rows) {
    const m = matchRow(row, index, opts);
    if (m.player) {
      matched.push(m);
      if (m.method.includes('ambiguous') || m.method === 'pos-mismatch') ambiguous.push(m);
    } else if (m.method !== 'ignored') unmatched.push(m);
  }
  return { matched, unmatched, ambiguous };
}

// Simple substring search over the player map for the manual-fix UI.
export function searchPlayers(players, query, { pos = null, limit = 12 } = {}) {
  const q = normalizeName(query);
  if (!q) return [];
  const out = [];
  for (const id in players) {
    const p = players[id];
    if (pos && !playerHasPos(p, pos)) continue;
    const k = normalizeName(p.full_name);
    if (k.includes(q)) out.push(p);
  }
  out.sort((a, b) => candidateScore(b, {}) - candidateScore(a, {}));
  return out.slice(0, limit);
}
