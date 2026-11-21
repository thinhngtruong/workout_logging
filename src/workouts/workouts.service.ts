import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { sql } from 'kysely';
import { v7 as uuidv7 } from 'uuid';
import { ApiError } from '../common/errors';
import { DB, Db } from '../db/database';
import { ExerciseCatalog } from '../exercises/exercise-catalog';
import { normalizeExerciseName } from '../exercises/normalize';
import { idempotentReplays, setsLogged } from '../ops/metrics';
import { UnitRegistry } from '../units/unit-registry';
import { LogWorkoutsInput } from './workouts.schemas';

export interface WriteResult {
  status: number;
  body: unknown;
  replayed: boolean;
}

const IDEMPOTENCY_TTL = '24 hours';

@Injectable()
export class WorkoutsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly catalog: ExerciseCatalog,
    private readonly units: UnitRegistry,
  ) {}

  /**
   * Bulk log, all-or-nothing. One transaction: claim the idempotency key, insert entries and sets, store the response.
   * A concurrent retry with the same key blocks on the key's unique index until this commits, then replays.
   */
  async log(userId: string, input: LogWorkoutsInput, idempotencyKey?: string): Promise<WriteResult> {
    const requestHash = createHash('sha256').update(JSON.stringify(input)).digest('hex');

    return this.db.transaction().execute(async (trx) => {
      if (idempotencyKey) {
        // Insert, or take over a key older than the TTL. No row back = someone else owns a live key.
        const claimed = await trx
          .insertInto('idempotency_keys')
          .values({ user_id: userId, key: idempotencyKey, request_hash: requestHash })
          .onConflict((oc) =>
            oc
              .columns(['user_id', 'key'])
              .doUpdateSet({ request_hash: requestHash, response_status: null, response_body: null, created_at: sql`now()` })
              .where('idempotency_keys.created_at', '<', sql<Date>`now() - ${IDEMPOTENCY_TTL}::interval`),
          )
          .returning('user_id')
          .executeTakeFirst();

        if (!claimed) {
          const stored = await trx
            .selectFrom('idempotency_keys')
            .select(['request_hash', 'response_status', 'response_body'])
            .where('user_id', '=', userId)
            .where('key', '=', idempotencyKey)
            .executeTakeFirstOrThrow();
          if (stored.request_hash !== requestHash) {
            throw new ApiError(422, 'IDEMPOTENCY_KEY_REUSED', 'Idempotency-Key was already used with a different request body');
          }
          idempotentReplays.inc();
          return { status: stored.response_status ?? 201, body: stored.response_body, replayed: true };
        }
      }

      const exercises = await this.catalog.resolveForWrite(trx, userId, input.entries.map((e) => e.exerciseName));

      const entries = input.entries.map((e) => {
        const exercise = exercises.get(normalizeExerciseName(e.exerciseName))!;
        return {
          row: {
            id: uuidv7(),
            user_id: userId,
            exercise_id: exercise.id,
            exercise_name: exercise.name,
            performed_on: e.date.performedOn,
            performed_at: e.date.performedAt,
            time_zone: e.timeZone ?? null,
          },
          sets: e.sets.map((s, i) => ({ setIndex: i + 1, reps: s.reps, weight: s.weight, unit: s.unit, weightKg: this.units.toKg(s.weight, s.unit) })),
        };
      });

      await trx.insertInto('workout_entries').values(entries.map((e) => e.row)).execute();
      const setRows = entries.flatMap(({ row, sets }) =>
        sets.map((s) => ({
          entry_id: row.id,
          user_id: userId,
          exercise_id: row.exercise_id,
          performed_on: row.performed_on,
          set_index: s.setIndex,
          reps: s.reps,
          weight_value: String(s.weight),
          weight_unit: s.unit,
          weight_kg: s.weightKg,
        })),
      );
      await trx.insertInto('workout_sets').values(setRows).execute();

      const body = {
        data: entries.map(({ row, sets }) => ({
          id: row.id,
          exerciseId: row.exercise_id,
          exerciseName: row.exercise_name,
          date: row.performed_on,
          performedAt: row.performed_at?.toISOString() ?? null,
          timeZone: row.time_zone,
          sets: sets.map((s) => ({ setIndex: s.setIndex, reps: s.reps, weight: s.weight, unit: s.unit, weightKg: Number(s.weightKg) })),
        })),
      };

      if (idempotencyKey) {
        await trx
          .updateTable('idempotency_keys')
          .set({ response_status: 201, response_body: JSON.stringify(body) })
          .where('user_id', '=', userId)
          .where('key', '=', idempotencyKey)
          .execute();
      }
      setsLogged.inc(setRows.length);
      return { status: 201, body, replayed: false };
    });
  }
}
