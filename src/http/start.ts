import type { AppConfiguration } from '../config/index.js';
import { CronometerBackend } from '../live/index.js';
import { createRemoteApp } from './app.js';
import type { RemoteConfiguration } from './config.js';
import { serveFetch } from './node-adapter.js';
import { OAuthStore } from './oauth/store.js';
import { assertPasswordHash } from './password.js';

/**
 * The remote connector: the same tools as the stdio server, over Streamable HTTP
 * behind OAuth, for Claude's hosted apps. It listens on loopback only. Reaching
 * it from the internet is a tunnel's job (Tailscale Funnel, Cloudflare Tunnel),
 * so nothing on the local network can talk to it directly.
 */
export function startRemoteServer(options: {
  readonly configuration: AppConfiguration;
  readonly remote: RemoteConfiguration;
  readonly environment: Readonly<Record<string, string>>;
  readonly setupProblem?: string;
  readonly log: (line: string) => void;
}): void {
  const { configuration, remote, log } = options;
  assertPasswordHash(remote.ownerPasswordHash);

  const bridge = new CronometerBackend({
    environment: options.environment,
    timeZone: configuration.timeZone,
    diagnostics: log,
    ...(options.setupProblem === undefined ? {} : { setupProblem: options.setupProblem }),
  });
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
}
