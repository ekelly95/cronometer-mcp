import {
  createMcpHandler,
  getOAuthProtectedResourceMetadataUrl,
  hostHeaderValidationResponse,
  oauthMetadataResponse,
  requireBearerAuth,
} from '@modelcontextprotocol/server';

import type { AppConfiguration } from '../config/index.js';
import { buildServer, type LiveCaller } from '../mcp/server.js';
import type { RemoteConfiguration } from './config.js';
import { AuthorizationServer, SCOPE } from './oauth/authorization-server.js';
import type { OAuthStore } from './oauth/store.js';

export interface RemoteAppOptions {
  readonly remote: Pick<RemoteConfiguration, 'publicUrl' | 'issuer' | 'ownerPasswordHash' | 'allowedHosts'>;
  readonly configuration: AppConfiguration;
  /** One bridge for every request: the helper process and its Cronometer session are shared. */
  readonly bridge: LiveCaller;
  readonly store: OAuthStore;
  readonly now?: () => number;
  /** One line per request. Paths only — query strings carry codes and state. */
  readonly log?: (line: string) => void;
}

export interface RemoteApp {
  readonly fetch: (request: Request) => Promise<Response>;
  readonly close: () => Promise<void>;
}

/**
 * The remote connector as one web-standard handler.
 *
 * Order matters: the Host check runs before anything else so a request aimed at
 * some other name never reaches the sign-in page; discovery documents are
 * public by design; the MCP endpoint answers nothing without a token.
 */
export function createRemoteApp(options: RemoteAppOptions): RemoteApp {
  const { remote, configuration, bridge, store } = options;
  const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));

  const authorization = new AuthorizationServer({
    issuer: remote.issuer,
    resource: remote.publicUrl,
    store,
    ownerPasswordHash: remote.ownerPasswordHash,
    ...(options.now === undefined ? {} : { now: options.now }),
  });

  const metadataOptions = {
    oauthMetadata: authorization.metadata,
    resourceServerUrl: remote.publicUrl,
    scopesSupported: [SCOPE],
    resourceName: 'Cronometer (personal)',
    dangerouslyAllowInsecureIssuerUrl: remote.publicUrl.protocol === 'http:',
  };

  const gate = requireBearerAuth({
    verifier: authorization.verifier,
    requiredScopes: [SCOPE],
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(remote.publicUrl),
    expectedResource: remote.publicUrl,
  });

  const mcp = createMcpHandler(
    () => buildServer({ bridge, configuration, ownsBridge: false }),
    {
      onerror: (error) => log(`MCP error: ${error.message}`),
    },
  );

  async function route(request: Request): Promise<Response> {
    const refusal = hostHeaderValidationResponse(request, [...remote.allowedHosts]);
    if (refusal !== undefined) return refusal;

    const discovery = oauthMetadataResponse(request, metadataOptions);
    if (discovery !== undefined) return discovery;

    const oauth = await authorization.handle(request);
    if (oauth !== undefined) return oauth;

    if (new URL(request.url).pathname === remote.publicUrl.pathname) {
      const auth = await gate(request);
      if (auth instanceof Response) return auth;
      return mcp.fetch(request, { authInfo: auth });
    }

    return new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }

  return {
    fetch: async (request: Request): Promise<Response> => {
      const started = Date.now();
      const response = await route(request);
      log(`${request.method} ${new URL(request.url).pathname} ${response.status} ${Date.now() - started}ms`);
      return response;
    },
    close: () => mcp.close(),
  };
}
