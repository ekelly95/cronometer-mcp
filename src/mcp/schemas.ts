import { z } from 'zod';

const CALENDAR_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const CRONOMETER_IDENTIFIER = /^[A-Za-z0-9$._-]+$/;

function realCalendarDay(value: string): boolean {
  const match = CALENDAR_DAY.exec(value);
  if (match === null) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function inclusiveDays(start: string, end: string): number {
  const startTime = Date.parse(`${start}T00:00:00Z`);
  const endTime = Date.parse(`${end}T00:00:00Z`);
  return Math.floor((endTime - startTime) / 86_400_000) + 1;
}

export const calendarDaySchema = z
  .string()
  .regex(CALENDAR_DAY, 'use YYYY-MM-DD')
  .refine(realCalendarDay, 'must be a real calendar date')
  .describe('Calendar date in YYYY-MM-DD form.');

export const dateRangeSchema = z
  .object({
    start_date: calendarDaySchema.describe('First date to include.'),
    end_date: calendarDaySchema.describe('Last date to include.'),
  })
  .strict()
  .refine(({ start_date, end_date }) => start_date <= end_date, {
    message: 'end_date must not be before start_date',
    path: ['end_date'],
  })
  .refine(({ start_date, end_date }) => inclusiveDays(start_date, end_date) <= 366, {
    message: 'a live request may cover at most 366 days',
    path: ['end_date'],
  });

export const emptyInputSchema = z.object({}).strict();

export const positiveIdSchema = z
  .number()
  .int()
  .min(1)
  .max(2_147_483_647)
  .describe('Positive Cronometer numeric identifier.');

export const identifierSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(CRONOMETER_IDENTIFIER)
  .describe('Cronometer identifier returned by an earlier tool result.');

export function protocolTextSchema(maximum: number, description: string): z.ZodString {
  return z
    .string()
    .trim()
    .min(1)
    .max(maximum)
    .refine(
      (value) =>
        !/[|\\{}]/.test(value) &&
        ![...value].some((character) => character.charCodeAt(0) < 32),
      'contains a character that the Cronometer protocol cannot encode safely',
    )
    .describe(description);
}

export const coverageSchema = z
  .object({
    withData: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    ratio: z.number().min(0).max(1).nullable(),
  })
  .strict();

/**
 * A number that may not have been recorded, kept as a tagged union all the way to
 * the wire.
 *
 * The obvious encoding is a nullable number, and it is the one thing this project
 * must not do: `null` invites `?? 0` at the far end and a blank Minutes column
 * becomes a workout of zero minutes. `domain/nutrient.ts` makes that impossible in
 * TypeScript; this keeps it impossible in JSON.
 */
export const measuredNumberSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('present'),
      value: z.number(),
      /** Digits after the decimal point in the source cell. */
      decimals: z.number().int().nonnegative(),
    })
    .strict(),
  z.object({ kind: z.literal('missing') }).strict(),
]);

/** Units are never converted — `lbs` here is `kg` on a metric account. */
export const quantitySchema = z
  .object({ value: z.number(), unit: z.string() })
  .strict();

export const localTimeSchema = z
  .object({
    hour: z.number().int().min(0).max(23),
    minute: z.number().int().min(0).max(59),
    /** Exactly as recorded, e.g. `9:39 PM`, so output can round-trip. */
    raw: z.string().min(1),
  })
  .strict();

/**
 * The `Day, Time, Group` spine shared by servings, exercises, biometrics and notes.
 * `time` is nullable here and only here: absent means the export left it blank,
 * which is normal and is never a stand-in for midnight.
 */
const pointEventShape = {
  day: calendarDaySchema,
  time: localTimeSchema.nullable(),
  group: z.string(),
};

const comparisonBase = {
  observedSubtotal: z.number(),
  roundingTolerance: z.number().nonnegative(),
};

export const totalComparisonSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('not-reported'), ...comparisonBase }).strict(),
  ...(['matches', 'rounding', 'missing-as-zero', 'unexplained'] as const).map((kind) =>
    z
      .object({
        kind: z.literal(kind),
        ...comparisonBase,
        reportedTotal: z.number(),
        delta: z.number(),
      })
      .strict(),
  ),
]);

const rangeNutrientBase = {
  nutrient: z.string().min(1),
  label: z.string().min(1),
  section: z.string().min(1),
  unit: z.string().min(1),
  coverage: z
    .object({
      groups: coverageSchema,
      days: coverageSchema,
    })
    .strict(),
  observedSubtotal: z.number(),
  dailyComparisons: z.array(
    z
      .object({
        date: calendarDaySchema,
        comparison: totalComparisonSchema,
      })
      .strict(),
  ),
};

export const rangeNutrientSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('value'), value: z.number(), ...rangeNutrientBase }).strict(),
  z.object({ kind: z.literal('insufficient-data'), ...rangeNutrientBase }).strict(),
]);

export const parseIssueSchema = z
  .object({
    file: z.string(),
    line: z.number().int().positive(),
    code: z.string(),
    column: z.string().optional(),
    detail: z.string(),
  })
  .strict();

export const servingRowSchema = z
  .object({
    ...pointEventShape,
    /** Untrusted free text, authored by users and food databases. */
    foodName: z.string(),
    /** Unfused from the single `Amount` cell: `1.00 container - each 5.3 oz`. */
    amount: quantitySchema,
    category: z.string(),
  })
  .strict();

export const exerciseRowSchema = z
  .object({
    ...pointEventShape,
    exercise: z.string(),
    minutes: measuredNumberSchema,
    caloriesBurned: measuredNumberSchema,
  })
  .strict();

export const biometricRowSchema = z
  .object({
    ...pointEventShape,
    /** Open vocabulary — never validated against a list. */
    metric: z.string().min(1),
    amount: quantitySchema,
  })
  .strict();

export const noteRowSchema = z
  .object({
    ...pointEventShape,
    /** The highest prompt-injection risk in the export. Verbatim, as data. */
    note: z.string(),
  })
  .strict();

export const PARSED_EXPORT_ROW_SCHEMAS = {
  servings: servingRowSchema,
  exercises: exerciseRowSchema,
  biometrics: biometricRowSchema,
  notes: noteRowSchema,
} as const;

export type ParsedExportKind = keyof typeof PARSED_EXPORT_ROW_SCHEMAS;

/**
 * The envelope every parsed export shares.
 *
 * `rowsDropped` and `issues` exist so that a short list of rows can never be
 * mistaken for a short diary. A row this parser could not read is reported and
 * counted, never silently omitted — and a *missing column* does not reach here at
 * all, because the tool fails instead of returning a plausible empty list.
 */
export function parsedExportOutputSchema(kind: ParsedExportKind): z.ZodType {
  return z
    .object({
      ok: z.literal(true),
      source: z.literal('cronometer-live-export'),
      data: z
        .object({
          exportType: z.literal(kind),
          dateRange: z
            .object({ start: calendarDaySchema, end: calendarDaySchema })
            .strict(),
          rows: z.array(PARSED_EXPORT_ROW_SCHEMAS[kind]),
          /** Rows the parser refused; each one has a matching entry in `issues`. */
          rowsDropped: z.number().int().nonnegative(),
          issues: z.array(parseIssueSchema),
        })
        .strict(),
    })
    .strict();
}

export const genericOutputSchema = z
  .object({
    ok: z.literal(true),
    source: z.enum(['connector-status', 'cronometer-live', 'cronometer-live-export']),
    data: z.unknown(),
    /**
     * Present only when the connector returned an empty answer it could not
     * confirm was empty: Cronometer replied, but not in a shape it recognised,
     * and an empty record looks identical at that point. Treat the emptiness as
     * unverified rather than as a finding — this is the flag that would have
     * stopped a logged weight being reported as "no biometrics recorded".
     */
    unverified: z.literal(true).optional(),
  })
  .strict();

/**
 * Folder names only — never a path. The MCP layer refuses anything else before the
 * filesystem is touched at all, so traversal is not something the reader has to
 * defend against alone.
 */
export const exportFolderSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/,
    'use only letters, digits, dots, dashes and underscores — no path separators',
  )
  .describe('Name of one export folder, as listed by cronometer_list_exports.');

export const exportListOutputSchema = z
  .object({
    ok: z.literal(true),
    source: z.literal('cronometer-file-export'),
    data: z
      .object({
        exportDirectory: z.string(),
        exports: z.array(
          z
            .object({
              name: z.string(),
              filesPresent: z.array(z.string()),
              filesAbsent: z.array(z.string()),
              lastModified: z.string().nullable(),
            })
            .strict(),
        ),
      })
      .strict(),
  })
  .strict();

export const nutritionOutputSchema = z
  .object({
    ok: z.literal(true),
    /**
     * Always a downloaded export. A file export carries one row per meal, so a
     * nutrient's coverage is real and a divergence from Cronometer's own total can
     * be classified. The live export is pre-aggregated to day totals and can carry
     * neither, which is why there is no live nutrition summary.
     */
    source: z.literal('cronometer-file-export'),
    data: z
      .object({
        dateRange: z
          .object({
            start: calendarDaySchema,
            end: calendarDaySchema,
          })
          .strict(),
        coverageThreshold: z.number().gt(0).max(1),
        /** Days that had rows. Every nutrient `value` is a sum over exactly these. */
        days: z.array(calendarDaySchema),
        /** Calendar days from `dateRange.start` to `dateRange.end`, inclusive. */
        daysInRange: z.number().int().positive(),
        /**
         * Days inside the range with no rows at all. They add nothing to any sum,
         * which is the missing-as-zero trap one level up from a nutrient cell: a
         * week with two unlogged days still sums to a `value`. Listed so that an
         * average is taken over the days that were actually logged.
         */
        daysAbsentFromExport: z.array(calendarDaySchema),
        parseIssues: z.array(parseIssueSchema),
        rowsOutsideRequestedRange: z.number().int().nonnegative(),
        nutrients: z.array(rangeNutrientSchema),
      })
      .strict(),
  })
  .strict();

export type ExportListOutput = z.infer<typeof exportListOutputSchema>;
export type GenericOutput = z.infer<typeof genericOutputSchema>;
export type NutritionOutput = z.infer<typeof nutritionOutputSchema>;
