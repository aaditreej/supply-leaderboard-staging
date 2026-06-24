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

async function fetchOrCache(key, ttlMs, queryId) {
  const now = Date.now();
  if (cache[key].rows && (now - cache[key].fetchedAt) < ttlMs) {
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

  const rows  = cache.today.rows;
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

  const qualifiedRows = rows
    .filter(r => r.qualified === true || r.qualified === 'true')
    .sort((a, b) => Number(b.talktime_secs) - Number(a.talktime_secs) || Number(a.user_id) - Number(b.user_id));

  const N = qualifiedRows.length;
  if (N === 0) return;

  for (let i = 0; i < qualifiedRows.length; i++) {
    const listener   = qualifiedRows[i];
    const globalRank = i + 1;

    try {
      const existing = await db.query(
        `SELECT talktime_secs, target_rank FROM leaderboard_pool_state WHERE user_id = $1 AND date_ist = $2`,
        [listener.user_id, today]
      );
      const current = existing.rows[0];

      let targetRank;

      if (!current) {
        targetRank = i < 20 ? i + 1 : 11;
      } else {
        const delta = Number(listener.talktime_secs) - Number(current.talktime_secs);
        const r = Math.random();
        if (delta <= 0) {
          // Inactive: 50% stay, 30% down 1, 15% up 1, 5% ±2
          if      (r < 0.50) targetRank = current.target_rank;
          else if (r < 0.80) targetRank = current.target_rank + 1;
          else if (r < 0.95) targetRank = current.target_rank - 1;
          else               targetRank = current.target_rank + (Math.random() < 0.5 ? -2 : +2);
        } else {
          // Active: 70% up 1, 20% stay, 10% up 2 — never down
          if      (r < 0.70) targetRank = current.target_rank - 1;
          else if (r < 0.90) targetRank = current.target_rank;
          else               targetRank = current.target_rank - 2;
        }
        // Floor: if 3+ people above globally, never target top-3
        if (i >= 3) targetRank = Math.max(4, targetRank);
        targetRank = Math.max(1, Math.min(20, targetRank));
      }

      await db.query(`
        INSERT INTO leaderboard_pool_state
          (user_id, date_ist, talktime_secs, qualified, global_rank, target_rank, last_updated)
        VALUES ($1,$2,$3,$4,$5,$6,NOW())
        ON CONFLICT (user_id, date_ist) DO UPDATE SET
          talktime_secs = EXCLUDED.talktime_secs,
          qualified     = EXCLUDED.qualified,
          global_rank   = EXCLUDED.global_rank,
          target_rank   = EXCLUDED.target_rank,
          last_updated  = NOW()
      `, [listener.user_id, today, Number(listener.talktime_secs), true, globalRank, targetRank]);

    } catch (e) {
      console.error(`refreshPoolState user ${listener.user_id}:`, e.message);
    }
  }
  console.log(`Pool state refreshed: ${N} qualified listeners`);
}

function scheduleAtMidnight(fn) {
  const ist     = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const next    = new Date(ist);
  next.setDate(next.getDate() + 1);
  next.setHours(0, 1, 0, 0);
  const msUntil = next - ist;
  setTimeout(async () => {
    try { await fn(); } catch (e) { console.error('Midnight settlement:', e.message); }
    scheduleAtMidnight(fn);
  }, msUntil);
}

async function midnightSettlement() {
  if (!dbAvailable) return;
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const dateStr = yesterday.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  console.log('Midnight settlement for', dateStr);

  const qualified = await db.query(
    `SELECT user_id FROM leaderboard_pool_state WHERE date_ist = $1 AND qualified = true`,
    [dateStr]
  );

  for (const row of qualified.rows) {
    await db.query(`
      INSERT INTO listener_streak (user_id, current_streak, last_qualifying_date, updated_at)
      VALUES ($1, 1, $2, NOW())
      ON CONFLICT (user_id) DO UPDATE SET
        current_streak = CASE
          WHEN listener_streak.last_qualifying_date = ($2::date - INTERVAL '1 day')::date
          THEN listener_streak.current_streak + 1 ELSE 1
        END,
        last_qualifying_date = $2,
        total_bonuses_earned = CASE
          WHEN MOD(CASE
            WHEN listener_streak.last_qualifying_date = ($2::date - INTERVAL '1 day')::date
            THEN listener_streak.current_streak + 1 ELSE 1
          END, 7) = 0
          THEN listener_streak.total_bonuses_earned + 1
          ELSE listener_streak.total_bonuses_earned
        END,
        updated_at = NOW()
    `, [row.user_id, dateStr]);
  }

  // Snapshot yesterday's display ranks before clearing pool state
  const yesterdayRows = await db.query(
    `SELECT user_id, talktime_secs, display_rank FROM leaderboard_pool_state
     WHERE date_ist = $1 AND qualified = true`,
    [dateStr]
  );
  for (const row of yesterdayRows.rows) {
    await db.query(`
      INSERT INTO leaderboard_yesterday_results (user_id, date_ist, talktime_secs, display_rank, updated_at)
      VALUES ($1, $2, $3, $4, NOW())
      ON CONFLICT (user_id) DO UPDATE SET
        date_ist = EXCLUDED.date_ist, talktime_secs = EXCLUDED.talktime_secs,
        display_rank = EXCLUDED.display_rank, updated_at = NOW()
    `, [row.user_id, dateStr, row.talktime_secs, row.display_rank]);
  }

  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  await db.query(`DELETE FROM leaderboard_pool_state WHERE date_ist < $1`, [today]);
  console.log(`Settlement done: ${qualified.rows.length} streaks updated, ${yesterdayRows.rows.length} display ranks saved`);
}

async function backfillYesterday() {
  if (!dbAvailable || !process.env.REDASH_QUERY_2_ID) return;
  if (isStartDate()) {
    console.log('Start date — skipping yesterday backfill');
    return;
  }

  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const dateStr = yesterday.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

  const existing = await db.query(
    `SELECT COUNT(*) FROM leaderboard_yesterday_results WHERE date_ist = $1`,
    [dateStr]
  );
  const existingCount = parseInt(existing.rows[0].count);
  console.log(`Yesterday backfill check: ${existingCount} rows for ${dateStr}`);
  if (existingCount > 0) return; // already done

  const rows = await fetchOrCache('yesterday', 2 * 60 * 60 * 1000, process.env.REDASH_QUERY_2_ID);
  if (!rows || rows.length === 0) return;

  // Sort by talktime desc — same ordering as today's qualified pool
  const sorted = [...rows].sort(
    (a, b) => Number(b.talktime_secs) - Number(a.talktime_secs) || Number(a.user_id) - Number(b.user_id)
  );
  const N = sorted.length;
  console.log(`Backfilling yesterday pool for ${N} listeners (${dateStr})…`);

  for (let i = 0; i < sorted.length; i++) {
    const listener   = sorted[i];
    const poolOthers = buildPool(sorted, i); // 19 others via percentile bands

    // Add listener to pool, sort by talktime → their display rank (1-20)
    const fullPool   = [...poolOthers, listener]
      .sort((a, b) => Number(b.talktime_secs) - Number(a.talktime_secs));
    const displayRank = fullPool.findIndex(r => String(r.user_id) === String(listener.user_id)) + 1;

    try {
      await db.query(`
        INSERT INTO leaderboard_yesterday_results (user_id, date_ist, talktime_secs, display_rank, updated_at)
        VALUES ($1, $2, $3, $4, NOW())
        ON CONFLICT (user_id) DO NOTHING
      `, [listener.user_id, dateStr, Number(listener.talktime_secs), displayRank]);
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
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
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
    next_bonus_inr: 500
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
    const allRows = await fetchOrCache('today', 10 * 60 * 1000, process.env.REDASH_QUERY_1_ID);
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

    // Default: use real global rank for top-20, 11 for everyone else.
    // With DB this gets overwritten by the drift-adjusted stored value.
    const naturalRank = G < 20 ? G + 1 : 11;
    let targetRank = naturalRank;
    if (dbAvailable) {
      const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
      try {
        const { rows: stateRows } = await db.query(
          `SELECT target_rank FROM leaderboard_pool_state WHERE user_id = $1 AND date_ist = $2`,
          [userId, today]
        );
        if (stateRows[0]) {
          targetRank = stateRows[0].target_rank || naturalRank;
        } else {
          // First load — seed DB so next 10-min job picks it up; seed from real rank
          await db.query(`
            INSERT INTO leaderboard_pool_state
              (user_id, date_ist, talktime_secs, qualified, global_rank, target_rank, last_updated)
            VALUES ($1,$2,$3,$4,$5,$6,NOW())
            ON CONFLICT (user_id, date_ist) DO NOTHING
          `, [userId, today, myTalktime, true, G + 1, naturalRank]);
        }
      } catch (e) { console.warn('pool state read:', e.message); }
    }

    const { takeAbove, takeBelow, userPos } = placeInPool(G, N, targetRank);
    const poolRows = qualifiedRows.slice(G - takeAbove, G + takeBelow + 1);

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
    const rowAbove  = takeAbove > 0 ? pool[takeAbove - 1] : null;
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
      max_talktime_secs:   Number(poolRows[0]?.talktime_secs) || 1,
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
    const sorted = (await fetchOrCache('yesterday', 2 * 60 * 60 * 1000, process.env.REDASH_QUERY_2_ID))
      .slice()
      .sort((a, b) => Number(b.talktime_secs) - Number(a.talktime_secs) || Number(a.user_id) - Number(b.user_id));

    const N = sorted.length;
    const G = sorted.findIndex(r => String(r.user_id) === String(userId));
    if (G === -1) return res.json(null);

    const { userPos } = placeInPool(G, N, G < 20 ? G + 1 : 11);

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

    // Today's qualified status from live cache
    const allRows      = cache.today?.rows || [];
    const myTodayRow   = allRows.find(r => String(r.user_id) === String(userId));
    const qualifiedToday = !!(myTodayRow && (myTodayRow.qualified === true || myTodayRow.qualified === 'true'));

    // Q3 tile data (cached 2h); gracefully absent if REDASH_QUERY_3_ID not set
    let q3Row = null;
    try {
      const rows = await fetchOrCache('streak', 2 * 60 * 60 * 1000, process.env.REDASH_QUERY_3_ID);
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
      next_bonus_inr: 500
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
          await fetchOrCache('today', 10 * 60 * 1000, process.env.REDASH_QUERY_1_ID);
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

      // Q1: refresh every 10 minutes (live talktime)
      setInterval(async () => {
        try {
          cache.today = { rows: null, fetchedAt: null };
          await fetchOrCache('today', 10 * 60 * 1000, process.env.REDASH_QUERY_1_ID);
          await refreshPoolState();
        } catch (e) { console.error('Q1 scheduled refresh:', e.message); }
      }, 10 * 60 * 1000);

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
