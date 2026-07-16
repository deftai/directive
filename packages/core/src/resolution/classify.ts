/**
 * Orthogonal fact-set classifier for the resolution spine (#2264 / epic #2203).
 *
 * `classify()` returns a flat, independent fact-set — never a single collapsed
 * enum. `plan()` owns the collapse into one recommended action, so there is
 * exactly one precedence table in the system.
 *
 * It REUSES the existing detectors rather than re-implementing them:
 *  - pre-cutover artifacts    -> `../vbrief-validate/precutover.ts`
 *  - managed-section sha      -> `../platform/agents-md.ts::parseManagedSectionAttrs`
 *  - deposited payload version-> `../doctor/manifest.ts` + `../init-deposit/constants.ts`
 *  - committed pin            -> `./pin.ts`
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ResolutionFacts } from "@deftai/directive-types";
import { locateManifest, manifestTagToVersion, parseInstallManifest } from "../doctor/manifest.js";
import { readCorePackageVersion } from "../engine-version.js";
import { CANONICAL_INSTALL_ROOT } from "../init-deposit/constants.js";
import { extractManagedSection, parseManagedSectionAttrs } from "../platform/agents-md.js";
import { ENV_VAR } from "../platform/constants.js";
import { detectPreCutover } from "../vbrief-validate/precutover.js";
import { resolveCommandOnPath, spawnCommandText } from "../verify-env/command-spawn.js";
import { readPin } from "./pin.js";

/** Result of probing whether an engine is reachable in the execution environment. */
export interface EngineProbeResult {
  readonly reachable: boolean;
  readonly version: string | null;
}

export interface ClassifySeams {
  readonly isFile?: (p: string) => boolean;
  readonly isDir?: (p: string) => boolean;
  readonly readText?: (p: string) => string | null;
  /**
   * Probe for a reachable engine IN THE ENVIRONMENT THE CALLER IS RUNNING IN.
   * Injected so classification is deterministic + offline in tests; the default
   * shells out to the `directive` / `deft` CLI (the #2124 execution-env probe).
   */
  readonly engineProbe?: () => EngineProbeResult;
  /** Pre-cutover probe; defaults to the shared `detectPreCutover` detector. */
  readonly preCutoverProbe?: (cwd: string) => boolean;
}

/** App-source markers used for the `hasAppCode` heuristic. */
const APP_CODE_MARKERS: readonly string[] = [
  "package.json",
  "pyproject.toml",
  "go.mod",
  "Cargo.toml",
  "pom.xml",
  "build.gradle",
  "Gemfile",
  "src",
];

const SEMVER_IN_TEXT_RE = /(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/;

function defaultIsFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function defaultIsDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function defaultReadText(p: string): string | null {
  try {
    if (!existsSync(p)) return null;
    return readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

function parseVersionFromOutput(out: string): string | null {
  const match = SEMVER_IN_TEXT_RE.exec(out);
  return match?.[1] ?? null;
}

/**
 * Prefer the engine version from the already-loaded core package when doctor /
 * update are executing inside `@deftai/directive` (#2606).
 */
function readInProcessEngineVersion(): string | null {
  const envVersion = process.env[ENV_VAR]?.trim();
  if (envVersion) {
    return parseVersionFromOutput(envVersion) ?? envVersion;
  }
  try {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json");
    if (!existsSync(pkgPath)) {
      return null;
    }
    return readCorePackageVersion();
  } catch {
    return null;
  }
}

function probeEngineVersion(binary: string): string | null {
  const resolved = resolveCommandOnPath(binary);
  const result = spawnCommandText(resolved ?? binary, ["--version"], { timeoutMs: 5000 });
  if (result.status !== 0) {
    return null;
  }
  return parseVersionFromOutput(result.stdout);
}

/** Default engine probe: in-process identity, then `directive` / `deft` on PATH. */
export function defaultEngineProbe(): EngineProbeResult {
  const inProcess = readInProcessEngineVersion();
  if (inProcess !== null) {
    return { reachable: true, version: inProcess };
  }
  for (const binary of ["directive", "deft"]) {
    const version = probeEngineVersion(binary);
    if (version !== null) {
      return { reachable: true, version };
    }
  }
  return { reachable: false, version: null };
}

function detectAppCode(
  cwd: string,
  isFile: (p: string) => boolean,
  isDir: (p: string) => boolean,
): boolean {
  return APP_CODE_MARKERS.some((marker) =>
    marker === "src" ? isDir(join(cwd, marker)) : isFile(join(cwd, marker)),
  );
}

function readManagedSection(
  cwd: string,
  readText: (p: string) => string | null,
): { hasManagedSection: boolean; managedSectionSha: string | null } {
  const text = readText(join(cwd, "AGENTS.md"));
  if (text === null) return { hasManagedSection: false, managedSectionSha: null };
  const section = extractManagedSection(text);
  if (section === null) return { hasManagedSection: false, managedSectionSha: null };
  const attrs = parseManagedSectionAttrs(section);
  return { hasManagedSection: true, managedSectionSha: attrs?.sha ?? null };
}

function readPayloadVersion(
  cwd: string,
  hasDeftCore: boolean,
  isFile: (p: string) => boolean,
  readText: (p: string) => string | null,
): string | null {
  if (!hasDeftCore) return null;
  const manifestPath = locateManifest(cwd, CANONICAL_INSTALL_ROOT, isFile);
  if (manifestPath === null) return null;
  const text = readText(manifestPath);
  if (text === null) return null;
  return manifestTagToVersion(parseInstallManifest(text));
}

/**
 * Classify a project directory into the orthogonal resolution fact-set. All I/O
 * is behind injectable seams so callers (tests, sandboxed runtimes) can supply a
 * deterministic view of the filesystem and the engine-reachability probe.
 */
export function classify(cwd: string, seams: ClassifySeams = {}): ResolutionFacts {
  const isFile = seams.isFile ?? defaultIsFile;
  const isDir = seams.isDir ?? defaultIsDir;
  const readText = seams.readText ?? defaultReadText;
  const engineProbe = seams.engineProbe ?? defaultEngineProbe;
  const preCutoverProbe =
    seams.preCutoverProbe ?? ((dir: string) => detectPreCutover(dir).preCutover);

  const hasDeftCore = isDir(join(cwd, CANONICAL_INSTALL_ROOT));
  const { hasManagedSection, managedSectionSha } = readManagedSection(cwd, readText);
  const engine = engineProbe();
  const pin = readPin(cwd, { isFile, readText });

  return {
    hasGit: isDir(join(cwd, ".git")) || isFile(join(cwd, ".git")),
    hasAppCode: detectAppCode(cwd, isFile, isDir),
    hasDeftCore,
    deftCorePayloadVersion: readPayloadVersion(cwd, hasDeftCore, isFile, readText),
    hasManagedSection,
    managedSectionSha,
    hasVbrief: isDir(join(cwd, "vbrief")),
    hasXbrief: isDir(join(cwd, "xbrief")),
    preCutoverArtifacts: preCutoverProbe(cwd),
    engineReachable: engine.reachable,
    engineVersion: engine.version,
    pinVersion: pin.pinVersion,
  };
}
