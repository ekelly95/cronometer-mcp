// Registers this MCP server in Claude Desktop's configuration file.
//
// Claude Desktop has no CLI for this, so its config has to be rewritten in place —
// and that file is not just a server list. It holds Desktop's own preferences,
// nested several levels deep. Losing one is losing something that was never ours,
// and a backup is a consolation rather than a defence.
//
// Only `cronometer-mcp setup` calls this; the MCP server itself never does.

import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export const SERVER_NAME = 'cronometer';

/** Where each platform's Claude Desktop keeps its configuration. */
export function defaultConfigPath(platform: NodeJS.Platform = process.platform, environment: Readonly<NodeJS.ProcessEnv> = process.env): string | undefined {
  if (platform === 'win32') {
    const appData = environment['APPDATA'];
    if (appData === undefined || appData === '') return undefined;
    return join(appData, 'Claude', 'claude_desktop_config.json');
  }
  if (platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  }
  return join(homedir(), '.config', 'Claude', 'claude_desktop_config.json');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Replaces a file by rename, retrying briefly on the transient Windows failures.
 *
 * Renaming *over* an existing file can fail with EPERM, EACCES or EBUSY when
 * something else holds it open for a moment — a virus scanner or the search indexer
 * reacting to the write that just happened. It is intermittent by nature, which is
 * the worst kind of bug to leave in a setup script: it would strand someone with a
 * half-registered client and no obvious reason why. A short bounded retry is the
 * standard answer, and this runs once during setup, so the cost of waiting is
 * nothing.
 */
function renameOverExisting(from: string, to: string, attempts = 5): void {
  const transient = new Set(['EPERM', 'EACCES', 'EBUSY']);
  for (let attempt = 1; ; attempt += 1) {
    try {
      renameSync(from, to);
      return;
    } catch (error) {
      if (attempt >= attempts || !transient.has((error as NodeJS.ErrnoException).code ?? '')) throw error;
      // Synchronous by design: the callers are setup scripts that must finish this
      // before reporting success, and there is nothing else for them to be doing.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, attempt * 50);
    }
  }
}

function timestamp(now: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  );
}

/**
 * Adds one server entry, or explains why it did not.
 *
 * Returns { status, message, backupPath }. `status` is 'registered', 'exists' (an
 * entry of this name was already there and was left alone) or 'skipped' (Claude
 * Desktop is not installed). Throws when the file exists but cannot be understood —
 * refusing is the only safe answer, because repairing someone else's config means
 * guessing what they meant.
 */
export interface DesktopRegistration {
  readonly status: 'registered' | 'exists' | 'skipped';
  readonly message: string;
  readonly backupPath?: string;
}

export function registerClaudeDesktopServer({
  configPath,
  command,
  args = [],
  env,
  serverName = SERVER_NAME,
  now = new Date(),
}: {
  readonly configPath: string | undefined;
  readonly command: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly serverName?: string;
  readonly now?: Date;
}): DesktopRegistration {
  if (typeof configPath !== 'string' || configPath === '') {
    throw new Error('A Claude Desktop configuration path is required.');
  }
  if (typeof command !== 'string' || command === '') {
    throw new Error('A launcher command is required.');
  }

  const directory = dirname(configPath);
  if (!existsSync(directory) || !statSync(directory).isDirectory()) {
    return {
      status: 'skipped',
      message: 'Claude Desktop is not installed for this account; skipped.',
    };
  }

  let originalText: string | undefined;
  let config: Record<string, unknown>;
  if (existsSync(configPath)) {
    originalText = readFileSync(configPath, 'utf8');
    if (originalText.trim() === '') {
      config = {};
    } else {
      let parsed: unknown;
      try {
        parsed = JSON.parse(originalText);
      } catch {
        throw new Error('claude_desktop_config.json is not valid JSON; it was left untouched.');
      }
      if (!isPlainObject(parsed)) {
        throw new Error('claude_desktop_config.json is not a JSON object; it was left untouched.');
      }
      config = parsed;
    }
  } else {
    originalText = undefined;
    config = {};
  }

  // Taken from the parsed object rather than the original text, so an absent file, an
  // empty one and a populated one all produce a comparable baseline.
  const baseline = JSON.stringify(config);
  const hadServersKey = Object.hasOwn(config, 'mcpServers');

  if (!hadServersKey) config['mcpServers'] = {};
  if (!isPlainObject(config['mcpServers'])) {
    throw new Error(
      'claude_desktop_config.json has an mcpServers value that is not an object; it was left untouched.',
    );
  }

  const servers = config['mcpServers'] as Record<string, unknown>;
  if (Object.hasOwn(servers, serverName)) {
    return {
      status: 'exists',
      message: `Claude Desktop already has an MCP server named ${serverName}; it was not overwritten.`,
    };
  }

  servers[serverName] = env === undefined ? { command, args: [...args] } : { command, args: [...args], env: { ...env } };
  const updatedText = `${JSON.stringify(config, null, 2)}\n`;

  const verified = JSON.parse(updatedText) as Record<string, unknown>;
  if (!isPlainObject(verified['mcpServers']) || !Object.hasOwn(verified['mcpServers'], serverName)) {
    throw new Error('The Claude Desktop configuration did not gain the server; nothing was written.');
  }

  // Comparing key names would only prove nothing was dropped, not that nothing was
  // altered — a preference silently rewritten by the round trip would pass that. So:
  // take the result, remove the one entry we added, and require what is left to be
  // identical to the original. Anything else is a bug here, and this file is Claude
  // Desktop's, not ours to experiment on.
  const residue = JSON.parse(updatedText) as Record<string, unknown>;
  const residueServers = residue['mcpServers'] as Record<string, unknown>;
  delete residueServers[serverName];
  if (!hadServersKey && Object.keys(residueServers).length === 0) delete residue['mcpServers'];
  if (JSON.stringify(residue) !== baseline) {
    throw new Error(
      'Rewriting the Claude Desktop configuration would have changed something other than adding this server; nothing was written.',
    );
  }

  let backupPath: string | undefined;
  if (originalText !== undefined) {
    backupPath = `${configPath}.backup-${timestamp(now)}`;
    writeFileSync(backupPath, originalText, 'utf8');
  }

  // Written to a scratch directory and moved into place, so a failure part-way
  // through cannot leave a half-written config behind.
  const staging = mkdtempSync(join(tmpdir(), 'cronometer-desktop-'));
  const temporary = join(staging, 'claude_desktop_config.json');
  try {
    writeFileSync(temporary, updatedText, 'utf8');
    renameOverExisting(temporary, configPath);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }

  return {
    status: 'registered',
    message:
      `Registered ${serverName} with Claude Desktop.` +
      (backupPath === undefined ? '' : ` The previous configuration was copied to ${backupPath.split(/[\\/]/).pop()}.`),
    ...(backupPath === undefined ? {} : { backupPath }),
  };
}
