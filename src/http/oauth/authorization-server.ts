import { createHash, timingSafeEqual } from 'node:crypto';

import { OAuthError, type AuthInfo, type OAuthMetadata, type OAuthTokenVerifier } from '@modelcontextprotocol/server';

import { isLoopbackHost } from '../config.js';
import { verifyPassword } from '../password.js';
import { newSecret, type OAuthStore } from './store.js';

/**
 * A deliberately small OAuth 2.1 authorization server for exactly one person.
 *
 * It exists because Claude's hosted apps — the iPhone app among them — reach a
 * connector only through OAuth (or no authentication at all), and the SDK ships
 * the resource-server half only. Everything here follows what Claude's client
 * does, documented at claude.com/docs/connectors/building/authentication:
 * Dynamic Client Registration for a public client, S256 PKCE on every request,
 * form-encoded token requests, and refresh-token rotation.
 *
 * "Signing in" means typing the owner password. There are no accounts: whoever
 * knows the password is the owner, which is why the password check is slow,
 * serialised and locked out after a handful of failures.
 */

export const SCOPE = 'cronometer';

/** The only places a code may be sent. Anything else is someone else's client. */
const HOSTED_CLAUDE_CALLBACKS: ReadonlySet<string> = new Set([
  'https://claude.ai/api/mcp/auth_callback',
  'https://claude.com/api/mcp/auth_callback',
]);

const AUTHORIZATION_CODE_LIFETIME_MS = 60 * 1_000;
const MAXIMUM_PENDING_CODES = 32;
const LOCKOUT_WINDOW_MS = 15 * 60 * 1_000;
const LOCKOUT_THRESHOLD = 5;
const MAXIMUM_FORM_BYTES = 16 * 1024;
const MAXIMUM_REDIRECT_URIS = 5;
const MAXIMUM_CLIENT_NAME = 100;
const PKCE_VERIFIER = /^[A-Za-z0-9\-._~]{43,128}$/;
const PKCE_CHALLENGE = /^[A-Za-z0-9\-_]{43}$/;
/** OAuth `state` is opaque to us, but it is echoed into a URL and a page, so it is bounded. */
const MAXIMUM_STATE_LENGTH = 1_024;

/**
 * Claude Code redirects to a loopback port that changes every session. RFC 8252
 * §7.3 says to ignore the port for loopback redirects, and Claude's docs ask for
 * the same for `localhost`.
 */
function isLoopbackCallback(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    url.protocol === 'http:' &&
    isLoopbackHost(url.hostname) &&
    url.pathname === '/callback' &&
    url.search === '' &&
    url.hash === '' &&
    url.username === '' &&
    url.password === ''
  );
}

function isAllowedRedirect(value: string): boolean {
  return HOSTED_CLAUDE_CALLBACKS.has(value) || isLoopbackCallback(value);
}

function redirectMatches(registered: readonly string[], presented: string): boolean {
  if (registered.includes(presented)) return true;
  if (!isLoopbackCallback(presented)) return false;
  const wanted = new URL(presented);
  return registered.some((candidate) => {
    if (!isLoopbackCallback(candidate)) return false;
    const url = new URL(candidate);
    return url.hostname === wanted.hostname && url.pathname === wanted.pathname;
  });
}

function sameResource(presented: string, resource: URL): boolean {
  const strip = (value: string): string => value.replace(/#.*$/, '').replace(/\/$/, '');
  return strip(presented) === strip(resource.href);
}

function pkceMatches(verifier: string, challenge: string): boolean {
  if (!PKCE_VERIFIER.test(verifier)) return false;
  const computed = Buffer.from(createHash('sha256').update(verifier, 'ascii').digest('base64url'));
  const expected = Buffer.from(challenge);
  return computed.length === expected.length && timingSafeEqual(computed, expected);
}

function hashCode(code: string): string {
  return createHash('sha256').update(code, 'utf8').digest('hex');
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

class PayloadTooLarge extends Error {}

async function readText(request: Request, limit: number): Promise<string> {
  if (request.body === null) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new PayloadTooLarge();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, MCP-Protocol-Version',
} as const;

const NO_STORE = { 'Cache-Control': 'no-store', Pragma: 'no-cache' } as const;

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...NO_STORE, ...CORS_HEADERS, ...headers },
  });
}

function oauthError(status: number, error: string, description: string): Response {
  return json(status, { error, error_description: description });
}

interface PendingCode {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly codeChallenge: string;
  readonly expiresAt: number;
}

/** What an authorization request asks for, once it has been checked. */
interface AuthorizationRequest {
  readonly clientId: string;
  readonly clientName: string | undefined;
  readonly redirectUri: string;
  readonly state: string | undefined;
  readonly codeChallenge: string;
  readonly resource: string | undefined;
}

type Checked =
  | { readonly kind: 'ok'; readonly request: AuthorizationRequest }
  /** Not safe to redirect: the client or redirect URI could not be trusted. */
  | { readonly kind: 'page'; readonly message: string }
  /** The redirect URI is trusted, so the error goes back to the client. */
  | { readonly kind: 'redirect'; readonly redirectUri: string; readonly state: string | undefined; readonly error: string; readonly description: string };

export interface AuthorizationServerOptions {
  readonly issuer: URL;
  readonly resource: URL;
  readonly store: OAuthStore;
  readonly ownerPasswordHash: string;
  readonly now?: () => number;
}

export class AuthorizationServer {
  public readonly metadata: OAuthMetadata;
  public readonly verifier: OAuthTokenVerifier;

  readonly #issuer: string;
  readonly #resource: URL;
  readonly #store: OAuthStore;
  readonly #ownerPasswordHash: string;
  readonly #now: () => number;
  readonly #codes = new Map<string, PendingCode>();
  #failures: number[] = [];
  /** One password check at a time, so parallel guesses cannot outrun the lockout. */
  #passwordQueue: Promise<unknown> = Promise.resolve();

  public constructor(options: AuthorizationServerOptions) {
    // The issuer is the bare origin, without the trailing slash `URL.href` adds:
    // Claude compares it as a string with the `iss` it receives.
    this.#issuer = options.issuer.origin;
    this.#resource = options.resource;
    this.#store = options.store;
    this.#ownerPasswordHash = options.ownerPasswordHash;
    this.#now = options.now ?? Date.now;

    this.metadata = {
      issuer: this.#issuer,
      authorization_endpoint: `${this.#issuer}/authorize`,
      token_endpoint: `${this.#issuer}/token`,
      registration_endpoint: `${this.#issuer}/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: [SCOPE],
      authorization_response_iss_parameter_supported: true,
    };

    this.verifier = {
      verifyAccessToken: async (token: string): Promise<AuthInfo> => {
        const record = this.#store.findAccessToken(token);
        if (record === undefined) {
          throw new OAuthError('invalid_token', 'The access token is unknown or has expired.');
        }
        return {
          token,
          clientId: record.clientId,
          scopes: [SCOPE],
          expiresAt: Math.floor(record.expiresAt / 1_000),
          resource: new URL(this.#resource.href),
        };
      },
    };
  }

  /** Answers the three OAuth routes, or `undefined` for anything else. */
  public async handle(request: Request): Promise<Response | undefined> {
    const path = new URL(request.url).pathname;
    if (path !== '/register' && path !== '/authorize' && path !== '/token') return undefined;
    try {
      if (path === '/authorize') {
        if (request.method === 'GET') return this.#authorizePage(request);
        if (request.method === 'POST') return await this.#authorizeSubmit(request);
        return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, POST' } });
      }
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
      if (request.method !== 'POST') {
        return new Response('Method not allowed', { status: 405, headers: { Allow: 'POST, OPTIONS', ...CORS_HEADERS } });
      }
      return path === '/register' ? await this.#register(request) : await this.#token(request);
    } catch (error) {
      if (error instanceof PayloadTooLarge) return oauthError(413, 'invalid_request', 'The request body is too large.');
      throw error;
    }
  }

  // --- Registration (RFC 7591) ---------------------------------------------------

  async #register(request: Request): Promise<Response> {
    if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) {
      return oauthError(400, 'invalid_client_metadata', 'Registration must be sent as application/json.');
    }
    let body: unknown;
    try {
      body = JSON.parse(await readText(request, MAXIMUM_FORM_BYTES));
    } catch (error) {
      if (error instanceof PayloadTooLarge) throw error;
      return oauthError(400, 'invalid_client_metadata', 'The registration body is not valid JSON.');
    }
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      return oauthError(400, 'invalid_client_metadata', 'The registration body must be a JSON object.');
    }
    const metadata = body as Record<string, unknown>;
    const redirectUris = metadata['redirect_uris'];
    if (
      !Array.isArray(redirectUris) ||
      redirectUris.length === 0 ||
      redirectUris.length > MAXIMUM_REDIRECT_URIS ||
      !redirectUris.every((value): value is string => typeof value === 'string')
    ) {
      return oauthError(400, 'invalid_redirect_uri', 'redirect_uris must list between one and five URIs.');
    }
    const refused = redirectUris.find((value) => !isAllowedRedirect(value));
    if (refused !== undefined) {
      return oauthError(400, 'invalid_redirect_uri', 'This server only accepts Claude as a client.');
    }
    const name = metadata['client_name'];
    const clientName = typeof name === 'string' && name.trim() !== '' ? name.trim().slice(0, MAXIMUM_CLIENT_NAME) : undefined;

    const clientId = this.#store.registerClient(redirectUris, clientName);
    return json(201, {
      client_id: clientId,
      client_id_issued_at: Math.floor(this.#now() / 1_000),
      redirect_uris: redirectUris,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      scope: SCOPE,
      ...(clientName === undefined ? {} : { client_name: clientName }),
    });
  }

  // --- Authorization ---------------------------------------------------------------

  #check(parameters: URLSearchParams): Checked {
    const clientId = parameters.get('client_id') ?? '';
    const client = clientId === '' ? undefined : this.#store.getClient(clientId);
    if (client === undefined) {
      return { kind: 'page', message: 'This sign-in link is for a client this server does not know. Start again from Claude.' };
    }
    const redirectUri = parameters.get('redirect_uri') ?? '';
    if (redirectUri === '' || !redirectMatches(client.redirectUris, redirectUri)) {
      return { kind: 'page', message: 'This sign-in link names a return address this client never registered.' };
    }
    const stateValue = parameters.get('state');
    if (stateValue !== null && stateValue.length > MAXIMUM_STATE_LENGTH) {
      return { kind: 'page', message: 'This sign-in link is malformed.' };
    }
    const state = stateValue ?? undefined;
    const fail = (error: string, description: string): Checked => ({ kind: 'redirect', redirectUri, state, error, description });

    if (parameters.get('response_type') !== 'code') {
      return fail('unsupported_response_type', 'Only the authorization code flow is supported.');
    }
    const codeChallenge = parameters.get('code_challenge') ?? '';
    if (parameters.get('code_challenge_method') !== 'S256' || !PKCE_CHALLENGE.test(codeChallenge)) {
      return fail('invalid_request', 'An S256 PKCE code challenge is required.');
    }
    const resource = parameters.get('resource') ?? undefined;
    if (resource !== undefined && !sameResource(resource, this.#resource)) {
      return fail('invalid_target', 'This server only issues tokens for its own MCP endpoint.');
    }
    return {
      kind: 'ok',
      request: { clientId, clientName: client.clientName, redirectUri, state, codeChallenge, resource },
    };
  }

  #redirectWith(redirectUri: string, values: Record<string, string | undefined>): Response {
    const target = new URL(redirectUri);
    for (const [key, value] of Object.entries(values)) {
      if (value !== undefined) target.searchParams.set(key, value);
    }
    target.searchParams.set('iss', this.#issuer);
    return new Response(null, { status: 302, headers: { Location: target.href, ...NO_STORE } });
  }

  #authorizePage(request: Request): Response {
    const checked = this.#check(new URL(request.url).searchParams);
    if (checked.kind === 'page') return this.#page(400, checked.message);
    if (checked.kind === 'redirect') {
      return this.#redirectWith(checked.redirectUri, {
        error: checked.error,
        error_description: checked.description,
        state: checked.state,
      });
    }
    return this.#loginForm(checked.request, undefined);
  }

  async #authorizeSubmit(request: Request): Promise<Response> {
    if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/x-www-form-urlencoded')) {
      return this.#page(400, 'The sign-in form was not submitted correctly.');
    }
    const form = new URLSearchParams(await readText(request, MAXIMUM_FORM_BYTES));
    const checked = this.#check(form);
    if (checked.kind === 'page') return this.#page(400, checked.message);
    if (checked.kind === 'redirect') {
      return this.#redirectWith(checked.redirectUri, {
        error: checked.error,
        error_description: checked.description,
        state: checked.state,
      });
    }

    if (form.get('decision') === 'deny') {
      return this.#redirectWith(checked.request.redirectUri, {
        error: 'access_denied',
        error_description: 'The owner declined.',
        state: checked.request.state,
      });
    }

    const verdict = await this.#checkPassword(form.get('password') ?? '');
    if (verdict !== 'accepted') {
      const message =
        verdict === 'locked'
          ? 'Too many wrong passwords. Wait fifteen minutes and try again.'
          : 'That password is not right.';
      return this.#loginForm(checked.request, message, verdict === 'locked' ? 429 : 401);
    }

    const code = newSecret();
    this.#prune();
    this.#codes.set(hashCode(code), {
      clientId: checked.request.clientId,
      redirectUri: checked.request.redirectUri,
      codeChallenge: checked.request.codeChallenge,
      expiresAt: this.#now() + AUTHORIZATION_CODE_LIFETIME_MS,
    });
    return this.#redirectWith(checked.request.redirectUri, { code, state: checked.request.state });
  }

  #checkPassword(password: string): Promise<'accepted' | 'rejected' | 'locked'> {
    const attempt = this.#passwordQueue.then(async () => {
      const now = this.#now();
      this.#failures = this.#failures.filter((at) => now - at < LOCKOUT_WINDOW_MS);
      // Locked means locked: a correct password does not get through either, or
      // the lockout would only slow an attacker down until the right guess.
      if (this.#failures.length >= LOCKOUT_THRESHOLD) return 'locked' as const;
      if (await verifyPassword(password, this.#ownerPasswordHash)) {
        this.#failures = [];
        return 'accepted' as const;
      }
      this.#failures.push(this.#now());
      return this.#failures.length >= LOCKOUT_THRESHOLD ? ('locked' as const) : ('rejected' as const);
    });
    this.#passwordQueue = attempt.catch(() => undefined);
    return attempt;
  }

  #prune(): void {
    const now = this.#now();
    for (const [key, pending] of this.#codes) {
      if (pending.expiresAt <= now) this.#codes.delete(key);
    }
    while (this.#codes.size >= MAXIMUM_PENDING_CODES) {
      const oldest = this.#codes.keys().next();
      if (oldest.done === true) break;
      this.#codes.delete(oldest.value);
    }
  }

  // --- Token -------------------------------------------------------------------------

  async #token(request: Request): Promise<Response> {
    if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/x-www-form-urlencoded')) {
      return oauthError(400, 'invalid_request', 'Token requests must be application/x-www-form-urlencoded.');
    }
    const form = new URLSearchParams(await readText(request, MAXIMUM_FORM_BYTES));
    const clientId = form.get('client_id') ?? '';
    if (clientId === '' || this.#store.getClient(clientId) === undefined) {
      // 401 invalid_client is what tells Claude to register again.
      return oauthError(401, 'invalid_client', 'The client is unknown. Register again.');
    }
    const resource = form.get('resource');
    if (resource !== null && !sameResource(resource, this.#resource)) {
      return oauthError(400, 'invalid_target', 'This server only issues tokens for its own MCP endpoint.');
    }

    const grantType = form.get('grant_type');
    if (grantType === 'authorization_code') return this.#exchangeCode(form, clientId);
    if (grantType === 'refresh_token') return this.#refresh(form, clientId);
    return oauthError(400, 'unsupported_grant_type', 'Only authorization_code and refresh_token are supported.');
  }

  #exchangeCode(form: URLSearchParams, clientId: string): Response {
    const code = form.get('code') ?? '';
    const key = hashCode(code);
    const pending = this.#codes.get(key);
    // Single use, whatever happens next: a code that fails a check is gone too.
    this.#codes.delete(key);
    if (
      pending === undefined ||
      pending.expiresAt <= this.#now() ||
      pending.clientId !== clientId ||
      pending.redirectUri !== (form.get('redirect_uri') ?? '')
    ) {
      return oauthError(400, 'invalid_grant', 'The authorization code is invalid, expired or already used.');
    }
    if (!pkceMatches(form.get('code_verifier') ?? '', pending.codeChallenge)) {
      return oauthError(400, 'invalid_grant', 'The PKCE code verifier does not match.');
    }
    return this.#tokenResponse(this.#store.issueTokens(clientId));
  }

  #refresh(form: URLSearchParams, clientId: string): Response {
    const outcome = this.#store.spendRefreshToken(form.get('refresh_token') ?? '', clientId);
    if (outcome.kind !== 'accepted') {
      return oauthError(400, 'invalid_grant', 'The refresh token is invalid or has expired. Connect again.');
    }
    return this.#tokenResponse(this.#store.issueTokens(clientId, outcome.familyId));
  }

  #tokenResponse(tokens: ReturnType<OAuthStore['issueTokens']>): Response {
    return json(200, {
      access_token: tokens.accessToken,
      token_type: 'Bearer',
      expires_in: tokens.expiresInSeconds,
      refresh_token: tokens.refreshToken,
      scope: SCOPE,
    });
  }

  // --- Pages -------------------------------------------------------------------------

  #headers(formTarget?: string): Record<string, string> {
    // Browsers apply form-action to the redirect that follows a form post, so the
    // client's origin has to be allowed as well as our own, or the code never
    // leaves this page.
    const formAction = formTarget === undefined ? "'self'" : `'self' ${new URL(formTarget).origin}`;
    return {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline'; form-action ${formAction}; frame-ancestors 'none'; base-uri 'none'`,
      'X-Frame-Options': 'DENY',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      ...NO_STORE,
    };
  }

  #page(status: number, message: string): Response {
    return new Response(this.#layout('Cannot connect', `<p>${escapeHtml(message)}</p>`), {
      status,
      headers: this.#headers(),
    });
  }

  #loginForm(request: AuthorizationRequest, error: string | undefined, status = 200): Response {
    const hidden: Record<string, string | undefined> = {
      response_type: 'code',
      client_id: request.clientId,
      redirect_uri: request.redirectUri,
      state: request.state,
      code_challenge: request.codeChallenge,
      code_challenge_method: 'S256',
      resource: request.resource,
    };
    const fields = Object.entries(hidden)
      .filter((entry): entry is [string, string] => entry[1] !== undefined)
      .map(([name, value]) => `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`)
      .join('');
    const destination = new URL(request.redirectUri).host;
    const who = request.clientName === undefined ? 'An app' : escapeHtml(request.clientName);
    const body = `
      <p><strong>${who}</strong> wants to read and change your Cronometer diary through this connector.</p>
      <p class="muted">After you sign in you will be sent back to <strong>${escapeHtml(destination)}</strong>.</p>
      ${error === undefined ? '' : `<p class="error" role="alert">${escapeHtml(error)}</p>`}
      <form method="post" action="/authorize">
        ${fields}
        <label for="password">Owner password</label>
        <input id="password" name="password" type="password" autocomplete="current-password" required autofocus>
        <div class="actions">
          <button type="submit" name="decision" value="allow">Allow</button>
          <button type="submit" name="decision" value="deny" formnovalidate class="secondary">Deny</button>
        </div>
      </form>`;
    return new Response(this.#layout('Connect Claude to Cronometer', body), {
      status,
      headers: this.#headers(request.redirectUri),
    });
  }

  #layout(title: string, body: string): string {
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; --fg: #1d1d1f; --bg: #f5f5f7; --card: #fff; --muted: #6e6e73; --accent: #2b6e3f; --error: #b3261e; }
  @media (prefers-color-scheme: dark) { :root { --fg: #f5f5f7; --bg: #111; --card: #1c1c1e; --muted: #a1a1a6; --accent: #5cbf7a; --error: #f2b8b5; } }
  body { margin: 0; font: 16px/1.5 system-ui, -apple-system, sans-serif; background: var(--bg); color: var(--fg); }
  main { max-width: 420px; margin: 48px auto; padding: 24px; background: var(--card); border-radius: 16px; }
  h1 { font-size: 1.3rem; margin: 0 0 12px; }
  .muted { color: var(--muted); font-size: .9rem; }
  .error { color: var(--error); }
  label { display: block; margin: 16px 0 6px; font-weight: 600; }
  input[type=password] { width: 100%; box-sizing: border-box; padding: 12px; font-size: 1rem; border-radius: 10px; border: 1px solid var(--muted); background: transparent; color: inherit; }
  .actions { display: flex; gap: 12px; margin-top: 20px; }
  button { flex: 1; padding: 12px; font-size: 1rem; border: 0; border-radius: 10px; background: var(--accent); color: #fff; }
  button.secondary { background: transparent; color: var(--fg); border: 1px solid var(--muted); }
</style>
</head>
<body><main><h1>${escapeHtml(title)}</h1>${body}</main></body>
</html>`;
  }
}
