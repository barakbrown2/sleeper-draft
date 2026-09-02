// src/plan.js
// Pre-draft plan and tier watch derived from survival probabilities
// (plan section 7, "pre-draft plan mode"; section 9, tier alarms). Pure.

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
