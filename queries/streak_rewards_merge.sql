-- Streak rewards (₹100 per completed 7-day cycle) — scheduled query (run daily,
-- any time after 00:05 IST). One row per listener whose consecutive-qualifying-day
-- streak, as of the PREVIOUS IST day, is a positive multiple of 7.
--
-- NOTE: unlike q3_streak_tiles.sql (which only looks back 7 days for the app's
-- tile display), this computes the TRUE streak over the full history since
-- leaderboard_start_date. A 7-day window would show "7" on every day of a longer
-- run and credit daily; the true streak fires exactly on days 7, 14, 21, ...
--
-- MERGE keyed on (date_ist, user_id): re-running never duplicates rows and never
-- touches rows that already exist, so manually set credited_flag / credited_at /
-- credited_by / remarks are preserved.
--
-- Keep config.leaderboard_start_date in sync with the app's LEADERBOARD_START_DATE.

MERGE `dostt-c1d96.ref_tables.aaditree_leaderboard_streak_rewards` T
USING (

  WITH

  config AS (
    SELECT DATE '2026-06-22' AS leaderboard_start_date
  ),

  target_day AS (
    SELECT DATE_SUB(CURRENT_DATE('Asia/Kolkata'), INTERVAL 1 DAY) AS date_ist
  ),

  kannada_experts AS (
    SELECT DISTINCT ei.user_id AS user_id
    FROM `dostt-c1d96.aggregate_tables.expert_info` ei
    WHERE LOWER(ei.locale) LIKE '%kannada%'
  ),

  -- every programme day from launch through the target day
  date_spine AS (
    SELECT day_ist
    FROM UNNEST(GENERATE_DATE_ARRAY(
      (SELECT leaderboard_start_date FROM config),
      (SELECT date_ist FROM target_day)
    )) AS day_ist
  ),

  daily_talktime AS (
    SELECT
      e.user_id                                AS user_id,
      DATE(s.slot_start)                       AS day_ist,
      SUM(s.talktime_audio + s.talktime_video) AS talktime_secs
    FROM `dostt-c1d96.aggregate_tables.slot_active_experts_dump` s
    JOIN `dostt-c1d96.dostt_pg_datastream_us.public_experts_expert` e
      ON e.id = s.expert_id
    JOIN kannada_experts ke
      ON ke.user_id = e.user_id
    WHERE
      DATE(s.slot_start) >= (SELECT leaderboard_start_date FROM config)
      AND DATE(s.slot_start) <= (SELECT date_ist FROM target_day)
    GROUP BY 1, 2
  ),

  -- explicit qualified/unqualified flag for every listener on every programme day
  daily_qualified AS (
    SELECT
      ke.user_id,
      ds.day_ist,
      COALESCE(dt.talktime_secs, 0) >= 600 AS qualified
    FROM kannada_experts ke
    CROSS JOIN date_spine ds
    LEFT JOIN daily_talktime dt
      ON dt.user_id = ke.user_id
      AND dt.day_ist = ds.day_ist
  ),

  -- most recent NON-qualifying day on or before the target day (per listener);
  -- the streak runs from the day after that through the target day
  last_miss AS (
    SELECT
      user_id,
      MAX(IF(NOT qualified, day_ist, NULL)) AS last_unqualified_day
    FROM daily_qualified
    GROUP BY user_id
  ),

  streaks AS (
    SELECT
      lm.user_id,
      DATE_DIFF(
        (SELECT date_ist FROM target_day),
        COALESCE(
          lm.last_unqualified_day,
          DATE_SUB((SELECT leaderboard_start_date FROM config), INTERVAL 1 DAY)
        ),
        DAY
      ) AS streak_count
    FROM last_miss lm
  )

  SELECT
    (SELECT date_ist FROM target_day) AS date_ist,
    st.user_id,
    e.id                              AS expert_id,
    u.mobile_no,
    st.streak_count,
    100                               AS coins_due
  FROM streaks st
  JOIN `dostt-c1d96.dostt_pg_datastream_us.public_experts_expert` e
    ON e.user_id = st.user_id
  JOIN `dostt-c1d96.dostt_pg_datastream_us.public_users_user` u
    ON u.id = st.user_id
  WHERE
    st.streak_count > 0
    AND MOD(st.streak_count, 7) = 0   -- milestone days only: 7, 14, 21, ...

) S
ON T.date_ist = S.date_ist AND T.user_id = S.user_id

WHEN NOT MATCHED THEN
  INSERT (date_ist, user_id, expert_id, mobile_no, streak_count,
          coins_due, credited_flag, credited_at, credited_by, remarks)
  VALUES (S.date_ist, S.user_id, S.expert_id, S.mobile_no, S.streak_count,
          S.coins_due, FALSE, NULL, NULL, NULL)
