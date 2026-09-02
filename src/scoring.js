// src/scoring.js
// Scoring engine (plan section 5). Pure functions, unit-tested against
// docs/rescored-league1-fixture.csv. Scores QB/RB/WR/TE from projection
// components under the league's live scoring_settings; K/DEF pass the
// source's FPTS through when the league rosters them.

export const GAMES = 17;

export const DEFAULT_CVS = {
  pass_yd: 0.3,
  rush_yd: 0.55,
  rec_yd: 0.6,
  pass_cmp: 0.25,
  rush_att: 0.45,
};

export const DEFAULT_FUMBLES = {
  qbPer500Att: 3.5, // QB fumbles lost = 3.5 * PaAtt / 500
  skillPer250Touches: 1.0, // RB/WR/TE fumbles lost = (RuAtt + Rec) / 250
};

// Complementary error function, fractional error < 1.2e-7 (Numerical Recipes erfcc).
export function erfc(x) {
  const z = Math.abs(x);
  const t = 1 / (1 + 0.5 * z);
  const r =
    t *
    Math.exp(
      -z * z -
        1.26551223 +
        t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))),
    );
  return x >= 0 ? r : 2 - r;
}

// P(Z >= z) for standard normal.
export function normalSf(z) {
  return 0.5 * erfc(z / Math.SQRT2);
}

// Keys the engine models from projection components.
const MODELED = new Set(['pass_yd', 'pass_td', 'pass_int', 'pass_cmp', 'pass_att', 'pass_inc', 'rush_yd', 'rush_td', 'rush_att', 'rec', 'rec_yd', 'rec_td', 'fum_lost', 'bonus_rec_qb', 'bonus_rec_rb', 'bonus_rec_wr', 'bonus_rec_te']);

// Offense-applicable keys are anything with these prefixes; kicker and
// defense/IDP keys are irrelevant to component scoring and never listed.
const OFFENSE_PREFIX = /^(pass_|rush_|rec|fum|bonus_|kr_|pr_|st_)/;

// Parse per-game bonus keys into { stat(s), threshold }.
export function parseBonusKey(key) {
  let m = /^bonus_(pass|rush|rec)_yd_(\d+)$/.exec(key);
  if (m) return { key, stats: [`${m[1]}_yd`], threshold: Number(m[2]) };
  m = /^bonus_rush_rec_yd_(\d+)$/.exec(key);
  if (m) return { key, stats: ['rush_yd', 'rec_yd'], threshold: Number(m[1]) };
  m = /^bonus_pass_cmp_(\d+)$/.exec(key);
  if (m) return { key, stats: ['pass_cmp'], threshold: Number(m[1]) };
  m = /^bonus_rush_att_(\d+)$/.exec(key);
  if (m) return { key, stats: ['rush_att'], threshold: Number(m[1]) };
  return null;
}

// Season totals by modeled stat name.
function statsFromRow(row) {
  return {
    pass_yd: Number(row.PaYds) || 0,
    pass_cmp: Number(row.PaCom) || 0,
    pass_att: Number(row.PaAtt) || 0,
    pass_td: Number(row.PaTD) || 0,
    pass_int: Number(row.PaINT) || 0,
    rush_yd: Number(row.RuYds) || 0,
    rush_att: Number(row.RuAtt) || 0,
    rush_td: Number(row.RuTD) || 0,
    rec: Number(row.Rec) || 0,
    rec_yd: Number(row.ReYds) || 0,
    rec_td: Number(row.ReTD) || 0,
  };
}

// Expected season bonus points: per-game stat ~ Normal(mean = season/17,
// sd = CV * mean); E = 17 * pts * P(X >= threshold). Tiers stack.
export function expectedBonus(spec, stats, cvs, pts) {
  let mean = 0;
  let variance = 0;
  for (const s of spec.stats) {
    const m = (stats[s] || 0) / GAMES;
    const cv = cvs[s] != null ? cvs[s] : 0.5;
    mean += m;
    variance += (cv * m) ** 2;
  }
  if (mean <= 0) return 0;
  const sd = Math.sqrt(variance);
  if (sd <= 0) return mean >= spec.threshold ? GAMES * pts : 0;
  const z = (spec.threshold - mean) / sd;
  return GAMES * pts * normalSf(z);
}

export function estimateFumblesLost(row, fumbles = DEFAULT_FUMBLES) {
  const f = { ...DEFAULT_FUMBLES, ...(fumbles || {}) };
  if (row.pos === 'QB') return (f.qbPer500Att * (Number(row.PaAtt) || 0)) / 500;
  return (f.skillPer250Touches * ((Number(row.RuAtt) || 0) + (Number(row.Rec) || 0))) / 250;
}

// Score one QB/RB/WR/TE projection row. Returns a breakdown matching the fixture columns.
export function scoreRow(row, scoring, opts = {}) {
  const cvs = { ...DEFAULT_CVS, ...(opts.cvs || {}) };
  const v = (k) => Number(scoring && scoring[k]) || 0;
  const st = statsFromRow(row);
  const pos = String(row.pos || '').toUpperCase();
  let base =
    st.pass_yd * v('pass_yd') +
    st.pass_td * v('pass_td') +
    st.pass_int * v('pass_int') +
    st.pass_cmp * v('pass_cmp') +
    st.pass_att * v('pass_att') +
    Math.max(0, st.pass_att - st.pass_cmp) * v('pass_inc') +
    st.rush_yd * v('rush_yd') +
    st.rush_td * v('rush_td') +
    st.rush_att * v('rush_att') +
    st.rec * v('rec') +
    st.rec_yd * v('rec_yd') +
    st.rec_td * v('rec_td');
  base += st.rec * v(`bonus_rec_${pos.toLowerCase()}`);

  const fumLostEst = estimateFumblesLost(row, opts.fumbles);
  const fumPts = fumLostEst * v('fum_lost');

  const bonuses = [];
  let bonusPass = 0;
  let bonusRush = 0;
  let bonusRec = 0;
  let bonusOther = 0;
  for (const key of Object.keys(scoring || {})) {
    const pts = v(key);
    if (!pts) continue;
    const spec = parseBonusKey(key);
    if (!spec) continue;
    const e = expectedBonus(spec, st, cvs, pts);
    if (!e) continue;
    bonuses.push({ key, pts: e });
    if (spec.stats.length === 1 && spec.stats[0].startsWith('pass')) bonusPass += e;
    else if (spec.stats.length === 1 && spec.stats[0].startsWith('rush')) bonusRush += e;
    else if (spec.stats.length === 1 && spec.stats[0].startsWith('rec')) bonusRec += e;
    else bonusOther += e;
  }
  const total = base + bonusPass + bonusRush + bonusRec + bonusOther + fumPts;
  return { base, bonusPass, bonusRush, bonusRec, bonusOther, bonuses, fumLostEst, fumPts, total };
}

// Non-zero offense-applicable scoring keys the engine cannot model from the
// projection components (listed in Settings, plan section 5).
export function unmodeledKeys(scoring) {
  const out = [];
  for (const key of Object.keys(scoring || {})) {
    const val = Number(scoring[key]) || 0;
    if (!val) continue;
    if (!OFFENSE_PREFIX.test(key)) continue;
    if (MODELED.has(key)) continue;
    if (parseBonusKey(key)) continue;
    out.push({ key, value: val });
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

const SKILL = new Set(['QB', 'RB', 'WR', 'TE']);

// Score a whole projections list under a league. K/DEF rows are kept only
// when the roster has those slots, using the source's FPTS.
export function scoreRows(rows, scoring, { hasK = false, hasDef = false, cvs, fumbles } = {}) {
  const out = [];
  for (const row of rows) {
    const pos = row.pos;
    if (SKILL.has(pos)) {
      const s = scoreRow(row, scoring, { cvs, fumbles });
      out.push({ row, pos, lgPts: s.total, score: s });
    } else if ((pos === 'K' && hasK) || (pos === 'DEF' && hasDef)) {
      const pts = Number(row.FPTS) || 0;
      out.push({ row, pos, lgPts: pts, score: { base: pts, bonusPass: 0, bonusRush: 0, bonusRec: 0, bonusOther: 0, bonuses: [], fumLostEst: 0, fumPts: 0, total: pts, passthrough: true } });
    }
  }
  return out;
}
