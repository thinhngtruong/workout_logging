import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { decodeCursor, encodeCursor } from '../common/cursor';
import { DB, Db } from '../db/database';
import { ExerciseCatalog } from '../exercises/exercise-catalog';
import { UnitRegistry } from '../units/unit-registry';
import { HistoryQuery } from './workouts.schemas';

const EMPTY_MESSAGE = 'No workout entries match the given filters';

@Injectable()
export class HistoryService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly catalog: ExerciseCatalog,
    private readonly units: UnitRegistry,
  ) {}

  async list(userId: string, q: HistoryQuery) {
    const filters = { exercise: q.exercise ?? null, muscleGroup: q.muscleGroup ?? null, from: q.from ?? null, to: q.to ?? null };
    const after = q.cursor ? decodeCursor(q.cursor, filters) : undefined;
    const empty = { data: [], page: { limit: q.limit, nextCursor: null }, message: EMPTY_MESSAGE };

    const exerciseIds = await this.catalog.idsForFilter(userId, q);
    if (exerciseIds?.length === 0) return empty;

    let query = this.db
      .selectFrom('workout_entries')
      .select(['id', 'exercise_id', 'exercise_name', 'performed_on', 'performed_at', 'time_zone'])
      .where('user_id', '=', userId)
      .orderBy('performed_on', 'desc')
      .orderBy('id', 'desc')
      .limit(q.limit + 1);
    if (exerciseIds) query = query.where('exercise_id', 'in', exerciseIds);
    if (q.from) query = query.where('performed_on', '>=', q.from);
    if (q.to) query = query.where('performed_on', '<=', q.to);
    if (after) query = query.where(sql<boolean>`(performed_on, id) < (${after.performedOn}::date, ${after.id}::uuid)`);

    const rows = await query.execute();
    if (!rows.length) return empty;
    const page = rows.slice(0, q.limit);
    const last = page[page.length - 1];
    const nextCursor = rows.length > q.limit ? encodeCursor({ performedOn: last.performed_on, id: last.id }, filters) : null;

    const [sets, muscleGroups] = await Promise.all([
      this.db
        .selectFrom('workout_sets')
        .select(['entry_id', 'set_index', 'reps', 'weight_value', 'weight_unit', 'weight_kg'])
        .where('entry_id', 'in', page.map((r) => r.id))
        .orderBy('entry_id')
        .orderBy('set_index')
        .execute(),
      this.catalog.muscleGroupsOf([...new Set(page.map((r) => r.exercise_id))]),
    ]);
    const setsByEntry = Map.groupBy(sets, (s) => s.entry_id);

    return {
      data: page.map((r) => ({
        id: r.id,
        exerciseId: r.exercise_id,
        exerciseName: r.exercise_name,
        muscleGroups: muscleGroups.get(r.exercise_id) ?? [],
        date: r.performed_on,
        performedAt: r.performed_at?.toISOString() ?? null,
        timeZone: r.time_zone,
        sets: (setsByEntry.get(r.id) ?? []).map((s) => ({
          setIndex: s.set_index,
          reps: s.reps,
          ...this.units.display({ value: s.weight_value, unit: s.weight_unit, kg: s.weight_kg }, q.unit),
        })),
      })),
      page: { limit: q.limit, nextCursor },
    };
  }
}
