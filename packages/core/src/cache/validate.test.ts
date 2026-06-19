import { describe, expect, it } from "vitest";
import { CacheValidationError } from "./errors.js";
import { validateMeta } from "./validate.js";

function goodMeta(): Record<string, unknown> {
  return {
    source: "github-issue",
    key: "deftai/directive/1",
    fetched_at: "2026-06-19T12:00:00Z",
    ttl_seconds: 3600,
    expires_at: "2026-06-19T13:00:00Z",
    scan_result: {
      passed: true,
      scanned_at: "2026-06-19T12:00:00Z",
      scanner_version: "2.1.0",
      flags: [],
    },
    size_bytes: 100,
    stale: false,
  };
}

describe("validateMeta", () => {
  it("accepts good meta", () => {
    expect(() => validateMeta(goodMeta())).not.toThrow();
  });

  it("rejects unknown keys", () => {
    expect(() => validateMeta({ ...goodMeta(), extra: true })).toThrow(CacheValidationError);
  });

  it("rejects bad semver", () => {
    const meta = goodMeta();
    (meta.scan_result as Record<string, unknown>).scanner_version = "bad";
    expect(() => validateMeta(meta)).toThrow(/SemVer/);
  });
});
