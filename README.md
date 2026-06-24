# Dostt Listener Leaderboard

A daily talktime leaderboard for Dostt listeners (experts). Each listener sees a personalised pool of 20 nearby competitors, earns podium rewards for finishing in the top 3, and builds a streak bonus for qualifying on consecutive days.

---

## How it works

- **Qualify** — accumulate ≥ 10 minutes of call talktime in a calendar day (IST)
- **Pool** — each listener is placed in a pool of 20 near-ranked competitors; display rank is 1–20 within that pool
- **Podium rewards** — credited at midnight IST: Rank 1 → ₹1,500 · Rank 2 → ₹1,000 · Rank 3 → ₹500 (all as Dostt coins)
- **Streak bonus** — ₹500 in coins for every 7 consecutive qualifying days
- **Ranks drift** — display rank updates every 10 minutes using a small random drift so the board feels live without exposing exact global position

---

## Stack

| Layer | Tech |
|---|---|
| Backend | Node.js + Express (single file — `server.js`) |
| Frontend | Vanilla HTML / CSS / JS (`public/`) — no bundler |
| Data | Redash (internal analytics) — 4 queries via REST API |
| Cache | In-memory + Postgres (`leaderboard_data_cache` table) |
| Session | Postgres (`connect-pg-simple`) → file store fallback → memory fallback |
| DB | PostgreSQL |
| Deploy | Docker + docker-compose |

---

## Local setup

### Prerequisites
- Node.js 18+
- PostgreSQL (optional — app runs without DB, ranks fall back to real global position)

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env` and fill in your values:

| Variable | Description |
|---|---|
| `REDASH_BASE_URL` | Redash instance URL (e.g. `https://analytics.example.com`) |
| `REDASH_API_KEY` | Redash API key |
| `REDASH_QUERY_1_ID` | Today's talktime query ID |
| `REDASH_QUERY_2_ID` | Yesterday's talktime query ID |
| `REDASH_QUERY_3_ID` | 7-day streak tiles query ID |
| `REDASH_QUERY_4_ID` | Mobile number → user_id lookup query ID |
| `DATABASE_URL` | Postgres connection string — omit to run without DB |
| `SESSION_SECRET` | Express session signing secret |
| `LEADERBOARD_START_DATE` | `YYYY-MM-DD` (IST) — suppresses yesterday/streak history on launch day |
| `PORT` | Default `3000` |

> If `REDASH_QUERY_1_ID` is not set the app runs in **MOCK_MODE** with hardcoded data — useful for UI testing without Redash credentials.

### 3. Set up the database (first time only)

```bash
npm run setup    # node scripts/setup_db.js
```

Creates tables: `session`, `leaderboard_pool_state`, `listener_streak`, `leaderboard_yesterday_results`, `leaderboard_data_cache`.  
Safe to re-run — uses `CREATE TABLE IF NOT EXISTS` and `ADD COLUMN IF NOT EXISTS`.

### 4. Run

```bash
npm start        # node server.js
npm run dev      # node --watch server.js  (auto-restarts on file changes)
```

Open `http://localhost:3000/login` or use a banner link `/?user_id=<id>`.

---

## Docker

```bash
docker-compose up --build    # builds image, starts app + postgres
docker-compose down
```

The `docker-compose.yml` wires up the app container and a Postgres container. The app waits for Postgres to be ready before starting.

---

## Deployment (Kubero / any PaaS)

1. Push this repo to GitHub
2. Point your platform at the repo
3. Set all env vars listed above in the platform dashboard
4. Run `node scripts/setup_db.js` once after first deploy to create DB tables
5. The app listens on `PORT` (default `3000`)

---

## Project structure

```
server.js               — Express backend (all routes, cache, pool, DB logic)
db.js                   — Postgres client (exported pool + query helper)
public/
  leaderboard.html      — App shell (tab layout, T&C overlay)
  leaderboard.js        — All fetch + render logic
  style.css             — Single stylesheet with CSS custom properties
  login.html            — Phone number login (self-contained)
  leaderboard-terms.html — Standalone T&C page (/leaderboard-terms)
scripts/
  setup_db.js           — DB migration (run once)
Dostt_packages/         — Brand assets (logo, avatars, icons)
Dockerfile
docker-compose.yml
.env.example
```

---

## Key backend concepts

**Pool construction** — `placeInPool(G, N, targetRank)` slices globally sorted qualified listeners so the user lands at exactly `targetRank` in their 20-person pool. Top-20 globally get their real rank; everyone else starts at 11 and drifts.

**Rank drift** — `refreshPoolState()` runs every 10 minutes. For each qualified listener it applies a small random delta to `target_rank` (active listeners trend upward; inactive ones trend downward) and persists it to `leaderboard_pool_state`. Floor: listeners with 3+ people above them globally are never shown in the top 3.

**Cache** — Three Redash queries are cached in memory and in `leaderboard_data_cache`. Q1 (today) refreshes every 10 min; Q2 (yesterday) and Q3 (streak) every hour. On startup the server loads from DB so a restart doesn't cold-hit Redash.

**Midnight settlement** — `midnightSettlement()` runs at 00:01 IST: updates `listener_streak`, snapshots final display ranks into `leaderboard_yesterday_results`, and purges stale pool rows.

**Start date** — `LEADERBOARD_START_DATE` suppresses yesterday/streak history on launch day. The yesterday tab shows a "Day 1" welcome card; streak is capped at 1.

---

## User flow

1. Banner link `/?user_id=XYZ` → server decodes, saves to session, redirects to `/leaderboard?user_id=XYZ`
2. Mobile login at `/login` → looks up `user_id` by phone number via Redash Q4
3. `/leaderboard` serves the HTML shell; JS fetches `/api/leaderboard/today`, `/yesterday`, `/streak`
4. The `user_id` is kept in the URL so session expiry doesn't log the user out

---

## Terms & Conditions

In-app: tap **Terms & Conditions** at the bottom of the leaderboard screen.  
Standalone page: `/leaderboard-terms`  
Hosted at: [www.dostt.in](https://www.dostt.in)

---

## Contact

Support: [support@dostt.in](mailto:support@dostt.in)  
Grievance Officer: Shruti Gupta — [grievance.officer@dostt.in](mailto:grievance.officer@dostt.in)  
Behtar Technology Private Limited · 1501, 19th Main, HSR Layout Sector 1, Bangalore – 560102
