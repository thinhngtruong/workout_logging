/**
 * Timezone strategy: a workout belongs to the client's LOCAL calendar day (performed_on, a DATE).
 * Instants (performed_at, created_at) are stored in UTC. See README "Timezones".
 */

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
// date-time WITH an explicit offset; the local date is the date part as the client wrote it
const DATETIME_WITH_OFFSET_RE = /^(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/i;
const DATETIME_NO_OFFSET_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?$/;

/** True for a real calendar day in YYYY-MM-DD (rejects 2026-02-30). */
export function isCalendarDate(s: string): boolean {
  const m = DATE_RE.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

export type ParsedWorkoutDate =
  | { ok: true; performedOn: string; performedAt: Date | null }
  | { ok: false; code: 'invalid_date' | 'ambiguous_timestamp'; message: string };

/** 'YYYY-MM-DD' -> that day. Timestamp with offset -> its local date + the UTC instant. No offset -> rejected. */
export function parseWorkoutDate(input: string): ParsedWorkoutDate {
  if (isCalendarDate(input)) return { ok: true, performedOn: input, performedAt: null };
  const m = DATETIME_WITH_OFFSET_RE.exec(input);
  if (m && isCalendarDate(m[1])) {
    const instant = new Date(input);
    if (!Number.isNaN(instant.getTime())) return { ok: true, performedOn: m[1], performedAt: instant };
  }
  if (DATETIME_NO_OFFSET_RE.test(input)) {
    return { ok: false, code: 'ambiguous_timestamp', message: 'timestamp has no UTC offset; send YYYY-MM-DD or include an offset like +07:00' };
  }
  return { ok: false, code: 'invalid_date', message: 'expected a date YYYY-MM-DD or an ISO 8601 timestamp with offset' };
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The calendar day it is right now in `timeZone`. */
export function todayIn(timeZone: string, now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

const toUtc = (d: string) => new Date(`${d}T00:00:00Z`);
const fmt = (d: Date) => d.toISOString().slice(0, 10);
export const addDays = (d: string, n: number): string => fmt(new Date(toUtc(d).getTime() + n * 86_400_000));

export interface DateRange {
  from: string;
  to: string;
}

/**
 * "This period vs last period" in the client's zone. Current runs from the period start to today;
 * previous is the whole prior period. Weeks start on Monday (ISO 8601).
 */
export function periodRanges(period: 'week' | 'month', timeZone: string, now = new Date()): { current: DateRange; previous: DateRange } {
  const today = todayIn(timeZone, now);
  if (period === 'month') {
    const start = `${today.slice(0, 8)}01`;
    const prevEnd = addDays(start, -1);
    return { current: { from: start, to: today }, previous: { from: `${prevEnd.slice(0, 8)}01`, to: prevEnd } };
  }
  const isoDow = (toUtc(today).getUTCDay() + 6) % 7; // Monday = 0
  const start = addDays(today, -isoDow);
  return { current: { from: start, to: today }, previous: { from: addDays(start, -7), to: addDays(start, -1) } };
}
