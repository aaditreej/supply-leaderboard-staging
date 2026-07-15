-- Q1 (REDASH_QUERY_1_ID) — today's talktime for all Kannada listeners
-- Served to the app's /api/leaderboard/today via the server cache.
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

today_talktime AS (
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
    DATE(s.slot_start) = CURRENT_DATE('Asia/Kolkata')
    -- programme not live before the start date: returns zero rows until then
    AND CURRENT_DATE('Asia/Kolkata') >= (SELECT leaderboard_start_date FROM config)
    AND (s.talktime_audio > 0 OR s.talktime_video > 0)
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
  CASE WHEN talktime_secs >= 600 THEN true ELSE false END          AS qualified,
  -- global_rank only among qualified listeners
  CASE
    WHEN talktime_secs >= 600
    THEN ROW_NUMBER() OVER (
      ORDER BY
        CASE WHEN talktime_secs >= 600 THEN talktime_secs ELSE NULL END DESC,
        user_id ASC
    )
    ELSE NULL
  END                                                              AS global_rank,
  -- total qualified count for pool construction
  SUM(CASE WHEN talktime_secs >= 600 THEN 1 ELSE 0 END)
    OVER ()                                                        AS total_qualified,
  FORMAT_TIMESTAMP(
    '%d %b %Y, %H:%M IST',
    TIMESTAMP(CURRENT_DATETIME('Asia/Kolkata'))
  )                                                                AS last_refreshed_at
FROM today_talktime
ORDER BY talktime_secs DESC
