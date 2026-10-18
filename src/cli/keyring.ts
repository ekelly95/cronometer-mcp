import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

import { KEYRING_SERVICE } from './paths.js';

/**
 * The operating system's own credential store, reached through the tool each
 * platform ships: `secret-tool` (the Secret Service: GNOME Keyring or KDE Wallet)
 * on Linux, `security` (the login Keychain) on macOS, and DPAPI through
 * PowerShell on Windows. Secrets go in on standard input, never on a command line
 * another process could read.
 */

export interface Keyring {
  readonly name: string;
  available(): boolean;
  store(account: string, secret: string, service?: string): void;
  lookup(account: string, service?: string): string | undefined;
}

/**
 * MCP clients often start servers with a pared-down environment, and the one
 * variable `secret-tool` cannot work without — the session bus address — is
 * usually among what is dropped. The per-user bus socket is at a fixed place on
 * systemd machines, so it is supplied when missing.
 */
function keyringEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  if (process.platform === 'linux' && !environment['DBUS_SESSION_BUS_ADDRESS'] && typeof process.getuid === 'function') {
    const socket = `/run/user/${process.getuid()}/bus`;
    if (existsSync(socket)) environment['DBUS_SESSION_BUS_ADDRESS'] = `unix:path=${socket}`;
  }
  return environment;
}

function run(command: string, args: readonly string[], input?: string): { readonly ok: boolean; readonly stdout: string; readonly stderr: string } {
  const result = spawnSync(command, args, {
    input,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 60_000,
    env: keyringEnvironment(),
  });
  if (result.error !== undefined) return { ok: false, stdout: '', stderr: result.error.message };
  return { ok: result.status === 0, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function onPath(command: string): boolean {
  const probe = process.platform === 'win32' ? run('where', [command]) : run('sh', ['-c', `command -v ${command}`]);
  return probe.ok;
}

export const secretTool: Keyring = {
  name: 'libsecret',
  available: () => onPath('secret-tool'),
  store(account, secret, service = KEYRING_SERVICE) {
    const result = run('secret-tool', ['store', `--label=Cronometer MCP (${account})`, 'service', service, 'account', account], secret);
    if (!result.ok) throw new Error(`Could not save to the Secret Service keyring: ${result.stderr.trim() || 'secret-tool failed'}. Is a keyring (GNOME Keyring or KDE Wallet) running and unlocked?`);
  },
  lookup(account, service = KEYRING_SERVICE) {
    const result = run('secret-tool', ['lookup', 'service', service, 'account', account]);
    return result.ok && result.stdout !== '' ? result.stdout.replace(/\n$/, '') : undefined;
  },
};

export const macKeychain: Keyring = {
  name: 'keychain',
  available: () => process.platform === 'darwin' && onPath('security'),
  store(account, secret, service = KEYRING_SERVICE) {
    // `security -i` reads its commands from standard input, so the secret travels
    // there instead of on a command line visible in the process table.
    const quote = (value: string): string => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    const command = `add-generic-password -U -s ${quote(service)} -a ${quote(account)} -w ${quote(secret)}\n`;
    const result = run('security', ['-i'], command);
    if (!result.ok || this.lookup(account, service) !== secret) {
      throw new Error(`Could not save to the login Keychain: ${result.stderr.trim() || 'the saved value did not read back'}.`);
    }
  },
  lookup(account, service = KEYRING_SERVICE) {
    const result = run('security', ['find-generic-password', '-s', service, '-a', account, '-w']);
    return result.ok && result.stdout !== '' ? result.stdout.replace(/\n$/, '') : undefined;
  },
};

const POWERSHELL = 'powershell.exe';
/**
 * Windows PowerShell decodes standard input and encodes standard output in the
 * console code page, not UTF-8, so a password with any non-ASCII character would
 * be protected or returned altered. The secret therefore crosses the pipe as
 * base64 of its UTF-8 bytes, which every code page carries unchanged. (DPAPI's
 * own ciphertext is hex, so it is safe as it is.)
 */
const toBase64 = (text: string): string => Buffer.from(text, 'utf8').toString('base64');
/**
 * `console` is how 1.0.1 and earlier passed secrets: through the code page. A
 * non-ASCII secret was saved as whatever PowerShell decoded, and only reading it
 * back through the same code page restores it, so those configurations keep it.
 */
export type DpapiTransport = 'base64' | 'console';
const fromBase64 = (text: string): string => Buffer.from(text.trim(), 'base64').toString('utf8');

/**
 * DPAPI ciphertext for a secret, decryptable only by this Windows account. The
 * ciphertext is decrypted again before it is returned, so a secret that would
 * not come back intact is never saved.
 */
export function dpapiProtect(secret: string): string {
  const script =
    '$s = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())); ' +
    '$secure = ConvertTo-SecureString -String $s -AsPlainText -Force; ' +
    '[Console]::Out.Write((ConvertFrom-SecureString -SecureString $secure))';
  const result = run(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', script], toBase64(secret));
  if (!result.ok || result.stdout.trim() === '') throw new Error(`Could not protect the password with DPAPI: ${result.stderr.trim()}`);
  const ciphertext = result.stdout.trim();
  if (dpapiUnprotect(ciphertext) !== secret) {
    throw new Error('Could not protect the password with DPAPI: it did not decrypt back to the same text.');
  }
  return ciphertext;
}

export function dpapiUnprotect(ciphertext: string, transport: DpapiTransport = 'base64'): string {
  const plain = '[Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)';
  const script =
    '$c = [Console]::In.ReadToEnd().Trim(); ' +
    '$secure = ConvertTo-SecureString -String $c; ' +
    '$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure); ' +
    `try { [Console]::Out.Write(${transport === 'base64' ? `[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(${plain}))` : plain}) } ` +
    'finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }';
  const result = run(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', script], ciphertext);
  if (!result.ok) throw new Error('Could not decrypt the saved password. It can only be read by the Windows account that saved it; run `cronometer-mcp setup` again.');
  return transport === 'base64' ? fromBase64(result.stdout) : result.stdout;
}

export function keyringFor(source: 'keychain' | 'libsecret'): Keyring {
  return source === 'keychain' ? macKeychain : secretTool;
}
