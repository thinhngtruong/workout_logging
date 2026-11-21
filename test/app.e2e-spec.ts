import { INestApplication } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { join } from 'node:path';
import { Pool } from 'pg';
import request from 'supertest';
import { randomUUID } from 'node:crypto';

/**
 * Runs the real app against a real PostgreSQL 16 (Testcontainers). Each test uses its own userId,
 * so tests stay independent without truncating tables.
 */
describe('Workout Logging API (e2e)', () => {
  let container: StartedPostgreSqlContainer;
  let app: INestApplication;
  let pool: Pool;
  const http = () => request(app.getHttpServer());
  const newUser = () => `u-${randomUUID().slice(0, 8)}`;

  const set = (weight: number, reps: number, unit = 'kg') => ({ weight, reps, unit });
  const log = (userId: string, entries: unknown[], key?: string) => {
    const req = http().post(`/users/${userId}/workouts`);
    if (key) req.set('Idempotency-Key', key);
    return req.send({ entries });
  };

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    process.env.DATABASE_URL = container.getConnectionUri();
    process.env.LOG_LEVEL = 'silent';
    process.env.EXERCISES_CONFIG = join(__dirname, '../config/exercises.yaml');

    const { runMigrations, seedCatalog } = await import('../src/db/migrate');
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const client = await pool.connect();
    await runMigrations(client);
    await seedCatalog(client, process.env.EXERCISES_CONFIG);
    client.release();

    const { AppModule } = await import('../src/app.module');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
    await container?.stop();
  });

  describe('POST /users/:userId/workouts', () => {
    it('logs several exercises in one request, keeping the original unit and a normalized kg value', async () => {
      const user = newUser();
      const res = await log(user, [
        { exerciseName: 'bench  press', date: '2026-11-20', sets: [set(225, 5, 'lbs'), set(100, 3)] },
        { exerciseName: 'Back Squat', date: '2026-11-20T06:30:00+07:00', timeZone: 'Asia/Ho_Chi_Minh', sets: [set(140, 5)] },
      ]).expect(201);

      expect(res.body.data).toHaveLength(2);
      expect(res.body.data[0]).toMatchObject({
        exerciseName: 'Bench Press', // resolved to the catalog name
        date: '2026-11-20',
        sets: [
          { setIndex: 1, reps: 5, weight: 225, unit: 'lb', weightKg: 102.05828 },
          { setIndex: 2, reps: 3, weight: 100, unit: 'kg', weightKg: 100 },
        ],
      });
      expect(res.body.data[1]).toMatchObject({ date: '2026-11-20', performedAt: '2026-11-19T23:30:00.000Z', timeZone: 'Asia/Ho_Chi_Minh' });
    });

    it('reports every validation error with its path and writes nothing', async () => {
      const user = newUser();
      const res = await log(user, [
        { exerciseName: 'Bench Press', date: '2026-11-20', sets: [set(100, 5)] }, // valid, must not be written
        { exerciseName: 'Deadlift', date: null, sets: [set(-5, 0, 'stone')] },
        { exerciseName: '', date: '2026-11-20T10:00:00', sets: [] },
      ]).expect(400);

      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(res.body).toMatchObject({ status: 400, code: 'VALIDATION_ERROR', requestId: expect.any(String) });
      const errors = Object.fromEntries(res.body.errors.map((e: { path: string; code: string }) => [e.path, e.code]));
      expect(errors).toMatchObject({
        'entries[1].date': 'invalid_type',
        'entries[1].sets[0].weight': 'too_small',
        'entries[1].sets[0].reps': 'too_small',
        'entries[1].sets[0].unit': 'unsupported_unit',
        'entries[2].exerciseName': 'too_small',
        'entries[2].date': 'ambiguous_timestamp',
        'entries[2].sets': 'too_small',
      });
      expect(res.body.errors.find((e: { path: string }) => e.path === 'entries[1].sets[0].unit').message).toBe(
        "unit 'stone' is not supported; use one of: kg, lb",
      );

      const { rows } = await pool.query('SELECT count(*)::int AS n FROM workout_entries WHERE user_id = $1', [user]);
      expect(rows[0].n).toBe(0);
    });

    it.each([
      ['missing entries', {}],
      ['empty entries', { entries: [] }],
      ['unknown top-level field', { entries: [{ exerciseName: 'Dip', date: '2026-11-20', sets: [set(0, 10)] }], extra: 1 }],
    ])('rejects %s', async (_, body) => {
      const res = await http().post(`/users/${newUser()}/workouts`).send(body).expect(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
    });

    it('rejects malformed JSON with a structured error', async () => {
      const res = await http().post(`/users/${newUser()}/workouts`).set('Content-Type', 'application/json').send('{"entries": [').expect(400);
      expect(res.body).toMatchObject({ code: 'VALIDATION_ERROR', errors: [{ code: 'malformed_json' }] });
    });

    it('replays a retried request with the same Idempotency-Key, and rejects the key with a different body', async () => {
      const user = newUser();
      const entries = [{ exerciseName: 'Deadlift', date: '2026-11-20', sets: [set(180, 3)] }];
      const first = await log(user, entries, 'key-1').expect(201);
      const retry = await log(user, entries, 'key-1').expect(201);

      expect(retry.headers['idempotent-replayed']).toBe('true');
      expect(retry.body).toEqual(first.body);
      await log(user, [{ ...entries[0], sets: [set(200, 1)] }], 'key-1').expect(422).expect((r) => expect(r.body.code).toBe('IDEMPOTENCY_KEY_REUSED'));

      const { rows } = await pool.query('SELECT count(*)::int AS n FROM workout_entries WHERE user_id = $1', [user]);
      expect(rows[0].n).toBe(1);
    });

    it('writes exactly once when 20 requests race with one Idempotency-Key', async () => {
      const user = newUser();
      const entries = [{ exerciseName: 'Bench Press', date: '2026-11-20', sets: [set(100, 5)] }];
      const results = await Promise.all(Array.from({ length: 20 }, () => log(user, entries, 'race-key')));

      expect(results.every((r) => r.status === 201)).toBe(true);
      expect(results.filter((r) => r.headers['idempotent-replayed'] !== 'true')).toHaveLength(1);
      expect(new Set(results.map((r) => r.body.data[0].id)).size).toBe(1);
      const { rows } = await pool.query('SELECT count(*)::int AS n FROM workout_sets WHERE user_id = $1', [user]);
      expect(rows[0].n).toBe(1);
    });

    it('keeps every write when the same user logs the same exercise concurrently (no idempotency key)', async () => {
      const user = newUser();
      const results = await Promise.all(
        Array.from({ length: 10 }, (_, i) => log(user, [{ exerciseName: 'My Custom Press', date: '2026-11-20', sets: [set(50 + i, 5)] }])),
      );
      expect(results.every((r) => r.status === 201)).toBe(true);
      // the custom exercise was created once and shared
      expect(new Set(results.map((r) => r.body.data[0].exerciseId)).size).toBe(1);
      const { rows } = await pool.query('SELECT count(*)::int AS n FROM workout_sets WHERE user_id = $1', [user]);
      expect(rows[0].n).toBe(10);
    });
  });

  describe('GET /users/:userId/workouts', () => {
    it('pages through history newest first with a cursor, without duplicates while new entries arrive', async () => {
      const user = newUser();
      await log(
        user,
        Array.from({ length: 7 }, (_, i) => ({ exerciseName: 'Bench Press', date: `2026-11-0${i + 1}`, sets: [set(60 + i, 5)] })),
      ).expect(201);

      const page1 = await http().get(`/users/${user}/workouts?limit=3`).expect(200);
      expect(page1.body.data.map((e: { date: string }) => e.date)).toEqual(['2026-11-07', '2026-11-06', '2026-11-05']);

      // a newer entry lands between page requests; it must not shift later pages
      await log(user, [{ exerciseName: 'Bench Press', date: '2026-11-08', sets: [set(70, 5)] }]).expect(201);

      const page2 = await http().get(`/users/${user}/workouts?limit=3&cursor=${page1.body.page.nextCursor}`).expect(200);
      const page3 = await http().get(`/users/${user}/workouts?limit=3&cursor=${page2.body.page.nextCursor}`).expect(200);
      expect(page2.body.data.map((e: { date: string }) => e.date)).toEqual(['2026-11-04', '2026-11-03', '2026-11-02']);
      expect(page3.body.data.map((e: { date: string }) => e.date)).toEqual(['2026-11-01']);
      expect(page3.body.page.nextCursor).toBeNull();
    });

    it('filters by partial exercise name, muscle group and date range, and converts to the requested unit', async () => {
      const user = newUser();
      await log(user, [
        { exerciseName: 'Bench Press', date: '2026-10-01', sets: [set(225, 5, 'lb')] },
        { exerciseName: 'Incline Bench Press', date: '2026-10-02', sets: [set(60, 8)] },
        { exerciseName: 'Back Squat', date: '2026-10-03', sets: [set(100, 5)] },
        { exerciseName: 'Bench Press', date: '2026-11-01', sets: [set(100, 5)] },
      ]).expect(201);

      const byName = await http().get(`/users/${user}/workouts?exercise=BENCH&from=2026-10-01&to=2026-10-31&unit=kg`).expect(200);
      expect(byName.body.data.map((e: { exerciseName: string }) => e.exerciseName)).toEqual(['Incline Bench Press', 'Bench Press']);
      expect(byName.body.data[1].sets[0]).toEqual({ setIndex: 1, reps: 5, weight: 102.06, unit: 'kg' });

      const sameUnit = await http().get(`/users/${user}/workouts?exercise=bench&to=2026-10-01&unit=lb`).expect(200);
      expect(sameUnit.body.data[0].sets[0]).toEqual({ setIndex: 1, reps: 5, weight: 225, unit: 'lb' }); // no drift

      const quads = await http().get(`/users/${user}/workouts?muscleGroup=Quads`).expect(200);
      expect(quads.body.data).toHaveLength(1);
      expect(quads.body.data[0]).toMatchObject({ exerciseName: 'Back Squat', muscleGroups: expect.arrayContaining(['quads', 'glutes']) });
    });

    it('returns 200 with an empty list and a message when nothing matches', async () => {
      const user = newUser();
      await log(user, [{ exerciseName: 'Deadlift', date: '2026-11-01', sets: [set(100, 5)] }]).expect(201);
      for (const qs of ['from=2020-01-01&to=2020-12-31', 'exercise=zzz', 'muscleGroup=calves']) {
        const res = await http().get(`/users/${user}/workouts?${qs}`).expect(200);
        expect(res.body).toMatchObject({ data: [], page: { nextCursor: null }, message: expect.any(String) });
      }
    });

    it('rejects a cursor reused with different filters, and a reversed date range', async () => {
      const user = newUser();
      await log(user, [1, 2].map((d) => ({ exerciseName: 'Deadlift', date: `2026-11-0${d}`, sets: [set(100, 5)] }))).expect(201);
      const page1 = await http().get(`/users/${user}/workouts?limit=1`).expect(200);
      const res = await http().get(`/users/${user}/workouts?limit=1&exercise=dead&cursor=${page1.body.page.nextCursor}`).expect(400);
      expect(res.body.code).toBe('INVALID_CURSOR');

      const range = await http().get(`/users/${user}/workouts?from=2026-12-01&to=2026-11-01`).expect(400);
      expect(range.body.errors[0]).toMatchObject({ code: 'invalid_range' });
    });
  });

  describe('GET /users/:userId/personal-records', () => {
    it('returns heaviest set, highest-volume set and best Epley 1RM, each with its date', async () => {
      const user = newUser();
      await log(user, [
        { exerciseName: 'Back Squat', date: '2026-09-01', sets: [set(100, 10), set(140, 1)] },
        { exerciseName: 'Back Squat', date: '2026-09-08', sets: [set(130, 5)] },
        { exerciseName: 'Back Squat', date: '2026-09-15', sets: [set(0, 20)] }, // bodyweight: ignored
      ]).expect(201);

      const res = await http().get(`/users/${user}/personal-records?exercise=back squat`).expect(200);
      expect(res.body.exercise.name).toBe('Back Squat');
      expect(res.body.records).toEqual({
        maxWeight: { value: 140, weight: 140, reps: 1, unit: 'kg', date: '2026-09-01' },
        maxVolume: { value: 1000, weight: 100, reps: 10, unit: 'kg', date: '2026-09-01' },
        // 130 x (1 + 5/30) = 151.67 beats 100 x (1 + 10/30) = 133.33 and 140 x (1 + 1/30) = 144.67
        bestE1rm: { value: 151.67, weight: 130, reps: 5, unit: 'kg', date: '2026-09-08' },
      });
    });

    it('breaks ties by the earliest date and compares mixed units on one scale', async () => {
      const user = newUser();
      await log(user, [
        { exerciseName: 'Deadlift', date: '2026-08-02', sets: [set(100, 5)] },
        { exerciseName: 'Deadlift', date: '2026-08-01', sets: [set(100, 5)] },
        { exerciseName: 'Deadlift', date: '2026-08-03', sets: [set(220, 1, 'lb')] }, // 99.79 kg, lighter
      ]).expect(201);

      const res = await http().get(`/users/${user}/personal-records?exercise=Deadlift&unit=lb`).expect(200);
      expect(res.body.records.maxWeight).toEqual({ value: 220.46, weight: 220.46, reps: 5, unit: 'lb', date: '2026-08-01' });
    });

    it('limits PRs to a date range, and answers an empty range with nulls and a message', async () => {
      const user = newUser();
      await log(user, [
        { exerciseName: 'Bench Press', date: '2026-10-05', sets: [set(100, 5)] },
        { exerciseName: 'Bench Press', date: '2026-11-05', sets: [set(90, 5)] },
      ]).expect(201);

      const nov = await http().get(`/users/${user}/personal-records?exercise=Bench Press&from=2026-11-01&to=2026-11-30`).expect(200);
      expect(nov.body.records.maxWeight).toMatchObject({ value: 90, date: '2026-11-05' });

      const empty = await http().get(`/users/${user}/personal-records?exercise=Bench Press&from=2025-01-01&to=2025-01-31`).expect(200);
      expect(empty.body).toMatchObject({ records: { maxWeight: null, maxVolume: null, bestE1rm: null }, message: expect.any(String) });
    });

    it('has no weight PRs for an exercise logged only with bodyweight (0 kg) sets', async () => {
      const user = newUser();
      await log(user, [{ exerciseName: 'Dip', date: '2026-11-01', sets: [set(0, 15), set(0, 12)] }]).expect(201);
      const res = await http().get(`/users/${user}/personal-records?exercise=Dip`).expect(200);
      expect(res.body).toMatchObject({ records: { maxWeight: null, maxVolume: null, bestE1rm: null }, message: expect.any(String) });
    });

    it('returns 404 with close names for an unknown exercise', async () => {
      const res = await http().get(`/users/${newUser()}/personal-records?exercise=bench pres`).expect(404);
      expect(res.body.code).toBe('EXERCISE_NOT_FOUND');
      expect(res.body.suggestions).toContain('Bench Press');
    });

    it('compares two explicit ranges with a delta per metric', async () => {
      const user = newUser();
      await log(user, [
        { exerciseName: 'Bench Press', date: '2026-10-05', sets: [set(100, 5)] },
        { exerciseName: 'Bench Press', date: '2026-11-05', sets: [set(105, 5)] },
      ]).expect(201);

      const res = await http()
        .get(`/users/${user}/personal-records/compare?exercise=Bench Press&currentFrom=2026-11-01&currentTo=2026-11-30&previousFrom=2026-10-01&previousTo=2026-10-31`)
        .expect(200);
      expect(res.body.current.records.maxWeight.value).toBe(105);
      expect(res.body.previous.records.maxWeight.value).toBe(100);
      expect(res.body.delta).toEqual({ maxWeight: 5, maxVolume: 25, bestE1rm: 5.83 });
    });

    it('compares by period in the client time zone, with null deltas for an empty period', async () => {
      const user = newUser();
      await log(user, [{ exerciseName: 'Bench Press', date: '2020-01-01', sets: [set(100, 5)] }]).expect(201);
      const res = await http().get(`/users/${user}/personal-records/compare?exercise=Bench Press&period=month&timeZone=Asia/Ho_Chi_Minh`).expect(200);
      expect(res.body).toMatchObject({ period: 'month', delta: { maxWeight: null, maxVolume: null, bestE1rm: null }, message: expect.any(String) });
      expect(res.body.current.range.from).toMatch(/^\d{4}-\d{2}-01$/);
    });

    it('rejects a compare request mixing period and explicit ranges', async () => {
      const res = await http().get(`/users/${newUser()}/personal-records/compare?exercise=Bench Press&period=week&currentFrom=2026-11-01`).expect(400);
      expect(res.body.errors[0]).toMatchObject({ code: 'invalid_range' });
    });
  });

  describe('performance at depth', () => {
    const heavy = 'heavy-user';

    beforeAll(async () => {
      // 50,000 Bench Press entries x 4 sets = 200,000 sets on ONE exercise: the design's worst case.
      // The last two months are light (a comeback after injury), so every PR in those ranges sits at the
      // BOTTOM of the per-metric indexes: walking them filtered by date would read almost all 200k rows.
      await pool.query(`
        WITH ex AS (SELECT id FROM exercises WHERE owner_user_id IS NULL AND normalized_name = 'bench press'),
        e AS (
          INSERT INTO workout_entries (id, user_id, exercise_id, exercise_name, performed_on)
          SELECT gen_random_uuid(), $1, ex.id, 'Bench Press', date '2026-11-20' - (g / 3)
          FROM generate_series(0, 49999) g, ex
          RETURNING id, exercise_id, performed_on),
        s AS (
          SELECT e.*, s AS set_index, 1 + (s * 3) AS reps,
                 CASE WHEN e.performed_on >= date '2026-10-01' THEN 20 ELSE 40 + (hashtext(e.id::text || s) & 127) END AS w
          FROM e, generate_series(1, 4) s)
        INSERT INTO workout_sets (entry_id, user_id, exercise_id, performed_on, set_index, reps, weight_value, weight_unit, weight_kg)
        SELECT id, $1, exercise_id, performed_on, set_index, reps, w, 'kg', w FROM s`, [heavy]);
      await pool.query('ANALYZE workout_entries; ANALYZE workout_sets');
    });

    const medianMs = async (url: string, runs = 7) => {
      await http().get(url).expect(200); // warm-up
      const times: number[] = [];
      for (let i = 0; i < runs; i++) {
        const t = performance.now();
        await http().get(url).expect(200);
        times.push(performance.now() - t);
      }
      return times.sort((a, b) => a - b)[Math.floor(runs / 2)];
    };

    // Regression: the planner walked the per-metric index filtering by date (~100+ ms) instead of the range index (~2 ms)
    it('compares one month vs the previous on 200,000 sets in well under 40 ms', async () => {
      const url = `/users/${heavy}/personal-records/compare?exercise=Bench Press&currentFrom=2026-11-01&currentTo=2026-11-30&previousFrom=2026-10-01&previousTo=2026-10-31`;
      expect(await medianMs(url)).toBeLessThan(40);
    });

    it('reads all-time PRs and a deep history page in well under 40 ms', async () => {
      expect(await medianMs(`/users/${heavy}/personal-records?exercise=Bench Press`)).toBeLessThan(40);
      const page1 = await http().get(`/users/${heavy}/workouts?limit=20&from=2016-01-01`).expect(200);
      expect(await medianMs(`/users/${heavy}/workouts?limit=20&from=2016-01-01&cursor=${page1.body.page.nextCursor}`)).toBeLessThan(40);
    });
  });

  describe('operations', () => {
    it('serves health, metrics and a request id', async () => {
      await http().get('/health').expect(200, { status: 'ok' });
      const metrics = await http().get('/metrics').expect(200);
      expect(metrics.text).toContain('http_request_duration_seconds');
      const res = await http().get('/nope').set('X-Request-Id', 'abc-123').expect(404);
      expect(res.body).toMatchObject({ code: 'NOT_FOUND', requestId: 'abc-123' });
    });
  });
});
