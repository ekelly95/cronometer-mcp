import type { AddressInfo } from 'node:net';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it } from 'vitest';

import { readRemoteConfiguration } from '../../src/http/config.js';
import { serveFetch } from '../../src/http/node-adapter.js';
import { hashPassword, verifyPassword } from '../../src/http/password.js';
import { LIVE_TOOL_REGISTRY } from '../../src/mcp/index.js';
import { MCP_URL, signIn, startHarness, withHost, type Harness } from './remote-app.js';

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function harness(): Promise<Harness> {
  const started = await startHarness();
  cleanups.push(started.dispose);
  return started;
}

/** A real MCP client, talking to the app in-process with the token Claude would hold. */
async function connect(app: Harness, accessToken: string, mode: 'legacy' | 'modern'): Promise<Client> {
  const client = new Client(
    { name: 'claude-ai', version: '1.0.0' },
    { versionNegotiation: { mode: mode === 'legacy' ? 'legacy' : { pin: '2026-07-28' } } },
  );
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
    requestInit: { headers: { Authorization: `Bearer ${accessToken}` } },
    fetch: (url, init) => app.app.fetch(withHost(new Request(url, init))),
  });
  await client.connect(transport);
  cleanups.push(() => client.close());
  return client;
}

describe('MCP over HTTP', () => {
  for (const mode of ['legacy', 'modern'] as const) {
    it(`serves every tool to a ${mode} client`, async () => {
      const app = await harness();
      const { tokens } = await signIn(app);
      const client = await connect(app, tokens.access_token, mode);
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name).sort()).toEqual(LIVE_TOOL_REGISTRY.map((tool) => tool.name).sort());
    });
  }

  it('shares one bridge across requests and never closes it between them', async () => {
    const app = await harness();
    const { tokens } = await signIn(app);
    const client = await connect(app, tokens.access_token, 'legacy');
    await client.callTool({ name: 'cronometer_status', arguments: {} });
    await client.callTool({ name: 'cronometer_check_connection', arguments: {} });
    expect(app.bridge.calls).toEqual(['status', 'check_connection']);
    expect(app.bridge.closed).toBe(0);
  });

  it('keeps the untrusted-data fence on results', async () => {
    const app = await harness();
    const { tokens } = await signIn(app);
    const client = await connect(app, tokens.access_token, 'modern');
    const result = await client.callTool({ name: 'cronometer_check_connection', arguments: {} });
    const [first] = result.content as { type: string; text: string }[];
    expect(first?.text).toMatch(/^UNTRUSTED CRONOMETER DATA/);
  });

  it('refuses a client without a token before any server is built', async () => {
    const app = await harness();
    const client = new Client({ name: 'anonymous', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
      fetch: (url, init) => app.app.fetch(withHost(new Request(url, init))),
    });
    await expect(client.connect(transport)).rejects.toThrow();
    expect(app.bridge.calls).toEqual([]);
  });
});

describe('node adapter', () => {
  it('serves the handler over a real socket, request bodies included', async () => {
    const server = serveFetch(async (request) =>
      Response.json({ method: request.method, path: new URL(request.url).pathname, body: await request.text() }),
    );
    await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
    cleanups.push(() => new Promise<void>((resolveClose) => server.close(() => resolveClose())));
    const { port } = server.address() as AddressInfo;

    const response = await fetch(`http://127.0.0.1:${port}/token`, { method: 'POST', body: 'a=1' });
    expect(await response.json()).toEqual({ method: 'POST', path: '/token', body: 'a=1' });
  });

  it('streams a response as it is written', async () => {
    const encoder = new TextEncoder();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    const server = serveFetch(async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          async start(controller) {
            controller.enqueue(encoder.encode('first\n'));
            await gate;
            controller.enqueue(encoder.encode('second\n'));
            controller.close();
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      ),
    );
    await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
    cleanups.push(() => new Promise<void>((resolveClose) => server.close(() => resolveClose())));
    const { port } = server.address() as AddressInfo;

    const response = await fetch(`http://127.0.0.1:${port}/`);
    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe('first\n');
    release();
    let rest = '';
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
      rest += new TextDecoder().decode(chunk.value);
    }
    expect(rest).toBe('second\n');
  });
});

describe('remote configuration', () => {
  const valid = {
    MCP_PUBLIC_URL: 'https://my-pc.example.ts.net/mcp',
    MCP_STATE_DIR: '/state',
    MCP_OWNER_PASSWORD_HASH: 'scrypt$32768$8$1$salt$key',
  };

  it('derives the issuer and the accepted host names from the public URL', () => {
    const remote = readRemoteConfiguration(valid);
    expect(remote.issuer.origin).toBe('https://my-pc.example.ts.net');
    expect(remote.listenPort).toBe(8787);
    expect(remote.allowedHosts).toContain('my-pc.example.ts.net');
  });

  it('requires https for anything but loopback', () => {
    expect(() => readRemoteConfiguration({ ...valid, MCP_PUBLIC_URL: 'http://my-pc.example.ts.net/mcp' })).toThrow(/https/);
    expect(readRemoteConfiguration({ ...valid, MCP_PUBLIC_URL: 'http://127.0.0.1:8787/mcp' }).publicUrl.port).toBe('8787');
  });

  it('requires a path for the MCP endpoint and refuses query strings', () => {
    expect(() => readRemoteConfiguration({ ...valid, MCP_PUBLIC_URL: 'https://my-pc.example.ts.net/' })).toThrow(/path/);
    expect(() => readRemoteConfiguration({ ...valid, MCP_PUBLIC_URL: 'https://my-pc.example.ts.net/mcp?k=1' })).toThrow(/query/);
  });

  it('refuses to start without a password hash or state directory', () => {
    expect(() => readRemoteConfiguration({ ...valid, MCP_OWNER_PASSWORD_HASH: '' })).toThrow(/MCP_OWNER_PASSWORD_HASH/);
    expect(() => readRemoteConfiguration({ ...valid, MCP_OWNER_PASSWORD_HASH: 'hunter2' })).toThrow(/hash/);
    expect(() => readRemoteConfiguration({ ...valid, MCP_STATE_DIR: '' })).toThrow(/MCP_STATE_DIR/);
  });
});

describe('owner password', () => {
  it('verifies only the password that was hashed', async () => {
    const hash = await hashPassword('a long enough password');
    expect(hash).toMatch(/^scrypt\$32768\$8\$1\$/);
    expect(await verifyPassword('a long enough password', hash)).toBe(true);
    expect(await verifyPassword('a long enough passworD', hash)).toBe(false);
    expect(await verifyPassword('', hash)).toBe(false);
  });

  it('refuses a short password', async () => {
    await expect(hashPassword('short')).rejects.toThrow(/at least 12/);
  });
});
