import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { CronometerApiError, MobileClient } from '../../src/live/mobile/client.js';
import { FakeCronometer } from './fake-cronometer.js';

const CREDENTIALS = { username: 'person@example.com', password: 'correct horse' };
const directories: string[] = [];

function sessionPath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'cronometer-mobile-'));
  directories.push(directory);
  return join(directory, '.mobile-session.json');
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function client(fake: FakeCronometer, path?: string, credentials: typeof CREDENTIALS & { totpSecret?: string } = CREDENTIALS): MobileClient {
  return new MobileClient({ credentials: () => credentials, fetch: fake.fetch, ...(path === undefined ? {} : { sessionPath: path }) });
}

describe('the mobile API client', () => {
  it('signs in once and sends the session with every call', async () => {
    const fake = new FakeCronometer();
    const mobile = client(fake);
    await mobile.read('get_macro_target_templates');
    await mobile.read('get_macro_target_templates');
    expect(fake.logins).toBe(1);
    const call = fake.calls('/api/v2/get_macro_target_templates')[1];
    expect(call?.body).toMatchObject({ auth: { userId: 4242, token: 'token-1', api: 3, os: 'Android' } });
  });

  it('never sends a timezone at sign-in, because that would overwrite the account’s', async () => {
    const fake = new FakeCronometer();
    await client(fake).session();
    const login = fake.calls('/api/v2/login')[0]?.body as Record<string, unknown>;
    expect(login).toHaveProperty('timezone', null);
    expect(login).toHaveProperty('userCode', null);
  });

  it('sends a two-factor code when a secret is configured', async () => {
    const fake = new FakeCronometer();
    await client(fake, undefined, { ...CREDENTIALS, totpSecret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ' }).session();
    const login = fake.calls('/api/v2/login')[0]?.body as Record<string, unknown>;
    expect(login['userCode']).toMatch(/^\d{6}$/);
  });

  it('explains a two-factor account without a secret', async () => {
    const fake = new FakeCronometer({ login: () => ({ body: { result: 'FAIL', error: 'TOTP_CODE_REQUIRED' } }) });
    await expect(client(fake).session()).rejects.toThrow('two-factor');
  });

  it('says so when sign-ins are being rate-limited', async () => {
    const fake = new FakeCronometer({ login: () => ({ status: 429, body: {} }) });
    await expect(client(fake).session()).rejects.toThrow('rate-limiting');
  });

  it('shares one sign-in between calls that all find the session missing', async () => {
    const fake = new FakeCronometer();
    const mobile = client(fake);
    await Promise.all([mobile.session(), mobile.session(), mobile.session()]);
    expect(fake.logins).toBe(1);
  });

  it('caches the session in a private file and reuses it in the next process', async () => {
    const fake = new FakeCronometer();
    const path = sessionPath();
    await client(fake, path).read('get_macro_target_templates');
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ version: 1, username: CREDENTIALS.username, userId: 4242 });

    await client(fake, path).read('get_macro_target_templates');
    expect(fake.logins).toBe(1);
  });

  it('ignores a cached session that belongs to another account', async () => {
    const fake = new FakeCronometer();
    const path = sessionPath();
    writeFileSync(path, JSON.stringify({ version: 1, username: 'someone@else.test', userId: 1, token: 't', timezone: null }));
    await client(fake, path).read('get_macro_target_templates');
    expect(fake.logins).toBe(1);
  });

  it('signs in again and retries a read once when the session has expired', async () => {
    for (const expire of ['http-401', 'body-fail'] as const) {
      const fake = new FakeCronometer({ expire });
      const mobile = client(fake);
      await mobile.session();
      fake.expireSessions();
      await expect(mobile.read('get_macro_target_templates'), expire).resolves.toHaveProperty('templates');
      expect(fake.logins, expire).toBe(2);
    }
  });

  it('re-sends a write only when Cronometer refused it outright', async () => {
    const fake = new FakeCronometer({ expire: 'http-401' });
    const mobile = client(fake);
    await mobile.session();
    fake.expireSessions();
    await mobile.write('add_serving', { serving: {} });
    // Refused with 401 the first time, so the second send cannot be a duplicate.
    expect(fake.calls('/api/v2/add_serving')).toHaveLength(2);
  });

  it('never re-sends a write that failed any other way', async () => {
    const fake = new FakeCronometer({ expire: 'body-fail' });
    const mobile = client(fake);
    await mobile.session();
    fake.expireSessions();
    await expect(mobile.write('add_serving', { serving: {} })).rejects.toThrow(CronometerApiError);
    expect(fake.calls('/api/v2/add_serving')).toHaveLength(1);
    // The dead session was dropped, so the next attempt signs in rather than failing again.
    await mobile.write('add_serving', { serving: {} });
    expect(fake.logins).toBe(2);
  });

  it('keeps the account profile from sign-in: targets, catalogue and preferences', async () => {
    const fake = new FakeCronometer();
    const profile = await client(fake).profile();
    expect(profile.targets).toContainEqual({ id: 203, min: 150, max: null });
    expect(profile.prefs['weightUnit']).toBe('Pounds');
    expect(profile.nutrients.length).toBeGreaterThan(0);
  });

  it('reports the session token as a secret to redact', async () => {
    const fake = new FakeCronometer();
    const mobile = client(fake);
    await mobile.session();
    expect(mobile.secrets()).toEqual(['token-1']);
  });
});
