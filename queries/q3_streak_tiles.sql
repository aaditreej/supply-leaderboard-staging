-- Q3 (REDASH_QUERY_3_ID) — 7-day streak tiles per Kannada listener
-- day_1 = 6 days ago ... day_7 = today. Consumed by /api/leaderboard/streak
-- (the server recomputes current_streak itself; day_N booleans are the source).
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

date_spine AS (
  SELECT
    DATE_SUB(CURRENT_DATE('Asia/Kolkata'), INTERVAL n DAY) AS day_ist,
    n                                                       AS days_ago
  FROM UNNEST(GENERATE_ARRAY(0, 6)) AS n
),

daily_talktime AS (
  SELECT
    e.user_id                                      AS user_id,
    DATE(s.slot_start)                             AS day_ist,
    SUM(s.talktime_audio + s.talktime_video)       AS talktime_secs
  FROM `dostt-c1d96.aggregate_tables.slot_active_experts_dump` s
  JOIN `dostt-c1d96.dostt_pg_datastream_us.public_experts_expert` e
    ON e.id = s.expert_id
  JOIN kannada_experts ke
    ON ke.user_id = e.user_id
  WHERE
    DATE(s.slot_start) >= DATE_SUB(CURRENT_DATE('Asia/Kolkata'), INTERVAL 6 DAY)
    AND DATE(s.slot_start) <= CURRENT_DATE('Asia/Kolkata')
    -- talktime before launch never counts toward a streak
    AND DATE(s.slot_start) >= (SELECT leaderboard_start_date FROM config)
  GROUP BY 1, 2
),

daily_qualified AS (
  SELECT
    ke.user_id,
    ds.day_ist,
    ds.days_ago,
    CASE
      -- days before the programme started are never "qualified"
      WHEN ds.day_ist < (SELECT leaderboard_start_date FROM config) THEN false
      WHEN COALESCE(dt.talktime_secs, 0) >= 600 THEN true
      ELSE false
    END AS qualified
  FROM kannada_experts ke
  CROSS JOIN date_spine ds
  LEFT JOIN daily_talktime dt
    ON dt.user_id = ke.user_id
    AND dt.day_ist = ds.day_ist
),

streak_calc AS (
  SELECT
    dq.user_id,
    MAX(CASE WHEN days_ago = 6 THEN qualified END) AS day_1,
    MAX(CASE WHEN days_ago = 5 THEN qualified END) AS day_2,
    MAX(CASE WHEN days_ago = 4 THEN qualified END) AS day_3,
    MAX(CASE WHEN days_ago = 3 THEN qualified END) AS day_4,
    MAX(CASE WHEN days_ago = 2 THEN qualified END) AS day_5,
    MAX(CASE WHEN days_ago = 1 THEN qualified END) AS day_6,
    MAX(CASE WHEN days_ago = 0 THEN qualified END) AS day_7
  FROM daily_qualified dq
  GROUP BY 1
)

SELECT
  sc.user_id,
  e.id                                                              AS expert_id,
  u.mobile_no,
  sc.day_1, sc.day_2, sc.day_3, sc.day_4,
  sc.day_5, sc.day_6, sc.day_7,
  CASE
    WHEN NOT sc.day_7 THEN 0
    WHEN NOT sc.day_6 THEN 1
    WHEN NOT sc.day_5 THEN 2
    WHEN NOT sc.day_4 THEN 3
    WHEN NOT sc.day_3 THEN 4
    WHEN NOT sc.day_2 THEN 5
    WHEN NOT sc.day_1 THEN 6
    ELSE 7
  END                                                               AS current_streak,
  CASE
    WHEN NOT sc.day_7 THEN 7
    WHEN NOT sc.day_6 THEN 6
    WHEN NOT sc.day_5 THEN 5
    WHEN NOT sc.day_4 THEN 4
    WHEN NOT sc.day_3 THEN 3
    WHEN NOT sc.day_2 THEN 2
    WHEN NOT sc.day_1 THEN 1
    ELSE 0
  END                                                               AS days_to_bonus,
  100                                                               AS next_bonus_inr
FROM streak_calc sc
JOIN `dostt-c1d96.dostt_pg_datastream_us.public_experts_expert` e
  ON e.user_id = sc.user_id
JOIN `dostt-c1d96.dostt_pg_datastream_us.public_users_user` u
  ON u.id = sc.user_id
ORDER BY sc.user_id
