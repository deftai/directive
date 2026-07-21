import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { grantProductSignalConsent } from "./consent.js";

function consentConfigDir(home: string, platform: NodeJS.Platform): string {
  if (platform === "win32") {
    return join(home, "deft");
  }
  return join(home, ".config", "deft");
}

/** Isolated platform-config env without consent (for gate tests). */
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

/** Apply isolated consent env to process.env for payload assembly tests. */
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
