import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { readRemoteConfiguration, type RemoteConfiguration } from '../http/config.js';
import { createLogger } from '../http/log.js';
import { hashPassword, MINIMUM_PASSWORD_LENGTH } from '../http/password.js';
import { startRemoteServer } from '../http/start.js';
import { ensurePrivateDirectory } from './config.js';
import { dataDirectory } from './paths.js';
import { ask, askHidden, confirm } from './prompt.js';
import { launchCommand, launchWarning } from './register.js';
import { resolveRuntime } from './runtime.js';

/**
 * The remote connector's own setup: a public HTTPS address (normally from
 * Tailscale Funnel), a loopback port, and an owner password stored only as a
 * scrypt hash. Everything lives under <data>/remote.
 */

const UNIT_NAME = 'cronometer-mcp-remote';
const LAUNCH_AGENT = 'io.github.ekelly95.cronometer-mcp-remote';

const remoteDirectory = (): string => join(dataDirectory(), 'remote');
const remoteConfigFile = (): string => join(remoteDirectory(), 'remote-config.json');

interface SavedRemote {
  readonly public_url: string;
  readonly listen_port: number;
  readonly owner_password_hash: string;
}

function tailscaleName(): string | undefined {
  const status = spawnSync('tailscale', ['status', '--json'], { encoding: 'utf8', windowsHide: true, timeout: 10_000 });
  if (status.status !== 0) return undefined;
  try {
    const name = (JSON.parse(status.stdout) as { Self?: { DNSName?: unknown } }).Self?.DNSName;
    return typeof name === 'string' && name !== '' ? name.replace(/\.$/, '') : undefined;
  } catch {
    return undefined;
  }
}

/** The remote configuration: MCP_* variables first, then the saved file. */
export function remoteConfiguration(environment: Readonly<NodeJS.ProcessEnv> = process.env): RemoteConfiguration {
  let saved: Partial<SavedRemote> = {};
  if (existsSync(remoteConfigFile())) {
    saved = JSON.parse(readFileSync(remoteConfigFile(), 'utf8')) as Partial<SavedRemote>;
  }
  return readRemoteConfiguration({
    MCP_STATE_DIR: join(remoteDirectory(), 'state'),
    ...(saved.public_url === undefined ? {} : { MCP_PUBLIC_URL: saved.public_url }),
    ...(saved.listen_port === undefined ? {} : { MCP_LISTEN_PORT: String(saved.listen_port) }),
    ...(saved.owner_password_hash === undefined ? {} : { MCP_OWNER_PASSWORD_HASH: saved.owner_password_hash }),
    ...Object.fromEntries(Object.entries(environment).filter(([name]) => name.startsWith('MCP_'))),
  });
}

export function runServeHttp(): void {
  const runtime = resolveRuntime();
  const logFile = process.env['MCP_LOG_FILE'] ?? join(remoteDirectory(), 'server.log');
  ensurePrivateDirectory(remoteDirectory());
  const log = createLogger(logFile, undefined, runtime.environment);
  try {
    startRemoteServer({
      configuration: { timeZone: runtime.timeZone, exportDirectory: runtime.exportDirectory },
      remote: remoteConfiguration(),
      environment: runtime.environment,
      ...(runtime.problem === undefined ? {} : { setupProblem: runtime.problem }),
      log,
    });
  } catch (error) {
    const message = `Remote connector failed to start: ${error instanceof Error ? error.message : 'unknown error'}`;
    log(message);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}

function systemdUnit(command: string, args: readonly string[]): string {
  const quote = (value: string): string => (/[\s"\\]/.test(value) ? `"${value.replace(/["\\]/g, '\\$&')}"` : value);
  return [
    '[Unit]',
    'Description=Cronometer MCP remote connector',
    'After=network-online.target',
    '',
    '[Service]',
    `ExecStart=${[command, ...args, 'serve-http'].map(quote).join(' ')}`,
    'Restart=on-failure',
    'RestartSec=10',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

function launchAgent(command: string, args: readonly string[]): string {
  const escape = (value: string): string => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const programArguments = [command, ...args, 'serve-http'].map((value) => `    <string>${escape(value)}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCH_AGENT}</string>
  <key>ProgramArguments</key>
  <array>
${programArguments}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
</dict>
</plist>
`;
}

export async function runRemoteSetup(): Promise<number> {
  process.stdout.write(`Remote connector setup

This lets claude.ai and the Claude phone apps use the connector by reaching this
computer over a public HTTPS address. Only someone who knows the owner password
you choose now can connect, and the server listens on 127.0.0.1 only; a tunnel
such as Tailscale Funnel carries traffic to it. It works while this computer is
on and you are signed in.

`);
  const runtime = resolveRuntime();
  if (runtime.source === 'none') {
    process.stderr.write(`${runtime.problem ?? 'Cronometer is not set up.'}\nRun \`cronometer-mcp setup\` first.\n`);
    return 1;
  }

  const host = tailscaleName();
  const publicUrl = await ask('Public MCP URL', host === undefined ? 'https://<this-machine>.<tailnet>.ts.net/mcp' : `https://${host}/mcp`);
  const portText = await ask('Local port', '8787');
  let password = '';
  while (password.length < MINIMUM_PASSWORD_LENGTH) {
    password = await askHidden(`Owner password (at least ${MINIMUM_PASSWORD_LENGTH} characters, not shown)`);
    if (password.length < MINIMUM_PASSWORD_LENGTH) continue;
    if ((await askHidden('Again, to confirm')) !== password) {
      process.stdout.write('Those did not match.\n');
      password = '';
    }
  }
  const saved: SavedRemote = { public_url: publicUrl, listen_port: Number(portText), owner_password_hash: await hashPassword(password) };
  // Validated through the same reader the server uses, before anything is written.
  readRemoteConfiguration({
    MCP_PUBLIC_URL: saved.public_url,
    MCP_LISTEN_PORT: String(saved.listen_port),
    MCP_OWNER_PASSWORD_HASH: saved.owner_password_hash,
    MCP_STATE_DIR: join(remoteDirectory(), 'state'),
  });
  ensurePrivateDirectory(remoteDirectory());
  const temporary = `${remoteConfigFile()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ version: 1, ...saved }, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, remoteConfigFile());
  process.stdout.write(`Saved to ${remoteConfigFile()}.\n\n`);

  const launch = launchCommand();
  if (process.platform === 'linux') {
    const directory = join(process.env['XDG_CONFIG_HOME'] || join(homedir(), '.config'), 'systemd', 'user');
    const unit = join(directory, `${UNIT_NAME}.service`);
    if (await confirm(`Write a systemd user service (${unit}) so it starts when you sign in?`, true)) {
      mkdirSync(directory, { recursive: true });
      writeFileSync(unit, systemdUnit(launch.command, launch.args));
      process.stdout.write(`Wrote ${unit}. Start it with:\n  systemctl --user daemon-reload && systemctl --user enable --now ${UNIT_NAME}\n`);
      const warning = launchWarning(launch);
      if (warning !== undefined) process.stdout.write(`${warning}\n`);
    }
  } else if (process.platform === 'darwin') {
    const plist = join(homedir(), 'Library', 'LaunchAgents', `${LAUNCH_AGENT}.plist`);
    if (await confirm(`Write a launch agent (${plist}) so it starts when you sign in?`, true)) {
      mkdirSync(join(homedir(), 'Library', 'LaunchAgents'), { recursive: true });
      writeFileSync(plist, launchAgent(launch.command, launch.args));
      process.stdout.write(`Wrote ${plist}. Start it with:\n  launchctl load ${plist}\n`);
    }
  } else {
    process.stdout.write(
      `To start it when you sign in, create a Task Scheduler task (trigger: at log on) that runs:\n  ${[launch.command, ...launch.args, 'serve-http'].join(' ')}\n`,
    );
  }
  process.stdout.write(`
Then publish the port with your tunnel. With Tailscale (MagicDNS and HTTPS turned on):
  tailscale funnel --bg ${saved.listen_port}

Finally, on claude.ai: Customize → Connectors → Add custom connector, URL ${saved.public_url},
leave the OAuth fields empty, and sign in with the owner password. Set every write tool
to "Needs approval" on the connector's page. REMOTE.md has the details.
`);
  return 0;
}
