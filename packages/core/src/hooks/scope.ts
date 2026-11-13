import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { briefOwnsIssue, issueOriginFromRepoSlug } from "../intake/residual-identity.js";
import { hasArtifactSuffix } from "../layout/resolve.js";
import { matchAny } from "../orchestration/pathspec.js";
import {
  hasPositiveGoverningStoryAllow,
  isStoryWriteFenceUnreadable,
  loadStoryWriteFenceFromMergeBase,
  type StoryWriteFenceView,
} from "../policy/write-fence.js";
import { evaluate } from "../preflight/evaluate.js";
import { fenceUntrustedAcceptanceText } from "../scope/acceptance-evidence.js";
import {
  liveOccupant,
  type OccupancyAdmission,
  type OccupancyRecord,
  occupancyAdmission,
} from "../session/occupancy.js";
import { isLinkedWorktreePath } from "../session/main-worktree.js";
import {
  type ReadWorkerAuthAssignmentResult,
  readWorkerAuthAssignment,
  resolveWorkerAuthDestPath,
  storyIdForBrief,
} from "../swarm/worker-auth-assignment.js";

export { hasPositiveGoverningStoryAllow } from "../policy/write-fence.js";

/**
 * Deny copy when a selected brief lacks positive governing allow (#5656).
 * Recovery text is inlined (same promote-then-activate wording as
 * SCOPE_NOT_READY_PROMOTE_THEN_ACTIVATE) so module init cannot see a
 * circular-import `undefined`.
 */
export const POSITIVE_GOVERNING_ALLOW_REQUIRED =
  "Directive denied this mutation: the selected running scope lacks positive " +
  "governing story allow coverage (non-empty file_scope / allow list). " +
  "Deny-only and pathless fences do not admit Write or implement spawn (#5656). " +
  "Recovery: for a newly written proposal, run `deft scope:promote -- <path>` then " +
  "`deft scope:activate -- <path>` (auto-promote from proposed/ is refused); " +
  "for an already-pending xBRIEF run `deft scope:activate -- <path>`.";

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
  /** Admitted untied maintainer branch (#5855): soft-missing, no story obligation. */
  | { readonly kind: "untied"; readonly message: string; readonly scannedCount: number }
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
 * Whether the selected brief supplies positive governing allow for a mutation
 * (#5656 Prefer-A Bound limb 2). Uses the same fence loader as the write gate
 * (merge-base by default) so agent-widened working-tree scope bytes alone do
 * not admit. Pathless and deny-only briefs return false.
 */
export function selectedBriefHasPositiveGoverningAllow(
  projectRoot: string,
  scopePath: string | null,
  loadFence: (
    projectRoot: string,
    scopePath: string,
  ) => StoryWriteFenceView = loadStoryWriteFenceFromMergeBase,
): boolean {
  if (scopePath === null || scopePath.trim().length === 0) return false;
  return hasPositiveGoverningStoryAllow(loadFence(projectRoot, scopePath));
}

/**
 * Whether governing story allow covers a project-relative POSIX path (#5656).
 * Empty allow never covers; deny lists are not a substitute.
 */
export function governingAllowCoversRelPath(
  fence: StoryWriteFenceView,
  relPathPosix: string,
): boolean {
  if (!hasPositiveGoverningStoryAllow(fence)) return false;
  return matchAny(fence.fileScope, relPathPosix);
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
 *
 * Note (#5656): inspect readiness alone is not Write/spawn admission. Dispatcher
 * still requires {@link selectedBriefHasPositiveGoverningAllow} for those tools.
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
  /**
   * Opt-in branch-side story bind for check / pre-PR only (#5855 P2). Omitted
   * (sor-preflight and other callers) keeps the need-pin default.
   */
  readonly branchBind?: BranchStoryBindOptions;
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
  if (options?.branchBind !== undefined) {
    const bind = bindBranchToActiveStory(scanned, {
      ...options.branchBind,
      projectRoot: options.branchBind.projectRoot ?? projectRoot,
    });
    if (bind.kind === "bound") {
      return { kind: "one", path: bind.path };
    }
    if (bind.kind === "untied") {
      return {
        kind: "untied",
        message: formatUntiedSoftMissingMessage(scanned),
        scannedCount: scanned.length,
      };
    }
    return {
      kind: "need-pin",
      message: formatSoftMissingNeedPinMessage(scanned.length, bind.message),
      denyKind: bind.denyKind,
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

/**
 * Legacy spawn/dispatch env keys retained for disclosure only (#5855 Recut-8).
 * Untied admission keys off verified worker-auth + foreign-live, not these markers.
 */
export const DISPATCH_EXPECTATION_ENV_KEYS = [
  "DEFT_AGENT_ID",
  "DEFT_WORKER_CREDENTIAL_DELIVERY_ID",
] as const;

/** Session id presented for foreign-live occupancy consult (#5855 Recut-8). */
export const CALLER_SESSION_ENV = "DEFT_SESSION_ID";

/**
 * Distinct non-zero exit for admitted-untied soft-missing no-obligation (#5855 Recut-8).
 * Neither 1 (fail), 2 (config), nor 124 (timeout). Exit 0 still means executed AC only.
 */
export const VERIFY_AC_NO_OBLIGATION_EXIT = 6;

/** Closed skipReason when merge_chokepoint observes no-obligation (#5855 Recut-8). */
export const MERGE_CHOKPOINT_NO_OBLIGATION_SKIP =
  "admitted-untied soft-missing no-obligation (#5855)" as const;

/** Positively known verify:ac disposition for pushBinding (#5855 Recut-8). */
export type VerifyAcDispositionKind = "executed-ac" | "no-obligation";

const VERSION_SHAPED_SEGMENT = /^v?\d+(?:\.\d+)+(?:[-+][0-9A-Za-z.-]+)?$/;

/** Story tokens a branch name carries (#5855). Text only; no network. */
export interface BranchStoryTokens {
  /** `/`-separated segments, compared to plan.id by equality. */
  readonly segments: readonly string[];
  /** Bare issue-number tokens; version-shaped and dotted parts never count. */
  readonly issueNumbers: readonly number[];
}

export function branchStoryTokens(branch: string | null | undefined): BranchStoryTokens {
  const trimmed = (branch ?? "").trim().replace(/^refs\/heads\//, "");
  if (trimmed.length === 0 || trimmed === "HEAD") {
    return { segments: [], issueNumbers: [] };
  }
  const segments = trimmed.split("/").filter((segment) => segment.length > 0);
  const numbers = new Set<number>();
  for (const segment of segments) {
    if (VERSION_SHAPED_SEGMENT.test(segment)) continue;
    for (const part of segment.split(/[-_]/)) {
      if (!/^\d+$/.test(part)) continue;
      const n = Number.parseInt(part, 10);
      if (Number.isSafeInteger(n) && n > 0) numbers.add(n);
    }
  }
  return { segments, issueNumbers: [...numbers] };
}

export interface BranchStoryBindOptions {
  /** Branch name (or `refs/heads/...`); null / empty for detached HEAD. */
  readonly branch: string | null;
  readonly env?: NodeJS.ProcessEnv;
  /** `owner/repo` for repo-scoped issue ownership; null keeps number-only. */
  readonly repoSlug?: string | null;
  /** Worktree root for worker-auth + occupancy consult (#5855 Recut-8). */
  readonly projectRoot?: string;
  /** Injectable worker-auth reader (tests). */
  readonly readWorkerAuthAssignment?: (cwd: string) => ReadWorkerAuthAssignmentResult;
  /** Injectable live occupancy reader (tests). */
  readonly liveOccupant?: (projectRoot: string) => OccupancyRecord | null;
  /** Injectable occupancy admission (tests). */
  readonly occupancyAdmission?: (record: OccupancyRecord, sessionId: string) => OccupancyAdmission;
}

export type BranchStoryBind =
  | { readonly kind: "bound"; readonly path: string }
  | { readonly kind: "untied" }
  | { readonly kind: "refuse"; readonly message: string; readonly denyKind: ActiveScopeDenyKind };

function readBriefRecord(path: string): Record<string, unknown> | null {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return typeof raw === "object" && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function briefPlanId(data: Record<string, unknown> | null): string | null {
  const plan = data?.plan;
  if (typeof plan !== "object" || plan === null || Array.isArray(plan)) return null;
  const id = (plan as Record<string, unknown>).id;
  return typeof id === "string" && id.trim().length > 0 ? id.trim() : null;
}

/** Story id the swarm launch records for this brief (#6233 shared derivation). */
function briefStoryId(brief: {
  readonly path: string;
  readonly data: Record<string, unknown> | null;
}): string {
  const plan = brief.data?.plan;
  const planRecord =
    typeof plan === "object" && plan !== null && !Array.isArray(plan)
      ? (plan as Record<string, unknown>)
      : null;
  return storyIdForBrief(brief.path, planRecord);
}

function fencedCandidates(paths: readonly string[]): string {
  return paths.map((path) => fenceActiveScopeName(path)).join(", ");
}

/**
 * Bind a check / pre-PR run to the branch's own active story (#5855 Recut-8 P1).
 * plan.id equality first, then a single repo-scoped issue token. No story token
 * admits untied only after verified worker-auth shows no registered assignment
 * and there is no foreign live occupancy lease (self-lease admits).
 */
export function bindBranchToActiveStory(
  scanned: readonly string[],
  options: BranchStoryBindOptions,
): BranchStoryBind {
  const tokens = branchStoryTokens(options.branch);
  const briefs = scanned.map((path) => ({ path, data: readBriefRecord(path) }));
  const byPlanId = briefs.filter((brief) => {
    const id = briefPlanId(brief.data);
    return id !== null && tokens.segments.includes(id);
  });
  const onlyPlanId = byPlanId[0];
  if (byPlanId.length === 1 && onlyPlanId !== undefined) {
    return { kind: "bound", path: onlyPlanId.path };
  }
  if (byPlanId.length > 1) {
    return {
      kind: "refuse",
      message: `branch plan.id token matches ${byPlanId.length} active briefs: ${fencedCandidates(byPlanId.map((b) => b.path))}.`,
      denyKind: "multiple-eligible",
    };
  }
  if (tokens.issueNumbers.length > 1) {
    return {
      kind: "refuse",
      message: `branch carries more than one issue token (${tokens.issueNumbers.map((n) => `#${n}`).join(", ")}); cannot bind one story.`,
      denyKind: "multiple-eligible",
    };
  }
  const issue = tokens.issueNumbers[0];
  if (issue !== undefined) {
    const target = issueOriginFromRepoSlug(options.repoSlug, issue) ?? issue;
    const owners = briefs.filter(
      (brief) => brief.data !== null && briefOwnsIssue(brief.data, target),
    );
    const onlyOwner = owners[0];
    if (owners.length === 1 && onlyOwner !== undefined) {
      return { kind: "bound", path: onlyOwner.path };
    }
    return {
      kind: "refuse",
      message:
        owners.length > 1
          ? `branch issue token #${issue} is owned by ${owners.length} active briefs: ${fencedCandidates(owners.map((b) => b.path))}.`
          : `branch names #${issue} but no active brief owns it (lost pin?). Active: ${fencedCandidates(scanned)}.`,
      denyKind: owners.length > 1 ? "multiple-eligible" : "pin-miss",
    };
  }
  return admitUntiedWithWorkerAuth(scanned, briefs, options);
}

function matchStoryIdToActive(
  briefs: readonly { path: string; data: Record<string, unknown> | null }[],
  storyId: string,
): BranchStoryBind {
  const id = storyId.trim();
  if (id.length === 0) {
    return {
      kind: "refuse",
      message: `registered worker-auth assignment without a story pin; set ${ACTIVE_SCOPE_PIN_ENV}.`,
      denyKind: "pin-miss",
    };
  }
  const owners = briefs.filter((brief) => briefStoryId(brief) === id);
  const only = owners[0];
  if (owners.length === 1 && only !== undefined) {
    return { kind: "bound", path: only.path };
  }
  if (owners.length > 1) {
    return {
      kind: "refuse",
      message: `worker-auth story_id ${id} matches ${owners.length} active briefs: ${fencedCandidates(owners.map((b) => b.path))}.`,
      denyKind: "multiple-eligible",
    };
  }
  return {
    kind: "refuse",
    message: `worker-auth story_id ${id} does not match an active brief (lost pin?). Active: ${fencedCandidates(briefs.map((b) => b.path))}.`,
    denyKind: "pin-miss",
  };
}

/**
 * Worker-auth untied + foreign-live refuse (#5855 Recut-8). Successful absence
 * admits; null commonDir / unreadable / indexed-missing refuse; present story_id
 * binds; foreign live lease refuses; self-lease and absent/stale occupancy admit.
 */
function admitUntiedWithWorkerAuth(
  scanned: readonly string[],
  briefs: readonly { path: string; data: Record<string, unknown> | null }[],
  options: BranchStoryBindOptions,
): BranchStoryBind {
  const projectRoot = options.projectRoot ?? process.cwd();
  const reader = options.readWorkerAuthAssignment ?? readWorkerAuthAssignment;
  const read = reader(projectRoot);
  if (!read.ok) {
    return {
      kind: "refuse",
      message: `worker-auth assignment unreadable or incomplete (${read.failureKind}): ${read.detail}`,
      denyKind: "pin-miss",
    };
  }
  if (read.commonDir === null) {
    return {
      kind: "refuse",
      message: "worker-auth: null Git common dir; refuse admitted-untied (#5855).",
      denyKind: "pin-miss",
    };
  }
  if (read.assignment !== null) {
    return matchStoryIdToActive(briefs, read.assignment.story_id);
  }
  const liveReader = options.liveOccupant ?? liveOccupant;
  const live = liveReader(projectRoot);
  if (live !== null) {
    const env = options.env ?? process.env;
    const caller = (env[CALLER_SESSION_ENV] ?? "").trim();
    const admissionFn = options.occupancyAdmission ?? occupancyAdmission;
    const admission = admissionFn(live, caller);
    if (admission === "stranger") {
      return {
        kind: "refuse",
        message:
          `foreign live occupancy lease on worktree (occupant=${live.sessionId}); ` +
          `refuse admitted-untied soft-missing (#5855). Active: ${fencedCandidates(scanned)}.`,
        denyKind: "pin-miss",
      };
    }
  }
  return { kind: "untied" };
}

/**
 * Write-fence story binding for a dispatch-registered linked worktree (#6233).
 *
 * - `none`: the main worktree (the registry is not read), or a linked worktree
 *   whose validated reader reports no assignment. The caller keeps today's
 *   selection (env pin, spawn bound path, single eligible, multiple-eligible).
 * - `bound`: the assignment's `story_id` matches exactly one active brief and
 *   that brief is implementation-eligible.
 * - `refuse`: the reader failed, the assigned story is missing, ineligible or
 *   ambiguous, or an env pin / spawn bound path names a different story.
 *
 * There is no `untied` outcome and no branch-token match: only the assignment
 * record binds a story here.
 */
export type WorktreeStoryBinding =
  | { readonly kind: "none" }
  | { readonly kind: "bound"; readonly path: string; readonly storyId: string }
  | { readonly kind: "refuse"; readonly failureKind: string; readonly message: string };

/** Refusal kinds the resolver adds to the reader's own failure kinds (#6233). */
export const WORKTREE_STORY_COMMON_DIR_UNRESOLVED = "common_dir_unresolved";
export const WORKTREE_STORY_MISSING = "assigned_story_missing";
export const WORKTREE_STORY_INELIGIBLE = "assigned_story_ineligible";
export const WORKTREE_STORY_AMBIGUOUS = "assigned_story_ambiguous";
export const WORKTREE_STORY_ENV_PIN_CONFLICT = "env_pin_conflict";
export const WORKTREE_STORY_BOUND_PATH_CONFLICT = "bound_path_conflict";

export interface ResolveWorktreeStoryBindingOptions {
  /** Hook environ bag; the env pin is read from here (default `process.env`). */
  readonly env?: NodeJS.ProcessEnv;
  /** Spawn-time bound path (dest unique basename), when the tool is a spawn. */
  readonly boundPath?: string | null;
  /** Injectable worker-auth reader (tests). */
  readonly readWorkerAuthAssignment?: (cwd: string) => ReadWorkerAuthAssignmentResult;
  /** Injectable linked-worktree predicate (tests). */
  readonly isLinkedWorktree?: (root: string) => boolean;
  /** Injectable eligibility check (tests); defaults to the xBRIEF preflight evaluator. */
  readonly isEligible?: (briefPath: string) => { readonly ok: boolean; readonly message: string };
}

function refuseBinding(failureKind: string, detail: string, repair: string): WorktreeStoryBinding {
  return {
    kind: "refuse",
    failureKind,
    message:
      `Worktree story binding refused (${failureKind}): ${detail} ` +
      `Repair: ${repair} (#6233).`,
  };
}

function defaultEligible(briefPath: string): { ok: boolean; message: string } {
  const result = evaluate(briefPath, { skipOriginFreshness: true });
  return { ok: result.exitCode === 0, message: result.message };
}

export function resolveWorktreeStoryBinding(
  worktreeRoot: string,
  options: ResolveWorktreeStoryBindingOptions = {},
): WorktreeStoryBinding {
  const isLinked = options.isLinkedWorktree ?? isLinkedWorktreePath;
  if (!isLinked(worktreeRoot)) return { kind: "none" };
  const reader = options.readWorkerAuthAssignment ?? readWorkerAuthAssignment;
  const read = reader(worktreeRoot);
  const reRegister =
    "the parent re-registers this worktree through `deft swarm:launch` (dispatch PREP rewrites its worker-auth record)";
  if (!read.ok) {
    return refuseBinding(
      read.failureKind,
      `the worker-auth registry cannot say which story this linked worktree belongs to: ${fenceUntrustedAcceptanceText(read.detail)}.`,
      reRegister,
    );
  }
  if (read.commonDir === null) {
    return refuseBinding(
      WORKTREE_STORY_COMMON_DIR_UNRESOLVED,
      "the Git common directory of this linked worktree cannot be resolved, so its worker-auth registration is unknowable.",
      "run the write from a worktree where `git rev-parse --git-common-dir` succeeds",
    );
  }
  if (read.assignment === null) return { kind: "none" };

  const storyId = read.assignment.story_id.trim();
  const fencedId = fenceUntrustedAcceptanceText(storyId);
  const scanned = listActiveLifecycleArtifacts(worktreeRoot).paths;
  const owners = scanned.filter(
    (path) => storyId.length > 0 && briefStoryId({ path, data: readBriefRecord(path) }) === storyId,
  );
  if (owners.length > 1) {
    return refuseBinding(
      WORKTREE_STORY_AMBIGUOUS,
      `assigned story ${fencedId} matches ${owners.length} active briefs (${fencedCandidates(owners)}).`,
      "give each active brief a unique plan.id",
    );
  }
  const owner = owners[0];
  if (owner === undefined) {
    return refuseBinding(
      WORKTREE_STORY_MISSING,
      `assigned story ${fencedId} matches no brief under xbrief/active/ in this worktree.`,
      "activate the assigned story's brief in this worktree (`deft scope:activate -- <brief>`)",
    );
  }
  const eligible = (options.isEligible ?? defaultEligible)(owner);
  if (!eligible.ok) {
    return refuseBinding(
      WORKTREE_STORY_INELIGIBLE,
      `assigned story ${fencedId} (${fenceActiveScopeName(owner)}) is not implementation-eligible: ${eligible.message}`,
      "run `deft xbrief:preflight -- <assigned-brief>` in this worktree and fix what it reports",
    );
  }

  const bound = options.boundPath?.trim() ?? "";
  if (bound.length > 0 && matchPinnedActiveScope(worktreeRoot, bound, scanned) !== owner) {
    return refuseBinding(
      WORKTREE_STORY_BOUND_PATH_CONFLICT,
      `the spawn bound path ${fencePinValue(bound)} names a different story than the worktree assignment ${fencedId}.`,
      "spawn into the worktree registered for that story",
    );
  }
  const envPin = (options.env ?? process.env)[ACTIVE_SCOPE_PIN_ENV]?.trim() ?? "";
  if (envPin.length > 0 && matchPinnedActiveScope(worktreeRoot, envPin, scanned) !== owner) {
    return refuseBinding(
      WORKTREE_STORY_ENV_PIN_CONFLICT,
      `${ACTIVE_SCOPE_PIN_ENV} ${fencePinValue(envPin)} names a different story than the worktree assignment ${fencedId}.`,
      `clear ${ACTIVE_SCOPE_PIN_ENV} for this worker (the worktree assignment names its story)`,
    );
  }
  return { kind: "bound", path: owner, storyId };
}

function formatUntiedSoftMissingMessage(scanned: readonly string[]): string {
  return (
    `verify:ac skipped (#3284 soft-missing): untied maintainer branch, no story AC executed (#5855). ` +
    `Active (not evaluated): ${fencedCandidates(scanned)}.`
  );
}

function gitOutput(projectRoot: string, args: readonly string[]): string | null {
  try {
    const out = execFileSync("git", [...args], {
      cwd: projectRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

/** Local-only branch + origin slug for {@link bindBranchToActiveStory} (#5855). */
export function readBranchBindContext(projectRoot: string): {
  readonly branch: string | null;
  readonly repoSlug: string | null;
} {
  const branch = gitOutput(projectRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const url = gitOutput(projectRoot, ["config", "--get", "remote.origin.url"]) ?? "";
  const match = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(url);
  return { branch, repoSlug: match ? `${match[1]}/${match[2]}` : null };
}

/**
 * Canonical worktree key for admitted-untied pushBinding evidence (#5855 Recut-8).
 */
export function admittedUntiedWorktreeKey(projectRoot: string): string {
  return resolveWorkerAuthDestPath(projectRoot);
}

/**
 * Push-admit story selection (#5855 P3): with several actives, a push is
 * refused when selection is need-pin / unresolved. Bound or admitted-untied
 * selection alone is not enough for no-obligation — push also requires
 * positively known disposition evidence on PrePrPushBinding (see pre-push).
 * Returns the refusal text, or null when selection may proceed.
 */
export function pushStoryAdmissionRefusal(
  projectRoot: string,
  localRef: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const scanned = listActiveLifecycleArtifacts(projectRoot).paths;
  if (scanned.length <= 1) return null;
  const context = readBranchBindContext(projectRoot);
  const branch = localRef?.startsWith("refs/heads/")
    ? localRef.slice("refs/heads/".length)
    : context.branch;
  const resolved = resolveSoftMissingAcTargets(projectRoot, {
    env,
    scannedPaths: scanned,
    branchBind: { branch, env, repoSlug: context.repoSlug, projectRoot },
  });
  return resolved.kind === "need-pin" ? resolved.message : null;
}
