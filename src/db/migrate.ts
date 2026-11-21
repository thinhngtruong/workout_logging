import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load } from 'js-yaml';
import { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { loadConfig } from '../config/config';
import { normalizeExerciseName } from '../exercises/normalize';

const catalogSchema = z.object({
  exercises: z
    .array(
      z.object({
        name: z.string().min(1),
        primary: z.array(z.string().min(1)).default([]),
        secondary: z.array(z.string().min(1)).default([]),
      }),
    )
    .min(1),
});

/** Applies migrations/*.sql in name order, once each. The advisory lock lets several replicas start together. */
export async function runMigrations(client: PoolClient, dir = join(__dirname, '../../migrations')): Promise<string[]> {
  await client.query('SELECT pg_advisory_lock(727274)');
  try {
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const done = new Set((await client.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
    const applied: string[] = [];
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
      if (done.has(file)) continue;
      await client.query('BEGIN');
      try {
        await client.query(readFileSync(join(dir, file), 'utf8'));
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
      }
      applied.push(file);
    }
    return applied;
  } finally {
    await client.query('SELECT pg_advisory_unlock(727274)');
  }
}

/** Upserts the catalog from YAML and replaces each catalog exercise's muscle groups. Custom exercises are untouched. */
export async function seedCatalog(client: PoolClient, path: string): Promise<number> {
  const catalog = catalogSchema.parse(load(readFileSync(path, 'utf8')));
  await client.query('BEGIN');
  try {
    for (const ex of catalog.exercises) {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO exercises (owner_user_id, name, normalized_name) VALUES (NULL, $1, $2)
         ON CONFLICT (owner_user_id, normalized_name) DO UPDATE SET name = EXCLUDED.name
         RETURNING id`,
        [ex.name.trim(), normalizeExerciseName(ex.name)],
      );
      const id = rows[0].id;
      await client.query('DELETE FROM exercise_muscle_groups WHERE exercise_id = $1', [id]);
      const groups = [
        ...ex.primary.map((g) => [g.toLowerCase(), 'primary']),
        ...ex.secondary.filter((g) => !ex.primary.includes(g)).map((g) => [g.toLowerCase(), 'secondary']),
      ];
      for (const [group, role] of groups) {
        await client.query('INSERT INTO exercise_muscle_groups (exercise_id, muscle_group, role) VALUES ($1, $2, $3)', [id, group, role]);
      }
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
  return catalog.exercises.length;
}

if (require.main === module) {
  (async () => {
    const config = loadConfig();
    const pool = new Pool({ connectionString: config.DATABASE_URL });
    const client = await pool.connect();
    try {
      const applied = await runMigrations(client);
      const seeded = await seedCatalog(client, config.EXERCISES_CONFIG);
      console.log(JSON.stringify({ msg: 'migrate done', applied, catalogExercises: seeded }));
    } finally {
      client.release();
      await pool.end();
    }
  })().catch((err) => {
    console.error(JSON.stringify({ msg: 'migrate failed', error: err.message }));
    process.exit(1);
  });
}
