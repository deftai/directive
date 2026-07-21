import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isProductSignalConsented } from "./consent.js";
import { applyIsolatedConsentEnv, isolatedConsentEnv } from "./test-helpers.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("test-helpers", () => {
  it("isolatedConsentEnv grants when requested", () => {
    const env = isolatedConsentEnv(roots, true);
    expect(isProductSignalConsented({ env, platform: process.platform })).toBe(true);
  });

  it("applyIsolatedConsentEnv updates process env", () => {
    applyIsolatedConsentEnv(roots, true);
    expect(isProductSignalConsented({ platform: process.platform })).toBe(true);
  });
});
