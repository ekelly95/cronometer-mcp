import type { Credentials } from '../credentials.js';
import { CookieJar, LiveHttpError, WEB_HOST, guardedRequest, parseJson, type FetchLike, type LiveResponse } from '../http.js';
import { deleteSessionFile, readSessionFile, writeSessionFile } from '../session-file.js';
import { GwtResponseError, gwtNumber, gwtText, parseRepeatedItems, type RepeatedItem } from './gwt.js';

/**
 * Cronometer's web app protocol (GWT-RPC), kept for what the mobile API does not
 * offer: the CSV export, macro-target templates and the weekly schedule, deleting
 * or cancelling a fast, and repeated foods.
 *
 * Sign-in is the website's: fetch the login page for its anti-CSRF token, post the
 * form, keep the `sesnonce` cookie, then ask GWT who we are. Every GWT body names
 * a build-specific "permutation" and policy hash, which change whenever Cronometer
 * deploys; they are discovered from the site's bootstrap script, with fallbacks.
 *
 * Writes are never retried. A rejected session is discarded where it is noticed,
 * so the next call signs in again instead of failing the same way.
 */

const BASE = `https://${WEB_HOST}`;
const LOGIN_PAGE = `${BASE}/login/`;
const LOGIN = `${BASE}/login`;
const GWT_URL = `${BASE}/cronometer/app`;
const GWT_MODULE_BASE = `${BASE}/cronometer/`;
const NOCACHE_JS = `${BASE}/cronometer/cronometer.nocache.js`;
const EXPORT_URL = `${BASE}/export`;
const SERVICE = 'com.cronometer.shared.rpc.CronometerService';
const STRING_TYPE = 'java.lang.String/2004016611';
const DAY_TYPE = 'com.cronometer.shared.entries.models.Day/782579793';

const FALLBACK_PERMUTATION = '8991EC9262AAC4288DD509AA25E804F1';
const FALLBACK_POLICY = 'F074E4C7D41D83A4BC27CA0816B7B731';
const HASH = /^[A-F0-9]{32}$/;
const SESSION_VERSION = 2;

/** Weekdays as getAllMacroSchedules numbers them (0 = Sunday) to saveMacroSchedule's (0 = Monday). */
const US_TO_ISO_WEEKDAY: Readonly<Record<number, number>> = { 0: 6, 1: 0, 2: 1, 3: 2, 4: 3, 5: 4, 6: 5 };

export const EXPORT_TYPES = {
  servings: 'servings',
  daily_summary: 'dailySummary',
  exercises: 'exercises',
  biometrics: 'biometrics',
  notes: 'notes',
} as const;
export type ExportType = keyof typeof EXPORT_TYPES;

export class WebSessionExpired extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'WebSessionExpired';
  }
}

interface WebSession {
  readonly username: string;
  readonly nonce: string;
  readonly userId: string;
  readonly permutation: string;
  readonly policy: string;
}

export interface WebClientOptions {
  readonly credentials: () => Credentials;
  readonly sessionPath?: string;
  readonly fetch?: FetchLike;
  readonly timeoutMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** A calendar day as GWT's Day object carries it: day, month, year. */
function dayFields(isoDay: string): string {
  const [year, month, day] = isoDay.split('-').map(Number) as [number, number, number];
  return `${day}|${month}|${year}`;
}

export class WebClient {
  readonly #credentials: () => Credentials;
  readonly #sessionPath: string | undefined;
  readonly #fetch: FetchLike | undefined;
  readonly #timeoutMs: number | undefined;
  readonly #cookies = new CookieJar();
  #session: WebSession | undefined;
  #signingIn: Promise<WebSession> | undefined;
  /** Cookie values and nonces this process has held and dropped. */
  readonly #retired: string[] = [];

  public constructor(options: WebClientOptions) {
    this.#credentials = options.credentials;
    this.#sessionPath = options.sessionPath;
    this.#fetch = options.fetch;
    this.#timeoutMs = options.timeoutMs;
  }

  public secrets(): string[] {
    return [...this.#retired, ...this.#cookies.values(), ...(this.#session === undefined ? [] : [this.#session.nonce])];
  }

  // ── Session ────────────────────────────────────────────────────────────

  async #ensure(): Promise<WebSession> {
    if (this.#session !== undefined) return this.#session;
    const restored = this.#restore();
    if (restored !== undefined) {
      this.#session = restored;
      return restored;
    }
    this.#signingIn ??= this.#login().finally(() => {
      this.#signingIn = undefined;
    });
    return this.#signingIn;
  }

  async #login(): Promise<WebSession> {
    const credentials = this.#credentials();
    this.#cookies.clear();
    const { permutation, policy } = await this.#discoverHashes();

    const page = await this.#request(LOGIN_PAGE, { label: 'Cronometer web sign-in' });
    const token = /name="anticsrf"\s+value="([^"]+)"/.exec(page.text)?.[1];
    if (token === undefined) throw new LiveHttpError('Cronometer web sign-in: the login page had no anti-CSRF token.');

    const form = new URLSearchParams({ anticsrf: token, username: credentials.username, password: credentials.password });
    const posted = await this.#request(LOGIN, {
      method: 'POST',
      label: 'Cronometer web sign-in',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
    const result = parseJson(posted, 'Cronometer web sign-in');
    if (!isRecord(result) || result['error'] !== undefined || !(result['success'] || result['redirect'])) {
      throw new LiveHttpError('Cronometer web sign-in was refused. Check the username and password with `cronometer-mcp setup`.');
    }
    const nonce = this.#cookies.get('sesnonce');
    if (nonce === undefined) throw new LiveHttpError('Cronometer web sign-in succeeded but set no session cookie.');

    const authenticated = await this.#gwtSend(
      `7|0|5|${GWT_MODULE_BASE}|${policy}|${SERVICE}|authenticate|java.lang.Integer/3438268394|1|2|3|4|1|5|5|-300|`,
      permutation,
    );
    const userId = /OK\[(\d+),/.exec(authenticated)?.[1];
    if (userId === undefined) throw new GwtResponseError('Cronometer web sign-in did not return an account id.');

    const session: WebSession = {
      username: credentials.username,
      nonce: this.#cookies.get('sesnonce') ?? nonce,
      userId,
      permutation,
      policy,
    };
    this.#session = session;
    this.#save();
    return session;
  }

  async #discoverHashes(): Promise<{ readonly permutation: string; readonly policy: string }> {
    try {
      const bootstrap = await this.#request(NOCACHE_JS, { label: 'Cronometer web bootstrap' });
      const permutation = /='([A-F0-9]{32})'/.exec(bootstrap.text)?.[1];
      if (permutation === undefined) return { permutation: FALLBACK_PERMUTATION, policy: FALLBACK_POLICY };
      const compiled = await this.#request(`${BASE}/cronometer/${permutation}.cache.js`, {
        label: 'Cronometer web bootstrap',
        maxBytes: 40 * 1024 * 1024,
      });
      const policy = /'app','([A-F0-9]{32})'/.exec(compiled.text)?.[1];
      return { permutation, policy: policy ?? FALLBACK_POLICY };
    } catch {
      return { permutation: FALLBACK_PERMUTATION, policy: FALLBACK_POLICY };
    }
  }

  #restore(): WebSession | undefined {
    if (this.#sessionPath === undefined) return undefined;
    const cached = readSessionFile(this.#sessionPath);
    if (!isRecord(cached) || cached['version'] !== SESSION_VERSION) return undefined;
    let expected: string;
    try {
      expected = this.#credentials().username;
    } catch {
      return undefined;
    }
    const { username, nonce, userId, permutation, policy, cookies } = cached;
    if (
      username !== expected ||
      typeof nonce !== 'string' ||
      nonce.length > 1024 ||
      typeof userId !== 'string' ||
      !/^\d+$/.test(userId) ||
      typeof permutation !== 'string' ||
      !HASH.test(permutation) ||
      typeof policy !== 'string' ||
      !HASH.test(policy) ||
      !isRecord(cookies) ||
      Object.keys(cookies).length > 100
    ) {
      deleteSessionFile(this.#sessionPath);
      return undefined;
    }
    this.#cookies.clear();
    for (const [name, value] of Object.entries(cookies)) {
      if (typeof value === 'string' && name.length <= 256 && value.length <= 8192) this.#cookies.set(name, value);
    }
    return { username, nonce, userId, permutation, policy };
  }

  #save(): void {
    if (this.#sessionPath === undefined || this.#session === undefined) return;
    writeSessionFile(this.#sessionPath, {
      version: SESSION_VERSION,
      ...this.#session,
      cookies: Object.fromEntries(this.#cookies.entries()),
    });
  }

  #discard(): void {
    this.#retired.push(...this.#cookies.values(), ...(this.#session === undefined ? [] : [this.#session.nonce]));
    this.#retired.splice(0, Math.max(0, this.#retired.length - 50));
    this.#session = undefined;
    this.#cookies.clear();
    if (this.#sessionPath !== undefined) deleteSessionFile(this.#sessionPath);
  }

  // ── Transport ──────────────────────────────────────────────────────────

  #request(
    url: string,
    init: { readonly method?: string; readonly label: string; readonly headers?: Record<string, string>; readonly body?: string; readonly maxBytes?: number },
  ): Promise<LiveResponse> {
    return guardedRequest(
      url,
      {
        ...init,
        headers: { 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64)', ...init.headers },
        cookies: this.#cookies,
        ...(this.#timeoutMs === undefined ? {} : { timeoutMs: this.#timeoutMs }),
      },
      this.#fetch,
    );
  }

  async #gwtSend(body: string, permutation: string): Promise<string> {
    const response = await this.#request(GWT_URL, {
      method: 'POST',
      label: 'Cronometer web call',
      headers: {
        'content-type': 'text/x-gwt-rpc; charset=UTF-8',
        'x-gwt-module-base': GWT_MODULE_BASE,
        'x-gwt-permutation': permutation,
      },
      body,
    });
    if (response.status >= 400) throw new LiveHttpError(`Cronometer web call failed with HTTP ${response.status}.`, response.status);
    const text = response.text;
    if (text.startsWith('//OK')) return text;
    if (text.startsWith('//EX')) {
      if (text.includes('IncompatibleRemoteServiceException')) {
        // Either Cronometer deployed a new build since the session was cached, or the
        // method itself changed. Dropping the session makes the next call rediscover
        // the build hashes, which fixes the first; nothing here can fix the second.
        this.#discard();
        throw new GwtResponseError(
          'Cronometer rejected this web operation as incompatible. The cached build information was discarded; if the next attempt fails the same way, Cronometer has changed the operation itself.',
        );
      }
      this.#discard();
      throw new WebSessionExpired(
        'Cronometer rejected the web call, most likely because the session expired. The saved session was discarded, so the next call signs in again.',
      );
    }
    throw new GwtResponseError('Cronometer returned an unreadable web response.');
  }

  /** A GWT write: sent once, never retried. */
  async #gwtWrite(build: (session: WebSession) => string): Promise<string> {
    const session = await this.#ensure();
    return this.#gwtSend(build(session), session.permutation);
  }

  /** A GWT read: may sign in again once. Takes a builder because the body embeds the nonce. */
  async #gwtRead(build: (session: WebSession) => string): Promise<string> {
    const session = await this.#ensure();
    try {
      return await this.#gwtSend(build(session), session.permutation);
    } catch (error) {
      if (!(error instanceof WebSessionExpired)) throw error;
      const fresh = await this.#ensure();
      return this.#gwtSend(build(fresh), fresh.permutation);
    }
  }

  #head(session: WebSession, count: number, method: string, ...strings: string[]): string {
    return [`7|0|${count}|${GWT_MODULE_BASE}`, session.policy, SERVICE, method, ...strings].join('|') + '|';
  }

  // ── Export ─────────────────────────────────────────────────────────────

  public async exportCsv(type: ExportType, start: string, end: string): Promise<string> {
    try {
      return await this.#exportOnce(type, start, end);
    } catch (error) {
      if (!(error instanceof WebSessionExpired)) throw error;
      return this.#exportOnce(type, start, end);
    }
  }

  async #exportOnce(type: ExportType, start: string, end: string): Promise<string> {
    const raw = await this.#gwtRead((session) =>
      this.#head(session, 8, 'generateAuthorizationToken', STRING_TYPE, 'I', 'com.cronometer.shared.user.AuthScope/2065601159', session.nonce) +
      `1|2|3|4|4|5|6|6|7|8|${session.userId}|3600|7|2|`,
    );
    const token = /"([^"]+)"/.exec(raw)?.[1];
    if (token === undefined) throw new GwtResponseError('Cronometer did not issue an export token.');

    const query = new URLSearchParams({ nonce: token, generate: EXPORT_TYPES[type], start, end });
    const response = await this.#request(`${EXPORT_URL}?${query.toString()}`, {
      label: 'Cronometer export',
      headers: { 'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate', 'sec-fetch-site': 'same-origin' },
    });
    if (response.status === 401 || response.status === 403) {
      this.#discard();
      throw new WebSessionExpired(`Cronometer refused the export with HTTP ${response.status}.`);
    }
    if (response.status >= 400) throw new LiveHttpError(`Cronometer export failed with HTTP ${response.status}.`, response.status);
    return response.text;
  }

  // ── Macro targets ──────────────────────────────────────────────────────

  public async setDailyTargets(day: string, targets: MacroValues, templateName: string): Promise<void> {
    const raw = await this.#gwtWrite((session) =>
      this.#head(
        session,
        12,
        'updateDailyTargetTemplate',
        STRING_TYPE,
        'I',
        'com.cronometer.shared.targets.models.MacroTargetTemplate/3691130822',
        session.nonce,
        'java.lang.Boolean/476441737',
        'java.lang.Double/858496421',
        DAY_TYPE,
        gwtText(templateName),
      ) +
      `1|2|3|4|3|5|6|7|8|${session.userId}|` +
      `7|9|0|10|${gwtNumber(targets.carbs_g)}|0|11|${dayFields(day)}|` +
      `10|${gwtNumber(targets.calories)}|10|${gwtNumber(targets.fat_g)}|0|1|0|0|0|12|10|${gwtNumber(targets.protein_g)}|0|`,
    );
    if (!raw.includes('Success')) throw new GwtResponseError('Cronometer did not confirm the new daily targets.');
  }

  /** Creates a template. Its id is read back by the caller from the template list. */
  public async createMacroTemplate(name: string, targets: MacroValues): Promise<void> {
    const carbs = gwtNumber(targets.carbs_g);
    const fat = gwtNumber(targets.fat_g);
    const calories = gwtNumber(targets.calories);
    const protein = gwtNumber(targets.protein_g);
    await this.#gwtWrite((session) => {
      const head =
        this.#head(
          session,
          13,
          'saveMacroTargetTemplate',
          STRING_TYPE,
          'I',
          'com.cronometer.shared.targets.models.MacroTargetTemplate/3691130822',
          session.nonce,
          'java.lang.Boolean/476441737',
          'java.lang.Double/858496421',
          'java.lang.Integer/3438268394',
          'Rigorous',
          gwtText(name),
        ) + '1|2|3|4|3|5|6|7|';
      // GWT refers back to an equal Double it has already written, so equal fat and
      // carbs serialise differently from unequal ones. Both layouts were captured.
      const data =
        targets.fat_g === targets.carbs_g
          ? `8|${session.userId}|7|9|0|10|${carbs}|-3|0|10|${calories}|-3|-3|0|11|0|12|0|13|10|${protein}|-6|`
          : `8|${session.userId}|7|9|0|10|${carbs}|10|${fat}|0|10|${calories}|10|${fat}|10|${fat}|0|11|0|12|0|13|10|${protein}|10|${calories}|`;
      return head + data;
    });
  }

  public async deleteMacroTemplate(templateId: number): Promise<void> {
    await this.#gwtWrite(
      (session) =>
        this.#head(session, 7, 'deleteMacroTargetTemplate', STRING_TYPE, 'I', session.nonce) +
        `1|2|3|4|3|5|6|6|7|${session.userId}|${templateId}|`,
    );
  }

  /** `weekday` is 0 = Sunday … 6 = Saturday; 0 as template id means the profile's default targets. */
  public async setScheduleDay(weekday: number, templateId: number): Promise<void> {
    const iso = US_TO_ISO_WEEKDAY[weekday];
    if (iso === undefined) throw new Error('weekday must be 0 through 6');
    await this.#gwtWrite(
      (session) =>
        this.#head(
          session,
          9,
          'saveMacroSchedule',
          STRING_TYPE,
          'I',
          'com.cronometer.shared.targets.DayOfWeek/913617675',
          session.nonce,
          'com.cronometer.shared.targets.DayOfWeek$DayOfWeekEnum/3974900421',
        ) + `1|2|3|4|4|5|6|7|6|8|${session.userId}|7|9|${iso}|${templateId}|`,
    );
  }

  // ── Fasting ────────────────────────────────────────────────────────────

  public async deleteFast(fastId: number): Promise<void> {
    await this.#gwtWrite(
      (session) =>
        this.#head(session, 8, 'deleteFast', STRING_TYPE, 'I', 'java.lang.Integer/3438268394', session.nonce) +
        `1|2|3|4|4|5|6|6|7|8|${session.userId}|${fastId}|0|`,
    );
  }

  public async cancelFastKeepSeries(fastId: number): Promise<void> {
    await this.#gwtWrite(
      (session) =>
        this.#head(session, 7, 'cancelFastAndKeepSeries', STRING_TYPE, 'I', session.nonce) +
        `1|2|3|4|3|5|6|6|7|${session.userId}|${fastId}|`,
    );
  }

  // ── Repeated foods ─────────────────────────────────────────────────────

  public async repeatedItems(): Promise<{ readonly items: RepeatedItem[]; readonly unverified: boolean }> {
    const raw = await this.#gwtRead(
      (session) =>
        this.#head(session, 7, 'getRepeatedItems', STRING_TYPE, 'I', session.nonce) + `1|2|3|4|2|5|6|7|${session.userId}|`,
    );
    return parseRepeatedItems(raw);
  }

  public async addRepeatItem(item: {
    readonly foodSourceId: number;
    readonly foodId: number;
    readonly quantity: number;
    readonly foodName: string;
    readonly diaryGroup: number;
    readonly daysOfWeek: readonly number[];
  }): Promise<void> {
    const days = item.daysOfWeek.map((day) => `10|${day}`).join('|');
    await this.#gwtWrite(
      (session) =>
        this.#head(
          session,
          11,
          'addRepeatItem',
          STRING_TYPE,
          'I',
          'com.cronometer.shared.repeatitems.RepeatItem/477684891',
          session.nonce,
          'java.util.ArrayList/4159755760',
          'java.lang.Integer/3438268394',
          gwtText(item.foodName),
        ) +
        `1|2|3|4|3|5|6|7|8|${session.userId}|7|${gwtNumber(item.quantity)}|` +
        `9|${item.daysOfWeek.length}|${days}|` +
        `0|11|${item.diaryGroup}|0|${item.foodSourceId}|${item.foodId}|0|`,
    );
  }

  public async deleteRepeatItem(repeatItemId: number): Promise<void> {
    await this.#gwtWrite(
      (session) =>
        this.#head(session, 7, 'deleteRepeatItem', STRING_TYPE, 'I', session.nonce) +
        `1|2|3|4|3|5|6|6|7|${session.userId}|${repeatItemId}|`,
    );
  }
}

export interface MacroValues {
  readonly protein_g: number;
  readonly fat_g: number;
  readonly carbs_g: number;
  readonly calories: number;
}
