-- Benchmark data: two users with 50,000 entries x 4 sets each (200,000 set rows per user).
--   bench-spread: entries spread over every catalog exercise (a typical long-time client)
--   bench-single: every entry is Bench Press (worst case: 200,000 sets on one exercise)
-- Run: docker compose exec -T db psql -U workout -d workout < scripts/seed-bench.sql
BEGIN;
DELETE FROM workout_entries WHERE user_id IN ('bench-spread', 'bench-single');

CREATE TEMP TABLE cat AS
  SELECT id, name, row_number() OVER (ORDER BY name) - 1 AS n FROM exercises WHERE owner_user_id IS NULL;

INSERT INTO workout_entries (id, user_id, exercise_id, exercise_name, performed_on)
SELECT gen_random_uuid(), u.user_id, c.id, c.name, date '2026-11-20' - (g / 3)
FROM generate_series(0, 49999) g
CROSS JOIN (VALUES ('bench-spread'), ('bench-single')) u(user_id)
JOIN cat c ON c.n = CASE WHEN u.user_id = 'bench-single' THEN (SELECT n FROM cat WHERE name = 'Bench Press')
                         ELSE g % (SELECT count(*) FROM cat) END;

INSERT INTO workout_sets (entry_id, user_id, exercise_id, performed_on, set_index, reps, weight_value, weight_unit, weight_kg)
SELECT e.id, e.user_id, e.exercise_id, e.performed_on, s, r.reps, r.w, 'kg', r.w
FROM workout_entries e
CROSS JOIN generate_series(1, 4) s
CROSS JOIN LATERAL (SELECT 1 + floor(random() * 12)::int AS reps, round((20 + random() * 180)::numeric, 1) AS w) r
WHERE e.user_id IN ('bench-spread', 'bench-single');

COMMIT;
ANALYZE workout_entries;
ANALYZE workout_sets;
SELECT user_id, count(*) AS sets FROM workout_sets WHERE user_id LIKE 'bench-%' GROUP BY 1;
