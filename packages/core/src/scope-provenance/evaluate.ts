/**
 * verify:scope-provenance evaluation (#3145).
 *
 * Detects same-PR active xBRIEF expansion that would self-authorize new
 * implementation paths. Requires renewed human approval (updated digest record
 * with human stamp); the modified xBRIEF alone is never sufficient.
 *
 * Three-state exit: 0 clean / 1 self-authorization / 2 config.
 * Migration: missing approved-scope records → warn (exit 0) unless --enforce.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { GitCommandError, GitNotFoundError } from "../encoding/git.js";
import {
  type ApprovedScopeRecord,
  computeFileScopeDigest,
  extractFileScope,
  extractPlanId,
  isHumanApprovalStamp,
  listApprovedScopeRecords,
  normalizeFileScope,
  readApprovedScopeRecord,
  scopeExpansion,
} from "./digest.js";

export type ScopeProvenanceViolationKind =
  | "self-authorizing-scope-expansion"
  | "active-xbrief-modified-without-digest"
  | "digest-mismatch-without-renewal";

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
  return { status: result.status ?? 1, stdout: result.stdout ?? "" };
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

/** Normalize git --name-only paths (including C-quoted paths). */
export function unquoteGitPath(raw: string): string {
  const t = raw.replace(/\r$/, "").trim().replace(/\\/g, "/");
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
    try {
      // git C-quotes: "path with spaces" / "weird\tname"
      return JSON.parse(
        t.replace(/\\([abtnvfr"'\\])/g, (_, c: string) => {
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
          return map[c] ?? c;
        }),
      ) as string;
    } catch {
      return t.slice(1, -1);
    }
  }
  return t;
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
  // Triple-dot includes all commits on the branch relative to merge-base.
  const range = resolved === "HEAD" || resolved.includes("...") ? resolved : `${resolved}...HEAD`;
  const diff = git(["diff", "--name-only", range], projectRoot);
  if (diff.status === 0) {
    for (const line of diff.stdout.split("\n")) {
      const t = unquoteGitPath(line);
      if (t.length > 0) out.add(t);
    }
  }
  // Also include working-tree changes vs HEAD (unstaged / staged / untracked).
  const vsHead = git(["diff", "--name-only", "HEAD"], projectRoot);
  if (vsHead.status === 0) {
    for (const line of vsHead.stdout.split("\n")) {
      const t = unquoteGitPath(line);
      if (t.length > 0) out.add(t);
    }
  }
  const untracked = git(["ls-files", "--others", "--exclude-standard"], projectRoot);
  if (untracked.status === 0) {
    for (const line of untracked.stdout.split("\n")) {
      const t = unquoteGitPath(line);
      if (t.length > 0) out.add(t);
    }
  }
  return [...out];
}

function listActiveXbriefPaths(projectRoot: string): string[] {
  const activeDir = join(projectRoot, "xbrief", "active");
  if (!existsSync(activeDir)) return [];
  return readdirSync(activeDir)
    .filter((n) => n.endsWith(".xbrief.json") || n.endsWith(".vbrief.json"))
    .map((n) => `xbrief/active/${n}`);
}

function remediationForExpansion(): string {
  return (
    "Renew human approval: re-record the approved-scope digest after operator review " +
    "(`task scope:record-approved-scope` / write `.deft/approved-scope/<plan-id>.json` " +
    "with humanApproval stamp). Editing the active xBRIEF alone does not authorize new " +
    "paths (#3145). See content/docs/scope-provenance.md."
  );
}

function configError(message: string): ScopeProvenanceResult {
  return { exitCode: 2, findings: [], message };
}

/**
 * Pure evaluation of one active xBRIEF against its approved baseline.
 * Exported for unit tests without git.
 */
export function evaluateOneScopeProvenance(input: {
  readonly xbriefRelPath: string;
  readonly currentPayload: unknown;
  readonly approved: ApprovedScopeRecord | null;
  readonly xbriefModifiedInChangeSet: boolean;
  readonly enforce: boolean;
  readonly renewedHumanApproval?: ApprovedScopeRecord["humanApproval"] | null;
}): ScopeProvenanceFinding | null {
  const planId =
    extractPlanId(input.currentPayload) ?? input.approved?.planId ?? input.xbriefRelPath;
  const currentScope = normalizeFileScope(extractFileScope(input.currentPayload));
  const currentDigest = computeFileScopeDigest(currentScope);

  // Not modified in this change set → nothing to police for self-auth
  if (!input.xbriefModifiedInChangeSet) {
    return null;
  }

  // Renewed human approval present → accept expansion as re-baselined intent
  if (isHumanApprovalStamp(input.renewedHumanApproval ?? null)) {
    return null;
  }

  if (input.approved === null) {
    if (!input.enforce) {
      // Migration / discovery: warn-level finding is returned by caller as soft
      return {
        xbriefRelPath: input.xbriefRelPath,
        planId,
        kind: "active-xbrief-modified-without-digest",
        expandedPaths: currentScope,
        detail: "active xBRIEF modified in change set but no approved-scope digest is recorded",
        remediation:
          "Record an approved-scope digest at activation (migration: warn-only until " +
          "enforcement is enabled). " +
          remediationForExpansion(),
      };
    }
    return {
      xbriefRelPath: input.xbriefRelPath,
      planId,
      kind: "active-xbrief-modified-without-digest",
      expandedPaths: currentScope,
      detail:
        "active xBRIEF modified in change set but no approved-scope digest is recorded (enforce)",
      remediation: remediationForExpansion(),
    };
  }

  // Approved record exists with human stamp and matching digest → ok
  if (
    input.approved.fileScopeDigest === currentDigest &&
    isHumanApprovalStamp(input.approved.humanApproval)
  ) {
    return null;
  }

  const expanded = scopeExpansion(input.approved.fileScope, currentScope);
  if (expanded.length === 0) {
    // Scope shrink or identical after normalize — body edit without expansion is OK
    if (input.approved.fileScopeDigest === currentDigest) {
      return null;
    }
    // Digest mismatch without path expansion (reorder/noise) — still OK for v1
    return null;
  }

  // Expansion without renewed human approval = self-authorization
  return {
    xbriefRelPath: input.xbriefRelPath,
    planId,
    kind: "self-authorizing-scope-expansion",
    expandedPaths: expanded,
    detail:
      `active xBRIEF expanded file_scope by ${expanded.length} path(s) in the same change set; ` +
      "modified xBRIEF cannot authorize the new paths",
    remediation: remediationForExpansion(),
  };
}

/**
 * Evaluate scope provenance for a project (or pure injected seams).
 */
export function evaluateScopeProvenance(
  projectRoot: string,
  options: ScopeProvenanceOptions = {},
): ScopeProvenanceResult {
  const root = resolve(projectRoot);
  const enforce = options.enforce ?? false;

  let changed: string[];
  try {
    if (options.changedFiles !== undefined) {
      changed = [...options.changedFiles].map((p) => p.replace(/\\/g, "/"));
    } else {
      // Default is PR-aware (origin/master...), not bare HEAD — bare HEAD misses
      // committed PR diffs on clean checkouts (#3145 Greptile P1).
      let baseRef = options.baseRef;
      if (baseRef === undefined || baseRef === "" || baseRef === "HEAD") {
        const resolved = resolveDefaultBaseRef(root);
        if (resolved === null) {
          return configError(
            "verify_scope_provenance: no merge-base ref found (origin/master|main, " +
              "DEFT_BASE_REF, or GITHUB_BASE_REF).\n" +
              "  Recovery: fetch the default branch or pass --base-ref <ref>. " +
              "Bare HEAD cannot see committed PR scope expansion (#3145).",
          );
        }
        baseRef = resolved;
      }
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
      return configError(
        `verify_scope_provenance: git failed -- ${err.message}\n` +
          "  Recovery: ensure --project-root points at a git working tree.",
      );
    }
    throw err;
  }

  const changedSet = new Set(changed);
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
      rel: rel.replace(/\\/g, "/"),
      raw,
    }));
  } else {
    activeEntries = [];
    for (const rel of listActiveXbriefPaths(root)) {
      const full = join(root, rel);
      if (!existsSync(full)) continue;
      try {
        activeEntries.push({ rel, raw: readFileSync(full, "utf8") });
      } catch {
        // skip unreadable
      }
    }
  }

  for (const { rel, raw } of activeEntries) {
    let payload: unknown;
    try {
      payload = JSON.parse(raw) as unknown;
    } catch {
      continue;
    }
    const planId = extractPlanId(payload);
    const approved =
      (planId !== null ? approvedByPlan.get(planId) : undefined) ??
      (planId !== null ? readApprovedScopeRecord(root, planId) : null) ??
      null;

    const modified = changedSet.has(rel);
    // Only an explicit renewed stamp from options (or a pre-existing on-disk
    // digest that was NOT rewritten in this change set) may authorize expansion.
    // Same-PR rewrite of .deft/approved-scope/<id>.json is NOT sufficient
    // (Greptile P1: changed approval record self-authorizes scope).
    const renewed = planId !== null ? (options.renewedApprovals?.get(planId) ?? null) : null;
    const approvalRecordRel =
      planId !== null
        ? `.deft/approved-scope/${planId.replace(/[^a-zA-Z0-9._-]/g, "_")}.json`
        : null;
    const approvalRecordRewritten =
      approvalRecordRel !== null &&
      [...changedSet].some(
        (p) =>
          p === approvalRecordRel ||
          p.endsWith(`/${approvalRecordRel}`) ||
          (p.includes("/approved-scope/") && p.includes(planId ?? "")),
      );

    const recordMatchesCurrent =
      approved !== null &&
      !approvalRecordRewritten &&
      approved.fileScopeDigest ===
        computeFileScopeDigest(normalizeFileScope(extractFileScope(payload))) &&
      isHumanApprovalStamp(approved.humanApproval);

    // Same-PR approval rewrite without independent renewal is hard-fail expansion,
    // not a soft missing-digest migration warning (Greptile P1).
    if (approvalRecordRewritten && modified && renewed === null) {
      const currentScope = normalizeFileScope(extractFileScope(payload));
      findings.push({
        xbriefRelPath: rel,
        planId: planId ?? rel,
        kind: "self-authorizing-scope-expansion",
        expandedPaths: currentScope,
        detail:
          "approved-scope record rewritten in the same change set as the active xBRIEF; " +
          "cannot self-authorize via concurrent approval rewrite",
        remediation:
          "Record renewed human approval outside the implementation PR (or pass an " +
          "independent renewed stamp). Same-PR approval rewrites do not authorize expansion (#3145).",
      });
      continue;
    }

    const finding = evaluateOneScopeProvenance({
      xbriefRelPath: rel,
      currentPayload: payload,
      approved,
      xbriefModifiedInChangeSet: modified,
      enforce,
      renewedHumanApproval: renewed ?? (recordMatchesCurrent ? approved?.humanApproval : null),
    });

    if (finding === null) continue;

    // Soft migration findings: missing digest without enforce
    if (finding.kind === "active-xbrief-modified-without-digest" && !enforce) {
      softFindings.push(finding);
      continue;
    }

    // Self-auth expansion always hard-fails when modified
    findings.push(finding);
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
