import { describe, expect, it } from "vitest";
import { CacheNotFoundError, keyErrorMessage } from "./errors.js";

describe("cache errors", () => {
  it("formats KeyError-style messages for parity with Python", () => {
    expect(keyErrorMessage("miss")).toBe('"miss"');
    expect(keyErrorMessage('say "hi"')).toBe('"say \\"hi\\""');
    expect(new CacheNotFoundError("cache miss").innerMessage).toBe("cache miss");
    expect(new CacheNotFoundError("cache miss").message).toBe('"cache miss"');
  });
});
