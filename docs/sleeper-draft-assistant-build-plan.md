# Sleeper Draft Assistant — Build Plan (v1)

Phone-only live draft companion for Sleeper leagues. Static web app on GitHub Pages, no server. Reads the Sleeper public API from the browser, re-scores the user's projections under each league's exact scoring, and shows live recommendations with survival-to-next-pick probabilities.

**Hard deadline:** first real draft is **Sunday Sept 6, 2026, 12:30 PM CDT** (draft `start_time` 1788715859000). Ship P0 before then. Everything marked P1/P2 is optional for this draft.

---

## 1. Non-negotiable constraints

- **Runs entirely on an iPhone 17 Pro Max in Safari.** No laptop during the draft. No backend. Everything is client-side JS on GitHub Pages (same pattern as `barakbrown2.github.io/draft-tracker`).
- **Read-only.** The tool never makes, submits, or queues a pick. (The Sleeper API is read-only anyway; do not add any write path.)
- **Two leagues, different formats.** League 1 is 10-team superflex full PPR (details below). League 2 is TBD — likely 1QB. All scoring, roster, and draft config must be read from the API per league, never hardcoded.
- **User uploads files from the phone.** Projections CSV and rankings CSV arrive via `<input type="file">` from the iOS Files app. Persist them in the browser (localStorage for the ~35 KB CSVs; IndexedDB for the ~5 MB Sleeper player map). This is a standalone site, so browser storage is fine.
- **90-second pick clock, snake.** Every recomputation after a pick must finish in < 2 s on the phone. Heavy sims run in a Web Worker.
- **iOS suspends background tabs.** The page cannot poll while the user is in the Sleeper app. On `visibilitychange`/`focus`, immediately re-fetch picks and recompute. Also poll every 3 s while visible.

---

## 2. Sleeper API (no auth, CORS from browser)

Base: `https://api.sleeper.app/v1`

| Purpose | Endpoint |
|---|---|
| Username → user_id | `GET /user/{username}` (username: `barakbrown2`) |
| User's leagues for a season | `GET /user/{user_id}/leagues/nfl/2026` |
| League config (scoring_settings, roster_positions, total_rosters, draft_id, previous_league_id) | `GET /league/{league_id}` |
| League users (display names for draft board) | `GET /league/{league_id}/users` |
| Draft config (type, rounds, pick_timer, draft_order, slot_to_roster_id, settings.slots_*) | `GET /draft/{draft_id}` |
| **Live picks** (poll this) | `GET /draft/{draft_id}/picks` |
| Player map (id → name, team, position, injury_status, etc.) | `GET /players/nfl` — ~5 MB, cache in IndexedDB with 24 h TTL, fetch at most once/day |
| Last year's draft (for replay + league tendencies) | `GET /league/{previous_league_id}/drafts` → `GET /draft/{id}/picks` |

Rate limit guidance: stay well under 1000 req/min. 3 s polling on one endpoint is ~20/min.

**Day-1 check:** confirm `api.sleeper.app` returns permissive CORS headers from a GitHub Pages origin (it does for existing community tools, but verify with a fetch from the deployed page). Contingency if it doesn't: a tiny Cloudflare Worker proxy (free tier) that forwards `GET` only and adds `Access-Control-Allow-Origin: *`. One-time setup from the computer; the phone never touches it.

Draft picks payload fields used: `pick_no`, `round`, `draft_slot`, `roster_id`, `picked_by`, `player_id`, `is_keeper`, `metadata.{first_name,last_name,position,team}`. Treat `is_keeper: true` rows as taken players (League 1 shows `max_keepers: 3` — may or may not be in use).

---

## 3. League 1 reference values ("vigorous jazz hands")

- league_id `1388245460631719936`, draft_id `1388245460648497152`, previous_league_id `1186831590109896704` (2025), copy_from_league_id `1049951352078237696` (2024)
- User's user_id is the one at `draft_order` slot **1** (`574323656180514816`) — verify via `/user/barakbrown2` on load rather than assuming.
- 10 teams, **snake**, 15 rounds, **90 s** pick clock, `reversal_round: 0` (standard snake), `cpu_autopick: 1`, `enforce_position_limits: 1` (league may have per-position roster maxes; the API doesn't expose them here — surface a manual setting, default none).
- Roster: QB, RB, RB, WR, WR, WR, TE, FLEX, SUPER_FLEX, BN×6, IR×1. **No K, no DEF.**
- User picks (slot 1): **1, 20, 21, 40, 41, 60, 61, 80, 81, 100, 101, 120, 121, 140, 141.**
- Scoring highlights: `pass_yd 0.04`, `pass_td 4`, `pass_int -2`, `rush_yd 0.1`, `rec 1.0`, `rec_yd 0.1`, all TDs 6, `fum_lost -2`, 2-pt conversions 2, `bonus_rush_yd_100 3`, `bonus_rush_yd_200 3`, `bonus_pass_yd_300 3`, `bonus_pass_yd_400 3`, no receiving-yard bonus, no TE premium. (Full `scoring_settings` object is in the league JSON — always read it live; never copy these values into code.)
- Note: league `settings.draft_rounds: 3` is a stale/irrelevant field. The draft object's `settings.rounds: 15` is authoritative. Always trust the draft object for rounds/timer/type.

---

## 4. Input files

### 4a. Projections CSV (season totals, one file shared across leagues)
Columns: `Player, Position, Team, Auction, Opp., PaCom, PaAtt, PaYds, PaTD, PaINT, RuAtt, RuYds, RuTD, Fum., Tar, Rec, ReYds, ReTD, FPTS`
- ~440 rows: QB, RB, WR, TE, K, DST. `Opp.` and `Fum.` are empty in the season-long file (populated only in in-season weekly files with the same template) — treat blank as 0/absent.
- `FPTS` is the source's own scoring (full PPR, 4-pt pass TD, -1 INT, no fumbles). **Ignore FPTS for QB/RB/WR/TE** — re-score from components. K and DST have no component stats; use FPTS only if the league rosters K/DEF, otherwise drop those rows entirely.
- `Auction` column: ignore for snake drafts.
- Same file template is re-uploaded repeatedly as the season approaches; parse defensively (BOM, trailing commas, quoted names).

### 4b. Rankings CSVs (one per format)
Header: `Player, Team, Position, <Analyst1>, <Analyst2>, ..., Consensus`. Analyst columns vary by export:
- 1QB export: `Ratcliffe, Popielarz, Herms, Orginski, Consensus`
- Superflex export: `Ratcliffe, Popielarz, Orginski, Consensus` (no Herms)
- Detect analyst columns dynamically = every column between `Position` and `Consensus`.
- Blank cells = unranked by that analyst (do not treat as 0). Some rows are duplicated (e.g., "Nicholas Singleton" appears twice with different partial ranks) — merge duplicates by taking the min non-blank rank per analyst.
- DST rows: name is the team nickname with a trailing space ("Texans "), team codes like `HST/BLT/ARZ/LA`. K/DST rows are irrelevant when the league has no K/DEF slots.
- Users pick which rankings file applies to which league. Default: if roster has `SUPER_FLEX`, use the superflex file.

### 4c. Name normalization (CSV ↔ Sleeper player map)
Match key = lowercase, strip punctuation and whitespace, strip suffixes (`jr`, `sr`, `ii`, `iii`, `iv`), map nicknames the files use (`Hollywood Brown` → `Marquise Brown`; keep a small manual alias map in code). Match on `(key, position)`; use team only as a tiebreaker because team codes differ (`ARZ/ARI`, `HST/HOU`, `BLT/BAL`, `LA/LAR`, `INA` = inactive/FA). Sleeper DEF player_ids are team abbreviations (`HOU`, `BAL`). Log unmatched names to a visible "unmatched" list in settings so the user can fix them on the phone.

---

## 5. Scoring engine

Score every QB/RB/WR/TE from components using the league's `scoring_settings`:

```
pts = PaYds*pass_yd + PaTD*pass_td + PaINT*pass_int + PaCom*pass_cmp + PaAtt*pass_att + (PaAtt-PaCom)*pass_inc
    + RuYds*rush_yd + RuTD*rush_td + RuAtt*rush_att
    + Rec*rec + ReYds*rec_yd + ReTD*rec_td + Rec*bonus_rec_{rb|wr|te by position}
    + fumbles_lost_est*fum_lost
    + per_game_bonuses
```

**Per-game bonuses from season totals.** Model each per-game stat as Normal(mean = season/17, sd = CV × mean); expected bonus = 17 × Σ bonus_i × P(X ≥ threshold_i). Both tiers stack (a 200-yd game also earns the 100-yd bonus — matches Sleeper). Default CVs (editable in settings): passing yards 0.30, rushing yards 0.55, receiving yards 0.60, pass completions 0.25, rush attempts 0.45. Apply to any `bonus_*_yd_*`, `bonus_pass_cmp_25`, `bonus_rush_att_20`, `bonus_rush_rec_yd_*` keys present. Keys with no component data (`pass_td_40p`, `rec_40p`, `*_2pt`, etc.) are skipped and listed under "Unmodeled scoring keys" in settings.

**Fumbles-lost estimate** (no projection data): QB `3.5 × PaAtt/500`; RB/WR/TE `(RuAtt + Rec)/250`. Editable.

**Validation fixture.** `rescored-league1-fixture.csv` (shipped alongside this plan) contains the expected output under League 1 scoring with the defaults above. The engine must reproduce these within ±0.2 pts:

| Player | LgPts | of which pass bonus | rush bonus | fumble est |
|---|---|---|---|---|
| Josh Allen | 349.1 | 6.0 | 0 | -6.8 |
| Jahmyr Gibbs | 348.4 | 0 | 13.7 | -2.5 |
| Bijan Robinson | 347.4 | 0 | 14.4 | -2.7 |
| Ja'Marr Chase | 324.9 | 0 | 0 | -0.9 |
| Joe Burrow | 306.4 | 12.0 | 0 | -7.9 |
| Jonathan Taylor | 304.3 | 0 | 17.2 | -2.7 |

Replacement levels with the fixture data: QB18 = 259.5, RB28 = 180.1, WR34 = 175.5, TE11 = 152.0.

---

## 6. Value model

**Replacement baselines derived from roster + team count** (T = teams). Flex allocation defaults: FLEX → RB 0.50 / WR 0.40 / TE 0.10; SUPER_FLEX → QB 0.85 / RB 0.08 / WR 0.07. Baseline rank per position = round(T × (dedicated slots + flex share)) + cushion, cushion = QB 0, RB 2, WR 0, TE 0. For League 1 this yields QB18 / RB28 / WR34 / TE11. Show and allow editing.

- `VORP = LgPts − LgPts(baseline player at that position)`.
- **Superflex reality check:** in League 1, QB18 still projects ~250 while a flex-level RB/WR is ~180, so any starting-caliber QB is worth ~70 pts over the flex alternative in the SUPER_FLEX slot. Implement the SUPER_FLEX slot as "best available of QB/RB/WR/TE for your roster," so the need multiplier reflects that a second QB is a starter, not depth.
- **Dynamic replacement (P1):** as the draft progresses, recompute baselines from the *remaining* pool plus expected picks before the user's next turn.

**Rankings blend.** Weighted mean of analyst ranks with blanks excluded and weights renormalized per player. Defaults: Ratcliffe 0.55, every other analyst splits 0.45 equally (superflex file: 0.60 / 0.20 / 0.20). Convert the blended rank to a value on the projection scale by mapping rank → LgPts of the player at that overall projection rank (so ranks and points live on one scale). Final value = `w_proj × VORP_proj + (1 − w_proj) × VORP_from_rank`, default `w_proj = 0.65`. Rankings are most useful within position; projections carry cross-position decisions (see §9).

**Tiers.** Within position, break tiers where the gap to the next player exceeds max(6 pts, 1.5× median gap in the top 40). Show tier boundaries on the board.

---

## 7. Survival-to-next-pick simulation

Goal: for each remaining player, `P(available at user's next pick)` and `P(available at the pick after that)` (snake pairs: 20 & 21, 40 & 41, …).

**Other-team pick model.** Each opposing pick samples from the remaining pool with weight ∝ `exp(−adjADP / τ)` × need multiplier × position-limit mask, τ default 6 (editable). `adjADP` = blended rankings rank, adjusted by **league tendencies** (§8) when available. Need multiplier per team from their current roster vs. `roster_positions` (e.g., a team with 0 QB in superflex gets ×2.0 on QBs; a team with full RB starters gets ×0.6 on RBs until bench). Late rounds (13+): random noise increases (τ ×1.5).

**Sim.** Run N = 400 Monte Carlo draft continuations in a Web Worker after every observed pick; only simulate up to the user's next two picks. Report survival % per player for both. Recompute must complete in < 1.5 s; degrade N if the device is slow (measure and adapt).

**QB-run alarm.** If ≥ 3 QBs were taken in the last 5 picks, or projected QB survival to the user's next pick drops below 40% for the last QB in the current tier, show a banner.

**Pre-draft plan mode (P1).** Before the draft starts, run the sim from pick 1 to show "expected best available at each of your picks" by position — this is the 1.01 decision view (e.g., Gibbs/Bijan at 1, expected QB tier at 20/21).

---

## 8. League tendencies from past drafts (P1, high value)

Fetch the 2025 draft (`previous_league_id` → drafts → picks) and 2024 if present. Compute:
- How early QBs went vs. the superflex consensus (this league's QB aggressiveness).
- Per-manager positional tendencies keyed by `picked_by` user_id (same people return year to year).
- Use these as multipliers on `adjADP` in the survival model. Show a small "League profile" card: QBs taken in rounds 1–3 last year, etc.
- **Replay mode:** step through last year's picks one at a time against last year's config to test the live loop and UI without a live draft. This is the primary integration test.

---

## 9. Recommendation logic (what the top of the screen shows)

For each candidate player at the user's turn:
1. `Value` = blended VORP (§6) × roster-need multiplier for the user's roster.
2. `Cost of waiting` = Value(player) − E[Value of best available at the same position at the user's next pick] (from the survival sim).
3. Sort primarily by `Value`, but flag/boost players whose `Cost of waiting` is large (they won't be there) and de-emphasize players likely to survive (show "likely there at 20" instead of recommending now).
4. Always show, per position, the best player likely to survive to the next pick — this is the "you can wait on X" signal.

The projections carry cross-position calls at the top of the draft: under League 1 scoring, Gibbs/Bijan (~348) tie Allen (349) in raw points but have double his VORP because QB2–QB12 sit in a flat 310–280 band while RB falls 348 → 320 → 304 → 278. Ratcliffe's superflex board (Allen 1, Burrow 4, Caleb 10) is much more QB-aggressive than this; the blend keeps him as a within-position signal without letting him override the 1.01 decision.

---

## 10. Live loop

1. On load: restore persisted league, files, weights. Fetch `/user/barakbrown2` → leagues → let user tap a league → fetch league + draft + users. Cache player map.
2. Poll `/draft/{id}/picks` every 3 s while `document.visibilityState === 'visible'`; on `visibilitychange` → visible and on `focus`, fetch immediately. Diff by `pick_no`.
3. On new picks: mark players taken, update all rosters, detect whether it's the user's turn (`next pick_no` maps to user's slot via snake math using `draft_order` and `settings.reversal_round`), recompute values in the main thread (fast), kick off survival sim in the worker, render.
4. Show: current pick number, whose turn, picks until user's turn, and a local countdown estimated from `pick_timer` and the last pick timestamp (approximate — Sleeper's clock is authoritative).
5. Handle: keepers (`is_keeper`), CPU autopicks (indistinguishable, just picks), traded picks (`/draft/{id}/traded_picks` — League 1 has `pick_trading: 0`, but implement generically), draft status `pre_draft` / `drafting` / `complete`.

---

## 11. Mobile UI (iPhone 17 Pro Max, Safari, portrait)

Single-column, thumb-first. Respect safe-area insets. Support dark mode. Minimum 15 pt text, 44 pt tap targets. Add-to-Home-Screen manifest so it opens full-screen.

Screens (bottom tab bar):
- **Board** (default): header = pick status + countdown + QB-run banner. Position filter chips: ALL / QB / RB / WR / TE / FLEX. List of top 12 recommendations: name, team, pos, LgPts, VORP, tier, survival % to next pick (color: green ≥ 70, amber 40–69, red < 40), injury badge from Sleeper `injury_status`. Tap row → detail sheet (component projection, per-analyst ranks, both survival numbers, "best alternative at your next pick").
- **My Team**: roster slots filled vs. open, projected weekly starters total, positional needs.
- **Draft**: full pick log and per-team rosters (read-only). Sortable by position — the user regularly sorts by position and views the full board mid-draft.
- **Settings**: league picker; file uploads (projections, rankings per format) with "last uploaded" timestamps; analyst weights; `w_proj`; baselines; CVs; τ; unmatched-names list; unmodeled-scoring-keys list; replay mode; clear data.

No modal that traps the user; every screen reachable in ≤ 2 taps. Keep the DOM small (virtualize the pick log if needed).

---

## 12. Storage keys

- `settings:v1` — weights, w_proj, baselines, CVs, τ, per-league rankings-file mapping
- `file:projections`, `file:rankings:1qb`, `file:rankings:superflex` — raw CSV text + uploaded_at
- `league:{league_id}` — cached league/draft JSON (refresh on open)
- IndexedDB `players_nfl` — player map + fetched_at

Version every key; migrate or wipe on schema change.

---

## 13. Phasing (deadline: Sunday Sept 6, 12:30 PM CDT)

**P0 — must work Sunday**
- API layer + CORS confirmed from the deployed page
- CSV upload/persist/parse for both file types, name matching, unmatched list
- Scoring engine passes the §5 fixture
- Static VORP baselines + rankings blend + tiers
- Live loop (polling, visibility refresh, turn detection, snake math)
- Board + My Team + Draft screens
- Survival sim (N=400, next two picks), QB-run banner
- Replay test against the 2025 draft; end-to-end test in a Sleeper mock draft on the phone (verify the picks endpoint works for mocks — it should; if not, replay mode is the test)

**P1 — if time allows before Sunday, otherwise before League 2**
- League tendencies from past drafts (§8)
- Pre-draft plan mode (§7)
- Dynamic replacement levels
- League 2 format detection polish (1QB, K/DEF present)

**P2**
- Back-test: score 2025 actual stats under the league's scoring and compare to the source's 2025 projections (Sleeper has an undocumented stats endpoint; otherwise skip). Shows how much to trust the source at each position.
- Weekly in-season mode using the same CSV template (Opp./Fum. columns populated).

---

## 14. Acceptance checklist

- [ ] Open the page on the phone, tap league, see correct roster slots, scoring summary, 15 rounds, 90 s, snake, user slot 1.
- [ ] Upload projections + superflex rankings from Files; reload the page; files persist.
- [ ] Fixture players match §5 within ±0.2.
- [ ] Replay 2025 draft: board updates every step, turn detection fires at the right picks, no unmatched top-100 players.
- [ ] In a mock draft: after switching to Sleeper and back, the board reflects new picks within 1 s.
- [ ] Survival sim completes < 1.5 s per update on the phone.
- [ ] K/DST never appear on League 1's board.
- [ ] Nothing in the app can write to Sleeper.

---

## 15. Repo layout (suggested)

```
/index.html            single-page app shell
/src/api.js            Sleeper endpoints + caching
/src/csv.js            parsing + name normalization + alias map
/src/scoring.js        scoring engine (pure functions, unit-tested against fixture)
/src/value.js          baselines, VORP, rankings blend, tiers
/src/sim.worker.js     survival Monte Carlo
/src/draft.js          live loop, snake math, turn detection
/src/ui/*.js           screens
/test/fixture.csv      rescored-league1-fixture.csv
/manifest.webmanifest  PWA
```

Plain JS + a tiny build (or none) is fine; keep it deployable by pushing to `main`.
