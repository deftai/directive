import { describe, expect, it } from "vitest";
import {
  computeIntentDigest,
  INTENT_DIGEST_ALGO,
  nfcString,
  sortKeysDeep,
} from "./intent-digest.js";

describe("intent-digest file (#3385)", () => {
  it("hashes canonically and names the algo", () => {
    expect(INTENT_DIGEST_ALGO).toBe("intent-extract-v1");
    expect(nfcString("e\u0301")).toBe("é");
    expect(sortKeysDeep({ b: 1, a: 2 })).toEqual({ a: 2, b: 1 });
    const hex = computeIntentDigest({ a: 1 });
    expect(hex).toMatch(/^[0-9a-f]{64}$/);
    expect(computeIntentDigest({ a: 1 })).toBe(hex);
  });
});
