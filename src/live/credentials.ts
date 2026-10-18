/**
 * The account this connector signs in as.
 *
 * Read from the environment the launcher builds, on demand rather than at
 * startup, so a server with no credentials still starts and can say what is
 * missing: listing tools, reading a downloaded export and reporting status need
 * no account at all.
 */

export interface Credentials {
  readonly username: string;
  readonly password: string;
  /** Base32 key for accounts with two-factor authentication. */
  readonly totpSecret?: string;
}

export const SECRET_ENVIRONMENT_VARIABLES = [
  'CRONOMETER_USERNAME',
  'CRONOMETER_PASSWORD',
  'CRONOMETER_TOTP_SECRET',
] as const;

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);

export function liveEnabled(environment: Readonly<NodeJS.ProcessEnv> = process.env): boolean {
  return TRUTHY.has((environment['CRONOMETER_LIVE_ENABLED'] ?? '').trim().toLowerCase());
}

export function credentialsConfigured(environment: Readonly<NodeJS.ProcessEnv> = process.env): boolean {
  return Boolean(environment['CRONOMETER_USERNAME']) && Boolean(environment['CRONOMETER_PASSWORD']);
}

export function readCredentials(environment: Readonly<NodeJS.ProcessEnv> = process.env): Credentials {
  if (!liveEnabled(environment)) {
    throw new Error(
      'Live access is disabled. Run `cronometer-mcp setup` to enable it deliberately, or set CRONOMETER_LIVE_ENABLED=1.',
    );
  }
  const username = environment['CRONOMETER_USERNAME']?.trim();
  const password = environment['CRONOMETER_PASSWORD'];
  if (username === undefined || username === '' || password === undefined || password === '') {
    throw new Error('No Cronometer credentials are configured. Run `cronometer-mcp setup`.');
  }
  const totpSecret = environment['CRONOMETER_TOTP_SECRET']?.trim();
  return totpSecret === undefined || totpSecret === ''
    ? { username, password }
    : { username, password, totpSecret };
}
