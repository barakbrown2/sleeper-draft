// test/run.mjs - node test runner (no dependencies). Run: node test/run.mjs [section...]
// Sections: match, fixture, draft, replay, sim. Default: all.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseCSV, parseProjections, parseRankings, buildPlayerIndex, matchRows } from '../src/csv.js';
import { trimPlayers } from '../src/api.js';
import { scoreRow, unmodeledKeys } from '../src/scoring.js';
import { buildPool } from '../src/model.js';

const LEAGUE1 = '1388245460631719936';
const DRAFT1 = '1388245460648497152';

async function getJSON(url, cacheName) {
  const cache = path.join(os.tmpdir(), `sleeper-draft-${cacheName}.json`);
  try {
    const st = fs.statSync(cache);
    if (Date.now() - st.mtimeMs < 6 * 3600 * 1000) return JSON.parse(fs.readFileSync(cache, 'utf8'));
  } catch {
    /* no cache */
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  const j = await res.json();
  fs.writeFileSync(cache, JSON.stringify(j));
  return j;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const docs = path.join(root, 'docs');

function findDoc(re) {
  const f = fs.readdirSync(docs).find((x) => re.test(x));
  if (!f) throw new Error(`docs file matching ${re} not found`);
  return fs.readFileSync(path.join(docs, f), 'utf8');
}

export async function loadPlayers() {
  const cache = path.join(os.tmpdir(), 'sleeper-draft-players.json');
  try {
    const st = fs.statSync(cache);
    if (Date.now() - st.mtimeMs < 24 * 3600 * 1000) return JSON.parse(fs.readFileSync(cache, 'utf8'));
  } catch {
    /* no cache */
  }
  const res = await fetch('https://api.sleeper.app/v1/players/nfl');
  if (!res.ok) throw new Error(`players fetch ${res.status}`);
  const trimmed = trimPlayers(await res.json());
  fs.writeFileSync(cache, JSON.stringify(trimmed));
  return trimmed;
}

let failures = 0;
function check(cond, msg) {
  if (cond) console.log(`  ok   ${msg}`);
  else {
    failures++;
    console.log(`  FAIL ${msg}`);
  }
}

async function sectionMatch() {
  console.log('\n== match: CSV names vs Sleeper player map ==');
  const players = await loadPlayers();
  const index = buildPlayerIndex(players);
  const proj = parseProjections(findDoc(/Projections/i));
  const rank = parseRankings(findDoc(/rankings-export/i));
  console.log(`  projections: ${proj.count} rows ${JSON.stringify(proj.counts)} warnings=${JSON.stringify(proj.warnings)}`);
  console.log(`  rankings: ${rank.count} rows, analysts=${rank.analysts.join('/')}, duplicates merged=${rank.duplicates.length} (${rank.duplicates.join(', ')}), format=${rank.format}`);
  for (const [label, rows] of [
    ['projections', proj.rows],
    ['rankings', rank.rows],
  ]) {
    const skill = rows.filter((r) => ['QB', 'RB', 'WR', 'TE'].includes(r.pos));
    const kd = rows.filter((r) => ['K', 'DEF'].includes(r.pos));
    const a = matchRows(skill, index);
    const b = matchRows(kd, index);
    console.log(`  ${label}: QB/RB/WR/TE matched ${a.matched.length}/${skill.length}, unmatched ${a.unmatched.length}, ambiguous ${a.ambiguous.length}; K/DEF matched ${b.matched.length}/${kd.length}`);
    for (const m of a.unmatched) console.log(`     UNMATCHED ${m.row.name} ${m.row.pos} ${m.row.teamRaw}`);
    for (const m of a.ambiguous) console.log(`     ambiguous ${m.row.name} ${m.row.pos} ${m.row.teamRaw} -> ${m.player.full_name} ${m.player.team} (${m.method}; ${m.candidates.map((c) => `${c.full_name}/${c.team}/${c.status}`).join(', ')})`);
    for (const m of b.unmatched) console.log(`     UNMATCHED K/DEF ${m.row.name} ${m.row.pos} ${m.row.teamRaw}`);
    const methods = {};
    for (const m of a.matched) methods[m.method] = (methods[m.method] || 0) + 1;
    console.log(`     methods ${JSON.stringify(methods)}`);
    check(a.unmatched.length === 0, `${label}: no unmatched QB/RB/WR/TE`);
    // Check that different CSV rows never collapse onto the same Sleeper player.
    const seen = new Map();
    for (const m of a.matched) {
      const id = m.player.player_id;
      if (seen.has(id)) console.log(`     COLLISION ${seen.get(id)} and ${m.row.name} -> ${m.player.full_name}`);
      seen.set(id, m.row.name);
    }
    check(seen.size === a.matched.length, `${label}: no two rows map to one player`);
  }
  // Spot checks against known Sleeper ids.
  const idx = new Map(matchRows(proj.rows, index).matched.map((m) => [m.row.name, m.player]));
  check(idx.get('Josh Allen') && idx.get('Josh Allen').player_id === '4984', 'Josh Allen -> 4984');
  check(idx.get('Lamar Jackson') && idx.get('Lamar Jackson').player_id === '4881', 'Lamar Jackson -> 4881');
  check(idx.get('Kenneth Walker III') && idx.get('Kenneth Walker III').team === 'KC', 'Kenneth Walker III (suffix) -> KC');
  check(idx.get('Hollywood Brown') && /marquise/i.test(idx.get('Hollywood Brown').full_name), 'Hollywood Brown alias -> Marquise Brown');
  check(idx.get('Houston Texans') && idx.get('Houston Texans').player_id === 'HOU', 'Houston Texans DST -> HOU');
  const rk = new Map(matchRows(rank.rows, index).matched.map((m) => [m.row.name, m.player]));
  check(rk.get('Texans') && rk.get('Texans').player_id === 'HOU', 'rankings "Texans " HST -> HOU');
  check(rk.get('Rams') && rk.get('Rams').player_id === 'LAR', 'rankings "Rams " LA -> LAR');
  check(rk.get('Ravens') && rk.get('Ravens').player_id === 'BAL', 'rankings "Ravens " BLT -> BAL');
}

async function sectionFixture() {
  console.log('\n== fixture: scoring engine vs docs/rescored-league1-fixture.csv ==');
  const league = await getJSON(`https://api.sleeper.app/v1/league/${LEAGUE1}`, 'league1');
  const draft = await getJSON(`https://api.sleeper.app/v1/draft/${DRAFT1}`, 'draft1');
  const scoring = league.scoring_settings;
  const fx = parseCSV(findDoc(/rescored-league1-fixture/i));
  const header = fx[0].map((c) => c.trim());
  const col = (n) => header.indexOf(n);
  const proj = parseProjections(findDoc(/Projections/i));
  const projByKey = new Map(proj.rows.map((r) => [`${r.name}|${r.pos}`, r]));
  let maxErr = 0;
  let maxErrName = '';
  let maxPart = 0;
  let n = 0;
  const bad = [];
  for (let i = 1; i < fx.length; i++) {
    const r = fx[i];
    const name = r[col('Player')];
    const pos = r[col('Position')];
    const row = projByKey.get(`${name}|${pos}`);
    if (!row) {
      bad.push(`no projection row for ${name} ${pos}`);
      continue;
    }
    const s = scoreRow(row, scoring);
    const want = Number(r[col('LgPts')]);
    const err = Math.abs(s.total - want);
    n++;
    if (err > maxErr) {
      maxErr = err;
      maxErrName = `${name} got ${s.total.toFixed(2)} want ${want}`;
    }
    for (const [mine, theirs] of [
      [s.base, 'base'],
      [s.bonusPass, 'b_pass'],
      [s.bonusRush, 'b_rush'],
      [s.fumPts, 'fum'],
    ]) {
      const e = Math.abs(mine - Number(r[col(theirs)]));
      if (e > maxPart) maxPart = e;
      if (e > 0.05) bad.push(`${name} ${theirs}: got ${mine.toFixed(3)} want ${r[col(theirs)]}`);
    }
  }
  console.log(`  compared ${n} players; max |LgPts error| = ${maxErr.toFixed(3)} (${maxErrName}); max component error = ${maxPart.toFixed(3)}`);
  for (const b of bad.slice(0, 10)) console.log(`     ${b}`);
  check(n >= 380, `fixture rows compared (${n})`);
  check(maxErr <= 0.2, 'all LgPts within 0.2 of fixture');
  check(bad.length === 0, 'all base/b_pass/b_rush/fum components within 0.05');

  // Plan section 5 spot table.
  const spot = { 'Josh Allen': 349.1, 'Jahmyr Gibbs': 348.4, 'Bijan Robinson': 347.4, "Ja'Marr Chase": 324.9, 'Joe Burrow': 306.4, 'Jonathan Taylor': 304.3 };
  for (const name in spot) {
    const row = proj.rows.find((r) => r.name === name);
    const s = scoreRow(row, scoring);
    check(Math.abs(s.total - spot[name]) <= 0.2, `${name} = ${s.total.toFixed(1)} (plan ${spot[name]})`);
  }
  console.log(`  unmodeled keys: ${unmodeledKeys(scoring).map((k) => `${k.key}=${k.value}`).join(', ')}`);

  // Value model: baselines and VORP against the fixture's VORP column.
  console.log('\n== value: baselines, VORP, blend, tiers ==');
  const players = await loadPlayers();
  const index = buildPlayerIndex(players);
  const rank = parseRankings(findDoc(/rankings-export/i));
  const model = buildPool({
    matchProj: matchRows(proj.rows.filter((r) => ['QB', 'RB', 'WR', 'TE'].includes(r.pos)), index),
    matchRank: matchRows(rank.rows.filter((r) => ['QB', 'RB', 'WR', 'TE'].includes(r.pos)), index),
    rankAnalysts: rank.analysts,
    league,
    draft,
  });
  console.log(`  pool ${model.pool.length} players, rank-only ${model.rankOnly.length}, baselines ${JSON.stringify(model.baselines)}, baseline pts ${JSON.stringify(Object.fromEntries(Object.entries(model.baselinePts).map(([k, v]) => [k, +v.toFixed(1)])))}`);
  console.log(`  weights ${JSON.stringify(model.weights)}`);
  check(model.baselines.QB === 18 && model.baselines.RB === 28 && model.baselines.WR === 34 && model.baselines.TE === 11, 'baselines QB18 / RB28 / WR34 / TE11');
  const bp = model.baselinePts;
  check(Math.abs(bp.QB - 259.5) <= 0.2 && Math.abs(bp.RB - 180.1) <= 0.2 && Math.abs(bp.WR - 175.5) <= 0.2 && Math.abs(bp.TE - 152.0) <= 0.2, `baseline pts QB ${bp.QB.toFixed(1)} RB ${bp.RB.toFixed(1)} WR ${bp.WR.toFixed(1)} TE ${bp.TE.toFixed(1)}`);
  let maxV = 0;
  let cmp = 0;
  const byName = new Map(model.pool.map((p) => [`${p.proj.name}|${p.pos}`, p]));
  for (let i = 1; i < fx.length; i++) {
    const r = fx[i];
    const p = byName.get(`${r[col('Player')]}|${r[col('Position')]}`);
    if (!p) continue;
    cmp++;
    const e = Math.abs(p.vorpProj - Number(r[col('VORP')]));
    if (e > maxV) maxV = e;
    if (Number(r[col('PosRank')]) !== p.posRank && e > 0.2) console.log(`     posrank differs ${r[col('Player')]}: fixture ${r[col('PosRank')]} mine ${p.posRank}`);
  }
  check(maxV <= 0.2, `VORP_proj within 0.2 of fixture for ${cmp} players (max err ${maxV.toFixed(3)})`);
  const top = [...model.pool].sort((a, b) => b.value - a.value).slice(0, 15);
  console.log('  top 15 by blended value:');
  for (const p of top) console.log(`     ${String(p.valueRank).padStart(2)} ${p.name.padEnd(22)} ${p.pos} ${p.team || 'FA'}  pts ${p.lgPts.toFixed(1)}  vorp ${p.vorpProj.toFixed(1)}  rank ${p.blendedRank == null ? '-' : p.blendedRank.toFixed(1)}  vorpRank ${p.vorpRank == null ? '-' : p.vorpRank.toFixed(1)}  value ${p.value.toFixed(1)}  tier ${p.tier}`);
  const qbTiers = model.pool.filter((p) => p.pos === 'QB').sort((a, b) => b.value - a.value).slice(0, 20);
  console.log(`  QB tiers (top 20): ${qbTiers.map((p) => `${p.name.split(' ').pop()}:${p.tier}`).join(' ')}`);
  check(top[0].pos === 'RB' && top.slice(0, 2).every((p) => p.pos === 'RB'), 'Gibbs/Bijan lead the blended board (plan section 9)');
}

const sections = { match: sectionMatch, fixture: sectionFixture };
const want = process.argv.slice(2);
const run = want.length ? want : Object.keys(sections);
for (const s of run) {
  if (!sections[s]) {
    console.log(`unknown section ${s}`);
    continue;
  }
  await sections[s]();
}
console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL OK');
process.exit(failures ? 1 : 0);
