import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { call } from "../scm/call.js";
import { extractIssueRef } from "../triage/reconcile/parse-uri.js";
import { depResolved, RESOLVED_FOLDERS } from "./graph.js";
import { allScopeIds, asStrList } from "./swarm-deps.js";
import type { LabelChange, LabelClient, ReconcileLabelsOutcome } from "./types.js";

export const SCAN_FOLDERS = ["proposed", "pending", "active"] as const;
export const MANAGED_LABELS = ["status:blocked", "epic", "status:tracker", "rfc"] as const;
const SCM_SOURCE = "github-issue";

export class ScmLabelError extends Error {
  override name = "ScmLabelError";
}

export function computeDesiredLabels(
  plan: Record<string, unknown>,
  unresolvedDeps: boolean,
): Set<string> {
  const desired = new Set<string>();
  const status = plan.status;
  const metadata =
    typeof plan.metadata === "object" && plan.metadata !== null && !Array.isArray(plan.metadata)
      ? (plan.metadata as Record<string, unknown>)
      : {};
  const kind = metadata.kind;
  if (status === "blocked" || unresolvedDeps) desired.add("status:blocked");
  if (kind === "epic") {
    desired.add("epic");
    desired.add("status:tracker");
  } else if (kind === "research") {
    desired.add("rfc");
  }
  return desired;
}

export class ScmLabelClient implements LabelClient {
  fetchLabels(repo: string, issueNumber: number): string[] {
    const proc = call(SCM_SOURCE, "issue", [
      "view",
      String(issueNumber),
      "--repo",
      repo,
      "--json",
      "labels",
    ]);
    if (proc.returncode !== 0) {
      throw new ScmLabelError(
        `issue view #${issueNumber} (${repo}) failed: ${(proc.stderr || "").trim()}`,
      );
    }
    let data: unknown;
    try {
      data = JSON.parse(proc.stdout || "{}");
    } catch (exc) {
      throw new ScmLabelError(
        `issue view #${issueNumber} (${repo}) returned non-JSON: ${String(exc)}`,
      );
    }
    const labels =
      typeof data === "object" && data !== null && !Array.isArray(data)
        ? (data as Record<string, unknown>).labels
        : null;
    if (!Array.isArray(labels)) return [];
    const names: string[] = [];
    for (const entry of labels) {
      if (typeof entry === "object" && entry !== null && !Array.isArray(entry)) {
        const name = (entry as Record<string, unknown>).name;
        if (typeof name === "string") names.push(name);
      } else if (typeof entry === "string") {
        names.push(entry);
      }
    }
    return names;
  }

  apply(
    repo: string,
    issueNumber: number,
    add: readonly string[],
    remove: readonly string[],
  ): void {
    const args = ["edit", String(issueNumber), "--repo", repo];
    for (const name of add) args.push("--add-label", name);
    for (const name of remove) args.push("--remove-label", name);
    const proc = call(SCM_SOURCE, "issue", args);
    if (proc.returncode !== 0) {
      throw new ScmLabelError(
        `issue edit #${issueNumber} (${repo}) failed: ${(proc.stderr || "").trim()}`,
      );
    }
  }
}

function hasUnresolvedDeps(
  swarm: Record<string, unknown>,
  knownIds: Record<string, [string, string]>,
): boolean {
  return asStrList(swarm.depends_on).some((dep) => !depResolved(dep, knownIds));
}

export interface ReconcileLabelsOptions {
  readonly repo?: string | null;
  readonly dryRun?: boolean;
  readonly client?: LabelClient;
}

export function reconcileLabels(
  projectRoot: string,
  options: ReconcileLabelsOptions = {},
): [number, ReconcileLabelsOutcome] {
  const root = resolve(projectRoot);
  const vbriefDir = join(root, "vbrief");
  if (!existsSync(vbriefDir)) {
    return [
      2,
      {
        changed: [],
        unchanged: [],
        skipped_no_ref: [],
        errors: [],
        dry_run: options.dryRun ?? false,
      },
    ];
  }

  const client = options.client ?? new ScmLabelClient();
  const knownIds = allScopeIds(root);
  const outcome: ReconcileLabelsOutcome = {
    changed: [],
    unchanged: [],
    skipped_no_ref: [],
    errors: [],
    dry_run: options.dryRun ?? false,
  };
  const seenIssues = new Set<string>();

  for (const folder of SCAN_FOLDERS) {
    const folderPath = join(vbriefDir, folder);
    if (!existsSync(folderPath)) continue;
    const files = readdirSync(folderPath)
      .filter((f) => f.endsWith(".vbrief.json"))
      .sort();
    for (const file of files) {
      const path = join(folderPath, file);
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (typeof data !== "object" || data === null) continue;
      const plan =
        typeof data.plan === "object" && data.plan !== null && !Array.isArray(data.plan)
          ? (data.plan as Record<string, unknown>)
          : {};
      const storyId = String(plan.id ?? file.slice(0, -".vbrief.json".length));

      const [refRepo, number] = extractIssueRef(data);
      const effectiveRepo = refRepo ?? options.repo ?? null;
      if (number === null || effectiveRepo === null) {
        outcome.skipped_no_ref.push(storyId);
        continue;
      }
      const key = `${effectiveRepo}:${number}`;
      if (seenIssues.has(key)) continue;
      seenIssues.add(key);

      const metadata =
        typeof plan.metadata === "object" && plan.metadata !== null && !Array.isArray(plan.metadata)
          ? (plan.metadata as Record<string, unknown>)
          : {};
      const swarm =
        typeof metadata.swarm === "object" &&
        metadata.swarm !== null &&
        !Array.isArray(metadata.swarm)
          ? (metadata.swarm as Record<string, unknown>)
          : {};
      const desired = computeDesiredLabels(plan, hasUnresolvedDeps(swarm, knownIds));

      let current: string[];
      try {
        current = client.fetchLabels(effectiveRepo, number);
      } catch (exc) {
        outcome.errors.push({ story_id: storyId, message: String(exc) });
        continue;
      }

      const managedSet = new Set<string>(MANAGED_LABELS);
      const currentManaged = new Set(current.filter((n) => managedSet.has(n)));
      const add = [...desired].filter((n) => !currentManaged.has(n)).sort();
      const remove = [...currentManaged].filter((n) => !desired.has(n)).sort();
      const change: LabelChange = {
        story_id: storyId,
        repo: effectiveRepo,
        issue_number: number,
        current: [...current].sort(),
        desired: [...desired].sort(),
        add,
        remove,
      };

      if (add.length === 0 && remove.length === 0) {
        outcome.unchanged.push(change);
        continue;
      }
      if (options.dryRun) {
        outcome.changed.push(change);
        continue;
      }
      try {
        client.apply(effectiveRepo, number, add, remove);
      } catch (exc) {
        outcome.errors.push({ story_id: storyId, message: String(exc) });
        continue;
      }
      outcome.changed.push(change);
    }
  }

  return [outcome.errors.length > 0 ? 1 : 0, outcome];
}

export function renderLabelsReport(outcome: ReconcileLabelsOutcome): string {
  const lines: string[] = ["vBRIEF reconcile labels", ""];
  const suffix = outcome.dry_run ? " (dry-run)" : "";

  lines.push(`Changed${suffix}:`);
  if (outcome.changed.length > 0) {
    for (const change of outcome.changed) {
      const parts: string[] = [];
      if (change.add.length > 0) parts.push(`+${change.add.join(", +")}`);
      if (change.remove.length > 0) parts.push(`-${change.remove.join(", -")}`);
      lines.push(
        `- #${change.issue_number} (${change.repo}) [${change.story_id}]: ${parts.join("; ")}`,
      );
    }
  } else {
    lines.push("- none");
  }
  lines.push("");

  lines.push("Unchanged:");
  if (outcome.unchanged.length > 0) {
    for (const c of outcome.unchanged) {
      lines.push(`- #${c.issue_number} (${c.repo}) [${c.story_id}]`);
    }
  } else {
    lines.push("- none");
  }

  if (outcome.skipped_no_ref.length > 0) {
    lines.push("");
    lines.push("Skipped (no github-issue reference / repo):");
    for (const sid of outcome.skipped_no_ref) lines.push(`- ${sid}`);
  }

  if (outcome.errors.length > 0) {
    lines.push("");
    lines.push("Errors:");
    for (const err of outcome.errors) lines.push(`- ${err.story_id}: ${err.message}`);
  }

  return lines.join("\n");
}

export function labelsOutcomeToJson(outcome: ReconcileLabelsOutcome): Record<string, unknown> {
  const toChange = (c: LabelChange) => ({
    story_id: c.story_id,
    repo: c.repo,
    issue_number: c.issue_number,
    current: [...c.current],
    desired: [...c.desired],
    add: [...c.add],
    remove: [...c.remove],
  });
  return {
    changed: outcome.changed.map(toChange),
    unchanged: outcome.unchanged.map(toChange),
    skipped_no_ref: [...outcome.skipped_no_ref],
    errors: outcome.errors.map((e) => ({ story_id: e.story_id, message: e.message })),
    dry_run: outcome.dry_run,
  };
}

// Re-export for tests
export { RESOLVED_FOLDERS };
