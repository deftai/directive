import { join, resolve } from "node:path";
import { type CacheLoader, detectDrift, type FetchLive } from "./drift.js";
import { iterActiveVbriefs } from "./extract.js";
import { type DriftRecord, type FreshnessSummary, PROMPT_OPTIONS } from "./types.js";

export type InputFn = (prompt: string) => string;
export type RefreshLocal = (repo: string, issueNumber: number, projectRoot: string) => void;
export type AuditWriter = (repo: string, issueNumber: number, annotation: string) => void;

function promptUser(drift: DriftRecord, inputFn: InputFn, log: (line: string) => void): string {
  log("");
  log(`Drift detected for ${drift.repo}#${drift.issueNumber}:`);
  log(`  cached fetched_at: ${JSON.stringify(drift.cachedFetchedAt)}`);
  log(`  live   updatedAt:  ${JSON.stringify(drift.liveUpdatedAt)}`);
  log(`  vBRIEF: ${drift.vbriefPath}`);
  log("  1) proceed-with-stale");
  log("  2) refresh-and-update-local");
  log("  3) defer-from-this-batch");
  const raw = inputFn("Choose [1/2/3]: ").trim();
  return PROMPT_OPTIONS[raw] ?? "defer-from-this-batch";
}

function defaultAuditWriter(
  repo: string,
  issueNumber: number,
  annotation: string,
  log: (line: string) => void,
): void {
  log(
    `[triage:refresh-active] WARN: audit annotation for ${repo}#${issueNumber} not persisted -- candidates_log rejected the entry. The proceed-with-stale choice has been logged to stdout but the JSONL trail does not yet recognize 'freshness-annotation'.`,
  );
  void annotation;
}

export interface RefreshActiveOptions {
  readonly activeDir?: string;
  readonly inputFn?: InputFn;
  readonly fetchLive?: FetchLive;
  readonly cacheLoader?: CacheLoader;
  readonly refreshLocal?: RefreshLocal;
  readonly auditWriter?: AuditWriter;
  readonly log?: (line: string) => void;
}

export function refreshActive(
  projectRoot: string,
  options: RefreshActiveOptions = {},
): FreshnessSummary {
  const root = resolve(projectRoot);
  const activeDir = options.activeDir ?? join(root, "vbrief", "active");
  const log = options.log ?? ((line: string) => process.stdout.write(`${line}\n`));
  const inputFn = options.inputFn ?? (() => "");
  const refreshLocal = options.refreshLocal ?? (() => {});
  const auditWriter =
    options.auditWriter ?? ((repo, num, ann) => defaultAuditWriter(repo, num, ann, log));

  const activeFiles = iterActiveVbriefs(activeDir);
  if (activeFiles.length === 0) {
    log("[triage:refresh-active] vbrief/active/ is empty -- no-op");
    return {
      totalActive: 0,
      driftsDetected: 0,
      proceeded: [],
      refreshed: [],
      deferred: [],
      skipped: [],
    };
  }

  const skippedRecords: Array<[string, number, string]> = [];
  const checkedPairs: Array<[string, number]> = [];
  const drifts = detectDrift(activeDir, root, {
    fetchLive: options.fetchLive,
    cacheLoader: options.cacheLoader,
    skippedOut: skippedRecords,
    checkedOut: checkedPairs,
    log,
  });
  const skippedPairs = skippedRecords.map(([repo, num]) => [repo, num] as [string, number]);

  if (drifts.length === 0) {
    if (skippedPairs.length > 0) {
      log(
        `[triage:refresh-active] WARN: no drift detected, but ${skippedPairs.length} of ${checkedPairs.length} (repo, issue) fetch(es) were skipped (treat freshness signal as unverified)`,
      );
    } else {
      log(`[triage:refresh-active] all ${activeFiles.length} active vBRIEFs fresh`);
    }
    return {
      totalActive: activeFiles.length,
      driftsDetected: 0,
      proceeded: [],
      refreshed: [],
      deferred: [],
      skipped: skippedPairs,
    };
  }

  const proceeded: Array<[string, number]> = [];
  const refreshed: Array<[string, number]> = [];
  const deferred: Array<[string, number]> = [];

  for (const drift of drifts) {
    const choice = promptUser(drift, inputFn, log);
    if (choice === "proceed-with-stale") {
      auditWriter(
        drift.repo,
        drift.issueNumber,
        `proceed-with-stale: cached_fetched_at=${drift.cachedFetchedAt} live_updated_at=${drift.liveUpdatedAt}`,
      );
      proceeded.push([drift.repo, drift.issueNumber]);
      log(
        `[triage:refresh-active] ${drift.repo}#${drift.issueNumber} proceed-with-stale (audit recorded)`,
      );
    } else if (choice === "refresh-and-update-local") {
      refreshLocal(drift.repo, drift.issueNumber, root);
      refreshed.push([drift.repo, drift.issueNumber]);
      log(`[triage:refresh-active] ${drift.repo}#${drift.issueNumber} refreshed-and-updated-local`);
    } else {
      deferred.push([drift.repo, drift.issueNumber]);
      log(`[triage:refresh-active] ${drift.repo}#${drift.issueNumber} deferred-from-this-batch`);
    }
  }

  return {
    totalActive: activeFiles.length,
    driftsDetected: drifts.length,
    proceeded,
    refreshed,
    deferred,
    skipped: skippedPairs,
  };
}
