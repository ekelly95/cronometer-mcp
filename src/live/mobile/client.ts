import type { Credentials } from '../credentials.js';
import {
  LiveHttpError,
  MOBILE_HOST,
  guardedRequest,
  parseJson,
  type FetchLike,
  type LiveResponse,
} from '../http.js';
import { deleteSessionFile, readSessionFile, writeSessionFile } from '../session-file.js';
import { totpCode } from '../totp.js';
import { appIdentity, type AppIdentity } from './identity.js';

/**
 * A client for Cronometer's mobile JSON API — the private interface the Android
 * app uses, at https://mobile.cronometer.com.
 *
 * Two request styles exist there. Most calls are `POST /api/v2/<name>` with a
 * JSON body carrying an `auth` block; a few newer ones are REST under
 * `/api/v3/user/<id>/...` with the session in an `x-crono-session` header.
 *
 * Retrying follows the rule the rest of the project keeps: a read that meets an
 * expired session signs in again and tries once more; a write is never sent
 * twice unless Cronometer rejected it outright with 401/403, which means it was
 * not applied. A write that fails any other way, or times out, is reported and
 * left alone.
 */

export type JsonRecord = Record<string, unknown>;

export class CronometerApiError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'CronometerApiError';
  }
}

export interface MobileSession {
  readonly username: string;
  readonly userId: number;
  readonly token: string;
  /** The account's IANA timezone as Cronometer reports it, or null if it has none. */
  readonly timezone: string | null;
}

/** What a sign-in tells us about the account that is not secret and is costly to re-learn. */
export interface AccountProfile {
  readonly nutrients: readonly JsonRecord[];
  readonly targets: readonly JsonRecord[];
  readonly prefs: Readonly<Record<string, string>>;
  readonly metrics: readonly JsonRecord[];
}

export interface MobileClientOptions {
  readonly credentials: () => Credentials;
  /** Where the session is cached between runs; absent keeps it in memory only. */
  readonly sessionPath?: string;
  readonly fetch?: FetchLike;
  readonly identity?: AppIdentity;
  readonly timeoutMs?: number;
}

const BASE_URL = `https://${MOBILE_HOST}`;
const SESSION_VERSION = 1;

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function failed(body: unknown): boolean {
  return isRecord(body) && (body['result'] === 'FAIL' || body['result'] === 'FAILURE');
}

/** An error string Cronometer sent, bounded and stripped of anything structural. */
function reason(body: unknown): string {
  if (!isRecord(body)) return 'no detail';
  const detail = body['error'] ?? body['message'] ?? body['result'];
  return typeof detail === 'string' ? detail.slice(0, 200) : 'no detail';
}

function preferences(raw: unknown): Record<string, string> {
  const result: Record<string, string> = {};
  if (!Array.isArray(raw)) return result;
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    for (const [key, value] of Object.entries(entry)) {
      if (typeof value === 'string') result[key] = value;
    }
  }
  return result;
}

function records(raw: unknown): JsonRecord[] {
  return Array.isArray(raw) ? raw.filter(isRecord) : [];
}

export class MobileClient {
  readonly #credentials: () => Credentials;
  readonly #sessionPath: string | undefined;
  readonly #fetch: FetchLike | undefined;
  readonly #identity: AppIdentity;
  readonly #timeoutMs: number | undefined;
  #session: MobileSession | undefined;
  #profile: AccountProfile | undefined;
  #signingIn: Promise<MobileSession> | undefined;
  /** Tokens this process has held and dropped. A failure can still echo one. */
  readonly #retired: string[] = [];

  public constructor(options: MobileClientOptions) {
    this.#credentials = options.credentials;
    this.#sessionPath = options.sessionPath;
    this.#fetch = options.fetch;
    this.#identity = options.identity ?? appIdentity();
    this.#timeoutMs = options.timeoutMs;
  }

  /** The secrets this client holds right now, for redaction. */
  public secrets(): string[] {
    return [...this.#retired, ...(this.#session === undefined ? [] : [this.#session.token])];
  }

  public hasCachedSession(): boolean {
    return this.#session !== undefined || (this.#sessionPath !== undefined && this.#restore() !== undefined);
  }

  public async session(): Promise<MobileSession> {
    if (this.#session !== undefined) return this.#session;
    const restored = this.#restore();
    if (restored !== undefined) {
      this.#session = restored;
      return restored;
    }
    return this.#signIn();
  }

  /** The account profile from the latest sign-in or cache. Signs in only if neither exists. */
  public async profile(): Promise<AccountProfile> {
    await this.session();
    if (this.#profile !== undefined) return this.#profile;
    // A session restored from disk carries the profile with it; one from an older
    // cache does not, and the only source of per-nutrient targets is a sign-in.
    this.#discard();
    await this.#signIn();
    if (this.#profile === undefined) throw new CronometerApiError('Signing in returned no account profile.');
    return this.#profile;
  }

  public async read(endpoint: string, payload: JsonRecord = {}): Promise<JsonRecord> {
    const sent = await this.session();
    const first = await this.#post(endpoint, payload, sent);
    if (!this.#rejected(first) && !failed(first.body)) return this.#checked(endpoint, first);

    this.#discard(sent);
    const retried = await this.#post(endpoint, payload, await this.session());
    return this.#checked(endpoint, retried);
  }

  public async write(endpoint: string, payload: JsonRecord): Promise<JsonRecord> {
    const sent = await this.session();
    const first = await this.#post(endpoint, payload, sent);
    if (this.#rejected(first)) {
      // Refused before it was applied, so sending it again cannot duplicate it.
      this.#discard(sent);
      return this.#checked(endpoint, await this.#post(endpoint, payload, await this.session()));
    }
    if (failed(first.body)) {
      // HTTP 200 with a failure body. An expired session looks like this too, so the
      // session is dropped — but the write is not repeated: the next attempt is the
      // user's to make.
      this.#discard(sent);
      throw new CronometerApiError(
        `Cronometer reported that ${endpoint} failed (${reason(first.body)}). The saved session was discarded, so a new attempt signs in again.`,
      );
    }
    return this.#checked(endpoint, first);
  }

  /** A REST call under /api/v3/user/<id>. Returns the raw response; callers read the status. */
  public async v3(method: 'GET' | 'DELETE' | 'POST' | 'PUT', path: string, body?: unknown): Promise<LiveResponse> {
    const send = async (session: MobileSession): Promise<LiveResponse> =>
      guardedRequest(
        `${BASE_URL}/api/v3/user/${session.userId}${path}`,
        {
          method,
          label: `Cronometer ${method} ${path.split('?')[0]}`,
          headers: {
            'user-agent': this.#identity.userAgent,
            'x-crono-session': session.token,
            'x-crono-app-os': 'android',
            'x-crono-app-build-number': this.#identity.buildNumber,
            'x-crono-app-version': this.#identity.appVersion,
            'content-type': 'application/json; charset=utf-8',
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          ...(this.#timeoutMs === undefined ? {} : { timeoutMs: this.#timeoutMs }),
        },
        this.#fetch,
      );
    const sent = await this.session();
    const first = await send(sent);
    if (first.status !== 401 && first.status !== 403) return first;
    this.#discard(sent);
    // A 401/403 means the call was refused, so even a write may be re-sent safely.
    return send(await this.session());
  }

  /**
   * The app's photo-upload endpoint, which is also how it saves diary notes: a
   * multipart form authenticated by a `sessionKey` field rather than the JSON
   * auth block. Always a write, never retried.
   */
  public async upload(fields: Readonly<Record<string, string>>): Promise<JsonRecord> {
    const session = await this.session();
    const form = new FormData();
    form.set('sessionKey', session.token);
    for (const [name, value] of Object.entries(fields)) form.set(name, value);
    const response = await guardedRequest(
      `${BASE_URL}/photoupload`,
      {
        method: 'POST',
        label: 'Cronometer note upload',
        headers: { 'user-agent': this.#identity.userAgent },
        body: form,
        ...(this.#timeoutMs === undefined ? {} : { timeoutMs: this.#timeoutMs }),
      },
      this.#fetch,
    );
    if (response.status === 401 || response.status === 403) {
      this.#discard(session);
      throw new CronometerApiError('Cronometer refused the upload because the session had expired. Nothing was saved; the session was discarded, so a new attempt signs in again.');
    }
    if (response.status >= 400) throw new LiveHttpError(`Cronometer note upload failed with HTTP ${response.status}.`, response.status);
    const body = parseJson(response, 'Cronometer note upload');
    if (!isRecord(body)) throw new CronometerApiError('Cronometer note upload returned an unexpected shape.');
    return body;
  }

  async #post(endpoint: string, payload: JsonRecord, session: MobileSession): Promise<{ readonly response: LiveResponse; readonly body: unknown }> {
    const body = {
      ...payload,
      auth: this.#authBlock(session),
      lastSeen: 0,
    };
    const response = await guardedRequest(
      `${BASE_URL}/api/v2/${endpoint}`,
      {
        method: 'POST',
        label: `Cronometer ${endpoint}`,
        headers: {
          'user-agent': this.#identity.userAgent,
          'content-type': 'text/plain; charset=utf-8',
        },
        body: JSON.stringify(body),
        ...(this.#timeoutMs === undefined ? {} : { timeoutMs: this.#timeoutMs }),
      },
      this.#fetch,
    );
    if (response.status === 401 || response.status === 403) return { response, body: undefined };
    return { response, body: response.status >= 400 ? undefined : parseJson(response, `Cronometer ${endpoint}`) };
  }

  #rejected(result: { readonly response: LiveResponse }): boolean {
    return result.response.status === 401 || result.response.status === 403;
  }

  #checked(endpoint: string, result: { readonly response: LiveResponse; readonly body: unknown }): JsonRecord {
    if (result.response.status >= 400) {
      throw new LiveHttpError(`Cronometer ${endpoint} failed with HTTP ${result.response.status}.`, result.response.status);
    }
    if (failed(result.body)) {
      throw new CronometerApiError(`Cronometer reported that ${endpoint} failed (${reason(result.body)}).`);
    }
    if (!isRecord(result.body)) {
      throw new CronometerApiError(`Cronometer ${endpoint} returned an unexpected shape.`);
    }
    return result.body;
  }

  #authBlock(session: MobileSession | undefined): JsonRecord {
    return {
      userId: session?.userId ?? null,
      token: session?.token ?? null,
      api: 3,
      os: 'Android',
      build: this.#identity.buildNumber,
      flavour: 'free',
    };
  }

  /** One sign-in at a time: a burst of expired calls shares a single login. */
  #signIn(): Promise<MobileSession> {
    this.#signingIn ??= this.#login().finally(() => {
      this.#signingIn = undefined;
    });
    return this.#signingIn;
  }

  async #login(): Promise<MobileSession> {
    const credentials = this.#credentials();
    const response = await guardedRequest(
      `${BASE_URL}/api/v2/login`,
      {
        method: 'POST',
        label: 'Cronometer sign-in',
        headers: {
          'user-agent': this.#identity.userAgent,
          'content-type': 'text/plain; charset=utf-8',
        },
        body: JSON.stringify({
          email: credentials.username,
          password: credentials.password,
          // Must stay null. A non-null timezone here is a write: it replaces the
          // account's own timezone setting, and that persists.
          timezone: null,
          userCode: credentials.totpSecret === undefined ? null : totpCode(credentials.totpSecret),
          build: `${this.#identity.appVersion} b${this.#identity.buildNumber}-a`,
          device: this.#identity.device,
          firebaseToken: '',
          features: {
            food_search_config: '{"newSearch": true, "newSpellcheck": true}',
            use_gpt_autofill: 'true',
          },
          auth: this.#authBlock(undefined),
          lastSeen: 0,
          config: { call_version: 2 },
        }),
        ...(this.#timeoutMs === undefined ? {} : { timeoutMs: this.#timeoutMs }),
      },
      this.#fetch,
    );
    if (response.status === 429) {
      throw new CronometerApiError('Cronometer is rate-limiting sign-ins for this account. Wait a few minutes before trying again.');
    }
    if (response.status >= 400) {
      throw new LiveHttpError(`Cronometer sign-in failed with HTTP ${response.status}.`, response.status);
    }
    const body = parseJson(response, 'Cronometer sign-in');
    if (!isRecord(body) || typeof body['sessionKey'] !== 'string' || typeof body['id'] !== 'number') {
      if (isRecord(body) && body['error'] === 'TOTP_CODE_REQUIRED') {
        throw new CronometerApiError(
          'This account has two-factor authentication. Re-run `cronometer-mcp setup` and give the base32 key shown when two-factor was enabled.',
        );
      }
      throw new CronometerApiError(`Cronometer sign-in failed (${reason(body)}). Check the username and password with \`cronometer-mcp setup\`.`);
    }

    const timezone = typeof body['timezone'] === 'string' && body['timezone'] !== '' ? body['timezone'] : null;
    const session: MobileSession = {
      username: credentials.username,
      userId: body['id'],
      token: body['sessionKey'],
      timezone,
    };
    this.#session = session;
    this.#profile = {
      nutrients: records(body['nutrients']),
      targets: isRecord(body['targets']) ? records(body['targets']['targets']) : [],
      prefs: preferences(body['prefs']),
      metrics: records(body['metrics']),
    };
    this.#save();
    return session;
  }

  #restore(): MobileSession | undefined {
    if (this.#sessionPath === undefined) return undefined;
    const cached = readSessionFile(this.#sessionPath);
    if (!isRecord(cached) || cached['version'] !== SESSION_VERSION) return undefined;
    const { username, userId, token, timezone, profile } = cached;
    let expected: string;
    try {
      expected = this.#credentials().username;
    } catch {
      return undefined;
    }
    if (
      username !== expected ||
      typeof userId !== 'number' ||
      typeof token !== 'string' ||
      token.length > 4096 ||
      (timezone !== null && typeof timezone !== 'string')
    ) {
      deleteSessionFile(this.#sessionPath);
      return undefined;
    }
    if (isRecord(profile)) {
      this.#profile = {
        nutrients: records(profile['nutrients']),
        targets: records(profile['targets']),
        prefs: isRecord(profile['prefs'])
          ? Object.fromEntries(Object.entries(profile['prefs']).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
          : {},
        metrics: records(profile['metrics']),
      };
    }
    return { username, userId, token, timezone };
  }

  #save(): void {
    if (this.#sessionPath === undefined || this.#session === undefined) return;
    writeSessionFile(this.#sessionPath, { version: SESSION_VERSION, ...this.#session, profile: this.#profile ?? null });
  }

  /** Forget a session, unless a newer one has already replaced the one that failed. */
  #discard(stale?: MobileSession): void {
    if (stale !== undefined && this.#session !== undefined && this.#session.token !== stale.token) return;
    if (this.#session !== undefined) {
      this.#retired.push(this.#session.token);
      this.#retired.splice(0, Math.max(0, this.#retired.length - 10));
    }
    this.#session = undefined;
    if (this.#sessionPath !== undefined) deleteSessionFile(this.#sessionPath);
  }
}
