// src/plan.js
// Pre-draft plan and tier watch derived from survival probabilities
// (plan section 7, "pre-draft plan mode"; section 9, tier alarms), and a
// draft-path optimizer for the highest projected starting lineup. Pure.
import { SLOT_ELIGIBLE, computeLineup } from './lineup.js';

const rawValue = (p) => p.value;

// Expected best value per position at each horizon, plus the most likely
// available players (survival >= 0.5), assuming independent survival.
// valueFn: which value to rank by (raw blended value, or the roster-need
// adjusted one). Not named "valueOf" on purpose: destructuring that name
// would pick up Object.prototype.valueOf instead of the default.
export function computePlan({ model, taken, survival, horizons, valueFn = rawValue }) {
  const avail = model.pool.filter((p) => !taken.has(p.player_id));
  const byPos = {};
  for (const p of avail) (byPos[p.pos] = byPos[p.pos] || []).push(p);
  const out = {};
  for (const pos in byPos) {
    const list = byPos[pos].sort((a, b) => valueFn(b) - valueFn(a));
    out[pos] = horizons.map((h, i) => {
      let remain = 1;
      let exp = 0;
      const likely = [];
      for (const p of list) {
        const s = survival[p.player_id];
        const sp = s ? s[i] : 0;
        exp += valueFn(p) * sp * remain;
        remain *= 1 - sp;
        if (sp >= 0.5 && likely.length < 3) likely.push({ id: p.player_id, name: p.name, value: valueFn(p), p: sp, tier: p.tier });
        if (remain < 0.001 && likely.length >= 3) break;
      }
      return { pick: h, expBest: exp, likely };
    });
  }
  return { byPos: out, horizons };
}

// For the top tiers of one position: expected members left at each horizon
// and the probability at least one is left (independence approximation).
// Tiers are the pool's value tiers, so they do not move with roster need.
export function tierWatch({ model, taken, survival, horizons, pos, maxTiers = 3 }) {
  const list = model.pool.filter((p) => p.pos === pos && !taken.has(p.player_id)).sort((a, b) => b.value - a.value);
  const tiers = [];
  for (const p of list) {
    let t = tiers.find((x) => x.tier === p.tier);
    if (!t) {
      if (tiers.length >= maxTiers) break;
      t = { tier: p.tier, members: [], expectedLeft: horizons.map(() => 0), pAny: horizons.map(() => 0) };
      tiers.push(t);
    }
    t.members.push(p);
  }
  for (const t of tiers) {
    horizons.forEach((h, i) => {
      let none = 1;
      let exp = 0;
      for (const p of t.members) {
        const s = survival[p.player_id];
        const sp = s ? s[i] : 0;
        exp += sp;
        none *= 1 - sp;
      }
      t.expectedLeft[i] = exp;
      t.pAny[i] = 1 - none;
    });
    const next = list.find((p) => p.tier === t.tier + 1);
    t.dropToNext = next ? t.members[t.members.length - 1].value - next.value : null;
    t.last = t.members[t.members.length - 1];
  }
  return tiers;
}

// Expected projected points of the k-th best available player at a position
// at horizon index h (null = right now, everyone available), assuming
// independent survival: sum_i pts_i * s_i * P(exactly k-1 higher-ranked
// players are available). Also returns the most likely player to be that
// k-th best. `list` is sorted by lgPts descending.
export function expectedKthBest(list, survival, h, k) {
  const probs = new Float64Array(k);
  probs[0] = 1;
  let exp = 0;
  let mass = 0;
  const candidates = [];
  for (const p of list) {
    const s = survival[p.player_id];
    const sp = h == null ? 1 : s ? s[h] : 0;
    const pk = sp * probs[k - 1];
    exp += p.lgPts * pk;
    mass += pk;
    if (pk > 0.001) candidates.push({ player: p, p: pk });
    for (let m = k - 1; m >= 1; m--) probs[m] = probs[m] * (1 - sp) + probs[m - 1] * sp;
    probs[0] *= 1 - sp;
    if (mass > 0.9999) break;
  }
  candidates.sort((a, b) => b.p - a.p);
  const top = candidates[0] || null;
  return { pts: exp, likely: top ? top.player : null, p: top ? top.p : 0, mass, candidates: candidates.slice(0, 6) };
}

// How many players of each position can start: dedicated slots plus every
// flex-type slot that accepts the position.
export function capsFromRoster(rosterPositions) {
  const counts = {};
  for (const s of rosterPositions || []) counts[s] = (counts[s] || 0) + 1;
  const caps = {};
  for (const pos of ['QB', 'RB', 'WR', 'TE', 'K', 'DEF']) {
    let n = counts[pos] || 0;
    for (const slot in SLOT_ELIGIBLE) if (SLOT_ELIGIBLE[slot].length > 1 && SLOT_ELIGIBLE[slot].includes(pos)) n += counts[slot] || 0;
    caps[pos] = n;
  }
  return caps;
}

function lineupPoints(rosterPositions, list) {
  return computeLineup(rosterPositions, list).lineup.reduce((s, l) => s + (l.player ? l.player.lgPts || 0 : 0), 0);
}

// Choose the position to draft at each of the user's upcoming picks so the
// expected projected points of the starting lineup are maximized, given the
// players already on the roster. turns: [{ picks: [pickNo...], h: horizonIndex
// | null (now) }]. Dynamic program over (pick index, drafted counts per
// position), keeping the best lineup per state; each drafted slot is valued
// at the expected k-th best available at that turn. forceFirst pins the
// first pick's position (for "what does taking X first cost").
export function optimizeDraftPath({ model, taken, survival, turns, rosterPositions, myPlayers = [], maxPicks = 14, forceFirst = null }) {
  const seq = [];
  for (const t of turns) for (const pn of t.picks) seq.push({ pick: pn, h: t.h == null ? null : t.h });
  const picks = seq.slice(0, maxPicks);
  if (!picks.length) return null;
  const byPos = {};
  for (const p of model.pool) {
    if (taken.has(p.player_id) || !(p.lgPts > 0)) continue;
    (byPos[p.pos] = byPos[p.pos] || []).push(p);
  }
  for (const pos in byPos) byPos[pos].sort((a, b) => b.lgPts - a.lgPts);
  const positions = Object.keys(byPos).filter((pos) => SLOT_ELIGIBLE[pos]);
  const caps = capsFromRoster(rosterPositions);
  const have = {};
  for (const p of myPlayers) have[p.pos] = (have[p.pos] || 0) + 1;
  const memo = new Map();
  const kth = (pos, h, k) => {
    const key = `${pos}|${h}|${k}`;
    if (!memo.has(key)) memo.set(key, expectedKthBest(byPos[pos], survival, h, k));
    return memo.get(key);
  };
  const base = myPlayers.map((p) => ({ pos: p.pos, lgPts: p.lgPts || 0, name: p.name, fixed: true }));
  const keyOf = (counts) => positions.map((pos) => counts[pos] || 0).join(',');
  let states = new Map([[keyOf({}), { counts: {}, list: base, path: [], value: lineupPoints(rosterPositions, base), sum: 0, used: new Set() }]]);
  picks.forEach((pk, i) => {
    const next = new Map();
    for (const st of states.values()) {
      const options = i === 0 && forceFirst ? [forceFirst] : positions.concat(['BN']);
      for (const pos of options) {
        let list2 = st.list;
        let item;
        let counts2 = st.counts;
        let value = st.value;
        let used2 = st.used;
        if (pos === 'BN') {
          item = { pick: pk.pick, pos: 'BN', pts: 0, likely: null, starter: false };
        } else {
          const drafted = st.counts[pos] || 0;
          if ((have[pos] || 0) + drafted >= caps[pos]) continue;
          const est = kth(pos, pk.h, drafted + 1);
          if (!est.likely) continue;
          // Display name: the most likely k-th best not already named on this path.
          const cand = est.candidates.find((c) => !st.used.has(c.player.player_id)) || est.candidates[0];
          const who = cand ? cand.player : est.likely;
          list2 = st.list.concat([{ pos, lgPts: est.pts, name: who.name }]);
          counts2 = { ...st.counts, [pos]: drafted + 1 };
          value = lineupPoints(rosterPositions, list2);
          used2 = new Set(st.used);
          used2.add(who.player_id);
          item = { pick: pk.pick, pos, pts: est.pts, likely: who.name, likelyId: who.player_id, p: cand ? cand.p : est.p, tier: who.tier, starter: value > st.value + 1e-9 };
        }
        const sum = st.sum + (item.pts || 0);
        const k = keyOf(counts2);
        const prev = next.get(k);
        if (!prev || value > prev.value + 1e-9 || (Math.abs(value - prev.value) <= 1e-9 && sum > prev.sum)) {
          next.set(k, { counts: counts2, list: list2, path: st.path.concat([item]), value, sum, used: used2 });
        }
      }
    }
    states = next;
  });
  let best = null;
  for (const st of states.values()) if (!best || st.value > best.value + 1e-9 || (Math.abs(st.value - best.value) <= 1e-9 && st.sum > best.sum)) best = st;
  if (!best) return null;
  const startersNow = lineupPoints(rosterPositions, base);
  return { total: best.value, gain: best.value - startersNow, path: best.path, lineup: computeLineup(rosterPositions, best.list).lineup, positions };
}

// Best path plus what pinning each position as the first pick costs.
export function optimizeWithAlternatives(args) {
  const best = optimizeDraftPath(args);
  if (!best) return null;
  const alternatives = [];
  for (const pos of best.positions) {
    const r = optimizeDraftPath({ ...args, forceFirst: pos });
    if (r) alternatives.push({ pos, total: r.total, cost: best.total - r.total, likely: r.path[0] ? r.path[0].likely : null });
  }
  alternatives.sort((a, b) => a.cost - b.cost);
  return { ...best, alternatives };
}

// Tier alarms for the banner: positions whose current top tier is likely
// gone before the user's next turn (last member under 40%), restricted to
// positions the user can still start (needPositions, or all when unknown),
// and only when a real value cliff (>= minDrop) sits behind the tier.
export function tierAlarms({ model, taken, survival, nextPick, needPositions = null, minDrop = 4 }) {
  const out = [];
  for (const pos of ['QB', 'RB', 'WR', 'TE']) {
    if (needPositions && !needPositions.has(pos)) continue;
    const tw = tierWatch({ model, taken, survival, horizons: [nextPick], pos, maxTiers: 1 });
    if (!tw.length) continue;
    const t = tw[0];
    const sLast = survival[t.last.player_id];
    const pLast = sLast ? sLast[0] : 0;
    if (pLast >= 0.4) continue;
    if (t.dropToNext != null && t.dropToNext < minDrop) continue;
    out.push({ pos, tier: t.tier, left: t.members.length, last: t.last, pLast, pAny: t.pAny[0], dropToNext: t.dropToNext, nextPick });
  }
  return out.sort((a, b) => (b.dropToNext || 0) - (a.dropToNext || 0));
}
