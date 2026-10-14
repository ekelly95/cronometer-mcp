// Validates live-config.json and prints the fields a launcher needs.
//
// The Windows launcher does this in PowerShell because it has to decrypt a DPAPI
// blob in the same breath, and that code is load-bearing today. This exists for the
// shell launcher, which has no JSON parser it can rely on and should not grow a
// dependency on `jq` — node is already required to run the server at all.
//
// It never reads or prints the password. On Windows the ciphertext is in this file
// and the launcher decrypts it; on macOS and Linux the file holds no secret and the
// password comes from the Keychain or the Secret Service keyring.
//
// Output is three lines in a fixed order — username, timezone, credential source —
// so the caller can read them without a parser. Every value is validated to contain
// no carriage return, line feed or NUL first, which is what makes that safe.

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const CREDENTIAL_SOURCES = ['dpapi', 'keychain', 'libsecret'];

const CONTROL_CHARACTERS = /[\r\n\0]/;

/**
 * Returns { username, timezone, credentialSource }, or throws with a message meant
 * for someone reading a terminal. A corrupted configuration must fail here rather
 * than reach the network with nonsense in it.
 */
export function readLiveConfig(text) {
  let config;
  try {
    config = JSON.parse(text);
  } catch {
    throw new Error('The saved Cronometer configuration is not valid JSON.');
  }
  if (typeof config !== 'object' || config === null || Array.isArray(config)) {
    throw new Error('The saved Cronometer configuration is not a JSON object.');
  }

  if (config.version !== 1) {
    throw new Error('The saved Cronometer configuration has an unrecognised version.');
  }
  if (config.live_enabled !== true) {
    throw new Error('Live access is disabled in the saved Cronometer configuration.');
  }

  const username = config.username;
  if (
    typeof username !== 'string' ||
    username.trim() === '' ||
    username.length > 320 ||
    CONTROL_CHARACTERS.test(username)
  ) {
    throw new Error('The saved Cronometer username is invalid.');
  }

  const timezone = config.timezone;
  if (
    typeof timezone !== 'string' ||
    timezone.trim() === '' ||
    timezone.length > 100 ||
    CONTROL_CHARACTERS.test(timezone)
  ) {
    throw new Error('The saved Cronometer diary timezone is invalid.');
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
  } catch {
    throw new Error(`The saved Cronometer diary timezone is not a real timezone: ${timezone}`);
  }

  // Absent means Windows: configurations written before this field existed are all
  // DPAPI ones, and defaulting keeps them working untouched.
  const credentialSource = config.credential_source ?? 'dpapi';
  if (!CREDENTIAL_SOURCES.includes(credentialSource)) {
    throw new Error(`The saved Cronometer configuration names an unknown credential store: ${credentialSource}`);
  }

  return { username, timezone, credentialSource };
}

// pathToFileURL rather than string-building the URL: on Windows a path becomes
// file:///C:/... and hand-assembly produces two slashes instead of three, so the shim
// never runs and the caller gets a silent success. That exact bug shipped once here.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const path = process.argv[2];
  if (path === undefined) {
    console.error('Usage: read-live-config.mjs <path-to-live-config.json>');
    process.exit(2);
  }
  try {
    const { username, timezone, credentialSource } = readLiveConfig(readFileSync(path, 'utf8'));
    process.stdout.write(`${username}\n${timezone}\n${credentialSource}\n`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
