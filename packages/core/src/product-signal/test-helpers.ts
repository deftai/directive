import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { grantProductSignalConsent } from "./consent.js";

/** Isolated platform-config env without consent (for gate tests). */
export function isolatedConsentEnv(roots: string[], grant = false): NodeJS.ProcessEnv {
  const home = mkdtempSync(join(tmpdir(), "deft-ps-env-"));
  roots.push(home);
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.CI;
  delete env.GITHUB_ACTIONS;
  if (process.platform === "win32") {
    env.APPDATA = home;
    mkdirSync(join(home, "deft"), { recursive: true });
    if (grant) {
      grantProductSignalConsent({ platform: "win32", homeDir: home, env });
    }
  } else {
    env.XDG_CONFIG_HOME = join(home, "config");
    mkdirSync(join(home, "config", "deft"), { recursive: true });
    if (grant) {
      grantProductSignalConsent({ platform: "linux", homeDir: home, env });
    }
  }
  return env;
}

/** Apply isolated consent env to process.env for payload assembly tests. */
export function applyIsolatedConsentEnv(roots: string[], grant = true): void {
  const env = isolatedConsentEnv(roots, grant);
  if (env.APPDATA !== undefined) {
    process.env.APPDATA = env.APPDATA;
  }
  if (env.XDG_CONFIG_HOME !== undefined) {
    process.env.XDG_CONFIG_HOME = env.XDG_CONFIG_HOME;
  }
  delete process.env.CI;
  delete process.env.GITHUB_ACTIONS;
}
