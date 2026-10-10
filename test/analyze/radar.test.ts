import { describe, expect, it } from 'vitest';

import { aggregateRange } from '../../src/analyze/coverage.js';
import { buildNutrientRadar, type RadarSpoke } from '../../src/analyze/radar.js';
import type { DailySummaryDay } from '../../src/domain/entries.js';
import { NUTRIENT_BY_ID } from '../../src/domain/nutrients.js';
import { RADAR_SPOKES } from '../../src/domain/reference-intakes.js';
import { parseDailySummary } from '../../src/parse/dailysummary.js';
import { readFixture } from '../support/fixtures.js';

function parsedDays(fixture: 'gold-complete' | 'missing-nutrients'): readonly DailySummaryDay[] {
  const parsed = parseDailySummary(readFixture(fixture, 'dailysummary.csv'));
  expect(parsed.issues).toEqual([]);
  return parsed.rows;
}

function spoke(spokes: readonly RadarSpoke[], id: string): RadarSpoke {
  const found = spokes.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`no spoke ${id}`);
  return found;
}

describe('micronutrient radar', () => {
  it('draws 31 spokes: 12 vitamins, 10 minerals, 9 essential amino acids', () => {
    const groups = RADAR_SPOKES.map((definition) => definition.group);
    expect(RADAR_SPOKES).toHaveLength(31);
    expect(groups.filter((group) => group === 'vitamins')).toHaveLength(12);
    expect(groups.filter((group) => group === 'minerals')).toHaveLength(10);
    expect(groups.filter((group) => group === 'essentialAminoAcids')).toHaveLength(9);
    expect(new Set(RADAR_SPOKES.map((definition) => definition.id)).size).toBe(31);
  });

  /**
   * The fixed references are written in the export column's unit. If Cronometer
   * renamed `Vitamin D (IU)` to µg, the 600 here would silently become a
   * reference forty times too high; this is where that change would surface.
   */
  it('pins the unit every fixed reference was written in', () => {
    const units = Object.fromEntries(
      RADAR_SPOKES.map((definition) => [
        definition.id,
        definition.components.map((id) => NUTRIENT_BY_ID[id].unit).join('+'),
      ]),
    );
    expect(units).toMatchObject({
      b12: 'µg',
      folate: 'µg',
      vitaminA: 'µg',
      vitaminD: 'IU',
      vitaminK: 'µg',
      selenium: 'µg',
      calcium: 'mg',
      methionineCystine: 'g+g',
      phenylalanineTyrosine: 'g+g',
    });
  });

  it('averages over logged days, never the calendar span', () => {
    const days = parsedDays('gold-complete');
    const radar = buildNutrientRadar(days, 'adult-male', 70);
    const total = aggregateRange(days).nutrients.vitaminC;
    if (total.kind !== 'value') throw new Error('fixture vitamin C should be complete');

    const vitaminC = spoke(radar.spokes, 'vitaminC');
    expect(radar.days).toHaveLength(3);
    expect(vitaminC).toMatchObject({ kind: 'measured', reference: { amount: 90, basis: 'RDA' } });
    if (vitaminC.kind !== 'measured') throw new Error('unreachable');
    expect(vitaminC.dailyAverage).toBeCloseTo(total.value / 3, 10);
    expect(vitaminC.percentOfReference).toBeCloseTo((total.value / 3 / 90) * 100, 10);
  });

  it('sums the paired amino acids and scales their reference by body weight', () => {
    const days = parsedDays('gold-complete');
    const aggregate = aggregateRange(days).nutrients;
    const radar = buildNutrientRadar(days, 'adult-female', 60);
    const pair = spoke(radar.spokes, 'methionineCystine');

    expect(pair.reference).toEqual({ amount: 0.9, basis: 'WHO-2007' });
    if (pair.kind !== 'measured') throw new Error('fixture amino acids should be complete');
    const expected =
      (aggregate.methionine.observedSubtotal + aggregate.cystine.observedSubtotal) / 3;
    expect(pair.dailyAverage).toBeCloseTo(expected, 10);
  });

  it('gives amino acids no reference, rather than a zero one, without a body weight', () => {
    const radar = buildNutrientRadar(parsedDays('gold-complete'), 'adult-male', undefined);
    for (const entry of radar.spokes) {
      if (entry.group !== 'essentialAminoAcids') {
        expect(entry.reference, entry.id).not.toBeNull();
        continue;
      }
      expect(entry.reference, entry.id).toBeNull();
      if (entry.kind === 'no-data') continue;
      const percent =
        entry.kind === 'measured' ? entry.percentOfReference : entry.atLeastPercentOfReference;
      expect(percent, entry.id).toBeNull();
    }
  });

  it('uses the profile’s own reference where the sexes differ', () => {
    const days = parsedDays('gold-complete');
    expect(spoke(buildNutrientRadar(days, 'adult-male', 70).spokes, 'iron').reference?.amount).toBe(8);
    expect(spoke(buildNutrientRadar(days, 'adult-female', 70).spokes, 'iron').reference?.amount).toBe(18);
  });

  it('reports an incompletely covered nutrient as a floor with no intake figure', () => {
    const radar = buildNutrientRadar(parsedDays('missing-nutrients'), 'adult-male', 70);
    const incomplete = radar.spokes.filter((entry) => entry.kind === 'incomplete');

    expect(incomplete.length).toBeGreaterThan(0);
    for (const entry of incomplete) {
      expect(entry).not.toHaveProperty('dailyAverage');
      expect(entry).not.toHaveProperty('percentOfReference');
      expect(entry).toHaveProperty('atLeastDailyAverage');
      expect(entry.coverage.groups.withData).toBeLessThan(entry.coverage.groups.total);
    }
  });

  describe('a nutrient column absent from the export', () => {
    function daysWithout(...columns: string[]): readonly DailySummaryDay[] {
      const lines = readFixture('gold-complete', 'dailysummary.csv').split('\n');
      const header = (lines[0] ?? '').split(',');
      const drop = new Set(columns.map((column) => header.indexOf(column)));
      expect(drop.has(-1)).toBe(false);
      const csv = lines
        .map((line) =>
          line === '' ? line : line.split(',').filter((_, index) => !drop.has(index)).join(','),
        )
        .join('\n');
      return parseDailySummary(csv).rows;
    }

    it('is a no-data spoke with no number at all, not an incomplete spoke at zero', () => {
      const radar = buildNutrientRadar(daysWithout('Selenium (µg)'), 'adult-male', 70);
      const selenium = spoke(radar.spokes, 'selenium');
      expect(selenium.kind).toBe('no-data');
      expect(selenium).not.toHaveProperty('atLeastDailyAverage');
      expect(selenium).not.toHaveProperty('atLeastPercentOfReference');
      expect(selenium.coverage.groups.withData).toBe(0);
      expect(spoke(radar.spokes, 'zinc').kind).toBe('measured');
    });

    it('leaves a pair as a floor when only one half is missing', () => {
      const radar = buildNutrientRadar(daysWithout('Cystine (g)'), 'adult-male', 70);
      const pair = spoke(radar.spokes, 'methionineCystine');
      expect(pair.kind).toBe('incomplete');
      if (pair.kind !== 'incomplete') throw new Error('unreachable');
      expect(pair.atLeastDailyAverage).toBeGreaterThan(0);
    });

    it('is no-data when both halves of a pair are missing', () => {
      const radar = buildNutrientRadar(
        daysWithout('Methionine (g)', 'Cystine (g)'),
        'adult-male',
        70,
      );
      expect(spoke(radar.spokes, 'methionineCystine').kind).toBe('no-data');
    });
  });

  it('refuses to average zero days', () => {
    expect(() => buildNutrientRadar([], 'adult-male', 70)).toThrow(RangeError);
  });
});
