/**
 * bridge-drift.ts -- Tier-1 cross-surface drift gate for the legacy Go-installer
 * bridge (#1912).
 *
 * Asserts that every surface which STATES the frozen bridge version reads the
 * Tier-0 SoT (`lastGoInstaller`) instead of hardcoding a competing number.
 * Modeled on the #1308/#1309 freshness/propagation gates: surfaces opt in to the
 * contract via a stable SENTINEL marker, and the gate enforces that no marked
 * line outside the SoT module carries a hardcoded Go-installer semver.
 *
 * The contract (sentinel-gated so it is zero-false-positive across the many
 * unrelated docs/code files that legitimately mention "deft-install"):
 *
 *   - Any surface that states the frozen bridge version puts the marker token
 *     `deft:last-go-installer` on the stating line and references the SoT
 *     (`lastGoInstaller()` / `LAST_GO_INSTALLER`) -- NOT an inline number.
 *   - A marked line that ALSO contains a hardcoded `vX.Y.Z` literal is drift:
 *     the version must come from the SoT, not be restated.
 *   - `sot.ts` is the sole exemption -- it is where the literal legitimately
 *     lives -- and is never scanned as a surface.
 *
 * Designed to pass whether or not story P's UPGRADING/doctor surfaces exist yet:
 * a registered surface that is absent is simply skipped (the assertion is "no
 * surface hardcodes", not "surface X must exist").
 *
 * Three-state exit (mirrors verify-source/content-manifest + scm-boundary):
 *   0 -- clean: no marked surface hardcodes a Go-installer version.
 *   1 -- drift: a marked surface line hardcodes a competing version.
 *   2 -- config error: the SoT module is missing or no longer exposes the
 *        reader API + sentinel anchor (the contract has no anchor to enforce).
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { lastGoInstaller } from "./sot.js";

const EXIT_OK = 0;
const EXIT_DRIFT = 1;
const EXIT_CONFIG_ERROR = 2;

/** Stable marker a surface puts on the line that states the bridge version. */
export const BRIDGE_SENTINEL = "deft:last-go-installer";

/** Repo-relative path to the Tier-0 SoT module (the sole literal home). */
export const SOT_RELATIVE_PATH = "packages/core/src/legacy-bridge/sot.ts";

/**
 * Default surface registry: files that document or consume the bridge version.
 * Scanned only when present; absence is a pass. The SoT module and `*.test.ts`
 * fixtures are never scanned (they may legitimately hold version literals).
 * Story P's UPGRADING/doctor surfaces are listed so the gate covers them the
 * moment they opt in via the sentinel -- but their absence today is a clean pass.
 */
export const DEFAULT_DRIFT_SURFACES: readonly string[] = [
  "UPGRADING.md",
  "content/UPGRADING.md",
  "packages/core/src/doctor/constants.ts",
  "packages/core/src/legacy-bridge/freeze-gate.ts",
  "packages/core/src/legacy-bridge/bridge-drift.ts",
];

/**
 * Matches a hardcoded Go-installer-style semver literal (tolerates a leading `v`).
 * The digit runs are length-bounded (`{1,9}`) rather than unbounded (`+`) on
 * purpose: a real semver component is never 10+ digits, and the bound removes the
 * quadratic-backtracking ReDoS class (`js/polynomial-redos`) that an unbounded
 * `\d+\.\d+\.\d+` exhibits when `.test()` runs over uncontrolled file input.
 */
const SEMVER_LITERAL = /v?\d{1,9}\.\d{1,9}\.\d{1,9}/;

export interface DriftFinding {
  readonly path: string;
  readonly line: number;
  readonly context: string;
}

/** Scan one surface's source for marked lines that hardcode a version literal. */
export function scanSurfaceForDrift(relPath: string, source: string): DriftFinding[] {
  const findings: DriftFinding[] = [];
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (line.includes(BRIDGE_SENTINEL) && SEMVER_LITERAL.test(line)) {
      const ctx = line.trim();
      findings.push({
        path: relPath,
        line: i + 1,
        context: ctx.length <= 120 ? ctx : `${ctx.slice(0, 117)}...`,
      });
    }
  }
  return findings;
}

export interface DriftResult {
  readonly code: 0 | 1 | 2;
  readonly message: string;
  readonly stream: "stdout" | "stderr";
  readonly findings: readonly DriftFinding[];
}

export interface DriftEvaluateOptions {
  /** Test seam: override the surface registry. */
  readonly surfaces?: readonly string[];
  /** Test seam: override the SoT module path. */
  readonly sotPath?: string;
  /** Test seam: override the SoT value for the clean-state message. */
  readonly pinned?: string | null;
}

function isReadableFile(full: string): boolean {
  try {
    return statSync(full).isFile();
  } catch {
    return false;
  }
}

/**
 * Evaluate the cross-surface drift gate. Reads the SoT module (config anchor)
 * plus each existing registered surface.
 */
export function evaluateBridgeDrift(
  projectRoot: string,
  options: DriftEvaluateOptions = {},
): DriftResult {
  const root = resolve(projectRoot);
  const sotFull = resolve(root, options.sotPath ?? SOT_RELATIVE_PATH);

  if (!existsSync(sotFull)) {
    return {
      code: EXIT_CONFIG_ERROR,
      findings: [],
      message:
        `Error: Tier-0 SoT module not found at ${options.sotPath ?? SOT_RELATIVE_PATH}; ` +
        "the drift contract has no anchor to enforce.",
      stream: "stderr",
    };
  }

  let sotSource: string;
  try {
    sotSource = readFileSync(sotFull, { encoding: "utf8" });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      code: EXIT_CONFIG_ERROR,
      findings: [],
      message: `Error: failed to read SoT module ${sotFull}: ${msg}`,
      stream: "stderr",
    };
  }

  const anchorOk =
    sotSource.includes("lastGoInstaller") &&
    sotSource.includes("isFrozen") &&
    sotSource.includes(BRIDGE_SENTINEL);
  if (!anchorOk) {
    return {
      code: EXIT_CONFIG_ERROR,
      findings: [],
      message:
        `Error: SoT module ${options.sotPath ?? SOT_RELATIVE_PATH} no longer exposes the reader API ` +
        `(lastGoInstaller / isFrozen) and sentinel anchor (${BRIDGE_SENTINEL}); the drift contract is broken.`,
      stream: "stderr",
    };
  }

  const surfaces = options.surfaces ?? DEFAULT_DRIFT_SURFACES;
  const sotRelNormalized = (options.sotPath ?? SOT_RELATIVE_PATH).replace(/\\/g, "/");
  const findings: DriftFinding[] = [];
  let scanned = 0;

  for (const rel of surfaces) {
    const relNorm = rel.replace(/\\/g, "/");
    if (relNorm === sotRelNormalized || relNorm.endsWith(".test.ts")) {
      continue;
    }
    const full = resolve(root, rel);
    if (!isReadableFile(full)) {
      continue;
    }
    let source: string;
    try {
      source = readFileSync(full, { encoding: "utf8" });
    } catch {
      continue;
    }
    scanned += 1;
    findings.push(...scanSurfaceForDrift(relNorm, source));
  }

  if (findings.length > 0) {
    const header =
      `FAIL: ${findings.length} bridge-version drift finding(s) -- a marked surface hardcodes a ` +
      "Go-installer version instead of reading the Tier-0 SoT (lastGoInstaller).\n" +
      `  Fix: replace the inline version next to the \`${BRIDGE_SENTINEL}\` marker with a reference to ` +
      "lastGoInstaller() / LAST_GO_INSTALLER (the SoT is the single source).";
    const body = findings.map((f) => `  ${f.path}:${f.line}  ${f.context}`).join("\n");
    return { code: EXIT_DRIFT, findings, message: `${header}\n${body}`, stream: "stderr" };
  }

  const pinned = options.pinned !== undefined ? options.pinned : lastGoInstaller();
  const state = pinned === null ? "null (unfrozen)" : pinned;
  return {
    code: EXIT_OK,
    findings: [],
    message:
      `OK: ${scanned} bridge-version surface(s) scanned; every reference reads the Tier-0 SoT ` +
      `(lastGoInstaller = ${state}). No hardcoded competing version.`,
    stream: "stdout",
  };
}
