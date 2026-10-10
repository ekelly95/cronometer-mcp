import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createRemoteApp, type RemoteApp } from '../../src/http/app.js';
import { OAuthStore } from '../../src/http/oauth/store.js';
import { hashPassword } from '../../src/http/password.js';
import type { JsonObject, LiveMethod, LiveResult } from '../../src/live/index.js';
import type { LiveCaller } from '../../src/mcp/index.js';

export const BASE = 'https://my-pc.example.ts.net';
export const MCP_URL = `${BASE}/mcp`;
export const CLAUDE_CALLBACK = 'https://claude.ai/api/mcp/auth_callback';
export const OWNER_PASSWORD = 'correct horse battery staple';

/** Hashed once: scrypt is slow on purpose, and every test would otherwise pay for it. */
const OWNER_PASSWORD_HASH = hashPassword(OWNER_PASSWORD);

export class RecordingBridge implements LiveCaller {
  public readonly calls: LiveMethod[] = [];
  public closed = 0;

  public async call(method: LiveMethod, _params: JsonObject = {}): Promise<LiveResult> {
    this.calls.push(method);
    return { value: { method, accepted: true }, unverified: false };
  }

  public async close(): Promise<void> {
    this.closed += 1;
  }
}

/**
 * A constructed `Request` carries no Host header — only one that crossed a real
 * socket does — and the app refuses a request without one, so add what Funnel
 * would have sent unless the test chose its own.
 */
export function withHost(request: Request): Request {
  if (request.headers.has('host')) return request;
  const headers = new Headers(request.headers);
  headers.set('host', new URL(request.url).host);
  return new Request(request, { headers });
}

export interface Harness {
  readonly app: RemoteApp;
  readonly bridge: RecordingBridge;
  readonly directory: string;
  readonly clock: { now: number };
  readonly fetch: (path: string, init?: RequestInit) => Promise<Response>;
  readonly dispose: () => Promise<void>;
}

// The clock starts at the real time because the SDK's bearer check compares the
// token's expiry with the real time; tests only ever move it forward.
export async function startHarness(directory?: string, clock = { now: Date.now() }): Promise<Harness> {
  const stateDirectory = directory ?? mkdtempSync(join(tmpdir(), 'cronometer-oauth-'));
  const now = (): number => clock.now;
  const bridge = new RecordingBridge();
  const store = new OAuthStore(stateDirectory, { now, diagnostics: () => undefined });
  const publicUrl = new URL(MCP_URL);
  const app = createRemoteApp({
    remote: {
      publicUrl,
      issuer: new URL(publicUrl.origin),
      ownerPasswordHash: await OWNER_PASSWORD_HASH,
      allowedHosts: [publicUrl.hostname, 'localhost', '127.0.0.1'],
    },
    configuration: { timeZone: 'America/New_York', exportDirectory: undefined },
    bridge,
    store,
    now,
    log: () => undefined,
  });
  return {
    app,
    bridge,
    directory: stateDirectory,
    clock,
    fetch: (path, init) => app.fetch(withHost(new Request(new URL(path, BASE), init))),
    dispose: async () => {
      await app.close();
      if (directory === undefined) rmSync(stateDirectory, { recursive: true, force: true });
    },
  };
}

export function pkcePair(): { readonly verifier: string; readonly challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

export async function register(harness: Harness, redirectUris: readonly string[] = [CLAUDE_CALLBACK]): Promise<Response> {
  return harness.fetch('/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ redirect_uris: redirectUris, client_name: 'Claude' }),
  });
}

export async function registeredClient(harness: Harness): Promise<string> {
  const body = (await (await register(harness)).json()) as { client_id: string };
  return body.client_id;
}

export function authorizationParameters(
  clientId: string,
  challenge: string,
  overrides: Record<string, string> = {},
): Record<string, string> {
  return {
    response_type: 'code',
    client_id: clientId,
    redirect_uri: CLAUDE_CALLBACK,
    state: 'state-123',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    resource: MCP_URL,
    ...overrides,
  };
}

export async function submitPassword(
  harness: Harness,
  parameters: Record<string, string>,
  password: string,
  decision: 'allow' | 'deny' = 'allow',
): Promise<Response> {
  return harness.fetch('/authorize', {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ...parameters, password, decision }),
  });
}

export async function token(harness: Harness, form: Record<string, string>): Promise<Response> {
  return harness.fetch('/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form),
  });
}

export interface TokenSet {
  readonly access_token: string;
  readonly refresh_token: string;
  readonly expires_in: number;
}

/** Register, sign in and exchange the code: what Claude does when you click Connect. */
export async function signIn(harness: Harness): Promise<{ readonly clientId: string; readonly tokens: TokenSet }> {
  const clientId = await registeredClient(harness);
  const { verifier, challenge } = pkcePair();
  const redirect = await submitPassword(harness, authorizationParameters(clientId, challenge), OWNER_PASSWORD);
  const code = new URL(redirect.headers.get('location')!).searchParams.get('code')!;
  const response = await token(harness, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: CLAUDE_CALLBACK,
    code_verifier: verifier,
    client_id: clientId,
  });
  return { clientId, tokens: (await response.json()) as TokenSet };
}
