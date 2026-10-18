/**
 * The only way this process talks to the network.
 *
 * Every request Cronometer sees goes through `guardedRequest`, so the rules that
 * matter are enforced in one place rather than remembered at each call site:
 *
 * - HTTPS to an exact allowlisted host, and nothing else. A redirect is followed
 *   only to another allowlisted host, and only a few times, so a compromised or
 *   confused response cannot point the session cookie somewhere new.
 * - A hard size cap on what is read back. A response that keeps coming is cut off
 *   and refused, never truncated and returned as if it were whole.
 * - A timeout on every request. What a timed-out *write* did is unknown, and the
 *   error says so in words the model is told never to work around.
 */

export const MOBILE_HOST = 'mobile.cronometer.com';
export const WEB_HOST = 'cronometer.com';
export const ALLOWED_HOSTS: ReadonlySet<string> = new Set([MOBILE_HOST, WEB_HOST]);

const DEFAULT_TIMEOUT_MS = 45_000;
const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;
const MAX_REDIRECTS = 3;

export class LiveHttpError extends Error {
  public constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'LiveHttpError';
  }
}

/** The request never got an answer in time, so whether it took effect is unknown. */
export class LiveTimeoutError extends LiveHttpError {
  public constructor(what: string) {
    super(`${what} timed out; its outcome is unknown, so do not retry it automatically.`);
    this.name = 'LiveTimeoutError';
  }
}

export interface LiveResponse {
  readonly status: number;
  readonly headers: Headers;
  readonly text: string;
}

export interface GuardedRequestInit {
  readonly method?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string | FormData;
  readonly cookies?: CookieJar;
  /** Named in errors, e.g. "Cronometer sign-in". Never contains a secret. */
  readonly label: string;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/**
 * A cookie jar for exactly one site. Cronometer's web session is a handful of
 * cookies on one host, so this keeps name → value and nothing else: no paths, no
 * expiry, no domain matching to get wrong. Hosts are already restricted by the
 * caller, and the jar is only ever sent to `cronometer.com`.
 */
export class CookieJar {
  readonly #cookies = new Map<string, string>();

  public get(name: string): string | undefined {
    return this.#cookies.get(name);
  }

  public set(name: string, value: string): void {
    this.#cookies.set(name, value);
  }

  public clear(): void {
    this.#cookies.clear();
  }

  public entries(): [string, string][] {
    return [...this.#cookies.entries()];
  }

  public values(): string[] {
    return [...this.#cookies.values()];
  }

  public header(): string | undefined {
    if (this.#cookies.size === 0) return undefined;
    return [...this.#cookies].map(([name, value]) => `${name}=${value}`).join('; ');
  }

  /** Reads every Set-Cookie on a response. A cookie set to an empty value is a deletion. */
  public absorb(headers: Headers): void {
    for (const line of headers.getSetCookie()) {
      const pair = line.split(';', 1)[0] ?? '';
      const separator = pair.indexOf('=');
      if (separator <= 0) continue;
      const name = pair.slice(0, separator).trim();
      const value = pair.slice(separator + 1).trim();
      if (value === '' || /max-age=0/i.test(line)) this.#cookies.delete(name);
      else this.#cookies.set(name, value);
    }
  }
}

function checkUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new LiveHttpError('The live connector refused a malformed URL.');
  }
  if (url.protocol !== 'https:' || !ALLOWED_HOSTS.has(url.hostname) || url.port !== '') {
    throw new LiveHttpError(
      'The live connector refused a request outside https://cronometer.com and https://mobile.cronometer.com.',
    );
  }
  return url;
}

async function readBounded(response: Response, maxBytes: number, label: string): Promise<string> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel();
    throw new LiveHttpError(`${label}: the response exceeded the ${Math.round(maxBytes / 1024 / 1024)} MB safety limit.`);
  }
  if (response.body === null) return '';

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new LiveHttpError(`${label}: the response exceeded the ${Math.round(maxBytes / 1024 / 1024)} MB safety limit.`);
    }
    chunks.push(value);
  }
  // UTF-8 always. Cronometer's CSV export says `text/csv` with no charset, and
  // guessing Latin-1 there mangles the micro sign in five nutrient headers.
  return new TextDecoder('utf-8').decode(Buffer.concat(chunks));
}

export async function guardedRequest(
  rawUrl: string,
  init: GuardedRequestInit,
  fetchImpl: FetchLike = fetch,
): Promise<LiveResponse> {
  let url = checkUrl(rawUrl);
  let method = init.method ?? 'GET';
  let body = init.body;
  const timeoutMs = init.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const signal = AbortSignal.timeout(timeoutMs);

  for (let hop = 0; ; hop += 1) {
    const headers: Record<string, string> = { ...init.headers };
    const cookie = url.hostname === WEB_HOST ? init.cookies?.header() : undefined;
    if (cookie !== undefined) headers['cookie'] = cookie;

    let response: Response;
    try {
      response = await fetchImpl(url.href, {
        method,
        headers,
        ...(body === undefined ? {} : { body }),
        redirect: 'manual',
        signal,
      });
    } catch (error) {
      if (signal.aborted) throw new LiveTimeoutError(init.label);
      const reason = error instanceof Error ? error.message : 'network error';
      throw new LiveHttpError(`${init.label} could not reach Cronometer: ${reason}`);
    }
    if (url.hostname === WEB_HOST) init.cookies?.absorb(response.headers);

    if (response.status >= 300 && response.status < 400 && response.headers.has('location')) {
      await response.body?.cancel();
      if (hop >= MAX_REDIRECTS) throw new LiveHttpError(`${init.label}: too many redirects.`);
      url = checkUrl(new URL(response.headers.get('location') ?? '', url).href);
      // A 303, or a 301/302 after a POST, becomes a GET without a body, as browsers do.
      if (response.status === 303 || method === 'POST') {
        method = 'GET';
        body = undefined;
      }
      continue;
    }

    try {
      const text = await readBounded(response, init.maxBytes ?? DEFAULT_MAX_BYTES, init.label);
      return { status: response.status, headers: response.headers, text };
    } catch (error) {
      if (signal.aborted) throw new LiveTimeoutError(init.label);
      throw error;
    }
  }
}

/** Parses JSON a response claims to hold, without echoing a body that is not JSON. */
export function parseJson(response: LiveResponse, label: string): unknown {
  try {
    return JSON.parse(response.text) as unknown;
  } catch {
    throw new LiveHttpError(`${label}: Cronometer answered with something that is not JSON (HTTP ${response.status}).`, response.status);
  }
}
