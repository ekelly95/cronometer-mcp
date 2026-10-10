import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { aggregateDay, aggregateRange } from '../../src/analyze/coverage.js';
import { parseCalendarDay } from '../../src/domain/calendar.js';
import type { DailySummaryDay } from '../../src/domain/entries.js';
import { present } from '../../src/domain/nutrient.js';
import { nutrientTable, type NutrientId } from '../../src/domain/nutrients.js';
import { parseDailySummary } from '../../src/parse/dailysummary.js';
import { readFixture } from '../support/fixtures.js';

function parsedDays(fixture: 'gold-complete' | 'missing-nutrients'): readonly DailySummaryDay[] {
  const parsed = parseDailySummary(readFixture(fixture, 'dailysummary.csv'));
  expect(parsed.issues).toEqual([]);
  return parsed.rows;
}

function oneNutrientDay(
  nutrient: NutrientId,
  values: readonly number[],
  reportedTotal: number,
): DailySummaryDay {
  const date = parseCalendarDay('2026-08-16');
  if (date === undefined) throw new Error('test date is invalid');

  return {
    date,
    groups: values.map((value, index) => ({
      group: `Group ${index + 1}`,
      nutrients: nutrientTable(new Map([[nutrient, present(value, 2)]])),
    })),
    reportedTotal: nutrientTable(new Map([[nutrient, present(reportedTotal, 2)]])),
    completed: 'incomplete',
  };
}

describe('coverage-aware daily totals', () => {
  const missingDay = parsedDays('missing-nutrients').find((day) => day.date === '2026-08-16');
  if (missingDay === undefined) throw new Error('fixture lost its missing-data day');
  const result = aggregateDay(missingDay);

  it('does not report omega-3 as an intake value when half the groups are missing it', () => {
    const omega3 = result.nutrients.omega3;
    expect(omega3).toEqual(expect.objectContaining({
      kind: 'insufficient-data',
      observedSubtotal: 0.01,
      coverage: { withData: 2, total: 4, ratio: 0.5 },
    }));
    expect('value' in omega3).toBe(false);
  });

  it("classifies Cronometer's collapsed total as missing-as-zero", () => {
    expect(result.nutrients.omega3.comparison).toEqual(expect.objectContaining({
      kind: 'missing-as-zero',
      observedSubtotal: 0.01,
      reportedTotal: 0.01,
    }));
    expect(result.nutrients.b3.comparison).toEqual(expect.objectContaining({
      kind: 'missing-as-zero',
      observedSubtotal: 0.78,
      reportedTotal: 0.79,
    }));
  });

  it('reports a fully covered nutrient as a value and never doubles the Total row', () => {
    const energy = result.nutrients.energy;
    expect(energy.kind).toBe('value');
    if (energy.kind !== 'value') throw new Error('expected complete energy data');
    expect(energy.value).toBe(1870);
    expect(energy.coverage).toEqual({ withData: 4, total: 4, ratio: 1 });
  });
});

describe('reported Total diagnostics', () => {
  it('treats a complete, in-tolerance difference as benign rounding', () => {
    const result = aggregateDay(oneNutrientDay('b3', [0.76, 0.02], 0.79));
    expect(result.nutrients.b3.kind).toBe('value');
    expect(result.nutrients.b3.comparison).toEqual(expect.objectContaining({
      kind: 'rounding',
      observedSubtotal: 0.78,
      reportedTotal: 0.79,
      roundingTolerance: 0.01,
    }));
  });

  it('does not hide a complete difference beyond rounding tolerance', () => {
    const result = aggregateDay(oneNutrientDay('b3', [0.76, 0.02], 0.9));
    expect(result.nutrients.b3.comparison.kind).toBe('unexplained');
  });
});

describe('multi-day coverage', () => {
  const result = aggregateRange(parsedDays('missing-nutrients'));

  it('tracks coverage separately for every nutrient across groups and days', () => {
    expect(result.nutrients.b3.coverage).toEqual({
      groups: { withData: 5, total: 8, ratio: 0.625 },
      days: { withData: 0, total: 2, ratio: 0 },
    });
    expect(result.nutrients.omega3.coverage).toEqual({
      groups: { withData: 6, total: 8, ratio: 0.75 },
      days: { withData: 1, total: 2, ratio: 0.5 },
    });
  });

  it('keeps the strict default and permits an explicit, labelled lower threshold', () => {
    expect(result.nutrients.omega3.kind).toBe('insufficient-data');

    const relaxed = aggregateRange(parsedDays('missing-nutrients'), 0.75).nutrients.omega3;
    expect(relaxed.kind).toBe('value');
    if (relaxed.kind !== 'value') throw new Error('expected the selected threshold to pass');
    expect(relaxed.coverage.groups.ratio).toBe(0.75);
  });

  it('labels a day with a Total row and no groups as no-groups, not unexplained', () => {
    const totalOnly = oneNutrientDay('protein', [], 42);
    const day = aggregateDay(totalOnly).nutrients.protein;
    expect(day.kind).toBe('insufficient-data');
    expect(day.comparison).toEqual(expect.objectContaining({ kind: 'no-groups', reportedTotal: 42 }));
  });

  it('rejects thresholds that could turn no data into a value', () => {
    expect(() => aggregateRange([], 0)).toThrow(RangeError);
    expect(() => aggregateRange([], 1.01)).toThrow(RangeError);
  });
});

describe('the data path cannot silently default missing data to zero', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = join(here, '..', '..', 'src');
  // Everything a cell passes through on its way to the model, not only the
  // arithmetic: a `?? 0` in a parser or in the MCP layer invents data just as well.
  const directories = ['analyze', 'domain', 'parse', 'mcp'];

  /** Comments may quote the forbidden patterns to explain them; code may not. */
  const withoutComments = (source: string): string =>
    source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  const forbidden = [/\?\?\s*0(?![.\d])/, /\|\|\s*0(?![.\d])/, /Number\([^)]*\)\s*\|\|\s*0/];

  it.each(directories)('src/%s contains none of the numeric-default patterns this project forbids', (directory) => {
    const files = readdirSync(join(src, directory)).filter((name) => name.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(0);
    for (const name of files) {
      const code = withoutComments(readFileSync(join(src, directory, name), 'utf8'));
      for (const pattern of forbidden) {
        expect(code, `${directory}/${name}`).not.toMatch(pattern);
      }
    }
  });

  it('strips comments without hiding code', () => {
    expect(withoutComments('const x = cell ?? 0;')).toMatch(forbidden[0]!);
    expect(withoutComments('/** quoting `?? 0` */\n// and `|| 0`')).not.toMatch(forbidden[0]!);
    expect(withoutComments('// and `|| 0`')).not.toMatch(forbidden[1]!);
  });
});

describe('complete fixtures remain complete', () => {
  it('reports full per-nutrient coverage instead of one global claim', () => {
    const range = aggregateRange(parsedDays('gold-complete'));
    expect(range.nutrients.energy.coverage.groups.ratio).toBe(1);
    expect(range.nutrients.omega3.coverage.groups.ratio).toBe(1);
    expect(range.nutrients.protein.coverage.days.ratio).toBe(1);
  });
});
