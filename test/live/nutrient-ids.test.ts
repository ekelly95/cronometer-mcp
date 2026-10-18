import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { NUTRIENTS } from '../../src/domain/nutrients.js';
import { MOBILE_NUTRIENT_IDS } from '../../src/live/nutrient-ids.js';

/**
 * Cronometer's nutrient catalogue as the mobile API serves it to every account:
 * reference data, the same for everyone, not anything from a diary.
 */
const CATALOG = JSON.parse(readFileSync(resolve('test', 'fixtures', 'mobile', 'nutrient-catalog.json'), 'utf8')) as {
  readonly id: number;
  readonly name: string;
  readonly unit: string;
}[];

describe('mobile nutrient ids', () => {
  it('point every modelled nutrient at the catalogue entry with its name and unit', () => {
    for (const nutrient of NUTRIENTS) {
      const entry = CATALOG.find((candidate) => candidate.id === MOBILE_NUTRIENT_IDS[nutrient.id]);
      expect(entry, nutrient.id).toBeDefined();
      // The export's header is "<name> (<unit>)"; the catalogue carries the two apart.
      expect(`${entry?.name} (${entry?.unit})`, nutrient.id).toBe(nutrient.csvHeader);
    }
  });

  it('never maps two nutrients to one id', () => {
    const ids = Object.values(MOBILE_NUTRIENT_IDS);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
