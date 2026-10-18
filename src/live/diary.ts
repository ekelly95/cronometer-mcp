import { NUTRIENT_IDS, type NutrientId } from '../domain/nutrients.js';
import { MOBILE_IDS, MOBILE_NUTRIENT_IDS } from './nutrient-ids.js';

/**
 * Shaping the mobile API's diary into what the tools return.
 *
 * Pure functions over already-fetched JSON, so the rules that matter are testable
 * without a network: a nutrient a food does not report is absent, never zero; an
 * entry whose food could not be resolved keeps its ids and says so; and nothing
 * Cronometer sends is passed through without being picked field by field.
 */

export type JsonRecord = Record<string, unknown>;

const DEFAULT_GROUP_NAMES = ['Breakfast', 'Lunch', 'Dinner', 'Snacks'] as const;

export function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const finite = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);

const round = (value: number, places = 2): number => {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
};

/** Cronometer's day format: `2026-10-6`, not zero-padded. */
export function cronometerDay(isoDay: string): string {
  const [year, month, day] = isoDay.split('-').map(Number) as [number, number, number];
  return `${year}-${month}-${day}`;
}

/** The diary group lives in the high 16 bits of an entry's `order`. */
export function diaryGroupOf(order: unknown): { readonly number: number; readonly name: string } | null {
  if (typeof order !== 'number' || !Number.isInteger(order) || order < 0) return null;
  const number = order >> 16;
  if (number === 0) return null;
  return { number, name: DEFAULT_GROUP_NAMES[number - 1] ?? `Group ${number}` };
}

interface Measure {
  readonly id: number;
  readonly name: string;
  readonly amount: number;
  readonly grams: number;
  readonly type: string;
}

function measuresOf(food: JsonRecord): Measure[] {
  const raw = food['measures'];
  if (!Array.isArray(raw)) return [];
  const result: Measure[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const id = finite(entry['id']);
    const grams = finite(entry['value']);
    const name = text(entry['name']);
    if (id === null || grams === null || name === null) continue;
    result.push({ id, name, amount: finite(entry['amount']) ?? 1, grams, type: text(entry['type']) ?? 'Weight' });
  }
  return result;
}

/**
 * A food's nutrients per 100 g, keyed by Cronometer id. Only what the food's
 * record carries: an absent id is "not reported", the whole reason coverage can
 * be measured at all.
 */
export function nutrientProfile(food: JsonRecord): Map<number, number> {
  const profile = new Map<number, number>();
  const raw = food['nutrients'];
  if (!Array.isArray(raw)) return profile;
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const id = finite(entry['id']);
    const amount = finite(entry['amount']);
    if (id !== null && amount !== null && amount >= 0) profile.set(id, amount);
  }
  // Net carbs are derived by Cronometer (carbs minus fiber) and many database
  // records do not store them. Deriving them the same way is not inventing data;
  // it needs both inputs, and without both they stay unreported.
  if (!profile.has(MOBILE_IDS.netCarbs)) {
    const carbs = profile.get(MOBILE_IDS.carbs);
    const fiber = profile.get(MOBILE_IDS.fiber);
    if (carbs !== undefined && fiber !== undefined) profile.set(MOBILE_IDS.netCarbs, Math.max(0, carbs - fiber));
  }
  return profile;
}

/**
 * How much of a food's per-100 g profile an entry represents. For an ordinary
 * measure the entry's `grams` is real grams. For a serving-based recipe measure it
 * is a count of reference servings and the profile is per serving.
 */
function scaleFor(entry: JsonRecord, food: JsonRecord): number | null {
  const grams = finite(entry['grams']);
  if (grams === null) return null;
  const measure = measuresOf(food).find((candidate) => candidate.id === entry['measureId']);
  return measure?.type === 'Recipe' ? grams : grams / 100;
}

export interface FoodEntryNutrients {
  readonly scale: number | null;
  readonly values: ReadonlyMap<number, number>;
}

export function entryNutrients(entry: JsonRecord, food: JsonRecord | undefined): FoodEntryNutrients {
  if (food === undefined) return { scale: null, values: new Map() };
  const scale = scaleFor(entry, food);
  if (scale === null) return { scale: null, values: new Map() };
  const values = new Map<number, number>();
  for (const [id, amount] of nutrientProfile(food)) values.set(id, amount * scale);
  return { scale, values };
}

function amountOf(entry: JsonRecord, food: JsonRecord | undefined): JsonRecord {
  const grams = finite(entry['grams']);
  const measure = food === undefined ? undefined : measuresOf(food).find((candidate) => candidate.id === entry['measureId']);
  if (measure === undefined || grams === null || measure.grams <= 0) {
    return { quantity: null, unit: null, grams };
  }
  if (measure.type === 'Recipe') {
    return { quantity: round(grams, 3), unit: measure.name, grams: null };
  }
  return { quantity: round((grams / measure.grams) * measure.amount, 3), unit: measure.name, grams: round(grams, 2) };
}

const macro = (values: ReadonlyMap<number, number>, id: number): number | null => {
  const value = values.get(id);
  return value === undefined ? null : round(value, 1);
};

export interface MetricCatalog {
  readonly name: (metricId: number) => string | null;
  readonly unit: (metricId: number, unitId: number) => string | null;
}

export function metricCatalog(metrics: readonly JsonRecord[]): MetricCatalog {
  const byId = new Map<number, JsonRecord>();
  for (const metric of metrics) {
    const id = finite(metric['id']);
    if (id !== null) byId.set(id, metric);
  }
  return {
    name: (metricId) => text(byId.get(metricId)?.['name']),
    unit: (metricId, unitId) => {
      const units = byId.get(metricId)?.['units'];
      if (!Array.isArray(units)) return null;
      const unit = units.find((candidate) => isRecord(candidate) && candidate['id'] === unitId);
      return isRecord(unit) ? text(unit['name']) : null;
    },
  };
}

export function shapeEntry(entry: JsonRecord, foods: ReadonlyMap<number, JsonRecord>, metrics: MetricCatalog): JsonRecord {
  const type = text(entry['type']) ?? 'Serving';
  const group = diaryGroupOf(entry['order']);
  const time = text(entry['time']);
  if (type === 'Serving') {
    const foodId = finite(entry['foodId']);
    const food = foodId === null ? undefined : foods.get(foodId);
    const { values } = entryNutrients(entry, food);
    return {
      type: 'food',
      serving_id: finite(entry['servingId']),
      time,
      diary_group: group,
      food_id: foodId,
      measure_id: finite(entry['measureId']),
      food_name: food === undefined ? null : text(food['name']),
      food_source: food === undefined ? null : text(food['source']),
      amount: amountOf(entry, food),
      energy_kcal: macro(values, MOBILE_IDS.energy),
      protein_g: macro(values, MOBILE_IDS.protein),
      carbs_g: macro(values, MOBILE_IDS.carbs),
      net_carbs_g: macro(values, MOBILE_IDS.netCarbs),
      fat_g: macro(values, MOBILE_IDS.fat),
      fiber_g: macro(values, MOBILE_IDS.fiber),
      ...(food === undefined ? { food_unresolved: true } : {}),
    };
  }
  if (type === 'Exercise') {
    const calories = finite(entry['calories']);
    return {
      type: 'exercise',
      exercise_id: finite(entry['exerciseId']),
      diary_group: group,
      name: text(entry['name']),
      activity_id: finite(entry['activityId']),
      minutes: finite(entry['minutes']),
      // Stored negative: energy out.
      calories_burned: calories === null ? null : round(Math.abs(calories), 1),
      source: text(entry['source']),
    };
  }
  if (type === 'Biometric') {
    const metricId = finite(entry['metricId']);
    const unitId = finite(entry['unitId']);
    return {
      type: 'biometric',
      biometric_id: finite(entry['biometricId']) ?? finite(entry['id']),
      time,
      metric_id: metricId,
      metric: metricId === null ? null : metrics.name(metricId),
      amount: finite(entry['amount']),
      unit_id: unitId,
      unit: metricId === null || unitId === null ? null : metrics.unit(metricId, unitId),
      source: text(entry['source']),
    };
  }
  if (type === 'Note') {
    return {
      type: 'note',
      note_id: finite(entry['noteId']) ?? finite(entry['id']),
      diary_group: group,
      text: text(entry['text']) ?? text(entry['note']) ?? text(entry['noteText']),
    };
  }
  return { type: type.toLowerCase(), unrecognised: true };
}

function targetsOf(day: JsonRecord): JsonRecord | null {
  const summary = isRecord(day['summary']) ? day['summary'] : undefined;
  const macros = summary !== undefined && isRecord(summary['macros']) ? summary['macros'] : undefined;
  const template = isRecord(day['template']) ? day['template'] : undefined;
  if (macros === undefined && template === undefined) return null;
  return {
    template_id: template === undefined ? null : finite(template['id']),
    template_name: template === undefined ? null : text(template['name']),
    energy_kcal: macros === undefined ? null : finite(macros['energy']),
    protein_g: macros === undefined ? null : finite(macros['protein']),
    carbs_g: macros === undefined ? null : finite(macros['total_carbs']) ?? finite(macros['carbs']),
    net_carbs_g: macros === undefined ? null : finite(macros['net_carbs']),
    fat_g: macros === undefined ? null : finite(macros['fat']),
  };
}

function consumedOf(day: JsonRecord): JsonRecord | null {
  const summary = isRecord(day['summary']) ? day['summary'] : undefined;
  const consumed = summary !== undefined && isRecord(summary['consumed']) ? summary['consumed'] : undefined;
  if (consumed === undefined) return null;
  const value = (key: string): number | null => {
    const number = finite(consumed[key]);
    return number === null ? null : round(number, 1);
  };
  return {
    energy_kcal: value('total'),
    protein_g: value('protein_g'),
    carbs_g: value('carbs_g'),
    fat_g: value('fat_g'),
    alcohol_g: value('alcohol_g'),
  };
}

function remainingOf(targets: JsonRecord | null, consumed: JsonRecord | null): JsonRecord | null {
  if (targets === null || consumed === null) return null;
  const left = (target: unknown, eaten: unknown): number | null =>
    typeof target === 'number' && typeof eaten === 'number' ? round(target - eaten, 1) : null;
  return {
    energy_kcal: left(targets['energy_kcal'], consumed['energy_kcal']),
    protein_g: left(targets['protein_g'], consumed['protein_g']),
    carbs_g: left(targets['carbs_g'], consumed['carbs_g']),
    fat_g: left(targets['fat_g'], consumed['fat_g']),
  };
}

function balanceOf(day: JsonRecord): JsonRecord | null {
  const summary = isRecord(day['summary']) ? day['summary'] : undefined;
  const burned = summary !== undefined && isRecord(summary['burned']) ? summary['burned'] : undefined;
  const consumed = summary !== undefined && isRecord(summary['consumed']) ? summary['consumed'] : undefined;
  if (burned === undefined) return null;
  const value = (record: JsonRecord | undefined, key: string): number | null => {
    const number = record === undefined ? null : finite(record[key]);
    return number === null ? null : round(number, 0);
  };
  return {
    burned_kcal: value(burned, 'total'),
    bmr_kcal: value(burned, 'bmr_kcal'),
    activity_kcal: value(burned, 'activity_kcal'),
    exercise_kcal: value(burned, 'exercise_kcal'),
    tracker_activity_kcal: value(burned, 'tracker_activity_kcal'),
    thermic_effect_kcal: value(burned, 'tef_kcal'),
    // Positive is a deficit, negative a surplus — consumed minus burned, inverted.
    deficit_kcal: value(consumed, 'deficit_kcal'),
  };
}

export function shapeDay(isoDay: string, day: JsonRecord, foods: ReadonlyMap<number, JsonRecord>, metrics: MetricCatalog): JsonRecord {
  const info = isRecord(day['info']) ? day['info'] : undefined;
  const raw = Array.isArray(day['diary']) ? day['diary'].filter(isRecord) : [];
  const targets = targetsOf(day);
  const consumed = consumedOf(day);
  return {
    date: isoDay,
    complete: info === undefined || typeof info['complete'] !== 'boolean' ? null : info['complete'],
    targets,
    consumed,
    remaining: remainingOf(targets, consumed),
    energy_balance: balanceOf(day),
    entries: raw.map((entry) => shapeEntry(entry, foods, metrics)),
  };
}

export function foodIdsIn(days: readonly JsonRecord[]): number[] {
  const ids = new Set<number>();
  for (const day of days) {
    const raw = Array.isArray(day['diary']) ? day['diary'] : [];
    for (const entry of raw) {
      if (isRecord(entry) && (entry['type'] ?? 'Serving') === 'Serving' && typeof entry['foodId'] === 'number') {
        ids.add(entry['foodId']);
      }
    }
  }
  return [...ids].sort((a, b) => a - b);
}

/**
 * One food entry as the coverage analysis sees it: a "group" whose nutrients
 * are the ones its food reports, scaled to the amount eaten. An entry whose food
 * could not be resolved reports nothing — and so counts against coverage.
 */
export interface NutritionServing {
  readonly label: string;
  readonly nutrients: Partial<Record<NutrientId, number>>;
}

export function nutritionServings(day: JsonRecord, foods: ReadonlyMap<number, JsonRecord>): NutritionServing[] {
  const raw = Array.isArray(day['diary']) ? day['diary'].filter(isRecord) : [];
  const servings: NutritionServing[] = [];
  for (const entry of raw) {
    if ((entry['type'] ?? 'Serving') !== 'Serving') continue;
    const foodId = finite(entry['foodId']);
    const food = foodId === null ? undefined : foods.get(foodId);
    const { values } = entryNutrients(entry, food);
    const nutrients: Partial<Record<NutrientId, number>> = {};
    for (const id of NUTRIENT_IDS) {
      const value = values.get(MOBILE_NUTRIENT_IDS[id]);
      if (value !== undefined) nutrients[id] = value;
    }
    const name = food === undefined ? `food ${foodId ?? '?'}` : text(food['name']) ?? `food ${foodId ?? '?'}`;
    const group = diaryGroupOf(entry['order'])?.name ?? 'Uncategorized';
    servings.push({ label: `${group}: ${name}`, nutrients });
  }
  return servings;
}

/** A food's measures and its nutrients per serving, labelled from the account's catalogue. */
export function shapeFood(food: JsonRecord, catalog: ReadonlyMap<number, { readonly name: string; readonly unit: string }>): JsonRecord {
  const measures = measuresOf(food);
  const defaultMeasureId = finite(food['defaultMeasureId']);
  const profile = nutrientProfile(food);
  const nutrients: JsonRecord[] = [];
  for (const [id, per100] of profile) {
    const label = catalog.get(id);
    nutrients.push({ id, name: label?.name ?? null, unit: label?.unit ?? null, per_100g: round(per100, 4) });
  }
  return {
    food_id: finite(food['id']),
    name: text(food['name']),
    source: text(food['source']),
    retired: food['retired'] === true,
    default_measure_id: defaultMeasureId,
    measures: measures.map((measure) => ({
      measure_id: measure.id,
      name: measure.name,
      quantity: measure.amount,
      grams: measure.type === 'Recipe' ? null : measure.grams,
      type: measure.type,
    })),
    nutrients_reported: nutrients.length,
    nutrients,
    is_recipe: Array.isArray(food['ingredients']) && food['ingredients'].length > 0,
  };
}
