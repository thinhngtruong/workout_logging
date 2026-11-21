import { Inject, Injectable } from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import { Database, DB, Db } from '../db/database';
import { normalizeExerciseName } from './normalize';

export interface ExerciseRef {
  id: string;
  name: string;
}

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/**
 * Exercise lookups. The catalog and its muscle-group mapping come from config/exercises.yaml (seeded by migrate);
 * unknown names become custom exercises owned by the user, with no muscle groups.
 */
@Injectable()
export class ExerciseCatalog {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** Visible to a user: the catalog plus their own custom exercises. */
  private visibleTo(userId: string) {
    return this.db.selectFrom('exercises').where((eb) => eb.or([eb('owner_user_id', 'is', null), eb('owner_user_id', '=', userId)]));
  }

  /**
   * Name -> exercise for every name in a write, creating missing custom exercises.
   * ON CONFLICT DO NOTHING + re-read makes two concurrent requests creating the same name share one id.
   */
  async resolveForWrite(trx: Kysely<Database>, userId: string, names: string[]): Promise<Map<string, ExerciseRef>> {
    const wanted = new Map(names.map((n) => [normalizeExerciseName(n), n.trim().replace(/\s+/g, ' ')]));
    const lookup = () =>
      trx
        .selectFrom('exercises')
        .select(['id', 'name', 'normalized_name'])
        .where('normalized_name', 'in', [...wanted.keys()])
        .where((eb) => eb.or([eb('owner_user_id', 'is', null), eb('owner_user_id', '=', userId)]))
        .orderBy(sql`owner_user_id NULLS FIRST`) // catalog wins over a custom duplicate
        .execute();

    const found = new Map<string, ExerciseRef>();
    const collect = (rows: { id: string; name: string; normalized_name: string }[]) => {
      for (const r of rows) if (!found.has(r.normalized_name)) found.set(r.normalized_name, { id: r.id, name: r.name });
    };
    collect(await lookup());

    const missing = [...wanted].filter(([norm]) => !found.has(norm));
    if (missing.length) {
      await trx
        .insertInto('exercises')
        .values(missing.map(([norm, display]) => ({ owner_user_id: userId, name: display, normalized_name: norm })))
        .onConflict((oc) => oc.constraint('exercises_owner_name_uq').doNothing())
        .execute();
      collect(await lookup());
    }
    return found;
  }

  /** Exact (normalized) match; PRs must never mix two exercises. */
  async findExact(userId: string, name: string): Promise<ExerciseRef | undefined> {
    return this.visibleTo(userId)
      .select(['id', 'name'])
      .where('normalized_name', '=', normalizeExerciseName(name))
      .orderBy(sql`owner_user_id NULLS FIRST`)
      .executeTakeFirst();
  }

  /** Close names for a 404, using the trigram index. */
  async suggest(userId: string, name: string, limit = 5): Promise<string[]> {
    const q = normalizeExerciseName(name);
    const rows = await this.visibleTo(userId)
      .select('name')
      .where(sql<boolean>`normalized_name % ${q} OR normalized_name ILIKE ${`%${escapeLike(q)}%`}`)
      .orderBy(sql`similarity(normalized_name, ${q})`, 'desc')
      .limit(limit)
      .execute();
    return rows.map((r) => r.name);
  }

  /**
   * Turns history filters into exercise ids. undefined = no filter; [] = nothing can match.
   * Partial name match is a trigram-indexed ILIKE on the small exercises table, never on the entries.
   */
  async idsForFilter(userId: string, filter: { exercise?: string; muscleGroup?: string }): Promise<string[] | undefined> {
    if (!filter.exercise && !filter.muscleGroup) return undefined;
    let q = this.visibleTo(userId).select('exercises.id');
    if (filter.exercise) q = q.where('normalized_name', 'ilike', `%${escapeLike(normalizeExerciseName(filter.exercise))}%`);
    if (filter.muscleGroup) {
      q = q.where('exercises.id', 'in', (eb) =>
        eb.selectFrom('exercise_muscle_groups').select('exercise_id').where('muscle_group', '=', filter.muscleGroup!.trim().toLowerCase()),
      );
    }
    return (await q.execute()).map((r) => r.id);
  }

  async muscleGroupsOf(ids: string[]): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>();
    if (!ids.length) return out;
    const rows = await this.db
      .selectFrom('exercise_muscle_groups')
      .select(['exercise_id', 'muscle_group'])
      .where('exercise_id', 'in', ids)
      .orderBy('role')
      .orderBy('muscle_group')
      .execute();
    for (const r of rows) out.set(r.exercise_id, [...(out.get(r.exercise_id) ?? []), r.muscle_group]);
    return out;
  }
}
