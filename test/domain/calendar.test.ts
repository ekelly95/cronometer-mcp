import { describe, expect, it } from 'vitest';

import {
  compareLocalTime,
  eachCalendarDay,
  minutesFromMidnight,
  parseCalendarDay,
  parseLocalTime,
  parseLocalTimestamp,
} from '../../src/domain/calendar.js';

describe('calendar days', () => {
  it.each(['2026-08-16', '2024-02-29', '2000-02-29', '2026-12-31'])('accepts %s', (raw) => {
    expect(parseCalendarDay(raw)).toBe(raw);
  });

  it.each([
    ['2026-13-45', 'an impossible month and day'],
    ['2026-02-30', 'a day past the end of February'],
    ['2026-02-29', 'February 29th in a non-leap year'],
    ['1900-02-29', 'the century rule'],
    ['08/16/2026', 'a non-ISO format'],
    ['2026-8-16', 'unpadded parts'],
    ['', 'an empty cell'],
    ['2026-08-16 ', 'trailing whitespace'],
  ])('rejects %o — %s', (raw) => {
    expect(parseCalendarDay(raw)).toBeUndefined();
  });
});

describe('calendar day ranges', () => {
  const day = (raw: string) => {
    const parsed = parseCalendarDay(raw);
    if (parsed === undefined) throw new Error(`not a day: ${raw}`);
    return parsed;
  };

  it('is inclusive at both ends', () => {
    expect(eachCalendarDay(day('2026-08-14'), day('2026-08-16'))).toEqual([
      '2026-08-14',
      '2026-08-15',
      '2026-08-16',
    ]);
  });

  it('crosses month, leap-day and year boundaries', () => {
    expect(eachCalendarDay(day('2024-02-28'), day('2024-03-01'))).toEqual([
      '2024-02-28',
      '2024-02-29',
      '2024-03-01',
    ]);
    expect(eachCalendarDay(day('2026-12-31'), day('2027-01-01'))).toEqual([
      '2026-12-31',
      '2027-01-01',
    ]);
  });

  it('does not repeat or skip a day across a DST change', () => {
    // 2026-03-08 and 2026-11-01 are the US clock changes.
    expect(eachCalendarDay(day('2026-03-07'), day('2026-03-09'))).toHaveLength(3);
    expect(eachCalendarDay(day('2026-10-31'), day('2026-11-02'))).toHaveLength(3);
  });

  it('is empty when the range is backwards, and one day when it is a single day', () => {
    expect(eachCalendarDay(day('2026-08-16'), day('2026-08-15'))).toEqual([]);
    expect(eachCalendarDay(day('2026-08-16'), day('2026-08-16'))).toEqual(['2026-08-16']);
  });
});

describe('local times', () => {
  it('reads a 12-hour clock into an orderable 24-hour value', () => {
    expect(parseLocalTime('9:39 PM')).toEqual({ hour: 21, minute: 39, raw: '9:39 PM' });
    expect(parseLocalTime('8:30 AM')).toEqual({ hour: 8, minute: 30, raw: '8:30 AM' });
  });

  it('handles the two hours everyone gets wrong', () => {
    expect(parseLocalTime('12:00 AM')?.hour).toBe(0);
    expect(parseLocalTime('12:30 PM')?.hour).toBe(12);
  });

  it.each(['25:99 XM', '9:39', '', '9:60 PM', '13:00 PM', '0:30 AM'])('rejects %o', (raw) => {
    expect(parseLocalTime(raw)).toBeUndefined();
  });

  it('keeps the source text so output can round-trip', () => {
    expect(parseLocalTime('9:39 PM')?.raw).toBe('9:39 PM');
  });

  it('orders times that sort wrongly as text', () => {
    const evening = parseLocalTime('9:30 PM');
    const afternoon = parseLocalTime('3:30 PM');
    if (evening === undefined || afternoon === undefined) throw new Error('expected both times');

    expect('9:30 PM' < '3:30 PM').toBe(false); // as text, the evening sorts later
    expect(compareLocalTime(afternoon, evening)).toBeLessThan(0);
    expect(minutesFromMidnight(evening)).toBe(21 * 60 + 30);
  });
});

describe('fast timestamps', () => {
  it('reads a recognised date and time', () => {
    expect(parseLocalTimestamp('2026-08-14 20:15:00')).toEqual({
      raw: '2026-08-14 20:15:00',
      day: '2026-08-14',
      time: { hour: 20, minute: 15, raw: '20:15:00' },
    });
  });

  it('reads the ISO T separator too', () => {
    expect(parseLocalTimestamp('2026-08-14T20:15')?.time?.hour).toBe(20);
  });

  it('takes a bare date without inventing a time', () => {
    expect(parseLocalTimestamp('2026-08-14')).toEqual({
      raw: '2026-08-14',
      day: '2026-08-14',
      time: undefined,
    });
  });

  it('keeps an unrecognised timestamp rather than discarding it', () => {
    // The format is unverified (DATA_MODEL.md section 8 question 3), so an
    // unfamiliar shape is not evidence of a bad value.
    expect(parseLocalTimestamp('not a timestamp')).toEqual({
      raw: 'not a timestamp',
      day: undefined,
      time: undefined,
    });
  });

  it('does not mistake the year for the hour', () => {
    // '20' appears at the very start of '2026-...' as well as in the time.
    expect(parseLocalTimestamp('2026-08-14 20:15:00')?.time?.raw).toBe('20:15:00');
  });
});
