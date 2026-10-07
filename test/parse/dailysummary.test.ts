import { describe, expect, it } from 'vitest';

import { MISSING, isPresent, present } from '../../src/domain/nutrient.js';
import { parseDailySummary } from '../../src/parse/dailysummary.js';
import { readFixture } from '../support/fixtures.js';

describe('gold-complete', () => {
  const parsed = parseDailySummary(readFixture('gold-complete', 'dailysummary.csv'));

  it('reads three days with no issues', () => {
    expect(parsed.issues).toEqual([]);
    expect(parsed.rows.map((d) => d.date)).toEqual(['2026-08-14', '2026-08-15', '2026-08-16']);
  });

  it('holds the Total row apart from the groups, so it cannot be summed twice', () => {
    const day = parsed.rows[1];
    expect(day?.groups.map((g) => g.group)).toEqual([
      'Breakfast',
      'Lunch',
      'Dinner',
      'Snacks',
      'Uncategorized',
    ]);
    expect(day?.groups.some((g) => g.group === 'Total')).toBe(false);
    expect(day?.reportedTotal).toBeDefined();
  });

  it('reads Completed as a string literal, never as a boolean', () => {
    expect(parsed.rows.map((d) => d.completed)).toEqual(['complete', 'incomplete', 'incomplete']);
  });

  it('gives every group a complete table of 61 nutrients', () => {
    for (const day of parsed.rows) {
      for (const group of day.groups) {
        expect(Object.keys(group.nutrients)).toHaveLength(61);
      }
    }
  });

  it('records measured zeros as Present(0), not as absence', () => {
    const breakfast = parsed.rows[0]?.groups[0];
    expect(breakfast?.nutrients.alcohol).toEqual(present(0, 2));
    expect(breakfast?.nutrients.alcohol.kind).toBe('present');
  });

  it('keeps the decimal precision M2 needs to size a rounding tolerance', () => {
    const niacin = parsed.rows[0]?.groups[0]?.nutrients.b3;
    if (niacin === undefined || !isPresent(niacin)) throw new Error('expected a value');
    expect(niacin.decimals).toBe(2);
  });
});

describe('missing-nutrients — an empty cell is not a zero', () => {
  const parsed = parseDailySummary(readFixture('missing-nutrients', 'dailysummary.csv'));
  const day = parsed.rows.find((d) => d.date === '2026-08-16');
  if (day === undefined) throw new Error('fixture lost its 2026-08-16');

  it('reads the DATA_MODEL section 4 table as a measured zero, two gaps, and a value', () => {
    expect(day.groups.map((g) => g.nutrients.omega3)).toEqual([
      present(0, 2),
      MISSING,
      MISSING,
      present(0.01, 2),
    ]);
  });

  it('does not conflate the measured zero with the gaps', () => {
    const [breakfast, lunch] = day.groups;
    expect(breakfast?.nutrients.omega3).not.toEqual(lunch?.nutrients.omega3);
    expect(breakfast?.nutrients.omega3.kind).toBe('present');
    expect(lunch?.nutrients.omega3.kind).toBe('missing');
  });

  it('reads niacin the same way', () => {
    expect(day.groups.map((g) => g.nutrients.b3)).toEqual([
      present(0.76, 2),
      MISSING,
      MISSING,
      present(0.02, 2),
    ]);
  });

  it("keeps Cronometer's own Total, which is what M2 has to argue with", () => {
    // Kept, not discarded: M2 compares it against a recomputed total and has to
    // tell benign rounding apart from missing summed as zero.
    expect(day.reportedTotal?.omega3).toEqual(present(0.01, 2));
    expect(day.reportedTotal?.b3).toEqual(present(0.79, 2));
    expect(day.reportedTotal?.protein).toEqual(present(181, 2));
  });

  it('records a nutrient no group reported as Missing in every group', () => {
    expect(day.groups.map((g) => g.nutrients.oxalate)).toEqual([
      MISSING,
      MISSING,
      MISSING,
      MISSING,
    ]);
    // While the export's own Total still says 0.00 for it.
    expect(day.reportedTotal?.oxalate).toEqual(present(0, 2));
  });

  it('leaves coverage differing per nutrient and per day', () => {
    const second = parsed.rows.find((d) => d.date === '2026-08-17');
    expect(second?.groups.filter((g) => g.nutrients.b3.kind === 'present')).toHaveLength(3);
    expect(day.groups.filter((g) => g.nutrients.b3.kind === 'present')).toHaveLength(2);
    expect(second?.groups.every((g) => g.nutrients.omega3.kind === 'present')).toBe(true);
  });
});

describe('malformed', () => {
  const parsed = parseDailySummary(readFixture('malformed', 'dailysummary.csv'));

  it('reads the good rows and reports the rest', () => {
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0]?.groups.map((g) => g.group)).toEqual([
      'Breakfast',
      'Lunch',
      'Snacks',
      'Second Breakfast',
    ]);
    expect(parsed.issues.length).toBeGreaterThan(0);
  });

  it('drops rows whose width does not match the header', () => {
    const widths = parsed.issues.filter((i) => i.code === 'field-count');
    expect(widths).toHaveLength(2); // the short Dinner row and the long Total row
    expect(parsed.rows[0]?.reportedTotal).toBeUndefined();
  });

  it('records an unreadable nutrient cell as Missing, and says which column', () => {
    const lunch = parsed.rows[0]?.groups.find((g) => g.group === 'Lunch');
    expect(lunch?.nutrients.b3).toEqual(MISSING); // the cell said 'N/A'
    expect(lunch?.nutrients.omega3).toEqual(MISSING); // the cell was a single space

    const unreadable = parsed.issues.filter((i) => i.code === 'unreadable-nutrient');
    expect(unreadable.map((i) => i.column)).toEqual(['B3 (Niacin) (mg)', 'Omega-3 (g)']);
    expect(unreadable.every((i) => i.file === 'dailysummary.csv')).toBe(true);
  });

  it('does not let an unreadable cell take the rest of its row down with it', () => {
    const lunch = parsed.rows[0]?.groups.find((g) => g.group === 'Lunch');
    expect(lunch?.nutrients.protein.kind).toBe('present');
    expect(lunch?.nutrients.energy.kind).toBe('present');
  });

  it("reports a Completed value that is neither 'true' nor 'false'", () => {
    const flagged = parsed.issues.filter((i) => i.code === 'unrecognised-completed');
    expect(flagged).toHaveLength(1); // the row saying FALSE
    expect(flagged[0]?.column).toBe('Completed');
  });

  it('reports rows of one day disagreeing about Completed', () => {
    expect(parsed.issues.some((i) => i.code === 'inconsistent-completed')).toBe(true);
  });

  it('reports an unparseable date and drops that row', () => {
    const dates = parsed.issues.filter((i) => i.code === 'invalid-date');
    expect(dates).toHaveLength(1);
    expect(parsed.rows.map((d) => d.date)).toEqual(['2026-08-16']);
  });
});

describe('an export missing a nutrient column', () => {
  it('reports the absence once and reads that nutrient as Missing everywhere', () => {
    const full = readFixture('gold-complete', 'dailysummary.csv');
    const withoutOmega3 = full
      .split('\n')
      .map((line, index) => {
        if (line === '') return line;
        const fields = line.split(',');
        // Omega-3 is the 43rd nutrient, so column index 2 + 42.
        expect(index === 0 ? fields[44] : true).toBeTruthy();
        fields.splice(44, 1);
        return fields.join(',');
      })
      .join('\n');

    const parsed = parseDailySummary(withoutOmega3);
    const absences = parsed.issues.filter((i) => i.code === 'missing-nutrient-column');
    expect(absences).toHaveLength(1);
    // Not the fatal code: a caller that refuses on `missing-column` must not
    // refuse a file over one nutrient.
    expect(parsed.issues.filter((i) => i.code === 'missing-column')).toEqual([]);
    expect(absences[0]?.column).toBe('Omega-3 (g)');

    expect(parsed.rows).toHaveLength(3);
    expect(parsed.rows[0]?.groups[0]?.nutrients.omega3).toEqual(MISSING);
    expect(parsed.rows[0]?.groups[0]?.nutrients.protein.kind).toBe('present');
  });

  it('refuses the file outright only if a spine column is absent', () => {
    const parsed = parseDailySummary('Group,Energy (kcal),Completed\nBreakfast,100.00,false\n');
    expect(parsed.rows).toEqual([]);
    expect(parsed.issues.map((i) => i.column)).toContain('Date');
  });
});
