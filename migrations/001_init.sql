CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Catalog (owner_user_id IS NULL) plus per-user custom exercises.
CREATE TABLE exercises (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id   text,
  name            text NOT NULL,
  normalized_name text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT exercises_owner_name_uq UNIQUE NULLS NOT DISTINCT (owner_user_id, normalized_name)
);
CREATE INDEX exercises_name_trgm ON exercises USING gin (normalized_name gin_trgm_ops);

CREATE TABLE exercise_muscle_groups (
  exercise_id  uuid NOT NULL REFERENCES exercises (id) ON DELETE CASCADE,
  muscle_group text NOT NULL,
  role         text NOT NULL CHECK (role IN ('primary', 'secondary')),
  PRIMARY KEY (exercise_id, muscle_group)
);
CREATE INDEX exercise_muscle_groups_group ON exercise_muscle_groups (muscle_group, exercise_id);

-- One row per exercise logged. id is uuid v7 (time-ordered), the keyset tie-breaker.
CREATE TABLE workout_entries (
  id            uuid PRIMARY KEY,
  user_id       text NOT NULL,
  exercise_id   uuid NOT NULL REFERENCES exercises (id),
  exercise_name text NOT NULL,
  performed_on  date NOT NULL,
  performed_at  timestamptz,
  time_zone     text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX workout_entries_history ON workout_entries (user_id, performed_on DESC, id DESC);
CREATE INDEX workout_entries_history_exercise ON workout_entries (user_id, exercise_id, performed_on DESC, id DESC);

-- One row per set. user_id, exercise_id, performed_on are copied from the entry so PR reads need no join.
CREATE TABLE workout_sets (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entry_id     uuid NOT NULL REFERENCES workout_entries (id) ON DELETE CASCADE,
  user_id      text NOT NULL,
  exercise_id  uuid NOT NULL,
  performed_on date NOT NULL,
  set_index    smallint NOT NULL,
  reps         integer NOT NULL CHECK (reps > 0),
  weight_value numeric(8, 2) NOT NULL CHECK (weight_value >= 0),
  weight_unit  text NOT NULL, -- checked by the UnitRegistry, no enum so a new unit needs no migration
  weight_kg    numeric(12, 5) NOT NULL CHECK (weight_kg >= 0),
  volume_kg    numeric GENERATED ALWAYS AS (reps * weight_kg) STORED,
  e1rm_kg      numeric GENERATED ALWAYS AS (weight_kg * (1 + reps::numeric / 30)) STORED
);
CREATE INDEX workout_sets_entry ON workout_sets (entry_id, set_index);
CREATE INDEX workout_sets_range ON workout_sets (user_id, exercise_id, performed_on)
  INCLUDE (reps, weight_kg, volume_kg, e1rm_kg);
CREATE INDEX workout_sets_pr_weight ON workout_sets (user_id, exercise_id, weight_kg DESC, reps DESC, performed_on, id) WHERE weight_kg > 0;
CREATE INDEX workout_sets_pr_volume ON workout_sets (user_id, exercise_id, volume_kg DESC, performed_on, id) WHERE weight_kg > 0;
CREATE INDEX workout_sets_pr_e1rm ON workout_sets (user_id, exercise_id, e1rm_kg DESC, performed_on, id) WHERE weight_kg > 0;

CREATE TABLE idempotency_keys (
  user_id         text NOT NULL,
  key             text NOT NULL,
  request_hash    text NOT NULL,
  response_status smallint,
  response_body   jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, key)
);
