import { createHmac } from 'node:crypto';

/**
 * RFC 6238 time-based one-time passwords: SHA-1, 30-second steps, six digits —
 * what Cronometer's two-factor setup issues. The secret is the base32 key shown
 * when two-factor authentication is enabled; authenticator apps display it
 * grouped and sometimes lower-cased, so spaces and case are ignored.
 */

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function decodeBase32(secret: string): Buffer {
  const normalized = secret.replace(/[\s-]/g, '').replace(/=+$/, '').toUpperCase();
  if (normalized === '') throw new Error('The two-factor secret is empty.');
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const character of normalized) {
    const index = BASE32.indexOf(character);
    if (index === -1) throw new Error('The two-factor secret is not valid base32.');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

export function totpCode(secret: string, nowMs: number = Date.now()): string {
  const key = decodeBase32(secret);
  const counter = Math.floor(nowMs / 1000 / 30);
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', key).update(message).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const code = (digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return code.toString().padStart(6, '0');
}
