import { Inject, Injectable } from '@nestjs/common';
import Decimal from 'decimal.js';
import { RawBuilder, sql } from 'kysely';
import { DateRange, periodRanges } from '../common/dates';
import { ApiError } from '../common/errors';
import { DB, Db } from '../db/database';
import { ExerciseCatalog, ExerciseRef } from '../exercises/exercise-catalog';
import { UnitRegistry } from '../units/unit-registry';
import { CompareQuery, RecordsQuery } from '../workouts/workouts.schemas';

type Metric = 'maxWeight' | 'maxVolume' | 'bestE1rm';
type Range = Partial<DateRange>;

/**
 * Each metric is one ordered read that returns the whole winning row (so its date and reps come with it).
 * Ties go to the earliest date: a PR is achieved the first time. Bodyweight sets (weight 0) are excluded.
 * `weight_kg > 0` must stay in the query so the planner can use the partial per-metric indexes.
 */
const METRIC_ORDER: Record<Metric, RawBuilder<unknown>> = {
  maxWeight: sql`weight_kg DESC, reps DESC, performed_on, id`,
  maxVolume: sql`volume_kg DESC, performed_on, id`,
  bestE1rm: sql`e1rm_kg DESC, performed_on, id`,
};
const METRICS = Object.keys(METRIC_ORDER) as Metric[];

interface WinningRow {
  label: string;
  metric: Metric;
  reps: number;
  weight_value: string;
  weight_unit: string;
  weight_kg: string;
  volume_kg: string;
  e1rm_kg: string;
  performed_on: string;
}

export interface PersonalRecord {
  value: number;
  weight: number;
  reps: number;
  unit: string;
  date: string;
}
export type Records = Record<Metric, PersonalRecord | null>;

@Injectable()
export class RecordsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly catalog: ExerciseCatalog,
    private readonly units: UnitRegistry,
  ) {}

  async personalRecords(userId: string, q: RecordsQuery) {
    const exercise = await this.resolve(userId, q.exercise);
    const range = { from: q.from, to: q.to };
    const records = (await this.query(userId, exercise.id, { all: range }, q.unit)).all;
    return {
      exercise,
      unit: q.unit,
      range: { from: q.from ?? null, to: q.to ?? null },
      records,
      ...(isEmpty(records) && { message: 'No weighted sets logged for this exercise in the given range' }),
    };
  }

  async compare(userId: string, q: CompareQuery) {
    const exercise = await this.resolve(userId, q.exercise);
    const ranges = q.period
      ? periodRanges(q.period, q.timeZone)
      : { current: { from: q.currentFrom!, to: q.currentTo! }, previous: { from: q.previousFrom!, to: q.previousTo! } };
    const { current, previous } = await this.query(userId, exercise.id, ranges, q.unit);

    const delta = Object.fromEntries(
      METRICS.map((m) => [m, current[m] && previous[m] ? new Decimal(current[m]!.value).minus(previous[m]!.value).toNumber() : null]),
    ) as Record<Metric, number | null>;
    const messages = [isEmpty(current) && 'current', isEmpty(previous) && 'previous'].filter(Boolean);

    return {
      exercise,
      unit: q.unit,
      ...(q.period && { period: q.period, timeZone: q.timeZone }),
      current: { range: ranges.current, records: current },
      previous: { range: ranges.previous, records: previous },
      delta,
      ...(messages.length && { message: `No weighted sets logged in the ${messages.join(' and ')} range` }),
    };
  }

  private async resolve(userId: string, name: string): Promise<ExerciseRef> {
    const exercise = await this.catalog.findExact(userId, name);
    if (exercise) return exercise;
    throw new ApiError(404, 'EXERCISE_NOT_FOUND', `Exercise '${name}' not found`, { suggestions: await this.catalog.suggest(userId, name) });
  }

  /** All metrics for all ranges in ONE statement: 3 × ranges index-backed `LIMIT 1` reads joined by UNION ALL. */
  private async query<K extends string>(userId: string, exerciseId: string, ranges: Record<K, Range>, unit: string): Promise<Record<K, Records>> {
    const parts = Object.entries<Range>(ranges).flatMap(([label, r]) =>
      METRICS.map(
        (metric) => sql`(SELECT ${label} AS label, ${metric} AS metric, reps, weight_value, weight_unit, weight_kg, volume_kg, e1rm_kg, performed_on
          FROM workout_sets
          WHERE user_id = ${userId} AND exercise_id = ${exerciseId} AND weight_kg > 0
            ${r.from ? sql`AND performed_on >= ${r.from}::date` : sql``}
            ${r.to ? sql`AND performed_on <= ${r.to}::date` : sql``}
          ORDER BY ${METRIC_ORDER[metric]} LIMIT 1)`,
      ),
    );
    const { rows } = await sql<WinningRow>`${sql.join(parts, sql` UNION ALL `)}`.execute(this.db);

    const out = Object.fromEntries(Object.keys(ranges).map((k) => [k, { maxWeight: null, maxVolume: null, bestE1rm: null }])) as Record<K, Records>;
    for (const row of rows) out[row.label as K][row.metric] = this.toRecord(row, unit);
    return out;
  }

  private toRecord(row: WinningRow, unit: string): PersonalRecord {
    const { weight } = this.units.display({ value: row.weight_value, unit: row.weight_unit, kg: row.weight_kg }, unit);
    const value = { maxWeight: weight, maxVolume: this.units.fromKg(row.volume_kg, unit), bestE1rm: this.units.fromKg(row.e1rm_kg, unit) }[row.metric];
    return { value, weight, reps: row.reps, unit, date: row.performed_on };
  }
}

const isEmpty = (r: Records) => METRICS.every((m) => r[m] === null);
