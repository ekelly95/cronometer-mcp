import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';

/**
 * The owner password guards the one door into the remote connector, so only its
 * hash is ever stored, and with a deliberately slow function. N = 2^15, r = 8 is
 * 32 MiB and roughly a tenth of a second per guess — invisible at a sign-in page,
 * expensive for anyone holding a copy of the hash.
 */
const COST = 2 ** 15;
const BLOCK_SIZE = 8;
const PARALLELISM = 1;
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;
const MAXIMUM_MEMORY = 64 * 1024 * 1024;
/** No sign-in needs more; it stops a megabyte "password" from costing a megabyte of scrypt input. */
export const MAXIMUM_PASSWORD_LENGTH = 1_024;
export const MINIMUM_PASSWORD_LENGTH = 12;

function derive(password: string, salt: Buffer, options: ScryptOptions, length: number): Promise<Buffer> {
  return new Promise((resolveKey, rejectKey) => {
    scrypt(password.normalize('NFC'), salt, length, { ...options, maxmem: MAXIMUM_MEMORY }, (error, key) => {
      if (error === null) resolveKey(key);
      else rejectKey(error);
    });
  });
}

export async function hashPassword(password: string): Promise<string> {
  if (password.length < MINIMUM_PASSWORD_LENGTH) {
    throw new Error(`The owner password must be at least ${MINIMUM_PASSWORD_LENGTH} characters.`);
  }
  if (password.length > MAXIMUM_PASSWORD_LENGTH) {
    throw new Error(`The owner password must be at most ${MAXIMUM_PASSWORD_LENGTH} characters.`);
  }
  const salt = randomBytes(SALT_LENGTH);
  const key = await derive(password, salt, { N: COST, r: BLOCK_SIZE, p: PARALLELISM }, KEY_LENGTH);
  return ['scrypt', COST, BLOCK_SIZE, PARALLELISM, salt.toString('base64url'), key.toString('base64url')].join('$');
}

interface ParsedHash {
  readonly options: ScryptOptions;
  readonly salt: Buffer;
  readonly key: Buffer;
}

function parseHash(encoded: string): ParsedHash {
  const parts = encoded.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') {
    throw new Error('The owner password hash is not in the expected scrypt format.');
  }
  const [, cost, blockSize, parallelism, salt, key] = parts as [string, string, string, string, string, string];
  const options = { N: Number(cost), r: Number(blockSize), p: Number(parallelism) };
  if (
    !Number.isInteger(options.N) || options.N < 2 ** 14 || options.N > 2 ** 20 ||
    !Number.isInteger(options.r) || options.r < 1 || options.r > 32 ||
    !Number.isInteger(options.p) || options.p < 1 || options.p > 16
  ) {
    throw new Error('The owner password hash has out-of-range scrypt parameters.');
  }
  const saltBytes = Buffer.from(salt, 'base64url');
  const keyBytes = Buffer.from(key, 'base64url');
  if (saltBytes.length < 16 || keyBytes.length < 32) {
    throw new Error('The owner password hash is truncated.');
  }
  return { options, salt: saltBytes, key: keyBytes };
}

/** Throws on a malformed hash, so a bad configuration fails at startup rather than at sign-in. */
export function assertPasswordHash(encoded: string): void {
  parseHash(encoded);
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  if (password.length === 0 || password.length > MAXIMUM_PASSWORD_LENGTH) return false;
  const { options, salt, key } = parseHash(encoded);
  const candidate = await derive(password, salt, options, key.length);
  return timingSafeEqual(candidate, key);
}
