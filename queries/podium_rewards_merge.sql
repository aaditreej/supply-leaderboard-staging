-- Podium rewards for the PREVIOUS IST day — scheduled query (run daily, any time
-- after 00:05 IST). One row per listener who finished global rank 1/2/3 among
-- qualified (>= 600s) Kannada listeners. coins_due = 1500/1000/500 by rank.
--
-- MERGE keyed on (date_ist, user_id): re-running never duplicates rows and never
-- touches rows that already exist, so manually set credited_flag / credited_at /
-- credited_by / remarks are preserved.
--
-- Keep config.leaderboard_start_date in sync with the app's LEADERBOARD_START_DATE.

MERGE `dostt-c1d96.ref_tables.aaditree_leaderboard_podium_rewards` T
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

  day_talktime AS (
    SELECT
      e.user_id                                AS user_id,
      e.id                                     AS expert_id,
      u.mobile_no,
      SUM(s.talktime_audio + s.talktime_video) AS talktime_secs
    FROM `dostt-c1d96.aggregate_tables.slot_active_experts_dump` s
    JOIN `dostt-c1d96.dostt_pg_datastream_us.public_experts_expert` e
      ON e.id = s.expert_id
    JOIN `dostt-c1d96.dostt_pg_datastream_us.public_users_user` u
      ON u.id = e.user_id
    JOIN kannada_experts ke
      ON ke.user_id = e.user_id
    WHERE
      DATE(s.slot_start) = (SELECT date_ist FROM target_day)
      -- no rewards for days before the programme started
      AND (SELECT date_ist FROM target_day)
            >= (SELECT leaderboard_start_date FROM config)
    GROUP BY 1, 2, 3
  ),

  ranked AS (
    SELECT
      user_id,
      expert_id,
      mobile_no,
      talktime_secs,
      ROW_NUMBER() OVER (ORDER BY talktime_secs DESC, user_id ASC) AS rank
    FROM day_talktime
    WHERE talktime_secs >= 600  -- podium only among qualified listeners
  )

  SELECT
    (SELECT date_ist FROM target_day) AS date_ist,
    user_id,
    expert_id,
    mobile_no,
    rank,
    talktime_secs,
    CASE rank
      WHEN 1 THEN 1500
      WHEN 2 THEN 1000
      WHEN 3 THEN 500
    END                               AS coins_due
  FROM ranked
  WHERE rank <= 3

) S
ON T.date_ist = S.date_ist AND T.user_id = S.user_id

WHEN NOT MATCHED THEN
  INSERT (date_ist, user_id, expert_id, mobile_no, rank, talktime_secs,
          coins_due, credited_flag, credited_at, credited_by, remarks)
  VALUES (S.date_ist, S.user_id, S.expert_id, S.mobile_no, S.rank, S.talktime_secs,
          S.coins_due, FALSE, NULL, NULL, NULL)
