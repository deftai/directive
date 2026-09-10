import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { isPass2CommitPath } from "../init-deposit/hygiene.js";
import { defaultWhich } from "../release/spawn.js";
import { resolveCommandOnPath, spawnCommandText } from "../verify-env/command-spawn.js";
import {
  MODULE_NOT_FOUND_MARKERS,
  NPM_BUILD_TIMEOUT_SECONDS,
  NPM_E2E_REHEARSAL_TAG,
  NPM_INSTALL_RUN_TIMEOUT_SECONDS,
  NPM_INSTALL_TIMEOUT_SECONDS,
  NPM_PACK_TIMEOUT_SECONDS,
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
  // Injected which seam wins for unit tests; production uses PATHEXT-aware PATH scan
  // so `where pnpm` extensionless shims do not ENOENT under spawnSync (#2548 / #2467).
  if (seams.which ?? seams.whichGh) {
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
  const pnpm = resolveCommandOnPath("pnpm");
  if (pnpm) {
    return [pnpm];
  }
  const corepack = resolveCommandOnPath("corepack");
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
  const spawn = seams.spawnText ?? spawnCommandText;
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
 *   5. `npm publish --dry-run --access public --tag e2e-rehearsal` per package
 *      in dependency order (#1925 bypasses implicit-`latest` when the rehearsal
 *      sentinel is below the highest published version).
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
      [npmPath, "publish", "--dry-run", "--access", "public", "--tag", NPM_E2E_REHEARSAL_TAG],
      pkgDir,
      env,
      `npm publish --dry-run --tag ${NPM_E2E_REHEARSAL_TAG} packages/${pkg}`,
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

function moduleResolutionFailure(output: string): string | null {
  for (const marker of MODULE_NOT_FOUND_MARKERS) {
    if (output.includes(marker)) return marker;
  }
  return null;
}

/**
 * Publish-layout install+run smoke (#1996, #2010): pack the four
 * @deftai/directive* packages, install the tarballs into a clean flat
 * node_modules, then run `directive --version` (exit-0 liveness) and
 * `directive doctor` (deep-import coverage) so import-resolution bugs like
 * #1993 sub-problem 1 surface before a real npm publish. The smoke gates on
 * module-not-found markers, NOT on the doctor's pass/fail verdict -- a full
 * doctor check exits non-zero in a bare consumer layout, which is benign
 * (#2010).
 */
export function rehearseNpmInstallAndRun(
  cloneDir: string,
  version: string,
  seams: E2ESeams = {},
  options: { skipWorkspacePrep?: boolean } = {},
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
        "cannot build the workspace for install+run smoke",
    ];
  }

  const env: NodeJS.ProcessEnv = { ...process.env, DEFT_PROJECT_ROOT: cloneDir };
  let ok = true;
  let reason = "";

  if (!options.skipWorkspacePrep) {
    let [ok, reason] = runNpmStep(
      [...pnpmCmd, "install", "--frozen-lockfile"],
      cloneDir,
      env,
      "pnpm install",
      NPM_INSTALL_TIMEOUT_SECONDS,
      seams,
    );
    if (!ok) return [false, reason];
    [ok, reason] = runNpmStep(
      [...pnpmCmd, "-w", "run", "build"],
      cloneDir,
      env,
      "pnpm build",
      NPM_BUILD_TIMEOUT_SECONDS,
      seams,
    );
    if (!ok) return [false, reason];
    [ok, reason] = alignNpmPackageVersions(cloneDir, version);
    if (!ok) return [false, reason];
  }

  const packDir = join(cloneDir, ".deft-e2e-packs");
  mkdirSync(packDir, { recursive: true });
  const tgzPaths: string[] = [];
  for (const pkg of NPM_PUBLISH_PACKAGES) {
    const pkgDir = join(cloneDir, "packages", pkg);
    [ok, reason] = runNpmStep(
      [npmPath, "pack", "--pack-destination", packDir],
      pkgDir,
      env,
      `npm pack packages/${pkg}`,
      NPM_PACK_TIMEOUT_SECONDS,
      seams,
    );
    if (!ok) return [false, reason];
    const manifest = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")) as {
      name?: string;
      version?: string;
    } | null;
    if (
      manifest === null ||
      typeof manifest.name !== "string" ||
      typeof manifest.version !== "string"
    ) {
      return [false, `version-align FAIL: invalid manifest in packages/${pkg}`];
    }
    const scoped = manifest.name.replaceAll("@", "").replaceAll("/", "-");
    tgzPaths.push(join(packDir, `${scoped}-${manifest.version}.tgz`));
  }

  const consumerDir = join(cloneDir, ".deft-e2e-consumer");
  mkdirSync(consumerDir, { recursive: true });
  writeFileSync(
    join(consumerDir, "package.json"),
    `${JSON.stringify({ name: "deft-e2e-consumer", private: true, version: "0.0.0" }, null, 2)}\n`,
    "utf8",
  );

  const installArgs = [npmPath, "install", ...tgzPaths];
  [ok, reason] = runNpmStep(
    installArgs,
    consumerDir,
    env,
    "npm install packed tarballs",
    NPM_INSTALL_RUN_TIMEOUT_SECONDS,
    seams,
  );
  if (!ok) return [false, reason];

  const spawn = seams.spawnText ?? spawnCommandText;
  const cliBin = join(consumerDir, "node_modules", "@deftai", "directive", "dist", "bin.js");

  // Liveness probe (#2010): `--version` loads the cli + core engine via
  // engineInfo(), exercising the cross-package import path that #1993 broke,
  // and reliably exits 0 on a healthy install. This is the clean exit-0 gate;
  // gating the smoke on the doctor's exit code instead is a false positive
  // because a full doctor check exits non-zero in a bare consumer layout.
  const versionRun = spawn(process.execPath, [cliBin, "--version"], {
    cwd: consumerDir,
    env,
    timeoutMs: NPM_INSTALL_RUN_TIMEOUT_SECONDS * 1000,
  });
  const versionOut = `${versionRun.stdout ?? ""}\n${versionRun.stderr ?? ""}`;
  let resolutionHit = moduleResolutionFailure(versionOut);
  if (resolutionHit !== null) {
    return [
      false,
      `install+run smoke: module resolution error on --version (${resolutionHit}): ${versionOut.trim().slice(-800)}`,
    ];
  }
  if (versionRun.status !== 0) {
    return [
      false,
      `install+run smoke: directive --version exited ${versionRun.status}: ${versionOut.trim().slice(-500)}`,
    ];
  }

  // Deep-import probe (#2010): run the doctor verb to exercise the deeper
  // cross-package import graph that #1993 sub-problem 1 broke. The doctor
  // legitimately exits non-zero in a bare consumer layout (e.g. no root
  // Taskfile.yml), so gate ONLY on the module-not-found markers, NOT on the
  // doctor's pass/fail verdict.
  const doctorRun = spawn(process.execPath, [cliBin, "doctor"], {
    cwd: consumerDir,
    env,
    timeoutMs: NPM_INSTALL_RUN_TIMEOUT_SECONDS * 1000,
  });
  const doctorOut = `${doctorRun.stdout ?? ""}\n${doctorRun.stderr ?? ""}`;
  resolutionHit = moduleResolutionFailure(doctorOut);
  if (resolutionHit !== null) {
    return [
      false,
      `install+run smoke: module resolution error on doctor (${resolutionHit}): ${doctorOut.trim().slice(-800)}`,
    ];
  }

  return [
    true,
    `packed + installed 4 packages at v${version}; ran directive --version (exit 0) + doctor without module-not-found`,
  ];
}

export const PASS1_ABSENCE_LOCK_PATHS = [
  "xbrief/PROJECT-DEFINITION.xbrief.json",
  "xbrief/specification.xbrief.json",
  "xbrief/plan.xbrief.json",
] as const;

const DIRECTIVE_SCOPE_PREFIX = "@deftai/directive";

function isInsideWorkspace(cleanDir: string, workspaceRoot: string): boolean {
  const rel = relative(resolve(workspaceRoot), resolve(cleanDir));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function xbriefStampFieldsPresent(raw: string): boolean {
  return /"DeftVersion"\s*:/.test(raw) || /"deft_version"\s*:/.test(raw);
}

export function pass1AbsenceLocksPresent(projectDir: string): boolean {
  for (const rel of PASS1_ABSENCE_LOCK_PATHS) {
    const full = join(projectDir, rel);
    if (!existsSync(full)) continue;
    const raw = readFileSync(full, "utf8");
    if (xbriefStampFieldsPresent(raw)) return false;
  }
  return true;
}

export function assertPass2Precondition(projectDir: string): void {
  if (!pass1AbsenceLocksPresent(projectDir)) {
    throw new Error(
      "Pass 2 precondition failed: three absence locks are not present in the base tree",
    );
  }
}

export interface DirectivePackageManifest {
  readonly path: string;
  readonly name: string;
  readonly version: string;
}

export function collectDirectivePackageManifests(installRoot: string): DirectivePackageManifest[] {
  const results: DirectivePackageManifest[] = [];
  const walk = (dir: string): void => {
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (entry.name !== "package.json") continue;
        try {
          const data = JSON.parse(readFileSync(full, "utf8")) as {
            name?: unknown;
            version?: unknown;
          };
          if (typeof data.name === "string" && data.name.startsWith(DIRECTIVE_SCOPE_PREFIX)) {
            results.push({
              path: full,
              name: data.name,
              version: typeof data.version === "string" ? data.version : "",
            });
          }
        } catch {
          // skip malformed package.json
        }
      }
    } catch {
      return;
    }
  };
  walk(installRoot);
  return results;
}

export function assertTagBoundDirectiveVersions(installRoot: string, version: string): void {
  const manifests = collectDirectivePackageManifests(installRoot);
  if (manifests.length === 0) {
    throw new Error("tag-bind FAIL: no @deftai/directive* package.json found");
  }
  for (const manifest of manifests) {
    if (manifest.version !== version) {
      throw new Error(
        `tag-bind FAIL: ${manifest.path} name=${manifest.name} version=${manifest.version} !== ${version}`,
      );
    }
  }
}

export interface PostPublishTwoPassOptions {
  readonly cleanDir: string;
  readonly workspaceRoot: string;
  readonly version: string;
  readonly consumerDir?: string;
  readonly registryPackages?: readonly string[];
  readonly pass2ChangedPaths?: readonly string[];
  readonly skipInstall?: boolean;
}

const DEFAULT_REGISTRY_PACKAGES = [
  "@deftai/directive-types",
  "@deftai/directive-core",
  "@deftai/directive-content",
  "@deftai/directive",
] as const;

export function runPostPublishTwoPassFixture(
  options: PostPublishTwoPassOptions,
  seams: E2ESeams = {},
): [boolean, string] {
  if (isInsideWorkspace(options.cleanDir, options.workspaceRoot)) {
    return [false, "two-pass fixture must run from a clean directory that is not this workspace"];
  }
  const which = resolveWhich(seams);
  const npmPath = which("npm");
  if (npmPath === null) {
    return [false, "npm missing (hard fail)"];
  }
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (!options.skipInstall) {
    const pkgs = options.registryPackages ?? DEFAULT_REGISTRY_PACKAGES;
    const specs = pkgs.map((name) => `${name}@${options.version}`);
    mkdirSync(options.cleanDir, { recursive: true });
    const [ok, reason] = runNpmStep(
      [npmPath, "install", ...specs],
      options.cleanDir,
      env,
      "tag-bound registry install",
      NPM_INSTALL_TIMEOUT_SECONDS,
      seams,
    );
    if (!ok) return [false, reason];
  }
  try {
    assertTagBoundDirectiveVersions(options.cleanDir, options.version);
  } catch (exc) {
    return [false, String(exc)];
  }
  const consumerDir = options.consumerDir ?? join(options.cleanDir, "consumer");
  try {
    assertPass2Precondition(consumerDir);
  } catch (exc) {
    return [false, String(exc)];
  }
  const changed = options.pass2ChangedPaths ?? [];
  const illegal = changed.filter((path) => !isPass2CommitPath(path));
  if (illegal.length > 0) {
    return [false, `Pass 2 commit-set includes non-installer-managed paths: ${illegal.join(", ")}`];
  }
  return [true, `post-publish two-pass fixture green at v${options.version}`];
}
