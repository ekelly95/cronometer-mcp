import { cpSync, existsSync } from 'node:fs';

import { directoryIsPrivate, ensurePrivateDirectory, readLiveConfig, writeLiveConfig, type LiveConfig } from './config.js';
import { dpapiUnprotect, keyringFor } from './keyring.js';
import { LEGACY_KEYRING_SERVICE, KEYRING_SERVICE, configFile, dataDirectory, exportsDirectory, legacyDataDirectory } from './paths.js';

/**
 * Everything the server needs to start, gathered without putting a secret into
 * any process's environment: the password is read from the OS keyring into this
 * process's memory and handed to the live backend directly.
 *
 * Credentials already in the environment win, which is how a container or a
 * client config that sets CRONOMETER_USERNAME/PASSWORD itself keeps working.
 */

export interface Runtime {
  /** Passed to the live backend; never exported to child processes. */
  readonly environment: Record<string, string>;
  readonly timeZone: string;
  readonly exportDirectory: string | undefined;
  readonly dataDirectory: string;
  readonly source: 'environment' | 'saved-configuration' | 'none';
  /** Why live access will not work, when it will not. The server still starts. */
  readonly problem?: string;
}

const PASS_THROUGH = [
  'CRONOMETER_READ_ONLY',
  'CRONOMETER_APP_VERSION',
  'CRONOMETER_APP_BUILD',
  'CRONOMETER_APP_USER_AGENT',
  'CRONOMETER_APP_DEVICE',
] as const;

export function systemTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

/**
 * Moves a configuration written before the rename into place, once. The legacy
 * directory is copied rather than moved, so a still-registered older launcher
 * keeps working until it is replaced.
 */
export function migrateLegacy(environment: Readonly<NodeJS.ProcessEnv> = process.env): string | undefined {
  if (environment['CRONOMETER_DATA_DIR']?.trim()) return undefined;
  const current = dataDirectory(process.platform, environment);
  const legacy = legacyDataDirectory(process.platform, environment);
  if (existsSync(configFile(current)) || !existsSync(configFile(legacy))) return undefined;
  ensurePrivateDirectory(current);
  const config = readLiveConfig(configFile(legacy));
  if (config === undefined) return undefined;
  if (existsSync(exportsDirectory(legacy))) {
    cpSync(exportsDirectory(legacy), exportsDirectory(current), { recursive: true, errorOnExist: false, force: false });
  }
  if (config.credentialSource !== 'dpapi') {
    const keyring = keyringFor(config.credentialSource);
    const password = keyring.lookup(config.username, LEGACY_KEYRING_SERVICE);
    if (password !== undefined && keyring.lookup(config.username, KEYRING_SERVICE) === undefined) {
      keyring.store(config.username, password, KEYRING_SERVICE);
    }
  }
  writeLiveConfig(configFile(current), config);
  return `Moved the saved configuration from ${legacy} to ${current}.`;
}

export function readSecrets(config: LiveConfig): { readonly password: string; readonly totpSecret?: string } {
  if (config.credentialSource === 'dpapi') {
    if (config.passwordDpapi === undefined) throw new Error('The saved configuration has no password. Run `cronometer-mcp setup` again.');
    const password = dpapiUnprotect(config.passwordDpapi);
    return config.totpDpapi === undefined ? { password } : { password, totpSecret: dpapiUnprotect(config.totpDpapi) };
  }
  const keyring = keyringFor(config.credentialSource);
  const password = keyring.lookup(config.username, KEYRING_SERVICE) ?? keyring.lookup(config.username, LEGACY_KEYRING_SERVICE);
  if (password === undefined || password === '') {
    throw new Error(`No Cronometer password was found in the ${config.credentialSource === 'keychain' ? 'login Keychain' : 'Secret Service keyring'}. Run \`cronometer-mcp setup\` again.`);
  }
  if (!config.twoFactor) return { password };
  const totpSecret = keyring.lookup(`${config.username}#totp`, KEYRING_SERVICE);
  if (totpSecret === undefined) throw new Error('The account is set up for two-factor sign-in but its key is missing from the keyring. Run `cronometer-mcp setup` again.');
  return { password, totpSecret };
}

export function resolveRuntime(environment: Readonly<NodeJS.ProcessEnv> = process.env): Runtime {
  const directory = dataDirectory(process.platform, environment);
  const exportDirectory = environment['CRONOMETER_EXPORT_DIR']?.trim() || exportsDirectory(directory);
  const passed: Record<string, string> = {};
  for (const name of PASS_THROUGH) {
    const value = environment[name];
    if (value !== undefined) passed[name] = value;
  }

  if (environment['CRONOMETER_USERNAME'] && environment['CRONOMETER_PASSWORD']) {
    return {
      environment: {
        ...passed,
        CRONOMETER_LIVE_ENABLED: environment['CRONOMETER_LIVE_ENABLED'] ?? '',
        CRONOMETER_USERNAME: environment['CRONOMETER_USERNAME'],
        CRONOMETER_PASSWORD: environment['CRONOMETER_PASSWORD'],
        ...(environment['CRONOMETER_TOTP_SECRET'] ? { CRONOMETER_TOTP_SECRET: environment['CRONOMETER_TOTP_SECRET'] } : {}),
        ...(environment['CRONOMETER_DATA_DIR'] ? { CRONOMETER_DATA_DIR: directory } : {}),
      },
      timeZone: environment['CRONOMETER_TIMEZONE']?.trim() || systemTimeZone(),
      exportDirectory: environment['CRONOMETER_DATA_DIR'] || environment['CRONOMETER_EXPORT_DIR'] ? exportDirectory : undefined,
      dataDirectory: directory,
      source: 'environment',
      ...(environment['CRONOMETER_LIVE_ENABLED'] ? {} : { problem: 'Credentials are set in the environment but CRONOMETER_LIVE_ENABLED is not. Set it to 1 to accept the risk of unofficial access.' }),
    };
  }

  let config: LiveConfig | undefined;
  try {
    migrateLegacy(environment);
    config = readLiveConfig(configFile(directory));
  } catch (error) {
    return {
      environment: passed,
      timeZone: environment['CRONOMETER_TIMEZONE']?.trim() || systemTimeZone(),
      exportDirectory,
      dataDirectory: directory,
      source: 'none',
      problem: error instanceof Error ? error.message : String(error),
    };
  }
  if (config === undefined) {
    return {
      environment: passed,
      timeZone: environment['CRONOMETER_TIMEZONE']?.trim() || systemTimeZone(),
      exportDirectory,
      dataDirectory: directory,
      source: 'none',
      problem: 'Cronometer is not set up yet. Run `npx @ekelly95/cronometer-mcp setup` in a terminal.',
    };
  }
  if (!directoryIsPrivate(directory)) {
    return {
      environment: passed,
      timeZone: config.timezone,
      exportDirectory,
      dataDirectory: directory,
      source: 'none',
      problem: `The data directory ${directory} is readable by other accounts. Run \`chmod 700\` on it, or \`cronometer-mcp setup\` again.`,
    };
  }
  try {
    const secrets = readSecrets(config);
    return {
      environment: {
        ...passed,
        CRONOMETER_LIVE_ENABLED: '1',
        CRONOMETER_USERNAME: config.username,
        CRONOMETER_PASSWORD: secrets.password,
        ...(secrets.totpSecret === undefined ? {} : { CRONOMETER_TOTP_SECRET: secrets.totpSecret }),
        CRONOMETER_DATA_DIR: directory,
      },
      timeZone: config.timezone,
      exportDirectory,
      dataDirectory: directory,
      source: 'saved-configuration',
    };
  } catch (error) {
    return {
      environment: { ...passed, CRONOMETER_DATA_DIR: directory },
      timeZone: config.timezone,
      exportDirectory,
      dataDirectory: directory,
      source: 'none',
      problem: error instanceof Error ? error.message : String(error),
    };
  }
}
