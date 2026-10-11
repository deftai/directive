/**
 * Package-manager selection and exact-add helpers for the launcher (AC5.7 / INIT-13).
 * Node builtins + child_process only — no runtime/core dependency.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { LAUNCHER_PACKAGE_NAME, RUNTIME_PACKAGE_NAME } from "./constants.js";

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

function readPackageManagerField(projectRoot: string): PackageManagerFieldResult {
  const pkg = readJsonObject(join(projectRoot, "package.json"));
  if (pkg === null) return { kind: "absent" };
  const raw = pkg.packageManager;
  if (typeof raw !== "string" || raw.trim() === "") return { kind: "absent" };
  if (raw.startsWith("npm@") || raw === "npm") return { kind: "supported", pm: "npm" };
  if (raw.startsWith("pnpm@") || raw === "pnpm") return { kind: "supported", pm: "pnpm" };
  if (raw.startsWith("yarn@") || raw === "yarn") return { kind: "unsupported", name: "Yarn" };
  if (raw.startsWith("bun@") || raw === "bun") return { kind: "unsupported", name: "Bun" };
  const name = raw.split("@")[0]?.trim() || raw;
  return { kind: "unsupported", name };
}

/**
 * Select npm or pnpm from lockfile / packageManager / explicit flag.
 * Refuses yarn and bun (AC5.7), including an explicit packageManager field
 * with no lockfile (do not fall through to npm).
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

  const field = readPackageManagerField(projectRoot);
  if (field.kind === "unsupported") {
    return {
      ok: false,
      message: `${field.name} projects are not supported (AC5.7). Use npm or pnpm.`,
    };
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
  const fieldPm = field.kind === "supported" ? field.pm : null;

  if (hasPnpmLock && hasNpmLock) {
    if (flag === "npm" || flag === "pnpm") {
      return { ok: true, pm: flag, evidence: `--package-manager ${flag} (both lockfiles present)` };
    }
    if (fieldPm !== null) {
      return {
        ok: true,
        pm: fieldPm,
        evidence: `packageManager field (${fieldPm}) with both lockfiles`,
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
  if (fieldPm !== null) {
    return { ok: true, pm: fieldPm, evidence: `packageManager field (${fieldPm})` };
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
  | { readonly ok: false; readonly message: string; readonly stderr: string };

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
 * Remove a supported pre-split `@deftai/directive` project pin from package.json
 * (AC10.3). Does not touch the lockfile or node_modules — caller runs PM add next.
 */
export function removeLegacyDirectivePin(projectRoot: string): boolean {
  const path = join(projectRoot, "package.json");
  const pkg = readJsonObject(path);
  if (pkg === null) return false;
  let removed = false;
  for (const key of ["dependencies", "devDependencies", "optionalDependencies"] as const) {
    const block = pkg[key];
    if (block === null || typeof block !== "object" || Array.isArray(block)) continue;
    const deps = block as Record<string, unknown>;
    if (!(LAUNCHER_PACKAGE_NAME in deps)) continue;
    delete deps[LAUNCHER_PACKAGE_NAME];
    removed = true;
    if (Object.keys(deps).length === 0) {
      delete pkg[key];
    }
  }
  if (!removed) return false;
  writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`);
  return true;
}

/**
 * Exact native add of @deftai/directive-runtime@<ver> as a devDependency (INIT-13).
 * Portable spawn: shell:true on win32 (#5383).
 */
export function runPmExactAdd(options: PmAddOptions): PmAddResult {
  const { projectRoot, pm, version } = options;
  const args = buildPmExactAddArgs(pm, version, projectRoot);
  const bin = pm;
  const result = spawnSync(bin, args, {
    cwd: projectRoot,
    env: options.env ?? process.env,
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  if (result.error) {
    return {
      ok: false,
      message: `Failed to spawn ${pm}: ${result.error.message}`,
      stderr: String(result.error),
    };
  }
  if (result.status !== 0) {
    return {
      ok: false,
      message: `${pm} ${args.join(" ")} failed (exit ${result.status ?? "?"})`,
      stderr: (result.stderr ?? "") + (result.stdout ?? ""),
    };
  }
  return { ok: true };
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
  if (result.error) {
    return {
      ok: false,
      message: `Failed to spawn ${pm}: ${result.error.message}`,
      stderr: String(result.error),
    };
  }
  if (result.status !== 0) {
    return {
      ok: false,
      message: `${pm} ${args.join(" ")} failed (exit ${result.status ?? "?"})`,
      stderr: (result.stderr ?? "") + (result.stdout ?? ""),
    };
  }
  return { ok: true };
}
