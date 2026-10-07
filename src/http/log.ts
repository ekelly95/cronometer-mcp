import { appendFileSync, existsSync, renameSync, statSync } from 'node:fs';

import { redactSecrets } from '../live/index.js';

/** One previous log is kept; past this size the current one becomes it at startup. */
const MAXIMUM_LOG_BYTES = 5 * 1024 * 1024;

/**
 * Where the remote connector's diagnostics go.
 *
 * Started hidden by Task Scheduler, the server has no console, so stderr would
 * reach nobody and a failure would leave no trace. With a path, lines are
 * appended there instead. Every line is redacted on the way out, because a log
 * file outlives the process that wrote it.
 */
export function createLogger(path: string | undefined): (text: string) => void {
  if (path === undefined || path.trim() === '') {
    return (text) => {
      process.stderr.write(redactSecrets(text.endsWith('\n') ? text : `${text}\n`));
    };
  }
  if (existsSync(path) && statSync(path).size > MAXIMUM_LOG_BYTES) {
    renameSync(path, `${path}.1`);
  }
  return (text) => {
    const lines = text
      .split(/\r?\n/)
      .filter((line) => line !== '')
      .map((line) => `${new Date().toISOString()} ${redactSecrets(line)}\n`)
      .join('');
    if (lines === '') return;
    try {
      appendFileSync(path, lines, { encoding: 'utf8', mode: 0o600 });
    } catch {
      process.stderr.write(lines);
    }
  };
}
