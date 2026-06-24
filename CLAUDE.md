# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Run locally (reads .env automatically)
npm start           # node server.js
npm run dev         # node --watch server.js  (auto-restarts on file changes)

# Create/migrate DB tables (run once after DATABASE_URL is set)
npm run setup       # node scripts/setup_db.js

# Docker
docker-compose up --build   # builds image, starts app + postgres
docker-compose down
```

No build step. No test suite. Frontend is plain HTML/CSS/JS served as static files.

## Architecture

Single-file Express backend (`server.js`) + static frontend (`public/`). No framework, no bundler.

### Request flow

1. User arrives via banner link (`/?user_id=XYZ` or base64-encoded) or types their mobile number on `/login`
2. Banner links: server decodes `user_id`, saves to session, redirects to `/leaderboard?user_id=XYZ` (URL param persists for re-auth after session expiry)
3. Mobile login: calls Redash Q4 to look up `user_id` by phone number
4. `/leaderboard` serves `public/leaderboard.html`; the JS fetches three API endpoints

### Data flow

All leaderboard data comes from Redash (internal analytics). Three queries:
- **Q1** (`REDASH_QUERY_1_ID`) — today's talktime for all listeners; has a `qualified` boolean (≥10 min)
- **Q2** (`REDASH_QUERY_2_ID`) — yesterday's talktime
- **Q3** (`REDASH_QUERY_3_ID`) — 7-day streak tiles per listener
- **Q4** (`REDASH_QUERY_4_ID`) — mobile number → user_id lookup

Results are cached in-memory: Q1 = 10 min TTL, Q2/Q3 = 2 hr TTL. Every 10 minutes the server proactively invalidates and re-fetches Q1, then calls `refreshPoolState()`.

`MOCK_MODE` is active when `REDASH_QUERY_1_ID` is not set — returns hardcoded mock data so the UI is testable without Redash credentials.

### Pool system

Each listener sees a personal pool of 20 (themselves + 19 others), not global ranks. The goal is to show close competitors rather than a demoralising global leaderboard.

**Pool construction** (`buildPool(qualifiedRows, listenerIdx)`):
- Takes globally sorted qualified listeners and the listener's index
- Selects up to 15 listeners from within +20 percentile points above, 4 from −10 below
- Pads to 19 with nearest-percentile others if needed
- Returns 19 rows (listener added back as position 20, then pool is sorted by talktime → display_rank 1–20)

**Pool persistence** (`leaderboard_pool_state` table): the periodic job `refreshPoolState()` writes each listener's pool to Postgres. Display rank is computed with dampening (any positive delta moves rank up) + random drift (±1 or ±2) to keep the board feeling live. When a listener's row doesn't exist yet, the `/api/leaderboard/today` endpoint writes it on-demand immediately.

**Display rank rules**:
- Always 1–20 within personal pool, never global rank
- Podium shows top 3 of personal pool (not global top 3)
- `state.display_rank` from DB is what's shown; pool talktime ordering drives the visual bars

### DB tables

- `session` — express-session storage (Postgres or file fallback)
- `leaderboard_pool_state` — per-(user, date) pool assignment and display_rank; rebuilt nightly
- `listener_streak` — current streak count per listener; updated at midnight IST
- `leaderboard_yesterday_results` — snapshot of display_rank taken at midnight settlement

All DB operations are gated on `dbAvailable`. When `DATABASE_URL` is absent, falls back gracefully: in-memory neighbourhood slice for pool, Redash Q3 for streak count.

### Midnight settlement (`midnightSettlement()`)

Runs at 00:01 IST via `scheduleAtMidnight`. Sequence:
1. Updates `listener_streak` for all listeners who qualified yesterday
2. Snapshots final display ranks into `leaderboard_yesterday_results`
3. Deletes stale rows from `leaderboard_pool_state`

### Start date

`LEADERBOARD_START_DATE` (format `YYYY-MM-DD` IST) controls launch-day behaviour:
- Yesterday endpoint returns `{ launch_day: true }` — no Redash Q2 call
- Streak endpoint returns a fresh 0-day streak using only today's Q1 cache (ignores Q3 history)
- `backfillYesterday()` skips entirely
- Frontend renders a "Day 1" welcome card on the Yesterday tab

### Mode restriction

Test/mock mode (`req.session.mode = 'test'`) is only accessible to `TEST_USER_ID = '13236328'` (mobile 9988818731). All other users are silently forced to `mode: 'real'`. The mode picker UI (`#mode-page`) is only shown when `show_chip: true` in the `/api/auth/mode` response.

### Frontend structure

- `public/leaderboard.html` — shell; `#tab-today` / `#tab-yesterday` switched by JS
- `public/leaderboard.js` — all fetch + render logic; no framework
  - `drift` object tracks velocity across polls for live ticker interpolation
  - `loadStreak()` calls `renderStreak(null)` immediately (shows empty state) before the async fetch, so the streak section never disappears on API failure
- `public/style.css` — single stylesheet; CSS custom properties at `:root`
- `public/login.html` — self-contained (inline JS, no external deps)

### Brand assets

Served from `Dostt_packages/` (a sibling directory, not inside the repo) via `app.use('/brand', express.static(...))`. Key assets: `Phone.png` (pending card icon), `avatar1-3.jpeg` (podium avatars), `Dostt_icon_no_bg.png` (header logo).

## Key env vars

| Variable | Purpose |
|---|---|
| `REDASH_BASE_URL` | Redash instance URL |
| `REDASH_API_KEY` | Redash API key |
| `REDASH_QUERY_1_ID` — `4_ID` | Query IDs for today / yesterday / streak / mobile lookup |
| `DATABASE_URL` | Postgres connection string; omit to run without DB |
| `SESSION_SECRET` | Express session signing secret |
| `LEADERBOARD_START_DATE` | `YYYY-MM-DD` IST — suppresses yesterday/streak history on Day 1 |
| `PORT` | Default 3000 |
