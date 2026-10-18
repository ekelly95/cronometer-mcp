#!/usr/bin/env node

import { readFileSync } from 'node:fs';

import { serveStdio } from '@modelcontextprotocol/server/stdio';

import { CronometerBackend } from '../live/index.js';
import { buildServer } from '../mcp/server.js';
import { runDoctor } from './doctor.js';
import { closePrompts } from './prompt.js';
import { runRemoteSetup, runServeHttp } from './remote.js';
import { resolveRuntime } from './runtime.js';
import { runSetup } from './setup.js';

const HELP = `cronometer-mcp — an MCP server for your Cronometer account

Usage:
  cronometer-mcp                 Run the MCP server over stdio (what MCP clients start)
  cronometer-mcp setup           Save your Cronometer sign-in and add the server to MCP clients
  cronometer-mcp doctor          Check the setup and the sign-in
  cronometer-mcp remote-setup    Configure the HTTPS connector for claude.ai and the phone apps
  cronometer-mcp serve-http      Run that connector (normally started by a user service)
  cronometer-mcp --version

Environment (all optional):
  CRONOMETER_READ_ONLY=1         Offer no tool that can change the account
  CRONOMETER_USERNAME / CRONOMETER_PASSWORD / CRONOMETER_TOTP_SECRET
                                 Sign in from the environment instead of the saved setup
                                 (also set CRONOMETER_LIVE_ENABLED=1)
  CRONOMETER_TIMEZONE            Diary timezone (default: the saved setup, else this computer's)
  CRONOMETER_DATA_DIR            Where the setup, sessions and exports live
`;

function version(): string {
  return (JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }).version;
}

function serve(): void {
  const runtime = resolveRuntime();
  if (runtime.problem !== undefined) process.stderr.write(`[cronometer-mcp] ${runtime.problem}\n`);
  serveStdio(() =>
    buildServer({
      configuration: { timeZone: runtime.timeZone, exportDirectory: runtime.exportDirectory },
      bridge: new CronometerBackend({
        environment: runtime.environment,
        timeZone: runtime.timeZone,
        ...(runtime.problem === undefined ? {} : { setupProblem: runtime.problem }),
      }),
    }),
  );
}

async function main(argv: readonly string[]): Promise<number | undefined> {
  const [command, ...rest] = argv;
  switch (command) {
    case undefined:
    case 'serve':
      serve();
      return undefined;
    case 'setup':
      return runSetup({ register: !rest.includes('--no-register') }).finally(closePrompts);
    case 'doctor':
      return runDoctor();
    case 'remote-setup':
      return runRemoteSetup().finally(closePrompts);
    case 'serve-http':
      runServeHttp();
      return undefined;
    case '--version':
    case '-v':
      process.stdout.write(`${version()}\n`);
      return 0;
    case '--help':
    case '-h':
    case 'help':
      process.stdout.write(HELP);
      return 0;
    default:
      process.stderr.write(`Unknown command: ${command}\n\n${HELP}`);
      return 2;
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    if (code !== undefined) process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  },
);
