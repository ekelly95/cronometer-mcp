import { describe, expect, it } from 'vitest';

import { CookieJar, LiveHttpError, LiveTimeoutError, guardedRequest, type FetchLike } from '../../src/live/http.js';
import { decodeBase32, totpCode } from '../../src/live/totp.js';

function fake(handler: (url: string, init: RequestInit) => Response | Promise<Response>): FetchLike & { readonly urls: string[] } {
  const urls: string[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    urls.push(url);
    return handler(url, init);
  }) as FetchLike & { urls: string[] };
  fn.urls = urls;
  return fn;
}

describe('guarded requests', () => {
  it('refuses hosts other than Cronometer’s two, and plain HTTP', async () => {
    const fetch = fake(() => new Response('ok'));
    for (const url of ['https://example.com/', 'http://cronometer.com/', 'https://cronometer.com.evil.test/', 'https://cronometer.com:8443/']) {
      await expect(guardedRequest(url, { label: 'test' }, fetch), url).rejects.toThrow(LiveHttpError);
    }
    expect(fetch.urls).toEqual([]);
  });

  it('follows a redirect only to another allowed host', async () => {
    const away = fake(() => new Response(null, { status: 302, headers: { location: 'https://example.com/steal' } }));
    await expect(guardedRequest('https://cronometer.com/login', { label: 'test' }, away)).rejects.toThrow(LiveHttpError);
    expect(away.urls).toEqual(['https://cronometer.com/login']);

    let hops = 0;
    const within = fake(() => (hops++ === 0 ? new Response(null, { status: 302, headers: { location: '/next' } }) : new Response('done')));
    const response = await guardedRequest('https://cronometer.com/login', { label: 'test' }, within);
    expect(response.text).toBe('done');
    expect(within.urls).toEqual(['https://cronometer.com/login', 'https://cronometer.com/next']);
  });

  it('refuses a response larger than the limit rather than truncating it', async () => {
    const fetch = fake(() => new Response('x'.repeat(2048)));
    await expect(guardedRequest('https://mobile.cronometer.com/a', { label: 'test', maxBytes: 1024 }, fetch)).rejects.toThrow('safety limit');
  });

  it('reports a timeout as an unknown outcome', async () => {
    const fetch = fake(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    const failure = guardedRequest('https://mobile.cronometer.com/a', { label: 'Cronometer add_serving', timeoutMs: 20 }, fetch);
    await expect(failure).rejects.toThrow(LiveTimeoutError);
    await expect(failure).rejects.toThrow('outcome is unknown');
  });

  it('decodes as UTF-8 whatever the content type says', async () => {
    const fetch = fake(() => new Response(Buffer.from('Vitamin K (µg)', 'utf8'), { headers: { 'content-type': 'text/csv' } }));
    const response = await guardedRequest('https://cronometer.com/export', { label: 'test' }, fetch);
    expect(response.text).toBe('Vitamin K (µg)');
  });

  it('sends cookies only to the web host', async () => {
    const jar = new CookieJar();
    jar.set('sesnonce', 'secret-nonce');
    const seen: (string | undefined)[] = [];
    const fetch = fake((_url, init) => {
      seen.push((init.headers as Record<string, string>)['cookie']);
      return new Response('ok');
    });
    await guardedRequest('https://cronometer.com/a', { label: 'test', cookies: jar }, fetch);
    await guardedRequest('https://mobile.cronometer.com/a', { label: 'test', cookies: jar }, fetch);
    expect(seen).toEqual(['sesnonce=secret-nonce', undefined]);
  });
});

describe('cookie jar', () => {
  it('keeps what Set-Cookie sets and drops what it clears', () => {
    const jar = new CookieJar();
    const headers = new Headers();
    headers.append('set-cookie', 'sesnonce=abc; Path=/; Secure; HttpOnly');
    headers.append('set-cookie', 'other=1; Path=/');
    jar.absorb(headers);
    expect(jar.get('sesnonce')).toBe('abc');
    const clearing = new Headers();
    clearing.append('set-cookie', 'other=; Max-Age=0');
    jar.absorb(clearing);
    expect(jar.entries()).toEqual([['sesnonce', 'abc']]);
  });
});

describe('two-factor codes', () => {
  // RFC 6238 appendix B, SHA-1: the secret is the ASCII "12345678901234567890".
  const SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

  it('matches the RFC 6238 test vectors (last six digits)', () => {
    expect(totpCode(SECRET, 59_000)).toBe('287082');
    expect(totpCode(SECRET, 1_111_111_109_000)).toBe('081804');
    expect(totpCode(SECRET, 1_234_567_890_000)).toBe('005924');
    expect(totpCode(SECRET, 2_000_000_000_000)).toBe('279037');
  });

  it('ignores the grouping and case authenticator apps display', () => {
    expect(totpCode('gezd gnbv gy3t qojq gezd gnbv gy3t qojq', 59_000)).toBe('287082');
    expect(decodeBase32('MZXW6===').toString('utf8')).toBe('foo');
  });

  it('refuses a secret that is not base32', () => {
    expect(() => totpCode('not-base32!', 0)).toThrow('base32');
  });
});
