import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { containedWrite } from "../fs/contained-write.js";
import { NPM_PACKAGE_NAME, PUBLIC_NPM_REGISTRY } from "./constants.js";

export interface NpmViewVersionResult {
  readonly ok: boolean;
  readonly version: string;
}

export interface NpmViewVersionOptions {
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Query the canonical public registry for the latest published Directive
 * version. `--registry` does not beat `@deftai:registry` (npm/cli#7659), so
 * the spawn uses a temp cwd whose project `.npmrc` sets the scoped key.
 * User npmrc still loads for proxy/cafile; project config in that cwd wins
 * the scoped registry without replacing `--userconfig`.
 */
export function defaultNpmViewVersion(options: NpmViewVersionOptions = {}): NpmViewVersionResult {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let dir: string | undefined;
  try {
    dir = mkdtempSync(join(tmpdir(), "deft-npm-view-"));
    containedWrite({
      root: dir,
      target: ".npmrc",
      data: `@deftai:registry=${PUBLIC_NPM_REGISTRY}\nregistry=${PUBLIC_NPM_REGISTRY}\n`,
      mode: "create",
    });
    const proc = spawnSync("npm", ["view", NPM_PACKAGE_NAME, "version", "--ignore-scripts"], {
      cwd: dir,
      encoding: "utf8",
      shell: false,
      timeout: timeoutMs,
      windowsHide: true,
    });
    if (proc.error !== undefined || proc.status !== 0) {
      return { ok: false, version: "" };
    }
    const version =
      (typeof proc.stdout === "string" ? proc.stdout : "").trim().split("\n")[0]?.trim() ?? "";
    return { ok: version.length > 0, version };
  } catch {
    return { ok: false, version: "" };
  } finally {
    if (dir !== undefined) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best-effort temp cleanup */
      }
    }
  }
}
