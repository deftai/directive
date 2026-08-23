import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
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

/**
 * Evaluator-owned. Reads only `worktreeRoot` (detached origin/master).
 * Must not accept a WIP census argument.
 */
export function evaluateValidity(worktreeRoot: string, issue: number): ValidityVerdict {
  const completed = listXbriefHits(worktreeRoot, "completed").filter((hit) => hit.issue === issue);
  const pending = listXbriefHits(worktreeRoot, "pending").filter((hit) => hit.issue === issue);
  const active = listXbriefHits(worktreeRoot, "active").filter((hit) => hit.issue === issue);
  const proposed = listXbriefHits(worktreeRoot, "proposed").filter((hit) => hit.issue === issue);
  const adrHits = filesMentionIssue(join(worktreeRoot, ADR_DIR), issue);
  const contractHits = filesMentionIssue(join(worktreeRoot, CONTRACT_DIR), issue);

  if (completed.length > 0) {
    return {
      state: "likely-shipped",
      evidence: `completed xbrief on origin/master: ${completed[0]?.path}`,
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
