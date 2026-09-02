// src/model.js
// Assemble the scored, valued player pool for a league from the matched CSV
// rows. Pure; runs in the main thread in a few ms.
import { scoreRows, unmodeledKeys } from './scoring.js';
import { computeValues, blendedRank } from './value.js';

// matchProj / matchRank: results of csv.matchRows(); each .matched item is { row, player }.
export function buildPool({ matchProj, matchRank, rankAnalysts, league, draft, settings }) {
  const scoring = (league && league.scoring_settings) || {};
  const rp = (league && league.roster_positions) || [];
  const teams = Number((draft && draft.settings && draft.settings.teams) || (league && league.total_rosters) || 0);
  const hasK = rp.includes('K');
  const hasDef = rp.includes('DEF');

  // Projections by player (if two rows map to one player keep the higher FPTS).
  const rowsById = new Map();
  for (const m of (matchProj && matchProj.matched) || []) {
    const id = m.player.player_id;
    const prev = rowsById.get(id);
    if (!prev || (Number(m.row.FPTS) || 0) > (Number(prev.row.FPTS) || 0)) rowsById.set(id, m);
  }
  const ranksById = new Map();
  for (const m of (matchRank && matchRank.matched) || []) ranksById.set(m.player.player_id, m.row);

  const scored = scoreRows(
    [...rowsById.values()].map((m) => ({ ...m.row, _player: m.player })),
    scoring,
    { hasK, hasDef, cvs: settings && settings.cvs, fumbles: settings && settings.fumbles },
  );

  const pool = scored.map((s) => {
    const player = s.row._player;
    const rk = ranksById.get(player.player_id) || null;
    return {
      player_id: player.player_id,
      name: player.full_name,
      pos: s.pos,
      team: player.team,
      injury: player.injury_status || null,
      status: player.status,
      player,
      proj: s.row,
      score: s.score,
      lgPts: s.lgPts,
      ranks: rk ? rk.ranks : null,
      consensus: rk ? rk.consensus : null,
    };
  });

  // Rankings-only players (ranked but no projection row) are tracked so the
  // sim knows other teams may take them; they get no projection value.
  const projIds = new Set(pool.map((p) => p.player_id));
  const rankOnly = [];
  for (const m of (matchRank && matchRank.matched) || []) {
    if (projIds.has(m.player.player_id)) continue;
    if (!['QB', 'RB', 'WR', 'TE'].includes(m.row.pos) && !((m.row.pos === 'K' && hasK) || (m.row.pos === 'DEF' && hasDef))) continue;
    rankOnly.push({ player_id: m.player.player_id, name: m.player.full_name, pos: m.row.pos, team: m.player.team, player: m.player, ranks: m.row.ranks, consensus: m.row.consensus, rankOnly: true });
  }

  const valueInfo = computeValues(pool, { rosterPositions: rp, teams, analysts: rankAnalysts || [], settings: settings && settings.value });
  for (const p of rankOnly) {
    p.lgPts = 0;
    p.value = -999;
    p.vorpProj = null;
    const br = blendedRank(p.ranks, valueInfo.weights);
    p.blendedRank = br != null ? br : p.consensus;
    p.adp = p.blendedRank != null ? p.blendedRank : 999;
  }

  const byId = new Map();
  for (const p of pool) byId.set(p.player_id, p);
  for (const p of rankOnly) byId.set(p.player_id, p);

  return {
    pool,
    rankOnly,
    byId,
    baselines: valueInfo.baselines,
    baselinePts: valueInfo.baselinePts,
    weights: valueInfo.weights,
    unmodeled: unmodeledKeys(scoring),
    teams,
    hasK,
    hasDef,
  };
}
