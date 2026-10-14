import { describe, expect, it } from 'vitest';

// @ts-expect-error -- plain ESM setup script, deliberately outside the TypeScript build.
import { readLiveConfig } from '../../scripts/lib/read-live-config.mjs';

/**
 * The shell launcher trusts this to reject a corrupted configuration before anything
 * reaches the network. The Windows launcher makes the same checks in PowerShell, so
 * these are also the specification the two are meant to agree on.
 */

const VALID = {
  version: 1,
  live_enabled: true,
  timezone: 'America/New_York',
  username: 'someone@example.invalid',
  credential_source: 'keychain',
};

const encode = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({ ...VALID, ...overrides });

describe('a configuration that is fine', () => {
  it('returns the three fields a launcher needs', () => {
    expect(readLiveConfig(encode())).toEqual({
      username: 'someone@example.invalid',
      timezone: 'America/New_York',
      credentialSource: 'keychain',
    });
  });

  it('treats a missing credential source as Windows DPAPI', () => {
    // Every configuration written before that field existed is a Windows one, so
    // defaulting keeps them working rather than demanding a re-run of setup.
    const { credential_source: _omitted, ...withoutField } = VALID;
    expect(readLiveConfig(JSON.stringify(withoutField)).credentialSource).toBe('dpapi');
  });

  it('accepts the Linux Secret Service as a credential source', () => {
    expect(readLiveConfig(encode({ credential_source: 'libsecret' })).credentialSource).toBe(
      'libsecret',
    );
  });

  it('never returns anything resembling a password', () => {
    const result = readLiveConfig(encode({ password_dpapi: 'ciphertext-that-must-not-leak' }));
    expect(JSON.stringify(result)).not.toContain('ciphertext-that-must-not-leak');
    expect(Object.keys(result)).toEqual(['username', 'timezone', 'credentialSource']);
  });
});

describe('a configuration that is not', () => {
  it.each([
    ['not JSON at all', 'this is not json'],
    ['a JSON array', '["nope"]'],
    ['a bare string', '"nope"'],
    ['null', 'null'],
  ])('refuses %s', (_label, text) => {
    expect(() => readLiveConfig(text)).toThrow();
  });

  it.each([
    ['an unknown version', { version: 2 }],
    ['live access switched off', { live_enabled: false }],
    ['live access as a string', { live_enabled: 'true' }],
    ['no username', { username: '' }],
    ['a whitespace username', { username: '   ' }],
    ['a numeric username', { username: 12345 }],
    ['an over-long username', { username: 'a'.repeat(321) }],
    ['no timezone', { timezone: '' }],
    ['an over-long timezone', { timezone: 'a'.repeat(101) }],
    ['a timezone that is not real', { timezone: 'Mars/Olympus_Mons' }],
    ['an unknown credential store', { credential_source: 'passwords-in-a-text-file' }],
  ])('refuses %s', (_label, overrides) => {
    expect(() => readLiveConfig(encode(overrides))).toThrow();
  });

  it.each([
    ['a carriage return', 'some\rone@example.invalid'],
    ['a line feed', 'some\none@example.invalid'],
    ['a NUL', 'some\0one@example.invalid'],
  ])('refuses a username containing %s', (_label, username) => {
    // The launcher reads these back as newline-separated lines, so a username
    // carrying a newline would be read as two fields. Refusing is what makes that
    // format safe rather than merely convenient.
    expect(() => readLiveConfig(encode({ username }))).toThrow();
  });

  it('refuses a timezone containing a line feed', () => {
    expect(() => readLiveConfig(encode({ timezone: 'America/\nNew_York' }))).toThrow();
  });
});
