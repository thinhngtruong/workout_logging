import { Generated, Kysely, PostgresDialect } from 'kysely';
import { Pool, types } from 'pg';
import { AppConfig } from '../config/config';

// Return DATE columns as 'YYYY-MM-DD' strings: a local calendar day must never pass through a JS Date.
types.setTypeParser(types.builtins.DATE, (v) => v);

export interface Database {
  exercises: {
    id: Generated<string>;
    owner_user_id: string | null;
    name: string;
    normalized_name: string;
    created_at: Generated<Date>;
  };
  exercise_muscle_groups: { exercise_id: string; muscle_group: string; role: 'primary' | 'secondary' };
  workout_entries: {
    id: string;
    user_id: string;
    exercise_id: string;
    exercise_name: string;
    performed_on: string;
    performed_at: Date | null;
    time_zone: string | null;
    created_at: Generated<Date>;
  };
  workout_sets: {
    id: Generated<string>;
    entry_id: string;
    user_id: string;
    exercise_id: string;
    performed_on: string;
    set_index: number;
    reps: number;
    weight_value: string; // numeric comes back as string: no float drift
    weight_unit: string;
    weight_kg: string;
    volume_kg: Generated<string>;
    e1rm_kg: Generated<string>;
  };
  idempotency_keys: {
    user_id: string;
    key: string;
    request_hash: string;
    response_status: number | null;
    response_body: unknown;
    created_at: Generated<Date>;
  };
}

export type Db = Kysely<Database>;
export const DB = Symbol('DB');

export function createPool(config: Pick<AppConfig, 'DATABASE_URL' | 'DB_POOL_MAX' | 'DB_STATEMENT_TIMEOUT_MS'>): Pool {
  return new Pool({
    connectionString: config.DATABASE_URL,
    max: config.DB_POOL_MAX,
    statement_timeout: config.DB_STATEMENT_TIMEOUT_MS,
  });
}

export function createDb(pool: Pool): Db {
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}
