import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  ACCESS_TOKEN_LIFETIME_MS,
  MAXIMUM_CLIENTS,
  REFRESH_REUSE_GRACE_MS,
} from '../../src/http/oauth/store.js';
import {
  BASE,
  CLAUDE_CALLBACK,
  MCP_URL,
  OWNER_PASSWORD,
  authorizationParameters,
  pkcePair,
  register,
  registeredClient,
  signIn,
  startHarness,
  submitPassword,
  token,
  type Harness,
} from './remote-app.js';

const harnesses: Harness[] = [];

async function harness(...args: Parameters<typeof startHarness>): Promise<Harness> {
  const started = await startHarness(...args);
  harnesses.push(started);
  return started;
}

afterEach(async () => {
  for (const started of harnesses.splice(0)) await started.dispose();
});

function mcpRequest(accessToken?: string): RequestInit {
  return {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(accessToken === undefined ? {} : { authorization: `Bearer ${accessToken}` }),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
  };
}

describe('discovery', () => {
  it('answers an unauthenticated MCP call with the 401 that starts sign-in', async () => {
    const app = await harness();
    const response = await app.fetch('/mcp', mcpRequest());
    expect(response.status).toBe(401);
    // Claude finds the authorization server only through this pointer, and ignores
    // the header on anything but a 401.
    expect(response.headers.get('www-authenticate')).toContain(
      `resource_metadata="${BASE}/.well-known/oauth-protected-resource/mcp"`,
    );
  });

  it('names the MCP URL exactly as the resource, and this origin as the only issuer', async () => {
    const app = await harness();
    const resource = (await (await app.fetch('/.well-known/oauth-protected-resource/mcp')).json()) as Record<string, unknown>;
    expect(resource['resource']).toBe(MCP_URL);
    expect(resource['authorization_servers']).toEqual([BASE]);

    const server = (await (await app.fetch('/.well-known/oauth-authorization-server')).json()) as Record<string, unknown>;
    expect(server).toMatchObject({
      issuer: BASE,
      authorization_endpoint: `${BASE}/authorize`,
      token_endpoint: `${BASE}/token`,
      registration_endpoint: `${BASE}/register`,
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
    });
  });

  it('refuses a request addressed to any other host name', async () => {
    const app = await harness();
    const response = await app.fetch('/.well-known/oauth-authorization-server', {
      headers: { host: 'attacker.example' },
    });
    expect(response.status).toBe(403);
  });
});

describe('registration', () => {
  it('registers Claude as a public client', async () => {
    const app = await harness();
    const response = await register(app);
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      redirect_uris: [CLAUDE_CALLBACK],
      token_endpoint_auth_method: 'none',
    });
  });

  it('refuses any client whose redirect is not Claude', async () => {
    const app = await harness();
    const response = await register(app, [CLAUDE_CALLBACK, 'https://attacker.example/callback']);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'invalid_redirect_uri' });
  });

  it('accepts Claude Code loopback redirects and matches them on any port', async () => {
    const app = await harness();
    const registered = (await (await register(app, ['http://localhost:3118/callback'])).json()) as { client_id: string };
    const { challenge } = pkcePair();
    const page = await app.fetch(
      `/authorize?${new URLSearchParams(
        authorizationParameters(registered.client_id, challenge, { redirect_uri: 'http://localhost:50123/callback' }),
      )}`,
    );
    expect(page.status).toBe(200);
  });

  it('keeps only the newest clients', async () => {
    const app = await harness();
    const first = await registeredClient(app);
    for (let index = 0; index < MAXIMUM_CLIENTS; index += 1) await registeredClient(app);
    const response = await token(app, { grant_type: 'refresh_token', refresh_token: 'x', client_id: first });
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: 'invalid_client' });
  });

  it('refuses a registration that is not JSON', async () => {
    const app = await harness();
    const response = await app.fetch('/register', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'redirect_uris=x',
    });
    expect(response.status).toBe(400);
  });
});

describe('authorization', () => {
  it('shows an error page, and never redirects, for an unknown client', async () => {
    const app = await harness();
    const { challenge } = pkcePair();
    const response = await app.fetch(`/authorize?${new URLSearchParams(authorizationParameters('unknown', challenge))}`);
    expect(response.status).toBe(400);
    expect(response.headers.get('location')).toBeNull();
  });

  it('shows an error page for a redirect the client never registered', async () => {
    const app = await harness();
    const clientId = await registeredClient(app);
    const { challenge } = pkcePair();
    const response = await app.fetch(
      `/authorize?${new URLSearchParams(
        authorizationParameters(clientId, challenge, { redirect_uri: 'https://claude.com/api/mcp/auth_callback' }),
      )}`,
    );
    expect(response.status).toBe(400);
    expect(response.headers.get('location')).toBeNull();
  });

  it('sends a request without S256 PKCE back to the client with invalid_request', async () => {
    const app = await harness();
    const clientId = await registeredClient(app);
    const response = await app.fetch(
      `/authorize?${new URLSearchParams(authorizationParameters(clientId, 'x', { code_challenge_method: 'plain' }))}`,
    );
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get('location')!);
    expect(location.searchParams.get('error')).toBe('invalid_request');
    expect(location.searchParams.get('state')).toBe('state-123');
  });

  it('refuses to issue a code for some other resource', async () => {
    const app = await harness();
    const clientId = await registeredClient(app);
    const { challenge } = pkcePair();
    const response = await app.fetch(
      `/authorize?${new URLSearchParams(
        authorizationParameters(clientId, challenge, { resource: 'https://elsewhere.example/mcp' }),
      )}`,
    );
    expect(new URL(response.headers.get('location')!).searchParams.get('error')).toBe('invalid_target');
  });

  it('serves a sign-in page that cannot be framed and may only post back to itself or the client', async () => {
    const app = await harness();
    const clientId = await registeredClient(app);
    const { challenge } = pkcePair();
    const response = await app.fetch(`/authorize?${new URLSearchParams(authorizationParameters(clientId, challenge))}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('x-frame-options')).toBe('DENY');
    expect(response.headers.get('content-security-policy')).toContain("form-action 'self' https://claude.ai");
    expect(response.headers.get('cache-control')).toBe('no-store');
    const page = await response.text();
    expect(page).toContain('claude.ai');
    expect(page).toContain('type="password"');
  });

  it('escapes what the client sent before putting it on the page', async () => {
    const app = await harness();
    const clientId = await registeredClient(app);
    const { challenge } = pkcePair();
    const response = await app.fetch(
      `/authorize?${new URLSearchParams(authorizationParameters(clientId, challenge, { state: '"><script>alert(1)</script>' }))}`,
    );
    const page = await response.text();
    expect(page).not.toContain('<script>');
    expect(page).toContain('&quot;&gt;&lt;script&gt;');
  });

  it('re-shows the form for a wrong password and issues nothing', async () => {
    const app = await harness();
    const clientId = await registeredClient(app);
    const { challenge } = pkcePair();
    const response = await submitPassword(app, authorizationParameters(clientId, challenge), 'not the password');
    expect(response.status).toBe(401);
    expect(response.headers.get('location')).toBeNull();
  });

  it('redirects with the code, the state and the issuer once the owner signs in', async () => {
    const app = await harness();
    const clientId = await registeredClient(app);
    const { challenge } = pkcePair();
    const response = await submitPassword(app, authorizationParameters(clientId, challenge), OWNER_PASSWORD);
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get('location')!);
    expect(`${location.origin}${location.pathname}`).toBe(CLAUDE_CALLBACK);
    expect(location.searchParams.get('code')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(location.searchParams.get('state')).toBe('state-123');
    expect(location.searchParams.get('iss')).toBe(BASE);
  });

  it('tells the client when the owner denies access', async () => {
    const app = await harness();
    const clientId = await registeredClient(app);
    const { challenge } = pkcePair();
    const response = await submitPassword(app, authorizationParameters(clientId, challenge), '', 'deny');
    expect(new URL(response.headers.get('location')!).searchParams.get('error')).toBe('access_denied');
  });

  it('locks sign-in after five wrong passwords, even against the right one, for fifteen minutes', async () => {
    const app = await harness();
    const clientId = await registeredClient(app);
    const { challenge } = pkcePair();
    const parameters = authorizationParameters(clientId, challenge);
    const statuses = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      statuses.push((await submitPassword(app, parameters, `wrong ${attempt}`)).status);
    }
    expect(statuses).toEqual([401, 401, 401, 401, 429]);
    expect((await submitPassword(app, parameters, OWNER_PASSWORD)).status).toBe(429);

    app.clock.now += 15 * 60 * 1_000;
    expect((await submitPassword(app, parameters, OWNER_PASSWORD)).status).toBe(302);
  });

  it('counts parallel guesses one at a time', async () => {
    const app = await harness();
    const clientId = await registeredClient(app);
    const { challenge } = pkcePair();
    const parameters = authorizationParameters(clientId, challenge);
    const responses = await Promise.all(
      Array.from({ length: 8 }, (_, index) => submitPassword(app, parameters, `guess ${index}`)),
    );
    expect(responses.filter((response) => response.status === 429)).toHaveLength(4);
  });
});

describe('token exchange', () => {
  it('exchanges a code once, and only with the matching PKCE verifier', async () => {
    const app = await harness();
    const clientId = await registeredClient(app);
    const { verifier, challenge } = pkcePair();
    const redirect = await submitPassword(app, authorizationParameters(clientId, challenge), OWNER_PASSWORD);
    const code = new URL(redirect.headers.get('location')!).searchParams.get('code')!;
    const form = { grant_type: 'authorization_code', code, redirect_uri: CLAUDE_CALLBACK, client_id: clientId };

    const wrongVerifier = await token(app, { ...form, code_verifier: pkcePair().verifier });
    expect(wrongVerifier.status).toBe(400);
    expect(await wrongVerifier.json()).toMatchObject({ error: 'invalid_grant' });

    // The failed attempt spent the code: a stolen code cannot be retried against PKCE.
    const afterFailure = await token(app, { ...form, code_verifier: verifier });
    expect(await afterFailure.json()).toMatchObject({ error: 'invalid_grant' });
  });

  it('issues a bearer token pair that the MCP endpoint accepts', async () => {
    const app = await harness();
    const { tokens } = await signIn(app);
    expect(tokens.expires_in).toBe(ACCESS_TOKEN_LIFETIME_MS / 1_000);
    const response = await app.fetch('/mcp', mcpRequest(tokens.access_token));
    expect(response.status).not.toBe(401);
    expect(response.status).toBeLessThan(500);
  });

  it('refuses a code sent with a different redirect', async () => {
    const app = await harness();
    const clientId = await registeredClient(app);
    const { verifier, challenge } = pkcePair();
    const redirect = await submitPassword(app, authorizationParameters(clientId, challenge), OWNER_PASSWORD);
    const code = new URL(redirect.headers.get('location')!).searchParams.get('code')!;
    const response = await token(app, {
      grant_type: 'authorization_code',
      code,
      redirect_uri: 'https://claude.com/api/mcp/auth_callback',
      code_verifier: verifier,
      client_id: clientId,
    });
    expect(await response.json()).toMatchObject({ error: 'invalid_grant' });
  });

  it('expires a code after a minute', async () => {
    const app = await harness();
    const clientId = await registeredClient(app);
    const { verifier, challenge } = pkcePair();
    const redirect = await submitPassword(app, authorizationParameters(clientId, challenge), OWNER_PASSWORD);
    const code = new URL(redirect.headers.get('location')!).searchParams.get('code')!;
    app.clock.now += 61 * 1_000;
    const response = await token(app, {
      grant_type: 'authorization_code',
      code,
      redirect_uri: CLAUDE_CALLBACK,
      code_verifier: verifier,
      client_id: clientId,
    });
    expect(await response.json()).toMatchObject({ error: 'invalid_grant' });
  });

  it('accepts only form-encoded token requests', async () => {
    const app = await harness();
    const clientId = await registeredClient(app);
    const response = await app.fetch('/token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ grant_type: 'refresh_token', client_id: clientId }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'invalid_request' });
  });

  it('answers an unknown client with 401 invalid_client, which tells Claude to register again', async () => {
    const app = await harness();
    const response = await token(app, { grant_type: 'refresh_token', refresh_token: 'x', client_id: 'gone' });
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: 'invalid_client' });
  });

  it('expires access tokens after an hour', async () => {
    const app = await harness();
    const { tokens } = await signIn(app);
    app.clock.now += ACCESS_TOKEN_LIFETIME_MS + 1;
    expect((await app.fetch('/mcp', mcpRequest(tokens.access_token))).status).toBe(401);
  });
});

describe('refresh', () => {
  it('rotates the refresh token on every use', async () => {
    const app = await harness();
    const { clientId, tokens } = await signIn(app);
    const response = await token(app, { grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: clientId });
    const rotated = (await response.json()) as { access_token: string; refresh_token: string };
    expect(rotated.refresh_token).not.toBe(tokens.refresh_token);
    expect((await app.fetch('/mcp', mcpRequest(rotated.access_token))).status).not.toBe(401);
  });

  it('tolerates a refresh token presented twice within a minute, as racing refreshes do', async () => {
    const app = await harness();
    const { clientId, tokens } = await signIn(app);
    const form = { grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: clientId };
    expect((await token(app, form)).status).toBe(200);
    app.clock.now += REFRESH_REUSE_GRACE_MS - 1_000;
    expect((await token(app, form)).status).toBe(200);
  });

  it('treats a long-spent refresh token as stolen and revokes everything descended from it', async () => {
    const app = await harness();
    const { clientId, tokens } = await signIn(app);
    const form = { grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: clientId };
    const rotated = (await (await token(app, form)).json()) as { access_token: string; refresh_token: string };

    app.clock.now += REFRESH_REUSE_GRACE_MS + 1_000;
    const replay = await token(app, form);
    expect(replay.status).toBe(400);
    expect(await replay.json()).toMatchObject({ error: 'invalid_grant' });

    expect((await app.fetch('/mcp', mcpRequest(rotated.access_token))).status).toBe(401);
    const descendant = await token(app, { ...form, refresh_token: rotated.refresh_token });
    expect(await descendant.json()).toMatchObject({ error: 'invalid_grant' });
  });

  it('refuses a refresh token presented by a different client', async () => {
    const app = await harness();
    const { tokens } = await signIn(app);
    const other = await registeredClient(app);
    const response = await token(app, { grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: other });
    expect(await response.json()).toMatchObject({ error: 'invalid_grant' });
  });
});

describe('storage', () => {
  it('survives a restart, and stores token hashes rather than tokens', async () => {
    const first = await harness();
    const { tokens } = await signIn(first);

    const restarted = await harness(first.directory, first.clock);
    expect((await restarted.fetch('/mcp', mcpRequest(tokens.access_token))).status).not.toBe(401);

    const saved = readFileSync(join(first.directory, 'state.json'), 'utf8');
    expect(saved).not.toContain(tokens.access_token);
    expect(saved).not.toContain(tokens.refresh_token);
  });
});
