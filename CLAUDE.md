# Sleeper Draft Assistant

Phone-only live draft companion for Sleeper fantasy leagues. Static site on
GitHub Pages (`https://barakbrown2.github.io/sleeper-draft/`), plain JS, no
build step, no server. The full plan is
`docs/sleeper-draft-assistant-build-plan.md`; read it before changing behavior.

## Hard constraints (from the plan; do not relax without asking)

- **Deadline.** First real draft is **Sunday Sept 6, 2026, 12:30 PM CDT**
  (draft `start_time` 1788715859000). P0 must work by then. P1/P2 are optional.
- **Phone-only.** Runs on an iPhone 17 Pro Max in Safari, portrait, no laptop
  during the draft. Everything is client-side. Input files arrive from the iOS
  Files app via `<input type="file">` and persist in localStorage (CSVs) and
  IndexedDB (Sleeper player map, 24 h TTL).
- **Read-only Sleeper API. Never write.** Only `GET https://api.sleeper.app/v1/...`.
  No code path may make, submit, or queue a pick, or send any non-GET request
  to Sleeper. No auth token exists anywhere in this repo.
- **Two leagues, different formats.** League 1 "vigorous jazz hands"
  (league `1388245460631719936`, draft `1388245460648497152`): 10-team
  superflex, full PPR, snake, 15 rounds, 90 s clock, no K/DEF, user at slot 1.
  League 2 is TBD (likely 1QB). Scoring, roster slots, and draft config are
  read from the API per league at runtime. Never hardcode scoring values,
  roster slots, rounds, or timer. Trust the draft object over the league
  object for rounds/timer/type.
- **No build, no node_modules.** Plain ES modules served as-is from `main`.
  This folder is OneDrive-synced: never create `node_modules/`, lockfiles, or
  build output here. Node is used only to run `test/*.mjs` with built-ins.
- **Performance.** Every recompute after a pick must finish in < 2 s on the
  phone. The survival Monte Carlo (N=400, next two user turns) runs in a Web
  Worker and must finish in < 1.5 s; degrade N on slow devices.
- **iOS suspends background tabs.** Poll `/draft/{id}/picks` every 3 s while
  `document.visibilityState === 'visible'`; re-fetch immediately on
  `visibilitychange` to visible and on `focus`.

## Validation

- Scoring engine must reproduce `docs/rescored-league1-fixture.csv` within
  +/-0.2 pts: `node test/run.mjs`.
- Replay mode against the 2025 draft (`previous_league_id` -> drafts -> picks)
  is the primary integration test for the live loop.
- Acceptance checklist: plan section 14. K/DST never appear on League 1's board.

## Layout

`index.html` (app shell), `src/api.js`, `src/csv.js`, `src/scoring.js`,
`src/value.js`, `src/draft.js`, `src/sim.worker.js`, `src/ui/*.js`,
`test/*.mjs`, `docs/` (plan, input CSVs, fixture), `manifest.webmanifest`.

## Workflow

- Deploy by pushing to `main`; GitHub Pages serves the repo root.
- Deploy after each P0 step and test on the phone at the Pages URL.
- Commit messages: plain, no trailers.
