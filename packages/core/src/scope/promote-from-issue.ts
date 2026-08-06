/**
 * scope:promote --from-issue reciprocity gate (#1136 / D18).
 *
 * Gates promote of a proposed scope on the latest triage-cache decision for
 * the issue, locates the proposed artifact via provenance scan, and runs the
 * shared promotePath path (WIP rules unchanged).
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { provenanceIssueNumber, scanProvenanceRefs } from "../intake/issue-ingest.js";
import { hasArtifactSuffix, resolveLifecycleRoot } from "../layout/resolve.js";
import { createCandidatesLog, resolveAuditLogPath } from "../triage/actions/candidates-log.js";
import type { AuditEntry } from "../triage/actions/types.js";
import { resolveRepo } from "../triage/queue/repo.js";
import { resolveProjectRoot } from "./project-context.js";
import { type PromotePathResult, promotePath } from "./promote-path.js";

export interface PromoteFromIssueOptions {
  readonly issueNumber: number;
  readonly repo?: string | null;
  readonly projectRoot?: string;
  /** WIP-cap override. */
  readonly force?: boolean;
  /** Skip reciprocity gate; still audit that force was used. */
  readonly forceNoCache?: boolean;
  /** Missing decision becomes hard fail (default: soft warn + proceed). */
  readonly strict?: boolean;
  readonly actor?: string;
  /** Explicit path when multiple proposed artifacts match the issue. */
  readonly explicitPath?: string;
  readonly now?: Date;
  /** Optional candidates-log path override (tests). */
  readonly candidatesLogPath?: string;
  /** Inject latest decision (tests). */
  readonly latestDecision?: AuditEntry | null;
}

export interface PromoteFromIssueResult extends PromotePathResult {
  readonly warnings: string[];
  readonly repo: string | null;
  readonly matchedPaths: string[];
  readonly cacheStateAtPromote: string | null;
  readonly cacheDecisionId: string | null;
}

/**
 * Locate proposed/ artifacts whose provenance owns ``issueNumber``.
 * Uses scanProvenanceRefs plus a proposed/-only Origin fallback.
 */
export function findProposedArtifactsForIssue(projectRoot: string, issueNumber: number): string[] {
  const root = resolve(projectRoot);
  let lifecycleRoot: string;
  try {
    lifecycleRoot = resolveLifecycleRoot(root);
  } catch {
    // No xbrief/ or vbrief/ layout yet — nothing proposed.
    return [];
  }
  const byIssue = scanProvenanceRefs(lifecycleRoot);
  const rels = (byIssue.get(issueNumber) ?? []).filter((rel) => {
    const folder = rel.split(/[/\\]/)[0];
    return folder === "proposed";
  });

  const absFromScan = rels.map((rel) => join(lifecycleRoot, rel));

  // Fallback: proposed/ files whose Origin/provenance mentions #N but lack
  // github-issue refs (hand scaffolds). Only when scan returned nothing.
  if (absFromScan.length > 0) {
    return uniqueExisting(absFromScan);
  }

  const proposedDir = join(lifecycleRoot, "proposed");
  if (!existsSync(proposedDir)) {
    return [];
  }
  const fallback: string[] = [];
  for (const name of readdirSync(proposedDir).filter((f) => hasArtifactSuffix(f))) {
    const abs = join(proposedDir, name);
    try {
      const data = JSON.parse(readFileSync(abs, "utf8")) as Record<string, unknown>;
      if (provenanceIssueNumber(data) === issueNumber) {
        fallback.push(abs);
      }
    } catch {
      /* skip unreadable */
    }
  }
  return uniqueExisting(fallback);
}

function uniqueExisting(paths: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of paths) {
    const key = resolve(p);
    if (seen.has(key)) continue;
    seen.add(key);
    if (existsSync(key)) {
      out.push(key);
    }
  }
  return out.sort();
}

function resolveLatestDecision(
  options: PromoteFromIssueOptions,
  projectRoot: string,
  repo: string,
): AuditEntry | null {
  if (options.latestDecision !== undefined) {
    return options.latestDecision;
  }
  const log = createCandidatesLog(projectRoot);
  const path = options.candidatesLogPath ?? resolveAuditLogPath(projectRoot);
  return log.latestDecision(options.issueNumber, repo, { path });
}

/**
 * Promote the proposed scope for an issue, gated on triage-cache latestDecision.
 */
export function promoteFromIssue(options: PromoteFromIssueOptions): PromoteFromIssueResult {
  const warnings: string[] = [];
  const projectRoot = resolveProjectRoot(options.projectRoot);
  if (projectRoot === null) {
    return {
      ok: false,
      message:
        "Cannot determine project root. Pass --project-root PATH, set $DEFT_PROJECT_ROOT, or run from inside a directory tree that contains vbrief/ or .git/ (#535).",
      exitCode: 2,
      warnings,
      repo: null,
      matchedPaths: [],
      cacheStateAtPromote: null,
      cacheDecisionId: null,
    };
  }

  const repo = resolveRepo(options.repo, projectRoot);
  if (repo === null) {
    return {
      ok: false,
      message:
        "scope:promote --from-issue requires --repo OWNER/NAME (or $DEFT_TRIAGE_REPO / git remote origin).",
      exitCode: 2,
      warnings,
      repo: null,
      matchedPaths: [],
      cacheStateAtPromote: null,
      cacheDecisionId: null,
    };
  }

  const n = options.issueNumber;
  if (!Number.isInteger(n) || n < 1) {
    return {
      ok: false,
      message: `Invalid --from-issue value: ${String(options.issueNumber)} (expected positive integer).`,
      exitCode: 2,
      warnings,
      repo,
      matchedPaths: [],
      cacheStateAtPromote: null,
      cacheDecisionId: null,
    };
  }

  const latest = resolveLatestDecision(options, projectRoot, repo);
  const cacheState = latest?.decision ?? null;
  const cacheDecisionId = latest?.decision_id ?? null;
  const forceNoCache = options.forceNoCache === true;

  if (!forceNoCache) {
    if (latest === null) {
      if (options.strict === true) {
        return {
          ok: false,
          message:
            `No triage-cache decision for #${n} (${repo}). ` +
            `Accept first: task triage:accept -- --issue ${n} --repo ${repo} ` +
            `(or omit --strict to soft-warn and proceed; --force-no-cache skips the gate).`,
          exitCode: 1,
          warnings,
          repo,
          matchedPaths: [],
          cacheStateAtPromote: null,
          cacheDecisionId: null,
        };
      }
      warnings.push(
        `[scope:promote --from-issue] no triage-cache decision for #${n} (${repo}); proceeding (soft warn). Use --strict to fail.`,
      );
    } else if (latest.decision !== "accept") {
      // Refuse any non-accept latest decision (defer/reject/needs-ac/mark-duplicate/…).
      return {
        ok: false,
        message:
          `Refusing promote for #${n} (${repo}): latest triage decision is '${latest.decision}' ` +
          `(decision_id=${latest.decision_id}). ` +
          `Accept first: task triage:accept -- --issue ${n} --repo ${repo} ` +
          `or override with --force-no-cache.`,
        exitCode: 1,
        warnings,
        repo,
        matchedPaths: [],
        cacheStateAtPromote: cacheState,
        cacheDecisionId,
      };
    }
  } else {
    warnings.push(
      `[scope:promote --from-issue] --force-no-cache: skipped reciprocity gate for #${n} ` +
        `(cache decision was ${cacheState === null ? "absent" : `'${cacheState}'`}).`,
    );
  }

  let matched = findProposedArtifactsForIssue(projectRoot, n);
  if (options.explicitPath !== undefined && options.explicitPath.trim().length > 0) {
    const raw = options.explicitPath.trim();
    const explicit = isAbsolute(raw) ? resolve(raw) : resolve(projectRoot, raw);
    if (matched.length === 0) {
      matched = [explicit];
    } else {
      const hit = matched.find((p) => resolve(p) === explicit);
      if (hit === undefined) {
        return {
          ok: false,
          message:
            `Explicit path is not a proposed artifact for #${n}: ${explicit}. ` +
            `Matched: ${matched.join(", ")}`,
          exitCode: 2,
          warnings,
          repo,
          matchedPaths: matched,
          cacheStateAtPromote: cacheState,
          cacheDecisionId,
        };
      }
      matched = [hit];
    }
  }

  if (matched.length === 0) {
    return {
      ok: false,
      message:
        `No proposed/ scope artifact found for issue #${n}. ` +
        `Ingest first (task triage:accept -- --issue ${n} --repo ${repo}) ` +
        `or pass an explicit path: task scope:promote -- <path>.`,
      exitCode: 1,
      warnings,
      repo,
      matchedPaths: [],
      cacheStateAtPromote: cacheState,
      cacheDecisionId,
    };
  }

  if (matched.length > 1) {
    const list = matched.map((p) => `  - ${p}`).join("\n");
    return {
      ok: false,
      message:
        `Multiple proposed/ artifacts match issue #${n}; refuse to guess.\n${list}\n` +
        `Promote one path explicitly: task scope:promote -- <path> ` +
        `or re-run with --path <one-of-the-above>.`,
      exitCode: 1,
      warnings,
      repo,
      matchedPaths: matched,
      cacheStateAtPromote: cacheState,
      cacheDecisionId,
    };
  }

  const filePath = matched[0] as string;
  const promoteResult = promotePath(filePath, {
    projectRoot,
    force: options.force,
    actor: options.actor,
    now: options.now,
    fromIssue: n,
    cacheDecisionId: forceNoCache && cacheState !== "accept" ? null : cacheDecisionId,
    cacheStateAtPromote: cacheState,
    forceNoCache,
  });

  warnings.push(
    `[scope:promote --from-issue] cache decision for #${n} was ` +
      `${cacheState === null ? "absent" : `'${cacheState}'`}` +
      (promoteResult.ok ? " (proceeded)" : " (promote failed)"),
  );

  return {
    ...promoteResult,
    warnings,
    repo,
    matchedPaths: matched,
    cacheStateAtPromote: cacheState,
    cacheDecisionId: forceNoCache && cacheState !== "accept" ? null : cacheDecisionId,
  };
}
