// test/run.mjs - node test runner (no dependencies). Run: node test/run.mjs [section...]
// Sections: match, fixture, draft, replay, sim. Default: all.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseProjections, parseRankings, buildPlayerIndex, matchRows } from '../src/csv.js';
import { trimPlayers } from '../src/api.js';

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

const sections = { match: sectionMatch };
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
