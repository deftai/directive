import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  briefOwnsIssue,
  findNonterminalResidualHits,
  findOwnedCompletedHits,
  residualRecoveryCommand,
} from "../../intake/residual-identity.js";
import { resolveLifecycleRoot } from "../../layout/resolve.js";
import type { ValidityVerdict } from "./types.js";
import { listXbriefHits } from "./xbrief-refs.js";

const ADR_DIR = join("docs", "decisions");
const CONTRACT_DIR = join("content", "contracts");

function filesMentionIssue(dir: string, issue: number): string[] {
  if (!existsSync(dir)) {
    return [];
  }
  const needle = `#${issue}`;
  const hits: string[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".md")) {
      continue;
    }
    const path = join(dir, name);
    try {
      const text = readFileSync(path, "utf8");
      if (text.includes(needle) || text.includes(`/issues/${issue}`)) {
        hits.push(path);
      }
    } catch {}
  }
  return hits;
}

function ownedHitsInFolder(
  worktreeRoot: string,
  folder: "completed" | "pending" | "active" | "proposed",
  issue: number,
): ReturnType<typeof listXbriefHits> {
  const hits = listXbriefHits(worktreeRoot, folder).filter((hit) => hit.issue === issue);
  return hits.filter((hit) => {
    try {
      const data = JSON.parse(readFileSync(hit.path, "utf8")) as Record<string, unknown>;
      return briefOwnsIssue(data, issue);
    } catch {
      return false;
    }
  });
}

/**
 * Evaluator-owned. Reads only `worktreeRoot` (detached origin/master).
 * Must not accept a WIP census argument.
 *
 * Completed / needs-re-scope ownership uses ingest-owner Origin and/or plan.id
 * (#5177 Prefer-A) — not bare plan.references.
 */
export function evaluateValidity(worktreeRoot: string, issue: number): ValidityVerdict {
  const completed = ownedHitsInFolder(worktreeRoot, "completed", issue);
  const pending = ownedHitsInFolder(worktreeRoot, "pending", issue);
  const active = ownedHitsInFolder(worktreeRoot, "active", issue);
  const proposed = ownedHitsInFolder(worktreeRoot, "proposed", issue);
  const adrHits = filesMentionIssue(join(worktreeRoot, ADR_DIR), issue);
  const contractHits = filesMentionIssue(join(worktreeRoot, CONTRACT_DIR), issue);

  const residualLive = [...proposed, ...pending, ...active].filter((hit) => {
    try {
      const data = JSON.parse(readFileSync(hit.path, "utf8")) as Record<string, unknown>;
      const plan =
        data.plan !== null && typeof data.plan === "object" && !Array.isArray(data.plan)
          ? (data.plan as Record<string, unknown>)
          : null;
      const id = typeof plan?.id === "string" ? plan.id : "";
      return id.startsWith("github.issue.residual.");
    } catch {
      return false;
    }
  });

  if (completed.length > 0 && residualLive.length > 0) {
    return {
      state: "residual-in-flight",
      evidence:
        `completed history ${completed[0]?.path}; live residual ${residualLive[0]?.path}` +
        ` (recovery ${residualRecoveryCommand(issue)} retired while residual is non-terminal)`,
      worktreePath: worktreeRoot,
      sessionStartReadOnly: true,
    };
  }

  if (completed.length > 0) {
    return {
      state: "likely-shipped",
      evidence: `owned completed xbrief on origin/master: ${completed[0]?.path}`,
      worktreePath: worktreeRoot,
      sessionStartReadOnly: true,
    };
  }
  if (pending.length > 0 || active.length > 0 || proposed.length > 0) {
    const hit = pending[0] ?? active[0] ?? proposed[0];
    return {
      state: "partial",
      evidence: `committed lifecycle xbrief on origin/master: ${hit?.path}`,
      worktreePath: worktreeRoot,
      sessionStartReadOnly: true,
    };
  }
  if (adrHits.length > 0 || contractHits.length > 0) {
    return {
      state: "partial",
      evidence: `ADR/contract mention on origin/master: ${adrHits[0] ?? contractHits[0] ?? ""}`,
      worktreePath: worktreeRoot,
      sessionStartReadOnly: true,
    };
  }
  return {
    state: "still-open",
    evidence: "no origin/master lifecycle coverage, ADR, or contract mention",
    worktreePath: worktreeRoot,
    sessionStartReadOnly: true,
  };
}

export function joinValidityWithGithub(
  validity: ValidityVerdict,
  githubState: "open" | "closed" | null,
): ValidityVerdict {
  if (githubState === "closed" && validity.state === "still-open") {
    return {
      ...validity,
      state: "likely-shipped",
      evidence: `${validity.evidence}; GitHub issue state=closed`,
    };
  }
  if (githubState === "open" && validity.state === "likely-shipped") {
    return {
      ...validity,
      state: "needs-re-scope",
      evidence: `${validity.evidence}; GitHub issue still open`,
    };
  }
  return validity;
}

/**
 * Attach the residual recovery verb for needs-re-scope when issue number is known.
 * Prefer this over parsing evidence for the issue id.
 */
export function withNeedsReScopeRecovery(
  validity: ValidityVerdict,
  issueNumber: number,
): ValidityVerdict {
  if (validity.state !== "needs-re-scope") {
    return validity;
  }
  const recovery = residualRecoveryCommand(issueNumber);
  if (validity.evidence.includes(recovery)) {
    return validity;
  }
  return {
    ...validity,
    evidence: `${validity.evidence}; recovery: ${recovery}`,
  };
}

/**
 * Live project-root overlay (#5177): after residual mint on the operator tree,
 * retire sticky needs-re-scope even when origin/master detached validity still
 * sees only completed history.
 */
export function applyLiveResidualOverlay(
  validity: ValidityVerdict,
  projectRoot: string,
  issueNumber: number,
): ValidityVerdict {
  if (validity.state === "residual-in-flight") {
    return validity;
  }
  let lifecycleRoot: string | null = null;
  try {
    lifecycleRoot = resolveLifecycleRoot(projectRoot);
  } catch {
    lifecycleRoot = null;
  }
  if (lifecycleRoot !== null) {
    const liveResiduals = findNonterminalResidualHits(lifecycleRoot, issueNumber);
    if (
      liveResiduals.length > 0 &&
      (validity.state === "needs-re-scope" || validity.state === "likely-shipped")
    ) {
      const completed = findOwnedCompletedHits(lifecycleRoot, issueNumber);
      const completedPath = completed[0]?.relPath ?? "completed/(owned)";
      const residualPath = liveResiduals[0]?.relPath ?? "proposed/(residual)";
      return {
        state: "residual-in-flight",
        evidence:
          `completed history ${completedPath}; live residual ${residualPath}` +
          ` (recovery ${residualRecoveryCommand(issueNumber)} retired while residual is non-terminal)`,
        worktreePath: validity.worktreePath,
        sessionStartReadOnly: true,
      };
    }
  }
  return withNeedsReScopeRecovery(validity, issueNumber);
}
