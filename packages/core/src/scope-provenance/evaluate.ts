/**
 * verify:scope-provenance evaluation (#3145 / #4956).
 *
 * Path fence (#4956): the active brief's `file_scope` on the merge base is the
 * precommitment. Changed production files are checked against that base list
 * plus a concrete-file allowance (floor 2, cap 5). Test-root paths spend
 * nothing. Head brief edits do not widen the fence. Proceed writes no
 * `.deft/approved-scope` digest and must not demand `scope:record-approved-scope`.
 *
 * Intent-pin checks (#3385) remain for existing base-committed records.
 *
 * Three-state exit: 0 clean / 1 fence violation / 2 config.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { GitCommandError, GitNotFoundError } from "../encoding/git.js";
import { loadTestBoundaryPolicy } from "../test-boundary/policy.js";
import { evaluateProductionScopeFence, pathMatchesFileScope } from "./base-fence.js";
import {
  type ApprovedScopeRecord,
  approvedScopeIntentRel,
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

/** Read a repo-relative path as of `ref` (null if missing; throws on other git failures). */
function readRepoFileAtRef(projectRoot: string, ref: string, relPath: string): string | null {
  const path = relPath.replace(/\\/g, "/").replace(/^\.\//, "");
  const result = git(["show", `${ref}:${path}`], projectRoot);
  if (result.status === 0) return result.stdout;
  const detail = result.stdout.trim();
  if (isGitMissingPathDetail(detail)) return null;
  throw new GitCommandError(
    `git show ${ref}:${path} failed: ${detail.length > 0 ? detail : `exit ${String(result.status)}`}`,
  );
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
  let baseRaw: string | null;
  try {
    baseRaw = readRepoFileAtRef(input.projectRoot, input.baseRef, input.approvalRecordRel);
  } catch {
    // Fail closed: a base-read error cannot authorize expansion.
    return false;
  }
  if (baseRaw === null) return false;
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
    activeEntries = [...options.activeXbriefs.entries()].map(([rel, raw]) => ({
      rel: normalizeRepoRelPath(rel),
      raw,
    }));
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

  for (const { rel, raw } of activeEntries) {
    let payload: unknown;
    try {
      payload = JSON.parse(raw) as unknown;
    } catch {
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

    const readAtBase = (baseRel: string): string | null => {
      if (options.baseXbriefs !== undefined) {
        // Injected base map is authoritative: absent key means missing on base.
        const injected = options.baseXbriefs.get(normalizeRepoRelPath(baseRel));
        return injected === undefined ? null : injected;
      }
      if (options.readAtBase !== undefined) return options.readAtBase(baseRel);
      if (discoveryBaseRef === null || discoveryBaseRef === "") return null;
      // Throw on non-missing git failures so the fence fails closed (#4956).
      return readRepoFileAtRef(root, discoveryBaseRef, baseRel);
    };

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

    // Path fence (#4956): compare changed production files to the merge-base
    // brief file_scope. Never read the head brief for the fence list.
    let baseBriefRaw: string | null;
    try {
      baseBriefRaw = readAtBase(rel);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      findings.push({
        xbriefRelPath: rel,
        planId: planId ?? rel,
        kind: "production-scope-over-budget",
        expandedPaths: [],
        detail: `merge-base brief read failed for ${rel}: ${detail}; fail closed (#4956)`,
        remediation:
          "Fix the merge-base git read (fetch the base ref / repair the object) before changing " +
          "production paths. There is no scope ceremony for proceed (#4956).",
      });
      continue;
    }
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
          detail: `merge-base brief at ${rel} is unreadable JSON; write fence / check fail closed (#4956)`,
          remediation:
            "Restore a readable active brief on the merge base before changing production paths. " +
            "There is no scope ceremony for proceed (#4956).",
        });
        continue;
      }
      const baseScope = normalizeFileScope(extractFileScope(basePayload));
      const headScope = normalizeFileScope(extractFileScope(payload));
      // Multi-story: do not charge paths claimed by another active brief's
      // head∪base scope. Orphan production extras still charge every fenced story.
      let storyChanged = changed;
      if (activeEntries.length > 1) {
        const ownClaim = normalizeFileScope([...headScope, ...baseScope]);
        const otherClaims: string[][] = [];
        for (const other of activeEntries) {
          if (other.rel === rel) continue;
          try {
            const otherPayload = JSON.parse(other.raw) as unknown;
            const otherHead = normalizeFileScope(extractFileScope(otherPayload));
            let otherBase = otherHead;
            try {
              const otherBaseRaw = readAtBase(other.rel);
              if (otherBaseRaw !== null) {
                otherBase = normalizeFileScope(
                  extractFileScope(JSON.parse(otherBaseRaw) as unknown),
                );
              }
            } catch {
              // Keep head-only claim for the peer when its base read fails.
            }
            otherClaims.push(normalizeFileScope([...otherHead, ...otherBase]));
          } catch {
            // skip unreadable peer
          }
        }
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
      readAtBase,
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
