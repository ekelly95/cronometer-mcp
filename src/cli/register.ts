import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SERVER_NAME, defaultConfigPath, registerClaudeDesktopServer, type DesktopRegistration } from './desktop-config.js';

/**
 * Adding the server to the MCP clients on this machine. Each client is offered
 * only if it is installed, and an existing entry is reported rather than
 * replaced: it may be one the user configured on purpose.
 */

export interface LaunchCommand {
  readonly command: string;
  readonly args: readonly string[];
}

/**
 * How a client should start the server. From an npx cache the path is temporary,
 * so the client is told to run npx itself; from a real install, the absolute path
 * to this package's entry point, which starts faster and works offline.
 */
export function launchCommand(): LaunchCommand {
  const entry = fileURLToPath(new URL('./main.js', import.meta.url));
  if (/[\\/]_npx[\\/]/.test(entry)) {
    return { command: process.platform === 'win32' ? 'npx.cmd' : 'npx', args: ['-y', '@ekelly95/cronometer-mcp'] };
  }
  return { command: process.execPath, args: [entry] };
}

/**
 * The Node version manager that owns `executable`, if any. Their paths name one
 * Node version, so a client told to run that path breaks once the version is
 * switched or removed.
 */
export function versionManagedNode(executable: string): string | undefined {
  const path = executable.replace(/\\/g, '/');
  const managers: readonly (readonly [string, RegExp])[] = [
    ['nvm', /\/\.nvm\/versions\/|\/nvm\/v\d/i],
    ['fnm', /\/fnm(_multishells)?\/|\/\.fnm\//i],
    ['Volta', /\/\.?volta\/tools\/image\//i],
    ['asdf', /\/\.asdf\/installs\//],
    ['mise', /\/mise\/installs\//],
    ['n', /\/n\/versions\/node\//],
    ['nodenv', /\/\.nodenv\/versions\//],
  ];
  return managers.find(([, pattern]) => pattern.test(path))?.[0];
}

/** A line to print when the launch command depends on a version manager's Node, or undefined. */
export function launchWarning(launch: LaunchCommand): string | undefined {
  const manager = versionManagedNode(launch.command);
  if (manager === undefined) return undefined;
  return (
    `Note: ${launch.command} belongs to ${manager}, so it stops working when that Node version is switched or removed. ` +
    'If that happens, run setup again, or point the client at `npx -y @ekelly95/cronometer-mcp` instead.'
  );
}

function has(command: string): boolean {
  const probe = spawnSync(process.platform === 'win32' ? 'where' : 'sh', process.platform === 'win32' ? [command] : ['-c', `command -v ${command}`], {
    encoding: 'utf8',
    windowsHide: true,
  });
  return probe.status === 0;
}

export interface ClientResult {
  readonly client: string;
  readonly status: 'registered' | 'exists' | 'skipped' | 'failed';
  readonly message: string;
}

export function claudeCodeAvailable(): boolean {
  return has('claude');
}

export function registerClaudeCode(launch: LaunchCommand): ClientResult {
  const existing = spawnSync('claude', ['mcp', 'get', SERVER_NAME], { encoding: 'utf8', windowsHide: true, shell: process.platform === 'win32' });
  if (existing.status === 0) {
    return { client: 'Claude Code', status: 'exists', message: `Claude Code already has a server named ${SERVER_NAME}; left as it is.` };
  }
  const added = spawnSync('claude', ['mcp', 'add', '--scope', 'user', SERVER_NAME, '--', launch.command, ...launch.args], {
    encoding: 'utf8',
    windowsHide: true,
    shell: process.platform === 'win32',
  });
  return added.status === 0
    ? { client: 'Claude Code', status: 'registered', message: `Registered ${SERVER_NAME} with Claude Code (user scope).` }
    : { client: 'Claude Code', status: 'failed', message: `claude mcp add failed: ${(added.stderr || added.stdout).trim()}` };
}

export function codexAvailable(): boolean {
  return has('codex');
}

export function registerCodex(launch: LaunchCommand): ClientResult {
  const existing = spawnSync('codex', ['mcp', 'get', SERVER_NAME], { encoding: 'utf8', windowsHide: true, shell: process.platform === 'win32' });
  if (existing.status === 0) {
    return { client: 'Codex', status: 'exists', message: `Codex already has a server named ${SERVER_NAME}; left as it is.` };
  }
  const added = spawnSync('codex', ['mcp', 'add', SERVER_NAME, '--', launch.command, ...launch.args], {
    encoding: 'utf8',
    windowsHide: true,
    shell: process.platform === 'win32',
  });
  if (added.status !== 0) {
    return { client: 'Codex', status: 'failed', message: `codex mcp add failed: ${(added.stderr || added.stdout).trim()}` };
  }
  return {
    client: 'Codex',
    status: 'registered',
    message: `Registered ${SERVER_NAME} with Codex. To have Codex ask before every write, add default_tools_approval_mode = "writes" under [mcp_servers.${SERVER_NAME}] in ${join(homedir(), '.codex', 'config.toml')}.`,
  };
}

export function claudeDesktopAvailable(): boolean {
  const path = defaultConfigPath();
  return path !== undefined && existsSync(join(path, '..'));
}

export function registerClaudeDesktop(launch: LaunchCommand): ClientResult {
  let result: DesktopRegistration;
  try {
    result = registerClaudeDesktopServer({ configPath: defaultConfigPath(), command: launch.command, args: launch.args });
  } catch (error) {
    return { client: 'Claude Desktop', status: 'failed', message: error instanceof Error ? error.message : String(error) };
  }
  return { client: 'Claude Desktop', status: result.status, message: result.message + (result.status === 'registered' ? ' Restart Claude Desktop to load it.' : '') };
}
