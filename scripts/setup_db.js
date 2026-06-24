require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { query } = require('../db');

async function setup() {
  await query(`
    CREATE TABLE IF NOT EXISTS session (
      sid   VARCHAR NOT NULL COLLATE "default",
      sess  JSON    NOT NULL,
      expire TIMESTAMP(6) NOT NULL,
      CONSTRAINT session_pkey PRIMARY KEY (sid)
    ) WITH (OIDS=FALSE);
  `);

  await query(`
    CREATE INDEX IF NOT EXISTS IDX_session_expire ON session (expire);
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS leaderboard_pool_state (
      user_id       INTEGER,
      date_ist      DATE,
      talktime_secs INTEGER,
      qualified     BOOLEAN,
      global_rank   INTEGER,
      target_rank   INTEGER DEFAULT 11,
      last_updated  TIMESTAMP,
      PRIMARY KEY (user_id, date_ist)
    );
  `);

  await query(`
    ALTER TABLE leaderboard_pool_state
      ADD COLUMN IF NOT EXISTS target_rank INTEGER DEFAULT 11;
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS listener_streak (
      user_id              INTEGER PRIMARY KEY,
      current_streak       INTEGER DEFAULT 0,
      last_qualifying_date DATE,
      total_bonuses_earned INTEGER DEFAULT 0,
      last_bonus_date      DATE,
      updated_at           TIMESTAMP
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS leaderboard_yesterday_results (
      user_id       INTEGER PRIMARY KEY,
      date_ist      DATE,
      talktime_secs INTEGER,
      display_rank  INTEGER,
      updated_at    TIMESTAMP
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS leaderboard_data_cache (
      query_key  TEXT PRIMARY KEY,
      rows_json  TEXT NOT NULL,
      fetched_at TIMESTAMP NOT NULL
    );
  `);

  console.log('All tables ready.');
  process.exit(0);
}

setup().catch(err => { console.error(err); process.exit(1); });
