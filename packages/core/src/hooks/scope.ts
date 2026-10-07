import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { hasArtifactSuffix } from "../layout/resolve.js";
import {
  isStoryWriteFenceUnreadable,
  loadStoryWriteFenceFromMergeBase,
  type StoryWriteFenceView,
} from "../policy/write-fence.js";
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
  /**
   * Allow-path advisory (#5386). Dispatcher merges this into allowMessage when
   * ready:true (inspector-only message fields are discarded on allow).
   */
  readonly warning?: string;
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

/** Evidence-only lifecycle verb (kept for stamp-evidence callers; not an eligibility fix) (#4840 / #5403). */
export const STAMP_EVIDENCE_VERB = "scope:stamp-evidence";

/** Local fence-unblock verb that clears eligibility without network (#5403). */
export const BLOCK_SCOPE_VERB = "scope:block";

/** Explicit-target historical ship-closeout named on multi-eligible deny (#5403). */
export const HISTORICAL_SHIP_CLOSEOUT_HINT =
  "If an eligible brief is already shipped on the delivery tip, close it out with " +
  "`deft scope:complete -- <brief> --merge-commit <sha> --pr <n>` " +
  "(delivery ancestry required; completed-tracked is post-land proof only).";

export interface InspectActiveScopeOptions {
  /** Explicit dispatched story path; wins over {@link ACTIVE_SCOPE_PIN_ENV}. */
  readonly boundPath?: string | null;
  /**
   * Hook environ bag. When provided (including `{}`), the pin is read from here
   * only. When omitted, `process.env` is consulted so CLI callers stay pinned.
   */
  readonly env?: NodeJS.ProcessEnv;
  /**
   * Story fence loader for the unpinned non-fencing partition (#4880 / #4956).
   * Defaults to merge-base authority (same SoT as the write gate). Tests may
   * inject a working-tree or fixture loader.
   */
  readonly loadStoryWriteFence?: (projectRoot: string, scopePath: string) => StoryWriteFenceView;
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
 * Assumptions: deny/allow copy is operator-visible hook text; basenames and pin
 * env / boundPath values are untrusted (#5386 S2).
 * Guarantees: names are fenced and CR/LF-collapsed so they cannot break markdown
 * or inject copy onto deny or allow paths.
 * Non-goals: preflight evaluator copy, origin-freshness messages.
 */
function fenceActiveScopeName(path: string): string {
  return fenceUntrustedAcceptanceText(toPosix(basename(path)));
}

function fencePinValue(pin: string): string {
  return fenceUntrustedAcceptanceText(toPosix(pin.trim()));
}

/**
 * Audience-labeled multiple-eligible recovery (#4880 Prefer-A A).
 * Parent/operator vs Dispatched worker; stamp-evidence is evidence-only.
 */
function formatMultipleActiveMessage(eligible: readonly EligibleScope[]): string {
  const names = eligible.map((item) => fenceActiveScopeName(item.path)).join(", ");
  const localShipHint = eligible.some((item) => briefHasLocalMergeProvenance(item.path))
    ? " Local completionProvenance.mergeCommit is already present on at least one eligible brief."
    : "";
  return (
    `Multiple active xBRIEF artifacts are eligible (${names}). ` +
    "The write fence cannot bind the first-sorted story: a cohort would share that " +
    "story's file_scope and over-permit every other worker (#4007). " +
    `Parent/operator: pin ${ACTIVE_SCOPE_PIN_ENV} to the dispatched story before spawn ` +
    `(or demote/complete competitors / run \`deft ${BLOCK_SCOPE_VERB} -- <brief>\`), ` +
    "and ensure the pin is visible to the hook environ that measured the deny " +
    "(process.env / spawn stdin env bag); restart the host when only User/system env was updated." +
    localShipHint +
    ` ${HISTORICAL_SHIP_CLOSEOUT_HINT} ` +
    "Dispatched worker: report the eligible brief names upward; do not set host process env. " +
    `If your intended operation is acceptance recording: \`deft ${STAMP_EVIDENCE_VERB} -- <brief>\` ` +
    "(evidence-only; may Edit the brief via stampEvidenceOnBrief; does not change plan.status " +
    "or leave active/; does not clear this Write/spawn deny)."
  );
}

/**
 * Write-fence storyActive predicate for eligibility partition (#4880 Prefer-A C').
 * Non-fencing = absent/empty allow + empty deny. Unreadable authority fails closed
 * (treated as fencing so it stays in unpinned competition). Uses the same fence
 * source as the write gate (merge-base by default), not working-tree head.
 */
function isFencingEligibleBrief(
  projectRoot: string,
  briefPath: string,
  loadFence: (projectRoot: string, scopePath: string) => StoryWriteFenceView,
): boolean {
  const fence = loadFence(projectRoot, briefPath);
  if (isStoryWriteFenceUnreadable(fence)) return true;
  return fence.fileScope.length > 0 || fence.denyPaths.length > 0;
}

/**
 * When ≥1 fencing eligible exists, drop non-fencing briefs from the unpinned
 * competition set. Zero fencing preserves today's sole/multi pathless behavior.
 */
function partitionUnpinnedEligible(
  projectRoot: string,
  eligible: readonly EligibleScope[],
  loadFence: (projectRoot: string, scopePath: string) => StoryWriteFenceView,
): readonly EligibleScope[] {
  const fencing = eligible.filter((item) =>
    isFencingEligibleBrief(projectRoot, item.path, loadFence),
  );
  if (fencing.length >= 1) return fencing;
  return eligible;
}

/** Local-only hint: completionProvenance already on disk (no gh) (#5403). */
function briefHasLocalMergeProvenance(briefPath: string): boolean {
  try {
    const raw = readFileSync(briefPath, "utf8");
    const data = JSON.parse(raw) as {
      plan?: { metadata?: { completionProvenance?: { mergeCommit?: unknown } } };
    };
    const merge = data.plan?.metadata?.completionProvenance?.mergeCommit;
    return typeof merge === "string" && merge.trim().length > 0;
  } catch {
    return false;
  }
}

function formatZeroEligibleBlockedMessage(blocked: readonly string[]): string {
  const names = blocked.map((path) => fenceActiveScopeName(path)).join(", ");
  return (
    `No eligible running xBRIEF under xbrief/active/. Scanned candidate(s) are ` +
    `blocked (${names}).`
  );
}

/** Env pin with no scanned match (#5386): absent from active/; clear/repoint + restart. */
function formatMissingEnvPinMessage(pin: string, eligibleCount: number): string {
  const fenced = fencePinValue(pin);
  const base =
    `${ACTIVE_SCOPE_PIN_ENV} names a path absent from xbrief/active/ ` + `(got ${fenced}).`;
  if (eligibleCount === 0) {
    return (
      `${base} Clear or repoint ${ACTIVE_SCOPE_PIN_ENV} to an eligible running brief, ` +
      "then restart the host so the hook process sees the change. " +
      "Clearing the pin alone cannot make the fence ready while no eligible brief exists."
    );
  }
  return (
    `${base} Clear or repoint ${ACTIVE_SCOPE_PIN_ENV} to an eligible running brief, ` +
    "then restart the host so the hook process sees the change."
  );
}

/** Explicit boundPath with no scanned match (#5386): do not imply env repair. */
function formatMissingBoundPathMessage(pin: string): string {
  return (
    `boundPath names a path absent from xbrief/active/ (got ${fencePinValue(pin)}). ` +
    "Repair the dispatch binding / dest basename; changing " +
    `${ACTIVE_SCOPE_PIN_ENV} does not override a nonempty boundPath.`
  );
}

/** Pin matched a scanned artifact but preflight rejected it (#5386). */
function formatMatchedRejectedPinMessage(
  pin: string,
  source: "env" | "boundPath",
  rejected: string,
  matchedPath: string,
  isBlocked: boolean,
): string {
  const label = source === "boundPath" ? "boundPath" : ACTIVE_SCOPE_PIN_ENV;
  const base =
    `${label} ${fencePinValue(pin)} names a present brief that is not ` +
    `implementation-eligible (${fenceActiveScopeName(matchedPath)}): ${rejected}`;
  if (isBlocked) {
    // Fenced name stays in `base`; command arg is a path placeholder (#5386 P2).
    return `${base} Recovery: run \`deft scope:unblock -- <blocked-brief>\`.`;
  }
  return base;
}

/** Allow-path warn after env-pin miss + sole-eligible fallback (#5386). */
function formatStaleEnvPinFallbackWarning(pin: string, selectedPath: string): string {
  return (
    `Warning: ${ACTIVE_SCOPE_PIN_ENV} named absent path ${fencePinValue(pin)}; ` +
    `falling back to sole eligible ${fenceActiveScopeName(selectedPath)}. ` +
    `Clear or repoint ${ACTIVE_SCOPE_PIN_ENV} and restart the host.`
  );
}

/**
 * Find an implementation-eligible scope by delegating every candidate to the
 * existing xBRIEF preflight evaluator for lifecycle/status. A second, narrower
 * predicate applies only on the unpinned multi-eligible path (#4880 Prefer-A C'):
 * when ≥1 fencing eligible exists (nonempty story allow or deny per write-fence
 * storyActive), non-fencing briefs are excluded from that competition set.
 * Explicit pin / boundPath still matches the full preflight-eligible set.
 *
 * When more than one candidate remains eligible after that partition, first-wins
 * is not used (#4007): bind {@link ACTIVE_SCOPE_PIN_ENV} / `boundPath`, or fail closed.
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

  const explicitBound = options?.boundPath?.trim() ?? "";
  const hasExplicitBound = explicitBound.length > 0;
  const envBag = options?.env ?? process.env;
  const envPin = envBag[ACTIVE_SCOPE_PIN_ENV]?.trim() ?? "";
  const pin = pinFrom(options);
  if (pin.length > 0) {
    const pinSource: "env" | "boundPath" = hasExplicitBound ? "boundPath" : "env";
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
        const isBlocked =
          blocked.includes(matched) || rejected.includes("plan.status is 'blocked'");
        return {
          ready: false,
          path: null,
          message: formatMatchedRejectedPinMessage(pin, pinSource, rejected, matched, isBlocked),
          denyKind: "pin-miss",
        };
      }
    }
    // Limb 3 (#5386): env pin, no scanned match, no boundPath, exactly one eligible.
    const onlyEligible = eligible[0];
    if (
      !hasExplicitBound &&
      envPin.length > 0 &&
      matched === null &&
      eligible.length === 1 &&
      onlyEligible !== undefined
    ) {
      return {
        ready: true,
        path: onlyEligible.path,
        message: onlyEligible.message,
        warning: formatStaleEnvPinFallbackWarning(envPin, onlyEligible.path),
      };
    }
    return {
      ready: false,
      path: null,
      message: hasExplicitBound
        ? formatMissingBoundPathMessage(pin)
        : formatMissingEnvPinMessage(pin, eligible.length),
      denyKind: "pin-miss",
    };
  }

  // Unpinned path only (#4880 C'): partition non-fencing out when fencing exists.
  // Same fence SoT as the write gate (merge-base unless a test seam overrides).
  const loadFence = options?.loadStoryWriteFence ?? loadStoryWriteFenceFromMergeBase;
  const competition = partitionUnpinnedEligible(projectRoot, eligible, loadFence);
  const only = competition[0];
  if (competition.length === 1 && only !== undefined) {
    return { ready: true, path: only.path, message: only.message };
  }
  if (competition.length > 1) {
    return {
      ready: false,
      path: null,
      message: formatMultipleActiveMessage(competition),
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
