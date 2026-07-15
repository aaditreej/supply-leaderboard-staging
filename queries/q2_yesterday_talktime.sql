-- Q2 (REDASH_QUERY_2_ID) — yesterday's talktime for all Kannada listeners
-- Fallback source for /api/leaderboard/yesterday when no midnight snapshot exists,
-- and the read-time verifier for top-3 finishes.
-- IMPORTANT: keep config.leaderboard_start_date in sync with the
-- LEADERBOARD_START_DATE env var on the server.

WITH

config AS (
  SELECT DATE '2026-07-16' AS leaderboard_start_date
),

kannada_experts AS (
  SELECT DISTINCT ei.user_id AS user_id
  FROM `dostt-c1d96.aggregate_tables.expert_info` ei
  WHERE LOWER(ei.locale) LIKE '%kannada%'
),

yesterday_talktime AS (
  SELECT
    e.user_id                                            AS user_id,
    e.id                                                 AS expert_id,
    u.mobile_no,
    SUM(s.talktime_audio + s.talktime_video)             AS talktime_secs,
    FLOOR(SUM(s.talktime_audio + s.talktime_video) / 60) AS talktime_mins,
    MOD(SUM(s.talktime_audio + s.talktime_video), 60)    AS talktime_remaining_secs
  FROM `dostt-c1d96.aggregate_tables.slot_active_experts_dump` s
  JOIN `dostt-c1d96.dostt_pg_datastream_us.public_experts_expert` e
    ON e.id = s.expert_id
  JOIN `dostt-c1d96.dostt_pg_datastream_us.public_users_user` u
    ON u.id = e.user_id
  JOIN kannada_experts ke
    ON ke.user_id = e.user_id
  WHERE
    DATE(s.slot_start) = DATE_SUB(CURRENT_DATE('Asia/Kolkata'), INTERVAL 1 DAY)
    -- "yesterday" only exists from the day AFTER launch: empty on/before start date
    AND DATE_SUB(CURRENT_DATE('Asia/Kolkata'), INTERVAL 1 DAY)
          >= (SELECT leaderboard_start_date FROM config)
  GROUP BY 1, 2, 3
)

SELECT
  user_id,
  expert_id,
  mobile_no,
  talktime_secs,
  talktime_mins,
  talktime_remaining_secs,
  CONCAT(
    CAST(talktime_mins AS STRING), 'm ',
    CAST(talktime_remaining_secs AS STRING), 's'
  )                                                                AS talktime_display,
  ROW_NUMBER() OVER (ORDER BY talktime_secs DESC, user_id ASC)     AS finish_rank
FROM yesterday_talktime
ORDER BY finish_rank
