import { CronometerBackend } from '../live/index.js';
import { ensurePrivateDirectory, writeLiveConfig, type CredentialSource, type LiveConfig } from './config.js';
import { dpapiProtect, keyringFor } from './keyring.js';
import { KEYRING_SERVICE, configFile, dataDirectory, exportsDirectory } from './paths.js';
import { ask, askHidden, confirm } from './prompt.js';
import {
  claudeCodeAvailable,
  claudeDesktopAvailable,
  codexAvailable,
  launchCommand,
  registerClaudeCode,
  registerClaudeDesktop,
  registerCodex,
  type ClientResult,
} from './register.js';
import { systemTimeZone } from './runtime.js';

const RISK = `
Cronometer has no public API. This connector signs in with your own username and
password and uses the same private interfaces as Cronometer's mobile app and
website. That is unofficial: it can stop working whenever Cronometer changes
those interfaces, and Cronometer could treat automated access as a breach of its
terms and restrict the account. Nothing is sent anywhere except cronometer.com.
Your password is kept in this computer's own credential store.
`;

function credentialSource(): CredentialSource {
  if (process.platform === 'win32') return 'dpapi';
  if (process.platform === 'darwin') return 'keychain';
  return 'libsecret';
}

function validTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

export async function runSetup(options: { readonly register: boolean }): Promise<number> {
  process.stdout.write(`Cronometer MCP setup\n${RISK}\n`);
  const enable = await ask('Type ENABLE to accept that and turn on live access');
  if (enable !== 'ENABLE') {
    process.stdout.write('Live access was not enabled. Nothing was saved.\n');
    return 1;
  }

  const source = credentialSource();
  if (source !== 'dpapi' && !keyringFor(source).available()) {
    process.stderr.write(
      source === 'libsecret'
        ? 'secret-tool was not found. Install libsecret-tools (Debian/Ubuntu) or libsecret (Arch/Fedora), and make sure GNOME Keyring or KDE Wallet is running.\n'
        : 'The macOS `security` tool was not found.\n',
    );
    return 1;
  }

  const username = await ask('Cronometer email');
  if (username === '' || username.length > 320 || /[\r\n]/.test(username)) {
    process.stderr.write('A Cronometer email is required.\n');
    return 1;
  }
  const password = await askHidden('Cronometer password (not shown)');
  if (password === '') {
    process.stderr.write('A password is required.\n');
    return 1;
  }
  process.stdout.write('\nIf the account uses two-factor sign-in, paste the authenticator key (the base32 text shown when it was set up).\n');
  const totpSecret = (await askHidden('Two-factor key, or leave blank')).replace(/\s/g, '');
  let timezone = await ask('Diary timezone', systemTimeZone());
  while (!validTimezone(timezone)) timezone = await ask('That is not a timezone name. Diary timezone (e.g. America/New_York)', systemTimeZone());

  const directory = dataDirectory();
  ensurePrivateDirectory(directory);
  ensurePrivateDirectory(exportsDirectory(directory));

  process.stdout.write('\nChecking the sign-in… ');
  const backend = new CronometerBackend({
    environment: {
      CRONOMETER_LIVE_ENABLED: '1',
      CRONOMETER_USERNAME: username,
      CRONOMETER_PASSWORD: password,
      ...(totpSecret === '' ? {} : { CRONOMETER_TOTP_SECRET: totpSecret }),
      CRONOMETER_DATA_DIR: directory,
    },
    timeZone: timezone,
    diagnostics: () => {},
  });
  try {
    const { value } = await backend.call('check_connection', {});
    process.stdout.write('signed in.\n');
    const accountZone = (value as { account_timezone?: unknown }).account_timezone;
    if (typeof accountZone === 'string' && accountZone !== timezone) {
      process.stdout.write(`Note: Cronometer reports the account's timezone as ${accountZone}, not ${timezone}. Dates like "today" follow ${timezone}.\n`);
    }
  } catch (error) {
    process.stdout.write('failed.\n');
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\nNothing was saved; run setup again once the details are right.\n`);
    return 1;
  }

  // Only now, with the sign-in proven, does anything reach the credential store.
  let config: LiveConfig = { username, timezone, credentialSource: source, twoFactor: totpSecret !== '' };
  if (source === 'dpapi') {
    config = { ...config, passwordDpapi: dpapiProtect(password), ...(totpSecret === '' ? {} : { totpDpapi: dpapiProtect(totpSecret) }) };
  } else {
    const keyring = keyringFor(source);
    keyring.store(username, password, KEYRING_SERVICE);
    if (totpSecret !== '') keyring.store(`${username}#totp`, totpSecret, KEYRING_SERVICE);
  }
  writeLiveConfig(configFile(directory), config);
  process.stdout.write(`Saved. Configuration and session caches live in ${directory}.\n`);

  if (options.register) {
    const launch = launchCommand();
    const results: ClientResult[] = [];
    if (claudeCodeAvailable() && (await confirm('Add to Claude Code?', true))) results.push(registerClaudeCode(launch));
    if (claudeDesktopAvailable() && (await confirm('Add to Claude Desktop?', true))) results.push(registerClaudeDesktop(launch));
    if (codexAvailable() && (await confirm('Add to Codex?', false))) results.push(registerCodex(launch));
    for (const result of results) process.stdout.write(`• ${result.message}\n`);
    if (results.length === 0) {
      process.stdout.write(`\nTo add it to an MCP client yourself, run: ${[launch.command, ...launch.args].join(' ')}\n`);
    }
  }
  process.stdout.write('\nDone. `cronometer-mcp doctor` checks the setup at any time.\n');
  return 0;
}
