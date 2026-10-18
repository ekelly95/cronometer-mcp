import { MOBILE_IDS } from './nutrient-ids.js';
import { isRecord, type JsonRecord } from './diary.js';

/**
 * Building custom foods and recipes for the mobile API's `add_food`, which is an
 * upsert: id 0 creates, a real id replaces that food wholesale.
 *
 * Cronometer stores every food's nutrients per 100 g, so amounts given per
 * serving are scaled. The derived duplicates the app writes alongside the macros
 * (negative ids, net carbs) are written the same way, because a food missing
 * them displays differently in the app. Payload shapes follow
 * rwestergren/cronometer-api-mcp (MIT), where they were verified against the
 * live API; see THIRD_PARTY_NOTICES.md.
 */

const OUNCE_GRAMS = 28.3495231;

export interface CustomFoodInput {
  readonly name: string;
  readonly serving_name: string;
  readonly serving_grams: number;
  readonly calories: number;
  readonly protein_g: number;
  readonly fat_g: number;
  readonly carbs_g: number;
  readonly fiber_g?: number;
  readonly sugars_g?: number;
  readonly sodium_mg?: number;
  readonly saturated_fat_g?: number;
  readonly barcodes?: readonly string[];
}

const round = (value: number, places: number): number => Math.round(value * 10 ** places) / 10 ** places;

function weightMeasures(servingName: string, servingGrams: number): JsonRecord[] {
  return [
    { id: 0, name: servingName, value: servingGrams, amount: 1, type: 'Weight' },
    { id: 0, name: 'g', value: 1, amount: 1, type: 'Weight' },
    { id: 0, name: 'oz', value: OUNCE_GRAMS, amount: 1, type: 'Weight' },
  ];
}

export function customFoodPayload(input: CustomFoodInput): JsonRecord {
  const scale = 100 / input.serving_grams;
  const per100 = (value: number | undefined): number => round((value ?? 0) * scale, 2);
  const fiber = input.fiber_g ?? 0;
  const nutrients = [
    { id: MOBILE_IDS.energy, amount: per100(input.calories) },
    { id: MOBILE_IDS.protein, amount: per100(input.protein_g) },
    { id: MOBILE_IDS.fat, amount: per100(input.fat_g) },
    { id: MOBILE_IDS.carbs, amount: per100(input.carbs_g) },
    { id: MOBILE_IDS.fiber, amount: per100(fiber) },
    { id: MOBILE_IDS.sugars, amount: per100(input.sugars_g) },
    { id: MOBILE_IDS.sodium, amount: per100(input.sodium_mg) },
    { id: MOBILE_IDS.saturated, amount: per100(input.saturated_fat_g) },
    { id: -203, amount: per100(input.protein_g) },
    { id: -204, amount: per100(input.fat_g) },
    { id: -205, amount: per100(input.carbs_g) },
    { id: -221, amount: 0 },
    { id: MOBILE_IDS.netCarbs, amount: per100(Math.max(0, input.carbs_g - fiber)) },
  ];
  return {
    data: {
      id: 0,
      name: input.name,
      category: 0,
      owner: null,
      retired: null,
      source: null,
      defaultMeasureId: 0,
      comments: null,
      alternateId: null,
      // The first measure becomes the server-assigned default.
      measures: weightMeasures(input.serving_name, input.serving_grams),
      labelType: 'AMERICAN_2016',
      nutrients,
      properties: {},
      foodTags: [],
      barcodes: normalizeBarcodes(input.barcodes ?? []),
    },
    config: { call_version: 1 },
  };
}

/**
 * A food object as get_food returned it, made safe to send back through add_food:
 * the sync messages the server appends are not food data.
 */
export function resendable(food: JsonRecord): JsonRecord {
  const copy = structuredClone(food);
  delete copy['messages'];
  return copy;
}

/**
 * Refuses anything but a food created in this account. Recipes may be retired —
 * that re-sends the object untouched apart from its flag — but not edited, since
 * their nutrients are derived from their ingredients.
 */
export function assertPlainCustomFood(food: JsonRecord, foodId: number, purpose: 'edit' | 'retire' = 'edit'): void {
  if (food['source'] !== 'Custom') {
    throw new Error(`Food ${foodId} is not a custom food, so it cannot be changed from here. Only foods created in this account can be edited or retired.`);
  }
  if (purpose === 'edit' && Array.isArray(food['ingredients']) && food['ingredients'].length > 0) {
    throw new Error(`Food ${foodId} is a recipe. Recipes cannot be edited from here; use the Cronometer app.`);
  }
}

export interface CustomFoodUpdate {
  readonly name?: string;
  readonly calories?: number;
  readonly protein_g?: number;
  readonly fat_g?: number;
  readonly carbs_g?: number;
  readonly fiber_g?: number;
  readonly serving_name?: string;
  readonly serving_grams?: number;
}

/** Applies the fields given to a fetched custom food; everything else is re-sent untouched. */
export function applyCustomFoodUpdate(food: JsonRecord, update: CustomFoodUpdate): JsonRecord {
  const copy = resendable(food);
  if (update.name !== undefined) {
    const old = copy['name'];
    copy['name'] = update.name;
    if (Array.isArray(copy['translations'])) {
      for (const translation of copy['translations']) {
        if (isRecord(translation) && translation['name'] === old) translation['name'] = update.name;
      }
    }
  }
  const measures = Array.isArray(copy['measures']) ? copy['measures'].filter(isRecord) : [];
  const measure = measures.find((candidate) => candidate['id'] === copy['defaultMeasureId']) ?? measures[0];
  if (measure !== undefined) {
    if (update.serving_name !== undefined) measure['name'] = update.serving_name;
    if (update.serving_grams !== undefined) {
      measure['value'] = update.serving_grams;
      measure['amount'] = 1;
      measure['type'] = 'Atomic';
    }
  }
  const grams = measure !== undefined && typeof measure['value'] === 'number' && measure['value'] > 0 ? measure['value'] : 100;
  const scale = 100 / grams;

  if (!Array.isArray(copy['nutrients'])) copy['nutrients'] = [];
  const nutrients = (copy['nutrients'] as unknown[]).filter(isRecord);
  const set = (id: number, amount: number): void => {
    const existing = nutrients.find((entry) => entry['id'] === id);
    if (existing === undefined) {
      const entry = { id, amount };
      nutrients.push(entry);
      (copy['nutrients'] as unknown[]).push(entry);
    } else existing['amount'] = amount;
  };
  const get = (id: number): number => {
    const value = nutrients.find((entry) => entry['id'] === id)?.['amount'];
    return typeof value === 'number' ? value : 0;
  };
  const changes: [number, number | undefined, number | undefined][] = [
    [MOBILE_IDS.energy, update.calories, undefined],
    [MOBILE_IDS.protein, update.protein_g, -203],
    [MOBILE_IDS.fat, update.fat_g, -204],
    [MOBILE_IDS.carbs, update.carbs_g, -205],
    [MOBILE_IDS.fiber, update.fiber_g, undefined],
  ];
  for (const [id, value, mirror] of changes) {
    if (value === undefined) continue;
    const per100 = round(value * scale, 2);
    set(id, per100);
    if (mirror !== undefined) set(mirror, per100);
  }
  if (update.carbs_g !== undefined || update.fiber_g !== undefined) {
    set(MOBILE_IDS.netCarbs, round(Math.max(0, get(MOBILE_IDS.carbs) - get(MOBILE_IDS.fiber)), 2));
  }
  return copy;
}

export interface RecipeIngredient {
  readonly food_id: number;
  readonly grams: number;
}

function gramMeasureId(food: JsonRecord): number {
  const measures = Array.isArray(food['measures']) ? food['measures'].filter(isRecord) : [];
  const gram = measures.find((measure) => measure['name'] === 'g' && measure['value'] === 1);
  const id = gram?.['id'] ?? food['defaultMeasureId'];
  return typeof id === 'number' ? id : 0;
}

function translationId(food: JsonRecord): number {
  const translations = food['translations'];
  if (!Array.isArray(translations) || !isRecord(translations[0])) return 0;
  const id = translations[0]['translationId'];
  return typeof id === 'number' ? id : 0;
}

/**
 * A weight-based recipe: nutrients per 100 g of the finished batch, summed from
 * each ingredient's per-100 g profile. A nutrient one ingredient does not report
 * is summed from the ones that do — the same floor Cronometer itself computes.
 */
export function recipePayload(
  name: string,
  ingredients: readonly RecipeIngredient[],
  foods: ReadonlyMap<number, JsonRecord>,
  servingName: string,
  servingGrams: number | undefined,
): { readonly payload: JsonRecord; readonly totalGrams: number } {
  const totalGrams = ingredients.reduce((sum, ingredient) => sum + ingredient.grams, 0);
  const totals = new Map<number, number>();
  const rows = ingredients.map((ingredient) => {
    const food = foods.get(ingredient.food_id);
    if (food === undefined) throw new Error(`Ingredient food ${ingredient.food_id} was not found.`);
    const raw = Array.isArray(food['nutrients']) ? food['nutrients'].filter(isRecord) : [];
    for (const nutrient of raw) {
      const { id, amount } = nutrient;
      if (typeof id === 'number' && typeof amount === 'number' && Number.isFinite(amount)) {
        totals.set(id, (totals.get(id) ?? 0) + (amount * ingredient.grams) / 100);
      }
    }
    return {
      id: 0,
      foodId: ingredient.food_id,
      measureId: gramMeasureId(food),
      translationId: translationId(food),
      grams: ingredient.grams,
      value: ingredient.grams,
    };
  });
  const scale = 100 / totalGrams;
  const nutrients = [...totals.entries()].sort((a, b) => a[0] - b[0]).map(([id, amount]) => ({ id, amount: round(amount * scale, 6) }));
  return {
    totalGrams,
    payload: {
      data: {
        id: 0,
        name,
        category: 0,
        owner: null,
        retired: null,
        source: null,
        defaultMeasureId: 0,
        comments: null,
        alternateId: null,
        ingredients: rows,
        measures: [
          ...weightMeasures(servingName, servingGrams ?? totalGrams),
          { id: 0, name: 'full recipe', value: totalGrams, amount: 1, type: 'Weight' },
        ],
        labelType: 'AMERICAN_2016',
        nutrients,
        properties: { advancedServingSize: 'false' },
        foodTags: [],
      },
      config: { call_version: 1 },
    },
  };
}

/**
 * Product barcodes (EAN-8, UPC-A, EAN-13, GTIN-14): spaces and dashes removed,
 * check digit verified. A wrong code would attach a food to someone else's
 * product, so a bad one is refused rather than stored.
 */
export function normalizeBarcodes(codes: readonly string[]): string[] {
  const result: string[] = [];
  for (const raw of codes) {
    const code = raw.replace(/[\s-]/g, '');
    if (!/^\d{8}$|^\d{12,14}$/.test(code)) {
      throw new Error(`"${raw}" is not an 8, 12, 13 or 14 digit product barcode.`);
    }
    const digits = [...code].map(Number);
    const check = digits.pop()!;
    const sum = digits.reverse().reduce((total, digit, index) => total + digit * (index % 2 === 0 ? 3 : 1), 0);
    if ((10 - (sum % 10)) % 10 !== check) throw new Error(`"${raw}" has the wrong check digit.`);
    if (!result.includes(code)) result.push(code);
  }
  return result;
}
