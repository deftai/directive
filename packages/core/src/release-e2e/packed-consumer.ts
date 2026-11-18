/**
 * Shared packed-consumer helpers (#6614): pack the launcher and runtime from
 * this workspace, install them globally into a temp npm prefix, and install
 * the packed runtime into a throwaway consumer project. Used by the greenfield
 * smoke (#2022 Phase 3) and the no-agent lifecycle fixture.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { spawnText } from "../release/spawn.js";
import { NPM_PUBLISH_PACKAGES } from "./constants.js";
import { alignNpmPackageVersions, packOvprTarballs } from "./npm-ops.js";
import type { E2ESeams } from "./types.js";

export type SpawnTextFn = typeof spawnText;

/**
 * Run one subprocess step and report `[ok, reason]`. Progress lines read
 * `<prefix>: <label> — starting|OK|failed`.
 */
export function runPackedStep(
  spawn: SpawnTextFn,
  prefix: string,
  label: string,
  cmd: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
  onProgress?: (message: string) => void,
): [boolean, string] {
  onProgress?.(`${prefix}: ${label} — starting`);
  const startedMs = Date.now();
  const result = spawn(cmd, args, options);
  const elapsedMs = Date.now() - startedMs;
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim();
    const timeoutHint =
      options.timeoutMs !== undefined && result.status === 128
        ? `; subprocess killed after ${elapsedMs}ms (spawn budget ${options.timeoutMs}ms — likely hang or timeout)`
        : "";
    onProgress?.(`${prefix}: ${label} — failed (exit ${result.status}) after ${elapsedMs}ms`);
    // Doctor suites are long; keep the full capture so the hard error is visible.
    // Other steps keep head+tail to bound CI log size.
    const clipped =
      label.includes("doctor") || detail.length <= 4000
        ? detail
        : `${detail.slice(0, 1000)}\n…\n${detail.slice(-1000)}`;
    return [
      false,
      `${label} failed (exit ${result.status})${timeoutHint}: ${clipped || "(no captured output)"}`,
    ];
  }
  onProgress?.(`${prefix}: ${label} — OK (${elapsedMs}ms)`);
  return [true, `${label} OK`];
}

/** Snapshot the publishable package manifests; `alignNpmPackageVersions` rewrites them. */
export function backupPackageManifests(repoRoot: string): Map<string, string> {
  const backup = new Map<string, string>();
  for (const pkg of NPM_PUBLISH_PACKAGES) {
    const manifestPath = join(repoRoot, "packages", pkg, "package.json");
    if (existsSync(manifestPath)) {
      backup.set(manifestPath, readFileSync(manifestPath, "utf8"));
    }
  }
  return backup;
}

export function restorePackageManifests(backup: ReadonlyMap<string, string>): void {
  for (const [manifestPath, contents] of backup) {
    writeFileSync(manifestPath, contents, "utf8");
  }
}

export interface PackAndInstallOptions {
  repoRoot: string;
  version: string;
  packDir: string;
  npm: string;
  /** Env with `npm_config_prefix` set to the temp global prefix. */
  env: NodeJS.ProcessEnv;
  seams: E2ESeams;
  spawn: SpawnTextFn;
  which: (name: string) => string | null;
  prefix: string;
  onProgress?: (message: string) => void;
  /** Budget for `npm install -g` (default 120s). */
  installTimeoutMs?: number;
}

/**
 * Align versions, pack the launcher and runtime, and `npm install -g` both
 * into the temp prefix. Returns the packed tarball paths. Reasons carry no
 * prefix; the caller adds its own.
 */
export function packAndInstallGlobally(
  options: PackAndInstallOptions,
): [boolean, string, string[]] {
  const { repoRoot, version, packDir, npm, env, seams, spawn, which, prefix, onProgress } = options;
  onProgress?.(`${prefix}: aligning npm package versions`);
  const [aligned, alignReason] = alignNpmPackageVersions(repoRoot, version);
  if (!aligned) return [false, alignReason, []];

  onProgress?.(`${prefix}: OVPR stage+pack runtime + launcher`);
  const packSeams: E2ESeams = { ...seams, spawnText: spawn, which };
  const packedResult = packOvprTarballs(repoRoot, version, packDir, npm, env, packSeams);
  if (!packedResult[0]) return [false, packedResult[1], []];
  const packed = packedResult[2];

  const [ok, reason] = runPackedStep(
    spawn,
    prefix,
    "npm install -g",
    npm,
    ["install", "-g", ...packed],
    { env, timeoutMs: options.installTimeoutMs ?? 120_000 },
    onProgress,
  );
  if (!ok) return [false, reason, []];
  return [true, "packed and installed globally", packed];
}

/**
 * npm records `file:../packs/...` for a local tarball; OVPR repair requires an
 * exact SemVer pin and a matching lockfile request. Rewrite both so repair
 * skips the registry restore (the smoke version is not on the public registry).
 */
export function rewriteExactRuntimePin(projectDir: string, version: string): void {
  const consumerPkgPath = join(projectDir, "package.json");
  const consumerPkg = JSON.parse(readFileSync(consumerPkgPath, "utf8")) as {
    devDependencies?: Record<string, string>;
    dependencies?: Record<string, string>;
  };
  const deps = consumerPkg.devDependencies ?? consumerPkg.dependencies ?? {};
  deps["@deftai/directive-runtime"] = version;
  consumerPkg.devDependencies = deps;
  writeFileSync(consumerPkgPath, `${JSON.stringify(consumerPkg, null, 2)}\n`, "utf8");

  const lockPath = join(projectDir, "package-lock.json");
  if (existsSync(lockPath)) {
    const lock = JSON.parse(readFileSync(lockPath, "utf8")) as {
      packages?: Record<string, Record<string, unknown>>;
    };
    const root = lock.packages?.[""];
    if (root && typeof root === "object") {
      const rootDeps = (root.devDependencies ?? root.dependencies) as
        | Record<string, string>
        | undefined;
      if (rootDeps) rootDeps["@deftai/directive-runtime"] = version;
      if (!root.devDependencies && rootDeps) root.devDependencies = rootDeps;
    }
    const entry = lock.packages?.["node_modules/@deftai/directive-runtime"];
    if (entry && typeof entry === "object") {
      entry.version = version;
    }
    writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`, "utf8");
  }
}

export interface InstallConsumerOptions {
  spawn: SpawnTextFn;
  which: (name: string) => string | null;
  npm: string;
  /** The globally installed packed launcher (`<prefix>/bin/deft`). */
  deft: string;
  projectDir: string;
  /** Working directory for `deft install --repair` (outside the project). */
  repairCwd: string;
  packed: readonly string[];
  version: string;
  packageName: string;
  /** Env with the packed launcher's bin first on PATH. */
  env: NodeJS.ProcessEnv;
  prefix: string;
  onProgress?: (message: string) => void;
  /** Budget for the consumer `npm install` and the repair (default 120s each). */
  installTimeoutMs?: number;
}

/**
 * Make an installed consumer: write `package.json`, install the packed
 * runtime tarball, rewrite the exact pin, `git init`, then
 * `deft install --repair --yes`. Reasons carry no prefix.
 */
export function installPackedConsumer(options: InstallConsumerOptions): [boolean, string] {
  const { spawn, which, npm, deft, projectDir, repairCwd, packed, version, env, prefix } = options;
  const { onProgress } = options;
  // Public @deftai/directive-runtime@latest is still a prerelease until GA, so
  // install the packed tip runtime tarball into the consumer, then run
  // install --repair for OVPR wiring (AC13.4 packed-pair path).
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(
    join(projectDir, "package.json"),
    `${JSON.stringify({ name: options.packageName, private: true, version: "0.0.0" }, null, 2)}\n`,
    "utf8",
  );
  const runtimeTgz = packed.find((p) => p.includes("directive-runtime-"));
  if (runtimeTgz === undefined) {
    return [false, "packed runtime tarball missing from OVPR pack result"];
  }
  let [ok, reason] = runPackedStep(
    spawn,
    prefix,
    "npm install packed runtime tarball",
    npm,
    ["install", "--save-dev", "--save-exact", runtimeTgz],
    { cwd: projectDir, env, timeoutMs: options.installTimeoutMs ?? 120_000 },
    onProgress,
  );
  if (!ok) return [false, reason];

  try {
    rewriteExactRuntimePin(projectDir, version);
  } catch (exc) {
    return [false, `cannot rewrite exact runtime pin: ${String(exc)}`];
  }

  // Initialize git before repair so setup can deposit hooks / GENERATION wiring.
  const gitBin = which("git");
  if (gitBin === null) {
    return [false, "git not on PATH; cannot init consumer repo before repair"];
  }
  [ok, reason] = runPackedStep(
    spawn,
    prefix,
    "git init consumer",
    gitBin,
    ["init"],
    { cwd: projectDir, env, timeoutMs: 30_000 },
    onProgress,
  );
  if (!ok) return [false, reason];

  return runPackedStep(
    spawn,
    prefix,
    "directive install --repair",
    deft,
    ["install", "--repair", "--yes", "--repo-root", projectDir],
    { cwd: repairCwd, env, timeoutMs: options.installTimeoutMs ?? 120_000 },
    onProgress,
  );
}
