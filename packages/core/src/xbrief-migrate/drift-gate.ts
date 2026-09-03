import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  GitCommandError,
  GitNotFoundError,
  gitStagedFiles,
  gitTrackedFiles,
} from "../encoding/git.js";
import { fnmatchCase } from "../encoding/text.js";
import {
  LEGACY_ARTIFACT_DIR,
  LEGACY_ARTIFACT_SUFFIX,
  LEGACY_INFO_ROOT_KEY,
  MIGRATED_ARTIFACT_DIR,
  MIGRATED_ARTIFACT_SUFFIX,
  MIGRATED_INFO_ROOT_KEY,
  VBRIEF_VERSION,
} from "./constants.js";

/**
 * #2109 Part 2 data-plane drift gate.
 *
 * After the canonical lifecycle tree is renamed `vbrief/` -> `xbrief/` and every
 * `*.vbrief.json` artifact -> `*.xbrief.json`, this gate FAILS when a NEW
 * legacy-layout token is reintroduced into the DATA PLANE:
 *
 *   1. a tracked `*.vbrief.json` artifact path (legacy suffix), or
 *   2. a tracked file under a top-level `vbrief/` lifecycle directory, or
 *   3. a bare `x-vbrief/` reference type inside a canonical corpus artifact
 *      (`xbrief/ ** / *.xbrief.json`), or
 *   4. a legacy envelope key/version (`vBRIEFInfo` or `xBRIEFInfo` not at the
 *      current write version) on a correctly named `*.xbrief.json` outside
 *      lifecycle-folder prefixes and the built-in allowlist (#4086).
 *
 * It is a DATA-PLANE gate by construction: it only inspects artifact PATHS and
 * the JSON content of canonical `*.xbrief.json` corpus files. The sanctioned
 * back-compat SHIMS therefore never trip it:
 *
 *   - the Part 1 layout-resolver fallback (packages/core/src/layout/resolve.ts),
 *   - the EXTENSION_PREFIXES legacy `x-vbrief/` entry
 *     (packages/core/src/vbrief-validate/conformance.ts),
 *   - the #2110 migrate path (packages/core/src/xbrief-migrate/),
 *   - the #1650 legacy policy fallback,
 *
 * are TypeScript source files -- not `*.vbrief.json` artifacts, not under a
 * top-level `vbrief/` dir, and not `xbrief/ ** / *.xbrief.json` corpus files --
 * so they are outside the scanned candidate set and keep their intentional
 * "vbrief" mentions. The DATA-PLANE fixtures that legitimately retain the legacy
 * layout for back-compat regression coverage (test fixtures, the shipped
 * `content/vbrief/` surface, forensic doc templates, archived history, and the
 * framework's own `xbrief/migration/` RESULT artifacts) are explicitly
 * allowlisted below.
 */

/** Bare legacy reference-namespace prefix (kept ACCEPTED by EXTENSION_PREFIXES; forbidden in NEW corpus artifacts). */
export const LEGACY_REFERENCE_PREFIX = "x-vbrief/" as const;

/** Default allowlist: sanctioned data-plane trees that legitimately retain legacy tokens for back-compat. */
export const BUILTIN_ALLOW_LIST: readonly string[] = [
  // Vendored npm deposit (#2146): C1 flatten maps content/vbrief/* -> .deft/core/vbrief/*.
  ".deft/core/vbrief/**",
  // Shipped vBRIEF surface (#1875 C3) + conformance round-trip fixtures (#715).
  "content/vbrief/**",
  // Test fixtures exercising the legacy read path + pre-cutover migration (#2108 / #2110)
  // and this gate's own regression fixtures.
  "tests/**",
  // Forensic-research doc templates ship a `.vbrief.json` example.
  "docs/**",
  // Archived forensic / onboarding records.
  "history/**",
  // The framework's own migration RESULT artifacts may reference the legacy layout by design.
  `${MIGRATED_ARTIFACT_DIR}/migration/**`,
];

export type DriftScanMode = "all" | "staged";

export interface DriftFinding {
  readonly path: string;
  readonly kind:
    | "legacy-suffix"
    | "legacy-lifecycle-dir"
    | "legacy-reference-token"
    | "legacy-envelope-key"
    | "legacy-envelope-version";
  readonly detail: string;
}

/** Lifecycle folders whose historical v0.6 records stay historical (#4086). */
export const LIFECYCLE_FOLDER_PREFIXES: readonly string[] = [
  `${MIGRATED_ARTIFACT_DIR}/proposed/`,
  `${MIGRATED_ARTIFACT_DIR}/pending/`,
  `${MIGRATED_ARTIFACT_DIR}/active/`,
  `${MIGRATED_ARTIFACT_DIR}/completed/`,
  `${MIGRATED_ARTIFACT_DIR}/cancelled/`,
];

function isLifecycleFolderPath(relPath: string): boolean {
  return LIFECYCLE_FOLDER_PREFIXES.some((prefix) => relPath.startsWith(prefix));
}

export interface DriftEvaluateOptions {
  readonly mode?: DriftScanMode;
  readonly allowListPath?: string | null;
  readonly quiet?: boolean;
}

export interface DriftEvaluateResult {
  readonly code: 0 | 1 | 2;
  readonly findings: readonly DriftFinding[];
  readonly message: string;
  readonly stream: "stdout" | "stderr";
}

function loadAllowList(path: string | null): string[] | { error: string } {
  if (path === null) {
    return [];
  }
  if (!existsSync(path)) {
    return {
      error:
        `verify_xbrief_drift: --allow-list file not found: [Errno 2] No such file or directory: '${path}'\n` +
        "  Recovery: pass an existing path or omit the flag.",
    };
  }
  try {
    const raw = readFileSync(path, { encoding: "utf8" });
    const out: string[] = [];
    for (const line of raw.split("\n")) {
      const stripped = line.trim();
      if (!stripped || stripped.startsWith("#")) {
        continue;
      }
      out.push(stripped);
    }
    return out;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      error:
        `verify_xbrief_drift: --allow-list unreadable: ${msg}\n` +
        "  Recovery: check file permissions.",
    };
  }
}

function isAllowListed(relPath: string, patterns: readonly string[]): boolean {
  return patterns.some((pat) => fnmatchCase(relPath, pat));
}

function listFiles(projectRoot: string, mode: DriftScanMode): string[] | { error: string } {
  try {
    const files = mode === "staged" ? gitStagedFiles(projectRoot) : gitTrackedFiles(projectRoot);
    return files.map((p) => p.replace(/\\/g, "/"));
  } catch (err) {
    if (err instanceof GitNotFoundError) {
      return {
        error:
          "verify_xbrief_drift: 'git' executable not found on PATH.\n" +
          "  Recovery: install git or run inside a git working tree.",
      };
    }
    if (err instanceof GitCommandError) {
      return {
        error:
          `verify_xbrief_drift: git failed: ${err.message}\n` +
          "  Recovery: run inside a git working tree.",
      };
    }
    const msg = err instanceof Error ? err.message : String(err);
    return { error: `verify_xbrief_drift: ${msg}` };
  }
}

/** Scan a canonical corpus artifact's content for the bare legacy reference token. */
export function scanCorpusToken(fullPath: string): boolean {
  let source: string;
  try {
    source = readFileSync(fullPath, { encoding: "utf8" });
  } catch {
    return false;
  }
  // Reference types appear as JSON string values, e.g. `"type": "x-vbrief/..."`.
  // The bare prefix as a quoted-string boundary is the structural token we forbid.
  return source.includes(`"${LEGACY_REFERENCE_PREFIX}`) || source.includes(LEGACY_REFERENCE_PREFIX);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Envelope-key/version predicate for correctly named `*.xbrief.json` (#4086). */
export function scanCorpusEnvelope(relPath: string, fullPath: string): DriftFinding | null {
  let raw: string;
  try {
    raw = readFileSync(fullPath, { encoding: "utf8" });
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isPlainObject(parsed)) return null;
  if (Object.hasOwn(parsed, LEGACY_INFO_ROOT_KEY)) {
    return {
      path: relPath,
      kind: "legacy-envelope-key",
      detail:
        `legacy envelope key \`${LEGACY_INFO_ROOT_KEY}\` on a correctly named \`${MIGRATED_ARTIFACT_SUFFIX}\` artifact ` +
        `(canonical: \`${MIGRATED_INFO_ROOT_KEY}\` @ ${VBRIEF_VERSION})`,
    };
  }
  const info = parsed[MIGRATED_INFO_ROOT_KEY];
  if (isPlainObject(info) && typeof info.version === "string" && info.version !== VBRIEF_VERSION) {
    return {
      path: relPath,
      kind: "legacy-envelope-version",
      detail: `\`${MIGRATED_INFO_ROOT_KEY}.version\` is \`${info.version}\` (canonical write: \`${VBRIEF_VERSION}\`)`,
    };
  }
  return null;
}

export function evaluateXbriefDrift(
  projectRoot: string,
  options: DriftEvaluateOptions = {},
): DriftEvaluateResult {
  const root = resolve(projectRoot);
  let isDir = false;
  try {
    isDir = statSync(root).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) {
    return {
      code: 2,
      findings: [],
      message:
        `verify_xbrief_drift: --project-root is not a directory: ${root}\n` +
        "  Recovery: pass an existing directory path.",
      stream: "stderr",
    };
  }

  const allowLoaded = loadAllowList(options.allowListPath ?? null);
  if (!Array.isArray(allowLoaded)) {
    return { code: 2, findings: [], message: allowLoaded.error, stream: "stderr" };
  }
  const allowGlobs = [...BUILTIN_ALLOW_LIST, ...allowLoaded];

  const mode = options.mode ?? "all";
  const listed = listFiles(root, mode);
  if (!Array.isArray(listed)) {
    return { code: 2, findings: [], message: listed.error, stream: "stderr" };
  }

  const legacyDirPrefix = `${LEGACY_ARTIFACT_DIR}/`;
  const corpusPrefix = `${MIGRATED_ARTIFACT_DIR}/`;
  const findings: DriftFinding[] = [];

  for (const rel of listed) {
    if (isAllowListed(rel, allowGlobs)) {
      continue;
    }
    if (rel === LEGACY_ARTIFACT_DIR || rel.startsWith(legacyDirPrefix)) {
      findings.push({
        path: rel,
        kind: "legacy-lifecycle-dir",
        detail: `tracked under the legacy top-level \`${legacyDirPrefix}\` lifecycle directory (canonical: \`${corpusPrefix}\`)`,
      });
      continue;
    }
    if (rel.endsWith(LEGACY_ARTIFACT_SUFFIX)) {
      findings.push({
        path: rel,
        kind: "legacy-suffix",
        detail: `legacy artifact suffix \`${LEGACY_ARTIFACT_SUFFIX}\` (canonical: \`${MIGRATED_ARTIFACT_SUFFIX}\`)`,
      });
      continue;
    }
    if (rel.startsWith(corpusPrefix) && rel.endsWith(MIGRATED_ARTIFACT_SUFFIX)) {
      const full = join(root, rel);
      if (scanCorpusToken(full)) {
        findings.push({
          path: rel,
          kind: "legacy-reference-token",
          detail: `bare legacy reference token \`${LEGACY_REFERENCE_PREFIX}\` in a canonical corpus artifact (canonical: \`x-${MIGRATED_ARTIFACT_DIR}/\`)`,
        });
      }
      if (!isLifecycleFolderPath(rel)) {
        const envelope = scanCorpusEnvelope(rel, full);
        if (envelope !== null) findings.push(envelope);
      }
    }
  }

  if (findings.length > 0) {
    const header =
      `verify_xbrief_drift: detected ${findings.length} legacy-layout token(s) reintroduced into the data plane (#2109 / #4086).\n` +
      "  Root cause: the canonical lifecycle layout is `xbrief/ ** / *.xbrief.json` with `x-xbrief/` reference types and `xBRIEFInfo` @ 0.8.\n" +
      "  Fix: rename the artifact to `.xbrief.json`, move it under `xbrief/`, use the `x-xbrief/` reference prefix, and lift current envelopes to `xBRIEFInfo` 0.8.\n" +
      "  Sanctioned back-compat fixtures are allowlisted; add a documented exception via `--allow-list <path>`\n" +
      "  (file with newline-separated glob patterns).";
    const body = findings
      .slice(0, 50)
      .map((f) => `  ${f.path} [${f.kind}] ${f.detail}`)
      .join("\n");
    const more = findings.length > 50 ? `\n  ... and ${findings.length - 50} more` : "";
    return { code: 1, findings, message: `${header}\n${body}${more}`, stream: "stderr" };
  }

  if (options.quiet === true) {
    return { code: 0, findings: [], message: "", stream: "stdout" };
  }
  return {
    code: 0,
    findings: [],
    message: `verify_xbrief_drift: no legacy-layout drift -- \`${corpusPrefix}\` is canonical (#2109).`,
    stream: "stdout",
  };
}
