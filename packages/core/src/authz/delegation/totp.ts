/**
 * RFC 6238 TOTP for operator delegation (#7420 B1).
 *
 * HMAC-SHA1, {@link DELEGATION_TOTP_STEP_SECONDS}-second steps,
 * {@link DELEGATION_TOTP_DIGITS} digits, the same scheme phone authenticator
 * apps use. Verification returns the matched time step so the store can burn
 * it (`lastAcceptedStep`); it never decides replay on its own.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  DELEGATION_TOTP_DIGITS,
  DELEGATION_TOTP_DRIFT_STEPS,
  DELEGATION_TOTP_ISSUER,
  DELEGATION_TOTP_SECRET_BYTES,
  DELEGATION_TOTP_STEP_SECONDS,
} from "./types.js";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** RFC 4648 base32 encode without padding (authenticator apps accept it). */
export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** RFC 4648 base32 decode; ignores case, spaces and `=` padding. Null on a bad character. */
export function base32Decode(text: string): Buffer | null {
  const clean = text.replace(/[\s=]/g, "").toUpperCase();
  if (clean.length === 0) return null;
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx < 0) return null;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A fresh random secret, base32 encoded. */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(DELEGATION_TOTP_SECRET_BYTES));
}

/** RFC 4226 HOTP value for one counter, zero-padded to `digits`. */
export function hotp(secret: Uint8Array, counter: number, digits = DELEGATION_TOTP_DIGITS): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac("sha1", Buffer.from(secret)).update(msg).digest();
  const offset = (mac[mac.length - 1] as number) & 0x0f;
  const bin =
    (((mac[offset] as number) & 0x7f) << 24) |
    (((mac[offset + 1] as number) & 0xff) << 16) |
    (((mac[offset + 2] as number) & 0xff) << 8) |
    ((mac[offset + 3] as number) & 0xff);
  return String(bin % 10 ** digits).padStart(digits, "0");
}

/** TOTP time step for a moment. */
export function totpStepAt(now: Date, stepSeconds = DELEGATION_TOTP_STEP_SECONDS): number {
  return Math.floor(now.getTime() / 1000 / stepSeconds);
}

/** The code for a step (tests and enrollment self-check). */
export function totpCodeForStep(secretBase32: string, step: number): string | null {
  const secret = base32Decode(secretBase32);
  if (secret === null) return null;
  return hotp(secret, step);
}

function codesEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/**
 * Verify a code against the secret within the drift window around `now`.
 * Returns the matched step (the highest one when several match), or null.
 * A malformed code or secret returns null.
 */
export function verifyTotpCode(input: {
  readonly secretBase32: string;
  readonly code: string;
  readonly now: Date;
}): number | null {
  const pattern = new RegExp(`^\\d{${DELEGATION_TOTP_DIGITS}}$`);
  if (!pattern.test(input.code)) return null;
  const secret = base32Decode(input.secretBase32);
  if (secret === null || secret.length === 0) return null;
  const center = totpStepAt(input.now);
  let matched: number | null = null;
  for (let delta = -DELEGATION_TOTP_DRIFT_STEPS; delta <= DELEGATION_TOTP_DRIFT_STEPS; delta++) {
    const step = center + delta;
    if (step < 0) continue;
    if (codesEqual(hotp(secret, step), input.code)) matched = step;
  }
  return matched;
}

/** `otpauth://` enrollment URI for a phone authenticator app. */
export function totpEnrollmentUri(secretBase32: string, account: string): string {
  const label = encodeURIComponent(`${DELEGATION_TOTP_ISSUER}:${account}`);
  const params = new URLSearchParams({
    secret: secretBase32,
    issuer: DELEGATION_TOTP_ISSUER,
    algorithm: "SHA1",
    digits: String(DELEGATION_TOTP_DIGITS),
    period: String(DELEGATION_TOTP_STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
