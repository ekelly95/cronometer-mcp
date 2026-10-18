import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { parseLiveConfig, writeLiveConfig } from '../../src/cli/config.js';
import { dataDirectory, legacyDataDirectory } from '../../src/cli/paths.js';
import { resolveRuntime } from '../../src/cli/runtime.js';

/**
 * The server trusts this to reject a corrupted configuration before anything
 * reaches the network.
 */

const VALID = {
  version: 2,
  live_enabled: true,
  timezone: 'America/New_York',
  username: 'someone@example.invalid',
  credential_source: 'keychain',
};

const encode = (overrides: Record<string, unknown> = {}) => JSON.stringify({ ...VALID, ...overrides });
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('a configuration that is fine', () => {
  it('returns what the server needs and nothing secret', () => {
    expect(parseLiveConfig(encode())).toEqual({
      username: 'someone@example.invalid',
      timezone: 'America/New_York',
      credentialSource: 'keychain',
      twoFactor: false,
    });
  });

  it('still reads a version 1 file written before the rename', () => {
    expect(parseLiveConfig(encode({ version: 1, credential_source: 'libsecret' })).credentialSource).toBe('libsecret');
  });

  it('treats a missing credential source as Windows DPAPI', () => {
    const { credential_source: _omitted, ...withoutField } = VALID;
    expect(parseLiveConfig(JSON.stringify(withoutField)).credentialSource).toBe('dpapi');
  });

  it('round-trips through the writer with private permissions', () => {
    const directory = mkdtempSync(join(tmpdir(), 'cronometer-config-'));
    directories.push(directory);
    const path = join(directory, 'live-config.json');
    writeLiveConfig(path, { username: 'a@b.test', timezone: 'Europe/London', credentialSource: 'libsecret', twoFactor: true });
    expect(parseLiveConfig(readFileSync(path, 'utf8'))).toEqual({ username: 'a@b.test', timezone: 'Europe/London', credentialSource: 'libsecret', twoFactor: true });
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});

describe('a configuration that is not', () => {
  it.each([
    ['not JSON at all', 'this is not json'],
    ['a JSON array', '["nope"]'],
    ['null', 'null'],
  ])('refuses %s', (_label, text) => {
    expect(() => parseLiveConfig(text)).toThrow();
  });

  it.each([
    ['an unknown version', { version: 3 }],
    ['live access switched off', { live_enabled: false }],
    ['live access as a string', { live_enabled: 'true' }],
    ['no username', { username: '' }],
    ['a whitespace username', { username: '   ' }],
    ['an over-long username', { username: 'a'.repeat(321) }],
    ['a username with a line break', { username: 'some\none@example.invalid' }],
    ['a timezone that is not real', { timezone: 'Mars/Olympus_Mons' }],
    ['an unknown credential store', { credential_source: 'passwords-in-a-text-file' }],
  ])('refuses %s', (_label, overrides) => {
    expect(() => parseLiveConfig(encode(overrides))).toThrow();
  });
});

describe('where things live', () => {
  it('follows each platform’s per-user data location', () => {
    expect(dataDirectory('linux', { XDG_DATA_HOME: '/x/data' })).toBe(join('/x/data', 'cronometer-mcp'));
    expect(dataDirectory('win32', { LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local' })).toBe(join('C:\\Users\\a\\AppData\\Local', 'cronometer-mcp'));
    expect(dataDirectory('darwin', {})).toContain(join('Library', 'Application Support', 'cronometer-mcp'));
    expect(legacyDataDirectory('linux', { XDG_DATA_HOME: '/x/data' })).toBe(join('/x/data', 'CronometerPersonalMcp'));
  });

  it('lets CRONOMETER_DATA_DIR override it', () => {
    expect(dataDirectory('linux', { CRONOMETER_DATA_DIR: '/srv/cronometer' })).toBe('/srv/cronometer');
  });
});

describe('the runtime', () => {
  it('takes credentials from the environment first, and never invents consent', () => {
    const directory = mkdtempSync(join(tmpdir(), 'cronometer-runtime-'));
    directories.push(directory);
    const runtime = resolveRuntime({ CRONOMETER_USERNAME: 'a@b.test', CRONOMETER_PASSWORD: 'pw', CRONOMETER_TIMEZONE: 'Asia/Tokyo', CRONOMETER_DATA_DIR: directory });
    expect(runtime.source).toBe('environment');
    expect(runtime.timeZone).toBe('Asia/Tokyo');
    expect(runtime.environment['CRONOMETER_LIVE_ENABLED']).toBe('');
    expect(runtime.problem).toContain('CRONOMETER_LIVE_ENABLED');
    expect(resolveRuntime({ CRONOMETER_USERNAME: 'a', CRONOMETER_PASSWORD: 'b', CRONOMETER_LIVE_ENABLED: 'false', CRONOMETER_DATA_DIR: directory }).problem).toContain('CRONOMETER_LIVE_ENABLED');
  });

  it('accepts the "true" a Claude Desktop extension checkbox sends', () => {
    const directory = mkdtempSync(join(tmpdir(), 'cronometer-runtime-'));
    directories.push(directory);
    const runtime = resolveRuntime({ CRONOMETER_USERNAME: 'a', CRONOMETER_PASSWORD: 'b', CRONOMETER_LIVE_ENABLED: 'true', CRONOMETER_TIMEZONE: '', CRONOMETER_DATA_DIR: directory });
    expect(runtime.problem).toBeUndefined();
    expect(runtime.environment['CRONOMETER_DATA_DIR']).toBe(directory);
    expect(runtime.timeZone).not.toBe('');
  });

  it('says how to set up when there is nothing to use, and still starts', () => {
    const directory = mkdtempSync(join(tmpdir(), 'cronometer-runtime-'));
    directories.push(directory);
    const runtime = resolveRuntime({ CRONOMETER_DATA_DIR: directory });
    expect(runtime.source).toBe('none');
    expect(runtime.problem).toContain('setup');
    expect(runtime.environment).not.toHaveProperty('CRONOMETER_PASSWORD');
  });

  it('passes read-only mode through to the server', () => {
    const directory = mkdtempSync(join(tmpdir(), 'cronometer-runtime-'));
    directories.push(directory);
    const runtime = resolveRuntime({ CRONOMETER_USERNAME: 'a', CRONOMETER_PASSWORD: 'b', CRONOMETER_LIVE_ENABLED: '1', CRONOMETER_READ_ONLY: '1', CRONOMETER_DATA_DIR: directory });
    expect(runtime.environment['CRONOMETER_READ_ONLY']).toBe('1');
    expect(runtime.problem).toBeUndefined();
  });
});
