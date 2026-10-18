import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { DpapiTransport } from './keyring.js';

/**
 * live-config.json: who to sign in as and how, never the password itself (except
 * on Windows, where it is DPAPI ciphertext that only this Windows account can
 * decrypt). Read strictly: a corrupted file must fail here rather than reach the
 * network with nonsense in it.
 */

export const CREDENTIAL_SOURCES = ['dpapi', 'keychain', 'libsecret'] as const;
export type CredentialSource = (typeof CREDENTIAL_SOURCES)[number];

export interface LiveConfig {
  readonly username: string;
  readonly timezone: string;
  readonly credentialSource: CredentialSource;
  readonly twoFactor: boolean;
  /** DPAPI ciphertext, Windows only. */
  readonly passwordDpapi?: string;
  readonly totpDpapi?: string;
  /**
   * How the DPAPI secrets crossed PowerShell's pipes when they were saved. Absent
   * means through the console code page (1.0.1 and earlier), which must be read
   * back the same way to get the same text.
   */
  readonly dpapiTransport?: DpapiTransport;
}

const CONTROL = /[\r\n\0]/;

function validTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

export function parseLiveConfig(text: string): LiveConfig {
  let config: unknown;
  try {
    config = JSON.parse(text);
  } catch {
    throw new Error('The saved Cronometer configuration is not valid JSON. Run `cronometer-mcp setup` again.');
  }
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('The saved Cronometer configuration is not a JSON object.');
  }
  const record = config as Record<string, unknown>;
  if (record['version'] !== 1 && record['version'] !== 2) {
    throw new Error('The saved Cronometer configuration has an unrecognised version.');
  }
  if (record['live_enabled'] !== true) {
    throw new Error('Live access is disabled in the saved Cronometer configuration.');
  }
  const username = record['username'];
  if (typeof username !== 'string' || username.trim() === '' || username.length > 320 || CONTROL.test(username)) {
    throw new Error('The saved Cronometer username is invalid.');
  }
  const timezone = record['timezone'];
  if (typeof timezone !== 'string' || timezone.trim() === '' || timezone.length > 100 || CONTROL.test(timezone) || !validTimezone(timezone)) {
    throw new Error('The saved Cronometer diary timezone is invalid.');
  }
  // Absent means Windows: configurations written before this field existed were all DPAPI.
  const source = record['credential_source'] ?? 'dpapi';
  if (!CREDENTIAL_SOURCES.includes(source as CredentialSource)) {
    throw new Error(`The saved Cronometer configuration names an unknown credential store: ${String(source)}`);
  }
  const passwordDpapi = record['password_dpapi'];
  const totpDpapi = record['totp_dpapi'];
  return {
    username,
    timezone,
    credentialSource: source as CredentialSource,
    twoFactor: record['two_factor'] === true,
    ...(typeof passwordDpapi === 'string' ? { passwordDpapi } : {}),
    ...(typeof totpDpapi === 'string' ? { totpDpapi } : {}),
    ...(record['dpapi_transport'] === 'base64' ? { dpapiTransport: 'base64' as const } : {}),
  };
}

export function readLiveConfig(path: string): LiveConfig | undefined {
  if (!existsSync(path)) return undefined;
  return parseLiveConfig(readFileSync(path, 'utf8'));
}

export function writeLiveConfig(path: string, config: LiveConfig): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const body = {
    version: 2,
    live_enabled: true,
    username: config.username,
    timezone: config.timezone,
    credential_source: config.credentialSource,
    two_factor: config.twoFactor,
    ...(config.passwordDpapi === undefined ? {} : { password_dpapi: config.passwordDpapi }),
    ...(config.totpDpapi === undefined ? {} : { totp_dpapi: config.totpDpapi }),
    ...(config.dpapiTransport === undefined ? {} : { dpapi_transport: config.dpapiTransport }),
  };
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
}

/**
 * The data directory holds session caches and whole-diary exports, so on Unix it
 * must not be readable by anyone else. Windows protects %LOCALAPPDATA% per user
 * already, and `chmod` there sets no ACL, so the check is Unix-only.
 */
export function ensurePrivateDirectory(directory: string, platform: NodeJS.Platform = process.platform): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (platform === 'win32') return;
  const mode = statSync(directory).mode & 0o777;
  if (mode !== 0o700) chmodSync(directory, 0o700);
}

export function directoryIsPrivate(directory: string, platform: NodeJS.Platform = process.platform): boolean {
  if (platform === 'win32') return true;
  try {
    return (statSync(directory).mode & 0o777) === 0o700;
  } catch {
    return false;
  }
}
