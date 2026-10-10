import type { NutrientId } from './nutrients.js';

/**
 * General-population reference intakes for the radar, and the one place in the
 * project that holds numbers Cronometer did not supply.
 *
 * Kept deliberately small and sourced, because a radar drawn against a reference
 * reads as a verdict whether or not it is one. These are population references
 * for healthy adults, not personal targets: Cronometer's own per-account targets
 * are not reachable through this connector, and nothing here should be presented
 * as one.
 *
 * - Vitamins and minerals: US National Academies Dietary Reference Intakes, as
 *   tabulated by the NIH Office of Dietary Supplements, for adults aged 31–50.
 *   That band is chosen because it is the only one magnesium differs on (19–30
 *   needs 20 mg less); every other value here is the same across 19–50.
 * - Essential amino acids: WHO/FAO/UNU 2007 (Technical Report Series 935), adult
 *   maintenance requirement in mg per kg of body weight per day. They scale with
 *   weight, so without a weight there is no reference to draw.
 *
 * Methionine and phenylalanine are referenced only as sums with cystine and
 * tyrosine respectively, because that is how the requirement is defined; a
 * methionine-only spoke would compare against a number nobody published.
 */

export type ReferenceProfile = 'adult-male' | 'adult-female';

export type RadarGroup = 'vitamins' | 'minerals' | 'essentialAminoAcids';

/** RDA where one exists, AI (Adequate Intake) where the evidence only supports that. */
export type ReferenceBasis = 'RDA' | 'AI' | 'WHO-2007';

interface FixedReference {
  readonly kind: 'fixed';
  readonly basis: 'RDA' | 'AI';
  readonly amount: Readonly<Record<ReferenceProfile, number>>;
}

interface PerKilogramReference {
  readonly kind: 'per-kg';
  readonly basis: 'WHO-2007';
  /** Milligrams per kilogram of body weight per day. */
  readonly mgPerKg: number;
}

export interface RadarSpokeDefinition {
  readonly id: string;
  readonly label: string;
  readonly group: RadarGroup;
  /** One nutrient, or the pair whose sum the reference is defined over. */
  readonly components: readonly NutrientId[];
  readonly reference: FixedReference | PerKilogramReference;
}

const both = (value: number): Readonly<Record<ReferenceProfile, number>> => ({
  'adult-male': value,
  'adult-female': value,
});

const split = (male: number, female: number): Readonly<Record<ReferenceProfile, number>> => ({
  'adult-male': male,
  'adult-female': female,
});

const rda = (amount: Readonly<Record<ReferenceProfile, number>>): FixedReference => ({
  kind: 'fixed',
  basis: 'RDA',
  amount,
});

const ai = (amount: Readonly<Record<ReferenceProfile, number>>): FixedReference => ({
  kind: 'fixed',
  basis: 'AI',
  amount,
});

const who = (mgPerKg: number): PerKilogramReference => ({
  kind: 'per-kg',
  basis: 'WHO-2007',
  mgPerKg,
});

export const RADAR_SPOKES: readonly RadarSpokeDefinition[] = [
  { id: 'b1', label: 'B1 Thiamine', group: 'vitamins', components: ['b1'], reference: rda(split(1.2, 1.1)) },
  { id: 'b2', label: 'B2 Riboflavin', group: 'vitamins', components: ['b2'], reference: rda(split(1.3, 1.1)) },
  { id: 'b3', label: 'B3 Niacin', group: 'vitamins', components: ['b3'], reference: rda(split(16, 14)) },
  { id: 'b5', label: 'B5 Pantothenic acid', group: 'vitamins', components: ['b5'], reference: ai(both(5)) },
  { id: 'b6', label: 'B6 Pyridoxine', group: 'vitamins', components: ['b6'], reference: rda(both(1.3)) },
  { id: 'b12', label: 'B12 Cobalamin', group: 'vitamins', components: ['b12'], reference: rda(both(2.4)) },
  { id: 'folate', label: 'Folate', group: 'vitamins', components: ['folate'], reference: rda(both(400)) },
  { id: 'vitaminA', label: 'Vitamin A', group: 'vitamins', components: ['vitaminA'], reference: rda(split(900, 700)) },
  { id: 'vitaminC', label: 'Vitamin C', group: 'vitamins', components: ['vitaminC'], reference: rda(split(90, 75)) },
  { id: 'vitaminD', label: 'Vitamin D', group: 'vitamins', components: ['vitaminD'], reference: rda(both(600)) },
  { id: 'vitaminE', label: 'Vitamin E', group: 'vitamins', components: ['vitaminE'], reference: rda(both(15)) },
  { id: 'vitaminK', label: 'Vitamin K', group: 'vitamins', components: ['vitaminK'], reference: ai(split(120, 90)) },

  { id: 'calcium', label: 'Calcium', group: 'minerals', components: ['calcium'], reference: rda(both(1000)) },
  { id: 'copper', label: 'Copper', group: 'minerals', components: ['copper'], reference: rda(both(0.9)) },
  { id: 'iron', label: 'Iron', group: 'minerals', components: ['iron'], reference: rda(split(8, 18)) },
  { id: 'magnesium', label: 'Magnesium', group: 'minerals', components: ['magnesium'], reference: rda(split(420, 320)) },
  { id: 'manganese', label: 'Manganese', group: 'minerals', components: ['manganese'], reference: ai(split(2.3, 1.8)) },
  { id: 'phosphorus', label: 'Phosphorus', group: 'minerals', components: ['phosphorus'], reference: rda(both(700)) },
  { id: 'potassium', label: 'Potassium', group: 'minerals', components: ['potassium'], reference: ai(split(3400, 2600)) },
  { id: 'selenium', label: 'Selenium', group: 'minerals', components: ['selenium'], reference: rda(both(55)) },
  { id: 'sodium', label: 'Sodium', group: 'minerals', components: ['sodium'], reference: ai(both(1500)) },
  { id: 'zinc', label: 'Zinc', group: 'minerals', components: ['zinc'], reference: rda(split(11, 8)) },

  { id: 'histidine', label: 'Histidine', group: 'essentialAminoAcids', components: ['histidine'], reference: who(10) },
  { id: 'isoleucine', label: 'Isoleucine', group: 'essentialAminoAcids', components: ['isoleucine'], reference: who(20) },
  { id: 'leucine', label: 'Leucine', group: 'essentialAminoAcids', components: ['leucine'], reference: who(39) },
  { id: 'lysine', label: 'Lysine', group: 'essentialAminoAcids', components: ['lysine'], reference: who(30) },
  { id: 'methionineCystine', label: 'Methionine + Cystine', group: 'essentialAminoAcids', components: ['methionine', 'cystine'], reference: who(15) },
  { id: 'phenylalanineTyrosine', label: 'Phenylalanine + Tyrosine', group: 'essentialAminoAcids', components: ['phenylalanine', 'tyrosine'], reference: who(25) },
  { id: 'threonine', label: 'Threonine', group: 'essentialAminoAcids', components: ['threonine'], reference: who(15) },
  { id: 'tryptophan', label: 'Tryptophan', group: 'essentialAminoAcids', components: ['tryptophan'], reference: who(4) },
  { id: 'valine', label: 'Valine', group: 'essentialAminoAcids', components: ['valine'], reference: who(26) },
];

/**
 * Essential nutrients with a published reference that `dailysummary.csv` has no
 * column for. Listed so the radar can say they were left out rather than imply
 * the 31 spokes are the whole set.
 */
export const ESSENTIAL_NUTRIENTS_NOT_IN_EXPORT: readonly string[] = [
  'Biotin',
  'Choline',
  'Chloride',
  'Chromium',
  'Fluoride',
  'Iodine',
  'Molybdenum',
];

export const REFERENCE_SOURCE =
  'Vitamins and minerals: US National Academies DRIs (RDA, or AI where no RDA exists) for adults 31–50, via NIH ODS. Essential amino acids: WHO/FAO/UNU 2007 adult requirement, mg per kg body weight per day.';

/**
 * The reference amount in the unit of the spoke's export column, or undefined
 * when it needs a weight that was not given. Each fixed amount above is written
 * in that column's unit — Vitamin D in IU because the export is — and a test
 * pins every spoke's unit, so a renamed column cannot silently rescale one.
 */
export function referenceAmount(
  spoke: RadarSpokeDefinition,
  profile: ReferenceProfile,
  bodyWeightKg: number | undefined,
): number | undefined {
  if (spoke.reference.kind === 'fixed') return spoke.reference.amount[profile];
  if (bodyWeightKg === undefined) return undefined;
  // mg/kg × kg gives mg; the export's amino-acid columns are grams.
  return (spoke.reference.mgPerKg * bodyWeightKg) / 1000;
}
