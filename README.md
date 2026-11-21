# Workout Logging API

An API that lets coaches track their clients' lifts: log sets in kg or lb, browse workout history, and get personal records (PRs). Built with NestJS 11 (TypeScript), PostgreSQL 16 and Kysely.

Also in this repo:

- [`AI_WORKFLOW.md`](AI_WORKFLOW.md): how AI tools were used, and where they were wrong.
- [`ESTIMATE.md`](ESTIMATE.md): the time estimate next to the actual time spent.
- The system design doc: [Claude Docs](https://claude.ai/artifact/Sv5FXFkDRrr7cPFWx52p7z).

## Quick start

```bash
docker compose up --build        # PostgreSQL + API on http://localhost:3000; runs migrations and seeds the catalog first
curl localhost:3000/health       # {"status":"ok"}
```

Local development (Node 22, see `.nvmrc`):

```bash
docker compose up -d db
cp .env.example .env && export $(cat .env | xargs)
npm ci && npm run start:dev      # build, migrate + seed, start
npm test                         # unit + e2e (e2e needs Docker: Testcontainers starts PostgreSQL 16)
```

Try it:

```bash
curl -X POST localhost:3000/users/client-42/workouts \
  -H 'Content-Type: application/json' -H 'Idempotency-Key: 7f1c2a' \
  -d '{"entries":[{"exerciseName":"Bench Press","date":"2026-11-20","sets":[{"reps":5,"weight":225,"unit":"lb"},{"reps":3,"weight":105,"unit":"kg"}]}]}'

curl 'localhost:3000/users/client-42/workouts?exercise=bench&unit=kg&limit=20'
curl 'localhost:3000/users/client-42/personal-records?exercise=Bench%20Press&unit=lb'
curl 'localhost:3000/users/client-42/personal-records/compare?exercise=Bench%20Press&period=month&timeZone=Asia/Ho_Chi_Minh'
```

## Architecture

```
            ┌──────────────────────── NestJS (stateless, scale out) ───────────────────────┐
 client ──▶ │ pino request log (request id) → ZodValidationPipe → controller               │
  REST      │                                                                               │
            │  WorkoutsController ─▶ WorkoutsService  (validate → normalize → 1 transaction)│
            │                     └▶ HistoryService   (filters → exercise ids → keyset)     │
            │  RecordsController  ─▶ RecordsService   (1 statement, LIMIT 1 per metric)     │
            │                                                                               │
            │  UnitRegistry (kg, lb, …)   ExerciseCatalog (name → id, muscle groups)       │
            │  ProblemDetailsFilter (RFC 9457)   /health   /metrics (Prometheus)            │
            └───────────────────────────────────────┬───────────────────────────────────────┘
                                                    │ Kysely + pg pool (statement_timeout 2s)
 config/exercises.yaml ──(npm run migrate: upsert)──▶ PostgreSQL 16
```

| Path | Responsibility |
|---|---|
| `src/units/unit-registry.ts` | The only list of weight units: code, aliases, exact kg factor (decimal.js). |
| `src/exercises/exercise-catalog.ts` | Resolves names to exercises (catalog first, then the user's own); partial match; muscle groups. |
| `src/workouts/workouts.service.ts` | Bulk write: claims the idempotency key, inserts entries and sets, stores the response. All in one transaction. |
| `src/workouts/history.service.ts` | Turns filters into exercise ids, runs a keyset page, converts units. |
| `src/records/records.service.ts` | PRs and comparisons: one SQL statement for every metric and range. |
| `src/common/` | Dates and time zones, opaque cursors, validation pipe, error filter. |
| `src/db/migrate.ts` | Applies `migrations/*.sql` (with an advisory lock, safe for parallel replicas) and seeds the catalog. |

## API

`userId` is a path parameter (1–64 characters: `A-Z a-z 0-9 . _ : -`). There is no authentication.

### `POST /users/:userId/workouts`: log workouts (bulk)

| | |
|---|---|
| Header `Idempotency-Key` | Optional. A retry with the same key returns the stored response with `Idempotent-Replayed: true`. The same key with a different body returns `422`. Keys last 24 hours. |
| Body | `{ "entries": [ { "exerciseName", "date", "timeZone"?, "sets": [ { "reps", "weight", "unit" } ] } ] }` |
| Limits | 1–50 entries, 1–20 sets per entry, reps 1–1000, weight 0–10000 with at most 2 decimals (0 = bodyweight). |
| `date` | `YYYY-MM-DD` (the client's local day), or an ISO timestamp **with** an offset (`2026-11-20T06:30:00+07:00`). A timestamp without an offset is rejected as ambiguous. |
| `unit` | `kg` or `lb`, case-insensitive, aliases `kgs`, `kilogram(s)`, `lbs`, `pound(s)`. |
| `201` | `{ "data": [ { id, exerciseId, exerciseName, date, performedAt, timeZone, sets: [ { setIndex, reps, weight, unit, weightKg } ] } ] }` |

The request is all-or-nothing: every entry is validated before anything is written, and the response lists every error with its path. An unknown exercise name becomes a custom exercise for that user, with no muscle groups.

### `GET /users/:userId/workouts`: history

| Query | |
|---|---|
| `exercise` | Partial, case-insensitive name match (`bench` matches Bench Press and Incline Bench Press). |
| `muscleGroup` | For example `chest` or `quads`, from `config/exercises.yaml`. |
| `from`, `to` | Inclusive local days, `YYYY-MM-DD`. |
| `unit` | Converts weights to this unit. Without it, each set comes back as logged. |
| `limit`, `cursor` | Page size 1–100 (default 20). `cursor` is `page.nextCursor` from the previous page. |

`200 { "data": [ { id, exerciseId, exerciseName, muscleGroups, date, performedAt, timeZone, sets } ], "page": { "limit", "nextCursor" } }`. Newest first. When nothing matches, `data` is `[]` and the response adds a `message`. That is not an error.

### `GET /users/:userId/personal-records?exercise=…`: personal records

`exercise` must name exactly one exercise. A PR that mixed Bench Press with Incline Bench Press would be wrong. Optional: `from`, `to`, `unit` (default `kg`).

```json
{ "exercise": { "id": "…", "name": "Back Squat" }, "unit": "kg", "range": { "from": null, "to": null },
  "records": {
    "maxWeight": { "value": 140,    "weight": 140, "reps": 1,  "unit": "kg", "date": "2026-09-01" },
    "maxVolume": { "value": 1000,   "weight": 100, "reps": 10, "unit": "kg", "date": "2026-09-01" },
    "bestE1rm":  { "value": 151.67, "weight": 130, "reps": 5,  "unit": "kg", "date": "2026-09-08" } } }
```

- Volume is reps × weight. The estimated 1RM uses Epley: weight × (1 + reps/30).
- On a tie, the earliest date wins, because a PR counts from the first time it was achieved.
- Bodyweight sets (0 kg) are excluded.
- With no data, each record is `null` and the response adds a `message`.

### `GET /users/:userId/personal-records/compare`: this period vs the last

Pass `exercise` and `unit`, plus **either**:

- `period=month|week` with `timeZone` (IANA, default `UTC`). "Current" runs from the start of the period to today in that zone, and "previous" is the whole prior period. Weeks start on Monday.
- **or** all four of `currentFrom`, `currentTo`, `previousFrom` and `previousTo`.

Returns `current` and `previous` (`{ range, records }`) and `delta` (current minus previous for each metric). A delta is `null` when either side has no data.

### Errors (RFC 9457 problem details, `application/problem+json`)

```json
{ "status": 400, "code": "VALIDATION_ERROR", "title": "Request validation failed",
  "errors": [ { "path": "entries[1].sets[0].unit", "code": "unsupported_unit",
                "message": "unit 'stone' is not supported; use one of: kg, lb" } ],
  "requestId": "01a1fc3f-d069-770a-afb3-e96353857ce0" }
```

| Status | `code` | When |
|---|---|---|
| 400 | `VALIDATION_ERROR` | A body, query, header or path value is invalid, or the JSON is malformed. `errors[]` holds every failure. |
| 400 | `INVALID_CURSOR` | The cursor is malformed, or was issued for different filters. |
| 404 | `EXERCISE_NOT_FOUND` | No such exercise for PRs. `suggestions[]` lists close names. |
| 404 | `NOT_FOUND` | Unknown route. |
| 413 | `PAYLOAD_TOO_LARGE` | The body is over 256 KB. |
| 422 | `IDEMPOTENCY_KEY_REUSED` | The same key was sent with a different body. |
| 503 | `SERVICE_UNAVAILABLE` | The database is unreachable or overloaded, or a query hit the 2 s timeout. Safe to retry. |
| 500 | `INTERNAL_ERROR` | A bug. Details are only in the logs, findable by `requestId`. |

Every response carries an `X-Request-Id` header. If the client sends its own `X-Request-Id`, the API reuses it.

### Operations

`GET /health` checks the database and returns 200 or 503. `GET /metrics` serves Prometheus metrics: request latency by route and status, sets logged, idempotent replays, and Node process metrics. Each request writes one JSON log line with request id, userId, route, status and duration.

## Database

PostgreSQL rather than MongoDB, because:

- The data is relational: user → entry → set, and exercise → muscle groups.
- A PR is "the max, plus the row it came from": an ordered index read.
- `numeric` is exact, so kg conversion doesn't drift. Generated columns and transactional bulk inserts do the rest.

| Table | Purpose |
|---|---|
| `exercises` | The catalog (`owner_user_id IS NULL`) plus custom exercises per user. Unique on `(owner_user_id, normalized_name)` with `NULLS NOT DISTINCT`. Trigram GIN index for partial names. |
| `exercise_muscle_groups` | `(exercise_id, muscle_group, role)`, seeded from `config/exercises.yaml`. Editing the YAML and re-running migrate changes the mapping. |
| `workout_entries` | One row per exercise logged. `id` is a uuid v7 (time-ordered), used as the paging tie-breaker. `performed_on` is the local day. |
| `workout_sets` | One row per set: `weight_value` and `weight_unit` as logged, `weight_kg` (5 decimals), and generated `volume_kg` and `e1rm_kg`. `user_id`, `exercise_id` and `performed_on` are copied from the entry, so PR queries need no join. |
| `idempotency_keys` | `(user_id, key)` with request hash and stored response, kept 24 hours. |

**Normalization.** The original value and unit are stored as sent, and `weight_kg` is computed once at write time. PRs compare `weight_kg`, `volume_kg` and `e1rm_kg` only, never a converted value. Reading back in the original unit returns the exact logged number. Reading in another unit converts from kg and rounds to 2 decimals. There is no unit enum in the database, so a new unit needs no migration.

**Indexes and the query each one serves**

| Index | Query |
|---|---|
| `workout_entries (user_id, performed_on DESC, id DESC)` | History pages: a keyset read of about 20 index entries at any depth |
| `workout_entries (user_id, exercise_id, performed_on DESC, id DESC)` | History filtered by exercise or muscle group |
| `workout_sets (entry_id, set_index)` | Loading the sets for one page |
| `workout_sets (user_id, exercise_id, performed_on) INCLUDE (reps, weight_kg, volume_kg, e1rm_kg)` | PRs within a date range |
| `workout_sets (user_id, exercise_id, <metric> DESC, …) WHERE weight_kg > 0`, one per metric | All-time PRs: `LIMIT 1` reads one row |
| `exercises GIN (normalized_name gin_trgm_ops)` | Partial name match, and suggestions for a 404 |

**One planner trap, found by benchmark.** A ranged PR query written as `WHERE … AND performed_on BETWEEN … ORDER BY e1rm_kg DESC LIMIT 1` can lead PostgreSQL to walk the per-metric index and filter out every row that falls outside the dates. That is fast when the range holds a heavy lift, but takes about 100 ms on 200k sets when it doesn't, for example a client coming back from injury and comparing this month with last month. Ranged reads therefore scan the range once into a `MATERIALIZED` CTE and pick the three winners from it, which takes about 2 ms. A regression test in `test/app.e2e-spec.ts` ("performance at depth") reproduces this case.

## Time zones

`performed_on` is the client's **local calendar day** and drives every filter and PR range. Instants (`performed_at`, `created_at`) are stored in UTC.

Why not store only UTC and bucket by day at read time?

- Every query would need the user's zone, and `(performed_at AT TIME ZONE tz)::date` can't use a plain index.
- A 06:00 session in Ho Chi Minh City would land on the previous UTC day, so "Monday's workout" would show up on Sunday.

The trade-off is that a travelling client's days follow whichever zone they logged from. A timestamp without an offset is rejected rather than guessed. Period comparisons (`period=month`) compute "today" in the `timeZone` you send.

## Concurrency and idempotency

- **Writes only append.** Entries and sets are only inserted, and PRs are computed when read. No write updates a shared row, so two concurrent requests for the same user and exercise both succeed. Tested with 10 parallel requests.
- **Retries.** The key is claimed inside the write transaction (`INSERT … ON CONFLICT`). A concurrent retry blocks on the unique index until the first request commits, then returns the stored response. If the first request rolled back, the retry runs normally. Tested with 20 parallel requests sharing one key: exactly one write.
- **Custom exercises.** `ON CONFLICT DO NOTHING`, then read back, so two requests creating the same new name end up with one id.

## Extending

- **A new unit** is one line in `WEIGHT_UNITS`, for example `{ code: 'st', aliases: ['stone'], kgPerUnit: '6.35029318' }`. Validation messages, conversion and storage all pick it up. A unit test proves this with a fake stone unit.
- **Muscle groups** are edited in `config/exercises.yaml` and applied with `npm run migrate` (it also runs on every container start). No code changes.

## Testing

The project is built test-first; see `CLAUDE.md` for the working rules.

- **Unit (`src/**/*.spec.ts`):** unit conversion and round-trips, a fake unit added through config, dates and time zones, ISO weeks, month rollover, cursors.
- **E2E (`test/`, real PostgreSQL 16 via Testcontainers):**
  - validation paths, plus bulk atomicity (nothing written when one entry is invalid);
  - idempotent replay, key reuse, a 20-way race on one key;
  - concurrent writes;
  - keyset paging while new entries arrive;
  - filters, unit conversion, empty results;
  - PR metrics, tie-breaks, bodyweight, ranges, compare, a 404 with suggestions;
  - a 200k-set performance regression.
- **Mutation check (`npm run test:mutants`):** breaks 13 key behaviors one at a time (Epley divisor, tie-break order, keyset `<` vs `<=`, idempotency, cursor binding, time zone, the planner fix, …) and fails if any change survives the tests.

## Benchmarks

Seed two users with 50,000 entries × 4 sets each, then run k6 against `docker compose` on a 4-CPU Docker Desktop (one API container, one Node process):

```bash
docker compose exec -T db psql -U workout -d workout < scripts/seed-bench.sql
k6 run -e SCENARIO=history scripts/bench.js     # also: allTimePr, comparePr, bulkLog
```

Three runs of 30 s per scenario, on 2026-11-21:

| Scenario (constant arrival rate) | Rate | Median (3 runs) | p99 (runs 2–3) | Target | Met |
|---|---|---|---|---|---|
| History, pages 1 and ~500, converted to lb | 200/s | 3.5–4.4 ms | 55–246 ms | p99 < 200 ms | 2 of 3 runs |
| All-time PRs, 200k sets on one exercise | 100/s | 3.9–4.4 ms | 13–286 ms | p99 < 50 ms | 1 of 3 runs |
| Month-vs-month compare | 100/s | 4.8–5.2 ms | 155–203 ms | p99 < 100 ms | 1 of 3 runs |
| Bulk log, 50 exercises × 5 sets | 50/s | 22–23 ms | 296–1,040 ms | p99 < 300 ms | 1 of 3 runs |

The database is not the bottleneck: in SQL the all-time PR query takes 0.4 ms (three one-row index reads), a ranged compare 1.5 ms and a deep history page 0.4 ms.

The tail comes from the host. One Node process shares a busy 4-CPU laptop, and the load average reached 18 during run 3. Running all four scenarios together (450 req/s) pushes p95 to about 480 ms. Count the p99 targets as met only after a rerun on dedicated hardware with two or more API replicas (the API is stateless).

## Trade-offs and what changes at scale

- **Expired idempotency keys** are only replaced when the same key comes back. At scale, a scheduled `DELETE … WHERE created_at < now() - '24 hours'`, or daily partitions that get dropped, would keep the table small.
- **The catalog is not cached in memory.** Name resolution is one indexed query per request over a small table. If profiling shows it matters, add a cache with invalidation when the YAML is seeded.
- **Fleet scale.** Every query starts with `user_id`, so at around 150M entries `workout_sets` can be hash-partitioned by `user_id`, or the data sharded by user (Citus), with no query changes. Coach dashboards can read from a replica.
- **PRs are computed on read.** That stays correct for any date range and has no counters to race on. If PR reads ever dominate, a `user_exercise_prs` table updated in the write transaction would make the all-time view O(1). The cost is updating a shared row under concurrency.
- **Offset pagination was rejected.** Page 2,000 would read and throw away 40,000 rows. Keyset paging costs the same at any depth and stays stable while new entries arrive.
- **Out of scope:** authentication and coach/client permissions, editing or deleting entries, an admin API for the catalog, and cardio or time-based metrics.
