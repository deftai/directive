import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { grantProductSignalConsent, isProductSignalConsented } from "./consent.js";

function consentConfigDir(home: string, platform: NodeJS.Platform): string {
  if (platform === "win32") {
    return join(home, "deft");
  }
  return join(home, ".config", "deft");
}

/** Isolated platform-config env for gate tests. */
export function isolatedConsentEnv(roots: string[], grant = false): NodeJS.ProcessEnv {
  const home = mkdtempSync(join(tmpdir(), "deft-ps-env-"));
  roots.push(home);
  const platform = process.platform;
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.CI;
  delete env.GITHUB_ACTIONS;
  if (platform === "win32") {
    env.APPDATA = home;
  } else {
    env.HOME = home;
  }
  mkdirSync(consentConfigDir(home, platform), { recursive: true });
  if (grant) {
    grantProductSignalConsent({ platform, homeDir: home, env });
  }
  return env;
}

/** Apply isolated consent env to process.env for submit tests. */
export function applyIsolatedConsentEnv(roots: string[], grant = true): void {
  const env = isolatedConsentEnv(roots, grant);
  if (env.APPDATA !== undefined) {
    process.env.APPDATA = env.APPDATA;
  }
  if (env.HOME !== undefined) {
    process.env.HOME = env.HOME;
  }
  delete process.env.CI;
  delete process.env.GITHUB_ACTIONS;
}

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("consent env helpers", () => {
  it("isolatedConsentEnv grants when requested", () => {
    const env = isolatedConsentEnv(roots, true);
    expect(isProductSignalConsented({ env, platform: process.platform })).toBe(true);
  });

  it("applyIsolatedConsentEnv updates process env", () => {
    applyIsolatedConsentEnv(roots, true);
    expect(isProductSignalConsented({ platform: process.platform })).toBe(true);
  });
});
