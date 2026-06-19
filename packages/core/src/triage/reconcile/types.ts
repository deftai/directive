export const AUDIT_LOG_RELPATH = "vbrief/.eval/candidates.jsonl";
export const BACKFILL_FOLDERS = ["proposed", "pending", "active"] as const;
export const RECONCILE_ACTOR = "agent:reconcile";

export interface ReconcileItem {
  readonly repo: string;
  readonly issueNumber: number;
  readonly folder: string;
  readonly path: string;
}

export interface ReconcileResult {
  readonly projectRoot: string;
  readonly defaultRepo: string | null;
  readonly restored: number;
  readonly skippedExisting: number;
  readonly skippedNoRepo: number;
  readonly dryRun: boolean;
  readonly items: readonly ReconcileItem[];
  readonly error: string | null;
  readonly exitCode: 0 | 1 | 2;
}

export function reconcileSummary(result: ReconcileResult): string {
  const verb = result.dryRun ? "would restore" : "restored";
  const mark = result.exitCode === 0 ? "✓" : "✗";
  const lines = ["", "Triage audit-log reconcile recap:"];
  lines.push(
    `  ${mark} ${verb} ${result.restored} accept decision(s) from on-disk ` +
      `vBRIEFs; skipped ${result.skippedExisting} (already in audit log)`,
  );
  if (result.skippedNoRepo > 0) {
    lines.push(
      `      skipped ${result.skippedNoRepo} vBRIEF(s) with no ` +
        "resolvable repo (no owner/name in the github-issue reference " +
        "and no --repo / git remote fallback)",
    );
  }
  if (result.error) {
    lines.push(`      error: ${result.error}`);
  }
  if (result.items.length > 0) {
    lines.push("");
    lines.push("  Issues reconciled:");
    for (const item of result.items) {
      lines.push(`    #${item.issueNumber} (${item.repo}) <- vbrief/${item.folder}/`);
    }
  }
  if (result.exitCode === 0 && result.items.length === 0 && !result.dryRun) {
    lines.push("");
    lines.push("  Nothing to reconcile -- the audit log already covers every in-scope vBRIEF.");
  }
  return lines.join("\n");
}

function pythonStyleJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => pythonStyleJson(item)).join(", ")}]`;
  }
  if (typeof value === "object") {
    const keys = Object.keys(value as object).sort();
    const body = keys
      .map(
        (key) =>
          `${JSON.stringify(key)}: ${pythonStyleJson((value as Record<string, unknown>)[key])}`,
      )
      .join(", ");
    return `{${body}}`;
  }
  return "null";
}

export function emitReconcileJson(result: ReconcileResult): string {
  const payload = {
    default_repo: result.defaultRepo,
    dry_run: result.dryRun,
    error: result.error,
    exit_code: result.exitCode,
    items: result.items.map((item) => ({
      folder: item.folder,
      issue_number: item.issueNumber,
      repo: item.repo,
    })),
    project_root: result.projectRoot,
    restored: result.restored,
    skipped_existing: result.skippedExisting,
    skipped_no_repo: result.skippedNoRepo,
  };
  return pythonStyleJson(payload);
}
