import type { NutrientId } from '../domain/nutrients.js';

/**
 * Cronometer's numeric id for each nutrient this project models, as the mobile
 * API reports them. They are USDA-style ids (208 energy, 203 protein…) plus a few
 * of Cronometer's own: 10001/10002 for omega-3/6, 10009 added sugars, 10012
 * oxalate, and -1205 for net carbs, which Cronometer derives rather than stores.
 *
 * Fixed rather than matched by name at runtime so that a renamed label on
 * Cronometer's side cannot silently re-point a nutrient. The test suite checks
 * each id against the name and unit in a captured catalogue.
 */
export const MOBILE_NUTRIENT_IDS: Readonly<Record<NutrientId, number>> = {
  energy: 208,
  alcohol: 221,
  caffeine: 262,
  oxalate: 10012,
  phytate: 246,
  water: 255,
  b1: 404,
  b2: 405,
  b3: 406,
  b5: 410,
  b6: 415,
  b12: 418,
  folate: 417,
  vitaminA: 320,
  vitaminC: 401,
  vitaminD: 324,
  vitaminE: 323,
  vitaminK: 430,
  calcium: 301,
  copper: 312,
  iron: 303,
  magnesium: 304,
  manganese: 315,
  phosphorus: 305,
  potassium: 306,
  selenium: 317,
  sodium: 307,
  zinc: 309,
  netCarbs: -1205,
  carbs: 205,
  fiber: 291,
  insolubleFiber: 297,
  solubleFiber: 295,
  starch: 209,
  sugars: 269,
  addedSugars: 10009,
  fat: 204,
  cholesterol: 601,
  monounsaturated: 645,
  polyunsaturated: 646,
  saturated: 606,
  transFats: 605,
  omega3: 10001,
  ala: 851,
  dha: 621,
  epa: 629,
  omega6: 10002,
  aa: 853,
  la: 675,
  cystine: 507,
  histidine: 512,
  isoleucine: 503,
  leucine: 504,
  lysine: 505,
  methionine: 506,
  phenylalanine: 508,
  protein: 203,
  threonine: 502,
  tryptophan: 501,
  tyrosine: 509,
  valine: 510,
};

export const NUTRIENT_ID_BY_MOBILE_ID: ReadonlyMap<number, NutrientId> = new Map(
  (Object.entries(MOBILE_NUTRIENT_IDS) as [NutrientId, number][]).map(([id, mobile]) => [mobile, id]),
);

export const MOBILE_IDS = {
  energy: 208,
  protein: 203,
  fat: 204,
  carbs: 205,
  netCarbs: -1205,
  fiber: 291,
  sugars: 269,
  sodium: 307,
  saturated: 606,
  alcohol: 221,
} as const;
