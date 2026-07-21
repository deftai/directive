import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  grantProductSignalConsent,
  isProductSignalConsented,
  readProductSignalConsent,
  resolveProductSignalConsentPath,
  revokeProductSignalConsent,
} from "./consent.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("consent file", () => {
  it("grant and revoke", () => {
    const home = mkdtempSync(join(tmpdir(), "deft-ps-consent-"));
    roots.push(home);
    mkdirSync(join(home, "deft"), { recursive: true });
    const env = { APPDATA: home } as NodeJS.ProcessEnv;
    grantProductSignalConsent({ env, platform: "win32", homeDir: home });
    expect(isProductSignalConsented({ env, platform: "win32", homeDir: home })).toBe(true);
    revokeProductSignalConsent({ env, platform: "win32", homeDir: home });
    expect(isProductSignalConsented({ env, platform: "win32", homeDir: home })).toBe(false);
  });

  it("returns null for invalid or revoked records", () => {
    const home = mkdtempSync(join(tmpdir(), "deft-ps-consent-bad-"));
    roots.push(home);
    mkdirSync(join(home, "deft"), { recursive: true });
    const env = { APPDATA: home } as NodeJS.ProcessEnv;
    const path = resolveProductSignalConsentPath({ env, platform: "win32", homeDir: home });
    writeFileSync(path, "not-json", "utf8");
    expect(readProductSignalConsent({ env, platform: "win32", homeDir: home })).toBeNull();
    writeFileSync(path, JSON.stringify({ consentVersion: 1, grantedAt: "x", tier: "t" }), "utf8");
    revokeProductSignalConsent({ env, platform: "win32", homeDir: home });
    expect(readProductSignalConsent({ env, platform: "win32", homeDir: home })).toBeNull();
    expect(revokeProductSignalConsent({ env, platform: "win32", homeDir: home })).toBe(true);
  });

  it("revoke returns false when file missing", () => {
    const home = mkdtempSync(join(tmpdir(), "deft-ps-consent-miss-"));
    roots.push(home);
    expect(
      revokeProductSignalConsent({
        env: { APPDATA: home },
        platform: "win32",
        homeDir: home,
      }),
    ).toBe(false);
  });

  it("revoke returns false when consent record invalid", () => {
    const home = mkdtempSync(join(tmpdir(), "deft-ps-consent-inv-"));
    roots.push(home);
    mkdirSync(join(home, "deft"), { recursive: true });
    const env = { APPDATA: home } as NodeJS.ProcessEnv;
    const path = resolveProductSignalConsentPath({ env, platform: "win32", homeDir: home });
    writeFileSync(path, JSON.stringify({ bad: true }), "utf8");
    expect(revokeProductSignalConsent({ env, platform: "win32", homeDir: home })).toBe(false);
    expect(readProductSignalConsent({ env, platform: "win32", homeDir: home })).toBeNull();
  });

  it("reads consent with empty revokedAt as active", () => {
    const home = mkdtempSync(join(tmpdir(), "deft-ps-consent-revempty-"));
    roots.push(home);
    mkdirSync(join(home, "deft"), { recursive: true });
    const env = { APPDATA: home } as NodeJS.ProcessEnv;
    const path = resolveProductSignalConsentPath({ env, platform: "win32", homeDir: home });
    writeFileSync(
      path,
      JSON.stringify({
        consentVersion: 1,
        grantedAt: "2026-07-21T12:00:00Z",
        tier: "product-signal",
        revokedAt: "",
      }),
      "utf8",
    );
    expect(readProductSignalConsent({ env, platform: "win32", homeDir: home })?.tier).toBe(
      "product-signal",
    );
  });

  it("resolves unix consent path from env.HOME", () => {
    const home = mkdtempSync(join(tmpdir(), "deft-ps-consent-unix-"));
    roots.push(home);
    const env = { HOME: home } as NodeJS.ProcessEnv;
    grantProductSignalConsent({ env, platform: "linux", homeDir: home });
    expect(isProductSignalConsented({ env, platform: "linux" })).toBe(true);
    expect(resolveProductSignalConsentPath({ env, platform: "linux" })).toContain(
      join(".config", "deft"),
    );
  });
});
