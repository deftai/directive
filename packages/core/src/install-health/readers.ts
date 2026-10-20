/**
 * Pure filesystem readers for in-sync predicates.
 * Seams keep unit tests off the real disk when needed; default uses node:fs.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  GENERATION_REL,
  READINESS_DIR_REL,
  RUNTIME_PIN_PACKAGE,
  readinessFileName,
} from "./constants.js";
import type { MinimalGenerationSetup } from "./types.js";

const BARE_SEMVER_RE = /^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$/;

export interface FsSeams {
  readonly isFile?: (p: string) => boolean;
  readonly readText?: (p: string) => string | null;
}

function defaultIsFile(p: string): boolean {
  try {
    return existsSync(p);
  } catch {
    return false;
  }
}

function defaultReadText(p: string): string | null {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

function resolveSeams(seams: FsSeams = {}): {
  isFile: (p: string) => boolean;
  readText: (p: string) => string | null;
} {
  return {
    isFile: seams.isFile ?? defaultIsFile,
    readText: seams.readText ?? defaultReadText,
  };
}

export function isExactSemver(version: string | null | undefined): boolean {
  if (typeof version !== "string") return false;
  return BARE_SEMVER_RE.test(version.trim().replace(/^v/i, ""));
}

export function normalizeVersion(version: string): string {
  return version.trim().replace(/^v/i, "");
}

function readJsonObject(
  path: string,
  seams: ReturnType<typeof resolveSeams>,
): Record<string, unknown> | null {
  if (!seams.isFile(path)) return null;
  const text = seams.readText(path);
  if (text === null) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function dependencySpec(pkg: Record<string, unknown>, name: string): string | null {
  for (const block of ["devDependencies", "dependencies"] as const) {
    const deps = pkg[block];
    if (typeof deps === "object" && deps !== null && !Array.isArray(deps)) {
      const spec = (deps as Record<string, unknown>)[name];
      if (typeof spec === "string" && spec.trim().length > 0) {
        return spec.trim();
      }
    }
  }
  return null;
}

export interface RuntimePinRead {
  readonly pinVersion: string | null;
  readonly rawSpec: string | null;
  readonly nonExact: boolean;
}

/**
 * Read the exact `@deftai/directive-runtime` pin from package.json.
 * Primary target architecture pin (UNIFIED). Legacy `@deftai/directive` is
 * not treated as the modern pin here.
 */
export function readRuntimePin(projectRoot: string, seams: FsSeams = {}): RuntimePinRead {
  const s = resolveSeams(seams);
  const pkg = readJsonObject(join(projectRoot, "package.json"), s);
  if (pkg === null) {
    return { pinVersion: null, rawSpec: null, nonExact: false };
  }
  const rawSpec = dependencySpec(pkg, RUNTIME_PIN_PACKAGE);
  if (rawSpec === null) {
    return { pinVersion: null, rawSpec: null, nonExact: false };
  }
  if (!isExactSemver(rawSpec)) {
    return { pinVersion: null, rawSpec, nonExact: true };
  }
  return { pinVersion: normalizeVersion(rawSpec), rawSpec, nonExact: false };
}

/**
 * Read installed runtime version from node_modules/@deftai/directive-runtime/package.json.
 */
export function readInstalledRuntimeVersion(
  projectRoot: string,
  seams: FsSeams = {},
): string | null {
  const s = resolveSeams(seams);
  const pkg = readJsonObject(
    join(projectRoot, "node_modules", "@deftai", "directive-runtime", "package.json"),
    s,
  );
  if (pkg === null) return null;
  const version = pkg.version;
  if (typeof version !== "string" || !isExactSemver(version)) return null;
  return normalizeVersion(version);
}

function readNpmLockVersion(
  projectRoot: string,
  s: ReturnType<typeof resolveSeams>,
): string | null {
  const lock = readJsonObject(join(projectRoot, "package-lock.json"), s);
  if (lock === null) return null;
  const packages = lock.packages;
  if (typeof packages === "object" && packages !== null && !Array.isArray(packages)) {
    const entry = (packages as Record<string, unknown>)[`node_modules/${RUNTIME_PIN_PACKAGE}`];
    if (typeof entry === "object" && entry !== null && !Array.isArray(entry)) {
      const version = (entry as Record<string, unknown>).version;
      if (typeof version === "string" && isExactSemver(version)) {
        return normalizeVersion(version);
      }
    }
  }
  // lockfileVersion 1 nested shape
  const deps = lock.dependencies;
  if (typeof deps === "object" && deps !== null && !Array.isArray(deps)) {
    const entry = (deps as Record<string, unknown>)[RUNTIME_PIN_PACKAGE];
    if (typeof entry === "object" && entry !== null && !Array.isArray(entry)) {
      const version = (entry as Record<string, unknown>).version;
      if (typeof version === "string" && isExactSemver(version)) {
        return normalizeVersion(version);
      }
    }
  }
  return null;
}

function readPnpmLockVersion(
  projectRoot: string,
  s: ReturnType<typeof resolveSeams>,
): string | null {
  const path = join(projectRoot, "pnpm-lock.yaml");
  if (!s.isFile(path)) return null;
  const text = s.readText(path);
  if (text === null) return null;

  // Prefer importers..devDependencies.'@deftai/directive-runtime'.version
  const importerBlock = text.match(
    new RegExp(
      `['"]?${RUNTIME_PIN_PACKAGE.replace("/", "\\/")}['"]?:\\s*\\n\\s+specifier:[^\\n]+\\n\\s+version:\\s*([^\\s\\n]+)`,
    ),
  );
  if (importerBlock?.[1] && isExactSemver(importerBlock[1])) {
    return normalizeVersion(importerBlock[1]);
  }

  // packages: '@deftai/directive-runtime@1.2.3':
  const pkgKey = text.match(
    new RegExp(
      `['"]${RUNTIME_PIN_PACKAGE.replace("/", "\\/")}@(\\d+\\.\\d+\\.\\d+(?:[-+][0-9A-Za-z.-]+)?)['"]\\s*:`,
    ),
  );
  if (pkgKey?.[1] && isExactSemver(pkgKey[1])) {
    return normalizeVersion(pkgKey[1]);
  }

  return null;
}

export interface LockfileVersionRead {
  readonly version: string | null;
  readonly kind: "npm" | "pnpm" | "absent";
}

/** Read the runtime version recorded in the project's lockfile (npm or pnpm). */
export function readLockfileRuntimeVersion(
  projectRoot: string,
  seams: FsSeams = {},
): LockfileVersionRead {
  const s = resolveSeams(seams);
  if (s.isFile(join(projectRoot, "pnpm-lock.yaml"))) {
    return { version: readPnpmLockVersion(projectRoot, s), kind: "pnpm" };
  }
  if (s.isFile(join(projectRoot, "package-lock.json"))) {
    return { version: readNpmLockVersion(projectRoot, s), kind: "npm" };
  }
  return { version: null, kind: "absent" };
}

/**
 * Parse minimal generation setup record.
 * Only `runtimeVersion` is required for 1a; other keys are the 1b extension point.
 */
export function parseMinimalGeneration(raw: unknown): MinimalGenerationSetup | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  const runtimeVersion = rec.runtimeVersion;
  if (typeof runtimeVersion !== "string" || !isExactSemver(runtimeVersion)) {
    return null;
  }
  return { ...rec, runtimeVersion: normalizeVersion(runtimeVersion) };
}

export function readGenerationSetup(
  projectRoot: string,
  seams: FsSeams = {},
): MinimalGenerationSetup | null {
  const s = resolveSeams(seams);
  const obj = readJsonObject(join(projectRoot, GENERATION_REL), s);
  if (obj === null) return null;
  return parseMinimalGeneration(obj);
}

export interface ReadinessRead {
  readonly present: boolean;
  readonly versionMatch: boolean;
  readonly path: string;
  readonly bodyVersion: string | null;
}

/**
 * AC8.6 readiness: presence of wiring-ready.<V>.json and optional body version match.
 * Does not write.
 */
export function readReadiness(
  projectRoot: string,
  runtimeVersion: string,
  seams: FsSeams = {},
): ReadinessRead {
  const s = resolveSeams(seams);
  const path = join(projectRoot, READINESS_DIR_REL, readinessFileName(runtimeVersion));
  if (!s.isFile(path)) {
    return { present: false, versionMatch: false, path, bodyVersion: null };
  }
  const obj = readJsonObject(path, s);
  if (obj === null) {
    // File present but unreadable — treat as invalid (stale).
    return { present: true, versionMatch: false, path, bodyVersion: null };
  }
  const bodyVersion =
    typeof obj.runtimeVersion === "string" && isExactSemver(obj.runtimeVersion)
      ? normalizeVersion(obj.runtimeVersion)
      : null;
  // Filename encodes V; body version, when present, must agree. Absent body version
  // is accepted when the filename already matches (minimal marker).
  const versionMatch = bodyVersion === null || bodyVersion === runtimeVersion;
  return { present: true, versionMatch, path, bodyVersion };
}

/** Read xbrief schema version from PROJECT-DEFINITION when present. */
export function readProjectXbriefSchemaVersion(
  projectRoot: string,
  seams: FsSeams = {},
): string | null {
  const s = resolveSeams(seams);
  const path = join(projectRoot, "xbrief", "PROJECT-DEFINITION.xbrief.json");
  const obj = readJsonObject(path, s);
  if (obj === null) return null;
  const info = obj.xBRIEFInfo;
  if (typeof info === "object" && info !== null && !Array.isArray(info)) {
    const version = (info as Record<string, unknown>).version;
    if (typeof version === "string" && version.trim()) {
      return version.trim();
    }
  }
  return null;
}

export function compareSchemaVersion(a: string, b: string): -1 | 0 | 1 | null {
  const pa = a.split(".").map((p) => Number(p));
  const pb = b.split(".").map((p) => Number(p));
  if (pa.some((n) => !Number.isFinite(n)) || pb.some((n) => !Number.isFinite(n))) {
    return null;
  }
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const av = pa[i] ?? 0;
    const bv = pb[i] ?? 0;
    if (av > bv) return 1;
    if (av < bv) return -1;
  }
  return 0;
}
