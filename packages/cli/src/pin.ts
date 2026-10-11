/**
 * Read pin + installed runtime metadata without loading runtime code (AC3.9).
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  CONTRACT_PACKAGE_JSON_KEY,
  LAUNCHER_MAX_SUPPORTED_CONTRACT,
  LAUNCHER_PACKAGE_NAME,
  RUNTIME_PACKAGE_NAME,
} from "./constants.js";

export interface RuntimeMeta {
  readonly version: string;
  readonly contract: number;
  readonly packageJsonPath: string;
  readonly entryPath: string;
}

export type PinKind = "none" | "exact" | "range" | "legacy_directive" | "invalid";

export interface PinInfo {
  readonly kind: PinKind;
  readonly raw: string | null;
  /** Exact version when kind === "exact". */
  readonly version: string | null;
}

export interface ProjectInstallState {
  readonly pin: PinInfo;
  readonly installed: RuntimeMeta | null;
  readonly pinMatchesInstalled: boolean;
  readonly contractSupported: boolean;
  /** Pre-split exact @deftai/directive pin without runtime pin. */
  readonly oldStyle: boolean;
}

function readJsonObject(path: string): Record<string, unknown> | null {
  try {
    const raw = readFileSync(path, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function depMap(pkg: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of ["dependencies", "devDependencies", "optionalDependencies"] as const) {
    const block = pkg[key];
    if (block !== null && typeof block === "object" && !Array.isArray(block)) {
      for (const [name, ver] of Object.entries(block as Record<string, unknown>)) {
        if (typeof ver === "string") out[name] = ver;
      }
    }
  }
  return out;
}

/** Exact SemVer or exact with leading "="; ranges/tags are not exact. */
export function classifyPinVersion(raw: string | null | undefined): PinInfo {
  if (raw === null || raw === undefined || raw.length === 0) {
    return { kind: "none", raw: null, version: null };
  }
  const trimmed = raw.trim();
  const exact = trimmed.startsWith("=") ? trimmed.slice(1) : trimmed;
  // Plain X.Y.Z or X.Y.Z-prerelease — no ^ ~ > < * x || workspace
  if (/^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$/.test(exact)) {
    return { kind: "exact", raw: trimmed, version: exact };
  }
  if (/^[~^><*x]|workspace:|file:|npm:|\|\|/.test(trimmed) || trimmed.includes(" ")) {
    return { kind: "range", raw: trimmed, version: null };
  }
  return { kind: "invalid", raw: trimmed, version: null };
}

function isRegularFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Copied-core installation evidence (AC10.1 / AC10.5).
 * Directory existence alone is insufficient; require VERSION, main.md, or a
 * deposit package.json (`deftConsumerDeposit: true`).
 */
export function hasCopiedCoreEvidence(projectRoot: string): boolean {
  const core = join(projectRoot, ".deft", "core");
  if (isRegularFile(join(core, "VERSION"))) return true;
  if (isRegularFile(join(core, "main.md"))) return true;
  const pkgPath = join(core, "package.json");
  if (!isRegularFile(pkgPath)) return false;
  const pkg = readJsonObject(pkgPath);
  return pkg !== null && pkg.deftConsumerDeposit === true;
}

export function readPin(projectRoot: string): PinInfo & { oldStyle: boolean } {
  const pkgPath = join(projectRoot, "package.json");
  const pkg = readJsonObject(pkgPath);
  if (pkg === null) {
    return { kind: "none", raw: null, version: null, oldStyle: false };
  }
  const deps = depMap(pkg);
  const runtimeRaw = deps[RUNTIME_PACKAGE_NAME];
  if (runtimeRaw !== undefined) {
    return { ...classifyPinVersion(runtimeRaw), oldStyle: false };
  }
  // Supported legacy: exact pre-split pin + copied-core evidence (AC10 / §A6.7).
  // Launcher-only dep is not an OVPR pin (AC14.51) — first install proceeds.
  const legacy = deps[LAUNCHER_PACKAGE_NAME];
  if (legacy !== undefined) {
    const classified = classifyPinVersion(legacy);
    if (classified.kind === "exact" && hasCopiedCoreEvidence(projectRoot)) {
      return { ...classified, oldStyle: true };
    }
    return { kind: "none", raw: null, version: null, oldStyle: false };
  }
  return { kind: "none", raw: null, version: null, oldStyle: false };
}

/**
 * Read installed runtime version + contract from package.json only (no code load).
 */
export function readInstalledRuntime(projectRoot: string): RuntimeMeta | null {
  const packageJsonPath = join(
    projectRoot,
    "node_modules",
    ...RUNTIME_PACKAGE_NAME.split("/"),
    "package.json",
  );
  if (!existsSync(packageJsonPath)) return null;
  const pkg = readJsonObject(packageJsonPath);
  if (pkg === null) return null;
  const version = pkg.version;
  if (typeof version !== "string" || version.length === 0) return null;
  const directive = pkg[CONTRACT_PACKAGE_JSON_KEY];
  if (directive === null || typeof directive !== "object" || Array.isArray(directive)) {
    return null;
  }
  const contract = (directive as { contract?: unknown }).contract;
  if (typeof contract !== "number" || !Number.isInteger(contract) || contract < 1) {
    return null;
  }
  const entryPath = join(
    projectRoot,
    "node_modules",
    ...RUNTIME_PACKAGE_NAME.split("/"),
    "dist",
    "bin.js",
  );
  return { version, contract, packageJsonPath, entryPath };
}

export function isContractSupported(runtimeContract: number): boolean {
  return (
    Number.isInteger(runtimeContract) &&
    runtimeContract >= 1 &&
    runtimeContract <= LAUNCHER_MAX_SUPPORTED_CONTRACT
  );
}

export function readProjectInstallState(projectRoot: string): ProjectInstallState {
  const pinRead = readPin(projectRoot);
  const installed = readInstalledRuntime(projectRoot);
  const pinMatchesInstalled =
    pinRead.kind === "exact" &&
    pinRead.version !== null &&
    installed !== null &&
    installed.version === pinRead.version;
  const contractSupported =
    installed === null ? true : isContractSupported(installed.contract);
  return {
    pin: pinRead,
    installed,
    pinMatchesInstalled,
    contractSupported,
    oldStyle: pinRead.oldStyle,
  };
}
