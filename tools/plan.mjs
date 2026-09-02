// tools/plan.mjs - pre-draft plan from the computer: tiers per position and
// expected best available at each of the user's picks (plan section 7,
// "pre-draft plan mode"). Read-only; uses the same engine as the app.
// Run: node tools/plan.mjs [leagueId] [--picks 140] [--N 1000]
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseProjections, parseRankings, buildPlayerIndex, matchRows } from '../src/csv.js';
import { buildPool } from '../src/model.js';
import { slotForPick, roundOf, picksForSlot, groupTurns } from '../src/draft.js';
import { rosterConfig, rosterPositionsFromDraft } from '../src/sim.js';
import { computePlan, tierWatch, optimizeWithAlternatives } from '../src/plan.js';
import { trimPlayers } from '../src/api.js';
await import('../src/simcore.js');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const docs = path.join(root, 'docs');
const args = process.argv.slice(2);
const leagueId = args.find((a) => /^\d{10,}$/.test(a)) || '1388245460631719936';
const N = Number((args.find((a) => a.startsWith('--N=')) || '--N=1000').slice(4));
const userId = '574323656180514816';

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

async function loadPlayers() {
  const cache = path.join(os.tmpdir(), 'sleeper-draft-players.json');
  try {
    const st = fs.statSync(cache);
    if (Date.now() - st.mtimeMs < 24 * 3600 * 1000) return JSON.parse(fs.readFileSync(cache, 'utf8'));
  } catch {
    /* no cache */
  }
  const res = await fetch('https://api.sleeper.app/v1/players/nfl');
  const trimmed = trimPlayers(await res.json());
  fs.writeFileSync(cache, JSON.stringify(trimmed));
  return trimmed;
}

const league = await getJSON(`https://api.sleeper.app/v1/league/${leagueId}`, `plan-league-${leagueId}`);
const draft = await getJSON(`https://api.sleeper.app/v1/draft/${league.draft_id}`, `plan-draft-${league.draft_id}`);
const players = await loadPlayers();
const index = buildPlayerIndex(players);
const projText = fs.readFileSync(path.join(docs, fs.readdirSync(docs).find((f) => /Projections/i.test(f))), 'utf8');
const proj = parseProjections(projText);
const rankDocs = fs
  .readdirSync(docs)
  .filter((f) => /rankings-export/i.test(f))
  .map((f) => parseRankings(fs.readFileSync(path.join(docs, f), 'utf8')));
const wantFormat = (league.roster_positions || []).includes('SUPER_FLEX') ? 'superflex' : '1qb';
const rank = rankDocs.find((r) => r.format === wantFormat) || rankDocs[0];
const skill = (rows) => rows.filter((r) => ['QB', 'RB', 'WR', 'TE'].includes(r.pos));
const model = buildPool({ matchProj: matchRows(skill(proj.rows), index), matchRank: matchRows(skill(rank.rows), index), rankAnalysts: rank.analysts, league, draft });

const teams = draft.settings.teams;
const rounds = draft.settings.rounds;
const opts = { type: draft.type, reversalRound: draft.settings.reversal_round || 0 };
const slot = draft.draft_order ? draft.draft_order[userId] : null;
if (!slot) throw new Error('user not in draft order');
const turns = groupTurns(picksForSlot(slot, teams, rounds, opts));
const horizons = turns.slice(0, 8).map((t) => t[0]);
console.log(`${league.name}: ${teams} teams, ${rounds} rounds, ${draft.type}; you are slot ${slot}; turns ${turns.map((t) => t.join('/')).join(', ')}`);
console.log(`rankings ${wantFormat} (${rank.analysts.join('/')}), baselines ${JSON.stringify(model.baselines)}\n`);

// ---- tiers per position ----
for (const pos of ['QB', 'RB', 'WR', 'TE']) {
  const list = model.pool.filter((p) => p.pos === pos).sort((a, b) => b.value - a.value);
  const byTier = new Map();
  for (const p of list) (byTier.get(p.tier) || byTier.set(p.tier, []).get(p.tier)).push(p);
  console.log(`== ${pos} tiers (value = blended VORP; pts = league points) ==`);
  let shown = 0;
  for (const [tier, members] of byTier) {
    if (shown++ >= 7) break;
    const next = byTier.get(tier + 1);
    const drop = next ? members[members.length - 1].value - next[0].value : null;
    const names = members.map((p) => `${p.name.split(' ').slice(-1)[0]} ${p.value.toFixed(0)}`).join(', ');
    console.log(`  T${tier} (${members.length}): value ${members[0].value.toFixed(0)}..${members[members.length - 1].value.toFixed(0)}, pts ${members[0].lgPts.toFixed(0)}..${members[members.length - 1].lgPts.toFixed(0)}${drop != null ? `, drop to next tier ${drop.toFixed(0)}` : ''}`);
    console.log(`      ${names}`);
  }
  console.log('');
}

// ---- sim from pick 1 through the last horizon ----
const last = horizons[horizons.length - 1];
const seq = [];
for (let p = 1; p <= last; p++) seq.push({ pickNo: p, slot: slotForPick(p, teams, opts), round: roundOf(p, teams) });
const teamCounts = {};
for (let s = 1; s <= teams; s++) teamCounts[s] = { QB: 0, RB: 0, WR: 0, TE: 0, K: 0, DEF: 0 };
const playersIn = model.pool.map((p) => ({ id: p.player_id, pos: p.pos, adp: p.adp, value: p.value })).concat(model.rankOnly.map((p) => ({ id: p.player_id, pos: p.pos, adp: p.adp, value: -999 })));
const input = { players: playersIn, picks: seq, teams: teamCounts, userSlot: slot, horizons, rc: rosterConfig(rosterPositionsFromDraft(draft), rounds, {}), tau: 6, lateTauMult: 1.5, lateRoundStart: 13, N, seed: 12345 };
const t0 = Date.now();
const r = globalThis.SimCore.runSim(input);
console.log(`sim from pick 1: N=${r.N}, ${seq.length} picks, ${Date.now() - t0} ms; horizons ${horizons.map((h) => '#' + h).join(' ')}\n`);

const plan = computePlan({ model, taken: new Set(), survival: r.survival, horizons });
console.log('== expected best available at each of your turns (value; most likely name at >= 50%) ==');
const head = ['pos'].concat(horizons.map((h) => `#${h}`.padStart(16))).join(' ');
console.log(head);
for (const pos of ['QB', 'RB', 'WR', 'TE']) {
  const cells = plan.byPos[pos].map((c) => `${c.expBest.toFixed(0).padStart(4)} ${(c.likely[0] ? c.likely[0].name.split(' ').slice(-1)[0] : '-').padEnd(11)}`);
  console.log(`${pos.padEnd(3)} ${cells.join(' ')}`);
}
console.log('\n== suggested draft path (maximize projected starting lineup) ==');
// Turn i maps to horizon index i (the sim records availability just before
// that pick, so a slot-1 first pick sees everyone and a slot-4 pick sees the
// pool after three picks).
const turnObjs = turns.slice(0, 8).map((t, i) => ({ picks: t, h: i }));
const best = optimizeWithAlternatives({ model, taken: new Set(), survival: r.survival, turns: turnObjs, rosterPositions: league.roster_positions, myPlayers: [] });
for (const x of best.path) console.log(`  #${String(x.pick).padStart(3)} ${x.pos.padEnd(3)} ${x.likely ? x.likely.padEnd(22) : ''.padEnd(22)} ${x.pts ? x.pts.toFixed(0).padStart(4) + ' pts' : ''}${x.p != null ? `  (${(x.p * 100).toFixed(0)}% that name)` : ''}${x.starter === false ? '  depth' : ''}`);
console.log(`  projected starters: ${best.total.toFixed(0)} pts`);
console.log(`  first pick options: ${best.alternatives.map((a) => `${a.pos} ${a.likely || ''} ${a.cost < 0.5 ? '(best)' : `-${a.cost.toFixed(0)}`}`).join(' | ')}`);
console.log('  lineup: ' + best.lineup.map((l) => `${l.slot.replace('SUPER_FLEX', 'SF')}=${l.player ? `${l.player.name} ${l.player.lgPts.toFixed(0)}` : 'open'}`).join(', '));

console.log('\n== tier watch from pick 1: how many of each top tier are expected to survive to each turn ==');
for (const pos of ['QB', 'RB', 'WR', 'TE']) {
  const tw = tierWatch({ model, taken: new Set(), survival: r.survival, horizons, pos, maxTiers: 4 });
  for (const t of tw) {
    console.log(`${pos} T${t.tier} (${t.members.length} now): ` + horizons.map((h, i) => `#${h}: ${t.expectedLeft[i].toFixed(1)} left, P(any) ${(t.pAny[i] * 100).toFixed(0)}%`).join(' | '));
  }
}
