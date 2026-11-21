import { isCalendarDate, isValidTimeZone, parseWorkoutDate, periodRanges, todayIn } from './dates';

describe('parseWorkoutDate', () => {
  it('keeps a plain calendar day as is, with no instant', () => {
    expect(parseWorkoutDate('2026-11-20')).toEqual({ ok: true, performedOn: '2026-11-20', performedAt: null });
  });

  it('reduces a timestamp with offset to the LOCAL day, not the UTC day', () => {
    // 06:00 in Ho Chi Minh City is 23:00 the previous day in UTC
    const r = parseWorkoutDate('2026-11-20T06:00:00+07:00');
    expect(r).toEqual({ ok: true, performedOn: '2026-11-20', performedAt: new Date('2026-11-19T23:00:00Z') });
  });

  it('rejects a timestamp without offset as ambiguous', () => {
    expect(parseWorkoutDate('2026-11-20T06:00:00')).toMatchObject({ ok: false, code: 'ambiguous_timestamp' });
  });

  it.each(['2026-02-30', '2026-13-01', '20-11-2026', '', 'yesterday', '2026-02-30T10:00:00Z'])('rejects %p', (input) => {
    expect(parseWorkoutDate(input)).toMatchObject({ ok: false, code: 'invalid_date' });
  });

  it('accepts leap days only in leap years', () => {
    expect(isCalendarDate('2024-02-29')).toBe(true);
    expect(isCalendarDate('2026-02-29')).toBe(false);
  });
});

describe('time zones', () => {
  it('validates IANA names', () => {
    expect(isValidTimeZone('Asia/Ho_Chi_Minh')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
  });

  it('computes today in the client zone', () => {
    const now = new Date('2026-11-30T20:00:00Z');
    expect(todayIn('UTC', now)).toBe('2026-11-30');
    expect(todayIn('Asia/Ho_Chi_Minh', now)).toBe('2026-12-01');
  });
});

describe('periodRanges', () => {
  it('month: this month to date vs the whole previous month, in the client zone', () => {
    // already 1 Dec in Ho Chi Minh City
    expect(periodRanges('month', 'Asia/Ho_Chi_Minh', new Date('2026-11-30T20:00:00Z'))).toEqual({
      current: { from: '2026-12-01', to: '2026-12-01' },
      previous: { from: '2026-11-01', to: '2026-11-30' },
    });
  });

  it('month: handles a January rollover and short February', () => {
    expect(periodRanges('month', 'UTC', new Date('2026-01-15T00:00:00Z')).previous).toEqual({ from: '2025-12-01', to: '2025-12-31' });
    expect(periodRanges('month', 'UTC', new Date('2026-03-10T00:00:00Z')).previous).toEqual({ from: '2026-02-01', to: '2026-02-28' });
  });

  it('week: ISO weeks starting Monday', () => {
    // 2026-11-21 is a Saturday
    expect(periodRanges('week', 'UTC', new Date('2026-11-21T12:00:00Z'))).toEqual({
      current: { from: '2026-11-16', to: '2026-11-21' },
      previous: { from: '2026-11-09', to: '2026-11-15' },
    });
  });
});
