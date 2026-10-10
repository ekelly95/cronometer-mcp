export type {
  Coverage,
  DatedTotalComparison,
  DayNutrientAggregate,
  DayNutrientInsufficientData,
  DayNutrientValue,
  DayNutritionAggregate,
  NutritionRangeAggregate,
  RangeCoverage,
  RangeNutrientAggregate,
  RangeNutrientInsufficientData,
  RangeNutrientValue,
  TotalCompared,
  TotalComparison,
  TotalComparisonKind,
  TotalNotReported,
} from './coverage.js';
export {
  DEFAULT_COVERAGE_THRESHOLD,
  aggregateDay,
  aggregateRange,
} from './coverage.js';
export type { IncompleteSpoke, MeasuredSpoke, NutrientRadar, RadarSpoke } from './radar.js';
export { buildNutrientRadar } from './radar.js';
