/**
 * Package-manager selection and exact-add helpers for the launcher (AC5.7 / INIT-13).
 * Node builtins + child_process only — no runtime/core dependency.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { RUNTIME_PACKAGE_NAME } from "./constants.js";

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

function packageManagerField(projectRoot: string): PackageManager | null {
  const pkg = readJsonObject(join(projectRoot, "package.json"));
  if (pkg === null) return null;
  const raw = pkg.packageManager;
  if (typeof raw !== "string") return null;
  if (raw.startsWith("npm@") || raw === "npm") return "npm";
  if (raw.startsWith("pnpm@") || raw === "pnpm") return "pnpm";
  if (raw.startsWith("yarn@") || raw === "yarn") return null;
  if (raw.startsWith("bun@") || raw === "bun") return null;
  return null;
}

/**
 * Select npm or pnpm from lockfile / packageManager / explicit flag.
 * Refuses yarn and bun (AC5.7).
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
  const field = packageManagerField(projectRoot);

  if (hasPnpmLock && hasNpmLock) {
    if (flag === "npm" || flag === "pnpm") {
      return { ok: true, pm: flag, evidence: `--package-manager ${flag} (both lockfiles present)` };
    }
    if (field !== null) {
      return { ok: true, pm: field, evidence: `packageManager field (${field}) with both lockfiles` };
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
  if (field !== null) {
    return { ok: true, pm: field, evidence: `packageManager field (${field})` };
  }

  // Fresh project: default npm (evidence disclosed in plan).
  return { ok: true, pm: "npm", evidence: "default (no lockfile / packageManager)" };
}

/** True when the lockfile consistently records the exact runtime pin (AC6.10). */
export function lockfileRecordsExactPin(projectRoot: string, exactVersion: string): boolean {
  const pnpmLock = join(projectRoot, "pnpm-lock.yaml");
  if (existsSync(pnpmLock)) {
    try {
      const text = readFileSync(pnpmLock, "utf8");
      const importer = text.match(
        new RegExp(
          `['"]?${RUNTIME_PACKAGE_NAME.replace("/", "\\/")}['"]?:\\s*\\n\\s+specifier:[^\\n]+\\n\\s+version:\\s*([^\\s\\n]+)`,
        ),
      );
      if (importer?.[1] && importer[1] === exactVersion) return true;
      const pkgKey = text.match(
        new RegExp(
          `['"]${RUNTIME_PACKAGE_NAME.replace("/", "\\/")}@${exactVersion.replace(
            /[.*+?^${}()|[\]\\]/g,
            "\\$&",
          )}['"]\\s*:`,
        ),
      );
      return pkgKey !== null;
    } catch {
      return false;
    }
  }
  const npmLock = join(projectRoot, "package-lock.json");
  if (existsSync(npmLock)) {
    const lock = readJsonObject(npmLock);
    if (lock === null) return false;
    const packages = lock.packages;
    if (typeof packages === "object" && packages !== null && !Array.isArray(packages)) {
      const entry = (packages as Record<string, unknown>)[
        `node_modules/${RUNTIME_PACKAGE_NAME}`
      ];
      if (typeof entry === "object" && entry !== null && !Array.isArray(entry)) {
        return (entry as { version?: unknown }).version === exactVersion;
      }
    }
    const deps = lock.dependencies;
    if (typeof deps === "object" && deps !== null && !Array.isArray(deps)) {
      const entry = (deps as Record<string, unknown>)[RUNTIME_PACKAGE_NAME];
      if (typeof entry === "object" && entry !== null && !Array.isArray(entry)) {
        return (entry as { version?: unknown }).version === exactVersion;
      }
    }
    return false;
  }
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

/**
 * Exact native add of @deftai/directive-runtime@<ver> as a devDependency (INIT-13).
 * Portable spawn: shell:true on win32 (#5383).
 */
export function runPmExactAdd(options: PmAddOptions): PmAddResult {
  const { projectRoot, pm, version } = options;
  const spec = `${RUNTIME_PACKAGE_NAME}@${version}`;
  const args =
    pm === "npm"
      ? ["install", "--save-dev", "--save-exact", spec]
      : ["add", "-D", spec];
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
