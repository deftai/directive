import { describe, expect, it } from "vitest";
import {
  base32Decode,
  base32Encode,
  generateTotpSecret,
  hotp,
  totpCodeForStep,
  totpEnrollmentUri,
  totpStepAt,
  verifyTotpCode,
} from "./totp.js";
import {
  DELEGATION_TOTP_DIGITS,
  DELEGATION_TOTP_DRIFT_STEPS,
  DELEGATION_TOTP_STEP_SECONDS,
} from "./types.js";

// RFC 6238 Appendix B shared secret (SHA1): ASCII "12345678901234567890".
const RFC_SECRET = Buffer.from("12345678901234567890", "ascii");

describe("TOTP (#7420 B1)", () => {
  it("matches the RFC 6238 SHA1 test vectors (last 6 of the 8-digit values)", () => {
    // T = 59s -> 94287082; T = 1111111109 -> 07081804; T = 1234567890 -> 89005924.
    expect(hotp(RFC_SECRET, Math.floor(59 / 30))).toBe("287082");
    expect(hotp(RFC_SECRET, Math.floor(1111111109 / 30))).toBe("081804");
    expect(hotp(RFC_SECRET, Math.floor(1234567890 / 30))).toBe("005924");
  });

  it("uses 30-second steps and 6 digits, the phone authenticator default", () => {
    expect(DELEGATION_TOTP_STEP_SECONDS).toBe(30);
    expect(DELEGATION_TOTP_DIGITS).toBe(6);
    expect(totpStepAt(new Date(59_000))).toBe(1);
    expect(totpStepAt(new Date(60_000))).toBe(2);
  });

  it("round-trips base32 and rejects bad characters", () => {
    const enc = base32Encode(RFC_SECRET);
    expect(enc).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
    expect(base32Decode(enc)?.equals(RFC_SECRET)).toBe(true);
    expect(base32Decode(enc.toLowerCase())?.equals(RFC_SECRET)).toBe(true);
    expect(base32Decode("not base32!")).toBeNull();
    expect(base32Decode("")).toBeNull();
  });

  it("generates a 160-bit base32 secret", () => {
    const s = generateTotpSecret();
    expect(base32Decode(s)?.length).toBe(20);
  });

  it("verifies the current code and returns its step", () => {
    const secret = base32Encode(RFC_SECRET);
    const now = new Date(1_234_567_890_000);
    const step = totpStepAt(now);
    const code = totpCodeForStep(secret, step) as string;
    expect(verifyTotpCode({ secretBase32: secret, code, now })).toBe(step);
  });

  it("accepts one step of drift each side and refuses beyond it", () => {
    const secret = base32Encode(RFC_SECRET);
    const now = new Date(1_234_567_890_000);
    const step = totpStepAt(now);
    expect(DELEGATION_TOTP_DRIFT_STEPS).toBe(1);
    const prev = totpCodeForStep(secret, step - 1) as string;
    const next = totpCodeForStep(secret, step + 1) as string;
    const far = totpCodeForStep(secret, step - 3) as string;
    expect(verifyTotpCode({ secretBase32: secret, code: prev, now })).toBe(step - 1);
    expect(verifyTotpCode({ secretBase32: secret, code: next, now })).toBe(step + 1);
    expect(verifyTotpCode({ secretBase32: secret, code: far, now })).toBeNull();
  });

  it("refuses malformed codes and secrets", () => {
    const secret = base32Encode(RFC_SECRET);
    const now = new Date(1_234_567_890_000);
    expect(verifyTotpCode({ secretBase32: secret, code: "12345", now })).toBeNull();
    expect(verifyTotpCode({ secretBase32: secret, code: "abcdef", now })).toBeNull();
    expect(verifyTotpCode({ secretBase32: "!!", code: "123456", now })).toBeNull();
  });

  it("builds an otpauth URI with the scheme parameters", () => {
    const uri = totpEnrollmentUri("GEZDGNBV", "scott");
    expect(uri).toMatch(/^otpauth:\/\/totp\/Directive%3Ascott\?/);
    expect(uri).toContain("secret=GEZDGNBV");
    expect(uri).toContain("digits=6");
    expect(uri).toContain("period=30");
  });
});
