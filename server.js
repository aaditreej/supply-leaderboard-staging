require('dotenv').config();
const express = require('express');
const session = require('express-session');
const fetch   = require('node-fetch');
const path    = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/brand', express.static(path.join(__dirname, 'Dostt_packages')));

// ─── Session store ────────────────────────────────────────────────────────────
async function buildSessionStore() {
  if (process.env.DATABASE_URL) {
    try {
      const { pool } = require('./db');
      await pool.query('SELECT 1');
      const pgSession = require('connect-pg-simple')(session);
      console.log('Session store: Postgres');
      return new pgSession({ pool, createTableIfMissing: true });
    } catch (e) {
      console.warn('Postgres unavailable:', e.message);
    }
  }
  try {
    const FileStore = require('session-file-store')(session);
    console.log('Session store: file (.sessions/)');
    return new FileStore({ path: path.join(__dirname, '.sessions'), logFn: () => {} });
  } catch (e) {
    console.warn('File store unavailable, using memory store:', e.message);
    return null;
  }
}

let _sessionImpl = (req, res, next) => next();
app.use((req, res, next) => _sessionImpl(req, res, next));

// ─── Redash ───────────────────────────────────────────────────────────────────
const REDASH     = (process.env.REDASH_BASE_URL || '').replace(/\/$/, '');
const REDASH_KEY = process.env.REDASH_API_KEY    || '';

async function callRedash(queryId, parameters = null) {
  const body = { max_age: 0 };
  if (parameters) body.parameters = parameters;

  const triggerRes = await fetch(`${REDASH}/api/queries/${queryId}/results`, {
    method: 'POST',
    headers: { 'Authorization': `Key ${REDASH_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!triggerRes.ok) throw new Error(`Redash trigger HTTP ${triggerRes.status}`);
  const triggered = await triggerRes.json();

  if (triggered.query_result) return triggered.query_result.data.rows;

  const jobId = triggered.job.id;
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 2000));
    const pollRes  = await fetch(`${REDASH}/api/jobs/${jobId}`, {
      headers: { 'Authorization': `Key ${REDASH_KEY}` }
    });
    const { job } = await pollRes.json();
    if (job.status === 3) {
      const resultRes  = await fetch(`${REDASH}/api/query_results/${job.query_result_id}`, {
        headers: { 'Authorization': `Key ${REDASH_KEY}` }
      });
      const resultData = await resultRes.json();
      return resultData.query_result.data.rows;
    }
    if (job.status === 4) throw new Error(`Redash query ${queryId} failed`);
  }
  throw new Error(`Redash query ${queryId} timed out`);
}

// ─── Cache ────────────────────────────────────────────────────────────────────
const cache = {
  today:     { rows: null, fetchedAt: null },
  yesterday: { rows: null, fetchedAt: null },
  streak:    { rows: null, fetchedAt: null }
};

// Q1 background refresh cadence (minutes, default hourly). Endpoints always serve
// from cache — this job is the only thing that hits Redash for the today board.
const Q1_REFRESH_MS = (Number(process.env.Q1_REFRESH_MINUTES) || 60) * 60 * 1000;

// Endpoints pass this TTL: any same-IST-day cache is served instantly, no Redash
// round-trip on a user request. The background jobs keep the cache fresh.
const SERVE_TTL_MS = 24 * 60 * 60 * 1000;

async function fetchOrCache(key, ttlMs, queryId) {
  const now = Date.now();
  // Fresh = within TTL AND fetched on the same IST day. Crossing midnight IST
  // invalidates everything: Q1 talktimes reset, and "yesterday" changes meaning.
  if (cache[key].rows && (now - cache[key].fetchedAt) < ttlMs
      && istDateOf(cache[key].fetchedAt) === istToday()) {
    return cache[key].rows;
  }
  const rows = await callRedash(queryId);
  cache[key] = { rows, fetchedAt: now };
  // Persist to DB so cache survives restarts (non-blocking)
  if (dbAvailable) {
    db.query(
      `INSERT INTO leaderboard_data_cache (query_key, rows_json, fetched_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (query_key) DO UPDATE SET rows_json = EXCLUDED.rows_json, fetched_at = NOW()`,
      [key, JSON.stringify(rows)]
    ).catch(e => console.warn(`cache persist ${key}:`, e.message));
  }
  return rows;
}

async function loadCacheFromDB() {
  if (!dbAvailable) return;
  try {
    const { rows } = await db.query(
      `SELECT query_key, rows_json, fetched_at FROM leaderboard_data_cache`
    );
    for (const row of rows) {
      if (cache[row.query_key] !== undefined) {
        cache[row.query_key] = {
          rows:      JSON.parse(row.rows_json),
          fetchedAt: new Date(row.fetched_at).getTime()
        };
        console.log(`Cache restored: ${row.query_key} (${cache[row.query_key].rows.length} rows)`);
      }
    }
  } catch (e) {
    console.warn('loadCacheFromDB:', e.message);
  }
}

// ─── DB pool state ────────────────────────────────────────────────────────────
let db          = null;
let dbAvailable = false;

// naturalTargetRank: maps global 0-based index to a pool display rank using percentile spread.
// Top 3 globally get rank 1/2/3. Everyone else maps across 4-18 by percentile so the board
// shows variety from day 1 without needing drift history.
function naturalTargetRank(G, N) {
  if (G < 3) return G + 1;
  const pct = N > 1 ? G / (N - 1) : 0;
  // Cap at 11 — nobody sees worse than 11th, keeps the competitive feel.
  // Drift can move ranks in either direction from here during the day.
  return Math.max(4, Math.min(11, Math.round(4 + pct * 7)));
}

// Server-side talktime formatter (mirrors frontend fmtTalktime)
function fmtSecs(s) {
  s = Math.round(Number(s) || 0);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

// placeInPool: given global 0-based index G, total N, target position, returns slice bounds + userPos
function placeInPool(G, N, targetRank) {
  const above = G;
  const below = N - 1 - G;
  let takeAbove = Math.min(targetRank - 1, above);
  let takeBelow = Math.min(20 - targetRank, below);
  let deficit   = 20 - (takeAbove + 1 + takeBelow);
  if (deficit > 0) {
    const addA = Math.min(deficit, above - takeAbove); takeAbove += addA; deficit -= addA;
    const addB = Math.min(deficit, below - takeBelow); takeBelow += addB;
  }
  let userPos = takeAbove + 1;
  if (above >= 3) userPos = Math.max(4, userPos); // never imply top-3 if 3+ ahead globally
  return { takeAbove, takeBelow, userPos };
}

// computeStreak: consecutive qualifying days clamped to LEADERBOARD_START_DATE.
// Streak is "held" at yesterday's count during the day — only resets at midnight if today ends unqualified.
function computeStreak(q3Row, qualifiedToday, startStr, todayStr) {
  const flags = q3Row
    ? ['day_1','day_2','day_3','day_4','day_5','day_6','day_7']
        .map(k => q3Row[k] === true || q3Row[k] === 'true')
    : Array(7).fill(false);
  flags[6] = !!qualifiedToday; // override today with live cache

  const today = new Date(todayStr + 'T00:00:00Z');
  const start = startStr ? new Date(startStr + 'T00:00:00Z') : null;

  const inRange = i => {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - (6 - i));
    return !start || d >= start;
  };

  // Count consecutive qualifying days ending yesterday (held streak regardless of today)
  let streak = 0;
  for (let i = 5; i >= 0; i--) {
    if (!inRange(i)) break;
    if (flags[i]) streak++; else break;
  }

  // Extend by 1 if today is also qualified
  if (flags[6] && inRange(6)) streak += 1;

  return streak;
}

async function refreshPoolState() {
  if (!dbAvailable || !cache.today.rows) return;

  const today = istToday();
  // Never write a previous IST day's talktimes under today's date — a fetch that
  // straddled midnight would seed yesterday's whole cohort as "qualified today".
  if (istDateOf(cache.today.fetchedAt) !== today) {
    console.log('refreshPoolState: cache is from a previous IST day — skipping until fresh fetch');
    return;
  }

  const qualifiedRows = cache.today.rows
    .filter(r => r.qualified === true || r.qualified === 'true')
    .sort((a, b) => Number(b.talktime_secs) - Number(a.talktime_secs) || Number(a.user_id) - Number(b.user_id));

  const N = qualifiedRows.length;
  if (N === 0) return;

  const qMap = {};
  for (const r of qualifiedRows) qMap[String(r.user_id)] = Number(r.talktime_secs);

  // One read for all of today's state rows instead of one SELECT per user
  const stateMap = {};
  try {
    const { rows: stateRows } = await db.query(
      `SELECT user_id, pool_members FROM leaderboard_pool_state WHERE date_ist = $1`,
      [today]
    );
    for (const s of stateRows) stateMap[String(s.user_id)] = s;
  } catch (e) {
    console.error('refreshPoolState state read:', e.message);
    return;
  }

  for (let i = 0; i < qualifiedRows.length; i++) {
    const listener   = qualifiedRows[i];
    const globalRank = i + 1;
    const userTt     = Number(listener.talktime_secs);
    const current    = stateMap[String(listener.user_id)];

    try {
      let needsAssign = !current || !current.pool_members;
      let currentPoolRank = null;

      if (!needsAssign) {
        const members  = current.pool_members.map(String);
        const resolved = members.filter(uid => qMap[uid] !== undefined);

        // Rank the user currently holds within their frozen pool (live talktime order)
        const better = resolved.filter(uid =>
          uid !== String(listener.user_id) &&
          (qMap[uid] > userTt || (qMap[uid] === userTt && Number(uid) < Number(listener.user_id)))
        ).length;
        currentPoolRank = better + 1;

        if (resolved.length < Math.min(20, N)) {
          // Pool was frozen while few had qualified — grow it now that more exist
          needsAssign = true;
        } else if (globalRank > 3 && currentPoolRank <= 3) {
          // Global-top-3 rule: user floated into their pool's podium without being
          // global top 3 — promote them into a tougher pool with 3+ genuinely ahead
          needsAssign = true;
        }
      }

      if (needsAssign) {
        // Target: global top 3 keep their real rank; a promoted/regrown user lands just
        // off the podium so their shown rank never teleports backwards mid-day;
        // brand-new qualifiers spread across 4-11 by percentile.
        let targetRank;
        if (i < 3)                targetRank = i + 1;
        else if (currentPoolRank) targetRank = Math.max(4, Math.min(11, Math.min(currentPoolRank, naturalTargetRank(i, N))));
        else                      targetRank = naturalTargetRank(i, N);

        const { takeAbove, takeBelow } = placeInPool(i, N, targetRank);
        const poolSlice = qualifiedRows.slice(i - takeAbove, i + takeBelow + 1);
        const memberIds = JSON.stringify(poolSlice.map(r => String(r.user_id)));

        // Overwrite pool_members only when re-assigning a stale pool; for brand-new rows
        // COALESCE keeps a pool a concurrent replica may have written since our read.
        const overwrite = !!(current && current.pool_members);
        await db.query(`
          INSERT INTO leaderboard_pool_state
            (user_id, date_ist, talktime_secs, qualified, global_rank, target_rank, pool_members, last_updated)
          VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
          ON CONFLICT (user_id, date_ist) DO UPDATE SET
            talktime_secs = EXCLUDED.talktime_secs,
            qualified     = EXCLUDED.qualified,
            global_rank   = EXCLUDED.global_rank,
            pool_members  = ${overwrite ? 'EXCLUDED.pool_members' : 'COALESCE(leaderboard_pool_state.pool_members, EXCLUDED.pool_members)'},
            last_updated  = NOW()
        `, [listener.user_id, today, userTt, true, globalRank, targetRank, memberIds]);
      } else {
        // Pool is valid and frozen — only refresh live stats used by midnight settlement.
        await db.query(`
          UPDATE leaderboard_pool_state
          SET talktime_secs = $1, global_rank = $2, last_updated = NOW()
          WHERE user_id = $3 AND date_ist = $4
        `, [userTt, globalRank, listener.user_id, today]);
      }
    } catch (e) {
      console.error(`refreshPoolState user ${listener.user_id}:`, e.message);
    }
  }
  console.log(`Pool state refreshed: ${N} qualified listeners`);
}

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000; // IST is fixed UTC+5:30, no DST

function scheduleAtMidnight(fn) {
  // Compute the next 00:01 IST as a real epoch timestamp — no locale-string
  // parsing, immune to the host timezone and its DST transitions.
  const nowMs   = Date.now();
  const istNow  = new Date(nowMs + IST_OFFSET_MS); // IST wall clock viewed in the UTC frame
  const nextIst = Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), istNow.getUTCDate() + 1, 0, 1, 0, 0);
  const msUntil = (nextIst - IST_OFFSET_MS) - nowMs;
  setTimeout(async () => {
    try { await fn(); } catch (e) { console.error('Midnight settlement:', e.message); }
    scheduleAtMidnight(fn);
  }, msUntil);
}

async function midnightSettlement() {
  if (!dbAvailable) return;
  // Runs at 00:01 IST — settle the IST day that just ended
  const dateStr = istDateOf(Date.now() - 24 * 60 * 60 * 1000);
  console.log('Midnight settlement for', dateStr);

  const qualified = await db.query(
    `SELECT user_id FROM leaderboard_pool_state WHERE date_ist = $1 AND qualified = true`,
    [dateStr]
  );

  for (const row of qualified.rows) {
    // Idempotent: if last_qualifying_date is already dateStr (double run, or a second
    // replica settling), the streak stays unchanged. Bonus payout tracking lives in
    // the BigQuery reward tables, not here.
    await db.query(`
      INSERT INTO listener_streak (user_id, current_streak, last_qualifying_date, updated_at)
      VALUES ($1, 1, $2, NOW())
      ON CONFLICT (user_id) DO UPDATE SET
        current_streak = CASE
          WHEN listener_streak.last_qualifying_date = $2::date
          THEN listener_streak.current_streak
          WHEN listener_streak.last_qualifying_date = ($2::date - INTERVAL '1 day')::date
          THEN listener_streak.current_streak + 1 ELSE 1
        END,
        last_qualifying_date = $2,
        updated_at = NOW()
    `, [row.user_id, dateStr]);
  }

  // Snapshot the display rank each user actually saw at midnight.
  // For frozen-pool users: rank by final talktime within their locked pool.
  // Fallback: compute from target_rank + global_rank for any without pool_members.
  const { rows: poolSnap } = await db.query(
    `SELECT user_id, talktime_secs, target_rank, global_rank, pool_members
     FROM leaderboard_pool_state
     WHERE date_ist = $1 AND qualified = true`,
    [dateStr]
  );

  // Build a talktime map for frozen-pool rank computation
  const snapTtMap = {};
  for (const row of poolSnap) snapTtMap[String(row.user_id)] = Number(row.talktime_secs);

  const snapN = poolSnap.length;
  for (const row of poolSnap) {
    let displayRank;
    if (row.pool_members && Array.isArray(row.pool_members)) {
      // Rank by final talktime within the frozen pool — exactly what the user last saw.
      const sorted = row.pool_members
        .map(uid => ({ uid: String(uid), tt: snapTtMap[String(uid)] || 0 }))
        .sort((a, b) => b.tt - a.tt || Number(a.uid) - Number(b.uid));
      const pos = sorted.findIndex(m => m.uid === String(row.user_id));
      displayRank = pos >= 0 ? pos + 1 : null;
      // Only the global top 3 may finish 1/2/3 — mirrors the live display cap
      if (displayRank && (row.global_rank || 999) > 3) displayRank = Math.max(4, displayRank);
    } else {
      const G      = (row.global_rank || 1) - 1;
      const target = row.target_rank || naturalTargetRank(G, snapN);
      const { userPos } = placeInPool(G, snapN, target);
      displayRank = userPos;
    }
    if (!displayRank) continue;
    await db.query(`
      INSERT INTO leaderboard_daily_results (user_id, date_ist, talktime_secs, display_rank, global_rank, qualified)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (user_id, date_ist) DO UPDATE SET
        talktime_secs = EXCLUDED.talktime_secs,
        display_rank  = EXCLUDED.display_rank,
        global_rank   = EXCLUDED.global_rank,
        qualified     = EXCLUDED.qualified
    `, [row.user_id, dateStr, row.talktime_secs, displayRank, row.global_rank, true]);
  }

  await db.query(`DELETE FROM leaderboard_pool_state WHERE date_ist < $1`, [istToday()]);

  // Drop the previous day's in-memory caches so the next tick refetches fresh data
  cache.today     = { rows: null, fetchedAt: null };
  cache.yesterday = { rows: null, fetchedAt: null };
  cache.streak    = { rows: null, fetchedAt: null };

  console.log(`Settlement done: ${qualified.rows.length} streaks updated, ${poolSnap.length} display ranks saved`);
}

async function backfillYesterday() {
  if (!dbAvailable || !process.env.REDASH_QUERY_2_ID) return;
  if (isStartDate()) {
    console.log('Start date — skipping yesterday backfill');
    return;
  }

  const dateStr = istDateOf(Date.now() - 24 * 60 * 60 * 1000);

  const existing = await db.query(
    `SELECT COUNT(*) FROM leaderboard_daily_results WHERE date_ist = $1`,
    [dateStr]
  );
  const existingCount = parseInt(existing.rows[0].count);
  console.log(`Yesterday backfill check: ${existingCount} rows for ${dateStr}`);
  if (existingCount > 0) return; // already done

  const rows = await fetchOrCache('yesterday', SERVE_TTL_MS, process.env.REDASH_QUERY_2_ID);
  if (!rows || rows.length === 0) return;

  // Sort by talktime desc — same ordering as today's qualified pool
  const sorted = [...rows].sort(
    (a, b) => Number(b.talktime_secs) - Number(a.talktime_secs) || Number(a.user_id) - Number(b.user_id)
  );
  const N = sorted.length;
  console.log(`Backfilling yesterday pool for ${N} listeners (${dateStr})…`);

  for (let i = 0; i < sorted.length; i++) {
    const listener  = sorted[i];
    const { userPos: displayRank } = placeInPool(i, N, naturalTargetRank(i, N));
    const qualifiedYest = Number(listener.talktime_secs) >= 600;

    try {
      await db.query(`
        INSERT INTO leaderboard_daily_results (user_id, date_ist, talktime_secs, display_rank, global_rank, qualified)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (user_id, date_ist) DO UPDATE SET
          talktime_secs = EXCLUDED.talktime_secs,
          display_rank  = EXCLUDED.display_rank,
          global_rank   = EXCLUDED.global_rank,
          qualified     = EXCLUDED.qualified
      `, [listener.user_id, dateStr, Number(listener.talktime_secs), displayRank, i + 1, qualifiedYest]);
    } catch (e) {
      console.error(`backfillYesterday user ${listener.user_id}:`, e.message);
    }
  }

  console.log(`Yesterday backfill done: ${N} listeners`);
}

// ─── Start date helpers ───────────────────────────────────────────────────────
function getStartDate() {
  return process.env.LEADERBOARD_START_DATE || null;
}

function istToday() {
  return istDateOf(Date.now());
}

// IST calendar date (YYYY-MM-DD) of an epoch-ms timestamp
function istDateOf(ms) {
  return new Date(ms).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

function isStartDate() {
  const s = getStartDate();
  return s ? istToday() === s : false;
}

function isBeforeStart() {
  const s = getStartDate();
  return s ? istToday() < s : false;
}

// ─── Auth middleware ──────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (!req.session.userId) return res.redirect('/login');
  next();
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// Entry Point 1 — banner tap (?user_id= in URL, may be base64-encoded)
function decodeUserId(raw) {
  try {
    const decoded = Buffer.from(raw, 'base64').toString('utf8').trim();
    return /^\d+$/.test(decoded) ? decoded : raw;
  } catch {
    return raw;
  }
}

app.get('/', (req, res) => {
  const raw = req.query.user_id;
  if (raw) {
    const userId = decodeUserId(raw);
    if (!userId) return res.redirect('/login');
    req.session.userId = userId;
    return req.session.save(() =>
      res.redirect('/leaderboard?user_id=' + encodeURIComponent(raw))
    );
  }
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/leaderboard-terms', (req, res) => res.sendFile(path.join(__dirname, 'public', 'leaderboard-terms.html')));

// Entry Point 2 — mobile number login
app.post('/api/auth/lookup-mobile', async (req, res) => {
  const { mobile_number } = req.body;
  if (!mobile_number) return res.status(400).json({ error: 'mobile_number required' });
  try {
    const rows  = await callRedash(process.env.REDASH_QUERY_4_ID, { mobile_numbers: String(mobile_number) });
    const match = rows.find(r => r.user_id);
    if (!match) return res.status(404).json({ error: 'This number is not registered as a listener.' });
    req.session.userId = String(match.user_id);
    req.session.save(() => res.json({ success: true }));
  } catch (err) {
    console.error('lookup-mobile:', err.message);
    res.status(503).json({ error: 'Data unavailable, retry in a moment.' });
  }
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

const TEST_USER_ID = '13236328';

app.get('/api/auth/mode', requireAuth, (req, res) => {
  if (String(req.session.userId) !== TEST_USER_ID) {
    if (req.session.mode !== 'real') {
      req.session.mode = 'real';
      req.session.save(() => {});
    }
    return res.json({ mode: 'real', show_chip: false });
  }
  res.json({ mode: req.session.mode || null, show_chip: true });
});

app.post('/api/auth/set-mode', requireAuth, (req, res) => {
  if (String(req.session.userId) !== TEST_USER_ID) {
    return res.status(403).json({ error: 'Not allowed' });
  }
  const { mode } = req.body;
  if (mode !== 'test' && mode !== 'real') return res.status(400).json({ error: 'Invalid mode' });
  req.session.mode = mode;
  req.session.save(() => res.json({ success: true }));
});

app.get('/leaderboard', (req, res) => {
  // Re-auth from URL param — keeps banner links self-authenticating after session expiry
  const raw = req.query.user_id;
  if (raw) {
    const userId = decodeUserId(raw);
    if (userId) {
      req.session.userId = userId;
      req.session.save(() => {});
    }
  }
  if (!req.session.userId) return res.redirect('/login');
  res.sendFile(path.join(__dirname, 'public', 'leaderboard.html'));
});

// ─── Mock data ────────────────────────────────────────────────────────────────
const MOCK_MODE = !process.env.REDASH_QUERY_1_ID;

function fmtDisplay(secs) {
  return `${Math.floor(secs / 60)}m ${secs % 60}s`;
}

function mockTodayData(userId) {
  const talktimes = [3492, 3100, 2940, 2780, 2650, 2510, 2400, 2280, 2160, 2050,
                     1940, 1820, 1710, 1620, 1530, 1440, 1350, 1260, 1180, 1090];
  const myIdx   = 11; // display_rank 12 in pool
  const userIds = talktimes.map((_, i) => i === myIdx ? String(userId) : String(90000 + i));
  const ist     = new Date().toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short',
    year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false
  }) + ' IST';

  // All 20 users form the pool; display_rank = position in pool (1–20)
  const pool = talktimes.map((t, i) => ({
    user_id:          userIds[i],
    expert_id:        80000 + i,
    display_rank:     i + 1,
    talktime_secs:    t,
    talktime_display: fmtDisplay(t),
    is_me:            i === myIdx
  }));

  const top3      = pool.slice(0, 3).map((r, i) => ({ ...r, reward: i === 0 ? 1500 : i === 1 ? 1000 : 500 }));
  const poolBelow = pool.slice(3);

  const myPoolRow = pool[myIdx];
  const rowAbove  = pool[myIdx - 1];
  const gapSecs   = Math.max(0, rowAbove.talktime_secs - myPoolRow.talktime_secs);

  return {
    qualified:           true,
    my_user_id:          String(userId),
    my_display_rank:     myIdx + 1,
    my_talktime_secs:    myPoolRow.talktime_secs,
    my_talktime_display: myPoolRow.talktime_display,
    top3,
    pool_below:          poolBelow,
    gap_to_next_secs:    gapSecs,
    gap_to_next_rank:    rowAbove.display_rank,
    max_talktime_secs:   talktimes[0],
    last_refreshed_at:   ist,
    _mock: true
  };
}

function mockYesterdayData(userId) {
  const t = 4320;
  return {
    user_id:          String(userId),
    talktime_secs:    t,
    talktime_display: fmtDisplay(t),
    display_rank:     9
  };
}

function mockStreakData(userId) {
  // 5-day streak: days 3–7 qualified (indices 2–6), days 1–2 not
  return {
    user_id:        String(userId),
    expert_id:      80011,
    days:           [false, false, true, true, true, true, true],
    current_streak: 5,
    days_to_bonus:  2,
    next_bonus_inr: 100
  };
}

// ─── Debug (remove before production) ────────────────────────────────────────
app.get('/api/debug/raw', requireAuth, async (req, res) => {
  try {
    const [r1, r2, r3] = await Promise.allSettled([
      callRedash(process.env.REDASH_QUERY_1_ID),
      callRedash(process.env.REDASH_QUERY_2_ID),
      callRedash(process.env.REDASH_QUERY_3_ID)
    ]);
    res.json({
      q1: r1.status === 'fulfilled' ? { cols: Object.keys(r1.value[0] || {}), sample: r1.value[0] } : { error: r1.reason?.message },
      q2: r2.status === 'fulfilled' ? { cols: Object.keys(r2.value[0] || {}), sample: r2.value[0] } : { error: r2.reason?.message },
      q3: r3.status === 'fulfilled' ? { cols: Object.keys(r3.value[0] || {}), sample: r3.value[0] } : { error: r3.reason?.message }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Leaderboard API ──────────────────────────────────────────────────────────

app.get('/api/leaderboard/today', requireAuth, async (req, res) => {
  if (MOCK_MODE || req.session.mode === 'test') return res.json(mockTodayData(req.session.userId));
  try {
    const allRows = await fetchOrCache('today', SERVE_TTL_MS, process.env.REDASH_QUERY_1_ID);
    const userId  = req.session.userId;
    const myRow   = allRows.find(r => String(r.user_id) === String(userId));

    if (!myRow) return res.json({ qualified: false, my_talktime_secs: 0, progress_percent: 0 });

    const myTalktime  = Number(myRow.talktime_secs);
    const isQualified = myRow.qualified === true || myRow.qualified === 'true';

    if (!isQualified) {
      return res.json({
        qualified:           false,
        my_talktime_secs:    myTalktime,
        my_talktime_display: myRow.talktime_display,
        progress_percent:    Math.min(99, Math.floor((myTalktime / 600) * 100))
      });
    }

    const qualifiedRows = allRows
      .filter(r => r.qualified === true || r.qualified === 'true')
      .sort((a, b) => Number(b.talktime_secs) - Number(a.talktime_secs) || Number(a.user_id) - Number(b.user_id));

    const N = qualifiedRows.length;
    const G = qualifiedRows.findIndex(r => String(r.user_id) === String(userId));

    // Small pool: show everyone at real sorted positions
    if (N <= 20) {
      const pool      = qualifiedRows.map((r, idx) => ({
        user_id:          r.user_id,
        expert_id:        r.expert_id,
        display_rank:     idx + 1,
        talktime_secs:    Number(r.talktime_secs),
        talktime_display: r.talktime_display,
        is_me:            String(r.user_id) === String(userId)
      }));
      const top3      = pool.slice(0, 3).map((r, i) => ({ ...r, reward: i === 0 ? 1500 : i === 1 ? 1000 : 500 }));
      const poolBelow = pool.slice(3);
      const rowAbove  = G > 0 ? pool[G - 1] : null;
      const gapSecs   = rowAbove ? Math.max(0, rowAbove.talktime_secs - myTalktime) : 0;
      return res.json({
        qualified:           true,
        my_user_id:          myRow.user_id,
        my_display_rank:     pool[G].display_rank,
        my_talktime_secs:    myTalktime,
        my_talktime_display: myRow.talktime_display,
        top3,
        pool_below:          poolBelow,
        gap_to_next_secs:    gapSecs,
        gap_to_next_rank:    rowAbove ? rowAbove.display_rank : null,
        max_talktime_secs:   Number(qualifiedRows[0]?.talktime_secs) || 1,
        last_refreshed_at:   allRows[0]?.last_refreshed_at
      });
    }

    // Build a talktime lookup for frozen-pool use
    const ttMap = {};
    for (const r of qualifiedRows) ttMap[String(r.user_id)] = r;

    // Pool assignment is owned exclusively by refreshPoolState() (runs every 10 min).
    // Direct API requests only READ an existing frozen pool; they never write one.
    // This prevents early-morning first-access from freezing a tiny pool where the
    // user naturally appears as rank 1.
    let poolRows;
    let userPos;
    const today = istToday();

    let frozenMembers = null;
    if (dbAvailable) {
      try {
        const { rows: stateRows } = await db.query(
          `SELECT pool_members FROM leaderboard_pool_state WHERE user_id = $1 AND date_ist = $2`,
          [userId, today]
        );
        if (stateRows[0]?.pool_members) frozenMembers = stateRows[0].pool_members;
      } catch (e) { console.warn('pool state read:', e.message); }
    }

    let frozenIdx = -1;
    if (frozenMembers) {
      // Frozen pool exists — build from stored member IDs using live talktime.
      poolRows = frozenMembers
        .map(uid => ttMap[String(uid)])
        .filter(Boolean)
        .sort((a, b) => Number(b.talktime_secs) - Number(a.talktime_secs) || Number(a.user_id) - Number(b.user_id));
      frozenIdx = poolRows.findIndex(r => String(r.user_id) === String(userId));
    }

    if (frozenMembers && frozenIdx >= 0) {
      let myIdx = frozenIdx;
      // Global-top-3 rule: only the global top 3 may occupy podium slots. If this user
      // floated into their frozen pool's top 3 without that, physically move them to
      // position 4 so podium/list/my_display_rank/gap all stay consistent. The next
      // refreshPoolState tick promotes them into a tougher pool anyway.
      if (G >= 3 && myIdx < 3) {
        const me = poolRows.splice(myIdx, 1)[0];
        poolRows.splice(3, 0, me);
        myIdx = 3;
      }
      userPos = myIdx + 1;
    } else {
      // No frozen pool yet (refreshPoolState hasn't run for this user today), or the
      // user is somehow missing from their own pool — live dynamic slice fallback.
      const { takeAbove, takeBelow, userPos: up } = placeInPool(G, N, naturalTargetRank(G, N));
      poolRows = qualifiedRows.slice(G - takeAbove, G + takeBelow + 1);
      userPos  = up;
    }

    const pool      = poolRows.map((r, idx) => ({
      user_id:          r.user_id,
      expert_id:        r.expert_id,
      display_rank:     idx + 1,
      talktime_secs:    Number(r.talktime_secs),
      talktime_display: r.talktime_display,
      is_me:            String(r.user_id) === String(userId)
    }));
    const top3      = pool.slice(0, 3).map((r, i) => ({ ...r, reward: i === 0 ? 1500 : i === 1 ? 1000 : 500 }));
    const poolBelow = pool.slice(3);
    const myPoolIdx = userPos - 1;
    const rowAbove  = myPoolIdx > 0 ? pool[myPoolIdx - 1] : null;
    const gapSecs   = rowAbove ? Math.max(0, rowAbove.talktime_secs - myTalktime) : 0;

    res.json({
      qualified:           true,
      my_user_id:          myRow.user_id,
      my_display_rank:     userPos,
      my_talktime_secs:    myTalktime,
      my_talktime_display: myRow.talktime_display,
      top3,
      pool_below:          poolBelow,
      gap_to_next_secs:    gapSecs,
      gap_to_next_rank:    rowAbove ? rowAbove.display_rank : null,
      // True pool max — after the podium remap the user (rank 4) may hold the
      // highest talktime, and bars must scale to it
      max_talktime_secs:   Math.max(Number(poolRows[0]?.talktime_secs) || 1, myTalktime),
      last_refreshed_at:   allRows[0]?.last_refreshed_at
    });

  } catch (err) {
    console.error('/api/leaderboard/today:', err.message);
    res.status(503).json({ error: 'Data unavailable, retry in a moment.' });
  }
});

app.get('/api/leaderboard/yesterday', requireAuth, async (req, res) => {
  if (MOCK_MODE || req.session.mode === 'test') return res.json(mockYesterdayData(req.session.userId));

  if (isStartDate() || isBeforeStart()) {
    return res.json({ launch_day: true });
  }

  try {
    const userId = req.session.userId;

    // Prefer the midnight snapshot — this is the rank the user actually saw at day end.
    // leaderboard_daily_results is append-only history, so scope to yesterday's date.
    const yIST = istDateOf(Date.now() - 24 * 60 * 60 * 1000);
    if (dbAvailable) {
      try {
        const { rows: snap } = await db.query(
          `SELECT talktime_secs, display_rank FROM leaderboard_daily_results
           WHERE user_id = $1 AND date_ist = $2`,
          [userId, yIST]
        );
        if (snap[0]) {
          let displayRank = snap[0].display_rank;
          // Read-time guard: a stored finish of 1/2/3 must be backed by a real global
          // top-3 finish in Q2. Snapshots written before the cap existed (or by a stale
          // pool) get recomputed here and the row self-heals.
          if (displayRank != null && displayRank <= 3) {
            try {
              const sorted = (await fetchOrCache('yesterday', SERVE_TTL_MS, process.env.REDASH_QUERY_2_ID))
                .slice()
                .sort((a, b) => Number(b.talktime_secs) - Number(a.talktime_secs) || Number(a.user_id) - Number(b.user_id));
              const G = sorted.findIndex(r => String(r.user_id) === String(userId));
              if (G >= 3) {
                const { userPos } = placeInPool(G, sorted.length, naturalTargetRank(G, sorted.length));
                displayRank = userPos;
              } else if (G === -1) {
                displayRank = Math.max(4, displayRank);
              }
              if (displayRank !== snap[0].display_rank) {
                db.query(
                  `UPDATE leaderboard_daily_results SET display_rank = $1 WHERE user_id = $2 AND date_ist = $3`,
                  [displayRank, userId, yIST]
                ).catch(e => console.warn('yesterday self-heal write:', e.message));
              }
            } catch (e) { console.warn('yesterday top-3 verify:', e.message); }
          }
          return res.json({
            user_id:          userId,
            talktime_secs:    Number(snap[0].talktime_secs),
            talktime_display: fmtSecs(snap[0].talktime_secs),
            display_rank:     displayRank
          });
        }
      } catch (e) { console.warn('yesterday snapshot read:', e.message); }
    }

    // Fallback: compute on-demand from Q2 data (no snapshot yet — first day or backfill running)
    const sorted = (await fetchOrCache('yesterday', SERVE_TTL_MS, process.env.REDASH_QUERY_2_ID))
      .slice()
      .sort((a, b) => Number(b.talktime_secs) - Number(a.talktime_secs) || Number(a.user_id) - Number(b.user_id));

    const N = sorted.length;
    const G = sorted.findIndex(r => String(r.user_id) === String(userId));
    if (G === -1) return res.json(null);

    const { userPos } = placeInPool(G, N, naturalTargetRank(G, N));

    res.json({
      user_id:          sorted[G].user_id,
      talktime_secs:    Number(sorted[G].talktime_secs),
      talktime_display: sorted[G].talktime_display,
      display_rank:     userPos
    });
  } catch (err) {
    console.error('/api/leaderboard/yesterday:', err.message);
    res.status(503).json({ error: 'Data unavailable, retry in a moment.' });
  }
});

app.get('/api/leaderboard/streak', requireAuth, async (req, res) => {
  if (MOCK_MODE || req.session.mode === 'test') return res.json(mockStreakData(req.session.userId));
  try {
    const userId = req.session.userId;

    // Today's qualified status from live cache — only if it was fetched today (IST);
    // right after a restart the restored cache may still hold yesterday's rows
    const todayCacheValid = !!(cache.today?.rows && istDateOf(cache.today.fetchedAt) === istToday());
    const allRows      = todayCacheValid ? cache.today.rows : [];
    const myTodayRow   = allRows.find(r => String(r.user_id) === String(userId));
    const qualifiedToday = !!(myTodayRow && (myTodayRow.qualified === true || myTodayRow.qualified === 'true'));

    // Q3 tile data (cached 2h); gracefully absent if REDASH_QUERY_3_ID not set
    let q3Row = null;
    try {
      const rows = await fetchOrCache('streak', SERVE_TTL_MS, process.env.REDASH_QUERY_3_ID);
      q3Row = rows.find(r => String(r.user_id) === String(userId)) || null;
    } catch (e) { /* Q3 absent — streak will be based only on today's live qualification */ }

    const streak     = computeStreak(q3Row, qualifiedToday, getStartDate(), istToday());
    const inCycle    = streak === 0 ? 0 : ((streak - 1) % 7) + 1;
    const bonusHit   = streak > 0 && streak % 7 === 0;
    const filled     = bonusHit ? 7 : inCycle;
    const daysToBonus = bonusHit ? 0 : 7 - inCycle;

    res.json({
      user_id:        userId,
      days:           Array.from({ length: 7 }, (_, i) => i < filled),
      current_streak: streak,
      days_to_bonus:  daysToBonus,
      next_bonus_inr: 100
    });
  } catch (err) {
    console.error('/api/leaderboard/streak:', err.message);
    res.status(503).json({ error: 'Data unavailable, retry in a moment.' });
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

(async () => {
  const store = await buildSessionStore();
  _sessionImpl = session({
    store: store || undefined,
    secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 8 * 60 * 60 * 1000, httpOnly: true, sameSite: 'lax' }
  });
  if (!store) console.warn('Using MemoryStore — sessions will not survive restarts');

  // Connect DB for pool state + cache persistence
  if (process.env.DATABASE_URL) {
    try {
      db = require('./db');
      await db.pool.query('SELECT 1');
      dbAvailable = true;
      console.log('DB: connected');
    } catch (e) {
      console.warn('DB: unavailable —', e.message);
    }
  }

  // Load persisted cache from DB before serving requests (avoids cold-start lag)
  await loadCacheFromDB();

  app.listen(PORT, () => {
    console.log(`Dostt leaderboard on http://localhost:${PORT}`);
    console.log(`LEADERBOARD_START_DATE: ${getStartDate() || '(not set)'}`);
    console.log(`isStartDate(): ${isStartDate()}, isBeforeStart(): ${isBeforeStart()}`);

    if (process.env.REDASH_QUERY_1_ID) {
      // Warm up all 3 queries on startup (Redash fetches run in background)
      (async () => {
        try {
          await fetchOrCache('today', Q1_REFRESH_MS, process.env.REDASH_QUERY_1_ID);
          await refreshPoolState();
        } catch (e) { console.warn('Q1 warm-up:', e.message); }
        try {
          await fetchOrCache('yesterday', 60 * 60 * 1000, process.env.REDASH_QUERY_2_ID);
          await backfillYesterday();
        } catch (e) { console.warn('Q2 warm-up:', e.message); }
        try {
          await fetchOrCache('streak', 60 * 60 * 1000, process.env.REDASH_QUERY_3_ID);
        } catch (e) { console.warn('Q3 warm-up:', e.message); }
      })();

      // Q1: background refresh (default hourly; Q1_REFRESH_MINUTES to tune)
      setInterval(async () => {
        try {
          cache.today = { rows: null, fetchedAt: null };
          await fetchOrCache('today', Q1_REFRESH_MS, process.env.REDASH_QUERY_1_ID);
          await refreshPoolState();
        } catch (e) { console.error('Q1 scheduled refresh:', e.message); }
      }, Q1_REFRESH_MS);

      // Q2 + Q3: refresh every hour (yesterday talktime and streak tiles)
      setInterval(async () => {
        try {
          cache.yesterday = { rows: null, fetchedAt: null };
          await fetchOrCache('yesterday', 60 * 60 * 1000, process.env.REDASH_QUERY_2_ID);
        } catch (e) { console.error('Q2 hourly refresh:', e.message); }
        try {
          cache.streak = { rows: null, fetchedAt: null };
          await fetchOrCache('streak', 60 * 60 * 1000, process.env.REDASH_QUERY_3_ID);
        } catch (e) { console.error('Q3 hourly refresh:', e.message); }
      }, 60 * 60 * 1000);
    }

    if (dbAvailable) scheduleAtMidnight(midnightSettlement);
  });
})();
