#!/usr/bin/env node

import { readConfiguration } from '../config/index.js';
import { LiveBridge } from '../live/index.js';
import { createRemoteApp } from './app.js';
import { readRemoteConfiguration } from './config.js';
import { createLogger } from './log.js';
import { serveFetch } from './node-adapter.js';
import { OAuthStore } from './oauth/store.js';
import { assertPasswordHash } from './password.js';

/**
 * The remote connector: the same tools as the stdio server, over Streamable HTTP
 * behind OAuth, for Claude's hosted apps. It listens on loopback only. Reaching
 * it from the internet is Tailscale Funnel's job, so nothing on the local network
 * can talk to it directly.
 */

const log = createLogger(process.env['MCP_LOG_FILE']);

try {
  const configuration = readConfiguration();
  const remote = readRemoteConfiguration();
  assertPasswordHash(remote.ownerPasswordHash);

  const bridge = new LiveBridge({ diagnostics: log });
  const store = new OAuthStore(remote.stateDirectory, { diagnostics: log });
  const app = createRemoteApp({ remote, configuration, bridge, store, log });
  const server = serveFetch(app.fetch, (error) => {
    log(`Request failed: ${error instanceof Error ? error.message : 'unknown error'}`);
  });

  server.on('error', (error) => {
    log(`Remote connector could not listen on 127.0.0.1:${remote.listenPort}: ${error.message}`);
    process.exit(1);
  });
  server.listen(remote.listenPort, '127.0.0.1', () => {
    log(`Remote connector listening on http://127.0.0.1:${remote.listenPort}; public endpoint ${remote.publicUrl.href}`);
  });

  let stopping = false;
  const stop = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    log('Remote connector stopping.');
    server.close();
    server.closeAllConnections();
    await Promise.allSettled([app.close(), bridge.close()]);
    process.exit(0);
  };
  process.on('SIGINT', () => void stop());
  process.on('SIGTERM', () => void stop());
} catch (error) {
  log(`Remote connector failed to start: ${error instanceof Error ? error.message : 'unknown error'}`);
  process.exitCode = 1;
}
