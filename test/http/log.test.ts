import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createLogger } from '../../src/http/log.js';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function logPath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'cronometer-log-'));
  directories.push(directory);
  return join(directory, 'remote.log');
}

describe('remote connector log', () => {
  it('rotates while running, not only at startup', () => {
    // The logon task runs for weeks; a size check made once per boot is no limit.
    const path = logPath();
    const log = createLogger(path, 200);

    for (let line = 0; line < 20; line += 1) log(`line ${line} ${'x'.repeat(40)}`);

    expect(existsSync(`${path}.1`)).toBe(true);
    // One write past the limit at most, and the newest line is in the current file.
    expect(readFileSync(path, 'utf8').length).toBeLessThan(200 + 100);
    expect(readFileSync(path, 'utf8')).toContain('line 19');
  });

  it('rotates a log that was already over the limit when the server started', () => {
    const path = logPath();
    writeFileSync(path, 'x'.repeat(500));
    createLogger(path, 200)('first line after a restart');
    expect(readFileSync(`${path}.1`, 'utf8')).toBe('x'.repeat(500));
    expect(readFileSync(path, 'utf8')).toContain('first line after a restart');
  });

  it('redacts the credentials before a line reaches the file', () => {
    const path = logPath();
    const previous = process.env['CRONOMETER_PASSWORD'];
    process.env['CRONOMETER_PASSWORD'] = 'correct-horse-battery';
    try {
      createLogger(path)('login failed with correct-horse-battery');
    } finally {
      if (previous === undefined) delete process.env['CRONOMETER_PASSWORD'];
      else process.env['CRONOMETER_PASSWORD'] = previous;
    }
    expect(readFileSync(path, 'utf8')).not.toContain('correct-horse-battery');
  });
});
