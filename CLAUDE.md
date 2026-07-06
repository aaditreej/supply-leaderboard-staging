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

### Pool system (frozen pools)

Each listener sees a personal pool of 20 (themselves + 19 others), not global ranks. The goal is to show close competitors rather than a demoralising global leaderboard.

**Pool assignment** is owned exclusively by `refreshPoolState()` (runs every 10 min after the Q1 refresh). On a listener's first appearance it slices the globally sorted qualified list around them (`placeInPool` + `naturalTargetRank`: global top 3 target 1/2/3, everyone else 4–11 by percentile) and freezes the 20 member IDs into `leaderboard_pool_state.pool_members` (JSONB) for the rest of the IST day. The `/api/leaderboard/today` endpoint only ever READS pools — it never writes one (a first-access write would freeze tiny early-morning pools where everyone is rank 1).

**Display rank** = the listener's live-talktime position within their frozen pool. No drift, no randomness — rank moves only when the listener or their fixed competitors talk.

**Pool re-assignment** happens in `refreshPoolState()` only when: (a) the pool is undersized (`resolved < min(20, N)` — frozen when few had qualified), or (b) the listener floated into their pool's top 3 while not being global top 3 — they're "promoted" into a tougher pool targeted at rank 4 so their shown rank never teleports.

**Display rank rules**:
- Always 1–20 within personal pool, never global rank
- Only the GLOBAL top 3 may display rank 1/2/3 (podium). Everyone else is capped at 4 — enforced in `refreshPoolState` (promotion), in the today endpoint (consistent remap: the user's row is physically moved to position 4), and in the midnight snapshot
- With N ≤ 20 qualified, everyone sees the real global board
- Pool talktime ordering drives the visual bars; `max_talktime_secs` is the true pool max including the user

**IST-day hygiene**: all caches carry an implicit IST date — `fetchOrCache` treats a cache fetched on a previous IST day as expired, `refreshPoolState` refuses to write a previous day's rows under today's date, and `midnightSettlement` clears the in-memory caches. This prevents the post-midnight race where yesterday's talktimes get written as today's.

### DB tables

- `session` — express-session storage (Postgres or file fallback)
- `leaderboard_pool_state` — per-(user, date) pool assignment and display_rank; rebuilt nightly
- `listener_streak` — current streak count per listener; updated at midnight IST
- `leaderboard_yesterday_results` — snapshot of display_rank taken at midnight settlement

All DB operations are gated on `dbAvailable`. When `DATABASE_URL` is absent, falls back gracefully: in-memory neighbourhood slice for pool, Redash Q3 for streak count.

### Midnight settlement (`midnightSettlement()`)

Runs at 00:01 IST via `scheduleAtMidnight` (fixed UTC+5:30 offset math — host-timezone independent). Sequence:
1. Updates `listener_streak` for all listeners who qualified yesterday (idempotent — a double run or second replica leaves streaks unchanged)
2. Snapshots final display ranks into `leaderboard_yesterday_results` (talktime position within each frozen pool, global-top-3 cap applied)
3. Deletes stale rows from `leaderboard_pool_state` and clears in-memory caches

The yesterday endpoint serves the snapshot only when its `date_ist` is actually yesterday — a listener who skipped a day falls through to the Q2 on-demand fallback instead of seeing a stale old-date row.

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
