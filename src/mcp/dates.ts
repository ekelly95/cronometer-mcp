import { z } from 'zod';

import { calendarDaySchema } from './schemas.js';

/**
 * Dates as people say them, resolved here rather than by the model.
 *
 * "Today" depends on the diary's timezone, which the model does not reliably
 * know and the host's clock may not share: at 11 PM in New York it is already
 * tomorrow in UTC. So relative dates are accepted as words and turned into a
 * calendar day in the configured timezone at the moment of the call, and every
 * result names the day it actually used.
 */

const RELATIVE = /^(today|yesterday|tomorrow|(\d{1,3}) days? ago)$/i;

export const dayInputSchema = z
  .string()
  .trim()
  .refine((value) => RELATIVE.test(value) || calendarDaySchema.safeParse(value).success, {
    message: 'use YYYY-MM-DD, "today", "yesterday", or "N days ago"',
  })
  .describe('A date: YYYY-MM-DD, "today", "yesterday", or "N days ago" (resolved in the diary timezone).');

/** Today's calendar day in a timezone, as YYYY-MM-DD. */
export function todayIn(timeZone: string, now: Date = new Date()): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export function shiftDay(day: string, offset: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + offset * 86_400_000).toISOString().slice(0, 10);
}

export function resolveDay(value: string, timeZone: string, now: Date = new Date()): string {
  const match = RELATIVE.exec(value.trim());
  if (match === null) return value.trim();
  const today = todayIn(timeZone, now);
  const word = match[1]!.toLowerCase();
  if (word === 'today') return today;
  if (word === 'yesterday') return shiftDay(today, -1);
  if (word === 'tomorrow') return shiftDay(today, 1);
  return shiftDay(today, -Number(match[2]));
}

/** Every `date`, `*_date` field in a tool's input, resolved. Other fields pass through untouched. */
export function resolveDates<T extends Record<string, unknown>>(input: T, timeZone: string, now: Date = new Date()): T {
  const resolved: Record<string, unknown> = { ...input };
  for (const [key, value] of Object.entries(resolved)) {
    if ((key === 'date' || key.endsWith('_date')) && typeof value === 'string') {
      resolved[key] = resolveDay(value, timeZone, now);
    }
  }
  return resolved as T;
}

/**
 * A single day or an inclusive range, for the diary reads. A plain object with a
 * refinement rather than a union, because clients flatten a top-level union into
 * something misleading.
 */
export function dayOrRangeSchema(maximumDays: number) {
  return z
    .object({
      date: dayInputSchema.optional().describe('One day. Use this, or start_date and end_date.'),
      start_date: dayInputSchema.optional().describe('First day of a range.'),
      end_date: dayInputSchema.optional().describe(`Last day of a range (at most ${maximumDays} days).`),
    })
    .strict()
    .superRefine(({ date, start_date, end_date }, context) => {
      const hasRange = start_date !== undefined || end_date !== undefined;
      if (date !== undefined && hasRange) {
        context.addIssue({ code: 'custom', path: ['date'], message: 'give date, or start_date and end_date, not both' });
      } else if (date === undefined && (start_date === undefined || end_date === undefined)) {
        context.addIssue({
          code: 'custom',
          path: [start_date === undefined ? 'start_date' : 'end_date'],
          message: 'give date, or both start_date and end_date',
        });
      }
    });
}

/** `{date}` becomes `{start_date: date, end_date: date}` once dates are resolved. */
export function asRange(input: Record<string, unknown>): Record<string, unknown> {
  if (typeof input['date'] !== 'string') return input;
  const { date, ...rest } = input;
  return { ...rest, start_date: date, end_date: date };
}
