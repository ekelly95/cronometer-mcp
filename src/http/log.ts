import { appendFileSync, existsSync, renameSync, statSync } from 'node:fs';

import { redactSecrets } from '../live/index.js';

/** One previous log is kept; past this size the current one becomes it. */
const MAXIMUM_LOG_BYTES = 5 * 1024 * 1024;

function rotateIfFull(path: string, maximumBytes: number): void {
  try {
    if (existsSync(path) && statSync(path).size > maximumBytes) {
      renameSync(path, `${path}.1`);
    }
  } catch {
    // A failed rotation must not cost the line being written; the append below
    // either succeeds into the oversized file or falls back to stderr.
  }
}

/**
 * Where the remote connector's diagnostics go.
 *
 * Started hidden by Task Scheduler, the server has no console, so stderr would
 * reach nobody and a failure would leave no trace. With a path, lines are
 * appended there instead. Every line is redacted on the way out, because a log
 * file outlives the process that wrote it.
 *
 * The size is checked on every write, not only at startup: the logon task runs
 * for weeks, and a check that happens once per boot is no limit at all.
 */
export function createLogger(
  path: string | undefined,
  maximumBytes = MAXIMUM_LOG_BYTES,
): (text: string) => void {
  if (path === undefined || path.trim() === '') {
    return (text) => {
      process.stderr.write(redactSecrets(text.endsWith('\n') ? text : `${text}\n`));
    };
  }
  return (text) => {
    const lines = text
      .split(/\r?\n/)
      .filter((line) => line !== '')
      .map((line) => `${new Date().toISOString()} ${redactSecrets(line)}\n`)
      .join('');
    if (lines === '') return;
    rotateIfFull(path, maximumBytes);
    try {
      appendFileSync(path, lines, { encoding: 'utf8', mode: 0o600 });
    } catch {
      process.stderr.write(lines);
    }
  };
}
