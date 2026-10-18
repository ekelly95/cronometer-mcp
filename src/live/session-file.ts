import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';

/**
 * Session caches are credentials: whoever can read one is signed in as the user
 * until it expires. They are plain JSON, never anything that executes on load,
 * written atomically with mode 600 into the data directory the setup made private,
 * and read back only if they are a small regular file. A symlink is refused in
 * both directions, so the cache cannot be redirected to overwrite or leak
 * something else.
 */

const MAX_SESSION_BYTES = 256 * 1024;

export function readSessionFile(path: string): unknown {
  let metadata;
  try {
    metadata = lstatSync(path);
  } catch {
    return undefined;
  }
  if (!metadata.isFile() || metadata.size > MAX_SESSION_BYTES) {
    deleteSessionFile(path);
    return undefined;
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch {
    deleteSessionFile(path);
    return undefined;
  }
}

export function writeSessionFile(path: string, value: unknown): void {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    if (lstatSync(path).isSymbolicLink()) {
      throw new Error('Refusing to replace a session-cache symlink.');
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const temporary = join(directory, `.session-${randomBytes(6).toString('hex')}.tmp`);
  try {
    writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: 'wx' });
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function deleteSessionFile(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    // Best effort: a cache that cannot be removed is rejected again on the next read.
  }
}
