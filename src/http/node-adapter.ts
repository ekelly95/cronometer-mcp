import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Readable } from 'node:stream';

/**
 * Serves a web-standard `fetch(request)` handler from `node:http`.
 *
 * The SDK's own adapter lives in `@modelcontextprotocol/node`, which has not been
 * published at the version this project pins, and this is the whole of what it
 * would do here: build a `Request`, stream the `Response` back, and abort the
 * handler when the client goes away. Streaming matters — a modern MCP response
 * can upgrade to server-sent events, which must reach the client as written
 * rather than when the handler finishes.
 */

export type FetchHandler = (request: Request) => Promise<Response>;

function toRequest(incoming: IncomingMessage, signal: AbortSignal): Request {
  const url = new URL(incoming.url ?? '/', `http://${incoming.headers.host ?? 'localhost'}`);
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const item of value) headers.append(name, item);
    else headers.set(name, value);
  }
  const hasBody = incoming.method !== 'GET' && incoming.method !== 'HEAD';
  return new Request(url, {
    method: incoming.method ?? 'GET',
    headers,
    signal,
    ...(hasBody ? { body: Readable.toWeb(incoming) as ReadableStream<Uint8Array>, duplex: 'half' } : {}),
  } as RequestInit);
}

async function writeResponse(response: Response, outgoing: ServerResponse): Promise<void> {
  const headers: Record<string, string | string[]> = {};
  response.headers.forEach((value, name) => {
    headers[name] = value;
  });
  const cookies = response.headers.getSetCookie();
  if (cookies.length > 0) headers['set-cookie'] = cookies;
  outgoing.writeHead(response.status, headers);
  // Headers go out now, not with the first chunk: an SSE stream may wait a while
  // before it has anything to say, and the client should know it is connected.
  outgoing.flushHeaders();

  if (response.body === null) {
    outgoing.end();
    return;
  }
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!outgoing.write(value)) {
        await new Promise<void>((resolveDrain) => {
          const finish = (): void => {
            outgoing.off('drain', finish);
            outgoing.off('close', finish);
            resolveDrain();
          };
          outgoing.once('drain', finish);
          outgoing.once('close', finish);
        });
      }
      if (outgoing.destroyed) break;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    outgoing.end();
  }
}

export function serveFetch(
  handler: FetchHandler,
  onError: (error: unknown) => void = (error) => {
    process.stderr.write(`Remote connector request failed: ${error instanceof Error ? error.message : 'unknown error'}\n`);
  },
): Server {
  return createServer((incoming, outgoing) => {
    const abort = new AbortController();
    outgoing.on('close', () => {
      if (!outgoing.writableFinished) abort.abort();
    });
    void (async () => {
      try {
        const response = await handler(toRequest(incoming, abort.signal));
        await writeResponse(response, outgoing);
      } catch (error) {
        onError(error);
        if (!outgoing.headersSent) {
          outgoing.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
          outgoing.end('Internal server error');
        } else {
          outgoing.destroy();
        }
      }
    })();
  });
}
