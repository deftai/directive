import { describe, expect, it } from "vitest";
import { validateMeta } from "./validate.js";

function goodMeta(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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
    ...overrides,
  };
}

describe("validateMeta branches", () => {
  it("rejects non-object root", () => {
    expect(() => validateMeta([])).toThrow(/expected object/);
  });

  it("rejects missing required keys", () => {
    const meta = goodMeta();
    delete (meta as Record<string, unknown>).key;
    expect(() => validateMeta(meta)).toThrow(/missing required keys/);
  });

  it("rejects bad source", () => {
    expect(() => validateMeta(goodMeta({ source: "other" }))).toThrow(/not in/);
  });

  it("rejects empty key", () => {
    expect(() => validateMeta(goodMeta({ key: "" }))).toThrow(/non-empty string/);
  });

  it("rejects bad datetime", () => {
    expect(() => validateMeta(goodMeta({ fetched_at: "not-a-date" }))).toThrow(/ISO-8601/);
  });

  it("rejects bad ttl and size_bytes", () => {
    expect(() => validateMeta(goodMeta({ ttl_seconds: -1 }))).toThrow(/ttl_seconds/);
    expect(() => validateMeta(goodMeta({ size_bytes: "big" }))).toThrow(/size_bytes/);
  });

  it("rejects bad stale and etag", () => {
    expect(() => validateMeta(goodMeta({ stale: "yes" }))).toThrow(/stale/);
    expect(() => validateMeta(goodMeta({ etag: 1 }))).toThrow(/etag/);
  });

  it("rejects bad scan_result", () => {
    expect(() => validateMeta(goodMeta({ scan_result: "nope" }))).toThrow(/scan_result/);
    const meta = goodMeta();
    (meta.scan_result as Record<string, unknown>).passed = "yes";
    expect(() => validateMeta(meta)).toThrow(/passed/);
  });

  it("rejects bad flag category and severity", () => {
    const meta = goodMeta({
      scan_result: {
        passed: true,
        scanned_at: "2026-06-19T12:00:00Z",
        scanner_version: "2.1.0",
        flags: [{ category: "bad", severity: "hard-fail", detail: "d" }],
      },
    });
    expect(() => validateMeta(meta)).toThrow(/category/);
    const meta2 = goodMeta({
      scan_result: {
        passed: true,
        scanned_at: "2026-06-19T12:00:00Z",
        scanner_version: "2.1.0",
        flags: [{ category: "credentials", severity: "bad", detail: "d" }],
      },
    });
    expect(() => validateMeta(meta2)).toThrow(/severity/);
  });

  it("rejects bad scanner_version semver", () => {
    const meta = goodMeta();
    (meta.scan_result as Record<string, unknown>).scanner_version = "not-semver";
    expect(() => validateMeta(meta)).toThrow(/scanner_version/);
  });

  it("rejects unexpected root keys", () => {
    expect(() => validateMeta(goodMeta({ surprise: true }))).toThrow(/unknown keys/);
  });

  it("rejects bad flag shape", () => {
    const meta = goodMeta({
      scan_result: {
        passed: true,
        scanned_at: "2026-06-19T12:00:00Z",
        scanner_version: "2.1.0",
        flags: [null],
      },
    });
    expect(() => validateMeta(meta)).toThrow(/flags\[0\]/);
  });

  it("accepts etag and match_count", () => {
    expect(() =>
      validateMeta(
        goodMeta({
          etag: 'W/"abc"',
          scan_result: {
            passed: false,
            scanned_at: "2026-06-19T12:00:00Z",
            scanner_version: "2.1.0",
            flags: [
              {
                category: "credentials",
                severity: "hard-fail",
                detail: "matched",
                match_count: 2,
              },
            ],
          },
        }),
      ),
    ).not.toThrow();
  });
});
