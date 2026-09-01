import { readdirSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { hasArtifactSuffix } from "../layout/resolve.js";
import { evaluate } from "../preflight/evaluate.js";

/** Hook/process env pin for the dispatched story when more than one brief is active (#4007). */
export const ACTIVE_SCOPE_PIN_ENV = "DEFT_ACTIVE_SCOPE";

export interface ActiveScopeInspection {
  readonly ready: boolean;
  readonly path: string | null;
  readonly message: string;
}

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
  return path.replace(/\\/g, "/");
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
    if (contained !== null && resolve(candidate) === contained) return candidate;
    if (toPosix(relative(resolve(projectRoot), candidate)) === wantPosix) return candidate;
  }
  // Path-shaped pins (absolute or project-relative) fail closed on exact miss.
  // Basename fallback is only for a bare filename; otherwise a stale/wrong-dir
  // pin would bind a same-named local story (#4007 Greptile P1).
  const pinPosix = toPosix(trimmed);
  if (pinPosix.includes("/")) return null;
  const base = basename(pinPosix);
  if (base.length === 0) return null;
  const eligibleHits = eligible.filter((candidate) => basename(candidate) === base);
  const eligibleHit = eligibleHits[0];
  if (eligibleHits.length === 1 && eligibleHit !== undefined) return eligibleHit;
  const scannedHits = scanned.filter((candidate) => basename(candidate) === base);
  const scannedHit = scannedHits[0];
  if (scannedHits.length === 1 && scannedHit !== undefined) return scannedHit;
  return null;
}

function formatMultipleActiveMessage(eligible: readonly EligibleScope[]): string {
  const names = eligible.map((item) => toPosix(basename(item.path))).join(", ");
  return (
    `Multiple active xBRIEF artifacts are eligible (${names}). ` +
    "The write fence cannot bind the first-sorted story: a cohort would share that " +
    "story's file_scope and over-permit every other worker (#4007). " +
    `Set ${ACTIVE_SCOPE_PIN_ENV} to the dispatched story path, or keep one running ` +
    "brief in xbrief/active/."
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
        return { ready: false, path: null, message: rejected };
      }
    }
    return { ready: false, path: null, message: formatMissingPinMessage(pin) };
  }

  const only = eligible[0];
  if (eligible.length === 1 && only !== undefined) {
    return { ready: true, path: only.path, message: only.message };
  }
  if (eligible.length > 1) {
    return { ready: false, path: null, message: formatMultipleActiveMessage(eligible) };
  }
  if (firstRejection !== null) {
    return { ready: false, path: null, message: firstRejection };
  }
  return {
    ready: false,
    path: null,
    message:
      "No active xBRIEF artifact was found under xbrief/active/ " +
      "(or the legacy vbrief/active/ compatibility path).",
  };
}
