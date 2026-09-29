import { existsSync, readdirSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { hasArtifactSuffix } from "../layout/resolve.js";
import { evaluate } from "../preflight/evaluate.js";
import { fenceUntrustedAcceptanceText } from "../scope/acceptance-evidence.js";

/** Hook/process env pin for the dispatched story when more than one brief is active (#4007). */
export const ACTIVE_SCOPE_PIN_ENV = "DEFT_ACTIVE_SCOPE";

/** Why inspectActiveScope is not ready (#4840). */
export type ActiveScopeDenyKind =
  | "multiple-eligible"
  | "zero-eligible-blocked"
  | "zero-eligible"
  | "pin-miss";

export interface ActiveScopeInspection {
  readonly ready: boolean;
  readonly path: string | null;
  readonly message: string;
  readonly denyKind?: ActiveScopeDenyKind;
}

/**
 * Soft-missing / check-composition target when active/ has more than one
 * lifecycle artifact (#4285). Pin or explicit path; never ALL-paths.
 */
export type SoftMissingAcTargetResolution =
  | { readonly kind: "one"; readonly path: string }
  | { readonly kind: "none" }
  | {
      readonly kind: "need-pin";
      readonly message: string;
      readonly denyKind?: ActiveScopeDenyKind;
      readonly scannedCount: number;
    };

/** Evidence-only lifecycle verb named on the multiple-eligible deny (#4840). */
export const STAMP_EVIDENCE_VERB = "scope:stamp-evidence";

export interface InspectActiveScopeOptions {
  /** Explicit dispatched story path; wins over {@link ACTIVE_SCOPE_PIN_ENV}. */
  readonly boundPath?: string | null;
  /**
   * Hook environ bag. When provided (including `{}`), the pin is read from here
   * only. When omitted, `process.env` is consulted so CLI callers stay pinned.
   */
  readonly env?: NodeJS.ProcessEnv;
}

interface EligibleScope {
  readonly path: string;
  readonly message: string;
}

function toPosix(path: string): string {
  // Win32 path separators only. On POSIX a backslash is a filename character;
  // rewriting it to `/` would let a nonexistent `xbrief\active\story.json` pin
  // match `xbrief/active/story.json` (#4007 Greptile).
  return process.platform === "win32" ? path.replace(/\\/g, "/") : path;
}

/** Win32 filesystems are case-insensitive; POSIX filenames are not (#4007 Greptile). */
function samePathToken(left: string, right: string): boolean {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function containedResolved(projectRoot: string, target: string): string | null {
  const root = resolve(projectRoot);
  const abs = resolve(root, target);
  const rel = relative(root, abs);
  if (rel.length === 0 || rel.startsWith("..") || isAbsolute(rel)) return null;
  return abs;
}

function pinFrom(options?: InspectActiveScopeOptions): string {
  const bound = options?.boundPath?.trim() ?? "";
  if (bound.length > 0) return bound;
  const env = options?.env ?? process.env;
  return env[ACTIVE_SCOPE_PIN_ENV]?.trim() ?? "";
}

/**
 * Match a dispatched-story pin against scanned active artifacts.
 * Accepts an absolute path, a project-relative path, or a unique basename.
 */
export function matchPinnedActiveScope(
  projectRoot: string,
  pin: string,
  eligible: readonly string[],
  scanned: readonly string[] = eligible,
): string | null {
  const trimmed = pin.trim();
  if (trimmed.length === 0) return null;
  const contained = containedResolved(projectRoot, trimmed);
  const wantPosix =
    contained !== null ? toPosix(relative(resolve(projectRoot), contained)) : toPosix(trimmed);
  for (const candidate of scanned) {
    if (contained !== null && samePathToken(resolve(candidate), contained)) return candidate;
    if (samePathToken(toPosix(relative(resolve(projectRoot), candidate)), wantPosix)) {
      return candidate;
    }
  }
  // Path-shaped pins (absolute or project-relative) fail closed on exact miss.
  // Basename fallback is only for a bare filename; otherwise a stale/wrong-dir
  // pin would bind a same-named local story (#4007 Greptile P1).
  const pinPosix = toPosix(trimmed);
  if (pinPosix.includes("/")) return null;
  const base = basename(pinPosix);
  if (base.length === 0) return null;
  const eligibleHits = eligible.filter((candidate) => samePathToken(basename(candidate), base));
  const eligibleHit = eligibleHits[0];
  if (eligibleHits.length === 1 && eligibleHit !== undefined) return eligibleHit;
  const scannedHits = scanned.filter((candidate) => samePathToken(basename(candidate), base));
  const scannedHit = scannedHits[0];
  if (scannedHits.length === 1 && scannedHit !== undefined) return scannedHit;
  return null;
}

/**
 * Assumptions: deny copy is operator-visible hook text; basenames come from the filesystem.
 * Guarantees: names are fenced and CR/LF-collapsed so they cannot break markdown or inject copy.
 * Non-goals: pin env values, preflight evaluator copy, origin-freshness messages.
 */
function fenceActiveScopeName(path: string): string {
  return fenceUntrustedAcceptanceText(toPosix(basename(path)));
}

function formatMultipleActiveMessage(eligible: readonly EligibleScope[]): string {
  const names = eligible.map((item) => fenceActiveScopeName(item.path)).join(", ");
  return (
    `Multiple active xBRIEF artifacts are eligible (${names}). ` +
    "The write fence cannot bind the first-sorted story: a cohort would share that " +
    "story's file_scope and over-permit every other worker (#4007). " +
    `Set ${ACTIVE_SCOPE_PIN_ENV} to the dispatched story path, or record acceptance ` +
    `with \`deft ${STAMP_EVIDENCE_VERB} -- <brief>\`. ` +
    "Or keep one running brief in xbrief/active/."
  );
}

function formatZeroEligibleBlockedMessage(blocked: readonly string[]): string {
  const names = blocked.map((path) => fenceActiveScopeName(path)).join(", ");
  return (
    `No eligible running xBRIEF under xbrief/active/. Scanned candidate(s) are ` +
    `blocked (${names}).`
  );
}

function formatMissingPinMessage(pin: string): string {
  return (
    `${ACTIVE_SCOPE_PIN_ENV} does not name an eligible running xBRIEF under ` +
    `xbrief/active/ (got ${pin}).`
  );
}

/**
 * Find an implementation-eligible scope by delegating every candidate to the
 * existing xBRIEF preflight evaluator. This intentionally creates no second
 * lifecycle/status policy stack.
 *
 * When more than one candidate is eligible, first-wins is not used (#4007):
 * bind {@link ACTIVE_SCOPE_PIN_ENV} / `boundPath`, or fail closed.
 */
export function inspectActiveScope(
  projectRoot: string,
  options?: InspectActiveScopeOptions,
): ActiveScopeInspection {
  const candidates: string[] = [];
  for (const relativeDir of [join("xbrief", "active"), join("vbrief", "active")]) {
    const activeDir = join(projectRoot, relativeDir);
    try {
      for (const entry of readdirSync(activeDir, { withFileTypes: true })) {
        if (entry.isFile() && hasArtifactSuffix(entry.name)) {
          candidates.push(join(activeDir, entry.name));
        }
      }
    } catch {
      // A missing/unreadable active folder contributes no eligible candidate.
    }
  }

  // Stable traversal makes the selected path and first rejection reproducible.
  candidates.sort();
  const eligible: EligibleScope[] = [];
  const rejections = new Map<string, string>();
  const blocked: string[] = [];
  let firstRejection: string | null = null;
  for (const candidate of candidates) {
    // #3736: origin freshness remains fail-closed at explicit xbrief:preflight.
    // The host mutation path must stay local and render before its effective timeout.
    const result = evaluate(candidate, { skipOriginFreshness: true });
    if (result.exitCode === 0) {
      eligible.push({ path: candidate, message: result.message });
    } else {
      rejections.set(candidate, result.message);
      firstRejection ??= result.message;
      if (result.message.includes("plan.status is 'blocked'")) {
        blocked.push(candidate);
      }
    }
  }

  const pin = pinFrom(options);
  if (pin.length > 0) {
    const matched = matchPinnedActiveScope(
      projectRoot,
      pin,
      eligible.map((item) => item.path),
      candidates,
    );
    if (matched !== null) {
      const hit = eligible.find((item) => item.path === matched);
      if (hit !== undefined) {
        return { ready: true, path: hit.path, message: hit.message };
      }
      const rejected = rejections.get(matched);
      if (rejected !== undefined) {
        return { ready: false, path: null, message: rejected, denyKind: "pin-miss" };
      }
    }
    return {
      ready: false,
      path: null,
      message: formatMissingPinMessage(pin),
      denyKind: "pin-miss",
    };
  }

  const only = eligible[0];
  if (eligible.length === 1 && only !== undefined) {
    return { ready: true, path: only.path, message: only.message };
  }
  if (eligible.length > 1) {
    return {
      ready: false,
      path: null,
      message: formatMultipleActiveMessage(eligible),
      denyKind: "multiple-eligible",
    };
  }
  if (blocked.length > 0) {
    return {
      ready: false,
      path: null,
      message: formatZeroEligibleBlockedMessage(blocked),
      denyKind: "zero-eligible-blocked",
    };
  }
  if (firstRejection !== null) {
    return {
      ready: false,
      path: null,
      message: firstRejection,
      denyKind: "zero-eligible",
    };
  }
  return {
    ready: false,
    path: null,
    message:
      "No active xBRIEF artifact was found under xbrief/active/ " +
      "(or the legacy vbrief/active/ compatibility path).",
    denyKind: "zero-eligible",
  };
}

/** Scan xbrief/active + vbrief/active for lifecycle artifact files (#4285). */
export function listActiveLifecycleArtifacts(projectRoot: string): {
  readonly paths: readonly string[];
  readonly dirs: readonly string[];
} {
  const paths: string[] = [];
  const dirs: string[] = [];
  for (const dirName of ["xbrief", "vbrief"]) {
    const active = join(projectRoot, dirName, "active");
    if (!existsSync(active)) continue;
    let names: string[] = [];
    try {
      names = readdirSync(active)
        .filter((name) => hasArtifactSuffix(name))
        .sort();
    } catch {
      continue;
    }
    if (names.length === 0) continue;
    dirs.push(active);
    for (const name of names) {
      paths.push(join(active, name));
    }
  }
  return { paths, dirs };
}

function formatSoftMissingNeedPinMessage(count: number, inspectMessage: string): string {
  return (
    `verify:ac soft-missing: ${count} active lifecycle artifacts; ` +
    `select the dispatched story via ${ACTIVE_SCOPE_PIN_ENV} or pass an explicit -- <path> ` +
    `(#4285). Do not silently skip AC. Do not run foreign leftover acceptance commands. ` +
    inspectMessage
  );
}

export interface ResolveSoftMissingAcTargetsOptions extends InspectActiveScopeOptions {
  /** Pre-scanned active artifact paths; when omitted, rescans active roots. */
  readonly scannedPaths?: readonly string[];
}

/**
 * Select the soft-missing / check-composition AC target (#4285).
 *
 * One scanned artifact → that path (single-scope unchanged).
 * Many artifacts → require an explicit pin / {@link ACTIVE_SCOPE_PIN_ENV} /
 * `boundPath` (or fail closed). Do not reuse {@link inspectActiveScope}
 * readiness: one preflight-eligible leftover must not win without a pin, and a
 * pinned blocked / preflight-ineligible story must still run acceptance (AC
 * does not require implementation-preflight). Never evaluates every active
 * leftover under soft-missing.
 */
export function resolveSoftMissingAcTargets(
  projectRoot: string,
  options?: ResolveSoftMissingAcTargetsOptions,
): SoftMissingAcTargetResolution {
  const scanned =
    options?.scannedPaths !== undefined
      ? [...options.scannedPaths]
      : [...listActiveLifecycleArtifacts(projectRoot).paths];
  if (scanned.length === 0) {
    return { kind: "none" };
  }
  if (scanned.length === 1) {
    const only = scanned[0];
    if (only === undefined) {
      return { kind: "none" };
    }
    return { kind: "one", path: only };
  }
  const pin = pinFrom(options);
  if (pin.length > 0) {
    // Match against scanned actives only — not preflight-eligible subset.
    const matched = matchPinnedActiveScope(projectRoot, pin, scanned, scanned);
    if (matched !== null) {
      return { kind: "one", path: matched };
    }
    return {
      kind: "need-pin",
      message: formatSoftMissingNeedPinMessage(
        scanned.length,
        `${ACTIVE_SCOPE_PIN_ENV} does not name an active lifecycle artifact under ` +
          `xbrief/active/ (got ${pin}).`,
      ),
      denyKind: "pin-miss",
      scannedCount: scanned.length,
    };
  }
  return {
    kind: "need-pin",
    message: formatSoftMissingNeedPinMessage(
      scanned.length,
      "No pin or boundPath; refuse unpinned multi-active soft-missing selection.",
    ),
    denyKind: "multiple-eligible",
    scannedCount: scanned.length,
  };
}
