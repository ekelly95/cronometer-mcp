import type { CalendarDay } from '../domain/calendar.js';
import type { DailySummaryDay } from '../domain/entries.js';
import { isPresent } from '../domain/nutrient.js';
import {
  NUTRIENT_BY_ID,
  NUTRIENT_IDS,
  type NutrientId,
} from '../domain/nutrients.js';
import type { Unit } from '../domain/quantity.js';

export const DEFAULT_COVERAGE_THRESHOLD = 1;

export interface Coverage {
  readonly withData: number;
  readonly total: number;
  /** Null means there were no observations over which a ratio could exist. */
  readonly ratio: number | null;
}

export type TotalComparisonKind =
  | 'not-reported'
  | 'matches'
  | 'rounding'
  | 'missing-as-zero'
  /** The day has a Total row but no diary group, so there is nothing to compare it with. */
  | 'no-groups'
  | 'unexplained';

interface TotalComparisonBase {
  readonly kind: TotalComparisonKind;
  readonly observedSubtotal: number;
  /** Maximum expected drift from rounding the displayed group cells. */
  readonly roundingTolerance: number;
}

export interface TotalNotReported extends TotalComparisonBase {
  readonly kind: 'not-reported';
}

export interface TotalCompared extends TotalComparisonBase {
  readonly kind: Exclude<TotalComparisonKind, 'not-reported'>;
  readonly reportedTotal: number;
  /** Cronometer's total minus the sum of the group cells that actually contain data. */
  readonly delta: number;
}

export type TotalComparison = TotalNotReported | TotalCompared;

interface DayNutrientBase {
  readonly nutrient: NutrientId;
  readonly unit: Unit;
  readonly coverage: Coverage;
  /** A lower-bound subtotal when coverage is incomplete, never an estimated intake. */
  readonly observedSubtotal: number;
  readonly comparison: TotalComparison;
}

export interface DayNutrientValue extends DayNutrientBase {
  readonly kind: 'value';
  readonly value: number;
}

export interface DayNutrientInsufficientData extends DayNutrientBase {
  readonly kind: 'insufficient-data';
}

export type DayNutrientAggregate = DayNutrientValue | DayNutrientInsufficientData;

export interface DayNutritionAggregate {
  readonly date: CalendarDay;
  readonly threshold: number;
  readonly nutrients: Readonly<Record<NutrientId, DayNutrientAggregate>>;
}

export interface RangeCoverage {
  /** Coverage of the diary-group cells from which values are summed. */
  readonly groups: Coverage;
  /** Days for which every diary group carried data for this nutrient. */
  readonly days: Coverage;
}

export interface DatedTotalComparison {
  readonly date: CalendarDay;
  readonly comparison: TotalComparison;
}

interface RangeNutrientBase {
  readonly nutrient: NutrientId;
  readonly unit: Unit;
  readonly coverage: RangeCoverage;
  readonly observedSubtotal: number;
  readonly dailyComparisons: readonly DatedTotalComparison[];
}

export interface RangeNutrientValue extends RangeNutrientBase {
  readonly kind: 'value';
  readonly value: number;
}

export interface RangeNutrientInsufficientData extends RangeNutrientBase {
  readonly kind: 'insufficient-data';
}

export type RangeNutrientAggregate = RangeNutrientValue | RangeNutrientInsufficientData;

export interface NutritionRangeAggregate {
  readonly threshold: number;
  readonly days: readonly CalendarDay[];
  readonly nutrients: Readonly<Record<NutrientId, RangeNutrientAggregate>>;
}

const FLOAT_TOLERANCE = 1e-12;

function coverage(withData: number, total: number): Coverage {
  return {
    withData,
    total,
    ratio: total === 0 ? null : withData / total,
  };
}

function readThreshold(threshold: number): number {
  if (!Number.isFinite(threshold) || threshold <= 0 || threshold > 1) {
    throw new RangeError('coverage threshold must be greater than 0 and no greater than 1');
  }
  return threshold;
}

function compareReportedTotal(
  day: DailySummaryDay,
  nutrient: NutrientId,
  observedSubtotal: number,
  nutrientCoverage: Coverage,
  roundingTolerance: number,
): TotalComparison {
  if (day.reportedTotal === undefined) {
    return { kind: 'not-reported', observedSubtotal, roundingTolerance };
  }

  const reported = day.reportedTotal[nutrient];
  if (!isPresent(reported)) {
    return { kind: 'not-reported', observedSubtotal, roundingTolerance };
  }

  const delta = reported.value - observedSubtotal;
  const magnitude = Math.abs(delta);
  const common = {
    observedSubtotal,
    roundingTolerance,
    reportedTotal: reported.value,
    delta,
  };

  if (nutrientCoverage.total === 0) {
    return { kind: 'no-groups', ...common };
  }
  if (nutrientCoverage.withData < nutrientCoverage.total) {
    return { kind: 'missing-as-zero', ...common };
  }
  if (magnitude <= FLOAT_TOLERANCE) {
    return { kind: 'matches', ...common };
  }
  if (magnitude <= roundingTolerance + FLOAT_TOLERANCE) {
    return { kind: 'rounding', ...common };
  }
  return { kind: 'unexplained', ...common };
}

function aggregateDayNutrient(
  day: DailySummaryDay,
  nutrient: NutrientId,
  threshold: number,
): DayNutrientAggregate {
  let observedSubtotal = 0;
  let withData = 0;
  let roundingTolerance = 0;

  for (const group of day.groups) {
    const value = group.nutrients[nutrient];
    if (!isPresent(value)) continue;

    observedSubtotal += value.value;
    withData += 1;
    roundingTolerance += 0.5 * 10 ** -value.decimals;
  }

  const nutrientCoverage = coverage(withData, day.groups.length);
  const common: DayNutrientBase = {
    nutrient,
    unit: NUTRIENT_BY_ID[nutrient].unit,
    coverage: nutrientCoverage,
    observedSubtotal,
    comparison: compareReportedTotal(
      day,
      nutrient,
      observedSubtotal,
      nutrientCoverage,
      roundingTolerance,
    ),
  };

  if (nutrientCoverage.ratio !== null && nutrientCoverage.ratio >= threshold) {
    return { kind: 'value', value: observedSubtotal, ...common };
  }
  return { kind: 'insufficient-data', ...common };
}

export function aggregateDay(
  day: DailySummaryDay,
  threshold = DEFAULT_COVERAGE_THRESHOLD,
): DayNutritionAggregate {
  const checkedThreshold = readThreshold(threshold);
  const nutrients = {} as Record<NutrientId, DayNutrientAggregate>;

  for (const nutrient of NUTRIENT_IDS) {
    nutrients[nutrient] = aggregateDayNutrient(day, nutrient, checkedThreshold);
  }

  return { date: day.date, threshold: checkedThreshold, nutrients };
}

export function aggregateRange(
  days: readonly DailySummaryDay[],
  threshold = DEFAULT_COVERAGE_THRESHOLD,
): NutritionRangeAggregate {
  const checkedThreshold = readThreshold(threshold);
  const daily = days.map((day) => aggregateDay(day, checkedThreshold));
  const nutrients = {} as Record<NutrientId, RangeNutrientAggregate>;

  for (const nutrient of NUTRIENT_IDS) {
    let observedSubtotal = 0;
    let groupsWithData = 0;
    let groupsTotal = 0;
    let daysWithData = 0;
    const dailyComparisons: DatedTotalComparison[] = [];

    for (const day of daily) {
      const value = day.nutrients[nutrient];
      observedSubtotal += value.observedSubtotal;
      groupsWithData += value.coverage.withData;
      groupsTotal += value.coverage.total;
      if (value.coverage.total > 0 && value.coverage.withData === value.coverage.total) {
        daysWithData += 1;
      }
      dailyComparisons.push({ date: day.date, comparison: value.comparison });
    }

    const groupCoverage = coverage(groupsWithData, groupsTotal);
    const common: RangeNutrientBase = {
      nutrient,
      unit: NUTRIENT_BY_ID[nutrient].unit,
      coverage: {
        groups: groupCoverage,
        days: coverage(daysWithData, daily.length),
      },
      observedSubtotal,
      dailyComparisons,
    };

    if (groupCoverage.ratio !== null && groupCoverage.ratio >= checkedThreshold) {
      nutrients[nutrient] = { kind: 'value', value: observedSubtotal, ...common };
    } else {
      nutrients[nutrient] = { kind: 'insufficient-data', ...common };
    }
  }

  return {
    threshold: checkedThreshold,
    days: days.map((day) => day.date),
    nutrients,
  };
}
