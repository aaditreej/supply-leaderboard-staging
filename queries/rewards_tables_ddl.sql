-- ─────────────────────────────────────────────────────────────────────────────
-- One-time DDL for the leaderboard reward-tracking tables (manual crediting).
-- Run ONCE in BigQuery. NOT part of the scheduled queries.
-- The scheduled MERGE queries (podium_rewards_merge.sql / streak_rewards_merge.sql)
-- only ever INSERT missing (date_ist, user_id) rows — they never update existing
-- rows, so credited_flag / credited_at / credited_by / remarks are safe to edit
-- by hand.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS `dostt-c1d96.ref_tables.aaditree_leaderboard_podium_rewards` (
  date_ist      DATE      NOT NULL,  -- the leaderboard day being rewarded
  user_id       INT64     NOT NULL,
  expert_id     INT64,
  mobile_no     STRING,
  rank          INT64,               -- final global rank: 1, 2 or 3
  talktime_secs INT64,
  coins_due     INT64,               -- 1500 / 1000 / 500 by rank
  credited_flag BOOL,                -- set true manually once coins are credited
  credited_at   TIMESTAMP,           -- manual
  credited_by   STRING,              -- manual
  remarks       STRING               -- manual
);

CREATE TABLE IF NOT EXISTS `dostt-c1d96.ref_tables.aaditree_leaderboard_streak_rewards` (
  date_ist      DATE      NOT NULL,  -- the day the streak milestone was hit
  user_id       INT64     NOT NULL,
  expert_id     INT64,
  mobile_no     STRING,
  streak_count  INT64,               -- 7, 14, 21, ... as of date_ist
  coins_due     INT64,               -- always 100
  credited_flag BOOL,                -- set true manually once coins are credited
  credited_at   TIMESTAMP,           -- manual
  credited_by   STRING,              -- manual
  remarks       STRING               -- manual
);
