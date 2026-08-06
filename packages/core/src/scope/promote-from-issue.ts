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

/** Collapse CR/LF in operator-facing messages (SLizard CWE-116). */
function sanitizeMsg(value: string): string {
  return value.replace(/\r?\n/g, " ");
}

/** True when brief references or Origin point at owner/name issue N. */
function briefMatchesIssueAndRepo(
  data: Record<string, unknown>,
  issueNumber: number,
  repo: string | null,
): boolean {
  if (provenanceIssueNumber(data) !== issueNumber) {
    // Also accept plan.references github-issue URIs without Origin text.
    const plan = data.plan;
    if (typeof plan !== "object" || plan === null || Array.isArray(plan)) {
      return false;
    }
    const refs = (plan as Record<string, unknown>).references;
    if (!Array.isArray(refs)) {
      return false;
    }
    let hit = false;
    for (const ref of refs) {
      if (typeof ref !== "object" || ref === null || Array.isArray(ref)) continue;
      const uri = String((ref as Record<string, unknown>).uri ?? "");
      if (uri.includes(`/issues/${issueNumber}`)) {
        hit = true;
        if (
          repo === null ||
          uri.includes(`github.com/${repo}/`) ||
          uri.includes(`${repo}/issues/`)
        ) {
          return true;
        }
      }
    }
    return hit && repo === null;
  }
  if (repo === null) {
    return true;
  }
  const plan = data.plan;
  if (typeof plan === "object" && plan !== null && !Array.isArray(plan)) {
    const refs = (plan as Record<string, unknown>).references;
    if (Array.isArray(refs)) {
      for (const ref of refs) {
        if (typeof ref !== "object" || ref === null || Array.isArray(ref)) continue;
        const uri = String((ref as Record<string, unknown>).uri ?? "");
        if (
          uri.includes(`/issues/${issueNumber}`) &&
          (uri.includes(`github.com/${repo}/`) || uri.includes(`${repo}/issues/`))
        ) {
          return true;
        }
      }
    }
    const narratives = (plan as Record<string, unknown>).narratives;
    if (typeof narratives === "object" && narratives !== null && !Array.isArray(narratives)) {
      const origin = String((narratives as Record<string, unknown>).Origin ?? "");
      if (origin.includes(`github.com/${repo}/issues/${issueNumber}`)) {
        return true;
      }
    }
  }
  // Provenance matched issue number but no repo-scoped URI — refuse when repo known.
  return false;
}

/**
 * Locate lifecycle artifacts whose provenance owns ``issueNumber`` (optionally repo-scoped).
 */
export function findLifecycleArtifactsForIssue(
  projectRoot: string,
  issueNumber: number,
  options: { folder?: "proposed" | "pending"; repo?: string | null } = {},
): string[] {
  const folder = options.folder ?? "proposed";
  const repo = options.repo ?? null;
  const root = resolve(projectRoot);
  let lifecycleRoot: string;
  try {
    lifecycleRoot = resolveLifecycleRoot(root);
  } catch {
    return [];
  }

  const byIssue = scanProvenanceRefs(lifecycleRoot);
  const rels = (byIssue.get(issueNumber) ?? []).filter((rel) => {
    const f = rel.split(/[/\\]/)[0];
    return f === folder;
  });

  const candidates = rels.map((rel) => join(lifecycleRoot, rel));

  // Always also scan the folder for Origin-only scaffolds.
  const folderDir = join(lifecycleRoot, folder);
  if (existsSync(folderDir)) {
    for (const name of readdirSync(folderDir).filter((f) => hasArtifactSuffix(f))) {
      candidates.push(join(folderDir, name));
    }
  }

  const out: string[] = [];
  for (const abs of uniqueExisting(candidates)) {
    try {
      const data = JSON.parse(readFileSync(abs, "utf8")) as Record<string, unknown>;
      if (briefMatchesIssueAndRepo(data, issueNumber, repo)) {
        out.push(abs);
      }
    } catch {
      /* skip */
    }
  }
  return uniqueExisting(out);
}

/** Locate proposed/ artifacts for issue N (repo-scoped when provided). */
export function findProposedArtifactsForIssue(
  projectRoot: string,
  issueNumber: number,
  repo: string | null = null,
): string[] {
  return findLifecycleArtifactsForIssue(projectRoot, issueNumber, { folder: "proposed", repo });
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
  const repoSafe = sanitizeMsg(repo);

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
            `No triage-cache decision for #${n} (${repoSafe}). ` +
            `Accept first: task triage:accept -- --issue ${n} --repo ${repoSafe} ` +
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
        `[scope:promote --from-issue] no triage-cache decision for #${n} (${repoSafe}); proceeding (soft warn). Use --strict to fail.`,
      );
    } else if (latest.decision !== "accept") {
      return {
        ok: false,
        message:
          `Refusing promote for #${n} (${repoSafe}): latest triage decision is '${sanitizeMsg(latest.decision)}' ` +
          `(decision_id=${latest.decision_id}). ` +
          `Accept first: task triage:accept -- --issue ${n} --repo ${repoSafe} ` +
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
        `(cache decision was ${cacheState === null ? "absent" : `'${sanitizeMsg(cacheState)}'`}).`,
    );
  }

  // Already in pending/ for this issue → idempotent success (auto-promote re-entry).
  const alreadyPending = findLifecycleArtifactsForIssue(projectRoot, n, {
    folder: "pending",
    repo,
  });
  if (alreadyPending.length === 1 && options.explicitPath === undefined) {
    warnings.push(
      `[scope:promote --from-issue] #${n} already pending (${sanitizeMsg(alreadyPending[0] ?? "")}); no-op.`,
    );
    return {
      ok: true,
      message: `No-op: issue #${n} already has pending scope ${alreadyPending[0]}`,
      exitCode: 0,
      warnings,
      repo,
      matchedPaths: alreadyPending,
      cacheStateAtPromote: cacheState,
      cacheDecisionId: forceNoCache && cacheState !== "accept" ? null : cacheDecisionId,
      destPath: alreadyPending[0],
    };
  }

  let matched = findProposedArtifactsForIssue(projectRoot, n, repo);
  if (options.explicitPath !== undefined && options.explicitPath.trim().length > 0) {
    const raw = options.explicitPath.trim();
    const explicit = isAbsolute(raw) ? resolve(raw) : resolve(projectRoot, raw);
    if (!existsSync(explicit)) {
      return {
        ok: false,
        message: `Explicit path not found: ${sanitizeMsg(explicit)}`,
        exitCode: 2,
        warnings,
        repo,
        matchedPaths: matched,
        cacheStateAtPromote: cacheState,
        cacheDecisionId,
      };
    }
    // Never accept an unrelated path — must match issue provenance (and repo).
    try {
      const data = JSON.parse(readFileSync(explicit, "utf8")) as Record<string, unknown>;
      if (!briefMatchesIssueAndRepo(data, n, repo)) {
        return {
          ok: false,
          message: `Explicit path is not a provenance match for #${n} (${repoSafe}): ${sanitizeMsg(explicit)}.`,
          exitCode: 2,
          warnings,
          repo,
          matchedPaths: matched,
          cacheStateAtPromote: cacheState,
          cacheDecisionId,
        };
      }
    } catch (err) {
      return {
        ok: false,
        message: `Explicit path is not readable JSON: ${sanitizeMsg(explicit)} (${String(err)})`,
        exitCode: 2,
        warnings,
        repo,
        matchedPaths: matched,
        cacheStateAtPromote: cacheState,
        cacheDecisionId,
      };
    }
    if (matched.length > 0) {
      const hit = matched.find((p) => resolve(p) === explicit);
      if (hit === undefined) {
        return {
          ok: false,
          message:
            `Explicit path is not among proposed matches for #${n}: ${sanitizeMsg(explicit)}. ` +
            `Matched: ${matched.map(sanitizeMsg).join(", ")}`,
          exitCode: 2,
          warnings,
          repo,
          matchedPaths: matched,
          cacheStateAtPromote: cacheState,
          cacheDecisionId,
        };
      }
      matched = [hit];
    } else {
      matched = [explicit];
    }
  }

  if (matched.length === 0) {
    return {
      ok: false,
      message:
        `No proposed/ scope artifact found for issue #${n} (${repoSafe}). ` +
        `Ingest first (task triage:accept -- --issue ${n} --repo ${repoSafe}) ` +
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
    const list = matched.map((p) => `  - ${sanitizeMsg(p)}`).join("\n");
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
    requireAudit: true,
  });

  warnings.push(
    `[scope:promote --from-issue] cache decision for #${n} was ` +
      `${cacheState === null ? "absent" : `'${sanitizeMsg(cacheState)}'`}` +
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
