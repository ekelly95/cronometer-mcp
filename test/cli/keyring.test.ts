import { spawnSync } from 'node:child_process';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { dpapiProtect, dpapiUnprotect } from '../../src/cli/keyring.js';

vi.mock('node:child_process', () => ({ spawnSync: vi.fn() }));

const spawn = vi.mocked(spawnSync);
const SECRET = 'pässwörd✓';
const base64 = (text: string): string => Buffer.from(text, 'utf8').toString('base64');

/** Answers each PowerShell call in turn. */
function powershell(...stdouts: string[]): void {
  for (const stdout of stdouts) {
    spawn.mockReturnValueOnce({ status: 0, stdout, stderr: '', pid: 1, output: [], signal: null } as never);
  }
}

afterEach(() => {
  spawn.mockReset();
});

describe('DPAPI', () => {
  it('passes the secret to PowerShell as base64, so no console code page can alter it', () => {
    powershell('01000000d08c9ddf\r\n', base64(SECRET));
    expect(dpapiProtect(SECRET)).toBe('01000000d08c9ddf');

    expect(spawn).toHaveBeenCalledTimes(2);
    const [protect, readBack] = spawn.mock.calls;
    expect(protect?.[0]).toBe('powershell.exe');
    expect(protect?.[2]).toMatchObject({ input: base64(SECRET) });
    expect(String((protect?.[1] as string[]).at(-1))).toContain('FromBase64String');
    expect(readBack?.[2]).toMatchObject({ input: '01000000d08c9ddf' });
    expect(String((readBack?.[1] as string[]).at(-1))).toContain('ToBase64String');
  });

  it('decodes what it reads back', () => {
    powershell(`${base64(SECRET)}\r\n`);
    expect(dpapiUnprotect('01000000d08c9ddf')).toBe(SECRET);
  });

  it('refuses a secret that comes back altered, so setup saves nothing', () => {
    powershell('01000000d08c9ddf', base64('p?ssw?rd?'));
    expect(() => dpapiProtect(SECRET)).toThrow('did not decrypt back to the same text');
  });
});
