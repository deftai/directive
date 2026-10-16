/**
 * Package-manager selection and exact-add helpers for the launcher (AC5.7 / INIT-13).
 * Node builtins + child_process only — no runtime/core dependency.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { LAUNCHER_PACKAGE_NAME, RUNTIME_PACKAGE_NAME } from "./constants.js";

/** AC5.15 / AC14.56 — mandated interruption report text. */
export const PARTIAL_CHANGES_MAY_REMAIN = "Partial changes may remain.";

/** AC5.1 / INIT-11 — plan disclosure for install-script policy. */
export const INSTALL_SCRIPT_POLICY_PLAN_LINE =
  "install-script policy: PM exact-add uses --ignore-scripts (pin/wiring do not require package lifecycle scripts); project registry, authentication, proxy, and lockfile settings are honoured";

export type PackageManager = "npm" | "pnpm";

export type DetectPmResult =
  | { readonly ok: true; readonly pm: PackageManager; readonly evidence: string }
  | { readonly ok: false; readonly message: string };

const EXACT_SEMVER_RE = /^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$/;

export function isExactSemver(version: string): boolean {
  return EXACT_SEMVER_RE.test(version.trim());
}

export function isPrereleaseVersion(version: string): boolean {
  const v = version.trim();
  if (!isExactSemver(v)) return false;
  return v.includes("-");
}

function readJsonObject(path: string): Record<string, unknown> | null {
  try {
    const raw = readFileSync(path, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

type PackageManagerFieldResult =
  | { readonly kind: "absent" }
  | { readonly kind: "supported"; readonly pm: PackageManager }
  | { readonly kind: "unsupported"; readonly name: string };

/** Parse Corepack-style `name` / `name@version` (packageManager field). */
function parsePmNameToken(raw: string): PackageManagerFieldResult {
  const token = raw.trim();
  if (token === "") return { kind: "absent" };
  if (token.startsWith("npm@") || token === "npm") return { kind: "supported", pm: "npm" };
  if (token.startsWith("pnpm@") || token === "pnpm") return { kind: "supported", pm: "pnpm" };
  if (token.startsWith("yarn@") || token === "yarn") return { kind: "unsupported", name: "Yarn" };
  if (token.startsWith("bun@") || token === "bun") return { kind: "unsupported", name: "Bun" };
  const name = token.split("@")[0]?.trim() || token;
  return { kind: "unsupported", name };
}

function readPackageManagerField(projectRoot: string): PackageManagerFieldResult {
  const pkg = readJsonObject(join(projectRoot, "package.json"));
  if (pkg === null) return { kind: "absent" };
  const raw = pkg.packageManager;
  if (typeof raw !== "string" || raw.trim() === "") return { kind: "absent" };
  return parsePmNameToken(raw);
}

/**
 * AC5.6 / INIT-08 — `devEngines.packageManager` (string or { name, version? }).
 * Same supported/unsupported rules as the Corepack `packageManager` field.
 */
function readDevEnginesPackageManager(projectRoot: string): PackageManagerFieldResult {
  const pkg = readJsonObject(join(projectRoot, "package.json"));
  if (pkg === null) return { kind: "absent" };
  const devEngines = pkg.devEngines;
  if (devEngines === null || typeof devEngines !== "object" || Array.isArray(devEngines)) {
    return { kind: "absent" };
  }
  const raw = (devEngines as Record<string, unknown>).packageManager;
  if (typeof raw === "string") return parsePmNameToken(raw);
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
    const name = (raw as Record<string, unknown>).name;
    if (typeof name !== "string" || name.trim() === "") return { kind: "absent" };
    return parsePmNameToken(name.trim());
  }
  return { kind: "absent" };
}

type DeclaredPmSlot =
  | { readonly kind: "absent" }
  | { readonly kind: "supported"; readonly pm: PackageManager; readonly evidence: string }
  | { readonly kind: "unsupported"; readonly name: string }
  | { readonly kind: "conflict"; readonly message: string };

/**
 * Merge packageManager + devEngines.packageManager (same AC5.6 slot).
 * Disagree → conflict; only one / both agree → supported with evidence.
 */
function readDeclaredPackageManagerSlot(projectRoot: string): DeclaredPmSlot {
  const field = readPackageManagerField(projectRoot);
  const dev = readDevEnginesPackageManager(projectRoot);

  if (field.kind === "unsupported") return field;
  if (dev.kind === "unsupported") return { kind: "unsupported", name: dev.name };

  if (field.kind === "supported" && dev.kind === "supported") {
    if (field.pm !== dev.pm) {
      return {
        kind: "conflict",
        message:
          `packageManager (${field.pm}) and devEngines.packageManager (${dev.pm}) disagree. ` +
          "Pass --package-manager npm|pnpm after aligning the declarations, or remove one.",
      };
    }
    return {
      kind: "supported",
      pm: field.pm,
      evidence: `packageManager/devEngines (${field.pm})`,
    };
  }
  if (field.kind === "supported") {
    return {
      kind: "supported",
      pm: field.pm,
      evidence: `packageManager field (${field.pm})`,
    };
  }
  if (dev.kind === "supported") {
    return {
      kind: "supported",
      pm: dev.pm,
      evidence: `devEngines.packageManager (${dev.pm})`,
    };
  }
  return { kind: "absent" };
}

/**
 * Select npm or pnpm from lockfile / packageManager / devEngines / explicit flag.
 * Refuses yarn and bun (AC5.7), including an explicit packageManager /
 * devEngines.packageManager field with no lockfile (do not fall through to npm).
 */
export function detectPackageManager(
  projectRoot: string,
  flag: string | null,
): DetectPmResult {
  const hasYarn = existsSync(join(projectRoot, "yarn.lock"));
  const hasBun =
    existsSync(join(projectRoot, "bun.lock")) || existsSync(join(projectRoot, "bun.lockb"));
  if (hasYarn) {
    return {
      ok: false,
      message:
        "Yarn projects are not supported (AC5.7). Use npm or pnpm, or remove yarn.lock.",
    };
  }
  if (hasBun) {
    return {
      ok: false,
      message:
        "Bun projects are not supported (AC5.7). Use npm or pnpm, or remove bun.lock.",
    };
  }

  const declared = readDeclaredPackageManagerSlot(projectRoot);
  if (declared.kind === "unsupported") {
    return {
      ok: false,
      message: `${declared.name} projects are not supported (AC5.7). Use npm or pnpm.`,
    };
  }
  if (declared.kind === "conflict") {
    return { ok: false, message: declared.message };
  }

  if (flag !== null) {
    if (flag !== "npm" && flag !== "pnpm") {
      return {
        ok: false,
        message: `--package-manager must be npm or pnpm (got ${flag}).`,
      };
    }
  }

  const hasPnpmLock = existsSync(join(projectRoot, "pnpm-lock.yaml"));
  const hasNpmLock = existsSync(join(projectRoot, "package-lock.json"));
  const fieldPm = declared.kind === "supported" ? declared.pm : null;
  const fieldEvidence = declared.kind === "supported" ? declared.evidence : null;

  if (hasPnpmLock && hasNpmLock) {
    if (flag === "npm" || flag === "pnpm") {
      return { ok: true, pm: flag, evidence: `--package-manager ${flag} (both lockfiles present)` };
    }
    if (fieldPm !== null && fieldEvidence !== null) {
      return {
        ok: true,
        pm: fieldPm,
        evidence: `${fieldEvidence} with both lockfiles`,
      };
    }
    return {
      ok: false,
      message:
        "Both package-lock.json and pnpm-lock.yaml present. Pass --package-manager npm|pnpm.",
    };
  }

  if (hasPnpmLock) {
    if (flag === "npm") {
      return {
        ok: false,
        message: "pnpm-lock.yaml present; refusing --package-manager npm.",
      };
    }
    return { ok: true, pm: "pnpm", evidence: "pnpm-lock.yaml" };
  }
  if (hasNpmLock) {
    if (flag === "pnpm") {
      return {
        ok: false,
        message: "package-lock.json present; refusing --package-manager pnpm.",
      };
    }
    return { ok: true, pm: "npm", evidence: "package-lock.json" };
  }

  if (flag === "npm" || flag === "pnpm") {
    return { ok: true, pm: flag, evidence: `--package-manager ${flag}` };
  }
  if (fieldPm !== null && fieldEvidence !== null) {
    return { ok: true, pm: fieldPm, evidence: fieldEvidence };
  }

  // Fresh project: default npm (evidence disclosed in plan).
  return { ok: true, pm: "npm", evidence: "default (no lockfile / packageManager)" };
}

/** Extract the root (`.:`) importer body from a pnpm-lock.yaml. */
function pnpmRootImporterBlock(text: string): string | null {
  const lines = text.split(/\r?\n/);
  let i = 0;
  while (i < lines.length && !/^importers:\s*$/.test(lines[i]!)) i++;
  if (i >= lines.length) return null;
  i++;
  while (i < lines.length && !/^  \.:\s*$/.test(lines[i]!)) {
    const line = lines[i]!;
    if (line !== "" && !line.startsWith(" ")) return null;
    i++;
  }
  if (i >= lines.length) return null;
  i++;
  const block: string[] = [];
  while (i < lines.length) {
    const line = lines[i]!;
    if (line !== "" && (/^  \S/.test(line) || /^[^ \t]/.test(line))) break;
    block.push(line);
    i++;
  }
  return block.join("\n");
}

function pnpmRootRecordsExactPin(text: string, exactVersion: string): boolean {
  const block = pnpmRootImporterBlock(text);
  if (block === null) return false;
  const pkg = RUNTIME_PACKAGE_NAME.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(
    `['"]?${pkg}['"]?:\\s*\\n\\s+specifier:\\s*['"]?([^\\s'"]+)['"]?\\s*\\n\\s+version:\\s*['"]?([^\\s'"]+)['"]?`,
  );
  const match = block.match(re);
  if (match === null) return false;
  return match[1] === exactVersion && match[2] === exactVersion;
}

function npmRootRequest(
  packages: Record<string, unknown>,
): string | null {
  const root = packages[""];
  if (typeof root !== "object" || root === null || Array.isArray(root)) return null;
  const rec = root as Record<string, unknown>;
  for (const key of ["devDependencies", "dependencies", "optionalDependencies"] as const) {
    const deps = rec[key];
    if (typeof deps !== "object" || deps === null || Array.isArray(deps)) continue;
    const v = (deps as Record<string, unknown>)[RUNTIME_PACKAGE_NAME];
    if (typeof v === "string") return v;
  }
  return null;
}

/**
 * True when the selected PM's lockfile consistently records the root project's
 * exact runtime pin request and resolved version (AC6.10). Other workspace
 * package matches alone are not sufficient.
 */
export function lockfileRecordsExactPin(
  projectRoot: string,
  exactVersion: string,
  pm: PackageManager,
): boolean {
  if (pm === "pnpm") {
    const pnpmLock = join(projectRoot, "pnpm-lock.yaml");
    if (!existsSync(pnpmLock)) return false;
    try {
      return pnpmRootRecordsExactPin(readFileSync(pnpmLock, "utf8"), exactVersion);
    } catch {
      return false;
    }
  }

  const npmLock = join(projectRoot, "package-lock.json");
  if (!existsSync(npmLock)) return false;
  const lock = readJsonObject(npmLock);
  if (lock === null) return false;
  const packages = lock.packages;
  if (typeof packages === "object" && packages !== null && !Array.isArray(packages)) {
    const pkgs = packages as Record<string, unknown>;
    const request = npmRootRequest(pkgs);
    if (request !== exactVersion) return false;
    const entry = pkgs[`node_modules/${RUNTIME_PACKAGE_NAME}`];
    if (typeof entry === "object" && entry !== null && !Array.isArray(entry)) {
      return (entry as { version?: unknown }).version === exactVersion;
    }
    return false;
  }
  // Legacy lockfileVersion 1: no packages[""] request — treat as unusable for
  // exact-pin consistency (repair must PM-add).
  return false;
}

export interface EnsurePackageJsonResult {
  readonly created: boolean;
  readonly path: string;
}

/** Create `{ "private": true }` when package.json is missing (AC6.12 / INIT-12). */
export function ensurePackageJson(projectRoot: string): EnsurePackageJsonResult {
  const path = join(projectRoot, "package.json");
  if (existsSync(path)) {
    return { created: false, path };
  }
  writeFileSync(path, `${JSON.stringify({ private: true }, null, 2)}\n`);
  return { created: true, path };
}

export interface PmAddOptions {
  readonly projectRoot: string;
  readonly pm: PackageManager;
  readonly version: string;
  readonly env?: NodeJS.ProcessEnv;
}

export type PmAddResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly interrupted?: false;
      readonly message: string;
      readonly stderr: string;
    }
  | {
      readonly ok: false;
      readonly interrupted: true;
      readonly signal: string;
      readonly message: string;
      readonly stderr: string;
    };

/** Extract trailing `@version` from a Corepack-style `name@version` token. */
function versionFromPmToken(raw: string): string | null {
  const at = raw.indexOf("@");
  if (at < 0) return null;
  const ver = raw.slice(at + 1).trim();
  return ver.length > 0 ? ver : null;
}

/**
 * Declared PM version from `packageManager` or `devEngines.packageManager`
 * (AC5.6 / AC5.8 — e.g. pnpm@9.15.0 → "9.15.0"). Prefer `packageManager` when both set.
 */
export function readDeclaredPackageManagerVersion(projectRoot: string): string | null {
  const pkg = readJsonObject(join(projectRoot, "package.json"));
  if (pkg === null) return null;
  if (typeof pkg.packageManager === "string" && pkg.packageManager.trim() !== "") {
    const fromField = versionFromPmToken(pkg.packageManager.trim());
    if (fromField !== null) return fromField;
  }
  const devEngines = pkg.devEngines;
  if (devEngines !== null && typeof devEngines === "object" && !Array.isArray(devEngines)) {
    const raw = (devEngines as Record<string, unknown>).packageManager;
    if (typeof raw === "string") {
      const fromDev = versionFromPmToken(raw.trim());
      if (fromDev !== null) return fromDev;
    } else if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
      const ver = (raw as Record<string, unknown>).version;
      if (typeof ver === "string" && ver.trim() !== "") return ver.trim();
      const name = (raw as Record<string, unknown>).name;
      if (typeof name === "string") {
        const fromName = versionFromPmToken(name.trim());
        if (fromName !== null) return fromName;
      }
    }
  }
  return null;
}

/** AC5.8 / AC14.45 — how-to when the declared PM binary is missing. */
export function formatMissingPmGuidance(
  pm: PackageManager,
  declaredVersion: string | null = null,
): string {
  const ver = declaredVersion && declaredVersion.length > 0 ? declaredVersion : "latest";
  const prepare =
    pm === "pnpm"
      ? `corepack enable && corepack prepare pnpm@${ver} --activate`
      : `corepack enable && corepack prepare npm@${ver} --activate`;
  return (
    `${pm} is required for this project but was not found on PATH.\n` +
    `To make ${pm} available:\n` +
    `  - If your Node install includes Corepack: ${prepare}\n` +
    `  - Or install ${pm} yourself and ensure its directory is on PATH\n` +
    `Directive does not install, upgrade, or switch package managers.`
  );
}

/**
 * AC5.8 / INIT-10: verify the selected PM binary is spawnable.
 * Does not install or switch managers; Corepack is suggested, never assumed.
 * When `projectRoot` is set, the probe runs with that cwd so Corepack reads
 * the selected project's packageManager field (not the launcher's cwd).
 */
export function ensurePackageManagerAvailable(
  pm: PackageManager,
  env: NodeJS.ProcessEnv = process.env,
  declaredVersion: string | null = null,
  projectRoot?: string,
): { ok: true } | { ok: false; message: string } {
  const result = spawnSync(pm, ["--version"], {
    ...(projectRoot !== undefined ? { cwd: projectRoot } : {}),
    env,
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  if (result.error) {
    const err = result.error as NodeJS.ErrnoException;
    if (err.code === "ENOENT" || /ENOENT/i.test(err.message)) {
      return { ok: false, message: formatMissingPmGuidance(pm, declaredVersion) };
    }
    return {
      ok: false,
      message: formatMissingPmGuidance(pm, declaredVersion),
    };
  }
  if (result.status === null && result.signal) {
    return { ok: false, message: formatMissingPmGuidance(pm, declaredVersion) };
  }
  if (result.status !== 0) {
    // Binary present but unhealthy — still explain how to make a working PM available.
    return { ok: false, message: formatMissingPmGuidance(pm, declaredVersion) };
  }
  return { ok: true };
}

export interface PlanFingerprint {
  readonly entries: ReadonlyArray<{ readonly relPath: string; readonly digest: string | null }>;
}

function fileDigest(absPath: string): string | null {
  if (!existsSync(absPath)) return null;
  try {
    return createHash("sha256").update(readFileSync(absPath)).digest("hex");
  } catch {
    return null;
  }
}

/**
 * Plan-critical paths for AC5.13 invalidation.
 * Includes every lockfile `detectPackageManager` consults so a concurrent
 * lockfile create/delete invalidates the plan even when the selected PM's
 * own lockfile digest is unchanged.
 */
export function planCriticalRelPaths(_pm: PackageManager): string[] {
  return [
    "package.json",
    "package-lock.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "yarn.lock",
    "bun.lock",
    "bun.lockb",
  ];
}

/** Snapshot plan-critical files at plan time (AC5.13). */
export function fingerprintPlanCriticalFiles(
  projectRoot: string,
  pm: PackageManager,
): PlanFingerprint {
  const entries = planCriticalRelPaths(pm).map((relPath) => ({
    relPath,
    digest: fileDigest(join(projectRoot, relPath)),
  }));
  return { entries };
}

/** True when any plan-critical file digest differs from the plan-time snapshot. */
export function planFingerprintChanged(
  projectRoot: string,
  pm: PackageManager,
  prior: PlanFingerprint,
): boolean {
  const now = fingerprintPlanCriticalFiles(projectRoot, pm);
  if (now.entries.length !== prior.entries.length) return true;
  for (let i = 0; i < prior.entries.length; i++) {
    const a = prior.entries[i]!;
    const b = now.entries[i]!;
    if (a.relPath !== b.relPath || a.digest !== b.digest) return true;
  }
  return false;
}

/**
 * Map a spawnSync result from a PM add/remove into PmAddResult.
 * Signals → interrupted (AC5.15 / AC14.56).
 */
export function interpretPmSpawnResult(
  pm: string,
  args: readonly string[],
  result: Pick<SpawnSyncReturns<string>, "status" | "signal" | "error" | "stdout" | "stderr">,
): PmAddResult {
  if (result.error) {
    const err = result.error as NodeJS.ErrnoException;
    if (err.code === "ENOENT" || /ENOENT/i.test(String(err.message))) {
      return {
        ok: false,
        message: formatMissingPmGuidance(pm === "pnpm" ? "pnpm" : "npm"),
        stderr: String(result.error),
      };
    }
    return {
      ok: false,
      message: `Failed to spawn ${pm}: ${result.error.message}`,
      stderr: String(result.error),
    };
  }
  if (result.status === null && result.signal) {
    const signal = String(result.signal);
    return {
      ok: false,
      interrupted: true,
      signal,
      message: `${pm} interrupted (${signal}). ${PARTIAL_CHANGES_MAY_REMAIN}`,
      stderr: `${result.stderr ?? ""}${result.stdout ?? ""}`,
    };
  }
  if (result.status !== 0) {
    return {
      ok: false,
      message: `${pm} ${args.join(" ")} failed (exit ${result.status ?? "?"})`,
      stderr: `${result.stderr ?? ""}${result.stdout ?? ""}`,
    };
  }
  return { ok: true };
}

/** True when projectRoot is a pnpm workspace root (pnpm-workspace.yaml present). */
export function isPnpmWorkspaceRoot(projectRoot: string): boolean {
  return existsSync(join(projectRoot, "pnpm-workspace.yaml"));
}

/**
 * Exact native add argv for @deftai/directive-runtime@<ver> as a devDependency.
 * At a pnpm workspace root, includes -w / --workspace-root (ERR_PNPM_ADDING_TO_ROOT).
 * AC5.11 / AC14.48 / INIT-13: physically install the devDep even under NODE_ENV=production.
 */
export function buildPmExactAddArgs(
  pm: PackageManager,
  version: string,
  projectRoot: string,
): string[] {
  const spec = `${RUNTIME_PACKAGE_NAME}@${version}`;
  // --ignore-scripts: runtime postinstall only strips Windows ps1 shims; pin/wiring
  // do not require it. Avoids pnpm 10+ ERR_PNPM_IGNORED_BUILDS fail-closed on add.
  if (pm === "npm") {
    return [
      "install",
      "--save-dev",
      "--save-exact",
      "--ignore-scripts",
      "--include=dev",
      spec,
    ];
  }
  const args = [
    "add",
    "-D",
    "--save-exact",
    "--ignore-scripts",
    "--config.production=false",
  ];
  if (isPnpmWorkspaceRoot(projectRoot)) {
    args.push("-w");
  }
  args.push(spec);
  return args;
}

/** Plan-facing PM command string (must match {@link buildPmExactAddArgs}). */
export function formatPmExactAddCommand(
  pm: PackageManager,
  version: string,
  projectRoot: string,
): string {
  return `${pm} ${buildPmExactAddArgs(pm, version, projectRoot).join(" ")}`;
}

/**
 * Retired pre-split published packages collapsed into `@deftai/directive-runtime`
 * (UNIFIED package collapse / AC10.3). Strip before PM add so convert does not
 * need old triad tarballs on the registry (wave4e).
 */
export const RETIRED_DIRECTIVE_PACKAGE_NAMES = [
  LAUNCHER_PACKAGE_NAME,
  "@deftai/directive-core",
  "@deftai/directive-content",
  "@deftai/directive-types",
] as const;

/**
 * Remove pre-split `@deftai/directive` and retired triad packages from
 * package.json (AC10.3). Does not touch the lockfile or node_modules — caller
 * runs PM add next.
 */
export function removeLegacyDirectivePackages(projectRoot: string): boolean {
  const path = join(projectRoot, "package.json");
  const pkg = readJsonObject(path);
  if (pkg === null) return false;
  let removed = false;
  for (const key of ["dependencies", "devDependencies", "optionalDependencies"] as const) {
    const block = pkg[key];
    if (block === null || typeof block !== "object" || Array.isArray(block)) continue;
    const deps = block as Record<string, unknown>;
    for (const name of RETIRED_DIRECTIVE_PACKAGE_NAMES) {
      if (!(name in deps)) continue;
      delete deps[name];
      removed = true;
    }
    if (Object.keys(deps).length === 0) {
      delete pkg[key];
    }
  }
  if (!removed) return false;
  writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`);
  return true;
}

/**
 * @deprecated Prefer {@link removeLegacyDirectivePackages} (also strips triad).
 * Kept as an alias for call sites that only named the launcher pin historically.
 */
export function removeLegacyDirectivePin(projectRoot: string): boolean {
  return removeLegacyDirectivePackages(projectRoot);
}

/**
 * Exact native add of @deftai/directive-runtime@<ver> as a devDependency (INIT-13).
 * Portable spawn: shell:true on win32 (#5383).
 * Signals → exit-path interruption (AC5.15 / AC14.56).
 */
export function runPmExactAdd(options: PmAddOptions): PmAddResult {
  const { projectRoot, pm, version } = options;
  const args = buildPmExactAddArgs(pm, version, projectRoot);
  const result = spawnSync(pm, args, {
    cwd: projectRoot,
    env: options.env ?? process.env,
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  return interpretPmSpawnResult(pm, args, result);
}

export interface PmRemoveOptions {
  readonly projectRoot: string;
  readonly pm: PackageManager;
  readonly packageName: string;
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * Native remove argv for a dependency (AC11.6). At a pnpm workspace root,
 * includes -w / --workspace-root.
 */
export function buildPmRemoveArgs(
  pm: PackageManager,
  packageName: string,
  projectRoot: string,
): string[] {
  if (pm === "npm") {
    return ["uninstall", "--save-dev", packageName];
  }
  const args = ["remove", "-D"];
  if (isPnpmWorkspaceRoot(projectRoot)) {
    args.push("-w");
  }
  args.push(packageName);
  return args;
}

export function formatPmRemoveCommand(
  pm: PackageManager,
  packageName: string,
  projectRoot: string,
): string {
  return `${pm} ${buildPmRemoveArgs(pm, packageName, projectRoot).join(" ")}`;
}

/** Native remove of a dependency through the package manager (AC11.6). */
export function runPmRemove(options: PmRemoveOptions): PmAddResult {
  const { projectRoot, pm, packageName } = options;
  const args = buildPmRemoveArgs(pm, packageName, projectRoot);
  const result = spawnSync(pm, args, {
    cwd: projectRoot,
    env: options.env ?? process.env,
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  return interpretPmSpawnResult(pm, args, result);
}
