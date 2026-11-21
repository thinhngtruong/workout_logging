import Decimal from 'decimal.js';
import { z } from 'zod';
import { isCalendarDate, isValidTimeZone, parseWorkoutDate } from '../common/dates';
import { UnitRegistry } from '../units/unit-registry';

export const LIMITS = { entriesPerRequest: 50, setsPerEntry: 20, maxReps: 1000, maxWeight: 10_000, maxPageSize: 100 };

const custom = (ctx: z.RefinementCtx, code: string, message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message, params: { code } });

export const userIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9._:-]+$/, 'userId may contain only letters, digits and . _ : -');

const unitSchema = (units: UnitRegistry) =>
  z.string().transform((u, ctx) => {
    const unit = units.find(u);
    if (unit) return unit.code;
    custom(ctx, 'unsupported_unit', `unit '${u}' is not supported; use one of: ${units.codes.join(', ')}`);
    return z.NEVER;
  });

const timeZoneSchema = z.string().refine(isValidTimeZone, { message: 'expected an IANA time zone such as Asia/Ho_Chi_Minh', params: { code: 'invalid_time_zone' } });
const calendarDate = z.string().refine(isCalendarDate, { message: 'expected a date YYYY-MM-DD', params: { code: 'invalid_date' } });

export function logWorkoutsSchema(units: UnitRegistry) {
  const set = z.object({
    reps: z.number().int('reps must be a whole number').min(1, 'reps must be at least 1').max(LIMITS.maxReps),
    weight: z
      .number()
      .min(0, 'weight must not be negative')
      .max(LIMITS.maxWeight)
      .refine((w) => new Decimal(w).decimalPlaces() <= 2, { message: 'weight allows at most 2 decimal places', params: { code: 'too_precise' } }),
    unit: unitSchema(units),
  });

  const entry = z.object({
    exerciseName: z.string().trim().min(1, 'exerciseName is required').max(100),
    date: z.string().transform((s, ctx) => {
      const r = parseWorkoutDate(s);
      if (r.ok) return r;
      custom(ctx, r.code, r.message);
      return z.NEVER;
    }),
    timeZone: timeZoneSchema.optional(),
    sets: z.array(set).min(1, 'sets must not be empty').max(LIMITS.setsPerEntry),
  });

  return z.object({ entries: z.array(entry).min(1, 'entries must not be empty').max(LIMITS.entriesPerRequest) }).strict();
}
export type LogWorkoutsInput = z.infer<ReturnType<typeof logWorkoutsSchema>>;

const rangeRefine = <T extends { from?: string; to?: string }>(q: T, ctx: z.RefinementCtx) => {
  if (q.from && q.to && q.from > q.to) custom(ctx, 'invalid_range', "'from' must not be after 'to'");
};

export function historyQuerySchema(units: UnitRegistry) {
  return z
    .object({
      exercise: z.string().trim().min(1).max(100).optional(),
      muscleGroup: z.string().trim().min(1).max(50).optional(),
      from: calendarDate.optional(),
      to: calendarDate.optional(),
      unit: unitSchema(units).optional(),
      limit: z.coerce.number().int().min(1).max(LIMITS.maxPageSize).default(20),
      cursor: z.string().max(512).optional(),
    })
    .superRefine(rangeRefine);
}
export type HistoryQuery = z.infer<ReturnType<typeof historyQuerySchema>>;

export function recordsQuerySchema(units: UnitRegistry) {
  return z
    .object({
      exercise: z.string().trim().min(1, 'exercise is required').max(100),
      from: calendarDate.optional(),
      to: calendarDate.optional(),
      unit: unitSchema(units).default('kg'),
    })
    .superRefine(rangeRefine);
}
export type RecordsQuery = z.infer<ReturnType<typeof recordsQuerySchema>>;

export function compareQuerySchema(units: UnitRegistry) {
  return z
    .object({
      exercise: z.string().trim().min(1, 'exercise is required').max(100),
      unit: unitSchema(units).default('kg'),
      period: z.enum(['week', 'month']).optional(),
      timeZone: timeZoneSchema.default('UTC'),
      currentFrom: calendarDate.optional(),
      currentTo: calendarDate.optional(),
      previousFrom: calendarDate.optional(),
      previousTo: calendarDate.optional(),
    })
    .superRefine((q, ctx) => {
      const explicit = [q.currentFrom, q.currentTo, q.previousFrom, q.previousTo];
      const given = explicit.filter(Boolean).length;
      if (q.period ? given > 0 : given !== 4) {
        custom(ctx, 'invalid_range', 'send either period=week|month, or all of currentFrom, currentTo, previousFrom, previousTo');
      } else if (!q.period && (q.currentFrom! > q.currentTo! || q.previousFrom! > q.previousTo!)) {
        custom(ctx, 'invalid_range', "each range's from must not be after its to");
      }
    });
}
export type CompareQuery = z.infer<ReturnType<typeof compareQuerySchema>>;
