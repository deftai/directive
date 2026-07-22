import { referenceTypeMatches } from "@deftai/directive-types";
import { parseGithubIssueUri } from "../triage/reconcile/parse-uri.js";

export interface IssueRef {
  readonly repo: string;
  readonly number: number;
}

export interface PrRef {
  readonly repo: string;
  readonly number: number;
}

/** Parse (repo, pr_number) from a github-pr reference URI. */
export function parseGithubPrUri(uri: unknown): [string | null, number | null] {
  if (typeof uri !== "string") {
    return [null, null];
  }
  const cleaned = uri.trim().replace(/\/$/, "");
  if (!cleaned) {
    return [null, null];
  }
  const noScheme = cleaned.includes("://") ? cleaned.split("://").slice(1).join("://") : cleaned;
  const parts = noScheme.split("/").filter(Boolean);
  if (parts.length >= 4 && parts[parts.length - 2] === "pull") {
    const tail = parts[parts.length - 1] ?? "";
    if (/^\d+$/.test(tail)) {
      const owner = parts[parts.length - 4];
      const repo = parts[parts.length - 3];
      if (owner && repo) {
        return [`${owner}/${repo}`, Number(tail)];
      }
    }
  }
  const tail = parts[parts.length - 1] ?? "";
  if (/^\d+$/.test(tail)) {
    return [null, Number(tail)];
  }
  return [null, null];
}

function parseTrackingIssue(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }
  if (typeof value !== "string") {
    return null;
  }
  const match = value.match(/#(\d+)/);
  return match ? Number(match[1]) : null;
}

function addIssueRef(
  out: IssueRef[],
  seen: Set<string>,
  repo: string | null,
  number: number | null,
  defaultRepo: string | null,
): void {
  if (number === null) {
    return;
  }
  const resolvedRepo = repo ?? defaultRepo;
  if (resolvedRepo === null || resolvedRepo.length === 0) {
    return;
  }
  const key = `${resolvedRepo}:${number}`;
  if (seen.has(key)) {
    return;
  }
  seen.add(key);
  out.push({ repo: resolvedRepo, number });
}

function addPrRef(
  out: PrRef[],
  seen: Set<string>,
  repo: string | null,
  number: number | null,
  defaultRepo: string | null,
): void {
  if (number === null) {
    return;
  }
  const resolvedRepo = repo ?? defaultRepo;
  if (resolvedRepo === null || resolvedRepo.length === 0) {
    return;
  }
  const key = `${resolvedRepo}:${number}`;
  if (seen.has(key)) {
    return;
  }
  seen.add(key);
  out.push({ repo: resolvedRepo, number });
}

/** Collect GitHub issue and PR refs from a scope plan object. */
export function collectGithubRefs(
  plan: Record<string, unknown>,
  defaultRepo: string | null,
): { issues: IssueRef[]; prs: PrRef[] } {
  const issues: IssueRef[] = [];
  const prs: PrRef[] = [];
  const seenIssues = new Set<string>();
  const seenPrs = new Set<string>();

  const refs = plan.references;
  if (Array.isArray(refs)) {
    for (const ref of refs) {
      if (typeof ref !== "object" || ref === null || Array.isArray(ref)) {
        continue;
      }
      const typed = ref as Record<string, unknown>;
      const type = String(typed.type ?? "");
      if (referenceTypeMatches(type, "github-issue")) {
        const [repo, number] = parseGithubIssueUri(typed.uri);
        addIssueRef(issues, seenIssues, repo, number, defaultRepo);
      } else if (referenceTypeMatches(type, "github-pr")) {
        const [repo, number] = parseGithubPrUri(typed.uri);
        addPrRef(prs, seenPrs, repo, number, defaultRepo);
      }
    }
  }

  const metadata = plan.metadata;
  if (typeof metadata === "object" && metadata !== null && !Array.isArray(metadata)) {
    const tracking = (metadata as Record<string, unknown>)["x-tracking"];
    if (typeof tracking === "object" && tracking !== null && !Array.isArray(tracking)) {
      const t = tracking as Record<string, unknown>;
      addIssueRef(issues, seenIssues, defaultRepo, parseTrackingIssue(t.parent_issue), defaultRepo);
      addIssueRef(
        issues,
        seenIssues,
        defaultRepo,
        parseTrackingIssue(t.decomposition_origin),
        defaultRepo,
      );
    }
  }

  return { issues, prs };
}
