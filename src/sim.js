// src/sim.js - main-thread client for the survival sim. Runs the latest
// request only (a newer request supersedes a queued one), adapts N to the
// device, and falls back to the main thread if Workers are unavailable.
import { turnInfo, slotForPick, roundOf } from './draft.js';

export const DEFAULT_SIM_SETTINGS = {
  tau: 6,
  lateTauMult: 1.5,
  lateRoundStart: 13,
  N: 400,
  positionLimits: {}, // { QB: 3 } manual per-position roster maxes
};

export class SimClient {
  constructor({ log } = {}) {
    this.log = log || (() => {});
    this.N = DEFAULT_SIM_SETTINGS.N;
    this.worker = null;
    this.busy = false;
    this.pending = null;
    this.seq = 0;
    this.lastMs = null;
    try {
      if (typeof Worker !== 'undefined') this.worker = new Worker('./src/sim.worker.js');
    } catch (e) {
      this.log(`sim worker unavailable: ${e.message}`);
      this.worker = null;
    }
  }

  // Resolves with the result of the most recent request; older queued
  // requests resolve to null. opts: { N, adapt } (adapt=false leaves the
  // adaptive N untouched, for one-off long runs like the plan).
  run(input, opts = {}) {
    return new Promise((resolve) => {
      if (this.pending) this.pending.resolve(null);
      this.pending = { input, resolve, opts };
      this._drain();
    });
  }

  _drain() {
    if (this.busy || !this.pending) return;
    const job = this.pending;
    this.pending = null;
    this.busy = true;
    const opts = job.opts || {};
    const N = opts.N || this.N;
    const payload = { ...job.input, N };
    const finish = (result, error) => {
      this.busy = false;
      if (error) this.log(`sim error: ${error}`);
      if (result && opts.adapt !== false) {
        this.lastMs = result.ms;
        if (result.ms > 1200 && this.N > 100) this.N = Math.max(100, Math.floor(this.N / 2));
        else if (result.ms < 300 && this.N < DEFAULT_SIM_SETTINGS.N) this.N = Math.min(DEFAULT_SIM_SETTINGS.N, this.N * 2);
      }
      job.resolve(result || null);
      this._drain();
    };
    if (this.worker) {
      const id = ++this.seq;
      const onMsg = (e) => {
        if (!e.data || e.data.id !== id) return;
        this.worker.removeEventListener('message', onMsg);
        finish(e.data.result, e.data.error);
      };
      this.worker.addEventListener('message', onMsg);
      try {
        this.worker.postMessage({ id, input: payload });
      } catch (e) {
        this.worker.removeEventListener('message', onMsg);
        finish(null, e.message);
      }
    } else if (globalThis.SimCore) {
      try {
        finish(globalThis.SimCore.runSim(payload));
      } catch (e) {
        finish(null, e.message);
      }
    } else {
      finish(null, 'no sim engine');
    }
  }
}

// Roster config for the need model from roster_positions.
export function rosterConfig(rosterPositions, rounds, limits) {
  const rc = { starters: { QB: 0, RB: 0, WR: 0, TE: 0, K: 0, DEF: 0 }, flex: 0, superflex: 0, recFlex: 0, wrrbFlex: 0, rounds: rounds || 15, limits: limits || {} };
  for (const s of rosterPositions || []) {
    if (rc.starters[s] != null) rc.starters[s]++;
    else if (s === 'FLEX' || s === 'WRRB_TE_FLEX') rc.flex++;
    else if (s === 'SUPER_FLEX') rc.superflex++;
    else if (s === 'REC_FLEX') rc.recFlex++;
    else if (s === 'WRRB_FLEX') rc.wrrbFlex++;
  }
  return rc;
}

// Build the sim input from app state pieces. Returns null when there is
// nothing to simulate (draft complete, or no future user turn).
export function buildSimInput({ model, picks, draft, userId, taken, settings, seed, horizonsCount = 2 }) {
  const t = turnInfo({ picks, draft, userId });
  if (!t.current || !t.slot || !t.futureTurns.length) return null;
  const horizons = t.futureTurns.slice(0, horizonsCount).map((turn) => turn[0]);
  const last = horizons[horizons.length - 1];
  const cfg = t.cfg;
  const opts = { type: cfg.type, reversalRound: cfg.reversalRound };
  const seq = [];
  for (let p = t.current; p <= last && p <= cfg.totalPicks; p++) seq.push({ pickNo: p, slot: slotForPick(p, cfg.teams, opts), round: roundOf(p, cfg.teams) });
  // Team counts by slot from picks.
  const teams = {};
  for (let s = 1; s <= cfg.teams; s++) teams[s] = { QB: 0, RB: 0, WR: 0, TE: 0, K: 0, DEF: 0 };
  for (const pk of picks) {
    const s = Number(pk.draft_slot);
    const pos = pk.metadata && pk.metadata.position;
    if (teams[s] && teams[s][pos] != null) teams[s][pos]++;
  }
  const players = [];
  for (const p of model.pool) {
    if (taken.has(p.player_id)) continue;
    players.push({ id: p.player_id, pos: p.pos, adp: p.adp, value: p.value });
  }
  for (const p of model.rankOnly) {
    if (taken.has(p.player_id)) continue;
    players.push({ id: p.player_id, pos: p.pos, adp: p.adp, value: -999 });
  }
  const s = { ...DEFAULT_SIM_SETTINGS, ...(settings || {}) };
  return {
    players,
    picks: seq,
    teams,
    userSlot: t.slot,
    horizons,
    rc: rosterConfig(draft && draft.settings ? rosterPositionsFromDraft(draft) : [], cfg.rounds, s.positionLimits),
    tau: s.tau,
    lateTauMult: s.lateTauMult,
    lateRoundStart: s.lateRoundStart,
    seed: seed || (Date.now() & 0x7fffffff),
    horizonsInfo: t.futureTurns.slice(0, horizonsCount),
    currentPick: t.current,
  };
}

// The draft object carries slots_* counts; rebuild a roster_positions-like
// list from them so the need model matches what Sleeper enforces.
export function rosterPositionsFromDraft(draft) {
  const s = draft.settings || {};
  const out = [];
  const push = (key, name) => {
    for (let i = 0; i < (Number(s[key]) || 0); i++) out.push(name);
  };
  push('slots_qb', 'QB');
  push('slots_rb', 'RB');
  push('slots_wr', 'WR');
  push('slots_te', 'TE');
  push('slots_flex', 'FLEX');
  push('slots_super_flex', 'SUPER_FLEX');
  push('slots_rec_flex', 'REC_FLEX');
  push('slots_wrrb_flex', 'WRRB_FLEX');
  push('slots_k', 'K');
  push('slots_def', 'DEF');
  push('slots_bn', 'BN');
  return out;
}
