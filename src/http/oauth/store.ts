import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Registered clients and issued tokens for the single-user authorization server.
 *
 * Tokens are stored only as SHA-256 hashes: the file is a list of things that
 * were issued, not a list of things that can be replayed. Losing it costs a
 * sign-in, nothing more, which is why a file that cannot be read is replaced with
 * an empty one rather than refusing to start.
 */

export const ACCESS_TOKEN_LIFETIME_MS = 60 * 60 * 1_000;
export const REFRESH_TOKEN_LIFETIME_MS = 30 * 24 * 60 * 60 * 1_000;
/**
 * How long a refresh token that has already been exchanged can be presented again
 * without being treated as stolen. Claude refreshes both ahead of expiry and on a
 * 401, and if those two race they present the same token twice; a minute covers
 * that without leaving a replayable token around for long.
 */
export const REFRESH_REUSE_GRACE_MS = 60 * 1_000;
/** A spent refresh token is kept this long, so presenting it later is recognised as reuse. */
const SPENT_REFRESH_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
/**
 * Dynamic registration gives every fresh connection its own client, so without a
 * ceiling the list only grows. The oldest go first; a connection that still used
 * one gets `invalid_client`, which tells Claude to register again.
 */
export const MAXIMUM_CLIENTS = 20;

const STATE_FILE = 'state.json';

export interface ClientRecord {
  readonly redirectUris: readonly string[];
  readonly clientName?: string;
  readonly createdAt: number;
}

interface TokenRecord {
  readonly clientId: string;
  /** Every token descended from one sign-in shares this, so a theft revokes them together. */
  readonly familyId: string;
  readonly expiresAt: number;
}

interface RefreshRecord extends TokenRecord {
  readonly spentAt?: number;
}

interface StateFile {
  readonly version: 1;
  readonly clients: Record<string, ClientRecord>;
  readonly accessTokens: Record<string, TokenRecord>;
  readonly refreshTokens: Record<string, RefreshRecord>;
}

export interface IssuedTokens {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresInSeconds: number;
}

export interface AccessTokenRecord {
  readonly clientId: string;
  readonly expiresAt: number;
}

export type RefreshOutcome =
  | { readonly kind: 'accepted'; readonly familyId: string }
  | { readonly kind: 'invalid' }
  /** A token exchanged long ago came back: the whole family is now revoked. */
  | { readonly kind: 'reused' };

export interface OAuthStoreOptions {
  readonly now?: () => number;
  readonly diagnostics?: (text: string) => void;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function newSecret(): string {
  return randomBytes(32).toString('base64url');
}

function emptyState(): StateFile {
  return { version: 1, clients: {}, accessTokens: {}, refreshTokens: {} };
}

function isRecordOf(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export class OAuthStore {
  readonly #path: string;
  readonly #now: () => number;
  #state: StateFile;

  public constructor(directory: string, options: OAuthStoreOptions = {}) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.#path = join(directory, STATE_FILE);
    this.#now = options.now ?? Date.now;
    this.#state = this.#load(options.diagnostics ?? ((text) => process.stderr.write(text)));
  }

  #load(diagnostics: (text: string) => void): StateFile {
    if (!existsSync(this.#path)) return emptyState();
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.#path, 'utf8'));
      if (
        isRecordOf(parsed) &&
        parsed['version'] === 1 &&
        isRecordOf(parsed['clients']) &&
        isRecordOf(parsed['accessTokens']) &&
        isRecordOf(parsed['refreshTokens'])
      ) {
        return parsed as unknown as StateFile;
      }
    } catch {
      // Fall through: an unreadable file is replaced, never trusted.
    }
    diagnostics('OAuth state file was unreadable and has been reset; Claude will need to connect again.\n');
    return emptyState();
  }

  #save(): void {
    const now = this.#now();
    const keep = <T extends TokenRecord>(records: Record<string, T>): Record<string, T> =>
      Object.fromEntries(
        Object.entries(records).filter(
          ([, record]) => record.expiresAt > now && this.#state.clients[record.clientId] !== undefined,
        ),
      );
    this.#state = {
      version: 1,
      clients: this.#state.clients,
      accessTokens: keep(this.#state.accessTokens),
      refreshTokens: keep(this.#state.refreshTokens),
    };
    const temporary = `${this.#path}.${process.pid}.tmp`;
    try {
      writeFileSync(temporary, `${JSON.stringify(this.#state)}\n`, { encoding: 'utf8', mode: 0o600 });
      renameSync(temporary, this.#path);
    } finally {
      rmSync(temporary, { force: true });
    }
  }

  public registerClient(redirectUris: readonly string[], clientName: string | undefined): string {
    const clientId = newSecret();
    const clients = Object.entries(this.#state.clients).sort(([, a], [, b]) => a.createdAt - b.createdAt);
    while (clients.length >= MAXIMUM_CLIENTS) clients.shift();
    const record: ClientRecord = {
      redirectUris: [...redirectUris],
      createdAt: this.#now(),
      ...(clientName === undefined ? {} : { clientName }),
    };
    this.#state = { ...this.#state, clients: Object.fromEntries([...clients, [clientId, record]]) };
    this.#save();
    return clientId;
  }

  public getClient(clientId: string): ClientRecord | undefined {
    return Object.hasOwn(this.#state.clients, clientId) ? this.#state.clients[clientId] : undefined;
  }

  public issueTokens(clientId: string, familyId: string = newSecret()): IssuedTokens {
    const now = this.#now();
    const accessToken = newSecret();
    const refreshToken = newSecret();
    this.#state.accessTokens[hashToken(accessToken)] = {
      clientId,
      familyId,
      expiresAt: now + ACCESS_TOKEN_LIFETIME_MS,
    };
    this.#state.refreshTokens[hashToken(refreshToken)] = {
      clientId,
      familyId,
      expiresAt: now + REFRESH_TOKEN_LIFETIME_MS,
    };
    this.#save();
    return { accessToken, refreshToken, expiresInSeconds: ACCESS_TOKEN_LIFETIME_MS / 1_000 };
  }

  public findAccessToken(token: string): AccessTokenRecord | undefined {
    const key = hashToken(token);
    if (!Object.hasOwn(this.#state.accessTokens, key)) return undefined;
    const record = this.#state.accessTokens[key]!;
    if (record.expiresAt <= this.#now() || this.getClient(record.clientId) === undefined) return undefined;
    return { clientId: record.clientId, expiresAt: record.expiresAt };
  }

  /**
   * Spend a refresh token. The caller issues the replacement pair in the returned
   * family; this only decides whether it may.
   */
  public spendRefreshToken(token: string, clientId: string): RefreshOutcome {
    const now = this.#now();
    const key = hashToken(token);
    if (!Object.hasOwn(this.#state.refreshTokens, key)) return { kind: 'invalid' };
    const record = this.#state.refreshTokens[key]!;
    if (record.clientId !== clientId || record.expiresAt <= now || this.getClient(clientId) === undefined) {
      return { kind: 'invalid' };
    }
    if (record.spentAt !== undefined) {
      if (now - record.spentAt <= REFRESH_REUSE_GRACE_MS) {
        return { kind: 'accepted', familyId: record.familyId };
      }
      this.revokeFamily(record.familyId);
      return { kind: 'reused' };
    }
    this.#state.refreshTokens[key] = {
      ...record,
      spentAt: now,
      expiresAt: Math.min(record.expiresAt, now + SPENT_REFRESH_RETENTION_MS),
    };
    this.#save();
    return { kind: 'accepted', familyId: record.familyId };
  }

  public revokeFamily(familyId: string): void {
    const outside = <T extends TokenRecord>(records: Record<string, T>): Record<string, T> =>
      Object.fromEntries(Object.entries(records).filter(([, record]) => record.familyId !== familyId));
    this.#state = {
      ...this.#state,
      accessTokens: outside(this.#state.accessTokens),
      refreshTokens: outside(this.#state.refreshTokens),
    };
    this.#save();
  }
}
