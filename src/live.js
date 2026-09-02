// src/live.js
// Live loop (plan section 10): poll picks every 3 s while visible, refresh
// immediately on visibilitychange/focus, diff by pick_no. A ReplaySource
// swaps in last year's draft for testing without a live draft.
// Read-only: sources only call GET endpoints in api.js.
import * as api from './api.js';
import { newPicks } from './draft.js';

export class LiveSource {
  constructor(draftId) {
    this.draftId = draftId;
    this.kind = 'live';
  }
  fetchPicks() {
    return api.getDraftPicks(this.draftId);
  }
  fetchDraft() {
    return api.getDraft(this.draftId);
  }
}

export class ReplaySource {
  constructor(picks, draft) {
    this.all = [...picks].sort((a, b) => a.pick_no - b.pick_no);
    this.draft = draft;
    this.n = 0;
    this.kind = 'replay';
    this.lastStep = Date.now();
  }
  fetchPicks() {
    return Promise.resolve(this.all.slice(0, this.n));
  }
  fetchDraft() {
    const status = this.n >= this.all.length ? 'complete' : this.n === 0 ? 'pre_draft' : 'drafting';
    return Promise.resolve({ ...this.draft, status, last_picked: this.lastStep });
  }
  step(k = 1) {
    this.n = Math.max(0, Math.min(this.all.length, this.n + k));
    this.lastStep = Date.now();
  }
  jumpTo(n) {
    this.n = Math.max(0, Math.min(this.all.length, n));
    this.lastStep = Date.now();
  }
  get total() {
    return this.all.length;
  }
}

export class DraftLoop {
  constructor({ source, intervalMs = 3000, onPicks, onError, log }) {
    this.source = source;
    this.intervalMs = intervalMs;
    this.onPicks = onPicks || (() => {});
    this.onError = onError || (() => {});
    this.log = log || (() => {});
    this.picks = [];
    this.draft = null;
    this.lastFetch = null;
    this.lastDraftFetch = 0;
    this.errors = 0;
    this.running = false;
    this._timer = null;
    this._inflight = null;
    this._onVis = () => {
      if (document.visibilityState === 'visible') this.refresh('visible');
    };
    this._onFocus = () => this.refresh('focus');
    this._onPageShow = () => this.refresh('pageshow');
  }

  start() {
    if (this.running) return;
    this.running = true;
    document.addEventListener('visibilitychange', this._onVis);
    window.addEventListener('focus', this._onFocus);
    window.addEventListener('pageshow', this._onPageShow);
    this.refresh('start').finally(() => this._schedule());
  }

  stop() {
    this.running = false;
    clearTimeout(this._timer);
    document.removeEventListener('visibilitychange', this._onVis);
    window.removeEventListener('focus', this._onFocus);
    window.removeEventListener('pageshow', this._onPageShow);
  }

  _schedule() {
    clearTimeout(this._timer);
    if (!this.running) return;
    this._timer = setTimeout(() => this._tick(), this.intervalMs);
  }

  async _tick() {
    if (!this.running) return;
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') {
      this._schedule();
      return;
    }
    await this.refresh('poll');
    this._schedule();
  }

  // Fetch picks (and the draft object when something changed or every 15 s).
  // Results that arrive after stop() are dropped so a stopped loop (replay
  // exit, draft switch) can never write into whatever replaced it.
  refresh(reason = 'manual') {
    if (this._inflight) return this._inflight;
    this._inflight = (async () => {
      try {
        const picks = await this.source.fetchPicks();
        if (!this.running) return;
        const fresh = newPicks(this.picks, picks);
        const changed = fresh.length > 0 || picks.length !== this.picks.length;
        this.picks = picks;
        this.lastFetch = Date.now();
        this.errors = 0;
        if (changed || !this.draft || Date.now() - this.lastDraftFetch > 15000) {
          try {
            const d = await this.source.fetchDraft();
            if (!this.running) return;
            if (d) {
              this.draft = d;
              this.lastDraftFetch = Date.now();
            }
          } catch (e) {
            this.log(`draft fetch failed: ${e.message}`);
          }
        }
        if (!this.running) return;
        this.onPicks({ picks, fresh, changed, reason, draft: this.draft, loop: this });
      } catch (e) {
        if (!this.running) return;
        this.errors++;
        this.onError(e, reason, this);
      } finally {
        this._inflight = null;
      }
    })();
    return this._inflight;
  }
}
