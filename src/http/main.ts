#!/usr/bin/env node

import { readConfiguration } from '../config/index.js';
import { readRemoteConfiguration } from './config.js';
import { createLogger } from './log.js';
import { startRemoteServer } from './start.js';

/**
 * The remote connector, configured entirely from the environment — for
 * containers and service managers that set MCP_* and CRONOMETER_* themselves.
 * `cronometer-mcp serve-http` is the usual way in; it reads the saved setup.
 */

const log = createLogger(process.env['MCP_LOG_FILE']);

try {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[0].startsWith('CRONOMETER_') && entry[1] !== undefined),
  );
  startRemoteServer({ configuration: readConfiguration(), remote: readRemoteConfiguration(), environment, log });
} catch (error) {
  log(`Remote connector failed to start: ${error instanceof Error ? error.message : 'unknown error'}`);
  process.exitCode = 1;
}
