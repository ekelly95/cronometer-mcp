import type { CalendarDay } from '../domain/calendar.js';
import type { DailySummaryDay } from '../domain/entries.js';
import { NUTRIENT_BY_ID } from '../domain/nutrients.js';
import {
  RADAR_SPOKES,
  referenceAmount,
  type RadarGroup,
  type ReferenceBasis,
  type ReferenceProfile,
} from '../domain/reference-intakes.js';
import { aggregateRange, type Coverage } from './coverage.js';

interface RadarSpokeBase {
  readonly id: string;
  readonly label: string;
  readonly group: RadarGroup;
  readonly unit: string;
  /** Null when the reference scales with body weight and none was given. */
  readonly reference: { readonly amount: number; readonly basis: ReferenceBasis } | null;
  /** The weakest component's coverage, since a sum is only as complete as its least-covered part. */
  readonly coverage: { readonly groups: Coverage; readonly days: Coverage };
}

/** Every diary group in range carried every component, so this is a real average. */
export interface MeasuredSpoke extends RadarSpokeBase {
  readonly kind: 'measured';
  readonly dailyAverage: number;
  readonly percentOfReference: number | null;
}

/**
 * Some diary groups had no value. What remains is a floor — the food that *was*
 * recorded contributed at least this much — and is named as one, so a chart
 * cannot draw it as the intake.
 */
export interface IncompleteSpoke extends RadarSpokeBase {
  readonly kind: 'incomplete';
  readonly atLeastDailyAverage: number;
  readonly atLeastPercentOfReference: number | null;
}

/**
 * Not one diary group in range carried any of the components — usually because
 * the column is absent from the export. There is no floor to draw: an `incomplete`
 * spoke at 0 would read as "ate none", which is a claim nothing here supports.
 */
export interface NoDataSpoke extends RadarSpokeBase {
  readonly kind: 'no-data';
}

export type RadarSpoke = MeasuredSpoke | IncompleteSpoke | NoDataSpoke;

export interface NutrientRadar {
  readonly days: readonly CalendarDay[];
  readonly spokes: readonly RadarSpoke[];
}

/** No observations at all ranks below any real ratio, including zero. */
const rank = (coverage: Coverage): number => (coverage.ratio === null ? -1 : coverage.ratio);

function weakest(coverages: readonly Coverage[]): Coverage {
  return coverages.reduce((worst, next) => (rank(next) < rank(worst) ? next : worst));
}

const percent = (amount: number, reference: number | undefined): number | null =>
  reference === undefined || reference === 0 ? null : (amount / reference) * 100;

/**
 * Per-day averages over the days that have rows, set against a reference.
 *
 * The divisor is the number of logged days, never the calendar span: a day with
 * no rows contributes nothing to a sum, so dividing by seven would read a
 * two-day gap as two days of eating nothing. The caller reports those days.
 */
export function buildNutrientRadar(
  days: readonly DailySummaryDay[],
  profile: ReferenceProfile,
  bodyWeightKg: number | undefined,
): NutrientRadar {
  if (days.length === 0) {
    throw new RangeError('a radar needs at least one logged day to average over');
  }
  // Full coverage only. A lower threshold makes `value` mean "mostly covered",
  // and a spoke drawn as measured must mean every diary group had the nutrient.
  const aggregate = aggregateRange(days, 1);
  const divisor = aggregate.days.length;

  const spokes = RADAR_SPOKES.map((spoke): RadarSpoke => {
    const parts = spoke.components.map((id) => aggregate.nutrients[id]);
    const amount = referenceAmount(spoke, profile, bodyWeightKg);
    const base: RadarSpokeBase = {
      id: spoke.id,
      label: spoke.label,
      group: spoke.group,
      unit: NUTRIENT_BY_ID[spoke.components[0]!].unit,
      reference: amount === undefined ? null : { amount, basis: spoke.reference.basis },
      coverage: {
        groups: weakest(parts.map((part) => part.coverage.groups)),
        days: weakest(parts.map((part) => part.coverage.days)),
      },
    };

    // Every component, not the weakest: when only one half of a pair is missing,
    // the half that was recorded is still a true floor for the sum.
    if (parts.every((part) => part.coverage.groups.withData === 0)) {
      return { ...base, kind: 'no-data' };
    }

    const complete = parts.every((part) => part.kind === 'value');
    const average = parts.reduce((sum, part) => sum + part.observedSubtotal, 0) / divisor;
    if (complete) {
      return {
        ...base,
        kind: 'measured',
        dailyAverage: average,
        percentOfReference: percent(average, amount),
      };
    }
    return {
      ...base,
      kind: 'incomplete',
      atLeastDailyAverage: average,
      atLeastPercentOfReference: percent(average, amount),
    };
  });

  return { days: aggregate.days, spokes };
}
