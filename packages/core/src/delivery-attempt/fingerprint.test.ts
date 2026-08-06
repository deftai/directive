import { describe, expect, it } from "vitest";
import {
  buildFailureInfo,
  computeFailureFingerprint,
  inferRetryability,
  normalizeFailureMessage,
} from "./fingerprint.js";

describe("delivery-attempt fingerprint (#3143)", () => {
  it("normalizes volatile timestamps, uuids, paths, and secrets", () => {
    const a = normalizeFailureMessage(
      "fail at 2026-08-06T12:00:00Z path=/Users/x/proj/a token=sk-secret run_id=abc",
    );
    const b = normalizeFailureMessage(
      "fail at 2026-08-07T99:99:99Z path=C:\\Users\\y\\proj\\b token=sk-other run_id=xyz",
    );
    expect(a).toBe(b);
    expect(a).not.toMatch(/sk-secret|Users/);
  });

  it("produces stable fingerprints across volatile message noise", () => {
    const f1 = computeFailureFingerprint({
      stage: "deploy",
      code: "CONFIG_INVALID",
      message: "bad field at 2026-01-01T00:00:00Z id=11111111-1111-1111-1111-111111111111",
      resourceClass: "manifest",
    });
    const f2 = computeFailureFingerprint({
      stage: "deploy",
      code: "CONFIG_INVALID",
      message: "bad field at 2026-02-02T00:00:00Z id=22222222-2222-2222-2222-222222222222",
      resourceClass: "manifest",
    });
    expect(f1).toBe(f2);
    expect(f1).toHaveLength(32);
  });

  it("differs when stage or code changes", () => {
    const a = computeFailureFingerprint({ stage: "build", code: "X" });
    const b = computeFailureFingerprint({ stage: "test", code: "X" });
    const c = computeFailureFingerprint({ stage: "build", code: "Y" });
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
  });

  it("buildFailureInfo defaults retryability to unknown", () => {
    const f = buildFailureInfo({ stage: "gate", code: "Z" });
    expect(f.retryability).toBe("unknown");
    expect(f.fingerprint).toHaveLength(32);
  });

  it("inferRetryability classifies common codes", () => {
    expect(inferRetryability("ETIMEDOUT")).toBe("transient");
    expect(inferRetryability("RATE_LIMIT")).toBe("transient");
    expect(inferRetryability("SCHEMA_INVALID")).toBe("deterministic");
    expect(inferRetryability("PERMISSION_DENIED")).toBe("deterministic");
    expect(inferRetryability("WEIRD_NEW")).toBe("unknown");
    expect(inferRetryability(null)).toBe("unknown");
  });
});
