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

// All rankings exports in docs/, parsed, keyed by detected format.
function rankingsDocs() {
  const out = [];
  for (const f of fs.readdirSync(docs)) {
    if (!/rankings-export/i.test(f)) continue;
    const parsed = parseRankings(fs.readFileSync(path.join(docs, f), 'utf8'));
    out.push({ file: f, parsed });
  }
  return out;
}

function rankingsByFormat(format) {
  const hit = rankingsDocs().find((r) => r.parsed.format === format);
  if (!hit) throw new Error(`no ${format} rankings export in docs/`);
  return hit.parsed;
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
  const rankDocs = rankingsDocs();
  const rank = rankingsByFormat('superflex');
  console.log(`  projections: ${proj.count} rows ${JSON.stringify(proj.counts)} warnings=${JSON.stringify(proj.warnings)}`);
  for (const r of rankDocs) console.log(`  rankings ${r.file}: ${r.parsed.count} rows, analysts=${r.parsed.analysts.join('/')}, duplicates merged=${r.parsed.duplicates.length} (${r.parsed.duplicates.join(', ')}), format=${r.parsed.format}`);
  check(rankDocs.some((r) => r.parsed.format === 'superflex') && rankDocs.some((r) => r.parsed.format === '1qb'), 'docs/ has one superflex and one 1QB rankings export, formats detected');
  const sets = [['projections', proj.rows]];
  for (const r of rankDocs) sets.push([`rankings ${r.parsed.format}`, r.parsed.rows]);
  for (const [label, rows] of sets) {
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
  const rank = rankingsByFormat('superflex');
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

async function sectionReplay() {
  console.log('\n== replay: 2025 draft through the pure draft logic ==');
  const { turnInfo, rostersFromPicks, picksForSlot, slotForPick } = await import('../src/draft.js');
  const { ReplaySource } = await import('../src/live.js');
  const league = await getJSON(`https://api.sleeper.app/v1/league/${LEAGUE1}`, 'league1');
  const draft26 = await getJSON(`https://api.sleeper.app/v1/draft/${DRAFT1}`, 'draft1');
  const drafts = await getJSON(`https://api.sleeper.app/v1/league/${league.previous_league_id}/drafts`, 'drafts2025');
  const d25 = drafts.find((x) => x.status === 'complete') || drafts[0];
  const picks = await getJSON(`https://api.sleeper.app/v1/draft/${d25.draft_id}/picks`, 'picks2025');
  const userId = '574323656180514816';
  const src = new ReplaySource(picks, d25);
  const slot = d25.draft_order[userId];
  const expectTurns = picksForSlot(slot, d25.settings.teams, d25.settings.rounds, { type: d25.type, reversalRound: d25.settings.reversal_round });
  console.log(`  ${d25.season} draft ${d25.draft_id}: ${src.total} picks, user slot ${slot}, expected user picks ${expectTurns.join(',')}`);
  const firedAt = [];
  let wrongSlot = 0;
  for (let n = 0; n <= src.total; n++) {
    src.jumpTo(n);
    const cur = await src.fetchPicks();
    const t = turnInfo({ picks: cur, draft: d25, userId });
    if (t.isUserTurn) firedAt.push(t.current);
    if (n < src.total) {
      const next = picks.find((p) => p.pick_no === n + 1);
      if (next && slotForPick(next.pick_no, d25.settings.teams, { type: d25.type, reversalRound: d25.settings.reversal_round }) !== next.draft_slot) wrongSlot++;
    }
  }
  const uniq = [...new Set(firedAt)];
  check(JSON.stringify(uniq) === JSON.stringify(expectTurns), `turn detection fired at exactly the user's picks (${uniq.join(',')})`);
  check(wrongSlot === 0, `snake math matches draft_slot for all ${src.total} real picks`);
  src.jumpTo(src.total);
  const all = await src.fetchPicks();
  const tEnd = turnInfo({ picks: all, draft: d25, userId });
  check(tEnd.complete, 'draft marked complete after the last pick');
  const rosters = rostersFromPicks(all, d25);
  const sizes = Object.values(rosters).map((r) => r.players.length);
  check(sizes.every((s) => s === d25.settings.rounds), `every team has ${d25.settings.rounds} players (${sizes.join(',')})`);
  // Mid-draft check at pick 37 (user's 4th pick in 2025).
  src.jumpTo(36);
  const t37 = turnInfo({ picks: await src.fetchPicks(), draft: d25, userId });
  check(t37.current === 37 && t37.isUserTurn && t37.futureTurns[0][0] === 44 && t37.futureTurns[1][0] === 57, `at pick 37: user turn, future turns start at 44 and 57 (got ${t37.futureTurns.slice(0, 2).map((x) => x[0]).join('/')})`);
  const t1 = turnInfo({ picks: [], draft: draft26, userId });
  check(t1.slot === 1 && t1.isUserTurn && t1.futureTurns[0].join('/') === '20/21' && t1.futureTurns[1].join('/') === '40/41', `2026 draft at pick 1: slot 1 on the clock, next turns 20/21 and 40/41`);
  // Coverage: how many 2025 picks map into the 2026 pool.
  const players = await loadPlayers();
  const index = buildPlayerIndex(players);
  const proj = parseProjections(findDoc(/Projections/i));
  const rank = rankingsByFormat('superflex');
  const model = buildPool({
    matchProj: matchRows(proj.rows.filter((r) => ['QB', 'RB', 'WR', 'TE'].includes(r.pos)), index),
    matchRank: matchRows(rank.rows.filter((r) => ['QB', 'RB', 'WR', 'TE'].includes(r.pos)), index),
    rankAnalysts: rank.analysts,
    league,
    draft: draft26,
  });
  const inPool = all.filter((p) => model.byId.has(String(p.player_id))).length;
  console.log(`  ${inPool} of ${all.length} 2025 picks are in the 2026 pool (the rest are unprojected/retired players and still count as taken)`);
  const top100 = [...model.pool].sort((a, b) => b.value - a.value).slice(0, 100);
  check(top100.every((p) => p.player_id && players[p.player_id]), 'top 100 board players all carry Sleeper ids');
}

async function sectionSim() {
  console.log('\n== sim: survival Monte Carlo on the 2025 replay ==');
  await import('../src/simcore.js');
  const { buildSimInput } = await import('../src/sim.js');
  const SimCore = globalThis.SimCore;
  const league = await getJSON(`https://api.sleeper.app/v1/league/${LEAGUE1}`, 'league1');
  const draft26 = await getJSON(`https://api.sleeper.app/v1/draft/${DRAFT1}`, 'draft1');
  const drafts = await getJSON(`https://api.sleeper.app/v1/league/${league.previous_league_id}/drafts`, 'drafts2025');
  const d25 = drafts.find((x) => x.status === 'complete') || drafts[0];
  const picks = await getJSON(`https://api.sleeper.app/v1/draft/${d25.draft_id}/picks`, 'picks2025');
  const players = await loadPlayers();
  const index = buildPlayerIndex(players);
  const proj = parseProjections(findDoc(/Projections/i));
  const rank = rankingsByFormat('superflex');
  const model = buildPool({
    matchProj: matchRows(proj.rows.filter((r) => ['QB', 'RB', 'WR', 'TE'].includes(r.pos)), index),
    matchRank: matchRows(rank.rows.filter((r) => ['QB', 'RB', 'WR', 'TE'].includes(r.pos)), index),
    rankAnalysts: rank.analysts,
    league,
    draft: draft26,
  });
  const userId = '574323656180514816';
  const byId = model.byId;
  const name = (id) => (byId.get(id) ? byId.get(id).name : id);

  // 2026 draft, pick 1 on the clock (slot 1): horizons 20 and 40.
  const in1 = buildSimInput({ model, picks: [], draft: draft26, userId, taken: new Set(), settings: {}, seed: 42 });
  check(in1 && in1.horizons.join('/') === '20/40', `2026 pick 1: horizons ${in1 && in1.horizons.join('/')}`);
  const r1 = SimCore.runSim({ ...in1, N: 400 });
  console.log(`  2026 pick 1: N=${r1.N}, ${r1.ms} ms, ${in1.players.length} players, ${in1.picks.length} picks simulated`);
  check(r1.ms < 1500, `sim time ${r1.ms} ms < 1500 ms (desktop; phone budget 1.5 s with adaptive N)`);
  const top = [...model.pool].sort((a, b) => (a.adp || 999) - (b.adp || 999)).slice(0, 25);
  console.log('  survival to #20 / #40 for the top 25 by blended rank:');
  for (const p of top) {
    const s = r1.survival[p.player_id];
    console.log(`     ${p.name.padEnd(22)} ${p.pos} adp ${(p.adp || 0).toFixed(1).padStart(5)}  #20 ${(s[0] * 100).toFixed(0).padStart(3)}%  #40 ${(s[1] * 100).toFixed(0).padStart(3)}%`);
  }
  const all = Object.values(r1.survival).flat();
  check(all.every((x) => x >= 0 && x <= 1), 'all survival probabilities in [0,1]');
  const top5 = top.slice(0, 5).map((p) => r1.survival[p.player_id][0]);
  check(top5.every((x) => x < 0.5), `top 5 by rank rarely reach #20 (${top5.map((x) => (x * 100).toFixed(0)).join('/')}%)`);
  const deep = [...model.pool].filter((p) => p.adp > 120).slice(0, 20).map((p) => r1.survival[p.player_id][0]);
  check(deep.every((x) => x > 0.8), 'players ranked beyond 120 almost always reach #20');
  const monotone = top.every((p) => r1.survival[p.player_id][1] <= r1.survival[p.player_id][0] + 1e-9);
  check(monotone, 'survival to #40 never exceeds survival to #20');

  // 2025 replay at pick 37 (user on the clock, slot 4): horizons 44 and 57.
  const upTo36 = picks.filter((p) => p.pick_no <= 36);
  const taken = new Set(upTo36.map((p) => String(p.player_id)));
  const in37 = buildSimInput({ model, picks: upTo36, draft: d25, userId, taken, settings: {}, seed: 7 });
  check(in37 && in37.horizons.join('/') === '44/57', `2025 pick 37: horizons ${in37 && in37.horizons.join('/')}`);
  const r37 = SimCore.runSim({ ...in37, N: 400 });
  console.log(`  2025 pick 37: N=${r37.N}, ${r37.ms} ms, ${in37.picks.length} picks simulated; team counts slot 4 = ${JSON.stringify(in37.teams[4])}`);
  const avail = model.pool.filter((p) => !taken.has(p.player_id)).sort((a, b) => b.value - a.value).slice(0, 8);
  for (const p of avail) console.log(`     ${p.name.padEnd(22)} ${p.pos} value ${p.value.toFixed(1).padStart(6)}  #44 ${(r37.survival[p.player_id][0] * 100).toFixed(0).padStart(3)}%  #57 ${(r37.survival[p.player_id][1] * 100).toFixed(0).padStart(3)}%`);
  check(!Object.keys(r37.survival).some((id) => taken.has(id)), 'taken players are excluded from the sim');
  // Actual 2025 picks 37..43 should mostly be players the sim considered likely to go (sanity, informational).
  const between = picks.filter((p) => p.pick_no > 37 && p.pick_no < 44);
  console.log(`  picks 38-43 in 2025 were: ${between.map((p) => `${name(String(p.player_id))} (#44 surv ${r37.survival[String(p.player_id)] ? (r37.survival[String(p.player_id)][0] * 100).toFixed(0) + '%' : 'n/a'})`).join(', ')}`);
}

const LEAGUE2 = '1389345938123804672';
const DRAFT2 = '1389345938123804673';

async function sectionLeague2() {
  console.log('\n== league2: Deep Cuts (16-team 1QB, 6-pt pass TD, TE premium, bonuses) ==');
  const league = await getJSON(`https://api.sleeper.app/v1/league/${LEAGUE2}`, 'league2');
  const draft = await getJSON(`https://api.sleeper.app/v1/draft/${DRAFT2}`, 'draft2');
  const scoring = league.scoring_settings;
  const players = await loadPlayers();
  const index = buildPlayerIndex(players);
  const proj = parseProjections(findDoc(/Projections/i));
  const rank = rankingsByFormat('1qb');
  const skill = (rows) => rows.filter((r) => ['QB', 'RB', 'WR', 'TE'].includes(r.pos));
  const model = buildPool({ matchProj: matchRows(skill(proj.rows), index), matchRank: matchRows(skill(rank.rows), index), rankAnalysts: rank.analysts, league, draft });
  console.log(`  roster ${league.roster_positions.join(',')}; teams ${model.teams}; K ${model.hasK} DEF ${model.hasDef}`);
  console.log(`  baselines ${JSON.stringify(model.baselines)}, baseline pts ${JSON.stringify(Object.fromEntries(Object.entries(model.baselinePts).map(([k, v]) => [k, +v.toFixed(1)])))}`);
  console.log(`  weights ${JSON.stringify(model.weights)}`);
  console.log(`  unmodeled keys: ${model.unmodeled.map((k) => `${k.key}=${k.value}`).join(', ') || 'none'}`);
  check(model.baselines.QB === 16 && model.baselines.RB === 51 && model.baselines.WR === 44 && model.baselines.TE === 19, `baselines QB16 / RB51 / WR44 / TE19 (got ${JSON.stringify(model.baselines)})`);
  check(Math.abs(model.weights.Ratcliffe - 0.55) < 1e-9 && Math.abs(model.weights.Herms - 0.15) < 1e-9, 'analyst weights Ratcliffe 0.55, others 0.15');
  check(!model.hasK && !model.hasDef && model.pool.every((p) => ['QB', 'RB', 'WR', 'TE'].includes(p.pos)), 'no K/DEF in the Deep Cuts pool');
  // Scoring spot checks under this league's keys.
  const row = (name) => proj.rows.find((r) => r.name === name);
  const allen = scoreRow(row('Josh Allen'), scoring);
  const allenNoBonus = scoreRow(row('Josh Allen'), { ...scoring, bonus_pass_yd_300: 0, bonus_pass_yd_400: 0 });
  console.log(`  Josh Allen: base ${allen.base.toFixed(1)} (25.5 pass TD x 6 = 153.0 included), pass bonus ${(allen.total - allenNoBonus.total).toFixed(2)}, fumbles ${allen.fumPts.toFixed(2)}, total ${allen.total.toFixed(1)}`);
  check(Math.abs(allen.base - (3743.5 * 0.04 + 25.5 * 6 - 11.5 * 1 + 540.5 * 0.1 + 11.2 * 6)) < 0.01, 'Allen base uses 6-pt pass TD and -1 INT');
  const bowers = scoreRow(row('Brock Bowers'), scoring);
  const bowersNoPrem = scoreRow(row('Brock Bowers'), { ...scoring, bonus_rec_te: 0 });
  check(Math.abs(bowers.total - bowersNoPrem.total - 0.5 * 93.7) < 0.01, `TE premium adds 0.5 x 93.7 receptions = ${(bowers.total - bowersNoPrem.total).toFixed(2)} for Bowers`);
  const taylor = scoreRow(row('Jonathan Taylor'), scoring);
  const att = taylor.bonuses.find((b) => b.key === 'bonus_rush_att_20');
  console.log(`  Jonathan Taylor bonuses: ${taylor.bonuses.map((b) => `${b.key}=${b.pts.toFixed(2)}`).join(', ')}`);
  check(att && att.pts > 3 && att.pts < 12, `rush_att_20 bonus modeled for Taylor (${att ? att.pts.toFixed(2) : 'missing'} pts)`);
  const top = [...model.pool].sort((a, b) => b.value - a.value).slice(0, 12);
  console.log('  top 12 by blended value (Deep Cuts):');
  for (const p of top) console.log(`     ${String(p.valueRank).padStart(2)} ${p.name.padEnd(22)} ${p.pos} pts ${p.lgPts.toFixed(1)} vorp ${p.vorpProj.toFixed(1)} rank ${p.blendedRank == null ? '-' : p.blendedRank.toFixed(1)} value ${p.value.toFixed(1)} tier ${p.tier}`);
  const qbTop = model.pool.filter((p) => p.pos === 'QB').sort((a, b) => b.value - a.value)[0];
  console.log(`  best QB: ${qbTop.name} value ${qbTop.value.toFixed(1)} (overall #${qbTop.valueRank})`);
  check(top.every((p) => p.pos !== 'QB'), '1QB: no QB in the top 12 by value');
}

async function sectionPlan() {
  console.log('\n== plan: tier watch, alarms, roster need ==');
  const { computePlan, tierWatch, tierAlarms } = await import('../src/plan.js');
  const { userNeedMultipliers, computeLineup } = await import('../src/lineup.js');
  await import('../src/simcore.js');
  const { buildSimInput } = await import('../src/sim.js');
  const league = await getJSON(`https://api.sleeper.app/v1/league/${LEAGUE1}`, 'league1');
  const draft26 = await getJSON(`https://api.sleeper.app/v1/draft/${DRAFT1}`, 'draft1');
  const players = await loadPlayers();
  const index = buildPlayerIndex(players);
  const proj = parseProjections(findDoc(/Projections/i));
  const rank = rankingsByFormat('superflex');
  const skill = (rows) => rows.filter((r) => ['QB', 'RB', 'WR', 'TE'].includes(r.pos));
  const model = buildPool({ matchProj: matchRows(skill(proj.rows), index), matchRank: matchRows(skill(rank.rows), index), rankAnalysts: rank.analysts, league, draft: draft26 });
  const userId = '574323656180514816';
  const input = buildSimInput({ model, picks: [], draft: draft26, userId, taken: new Set(), settings: {}, seed: 99, horizonsCount: 7 });
  check(input.horizons.join('/') === '20/40/60/80/100/120/140', `plan horizons from pick 1: ${input.horizons.join('/')}`);
  const r = globalThis.SimCore.runSim({ ...input, N: 600 });
  console.log(`  whole-draft sim: N=${r.N}, ${input.picks.length} picks, ${r.ms} ms`);
  const taken = new Set();
  const plan = computePlan({ model, taken, survival: r.survival, horizons: r.horizons });
  check(plan.byPos.RB.length === 7 && plan.byPos.RB[0].expBest > 90 && plan.byPos.RB[0].expBest < 125, `expected best RB at #20 = ${plan.byPos.RB[0].expBest.toFixed(1)} (Walker/Cook range)`);
  check(plan.byPos.TE[0].expBest > 80, `expected best TE at #20 = ${plan.byPos.TE[0].expBest.toFixed(1)} (tier 1 still there)`);
  const te = tierWatch({ model, taken, survival: r.survival, horizons: r.horizons, pos: 'TE', maxTiers: 2 });
  console.log(`  TE T${te[0].tier} (${te[0].members.map((m) => m.name).join(', ')}): expected left ${te[0].expectedLeft.map((x) => x.toFixed(1)).join('/')}, P(any) ${te[0].pAny.map((x) => Math.round(x * 100)).join('/')}%, drop ${te[0].dropToNext.toFixed(0)}`);
  check(te[0].pAny[1] > 0.6 && te[0].pAny[2] < 0.15 && te[0].dropToNext > 30, 'TE tier 1 likely at #40, gone by #60, with a 30+ pt cliff behind it');
  const qb = tierWatch({ model, taken, survival: r.survival, horizons: r.horizons, pos: 'QB', maxTiers: 3 });
  const band = qb.find((t) => t.members.length >= 10);
  check(band && band.expectedLeft[1] > 2 && band.expectedLeft[3] < 0.3, `QB band tier ${band ? band.tier : '-'}: ${band ? band.expectedLeft.map((x) => x.toFixed(1)).join('/') : '-'} left at #20..#140`);
  const alarms = tierAlarms({ model, taken, survival: r.survival, nextPick: 20, needPositions: null });
  console.log(`  alarms at pick 1 for #20: ${alarms.map((a) => `${a.pos} T${a.tier} (${a.left} left, ${a.last.name} ${Math.round(a.pLast * 100)}%, drop ${a.dropToNext == null ? '-' : a.dropToNext.toFixed(0)})`).join('; ') || 'none'}`);
  check(alarms.some((a) => a.pos === 'RB') && alarms.some((a) => a.pos === 'QB') && !alarms.some((a) => a.pos === 'TE'), 'alarms at pick 1: RB and QB tier 1 gone by #20, TE tier 1 not alarmed');
  // Roster need multipliers.
  const rp = league.roster_positions;
  const mk = (pos, pts) => ({ pos, lgPts: pts, name: pos });
  let nm = userNeedMultipliers(rp, []);
  check(nm.mult.QB === 1 && nm.mult.RB === 1 && nm.mult.TE === 1, 'empty roster: all positions x1.0');
  nm = userNeedMultipliers(rp, [mk('QB', 300)]);
  check(nm.mult.QB === 0.9, `one QB: QB x${nm.mult.QB} (superflex slot still open)`);
  nm = userNeedMultipliers(rp, [mk('QB', 300), mk('QB', 290)]);
  check(nm.mult.QB === 0.55 && nm.mult.RB === 1, `two QBs: QB x${nm.mult.QB}, RB x${nm.mult.RB}`);
  nm = userNeedMultipliers(rp, [mk('RB', 300), mk('RB', 290), mk('WR', 280), mk('WR', 270), mk('WR', 260), mk('TE', 200), mk('RB', 150)]);
  check(nm.mult.RB === 0.9 && nm.mult.TE === 0.9 && nm.mult.QB === 1, `RB/WR/TE starters full, FLEX taken by RB3: RB x${nm.mult.RB}, TE x${nm.mult.TE}, QB x${nm.mult.QB} (SF open)`);
  const { lineup } = computeLineup(rp, [mk('QB', 300), mk('QB', 290)]);
  check(lineup.find((l) => l.slot === 'SUPER_FLEX').player && lineup.find((l) => l.slot === 'SUPER_FLEX').player.pos === 'QB', 'second QB fills the SUPER_FLEX slot');

  // Draft-path optimizer from pick 1.
  const { optimizeWithAlternatives, expectedKthBest, capsFromRoster } = await import('../src/plan.js');
  const caps = capsFromRoster(rp);
  check(caps.QB === 2 && caps.RB === 4 && caps.WR === 5 && caps.TE === 3, `caps QB${caps.QB} RB${caps.RB} WR${caps.WR} TE${caps.TE}`);
  const tes = model.pool.filter((p) => p.pos === 'TE').sort((a, b) => b.lgPts - a.lgPts);
  const k1 = expectedKthBest(tes, r.survival, 1, 1);
  const k2 = expectedKthBest(tes, r.survival, 1, 2);
  console.log(`  TE at #40: 1st best ${k1.pts.toFixed(1)} (likely ${k1.likely.name} ${(k1.p * 100).toFixed(0)}%), 2nd best ${k2.pts.toFixed(1)} (likely ${k2.likely.name})`);
  check(k1.pts > k2.pts && k1.pts > 200 && k2.pts < k1.pts, 'expected 1st best > 2nd best at TE');
  const turnObjs = [{ picks: [1], h: null }].concat(input.horizonsInfo.map((picks, h) => ({ picks, h })));
  const t0 = Date.now();
  const best = optimizeWithAlternatives({ model, taken, survival: r.survival, turns: turnObjs, rosterPositions: rp, myPlayers: [] });
  console.log(`  optimizer ${Date.now() - t0} ms: ${best.path.map((x) => `#${x.pick} ${x.pos}${x.likely ? ' ' + x.likely.split(' ').slice(-1)[0] : ''}`).join(', ')} = ${best.total.toFixed(0)} pts`);
  console.log(`  first pick options: ${best.alternatives.map((a) => `${a.pos} ${a.cost.toFixed(0)}`).join(', ')}`);
  check(best.path.length === 14 && best.path[0].pos === 'RB', `path covers 14 picks and opens with RB (${best.path[0].likely})`);
  const qbs = best.path.filter((x) => x.pos === 'QB').length;
  check(qbs === 2, `path drafts exactly 2 QBs for QB + SF (${qbs})`);
  const filled = best.lineup.filter((l) => l.player).length;
  check(filled === 9, `all 9 starting slots filled by the path (${filled})`);
  const qbAlt = best.alternatives.find((a) => a.pos === 'QB');
  check(qbAlt && qbAlt.cost > 0, `taking a QB first costs ${qbAlt ? qbAlt.cost.toFixed(0) : '-'} projected starter points`);
  // Mid-draft: with two QBs already, the path never adds a third.
  const mid = optimizeWithAlternatives({ model, taken, survival: r.survival, turns: turnObjs.slice(1), rosterPositions: rp, myPlayers: [mk('QB', 300), mk('QB', 290)] });
  check(mid.path.every((x) => x.pos !== 'QB'), 'with QB and SF filled the path adds no QB');
}

const sections = { match: sectionMatch, fixture: sectionFixture, replay: sectionReplay, sim: sectionSim, league2: sectionLeague2, plan: sectionPlan };
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
