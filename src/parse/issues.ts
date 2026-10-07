/** The six files a Cronometer export can contain (DATA_MODEL.md §1). */
export const EXPORT_FILE_NAMES = [
  'servings.csv',
  'dailysummary.csv',
  'biometrics.csv',
  'exercises.csv',
  'notes.csv',
  'fasts.csv',
] as const;

export type ExportFileName = (typeof EXPORT_FILE_NAMES)[number];

export type ParseIssueCode =
  /** A column the file must have was not in its header. */
  | 'missing-column'
  /**
   * One nutrient column was not in the daily summary's header. Not fatal: that
   * nutrient reads as Missing everywhere and the other sixty are unaffected. Kept
   * apart from `missing-column` so a caller can refuse on the one and not the other.
   */
  | 'missing-nutrient-column'
  /** The row has a different number of fields than the header. */
  | 'field-count'
  /** A quoted field was never closed; everything from there on is unreadable. */
  | 'unterminated-quote'
  | 'invalid-date'
  | 'invalid-time'
  /** `Amount` did not match the number-space-unit rule. */
  | 'invalid-amount'
  /** A cell that should hold a plain number held something else. */
  | 'invalid-number'
  /** A nutrient cell held text. Recorded as Missing; the issue is the trace. */
  | 'unreadable-nutrient'
  /** `Completed` held neither `true` nor `false`. */
  | 'unrecognised-completed'
  /** Rows of one day disagreed about `Completed`. */
  | 'inconsistent-completed'
  /** A field the row cannot do without was empty. */
  | 'empty-required-field'
  /** A second `Total` row turned up for a day that already had one. */
  | 'duplicate-total-row';

/**
 * A defect in one row, located precisely enough to go and look at it.
 *
 * Deliberately carries no cell content. `Food Name` and `Note` are untrusted free
 * text on their way to a language model (CLAUDE.md), and an error message is a
 * channel like any other — quoting the offending value back would carry the
 * payload with it. `column` is always one of our own expected column names, never
 * a string read from the file.
 */
export interface ParseIssue {
  readonly file: string;
  /** 1-based physical line in the source file where the record starts. */
  readonly line: number;
  readonly code: ParseIssueCode;
  readonly column: string | undefined;
  /** Fixed explanatory text plus structural facts. Never file content. */
  readonly detail: string;
}

/**
 * What a parser returns. Rows that could be read and defects that were found,
 * side by side: one bad row does not stop the import (BUILD_PLAN.md M1 §7).
 */
export interface ParseResult<T> {
  readonly rows: readonly T[];
  readonly issues: readonly ParseIssue[];
}

export function issue(
  file: string,
  line: number,
  code: ParseIssueCode,
  detail: string,
  column?: string,
): ParseIssue {
  return { file, line, code, column, detail };
}
