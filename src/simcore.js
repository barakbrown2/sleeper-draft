// src/simcore.js
// Survival-to-next-pick Monte Carlo (plan section 7). Plain script with no
// imports so the same code runs inside the Web Worker (importScripts) and,
// as a fallback, on the main thread. Exposes globalThis.SimCore.
(function (root) {
  'use strict';

  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const POS_INDEX = { QB: 0, RB: 1, WR: 2, TE: 3, K: 4, DEF: 5 };
  const POS_NAMES = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF'];

  // Need multiplier for a team drafting `pos` given how many it already has.
  // rc = { starters: {QB,RB,WR,TE,K,DEF}, flex, superflex, recFlex, wrrbFlex, rounds, limits }
  function needMult(have, pos, rc, round) {
    const starters = rc.starters[pos] || 0;
    const limit = rc.limits && rc.limits[pos];
    if (limit && have >= limit) return 0;
    if (pos === 'QB') {
      if (rc.superflex > 0) {
        if (have === 0) return 2.0;
        if (have === 1) return 1.3;
        if (have === 2) return 0.35;
        return 0.1;
      }
      if (have === 0) return 1.0;
      if (have === 1) return 0.25;
      return 0.08;
    }
    if (pos === 'TE') {
      const teFlex = (rc.flex || 0) + (rc.recFlex || 0);
      if (have === 0) return 1.0;
      if (have < starters) return 0.9;
      if (have < starters + teFlex) return 0.45;
      return 0.15;
    }
    if (pos === 'RB' || pos === 'WR') {
      const flexEligible = (rc.flex || 0) + (rc.superflex || 0) + (rc.wrrbFlex || 0) + (pos === 'WR' ? rc.recFlex || 0 : 0);
      if (have < starters) return 1.15;
      if (have < starters + flexEligible) return 1.0;
      if (have < starters + flexEligible + 2) return 0.7;
      return 0.45;
    }
    // K / DEF: only near the end of the draft, one each.
    if (have >= 1) return 0.02;
    return round >= (rc.rounds || 15) - 2 ? 1.0 : 0.05;
  }

  // input: {
  //   players: [{ id, pos, adp, value }],
  //   picks: [{ pickNo, slot, round }]  (from the current open pick through the last horizon, inclusive)
  //   teams: { slot: { QB, RB, WR, TE, K, DEF } }  current counts per slot
  //   userSlot, horizons: [pickNo, pickNo?], rc (roster config), tau, lateTauMult, lateRoundStart, N, seed
  // }
  function runSim(input) {
    const t0 = Date.now();
    const players = input.players || [];
    const n = players.length;
    const picks = input.picks || [];
    const horizons = input.horizons || [];
    const H = horizons.length;
    const N = Math.max(1, input.N || 400);
    const tau = input.tau || 6;
    const lateMult = input.lateTauMult || 1.5;
    const lateStart = input.lateRoundStart || 13;
    const rc = input.rc;
    const userSlot = input.userSlot;
    const rand = mulberry32(input.seed || 1);

    const posIdx = new Int8Array(n);
    const value = new Float64Array(n);
    const wBase = new Float64Array(n);
    const wLate = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const p = players[i];
      posIdx[i] = POS_INDEX[p.pos] != null ? POS_INDEX[p.pos] : 6;
      value[i] = p.value != null ? p.value : -999;
      const adp = p.adp != null ? p.adp : 999;
      wBase[i] = Math.exp(-adp / tau);
      wLate[i] = Math.exp(-adp / (tau * lateMult));
    }

    // Team counts as flat arrays: counts[slot * 6 + posIndex]
    const slots = Object.keys(input.teams || {}).map(Number);
    const maxSlot = slots.length ? Math.max.apply(null, slots) : 0;
    const base = new Int16Array((maxSlot + 1) * 7);
    for (const s of slots) {
      const c = input.teams[s] || {};
      for (let k = 0; k < 6; k++) base[s * 7 + k] = c[POS_NAMES[k]] || 0;
    }

    const survive = new Float64Array(H * n);
    const takenBy = new Float64Array(n); // how often each player was taken before horizon 1 (diagnostic)
    const counts = new Int16Array(base.length);
    const taken = new Uint8Array(n);
    const weights = new Float64Array(n);

    for (let s = 0; s < N; s++) {
      taken.fill(0);
      counts.set(base);
      let h = 0;
      for (let k = 0; k < picks.length; k++) {
        const pk = picks[k];
        while (h < H && pk.pickNo === horizons[h]) {
          const off = h * n;
          for (let i = 0; i < n; i++) if (!taken[i]) survive[off + i] += 1;
          h++;
        }
        if (h >= H) break;
        const slot = pk.slot;
        const cOff = slot * 7;
        let chosen = -1;
        if (slot === userSlot) {
          // Greedy: best value times need.
          let best = -Infinity;
          for (let i = 0; i < n; i++) {
            if (taken[i]) continue;
            const pi = posIdx[i];
            if (pi > 5) continue;
            const nm = needMult(counts[cOff + pi], POS_NAMES[pi], rc, pk.round);
            if (nm <= 0) continue;
            const v = value[i] * (value[i] >= 0 ? nm : 1 / nm);
            if (v > best) {
              best = v;
              chosen = i;
            }
          }
        } else {
          const late = pk.round >= lateStart;
          const w = late ? wLate : wBase;
          let total = 0;
          for (let i = 0; i < n; i++) {
            if (taken[i]) {
              weights[i] = 0;
              continue;
            }
            const pi = posIdx[i];
            const nm = pi > 5 ? 0 : needMult(counts[cOff + pi], POS_NAMES[pi], rc, pk.round);
            const wi = w[i] * nm;
            weights[i] = wi;
            total += wi;
          }
          if (total > 0) {
            let r = rand() * total;
            for (let i = 0; i < n; i++) {
              r -= weights[i];
              if (r <= 0 && weights[i] > 0) {
                chosen = i;
                break;
              }
            }
            if (chosen < 0) for (let i = n - 1; i >= 0; i--) if (weights[i] > 0) {
              chosen = i;
              break;
            }
          }
        }
        if (chosen >= 0) {
          taken[chosen] = 1;
          const pi = posIdx[chosen];
          if (pi <= 5) counts[cOff + pi]++;
          if (h === 0) takenBy[chosen] += 1;
        }
      }
      // Horizons beyond the simulated picks (draft ends first) count as survived.
      while (h < H) {
        const off = h * n;
        for (let i = 0; i < n; i++) if (!taken[i]) survive[off + i] += 1;
        h++;
      }
    }

    const survival = {};
    for (let i = 0; i < n; i++) {
      const arr = new Array(H);
      for (let h = 0; h < H; h++) arr[h] = survive[h * n + i] / N;
      survival[players[i].id] = arr;
    }
    return { survival, N, horizons, ms: Date.now() - t0, picksSimulated: picks.length };
  }

  root.SimCore = { runSim, needMult, mulberry32 };
})(typeof self !== 'undefined' ? self : globalThis);
