import type { CalendarDay } from '../domain/calendar.js';
import { parseCalendarDay } from '../domain/calendar.js';
import { readCompleted, TOTAL_ROW_LABEL, type Completed } from '../domain/diary.js';
import type { DailySummaryDay, DailySummaryGroup } from '../domain/entries.js';
import { readMeasuredCell, type NutrientValue } from '../domain/nutrient.js';
import { NUTRIENTS, nutrientTable, type NutrientId, type NutrientTable } from '../domain/nutrients.js';
import { cell, mapColumns } from './columns.js';
import { readCsv } from './csv.js';
import { issue, type ParseIssue, type ParseResult } from './issues.js';
import { checkFieldCount } from './rows.js';

/** The spine columns. The 61 nutrient columns are looked up by name separately. */
export const DAILY_SUMMARY_COLUMNS = ['Date', 'Group', 'Completed'];

interface DayUnderConstruction {
  readonly date: CalendarDay;
  readonly groups: DailySummaryGroup[];
  reportedTotal: NutrientTable | undefined;
  completed: Completed;
}

/**
 * `dailysummary.csv` — the only source of nutrient data in the export, and the
 * one file that is a wide aggregate rather than a stream of events.
 *
 * Two things it does differently from the other five:
 *
 * It uses `Date` where everything else uses `Day`. DATA_MODEL.md §2 flags this as
 * a real inconsistency that a generic column mapper silently drops, so the name
 * is stated here rather than shared.
 *
 * Its `Group` column holds diary groups *plus* a `Total` row per day. The Total
 * is lifted out into its own field instead of being left among the groups —
 * summing a day that still contains it double-counts everything (DATA_MODEL.md
 * §5 rule 1), and with the two separated that mistake is not available.
 *
 * Nutrient columns are looked up by name and are individually optional. If an
 * export drops one, that nutrient is `Missing` everywhere and the absence is
 * reported once; refusing the whole file over one column would throw away sixty
 * good ones. Extra columns we do not recognise are ignored.
 */
export function parseDailySummary(
  text: string,
  file = 'dailysummary.csv',
): ParseResult<DailySummaryDay> {
  const doc = readCsv(text);
  const header = doc.header;
  const issues: ParseIssue[] = [];

  if (header === undefined) {
    return { rows: [], issues: [issue(file, 1, 'missing-column', 'file has no header row')] };
  }

  const columns = mapColumns(header, DAILY_SUMMARY_COLUMNS);
  if (columns.missing.length > 0) {
    return {
      rows: [],
      issues: columns.missing.map((name) =>
        issue(file, header.line, 'missing-column', 'column not found in header', name),
      ),
    };
  }

  const nutrientColumns: { readonly id: NutrientId; readonly csvHeader: string }[] = [];
  for (const nutrient of NUTRIENTS) {
    if (columns.index.has(nutrient.csvHeader)) {
      nutrientColumns.push({ id: nutrient.id, csvHeader: nutrient.csvHeader });
    } else {
      issues.push(
        issue(
          file,
          header.line,
          'missing-nutrient-column',
          'nutrient column not in this export; it will read as Missing everywhere',
          nutrient.csvHeader,
        ),
      );
    }
  }

  const days = new Map<string, DayUnderConstruction>();

  for (const record of doc.records) {
    const widthIssue = checkFieldCount(record, columns, file);
    if (widthIssue !== undefined) {
      issues.push(widthIssue);
      continue;
    }

    const date = parseCalendarDay(cell(record, columns, 'Date'));
    if (date === undefined) {
      issues.push(issue(file, record.line, 'invalid-date', 'not an ISO calendar date', 'Date'));
      continue;
    }

    const completed = readCompleted(cell(record, columns, 'Completed'));
    if (completed === 'unrecognised') {
      issues.push(
        issue(
          file,
          record.line,
          'unrecognised-completed',
          "neither the string 'true' nor the string 'false'",
          'Completed',
        ),
      );
    }

    const found = new Map<NutrientId, NutrientValue>();
    for (const nutrient of nutrientColumns) {
      const read = readMeasuredCell(cell(record, columns, nutrient.csvHeader));
      if (read.kind === 'present') {
        found.set(nutrient.id, read.value);
        continue;
      }
      if (read.kind === 'unreadable') {
        // Recorded as Missing so coverage stays truthful, with an issue as the
        // trace of why. The row's other sixty nutrients are still good.
        issues.push(
          issue(
            file,
            record.line,
            'unreadable-nutrient',
            'cell is neither empty nor a plain decimal number',
            nutrient.csvHeader,
          ),
        );
      }
    }
    const nutrients = nutrientTable(found);

    let day = days.get(date);
    if (day === undefined) {
      day = { date, groups: [], reportedTotal: undefined, completed };
      days.set(date, day);
    } else if (day.completed !== completed) {
      issues.push(
        issue(
          file,
          record.line,
          'inconsistent-completed',
          "row disagrees with an earlier row for the same date; the day's first value is kept",
          'Completed',
        ),
      );
    }

    const group = cell(record, columns, 'Group');
    if (group === TOTAL_ROW_LABEL) {
      if (day.reportedTotal !== undefined) {
        issues.push(
          issue(file, record.line, 'duplicate-total-row', 'date already had a Total row', 'Group'),
        );
        continue;
      }
      day.reportedTotal = nutrients;
      continue;
    }

    day.groups.push({ group, nutrients });
  }

  if (doc.unterminatedQuoteAtLine !== undefined) {
    issues.push(
      issue(file, doc.unterminatedQuoteAtLine, 'unterminated-quote', 'quoted field never closed'),
    );
  }

  // Days in the order the file introduced them; DATA_MODEL.md §8 question 4
  // leaves multi-day ordering unverified, so nothing is re-sorted here.
  const rows: DailySummaryDay[] = [...days.values()].map((day) => ({
    date: day.date,
    groups: day.groups,
    reportedTotal: day.reportedTotal,
    completed: day.completed,
  }));

  return { rows, issues };
}
