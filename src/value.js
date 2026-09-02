// src/value.js
// Value model (plan section 6): replacement baselines from roster + team
// count, VORP, rankings blend on the projection scale, tiers. Pure functions.

export const DEFAULT_VALUE_SETTINGS = {
  // Share of each flex slot type absorbed by each position.
  flexShare: {
    FLEX: { RB: 0.5, WR: 0.4, TE: 0.1 },
    SUPER_FLEX: { QB: 0.85, RB: 0.08, WR: 0.07 },
    REC_FLEX: { WR: 0.7, TE: 0.3 },
    WRRB_FLEX: { RB: 0.55, WR: 0.45 },
    WRRB_TE_FLEX: { RB: 0.5, WR: 0.4, TE: 0.1 },
  },
  // Added to the computed baseline rank. Baseline rank = floor(T * (dedicated + flex share)) + cushion.
  cushion: { QB: 0, RB: 3, WR: 0, TE: 0, K: 0, DEF: 0 },
  // Manual overrides of the baseline rank per position, e.g. { QB: 18 }.
  baselineOverrides: {},
  // Analyst weights. Ratcliffe gets `ratcliffe` when present; others split the remainder.
  ratcliffeWeight3: 0.6, // when the file has 3 analysts
  ratcliffeWeight4: 0.55, // when it has 4 or more
  analystOverrides: {}, // { analystName: weight }
  wProj: 0.65,
  tierMinGap: 6,
  tierGapMult: 1.5,
};

export const VALUE_POSITIONS = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF'];

// Counts of starters by position and flex slots from roster_positions.
export function rosterSlots(rosterPositions) {
  const counts = {};
  for (const p of rosterPositions || []) counts[p] = (counts[p] || 0) + 1;
  return counts;
}

export function baselineRanks(rosterPositions, teams, settings = DEFAULT_VALUE_SETTINGS) {
  const s = { ...DEFAULT_VALUE_SETTINGS, ...(settings || {}) };
  const slots = rosterSlots(rosterPositions);
  const out = {};
  for (const pos of VALUE_POSITIONS) {
    if (!slots[pos] && !hasFlexFor(pos, slots, s.flexShare)) continue;
    let starters = slots[pos] || 0;
    for (const flexType in s.flexShare) {
      const n = slots[flexType] || 0;
      const share = s.flexShare[flexType][pos] || 0;
      starters += n * share;
    }
    const cushion = (s.cushion && s.cushion[pos]) || 0;
    const computed = Math.floor(teams * starters + 1e-9) + cushion;
    const override = s.baselineOverrides && s.baselineOverrides[pos];
    out[pos] = override ? Number(override) : Math.max(1, computed);
  }
  return out;
}

function hasFlexFor(pos, slots, flexShare) {
  for (const flexType in flexShare) if ((slots[flexType] || 0) > 0 && (flexShare[flexType][pos] || 0) > 0) return true;
  return false;
}

// Default analyst weights for a rankings file.
export function analystWeights(analysts, settings = DEFAULT_VALUE_SETTINGS) {
  const s = { ...DEFAULT_VALUE_SETTINGS, ...(settings || {}) };
  const names = analysts || [];
  const w = {};
  const overrides = s.analystOverrides || {};
  const rat = names.find((a) => /ratcliffe/i.test(a));
  if (rat && names.length > 1) {
    const rw = names.length <= 3 ? s.ratcliffeWeight3 : s.ratcliffeWeight4;
    w[rat] = rw;
    const others = names.filter((a) => a !== rat);
    for (const a of others) w[a] = (1 - rw) / others.length;
  } else {
    for (const a of names) w[a] = 1 / Math.max(1, names.length);
  }
  for (const a of names) if (overrides[a] != null) w[a] = Number(overrides[a]);
  return w;
}

// Weighted mean of non-blank analyst ranks with weights renormalized per player.
export function blendedRank(ranks, weights) {
  if (!ranks) return null;
  let num = 0;
  let den = 0;
  for (const a in weights) {
    const r = ranks[a];
    if (r == null || !Number.isFinite(r)) continue;
    num += weights[a] * r;
    den += weights[a];
  }
  return den > 0 ? num / den : null;
}

// Map an overall rank (1-based, fractional ok) to LgPts on the projection
// scale: the LgPts of the player at that overall projection rank.
export function makeRankToPts(lgPtsDesc) {
  const n = lgPtsDesc.length;
  return (rank) => {
    if (!n || rank == null) return null;
    const r = Math.max(1, rank);
    if (r >= n) return lgPtsDesc[n - 1];
    const lo = Math.floor(r);
    const hi = Math.ceil(r);
    if (lo === hi) return lgPtsDesc[lo - 1];
    const f = r - lo;
    return lgPtsDesc[lo - 1] * (1 - f) + lgPtsDesc[hi - 1] * f;
  };
}

// Tier boundaries within a position from a list sorted by value desc.
// New tier when gap to next > max(minGap, mult * median gap over top 40).
export function assignTiers(sortedValues, { tierMinGap = 6, tierGapMult = 1.5 } = {}) {
  const n = sortedValues.length;
  const tiers = new Array(n).fill(1);
  if (n < 2) return tiers;
  const gaps = [];
  for (let i = 0; i < Math.min(n - 1, 39); i++) gaps.push(sortedValues[i] - sortedValues[i + 1]);
  const sorted = [...gaps].sort((a, b) => a - b);
  const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
  const threshold = Math.max(tierMinGap, tierGapMult * median);
  let tier = 1;
  tiers[0] = 1;
  for (let i = 1; i < n; i++) {
    if (sortedValues[i - 1] - sortedValues[i] > threshold) tier++;
    tiers[i] = tier;
  }
  return tiers;
}

// Compute VORP, blended rank, value and tiers for a scored pool.
// pool: [{ player_id, pos, lgPts, ranks|null }] (mutated in place with results)
export function computeValues(pool, { rosterPositions, teams, analysts, settings }) {
  const s = { ...DEFAULT_VALUE_SETTINGS, ...(settings || {}) };
  const baselines = baselineRanks(rosterPositions, teams, s);
  const weights = analystWeights(analysts, s);

  // Position ranks by LgPts.
  const byPos = {};
  for (const p of pool) (byPos[p.pos] = byPos[p.pos] || []).push(p);
  const baselinePts = {};
  for (const pos in byPos) {
    const list = byPos[pos].sort((a, b) => b.lgPts - a.lgPts);
    list.forEach((p, i) => (p.posRank = i + 1));
    const rank = baselines[pos] || list.length;
    const idx = Math.min(list.length, Math.max(1, rank)) - 1;
    baselinePts[pos] = list.length ? list[idx].lgPts : 0;
  }

  // Overall projection order for rank -> pts mapping.
  const overall = [...pool].sort((a, b) => b.lgPts - a.lgPts);
  overall.forEach((p, i) => (p.projRank = i + 1));
  const rankToPts = makeRankToPts(overall.map((p) => p.lgPts));

  for (const p of pool) {
    p.baselinePts = baselinePts[p.pos] || 0;
    p.vorpProj = p.lgPts - p.baselinePts;
    p.blendedRank = blendedRank(p.ranks, weights);
    if (p.blendedRank == null && p.ranks && p.consensus != null) p.blendedRank = p.consensus;
    if (p.blendedRank != null) {
      p.rankPts = rankToPts(p.blendedRank);
      p.vorpRank = p.rankPts - p.baselinePts;
      p.value = s.wProj * p.vorpProj + (1 - s.wProj) * p.vorpRank;
      p.adp = p.blendedRank;
    } else {
      p.rankPts = null;
      p.vorpRank = null;
      p.value = p.vorpProj;
      p.adp = 400 + p.projRank; // unranked: behind every ranked player in the sim
    }
  }

  // Tiers within position by value.
  for (const pos in byPos) {
    const list = byPos[pos].sort((a, b) => b.value - a.value);
    const tiers = assignTiers(
      list.map((p) => p.value),
      s,
    );
    list.forEach((p, i) => {
      p.tier = tiers[i];
      p.valueRankPos = i + 1;
    });
  }
  const byValue = [...pool].sort((a, b) => b.value - a.value);
  byValue.forEach((p, i) => (p.valueRank = i + 1));

  return { baselines, baselinePts, weights };
}
