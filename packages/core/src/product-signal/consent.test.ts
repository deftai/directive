import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_PRODUCT_SIGNAL_SINK_REPO } from "../policy/product-signal.js";
import {
  authorizeProductSignalSink,
  grantProductSignalConsent,
  isProductSignalConsented,
  normalizeProductSignalSinkRepo,
  PRODUCT_SIGNAL_CONSENT_VERSION,
  readProductSignalConsent,
  resolveConsentedProductSignalSink,
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
  it("isProductSignalConsented reflects grant state", () => {
    const home = mkdtempSync(join(tmpdir(), "deft-ps-consent-is-"));
    roots.push(home);
    const env = { APPDATA: home } as NodeJS.ProcessEnv;
    expect(isProductSignalConsented({ env, platform: "win32", homeDir: home })).toBe(false);
    grantProductSignalConsent({ env, platform: "win32", homeDir: home });
    expect(isProductSignalConsented({ env, platform: "win32", homeDir: home })).toBe(true);
  });

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

describe("sink authorization (#2767)", () => {
  it("normalizes github URLs and casing", () => {
    expect(normalizeProductSignalSinkRepo("DeftAI/Product-Signal")).toBe("deftai/product-signal");
    expect(normalizeProductSignalSinkRepo("https://github.com/o/r/")).toBe("o/r");
    expect(normalizeProductSignalSinkRepo("http://github.com/o/r")).toBe("o/r");
  });

  it("authorize rejects missing consent", () => {
    const result = authorizeProductSignalSink("deftai/product-signal", null);
    expect(result.authorized).toBe(false);
    expect(result.message).toContain("requires consent");
  });

  it("v2 grant records normalized sinkRepo", () => {
    const home = mkdtempSync(join(tmpdir(), "deft-ps-consent-v2-"));
    roots.push(home);
    const env = { APPDATA: home } as NodeJS.ProcessEnv;
    const record = grantProductSignalConsent({
      env,
      platform: "win32",
      homeDir: home,
      sinkRepo: "Org/Custom-Sink",
    });
    expect(record.consentVersion).toBe(PRODUCT_SIGNAL_CONSENT_VERSION);
    expect(record.sinkRepo).toBe("org/custom-sink");
  });

  it("v1 consent authorizes only default sink", () => {
    const consent = {
      consentVersion: 1,
      grantedAt: "2026-07-21T12:00:00Z",
      tier: "product-signal",
    };
    expect(authorizeProductSignalSink(DEFAULT_PRODUCT_SIGNAL_SINK_REPO, consent).authorized).toBe(
      true,
    );
    expect(authorizeProductSignalSink("evil/custom", consent).authorized).toBe(false);
    expect(resolveConsentedProductSignalSink(consent)).toBe("deftai/product-signal");
  });

  it("v2 consent requires exact sink match", () => {
    const consent = {
      consentVersion: PRODUCT_SIGNAL_CONSENT_VERSION,
      grantedAt: "2026-07-21T12:00:00Z",
      tier: "product-signal",
      sinkRepo: "partner/signal",
    };
    const allowed = authorizeProductSignalSink("partner/signal", consent);
    expect(allowed.authorized).toBe(true);
    expect(allowed.message).toBe("sink authorized");
    expect(authorizeProductSignalSink("other/signal", consent).authorized).toBe(false);
  });

  it("rejects v2 records missing sinkRepo", () => {
    const home = mkdtempSync(join(tmpdir(), "deft-ps-consent-v2bad-"));
    roots.push(home);
    mkdirSync(join(home, "deft"), { recursive: true });
    const env = { APPDATA: home } as NodeJS.ProcessEnv;
    const path = resolveProductSignalConsentPath({ env, platform: "win32", homeDir: home });
    writeFileSync(
      path,
      JSON.stringify({
        consentVersion: 2,
        grantedAt: "2026-07-21T12:00:00Z",
        tier: "product-signal",
      }),
      "utf8",
    );
    expect(readProductSignalConsent({ env, platform: "win32", homeDir: home })).toBeNull();
  });

  it("returns null for non-object consent payloads", () => {
    const home = mkdtempSync(join(tmpdir(), "deft-ps-consent-nonobj-"));
    roots.push(home);
    mkdirSync(join(home, "deft"), { recursive: true });
    const env = { APPDATA: home } as NodeJS.ProcessEnv;
    const path = resolveProductSignalConsentPath({ env, platform: "win32", homeDir: home });
    writeFileSync(path, "[]", "utf8");
    expect(readProductSignalConsent({ env, platform: "win32", homeDir: home })).toBeNull();
  });

  it("returns null for invalid consentVersion or grantedAt", () => {
    const home = mkdtempSync(join(tmpdir(), "deft-ps-consent-fields-"));
    roots.push(home);
    mkdirSync(join(home, "deft"), { recursive: true });
    const env = { APPDATA: home } as NodeJS.ProcessEnv;
    const path = resolveProductSignalConsentPath({ env, platform: "win32", homeDir: home });
    writeFileSync(
      path,
      JSON.stringify({
        consentVersion: "2",
        grantedAt: "x",
        tier: "product-signal",
        sinkRepo: "o/r",
      }),
      "utf8",
    );
    expect(readProductSignalConsent({ env, platform: "win32", homeDir: home })).toBeNull();
    writeFileSync(
      path,
      JSON.stringify({ consentVersion: 2, grantedAt: 1, tier: "product-signal", sinkRepo: "o/r" }),
      "utf8",
    );
    expect(readProductSignalConsent({ env, platform: "win32", homeDir: home })).toBeNull();
  });

  it("returns null for blank v2 sinkRepo", () => {
    const home = mkdtempSync(join(tmpdir(), "deft-ps-consent-blank-sink-"));
    roots.push(home);
    mkdirSync(join(home, "deft"), { recursive: true });
    const env = { APPDATA: home } as NodeJS.ProcessEnv;
    const path = resolveProductSignalConsentPath({ env, platform: "win32", homeDir: home });
    writeFileSync(
      path,
      JSON.stringify({
        consentVersion: 2,
        grantedAt: "2026-07-21T12:00:00Z",
        tier: "product-signal",
        sinkRepo: "   ",
      }),
      "utf8",
    );
    expect(readProductSignalConsent({ env, platform: "win32", homeDir: home })).toBeNull();
  });

  it("v1 consent ignores sinkRepo field in file for authorization", () => {
    const consent = {
      consentVersion: 1,
      grantedAt: "2026-07-21T12:00:00Z",
      tier: "product-signal",
      sinkRepo: "evil/custom",
    };
    expect(authorizeProductSignalSink("evil/custom", consent).authorized).toBe(false);
    expect(authorizeProductSignalSink(DEFAULT_PRODUCT_SIGNAL_SINK_REPO, consent).authorized).toBe(
      true,
    );
  });

  it("authorize treats v2 consent missing sink as unconsented", () => {
    const consent = {
      consentVersion: PRODUCT_SIGNAL_CONSENT_VERSION,
      grantedAt: "2026-07-21T12:00:00Z",
      tier: "product-signal",
    } as import("./consent.js").ProductSignalConsentRecord;
    expect(authorizeProductSignalSink("deftai/product-signal", consent).authorized).toBe(false);
  });

  it("revoke preserves sinkRepo on v2 record", () => {
    const home = mkdtempSync(join(tmpdir(), "deft-ps-consent-revoke-v2-"));
    roots.push(home);
    const env = { APPDATA: home } as NodeJS.ProcessEnv;
    grantProductSignalConsent({ env, platform: "win32", homeDir: home, sinkRepo: "partner/inbox" });
    expect(revokeProductSignalConsent({ env, platform: "win32", homeDir: home })).toBe(true);
    expect(readProductSignalConsent({ env, platform: "win32", homeDir: home })).toBeNull();
  });

  it("returns null when consent file is unreadable json", () => {
    const home = mkdtempSync(join(tmpdir(), "deft-ps-consent-parse-err-"));
    roots.push(home);
    mkdirSync(join(home, "deft"), { recursive: true });
    const env = { APPDATA: home } as NodeJS.ProcessEnv;
    const path = resolveProductSignalConsentPath({ env, platform: "win32", homeDir: home });
    writeFileSync(path, "{", "utf8");
    expect(readProductSignalConsent({ env, platform: "win32", homeDir: home })).toBeNull();
  });

  it("grant records grantedAt without milliseconds", () => {
    const home = mkdtempSync(join(tmpdir(), "deft-ps-consent-grant-time-"));
    roots.push(home);
    const env = { APPDATA: home } as NodeJS.ProcessEnv;
    const now = new Date("2026-07-21T12:34:56.789Z");
    const record = grantProductSignalConsent({
      env,
      platform: "win32",
      homeDir: home,
      now,
    });
    expect(record.grantedAt).toBe("2026-07-21T12:34:56Z");
  });

  it("returns null for json null", () => {
    const home = mkdtempSync(join(tmpdir(), "deft-ps-consent-json-null-"));
    roots.push(home);
    mkdirSync(join(home, "deft"), { recursive: true });
    const env = { APPDATA: home } as NodeJS.ProcessEnv;
    const path = resolveProductSignalConsentPath({ env, platform: "win32", homeDir: home });
    writeFileSync(path, "null", "utf8");
    expect(readProductSignalConsent({ env, platform: "win32", homeDir: home })).toBeNull();
  });

  it("grant normalizes explicit default sink", () => {
    const home = mkdtempSync(join(tmpdir(), "deft-ps-consent-grant-default-"));
    roots.push(home);
    const env = { APPDATA: home } as NodeJS.ProcessEnv;
    const record = grantProductSignalConsent({
      env,
      platform: "win32",
      homeDir: home,
      sinkRepo: "  deftai/product-signal  ",
    });
    expect(record.sinkRepo).toBe("deftai/product-signal");
  });

  it("reads active consent with revokedAt whitespace only", () => {
    const home = mkdtempSync(join(tmpdir(), "deft-ps-consent-revws-"));
    roots.push(home);
    mkdirSync(join(home, "deft"), { recursive: true });
    const env = { APPDATA: home } as NodeJS.ProcessEnv;
    const path = resolveProductSignalConsentPath({ env, platform: "win32", homeDir: home });
    writeFileSync(
      path,
      JSON.stringify({
        consentVersion: 2,
        grantedAt: "2026-07-21T12:00:00Z",
        tier: "product-signal",
        sinkRepo: "deftai/product-signal",
        revokedAt: "   ",
      }),
      "utf8",
    );
    expect(readProductSignalConsent({ env, platform: "win32", homeDir: home })?.sinkRepo).toBe(
      "deftai/product-signal",
    );
  });

  it("rejects v2 consent when sinkRepo normalizes to empty", () => {
    const home = mkdtempSync(join(tmpdir(), "deft-ps-consent-empty-norm-"));
    roots.push(home);
    mkdirSync(join(home, "deft"), { recursive: true });
    const env = { APPDATA: home } as NodeJS.ProcessEnv;
    const path = resolveProductSignalConsentPath({ env, platform: "win32", homeDir: home });
    writeFileSync(
      path,
      JSON.stringify({
        consentVersion: 2,
        grantedAt: "2026-07-21T12:00:00Z",
        tier: "product-signal",
        sinkRepo: "https://github.com/",
      }),
      "utf8",
    );
    expect(readProductSignalConsent({ env, platform: "win32", homeDir: home })).toBeNull();
  });

  it("grant falls back to default sink when sinkRepo normalizes empty", () => {
    const home = mkdtempSync(join(tmpdir(), "deft-ps-consent-grant-empty-"));
    roots.push(home);
    const env = { APPDATA: home } as NodeJS.ProcessEnv;
    const fromEmpty = grantProductSignalConsent({
      env,
      platform: "win32",
      homeDir: home,
      sinkRepo: "",
    });
    expect(fromEmpty.sinkRepo).toBe("deftai/product-signal");
    const fromGithubRoot = grantProductSignalConsent({
      env,
      platform: "win32",
      homeDir: home,
      sinkRepo: "https://github.com/",
    });
    expect(fromGithubRoot.sinkRepo).toBe("deftai/product-signal");
  });

  it("resolveConsentedProductSignalSink returns null for unknown consent version", () => {
    expect(
      resolveConsentedProductSignalSink({
        consentVersion: 0,
        grantedAt: "2026-07-21T12:00:00Z",
        tier: "product-signal",
      }),
    ).toBeNull();
  });

  it("returns null for invalid tier", () => {
    const home = mkdtempSync(join(tmpdir(), "deft-ps-consent-tier-"));
    roots.push(home);
    mkdirSync(join(home, "deft"), { recursive: true });
    const env = { APPDATA: home } as NodeJS.ProcessEnv;
    const path = resolveProductSignalConsentPath({ env, platform: "win32", homeDir: home });
    writeFileSync(
      path,
      JSON.stringify({ consentVersion: 2, grantedAt: "x", tier: 1, sinkRepo: "o/r" }),
      "utf8",
    );
    expect(readProductSignalConsent({ env, platform: "win32", homeDir: home })).toBeNull();
  });

  it("revoke returns false when consent file is unreadable", () => {
    const home = mkdtempSync(join(tmpdir(), "deft-ps-consent-revoke-read-"));
    roots.push(home);
    mkdirSync(join(home, "deft"), { recursive: true });
    const env = { APPDATA: home } as NodeJS.ProcessEnv;
    const path = resolveProductSignalConsentPath({ env, platform: "win32", homeDir: home });
    writeFileSync(path, "{", "utf8");
    expect(revokeProductSignalConsent({ env, platform: "win32", homeDir: home })).toBe(false);
  });
});
