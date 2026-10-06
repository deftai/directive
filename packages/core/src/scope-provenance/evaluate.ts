/**
 * verify:scope-provenance evaluation (#3145 / #4956 / #4774 / #5192 / #5412).
 *
 * Path fence (#4956): the active brief's `file_scope` on the merge base is the
 * precommitment. Changed production files are checked against that base list
 * plus a concrete-file allowance (floor 2, cap 5). Test-root paths spend
 * nothing on the production fence. Head brief edits do not widen the fence.
 * Proceed writes no `.deft/approved-scope` digest for that fence and must not
 * demand `scope:record-approved-scope` as remint remediation.
 *
 * Membership (#4774 / #5192): when the bound story is in the change set, the
 * allowlist is a human-stamped merge-base mint for the continuity-resolved
 * story when present (planId match ignores stale xbriefRelPath; no-plan.id is
 * path-first + basename-keyed mint). Missing mint falls to the merge-base
 * brief's **concrete** file_scope as agent precommitment. Glob matches do not
 * admit without a mint. Source-root extras spend production allowance; test /
 * fixture and other undeclared paths must match. xBRIEF-only change sets may
 * omit a mint. Peer coverage never clears a missing own allowlist. Same-PR
 * approval rewrite stays fail-closed. Missing-mint remediation is split or
 * land a widened concrete brief — never renew mint.
 *
 * Changed-lifecycle admission (#5192 item 6 / #5412): live discovery and an
 * injected activeXbriefs map share one predicate. Seed is live xbrief/active/
 * or injected non-pending entries; pending paths (live or injected) admit
 * only when active on the merge base. Brand-new pending that was never
 * active on base must not become an active scope via the diff or the map.
 *
 * Intent-pin checks (#3385) remain for existing base-committed records.
 *
 * Three-state exit: 0 clean / 1 fence violation / 2 config.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { GitCommandError, GitNotFoundError } from "../encoding/git.js";
import { loadTestBoundaryPolicy } from "../test-boundary/policy.js";
import {
  evaluateApprovedScopeMembership,
  evaluateProductionScopeFence,
  isConcreteFileScopeEntry,
  type MembershipAllowlistAuthority,
  pathMatchesFileScope,
} from "./base-fence.js";
import {
  type CensusBrief,
  type ContinuityResolution,
  censusFromBaseMap,
  continuityExemptPaths,
  isLifecycleXbriefPath,
  LIFECYCLE_FOLDERS,
  preMoveSameBasenameLifecyclePaths,
  resolveStoryContinuity,
  sameBasenameLifecyclePaths,
} from "./continuity.js";
import {
  type ApprovedScopeRecord,
  approvedScopeIntentRel,
  approvedScopeSafePlanId,
  computeFileScopeDigest,
  extractFileScope,
  extractPlanId,
  isHumanApprovalStamp,
  listApprovedScopeRecords,
  normalizeFileScope,
  readApprovedScopeRecord,
} from "./digest.js";
import { bodyDigestIsAuthority, evaluateIntentForXbrief } from "./intent-evaluate.js";
import { recoverApprovedScopePairs } from "./mint-artifacts.js";

export type ScopeProvenanceViolationKind =
  | "self-authorizing-scope-expansion"
  | "production-scope-over-budget"
  | "active-xbrief-modified-without-digest"
  | "change-set-outside-approved-scope"
  | "digest-mismatch-without-renewal"
  | "intent-drift"
  | "unclassified-key"
  | "intent-digest-mismatch"
  | "duplicate-key"
  | "duplicate-item-id"
  | "same-pr-intent-rewrite"
  | "first-activation-missing-intent-pin"
  | "legacy-intent-edit"
  | "intent-parse-error";

export interface ScopeProvenanceFinding {
  readonly xbriefRelPath: string;
  readonly planId: string;
  readonly kind: ScopeProvenanceViolationKind;
  readonly expandedPaths: readonly string[];
  readonly detail: string;
  readonly remediation: string;
}

export interface ScopeProvenanceResult {
  readonly exitCode: 0 | 1 | 2;
  readonly findings: readonly ScopeProvenanceFinding[];
  readonly message: string;
}

export interface ScopeProvenanceOptions {
  /**
   * When true, missing digests on modified active xBRIEFs fail closed.
   * Default false = migration warn path.
   */
  readonly enforce?: boolean;
  /** Base ref for diff (default HEAD). */
  readonly baseRef?: string;
  /** Inject changed files (repo-relative POSIX). */
  readonly changedFiles?: readonly string[];
  /** Inject active xBRIEF payloads: relPath -> raw JSON text. */
  readonly activeXbriefs?: ReadonlyMap<string, string>;
  /** Inject approved records (skips disk). */
  readonly approvedRecords?: readonly ApprovedScopeRecord[];
  /**
   * Inject merge-base approved-scope records keyed by planId (#4774 membership).
   * When set, membership reads these instead of `git show` / readAtBase for the
   * approval path. Absent key means missing on the merge base.
   */
  readonly baseApprovedRecords?: ReadonlyMap<string, ApprovedScopeRecord>;
  /** Inject renewed-approval stamps keyed by planId (test seam). */
  readonly renewedApprovals?: ReadonlyMap<string, ApprovedScopeRecord["humanApproval"]>;
  /** Inject `git show <base>:<rel>` (test seam; never working-tree). */
  readonly readAtBase?: (relPath: string) => string | null;
  /**
   * Inject merge-base active xBRIEF payloads (relPath -> raw JSON).
   * When set, path fencing reads these instead of `readAtBase` / git show.
   */
  readonly baseXbriefs?: ReadonlyMap<string, string>;
  /** Optional repo slug seed for live extract (mint uses resolveProjectRepo). */
  readonly approvedReposSeed?: readonly string[];
  /** Override test-boundary roots for the production fence (tests). */
  readonly testRoots?: readonly string[];
  readonly fixtureRoots?: readonly string[];
  readonly sourceRoots?: readonly string[];
}

function git(args: string[], projectRoot: string): { status: number; stdout: string } {
  const result = spawnSync("git", args, {
    cwd: projectRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error !== undefined) {
    const e = result.error as NodeJS.ErrnoException;
    if (e.code === "ENOENT") {
      throw new GitNotFoundError("'git' executable not found on PATH");
    }
    throw new GitCommandError(`git ${args.join(" ")} failed: ${String(e.message)}`);
  }
  // Signal-killed subprocesses report status=null; never treat as clean exit (SLizard P1).
  if (result.signal !== null && result.signal !== undefined) {
    throw new GitCommandError(`git ${args.join(" ")} killed by signal ${String(result.signal)}`);
  }
  const status = result.status ?? 1;
  const stderr = String(result.stderr ?? "").trim();
  // Surface stderr on failure so callers can distinguish "not a git repository".
  if (status !== 0 && stderr.length > 0) {
    return { status, stdout: `${result.stdout ?? ""}\n${stderr}` };
  }
  return { status, stdout: result.stdout ?? "" };
}

/**
 * Resolve a PR-aware base ref. Bare `HEAD` only shows uncommitted changes, so
 * CI/PR checkouts would miss committed active-xBRIEF expansion. Prefer
 * origin/master (or main) for merge-base comparison.
 * Returns null when no merge-base candidate exists (caller fails closed).
 */
export function resolveDefaultBaseRef(projectRoot: string): string | null {
  const envCandidates = [
    process.env.DEFT_BASE_REF,
    process.env.GITHUB_BASE_REF ? `origin/${process.env.GITHUB_BASE_REF}` : undefined,
    process.env.GITHUB_BASE_REF,
  ].filter((x): x is string => typeof x === "string" && x.trim().length > 0);
  for (const cand of [...envCandidates, "origin/master", "origin/main", "master", "main"]) {
    if (git(["rev-parse", "--verify", "-q", cand], projectRoot).status === 0) {
      return cand;
    }
  }
  return null;
}

/**
 * Normalize git --name-only paths (including C-quoted paths).
 * Decode C-quotes BEFORE converting remaining backslashes to `/` so escape
 * sequences are not destroyed. Consecutive octal escapes decode as UTF-8
 * bytes (e.g. \\303\\251 → é) so Unicode xBRIEF paths match filesystem names.
 */
export function unquoteGitPath(raw: string): string {
  const t = raw.replace(/\r$/, "").trim();
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
    let inner = t.slice(1, -1);
    // First: runs of octal bytes → UTF-8 (Git encodes non-ASCII this way)
    inner = inner.replace(/(?:\\[0-7]{1,3})+/g, (seq) => {
      const bytes: number[] = [];
      for (const m of seq.matchAll(/\\([0-7]{1,3})/g)) {
        bytes.push(parseInt(m[1] ?? "0", 8));
      }
      try {
        return Buffer.from(bytes).toString("utf8");
      } catch {
        return String.fromCharCode(...bytes);
      }
    });
    // Then: standard single-char escapes
    inner = inner.replace(/\\([abtnvfr"'\\])/g, (_m, ch: string) => {
      const map: Record<string, string> = {
        a: "\x07",
        b: "\b",
        t: "\t",
        n: "\n",
        v: "\v",
        f: "\f",
        r: "\r",
        '"': '"',
        "'": "'",
        "\\": "\\",
      };
      return map[ch] ?? ch;
    });
    return inner.replace(/\\/g, "/");
  }
  return t.replace(/\\/g, "/");
}

function isGitMissingPathDetail(detail: string): boolean {
  const s = detail.toLowerCase();
  return (
    s.includes("does not exist") ||
    s.includes("exists on disk, but not in") ||
    s.includes("pathspec")
  );
}

type ReadRepoFileAtRefResult =
  | { readonly status: "ok"; readonly text: string }
  | { readonly status: "missing" }
  | { readonly status: "error"; readonly message: string };

/** Read a repo-relative path as of `ref` (missing vs other git failures distinguished). */
function readRepoFileAtRef(
  projectRoot: string,
  ref: string,
  relPath: string,
): ReadRepoFileAtRefResult {
  const path = relPath.replace(/\\/g, "/").replace(/^\.\//, "");
  const result = git(["show", `${ref}:${path}`], projectRoot);
  if (result.status === 0) return { status: "ok", text: result.stdout };
  const detail = result.stdout.trim();
  if (isGitMissingPathDetail(detail)) return { status: "missing" };
  return {
    status: "error",
    message: `git show ${ref}:${path} failed: ${detail.length > 0 ? detail : `exit ${String(result.status)}`}`,
  };
}

function changedFilesVsBase(projectRoot: string, baseRef: string): string[] {
  const inside = git(["rev-parse", "--is-inside-work-tree"], projectRoot);
  if (inside.status !== 0) {
    throw new GitCommandError("not a git working tree");
  }
  // Normalize: if caller passed HEAD, upgrade to default branch so PR commits
  // are visible (Greptile P1 / #3145). Never silently fall back to bare HEAD.
  let resolved = baseRef;
  if (baseRef === "HEAD" || baseRef === "") {
    const upgraded = resolveDefaultBaseRef(projectRoot);
    if (upgraded === null) {
      throw new GitCommandError(
        "no merge-base ref (origin/master|main or DEFT_BASE_REF/GITHUB_BASE_REF); " +
          "cannot evaluate committed PR scope expansion against bare HEAD",
      );
    }
    resolved = upgraded;
  }
  const hasBase = git(["rev-parse", "--verify", "-q", resolved], projectRoot).status === 0;
  if (!hasBase) {
    throw new GitCommandError(
      `base ref '${resolved}' not found; pass --base-ref or set DEFT_BASE_REF`,
    );
  }
  const out = new Set<string>();
  const addPath = (raw: string): void => {
    const t = normalizeRepoRelPath(unquoteGitPath(raw));
    if (t.length > 0) out.add(t);
  };
  // Triple-dot includes all commits on the branch relative to merge-base.
  const range = resolved === "HEAD" || resolved.includes("...") ? resolved : `${resolved}...HEAD`;
  const diff = git(["diff", "--name-only", range], projectRoot);
  if (diff.status === 0) {
    for (const line of diff.stdout.split("\n")) {
      addPath(line);
    }
  }
  // Also include working-tree changes vs HEAD (unstaged / staged / untracked).
  const vsHead = git(["diff", "--name-only", "HEAD"], projectRoot);
  if (vsHead.status === 0) {
    for (const line of vsHead.stdout.split("\n")) {
      addPath(line);
    }
  }
  const untracked = git(["ls-files", "--others", "--exclude-standard"], projectRoot);
  if (untracked.status === 0) {
    for (const line of untracked.stdout.split("\n")) {
      addPath(line);
    }
  }
  return [...out];
}

/** Normalize repo-relative paths for exact set membership (always POSIX separators). */
export function normalizeRepoRelPath(p: string): string {
  return p
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/{2,}/g, "/");
}

/**
 * True when `rel` appears in the changed-path set under any normalization that
 * Git C-quoting / slash folding may produce (Greptile conf=4 residual).
 */
export function changedSetHasPath(changedSet: ReadonlySet<string>, rel: string): boolean {
  const candidates = new Set<string>([
    normalizeRepoRelPath(rel),
    normalizeRepoRelPath(unquoteGitPath(rel)),
    rel.replace(/\\/g, "/"),
  ]);
  for (const c of candidates) {
    if (changedSet.has(c)) return true;
  }
  const want = normalizeRepoRelPath(rel);
  const wantBase = want.split("/").pop() ?? want;
  for (const p of changedSet) {
    const n = normalizeRepoRelPath(p);
    if (candidates.has(n)) return true;
    // Same leaf under xbrief/active/ (C-quote / escape divergence)
    if (
      want.includes("xbrief/active/") &&
      n.includes("xbrief/active/") &&
      (n.split("/").pop() ?? n) === wantBase
    ) {
      return true;
    }
  }
  return false;
}

function listActiveXbriefPaths(projectRoot: string): string[] {
  const activeDir = join(projectRoot, "xbrief", "active");
  if (!existsSync(activeDir)) return [];
  return readdirSync(activeDir)
    .filter((n) => n.endsWith(".xbrief.json") || n.endsWith(".vbrief.json"))
    .map((n) => `xbrief/active/${n}`);
}

type BaseBriefReadLocal =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "missing" }
  | { readonly kind: "error"; readonly message: string };

type LifecycleCensusResult =
  | { readonly kind: "ok"; readonly briefs: CensusBrief[] }
  | { readonly kind: "error"; readonly detail: string };

/**
 * Merge-base lifecycle census via git ls-tree + readAtBase (#5192).
 * Fail closed on ls-tree / read / parse errors so duplicate plan.id identities
 * cannot hide behind a partial census.
 */
function listLifecycleBriefsAtRef(
  projectRoot: string,
  baseRef: string,
  readAtBase: (rel: string) => BaseBriefReadLocal,
): LifecycleCensusResult {
  const out: CensusBrief[] = [];
  for (const folder of LIFECYCLE_FOLDERS) {
    const listed = git(["ls-tree", "-r", "--name-only", baseRef, `xbrief/${folder}`], projectRoot);
    if (listed.status !== 0) {
      return {
        kind: "error",
        detail:
          `merge-base lifecycle census ls-tree failed for xbrief/${folder} at ${baseRef} ` +
          `(exit ${String(listed.status)}); refuse rather than hide duplicate identities (#5192)`,
      };
    }
    for (const line of listed.stdout.split("\n")) {
      const rel = normalizeRepoRelPath(unquoteGitPath(line));
      if (!isLifecycleXbriefPath(rel)) continue;
      const read = readAtBase(rel);
      if (read.kind === "missing") {
        return {
          kind: "error",
          detail:
            `merge-base lifecycle census missing ${rel} after ls-tree listed it; ` +
            "refuse rather than hide duplicate identities (#5192)",
        };
      }
      if (read.kind === "error") {
        return {
          kind: "error",
          detail:
            `merge-base lifecycle census read failed for ${rel}: ${read.message}; ` +
            "refuse rather than hide duplicate identities (#5192)",
        };
      }
      try {
        const payload = JSON.parse(read.text) as unknown;
        out.push({
          rel,
          planId: extractPlanId(payload),
          raw: read.text,
          payload,
        });
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        return {
          kind: "error",
          detail:
            `merge-base lifecycle census unreadable JSON at ${rel}: ${detail}; ` +
            "refuse rather than hide duplicate identities (#5192)",
        };
      }
    }
  }
  return { kind: "ok", briefs: out };
}

/**
 * Resolve the merge-base brief used by the production fence and Path B
 * membership precommitment (#5192). Continuity wins; otherwise probe
 * same-basename pre-move paths (active before pending) when the head
 * completed/cancelled path is absent on base. A same-basename candidate
 * may supply scope only when it is absent from HEAD — otherwise an
 * unrelated live brief would authorize the completed story.
 */
function resolveMergeBaseBriefRead(
  rel: string,
  continuity: ContinuityResolution,
  readAtBase: (baseRel: string) => BaseBriefReadLocal,
  headLifecycleRels: ReadonlySet<string> | readonly string[],
): { readonly baseRel: string; readonly read: BaseBriefReadLocal } {
  if (continuity.kind === "resolved") {
    return { baseRel: continuity.baseRel, read: readAtBase(continuity.baseRel) };
  }
  const headN = normalizeRepoRelPath(rel);
  const headRead = readAtBase(headN);
  if (headRead.kind !== "missing") {
    return { baseRel: headN, read: headRead };
  }
  if (!(headN.startsWith("xbrief/completed/") || headN.startsWith("xbrief/cancelled/"))) {
    return { baseRel: headN, read: headRead };
  }
  const headSet =
    headLifecycleRels instanceof Set
      ? headLifecycleRels
      : new Set([...headLifecycleRels].map((p) => normalizeRepoRelPath(p)));
  for (const candidate of preMoveSameBasenameLifecyclePaths(headN)) {
    // Still on HEAD → different story sharing the leaf name, not a move.
    if (headSet.has(candidate)) continue;
    const alt = readAtBase(candidate);
    if (alt.kind === "text") {
      return { baseRel: candidate, read: alt };
    }
    if (alt.kind === "error") {
      return { baseRel: candidate, read: alt };
    }
  }
  return { baseRel: headN, read: headRead };
}

/** True when a lifecycle path is pending|completed|cancelled (#5412 limb 1). */
function isMovedLifecycleFolder(rel: string): boolean {
  const n = normalizeRepoRelPath(rel);
  return (
    n.startsWith("xbrief/pending/") ||
    n.startsWith("xbrief/completed/") ||
    n.startsWith("xbrief/cancelled/")
  );
}

/**
 * Active-on-merge-base probe for changed-lifecycle admission (#5412 / #5192).
 * Reuses preMoveSameBasenameLifecyclePaths (active before pending) and optional
 * listLifecycleBriefsAtRef / baseXbriefs census for plan.id hits. Unreadable
 * base probes and census read failures fail closed by returning true so later
 * gates can surface (renamed moves must not silently drop the fence).
 */
function wasActiveOnMergeBase(input: {
  readonly headRel: string;
  readonly headPlanId: string | null;
  readonly readAtBase: (rel: string) => BaseBriefReadLocal;
  readonly census: readonly CensusBrief[] | null;
  readonly censusReadFailed?: boolean;
  /** changedFiles-injected snapshot seam — no fail-closed admit on missing census. */
  readonly changedFilesInjected?: boolean;
}): boolean {
  const headN = normalizeRepoRelPath(input.headRel);
  for (const candidate of preMoveSameBasenameLifecyclePaths(headN)) {
    if (!candidate.startsWith("xbrief/active/")) continue;
    const read = input.readAtBase(candidate);
    if (read.kind === "error") return true;
    if (read.kind === "text") return true;
    break;
  }
  if (input.headPlanId === null) return false;
  if (input.census === null) {
    // Live / activeXbriefs-only: admit on census read failure so renamed moves
    // and membership identity checks cannot drop the fence. changedFiles-
    // injected snapshots must supply baseXbriefs for plan.id rename matching.
    return input.censusReadFailed === true && input.changedFilesInjected !== true;
  }
  const activeHits = input.census.filter(
    (b) =>
      normalizeRepoRelPath(b.rel).startsWith("xbrief/active/") &&
      b.planId !== null &&
      b.planId === input.headPlanId,
  );
  // Ambiguous duplicate active plan.id → admit so continuity refuse can fire.
  return activeHits.length >= 1;
}

/** Head lifecycle paths for continuity move exclusivity (#5192). */
function listHeadLifecycleRels(input: {
  readonly projectRoot: string;
  readonly activeEntries: readonly { readonly rel: string }[];
  readonly changedSet: ReadonlySet<string>;
  readonly baseXbriefs?: ReadonlyMap<string, string>;
  readonly injected: boolean;
}): string[] {
  const out = new Set(input.activeEntries.map((e) => normalizeRepoRelPath(e.rel)));
  if (input.injected) {
    // Unchanged base lifecycle paths remain on HEAD when absent from the change set.
    if (input.baseXbriefs !== undefined) {
      for (const relRaw of input.baseXbriefs.keys()) {
        const rel = normalizeRepoRelPath(relRaw);
        if (!isLifecycleXbriefPath(rel)) continue;
        if (!changedSetHasPath(input.changedSet, rel)) out.add(rel);
      }
    }
    return [...out];
  }
  for (const folder of LIFECYCLE_FOLDERS) {
    const dir = join(input.projectRoot, "xbrief", folder);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".xbrief.json") && !name.endsWith(".vbrief.json")) continue;
      out.add(`xbrief/${folder}/${name}`);
    }
  }
  return [...out];
}

/**
 * Parse + lightly validate an approved-scope JSON blob (base-ref `git show` or disk).
 * Returns null when schema fields required for authorization are missing/malformed.
 */
export function parseApprovedScopeRecordRaw(raw: string): ApprovedScopeRecord | null {
  try {
    const data = JSON.parse(raw) as unknown;
    if (data === null || typeof data !== "object" || Array.isArray(data)) return null;
    const rec = data as Record<string, unknown>;
    if (rec.schemaVersion !== undefined && rec.schemaVersion !== 1) return null;
    if (typeof rec.planId !== "string" || rec.planId.trim().length === 0) return null;
    if (typeof rec.xbriefRelPath !== "string" || rec.xbriefRelPath.trim().length === 0) {
      return null;
    }
    if (typeof rec.fileScopeDigest !== "string" || rec.fileScopeDigest.length === 0) {
      return null;
    }
    if (!Array.isArray(rec.fileScope)) return null;
    // Digest must match the recorded path list — never trust a forged digest alone (#3205 Greptile).
    const scopePaths = rec.fileScope.filter((x): x is string => typeof x === "string");
    const expected = computeFileScopeDigest(scopePaths);
    if (rec.fileScopeDigest !== expected) return null;
    // xbriefBodyDigest is never authority (#3385 F4 / R6) — ignored if present.
    bodyDigestIsAuthority(data as ApprovedScopeRecord);
    return data as ApprovedScopeRecord;
  } catch {
    return null;
  }
}

/**
 * True when the merge-base approved-scope record authorizes the current scope and
 * the current disk record is semantically unchanged from that base authority (#3205).
 *
 * Authority comes from the approval record on the base, not from whether the active
 * xBRIEF path existed on the base (pending→active is the normal first activation).
 */
export function baseApprovalAuthorizesCurrent(input: {
  readonly projectRoot: string;
  readonly baseRef: string | null;
  readonly approvalRecordRel: string;
  readonly planId: string;
  readonly xbriefRelPath: string;
  readonly currentDigest: string;
  readonly currentApproved: ApprovedScopeRecord;
}): boolean {
  if (input.baseRef === null || input.baseRef === "") return false;
  const baseRead = readRepoFileAtRef(input.projectRoot, input.baseRef, input.approvalRecordRel);
  // Fail closed: a base-read error cannot authorize expansion.
  if (baseRead.status !== "ok") return false;
  const baseRaw = baseRead.text;
  const baseRec = parseApprovedScopeRecordRaw(baseRaw);
  if (baseRec === null) return false;
  if (!isHumanApprovalStamp(baseRec.humanApproval)) return false;
  if (baseRec.planId !== input.planId) return false;
  if (normalizeRepoRelPath(baseRec.xbriefRelPath) !== normalizeRepoRelPath(input.xbriefRelPath)) {
    return false;
  }
  // Base record must authorize the *current* file_scope (digest match).
  if (baseRec.fileScopeDigest !== input.currentDigest) return false;
  // Current on-disk/injected record must not diverge from base authority fields.
  if (input.currentApproved.fileScopeDigest !== baseRec.fileScopeDigest) return false;
  if (input.currentApproved.planId !== baseRec.planId) return false;
  if (
    normalizeRepoRelPath(input.currentApproved.xbriefRelPath) !==
    normalizeRepoRelPath(baseRec.xbriefRelPath)
  ) {
    return false;
  }
  if (!isHumanApprovalStamp(input.currentApproved.humanApproval)) return false;
  return true;
}

function configError(message: string): ScopeProvenanceResult {
  return { exitCode: 2, findings: [], message };
}

/**
 * Legacy head-brief-vs-digest evaluator.
 *
 * #4956 retires mint-on-proceed and head-brief self-auth for the path fence.
 * Callers must use {@link evaluateProductionScopeFence} against the merge-base
 * brief. This function always returns null so older unit seams stay importable
 * without reintroducing `scope:record-approved-scope` remediations.
 */
export function evaluateOneScopeProvenance(_input: {
  readonly xbriefRelPath: string;
  readonly currentPayload: unknown;
  readonly approved: ApprovedScopeRecord | null;
  readonly xbriefModifiedInChangeSet: boolean;
  readonly enforce: boolean;
  readonly renewedHumanApproval?: ApprovedScopeRecord["humanApproval"] | null;
}): ScopeProvenanceFinding | null {
  void _input;
  return null;
}

/**
 * Evaluate scope provenance for a project (or pure injected seams).
 */
export function evaluateScopeProvenance(
  projectRoot: string,
  options: ScopeProvenanceOptions = {},
): ScopeProvenanceResult {
  const root = resolve(projectRoot);
  // `enforce` retained for CLI/API compat; path fence is always hard (#4956).
  void (options.enforce ?? false);
  recoverApprovedScopePairs(root);

  let changed: string[];
  /** Merge-base ref used for changed-file discovery (null when files injected). */
  let discoveryBaseRef: string | null = null;
  try {
    if (options.changedFiles !== undefined) {
      changed = [...options.changedFiles].map((p) => p.replace(/\\/g, "/"));
      // Prefer explicit baseRef for base-scope comparisons; do not force git
      // discovery on pure injected-seam tests (cwd may not be a repo).
      if (options.baseRef !== undefined && options.baseRef !== "" && options.baseRef !== "HEAD") {
        discoveryBaseRef = options.baseRef;
      } else {
        try {
          discoveryBaseRef = resolveDefaultBaseRef(root);
        } catch {
          discoveryBaseRef = null;
        }
      }
    } else {
      // Default is PR-aware (origin/master...), not bare HEAD — bare HEAD misses
      // committed PR diffs on clean checkouts (#3145 Greptile P1).
      let baseRef = options.baseRef;
      if (baseRef === undefined || baseRef === "" || baseRef === "HEAD") {
        const resolved = resolveDefaultBaseRef(root);
        if (resolved === null) {
          // Greenfield / single-commit consumer trees often have no origin/* and no
          // default-branch ref yet. Fail closed only when the caller demanded an
          // explicit --base-ref; otherwise soft-skip (same posture as non-git trees)
          // so verify:scope-provenance does not brick `task check` on init (#3205 smoke).
          return {
            exitCode: 0,
            findings: [],
            message:
              "verify_scope_provenance: skipped -- no merge-base ref found " +
              "(origin/master|main, DEFT_BASE_REF, or GITHUB_BASE_REF). " +
              "Fetch the default branch or pass --base-ref <ref> before enforcing " +
              "PR scope expansion (#3145 / #3205).",
          };
        }
        baseRef = resolved;
      }
      discoveryBaseRef = baseRef;
      changed = changedFilesVsBase(root, baseRef);
    }
  } catch (err: unknown) {
    if (err instanceof GitNotFoundError) {
      return configError(
        "verify_scope_provenance: 'git' executable not found on PATH.\n" +
          "  Recovery: install git or run inside a git working tree.",
      );
    }
    if (err instanceof GitCommandError) {
      const msg = err.message.toLowerCase();
      // Only non-repo trees skip clean (greenfield smoke). Other git failures
      // fail closed so discovery errors cannot hide scope expansion (Greptile).
      if (
        msg.includes("not a git repository") ||
        msg.includes("outside repository") ||
        msg.includes("not a git working tree")
      ) {
        return {
          exitCode: 0,
          findings: [],
          message:
            `verify_scope_provenance: skipped -- not a git working tree (${err.message}). ` +
            "Initialize git or pass --base-ref / inject changedFiles (#3145).",
        };
      }
      return configError(
        `verify_scope_provenance: git failed -- ${err.message}\n` +
          "  Recovery: ensure --project-root points at a healthy git working tree.",
      );
    }
    throw err;
  }

  const changedSet = new Set(changed.map((p) => normalizeRepoRelPath(p)));
  const findings: ScopeProvenanceFinding[] = [];
  const softFindings: ScopeProvenanceFinding[] = [];

  const approvedByPlan = new Map<string, ApprovedScopeRecord>();
  if (options.approvedRecords !== undefined) {
    for (const r of options.approvedRecords) {
      approvedByPlan.set(r.planId, r);
    }
  } else {
    for (const r of listApprovedScopeRecords(root)) {
      approvedByPlan.set(r.planId, r);
    }
  }

  let activeEntries: Array<{ rel: string; raw: string }>;
  if (options.activeXbriefs !== undefined) {
    // Injected map is the seed for active/ and terminal completed|cancelled
    // entries (existing #5192 fixtures). Pending paths in the map still go
    // through wasActiveOnMergeBase so brand-new planning cannot bypass
    // admission by stuffing the map (#5412 Greptile P1).
    activeEntries = [];
    for (const [rel, raw] of options.activeXbriefs.entries()) {
      const n = normalizeRepoRelPath(rel);
      if (n.startsWith("xbrief/pending/")) continue;
      activeEntries.push({ rel: n, raw });
    }
  } else {
    activeEntries = [];
    for (const rel of listActiveXbriefPaths(root)) {
      const full = join(root, rel);
      if (!existsSync(full)) continue;
      try {
        activeEntries.push({ rel: normalizeRepoRelPath(rel), raw: readFileSync(full, "utf8") });
      } catch {
        // skip unreadable
      }
    }
  }

  // Shared readAtBase for admission + per-story evaluation (#5412 / #5192).
  const readAtBase = (baseRel: string): BaseBriefReadLocal => {
    if (options.baseXbriefs !== undefined) {
      const injected = options.baseXbriefs.get(normalizeRepoRelPath(baseRel));
      return injected === undefined ? { kind: "missing" } : { kind: "text", text: injected };
    }
    if (options.readAtBase !== undefined) {
      try {
        const injected = options.readAtBase(baseRel);
        return injected === null ? { kind: "missing" } : { kind: "text", text: injected };
      } catch (err) {
        return {
          kind: "error",
          message: err instanceof Error ? err.message : String(err),
        };
      }
    }
    if (discoveryBaseRef === null || discoveryBaseRef === "") return { kind: "missing" };
    const read = readRepoFileAtRef(root, discoveryBaseRef, baseRel);
    if (read.status === "ok") return { kind: "text", text: read.text };
    if (read.status === "missing") return { kind: "missing" };
    return { kind: "error", message: read.message };
  };

  // Admission census: injected base map, else live listLifecycleBriefsAtRef.
  // Lazy until a moved-lifecycle candidate needs plan.id matching; shared with
  // the per-story membership loop below (#5412 Greptile P1/P2). Only
  // changedFiles-injected seams without baseXbriefs skip live ls-tree
  // (isolated snapshot callers). activeXbriefs-only on a real checkout still
  // runs the census so membership fail-closed identity checks remain.
  const changedFilesInjected = options.changedFiles !== undefined;
  let admissionCensus: readonly CensusBrief[] | null = null;
  let admissionCensusReadFailed = false;
  let admissionCensusResolved = false;
  const ensureAdmissionCensus = (): void => {
    if (admissionCensusResolved) return;
    admissionCensusResolved = true;
    if (options.baseXbriefs !== undefined) {
      admissionCensus = censusFromBaseMap(options.baseXbriefs);
      return;
    }
    if (changedFilesInjected) return;
    if (discoveryBaseRef === null || discoveryBaseRef === "") return;
    try {
      const listed = listLifecycleBriefsAtRef(root, discoveryBaseRef, readAtBase);
      if (listed.kind === "ok") admissionCensus = listed.briefs;
      else admissionCensusReadFailed = true;
    } catch {
      admissionCensusReadFailed = true;
    }
  };
  if (options.baseXbriefs !== undefined) ensureAdmissionCensus();

  // #5192 item 6 / #5412: shared live+injected changed-lifecycle admission.
  // Seed is live xbrief/active/ or injected non-pending entries. Admit a
  // changed pending|completed|cancelled brief only when it was active on the
  // merge base — never bind brand-new pending solely because it is in the
  // diff or the injected map.
  const seenEvalRels = new Set(activeEntries.map((e) => e.rel));
  for (const changedRel of changed) {
    const n = normalizeRepoRelPath(changedRel);
    if (!isLifecycleXbriefPath(n) || seenEvalRels.has(n)) continue;
    if (!isMovedLifecycleFolder(n)) continue;

    let raw: string | undefined;
    if (options.activeXbriefs !== undefined) {
      const injected = options.activeXbriefs.get(n);
      if (injected !== undefined) raw = injected;
    }
    if (raw === undefined) {
      const full = join(root, n);
      if (!existsSync(full)) continue;
      try {
        raw = readFileSync(full, "utf8");
      } catch {
        continue;
      }
    }

    let headPlanId: string | null = null;
    try {
      headPlanId = extractPlanId(JSON.parse(raw) as unknown);
    } catch {
      headPlanId = null;
    }
    ensureAdmissionCensus();
    if (
      !wasActiveOnMergeBase({
        headRel: n,
        headPlanId,
        readAtBase,
        census: admissionCensus,
        censusReadFailed: admissionCensusReadFailed,
        changedFilesInjected,
      })
    ) {
      continue;
    }

    activeEntries.push({ rel: n, raw });
    seenEvalRels.add(n);
  }

  const headLifecycleRels = listHeadLifecycleRels({
    projectRoot: root,
    activeEntries,
    changedSet,
    baseXbriefs: options.baseXbriefs,
    injected: options.activeXbriefs !== undefined || options.changedFiles !== undefined,
  });

  const boundary =
    options.testRoots !== undefined ||
    options.fixtureRoots !== undefined ||
    options.sourceRoots !== undefined
      ? {
          testRoots: options.testRoots,
          fixtureRoots: options.fixtureRoots,
          sourceRoots: options.sourceRoots,
        }
      : (() => {
          try {
            const policy = loadTestBoundaryPolicy(root);
            return {
              testRoots: policy.testRoots,
              fixtureRoots: policy.fixtureRoots,
              sourceRoots: policy.sourceRoots,
            };
          } catch {
            return {};
          }
        })();

  const headPlanIds = new Map<string, string | null>();
  for (const e of activeEntries) {
    try {
      headPlanIds.set(e.rel, extractPlanId(JSON.parse(e.raw) as unknown));
    } catch {
      headPlanIds.set(e.rel, null);
    }
  }

  let reportedPeerFailure = false;
  for (const { rel, raw } of activeEntries) {
    const modifiedEarly = changedSetHasPath(changedSet, rel);
    let payload: unknown;
    try {
      payload = JSON.parse(raw) as unknown;
    } catch {
      if (modifiedEarly) {
        findings.push({
          xbriefRelPath: rel,
          planId: rel,
          kind: "active-xbrief-modified-without-digest",
          expandedPaths: [],
          detail: "active xBRIEF in change set is unreadable JSON; fail closed (#4774)",
          remediation: "Fix the active xBRIEF JSON before landing product paths with it (#4774).",
        });
      }
      continue;
    }
    const planId = extractPlanId(payload);
    const approvedCandidate =
      (planId !== null ? approvedByPlan.get(planId) : undefined) ??
      (planId !== null ? readApprovedScopeRecord(root, planId) : null) ??
      null;
    // Bind approval to this xBRIEF path — do not reuse another plan's stamp when
    // plan.id was rewritten to match (Greptile conf=1).
    const approved =
      approvedCandidate !== null &&
      normalizeRepoRelPath(approvedCandidate.xbriefRelPath) === normalizeRepoRelPath(rel)
        ? approvedCandidate
        : null;

    const modified = changedSetHasPath(changedSet, rel);
    // Only an explicit renewed stamp from options (or a pre-existing on-disk
    // digest that was NOT rewritten in this change set) may authorize expansion.
    // Same-PR rewrite of .deft/approved-scope/<id>.json is NOT sufficient
    // (Greptile P1: changed approval record self-authorizes scope).
    const renewed = planId !== null ? (options.renewedApprovals?.get(planId) ?? null) : null;
    const approvalRecordRel =
      planId !== null
        ? `.deft/approved-scope/${planId.replace(/[^a-zA-Z0-9._-]/g, "_")}.json`
        : null;
    const approvalInGitChange =
      approvalRecordRel !== null &&
      [...changedSet].some((p) => {
        const n = normalizeRepoRelPath(p);
        if (n === approvalRecordRel || n.endsWith(`/${approvalRecordRel}`)) return true;
        // Exact basename match only — no planId substring (Greptile / SLizard).
        if (planId === null) return false;
        const safe = planId.replace(/[^a-zA-Z0-9._-]/g, "_");
        return (
          n.includes("/approved-scope/") &&
          (n.endsWith(`/${safe}.json`) || n.endsWith(`${safe}.json`))
        );
      });
    const preimageRel = planId !== null ? approvedScopeIntentRel(planId) : null;
    const preimageInGitChange =
      preimageRel !== null &&
      [...changedSet].some((p) => {
        const n = normalizeRepoRelPath(p);
        if (n === preimageRel || n.endsWith(`/${preimageRel}`)) return true;
        if (planId === null) return false;
        const safe = planId.replace(/[^a-zA-Z0-9._-]/g, "_");
        return n.includes("/approved-scope/") && n.endsWith(`/${safe}.intent.json`);
      });
    // Disk-only / concurrent-rewrite inference (#3205):
    // Authority is the *approval record on the merge base*, not whether the
    // active xBRIEF path existed there. pending→active leaves the active path
    // absent on base; treating that as an approval rewrite is a false positive.
    // Fail closed when base approval is missing, malformed, agent-stamped,
    // path/plan/digest mismatched, or the current record diverged from base.
    // Same-PR git changes still hard-fail via approvalInGitChange.
    let approvalDiskOnly = false;
    if (
      modified &&
      approved !== null &&
      renewed === null &&
      approvalRecordRel !== null &&
      planId !== null &&
      !approvalInGitChange &&
      existsSync(join(root, approvalRecordRel)) &&
      isHumanApprovalStamp(approved.humanApproval)
    ) {
      const currentDigest = computeFileScopeDigest(normalizeFileScope(extractFileScope(payload)));
      if (approved.fileScopeDigest === currentDigest) {
        const baseAuthorizes = baseApprovalAuthorizesCurrent({
          projectRoot: root,
          baseRef: discoveryBaseRef,
          approvalRecordRel,
          planId,
          xbriefRelPath: rel,
          currentDigest,
          currentApproved: approved,
        });
        if (!baseAuthorizes) {
          approvalDiskOnly = true;
        }
      }
    }
    const approvalRecordRewritten = approvalInGitChange || approvalDiskOnly || preimageInGitChange;

    // Same-PR approved-scope rewrite still fails closed when a digest file is
    // co-changed (legacy anti-forgery). Remediation does not schedule a proceed
    // mint ceremony (#4956).
    if (approvalRecordRewritten && modified && renewed === null) {
      const currentScope = normalizeFileScope(extractFileScope(payload));
      findings.push({
        xbriefRelPath: rel,
        planId: planId ?? rel,
        kind: "self-authorizing-scope-expansion",
        expandedPaths: currentScope,
        detail:
          "approved-scope record or preimage rewritten in the same change set as the active xBRIEF; " +
          "cannot self-authorize via concurrent approval rewrite",
        remediation:
          "Do not rewrite `.deft/approved-scope/<plan-id>.json` in the same change set as the " +
          "active xBRIEF (#3145 / #3205). Proceed writes no approved-scope digest for scope (#4956).",
      });
      continue;
    }

    // Membership (#4774 / #5192): continuity-resolved mint, else concrete
    // merge-base precommitment. Path A (no xBRIEF in change set) no-ops.
    const membershipTrigger =
      modified || [...changedSet].some((p) => isLifecycleXbriefPath(normalizeRepoRelPath(p)));

    // Merge-base census for continuity — reuse admission census when resolved
    // so live listLifecycleBriefsAtRef runs at most once per evaluate (#5412).
    let census: CensusBrief[] = [];
    let censusError: string | null = null;
    ensureAdmissionCensus();
    if (admissionCensusReadFailed) {
      censusError =
        "merge-base lifecycle census read failed; refuse rather than hide duplicate identities (#5192)";
      census = [];
    } else if (admissionCensus !== null) {
      census = [...admissionCensus];
    }
    if (censusError !== null && membershipTrigger) {
      findings.push({
        xbriefRelPath: rel,
        planId: planId ?? rel,
        kind: "active-xbrief-modified-without-digest",
        expandedPaths: [],
        detail: censusError,
        remediation:
          "Fix the merge-base lifecycle census read (fetch base ref / repair objects) before " +
          "membership can resolve identities (#5192).",
      });
      continue;
    }

    const continuity = resolveStoryContinuity({
      headRel: rel,
      headPlanId: planId,
      headLifecycleRels,
      census,
      headPlanIds,
    });

    if (continuity.kind === "relabel-refuse" && membershipTrigger) {
      findings.push({
        xbriefRelPath: rel,
        planId: planId ?? rel,
        kind: "active-xbrief-modified-without-digest",
        expandedPaths: [],
        detail: continuity.detail,
        remediation:
          "Restore the continuity-resolved plan.id on the same path, or land the rewrite as a " +
          "new story with its own merge-base brief. Do not borrow another story's mint (#5192).",
      });
      continue;
    }
    if (
      (continuity.kind === "duplicate-refuse" || continuity.kind === "ambiguous-refuse") &&
      membershipTrigger
    ) {
      findings.push({
        xbriefRelPath: rel,
        planId: planId ?? rel,
        kind: "active-xbrief-modified-without-digest",
        expandedPaths: [],
        detail: continuity.detail,
        remediation:
          "Make the merge-base plan.id census unique and complete the lifecycle move " +
          "(base path absent from head) before membership can resolve (#5192).",
      });
      continue;
    }

    type MintLookup =
      | { readonly kind: "mint"; readonly fileScope: readonly string[] }
      | { readonly kind: "invalid"; readonly detail: string }
      | { readonly kind: "missing" };

    const lookupMintByPlanId = (resolvedPlanId: string): MintLookup => {
      if (options.baseApprovedRecords !== undefined) {
        const injected = options.baseApprovedRecords.get(resolvedPlanId);
        if (injected === undefined) return { kind: "missing" };
        if (!isHumanApprovalStamp(injected.humanApproval)) {
          return { kind: "invalid", detail: `mint for ${resolvedPlanId} lacks human stamp` };
        }
        if (injected.planId !== resolvedPlanId) {
          return { kind: "invalid", detail: `mint planId mismatch for ${resolvedPlanId}` };
        }
        // Continuity-resolved planId mint wins whatever xbriefRelPath says (#5192).
        return { kind: "mint", fileScope: normalizeFileScope(injected.fileScope) };
      }
      const approvalRel = `.deft/approved-scope/${approvedScopeSafePlanId(resolvedPlanId)}.json`;
      const approvalBaseRead = readAtBase(approvalRel);
      if (approvalBaseRead.kind === "error") {
        return {
          kind: "invalid",
          detail: `merge-base approved-scope read failed for ${approvalRel}: ${approvalBaseRead.message}`,
        };
      }
      if (approvalBaseRead.kind === "missing") return { kind: "missing" };
      const parsed = parseApprovedScopeRecordRaw(approvalBaseRead.text);
      if (parsed === null) {
        return { kind: "invalid", detail: `unreadable approved-scope at ${approvalRel}` };
      }
      if (!isHumanApprovalStamp(parsed.humanApproval)) {
        return { kind: "invalid", detail: `mint at ${approvalRel} lacks human stamp` };
      }
      if (parsed.planId !== resolvedPlanId) {
        return { kind: "invalid", detail: `mint planId mismatch at ${approvalRel}` };
      }
      return { kind: "mint", fileScope: normalizeFileScope(parsed.fileScope) };
    };

    const basenameMintPathOk = (mintRel: string, headPath: string): boolean => {
      const mintN = normalizeRepoRelPath(mintRel);
      const headN = normalizeRepoRelPath(headPath);
      if (mintN === headN) return true;
      // Lifecycle moves keep the leaf name; mint xbriefRelPath may still be the
      // pre-move folder (active/pending) while head is completed/cancelled.
      return sameBasenameLifecyclePaths(headN).includes(mintN);
    };

    const lookupBasenameMint = (headPath: string): MintLookup => {
      const key = basename(headPath)
        .replace(/\.xbrief\.json$/i, "")
        .replace(/\.vbrief\.json$/i, "");
      if (key.length === 0) return { kind: "missing" };
      if (options.baseApprovedRecords !== undefined) {
        const injected = options.baseApprovedRecords.get(key);
        if (injected === undefined) return { kind: "missing" };
        if (!isHumanApprovalStamp(injected.humanApproval)) {
          return { kind: "invalid", detail: `basename mint for ${key} lacks human stamp` };
        }
        if (!basenameMintPathOk(injected.xbriefRelPath, headPath)) {
          return { kind: "missing" };
        }
        // Basename key is the only planId that may authorize this lookup.
        // A record stored under the basename key with a different planId is
        // invalid — never treat it as a present mint (#5192 Greptile).
        if (injected.planId !== key) {
          return {
            kind: "invalid",
            detail: `basename mint for ${key} has mismatched planId=${injected.planId}`,
          };
        }
        return { kind: "mint", fileScope: normalizeFileScope(injected.fileScope) };
      }
      const approvalRel = `.deft/approved-scope/${approvedScopeSafePlanId(key)}.json`;
      const approvalBaseRead = readAtBase(approvalRel);
      if (approvalBaseRead.kind === "error") {
        return {
          kind: "invalid",
          detail: `merge-base approved-scope read failed for ${approvalRel}: ${approvalBaseRead.message}`,
        };
      }
      if (approvalBaseRead.kind === "missing") return { kind: "missing" };
      const parsed = parseApprovedScopeRecordRaw(approvalBaseRead.text);
      if (parsed === null) {
        return { kind: "invalid", detail: `unreadable approved-scope at ${approvalRel}` };
      }
      if (!isHumanApprovalStamp(parsed.humanApproval)) {
        return { kind: "invalid", detail: `mint at ${approvalRel} lacks human stamp` };
      }
      // Basename key is the only planId that may authorize this lookup.
      // Check before path-ok so a mismatched planId cannot become a mint
      // merely because xbriefRelPath happens to share the leaf name.
      if (parsed.planId !== key) {
        return {
          kind: "invalid",
          detail: `basename mint for ${key} has mismatched planId=${parsed.planId}`,
        };
      }
      if (!basenameMintPathOk(parsed.xbriefRelPath, headPath)) {
        return { kind: "missing" };
      }
      return { kind: "mint", fileScope: normalizeFileScope(parsed.fileScope) };
    };

    let mintLookup: MintLookup = { kind: "missing" };
    if (continuity.kind === "resolved" && continuity.basePlanId !== null) {
      mintLookup = lookupMintByPlanId(continuity.basePlanId);
    } else if (continuity.kind === "resolved" && planId === null) {
      // no-plan.id path-first: basename-keyed mint whose xbriefRelPath equals head.
      mintLookup = lookupBasenameMint(rel);
    } else if (
      planId === null &&
      continuity.kind === "missing" &&
      (rel.startsWith("xbrief/completed/") || rel.startsWith("xbrief/cancelled/"))
    ) {
      // no-plan.id completed/cancelled move: still resolve basename mint (path may
      // be the pre-move folder); production fence probes same-basename on base.
      mintLookup = lookupBasenameMint(rel);
    } else if (planId !== null && continuity.kind === "missing") {
      // No continuity identity: do not look up mint by head plan.id alone when
      // the head path is absent on base (fall to item 4/5).
      mintLookup = { kind: "missing" };
    }

    if (mintLookup.kind === "invalid" && modified) {
      findings.push({
        xbriefRelPath: rel,
        planId: planId ?? rel,
        kind: "active-xbrief-modified-without-digest",
        expandedPaths: [],
        detail: `${mintLookup.detail}; fail closed (#4774 / #5192)`,
        remediation:
          "Fix or remove the invalid merge-base approved-scope record before landing " +
          "product paths with the active xBRIEF (#4774 / #5192).",
      });
      continue;
    }

    let membershipAllowlist: readonly string[] | null = null;
    let allowlistAuthority: MembershipAllowlistAuthority = "missing";

    if (mintLookup.kind === "mint") {
      membershipAllowlist = mintLookup.fileScope;
      allowlistAuthority = "mint";
    } else if (modified) {
      // Path B missing-mint: concrete merge-base brief file_scope precommitment.
      // Use the same move-aware base resolution as the production fence so a
      // completed/ head does not lose the old active brief's concrete scope.
      let basePayloadForPrecommit: unknown | null = null;
      if (continuity.kind === "resolved") {
        basePayloadForPrecommit = continuity.basePayload;
      } else {
        const precommit = resolveMergeBaseBriefRead(rel, continuity, readAtBase, headLifecycleRels);
        if (precommit.read.kind === "error") {
          findings.push({
            xbriefRelPath: rel,
            planId: planId ?? rel,
            kind: "active-xbrief-modified-without-digest",
            expandedPaths: [],
            detail: `merge-base brief read failed for ${precommit.baseRel}: ${precommit.read.message}; fail closed (#5192)`,
            remediation:
              "Fix the merge-base git read before Path B membership can use concrete precommitment (#5192).",
          });
          continue;
        }
        if (precommit.read.kind === "text") {
          try {
            basePayloadForPrecommit = JSON.parse(precommit.read.text) as unknown;
          } catch {
            findings.push({
              xbriefRelPath: rel,
              planId: planId ?? rel,
              kind: "active-xbrief-modified-without-digest",
              expandedPaths: [],
              detail: `merge-base brief at ${precommit.baseRel} is unreadable JSON; fail closed (#5192)`,
              remediation:
                "Restore a readable brief on the merge base before Path B membership (#5192).",
            });
            continue;
          }
        }
      }
      if (basePayloadForPrecommit !== null) {
        const concrete = normalizeFileScope(extractFileScope(basePayloadForPrecommit)).filter((e) =>
          isConcreteFileScopeEntry(e),
        );
        membershipAllowlist = concrete;
        allowlistAuthority = "precommitment";
      } else {
        membershipAllowlist = null;
        allowlistAuthority = "missing";
      }
    }

    // Membership no-ops when the bound path is outside the change set (Path A).
    const membershipAllowlistForEval = modified ? membershipAllowlist : null;
    const authorityForEval: MembershipAllowlistAuthority = modified
      ? allowlistAuthority
      : "missing";

    const exemptRelPaths = continuityExemptPaths({
      headRel: rel,
      headPlanId: planId,
      continuity,
    });

    const peerXbriefRelPaths: string[] = [];
    const peerApprovedFileScopes: string[][] = [];
    // Exempt only peers still present and parseable. Deleted peer paths stay in
    // this story's membership extras (fail closed); malformed peers are not
    // exempt — their own loop fails closed on unreadable JSON.
    if (activeEntries.length > 1) {
      for (const other of activeEntries) {
        if (other.rel === rel) continue;
        // Unchanged peers must not authorize this story's change set.
        if (!changedSetHasPath(changedSet, other.rel)) continue;
        let otherPayload: unknown;
        try {
          otherPayload = JSON.parse(other.raw) as unknown;
        } catch {
          // Malformed peer: do not exempt; own loop fails closed.
          continue;
        }
        if (!peerXbriefRelPaths.includes(other.rel)) peerXbriefRelPaths.push(other.rel);
        const otherPlanId = extractPlanId(otherPayload);
        let otherMint: readonly string[] | null = null;
        if (otherPlanId !== null) {
          const otherLookup = lookupMintByPlanId(otherPlanId);
          if (otherLookup.kind === "mint") {
            otherMint = otherLookup.fileScope;
          }
        }
        // Peer PR-authored / brief file_scope must not expand this allowlist.
        if (otherMint !== null && otherMint.length > 0) {
          peerApprovedFileScopes.push([...otherMint]);
        }
      }
    }

    const membershipHit = evaluateApprovedScopeMembership({
      xbriefRelPath: rel,
      planId: planId ?? rel,
      xbriefModifiedInChangeSet: modified,
      baseApprovedFileScope: membershipAllowlistForEval,
      allowlistAuthority: authorityForEval,
      changedFiles: changed,
      peerXbriefRelPaths,
      peerApprovedFileScopes,
      exemptRelPaths,
      testRoots: boundary.testRoots,
      fixtureRoots: boundary.fixtureRoots,
      sourceRoots: boundary.sourceRoots,
    });
    // Only emit membership when the xBRIEF is in the change set (helper no-ops otherwise).
    if (membershipHit !== null) {
      findings.push({
        xbriefRelPath: membershipHit.xbriefRelPath,
        planId: membershipHit.planId,
        kind: membershipHit.kind,
        expandedPaths: membershipHit.expandedPaths,
        detail: membershipHit.detail,
        remediation: membershipHit.remediation,
      });
      // Missing allowlist is decisive for C24; skip further fences for this brief.
      if (membershipHit.kind === "active-xbrief-modified-without-digest") {
        continue;
      }
    }

    // Path fence (#4956): compare changed production files to the merge-base
    // brief file_scope. Never read the head brief for the fence list.
    // On lifecycle moves, the head path is absent on base — use continuity.baseRel
    // or same-basename pre-move probes (active before pending).
    const fenceResolved = resolveMergeBaseBriefRead(rel, continuity, readAtBase, headLifecycleRels);
    const fenceBaseRel = fenceResolved.baseRel;
    const baseBriefRead = fenceResolved.read;
    if (baseBriefRead.kind === "error") {
      findings.push({
        xbriefRelPath: rel,
        planId: planId ?? rel,
        kind: "production-scope-over-budget",
        expandedPaths: [],
        detail: `merge-base brief read failed for ${fenceBaseRel}: ${baseBriefRead.message}; fail closed (#4956)`,
        remediation:
          "Fix the merge-base git read (fetch the base ref / repair the object) before changing " +
          "production paths. There is no scope ceremony for proceed (#4956).",
      });
      continue;
    }
    const baseBriefRaw = baseBriefRead.kind === "text" ? baseBriefRead.text : null;
    if (baseBriefRaw !== null) {
      let basePayload: unknown = null;
      try {
        basePayload = JSON.parse(baseBriefRaw) as unknown;
      } catch {
        findings.push({
          xbriefRelPath: rel,
          planId: planId ?? rel,
          kind: "production-scope-over-budget",
          expandedPaths: [],
          detail: `merge-base brief at ${fenceBaseRel} is unreadable JSON; write fence / check fail closed (#4956)`,
          remediation:
            "Restore a readable active brief on the merge base before changing production paths. " +
            "There is no scope ceremony for proceed (#4956).",
        });
        continue;
      }
      const baseScope = normalizeFileScope(extractFileScope(basePayload));
      const headScope = normalizeFileScope(extractFileScope(payload));
      // Multi-story: do not charge paths claimed by another active brief's
      // merge-base scope. Head-only peer scopes must not siphon extras (#4956).
      // Orphan production extras still charge every fenced story.
      let storyChanged = changed;
      if (activeEntries.length > 1) {
        const ownClaim = normalizeFileScope([...headScope, ...baseScope]);
        const otherClaims: string[][] = [];
        let peerBaseFailure: { readonly peerRel: string; readonly detail: string } | null = null;
        for (const other of activeEntries) {
          if (other.rel === rel) continue;
          let otherPlanId: string | null = null;
          try {
            otherPlanId = extractPlanId(JSON.parse(other.raw) as unknown);
          } catch {
            otherPlanId = null;
          }
          const otherContinuity = resolveStoryContinuity({
            headRel: other.rel,
            headPlanId: otherPlanId,
            headLifecycleRels,
            census,
            headPlanIds,
          });
          const otherFence = resolveMergeBaseBriefRead(
            other.rel,
            otherContinuity,
            readAtBase,
            headLifecycleRels,
          );
          const otherBaseRead = otherFence.read;
          if (otherBaseRead.kind === "error") {
            peerBaseFailure = {
              peerRel: other.rel,
              detail: `merge-base peer brief read failed: ${otherBaseRead.message}`,
            };
            break;
          }
          if (otherBaseRead.kind === "missing") {
            // Peer exists only on HEAD: no merge-base claim to attribute.
            continue;
          }
          const otherBaseRaw = otherBaseRead.text;
          try {
            otherClaims.push(
              normalizeFileScope(extractFileScope(JSON.parse(otherBaseRaw) as unknown)),
            );
          } catch (err) {
            const detail = err instanceof Error ? err.message : String(err);
            peerBaseFailure = {
              peerRel: other.rel,
              detail: `merge-base peer brief unreadable JSON: ${detail}`,
            };
            break;
          }
        }
        if (peerBaseFailure !== null) {
          // Base-visible peer that cannot be read/parsed must fail closed —
          // silent discard would charge the peer's files as production extras.
          // Report once; still run this story's own fence/intent (#4956 P2).
          if (!reportedPeerFailure) {
            reportedPeerFailure = true;
            findings.push({
              xbriefRelPath: peerBaseFailure.peerRel,
              planId: peerBaseFailure.peerRel,
              kind: "production-scope-over-budget",
              expandedPaths: [],
              detail: `peer ${peerBaseFailure.peerRel}: ${peerBaseFailure.detail}; fail closed (#4956)`,
              remediation:
                "Fix the merge-base peer brief read/parse before attributing multi-story " +
                "production extras. There is no scope ceremony for proceed (#4956).",
            });
          }
          // Untrusted peer claims: do not invent extras; keep own-scope files only.
          storyChanged = changed.filter((f) => {
            const n = normalizeRepoRelPath(f);
            if (n === rel || n.endsWith(`/${rel}`)) return true;
            return ownClaim.length > 0 && pathMatchesFileScope(n, ownClaim);
          });
        } else {
          storyChanged = changed.filter((f) => {
            const n = normalizeRepoRelPath(f);
            if (n === rel || n.endsWith(`/${rel}`)) return true;
            const matchesOwn = ownClaim.length > 0 && pathMatchesFileScope(n, ownClaim);
            if (matchesOwn) return true;
            const matchesOther = otherClaims.some(
              (claim) => claim.length > 0 && pathMatchesFileScope(n, claim),
            );
            if (matchesOther) return false;
            return true;
          });
        }
      }
      const fenceHit = evaluateProductionScopeFence({
        xbriefRelPath: rel,
        planId: planId ?? rel,
        baseFileScope: baseScope,
        changedFiles: storyChanged,
        testRoots: boundary.testRoots,
        fixtureRoots: boundary.fixtureRoots,
        sourceRoots: boundary.sourceRoots,
      });
      if (fenceHit !== null) {
        findings.push({
          xbriefRelPath: fenceHit.xbriefRelPath,
          planId: fenceHit.planId,
          kind: fenceHit.kind,
          expandedPaths: fenceHit.expandedPaths,
          detail: fenceHit.detail,
          remediation: fenceHit.remediation,
        });
      }
    }

    // Intent pin (#3385) only when a digest already exists / is rewritten —
    // never demands a first mint for proceed (#4956).
    const intentHits = evaluateIntentForXbrief({
      projectRoot: root,
      xbriefRelPath: rel,
      liveRaw: raw,
      livePayload: payload,
      planId: planId ?? rel,
      approved,
      xbriefModified: modified,
      approvalRewritten: approvalRecordRewritten,
      preimageRewritten: preimageInGitChange,
      currentScopeNonEmpty: normalizeFileScope(extractFileScope(payload)).length > 0,
      baseRef: discoveryBaseRef,
      changedFiles: changed,
      readAtBase: (baseRel) => {
        const r = readAtBase(baseRel);
        if (r.kind === "text") return r.text;
        // Missing stays null; Git/read errors return { error } so intent eval
        // fails closed without a mintable throw-site (#4956 / Greptile).
        if (r.kind === "error") {
          return { error: r.message };
        }
        return null;
      },
      approvedReposSeed: options.approvedReposSeed,
    });
    for (const hit of intentHits) {
      const mapped: ScopeProvenanceFinding = {
        xbriefRelPath: hit.xbriefRelPath,
        planId: hit.planId,
        kind: hit.kind,
        expandedPaths: [],
        detail: hit.detail,
        remediation: hit.remediation,
      };
      if (hit.warnOnly) {
        softFindings.push(mapped);
      } else {
        findings.push(mapped);
      }
    }
  }

  if (findings.length === 0 && softFindings.length === 0) {
    return {
      exitCode: 0,
      findings: [],
      message:
        `verify_scope_provenance: clean (${activeEntries.length} active xBRIEF(s), ` +
        `${changed.length} changed file(s)) (#3145).`,
    };
  }

  if (findings.length === 0) {
    // Warn-only migration discoveries
    const body = softFindings
      .map(
        (f) => `  ${f.xbriefRelPath} (${f.planId})\n    kind: ${f.kind}\n    detail: ${f.detail}`,
      )
      .join("\n");
    return {
      exitCode: 0,
      findings: softFindings,
      message:
        `verify_scope_provenance: WARN ${softFindings.length} migration finding(s) ` +
        `(not failing; pass --enforce to fail closed) (#3145).\n${body}`,
    };
  }

  const all = [...findings, ...softFindings];
  const body = all
    .map(
      (f) =>
        `  ${f.xbriefRelPath} (${f.planId})\n` +
        `    kind: ${f.kind}\n` +
        `    expanded: ${f.expandedPaths.join(", ") || "(none)"}\n` +
        `    detail: ${f.detail}\n` +
        `    remediation: ${f.remediation}`,
    )
    .join("\n");

  return {
    exitCode: 1,
    findings: all,
    message: `verify_scope_provenance: ${findings.length} self-authorization violation(s) (#3145).\n${body}`,
  };
}

/** Re-export builder for activation hook callers. */
export { buildApprovedScopeRecord, writeApprovedScopeRecord } from "./digest.js";
