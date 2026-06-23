import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaultWhich, spawnText } from "../release/spawn.js";
import {
  NPM_BUILD_TIMEOUT_SECONDS,
  NPM_INSTALL_TIMEOUT_SECONDS,
  NPM_PUBLISH_DRYRUN_TIMEOUT_SECONDS,
  NPM_PUBLISH_PACKAGES,
} from "./constants.js";
import type { E2ESeams } from "./types.js";

/**
 * npm publish dry-run rehearsal (#1910) -- the TS port of the
 * scripts/release_e2e.py helpers of the same name. Mirrors
 * .github/workflows/npm-publish.yml so a broken `files` allowlist, version
 * drift, or dependency-order bug surfaces in `task release:e2e` BEFORE a real
 * `v*` tag fires the publish workflow, without ever touching the real registry.
 */

function resolveWhich(seams: E2ESeams): (name: string) => string | null {
  return seams.which ?? seams.whichGh ?? defaultWhich;
}

/**
 * Resolve a pnpm invocation prefix for the clone build. Prefers a `pnpm`
 * binary on PATH; falls back to `corepack pnpm`. Returns null when neither is
 * available.
 */
export function resolvePnpm(seams: E2ESeams = {}): string[] | null {
  const which = resolveWhich(seams);
  const pnpm = which("pnpm");
  if (pnpm) {
    return [pnpm];
  }
  const corepack = which("corepack");
  if (corepack) {
    return [corepack, "pnpm"];
  }
  return null;
}

function runNpmStep(
  cmd: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  label: string,
  timeoutSeconds: number,
  seams: E2ESeams,
): [boolean, string] {
  const spawn = seams.spawnText ?? spawnText;
  const head = cmd[0] ?? "";
  const result = spawn(head, cmd.slice(1), {
    cwd,
    env,
    timeoutMs: timeoutSeconds * 1000,
  });
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim();
    return [false, `${label} failed (exit ${result.status}): ${detail.slice(-500)}`];
  }
  return [true, `${label} OK`];
}

/**
 * Bump the four published package versions to <version> and resolve any
 * `workspace:` dependency spec to `^<version>` (npm cannot publish the pnpm
 * workspace protocol verbatim). Folds in the scope item-4 version-alignment
 * assertion: each manifest is read back and must report exactly <version>.
 */
export function alignNpmPackageVersions(cloneDir: string, version: string): [boolean, string] {
  for (const pkg of NPM_PUBLISH_PACKAGES) {
    const manifest = join(cloneDir, "packages", pkg, "package.json");
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(readFileSync(manifest, "utf8")) as Record<string, unknown>;
    } catch (exc) {
      return [
        false,
        `version-align FAIL: cannot read packages/${pkg}/package.json: ${String(exc)}`,
      ];
    }
    data.version = version;
    const deps = data.dependencies;
    if (deps !== null && typeof deps === "object") {
      const depMap = deps as Record<string, unknown>;
      for (const [name, spec] of Object.entries(depMap)) {
        if (typeof spec === "string" && spec.startsWith("workspace:")) {
          depMap[name] = `^${version}`;
        }
      }
    }
    let readback: Record<string, unknown>;
    try {
      writeFileSync(manifest, `${JSON.stringify(data, null, 2)}\n`, "utf8");
      readback = JSON.parse(readFileSync(manifest, "utf8")) as Record<string, unknown>;
    } catch (exc) {
      return [
        false,
        `version-align FAIL: cannot write packages/${pkg}/package.json: ${String(exc)}`,
      ];
    }
    if (readback.version !== version) {
      return [
        false,
        `version-align FAIL: packages/${pkg} version=` +
          `${JSON.stringify(readback.version)} != ${JSON.stringify(version)}`,
      ];
    }
  }
  return [true, `aligned 4 package versions to ${version} (+ resolved workspace protocol)`];
}

/**
 * Dry-run the npm publish for the four @deftai/directive* packages.
 *
 * Steps, all inside the throwaway clone:
 *   1. Resolve `npm`. SOFT-SKIP (ok=true) when npm is absent so Node-less
 *      operators are not blocked -- symmetric to --skip-npm.
 *   2. Resolve pnpm (or `corepack pnpm`) and `pnpm install --frozen-lockfile`.
 *   3. `pnpm -w run build`; dist/ must exist for the dist-only files allowlist.
 *   4. Align the four package.json versions + resolve the workspace protocol.
 *   5. `npm publish --dry-run --access public` per package in dependency order.
 *
 * Returns [ok, reason] like verifyDraftRelease / verifyTag.
 */
export function rehearseNpmPublish(
  cloneDir: string,
  version: string,
  seams: E2ESeams = {},
): [boolean, string] {
  const which = resolveWhich(seams);
  const npmPath = which("npm");
  if (npmPath === null) {
    return [true, "SKIP (npm not on PATH; Node-less operator)"];
  }
  const pnpmCmd = resolvePnpm(seams);
  if (pnpmCmd === null) {
    return [
      false,
      "npm present but neither pnpm nor corepack is on PATH -- " +
        "cannot build the workspace for the dry-run",
    ];
  }

  const env: NodeJS.ProcessEnv = { ...process.env, DEFT_PROJECT_ROOT: cloneDir };

  let [ok, reason] = runNpmStep(
    [...pnpmCmd, "install", "--frozen-lockfile"],
    cloneDir,
    env,
    "pnpm install",
    NPM_INSTALL_TIMEOUT_SECONDS,
    seams,
  );
  if (!ok) {
    return [false, reason];
  }
  [ok, reason] = runNpmStep(
    [...pnpmCmd, "-w", "run", "build"],
    cloneDir,
    env,
    "pnpm build",
    NPM_BUILD_TIMEOUT_SECONDS,
    seams,
  );
  if (!ok) {
    return [false, reason];
  }
  [ok, reason] = alignNpmPackageVersions(cloneDir, version);
  if (!ok) {
    return [false, reason];
  }
  for (const pkg of NPM_PUBLISH_PACKAGES) {
    const pkgDir = join(cloneDir, "packages", pkg);
    [ok, reason] = runNpmStep(
      [npmPath, "publish", "--dry-run", "--access", "public"],
      pkgDir,
      env,
      `npm publish --dry-run packages/${pkg}`,
      NPM_PUBLISH_DRYRUN_TIMEOUT_SECONDS,
      seams,
    );
    if (!ok) {
      return [false, reason];
    }
  }
  return [
    true,
    "npm publish --dry-run clean for 4 packages " +
      `(types -> core -> content -> cli) at v${version}`,
  ];
}
