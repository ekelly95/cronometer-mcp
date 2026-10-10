import { appendFileSync, existsSync, renameSync, statSync } from 'node:fs';

import { redactSecrets } from '../live/index.js';

/** One previous log is kept; past this size the current one becomes it. */
const MAXIMUM_LOG_BYTES = 5 * 1024 * 1024;

function currentSize(path: string): number {
  try {
    return existsSync(path) ? statSync(path).size : 0;
  } catch {
    return 0;
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
 * The size is tracked on every write, not only checked at startup: the logon
 * task runs for weeks, and a check that happens once per boot is no limit at
 * all. It is counted in memory from one stat at startup, so a write costs no
 * extra filesystem call.
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
  let size = currentSize(path);
  return (text) => {
    const lines = text
      .split(/\r?\n/)
      .filter((line) => line !== '')
      .map((line) => `${new Date().toISOString()} ${redactSecrets(line)}\n`)
      .join('');
    if (lines === '') return;
    if (size > maximumBytes) {
      try {
        renameSync(path, `${path}.1`);
        size = 0;
      } catch {
        // A failed rotation must not cost the line being written; it goes into
        // the oversized file instead, and rotation is tried again next time.
      }
    }
    try {
      appendFileSync(path, lines, { encoding: 'utf8', mode: 0o600 });
      size += Buffer.byteLength(lines, 'utf8');
    } catch {
      process.stderr.write(lines);
    }
  };
}
