export const PUBLIC_URL_ENVIRONMENT_VARIABLE = 'MCP_PUBLIC_URL';
export const LISTEN_PORT_ENVIRONMENT_VARIABLE = 'MCP_LISTEN_PORT';
export const STATE_DIRECTORY_ENVIRONMENT_VARIABLE = 'MCP_STATE_DIR';
export const OWNER_PASSWORD_HASH_ENVIRONMENT_VARIABLE = 'MCP_OWNER_PASSWORD_HASH';

const DEFAULT_LISTEN_PORT = 8787;
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);

export interface RemoteConfiguration {
  /** The MCP endpoint exactly as it is entered in Claude, and the OAuth resource identifier. */
  readonly publicUrl: URL;
  /** The authorization server's issuer: the public URL's origin. */
  readonly issuer: URL;
  readonly listenPort: number;
  /** Where registered clients and token hashes are kept. */
  readonly stateDirectory: string;
  /** The owner password's scrypt hash, as written by scripts/lib/hash-password.mjs. */
  readonly ownerPasswordHash: string;
  /** Host header values accepted: the public name, plus loopback for local checks. */
  readonly allowedHosts: readonly string[];
}

export function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname);
}

function required(environment: Readonly<NodeJS.ProcessEnv>, name: string): string {
  const value = environment[name]?.trim();
  if (value === undefined || value === '') {
    throw new Error(`${name} is required for the remote connector. Start it through scripts\\run-mcp.ps1 -Transport http.`);
  }
  return value;
}

/**
 * The remote half of the configuration. Kept apart from `readConfiguration` so the
 * stdio server never reads, and so never needs, anything here.
 */
export function readRemoteConfiguration(
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
): RemoteConfiguration {
  let publicUrl: URL;
  try {
    publicUrl = new URL(required(environment, PUBLIC_URL_ENVIRONMENT_VARIABLE));
  } catch (error) {
    if (error instanceof TypeError) {
      throw new Error(`${PUBLIC_URL_ENVIRONMENT_VARIABLE} must be an absolute URL such as https://my-pc.example.ts.net/mcp.`);
    }
    throw error;
  }
  // Plain HTTP is accepted only for loopback, which is how the server is checked
  // before Funnel is in front of it. Anything public must be HTTPS: the tokens and
  // the owner password cross it.
  if (publicUrl.protocol !== 'https:' && !(publicUrl.protocol === 'http:' && isLoopbackHost(publicUrl.hostname))) {
    throw new Error(`${PUBLIC_URL_ENVIRONMENT_VARIABLE} must use https.`);
  }
  if (publicUrl.search !== '' || publicUrl.hash !== '' || publicUrl.username !== '' || publicUrl.password !== '') {
    throw new Error(`${PUBLIC_URL_ENVIRONMENT_VARIABLE} must not carry a query, fragment or credentials.`);
  }
  if (publicUrl.pathname === '/' || publicUrl.pathname.startsWith('/.well-known/')) {
    throw new Error(`${PUBLIC_URL_ENVIRONMENT_VARIABLE} needs a path for the MCP endpoint, such as /mcp.`);
  }

  const portText = environment[LISTEN_PORT_ENVIRONMENT_VARIABLE]?.trim();
  const listenPort = portText === undefined || portText === '' ? DEFAULT_LISTEN_PORT : Number(portText);
  if (!Number.isInteger(listenPort) || listenPort < 1 || listenPort > 65_535) {
    throw new Error(`${LISTEN_PORT_ENVIRONMENT_VARIABLE} must be a port number.`);
  }

  const ownerPasswordHash = required(environment, OWNER_PASSWORD_HASH_ENVIRONMENT_VARIABLE);
  if (!ownerPasswordHash.startsWith('scrypt$')) {
    throw new Error(`${OWNER_PASSWORD_HASH_ENVIRONMENT_VARIABLE} is not a hash written by scripts/lib/hash-password.mjs.`);
  }

  return Object.freeze({
    publicUrl,
    issuer: new URL(publicUrl.origin),
    listenPort,
    stateDirectory: required(environment, STATE_DIRECTORY_ENVIRONMENT_VARIABLE),
    ownerPasswordHash,
    allowedHosts: Object.freeze([...new Set([publicUrl.hostname, ...LOOPBACK_HOSTS])]),
  });
}
