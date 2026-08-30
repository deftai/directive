import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  assertProjectionContained,
  assertWriteTargetSafe,
  ProjectionContainmentError,
} from "../fs/projection-containment.js";
import { hasArtifactSuffix, resolveLifecycleRoot } from "../layout/resolve.js";
import { missingEnvelopeMessage, stampExistingEnvelopes } from "../lifecycle/brief-envelope.js";
import { type CallOptions, type CompletedProcess, call } from "../scm/call.js";
import { updateDecomposedChildBackReferences } from "../scope/decomposed-refs.js";
import { resolveProjectRoot } from "../scope/project-context.js";
import { resolveProjectRepo } from "../slice/project-context.js";
import { FOLDER_ALLOWED_STATUSES } from "../vbrief-validate/constants.js";

export const LIFECYCLE_FOLDERS = [
  "proposed",
  "pending",
  "active",
  "completed",
  "cancelled",
] as const;

export const TERMINAL_LIFECYCLE_FOLDERS = new Set<string>(["completed", "cancelled"]);

export const GITHUB_ISSUE_REF_TYPES = new Set<string>([
  "github-issue",
  "x-vbrief/github-issue",
  "x-xbrief/github-issue",
]);

export const CANCELLED_STATE_REASONS = new Set<string>(["NOT_PLANNED", "DUPLICATE"]);

const ISSUE_URL_PATTERN = /https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/issues\/(\d+)/;
const ISSUE_ID_PATTERN = /^#(\d+)$/;

export const ISSUE_FETCH_LIMIT = 1000;
export const GRAPHQL_BATCH_SIZE = 200;
export const DEFAULT_MAX_OPEN_ISSUES = 1000;

/** GitHub issue state plus optional stateReason (#1290). */
export class IssueState {
  readonly value: string;
  readonly stateReason: string | null;

  constructor(state: string, stateReason: string | null = null) {
    this.value = state;
    this.stateReason = stateReason;
  }

  toString(): string {
    return this.value;
  }
}

export function stateReasonOf(value: unknown): string | null {
  if (value instanceof IssueState) {
    return value.stateReason;
  }
  return null;
}

export function isTerminalLifecyclePath(relPath: string): boolean {
  const slash = relPath.indexOf("/");
  if (slash < 0) {
    return false;
  }
  return TERMINAL_LIFECYCLE_FOLDERS.has(relPath.slice(0, slash));
}

export function extractReferencesFromVbrief(
  data: Record<string, unknown>,
): Record<string, unknown>[] {
  const refs: Record<string, unknown>[] = [];
  const plan = (data.plan ?? {}) as Record<string, unknown>;

  for (const ref of (plan.references ?? []) as unknown[]) {
    if (ref !== null && typeof ref === "object" && !Array.isArray(ref)) {
      refs.push(ref as Record<string, unknown>);
    }
  }

  const walkItems = (items: unknown): void => {
    if (!Array.isArray(items)) {
      return;
    }
    for (const item of items) {
      if (item === null || typeof item !== "object" || Array.isArray(item)) {
        continue;
      }
      const itemObj = item as Record<string, unknown>;
      for (const ref of (itemObj.references ?? []) as unknown[]) {
        if (ref !== null && typeof ref === "object" && !Array.isArray(ref)) {
          refs.push(ref as Record<string, unknown>);
        }
      }
      walkItems(itemObj.subItems);
      walkItems(itemObj.items);
    }
  };

  walkItems(plan.items);
  return refs;
}

export function parseIssueNumber(ref: Record<string, unknown>): number | null {
  for (const key of ["uri", "url"] as const) {
    const value = ref[key];
    if (typeof value === "string" && value.length > 0) {
      const m = ISSUE_URL_PATTERN.exec(value);
      if (m?.[3]) {
        return Number.parseInt(m[3], 10);
      }
    }
  }
  const refId = ref.id;
  if (typeof refId === "string") {
    const m = ISSUE_ID_PATTERN.exec(refId);
    if (m?.[1]) {
      return Number.parseInt(m[1], 10);
    }
  }
  return null;
}

export function scanVbriefDir(vbriefDir: string): Map<number, string[]> {
  const issueToVbriefs = new Map<number, string[]>();

  for (const folder of LIFECYCLE_FOLDERS) {
    const folderPath = join(vbriefDir, folder);
    try {
      if (!statSync(folderPath).isDirectory()) {
        continue;
      }
    } catch {
      continue;
    }
    const files = readdirSync(folderPath)
      .filter((f) => hasArtifactSuffix(f))
      .sort();
    for (const filename of files) {
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(readFileSync(join(folderPath, filename), "utf8")) as Record<
          string,
          unknown
        >;
      } catch {
        continue;
      }
      const refs = extractReferencesFromVbrief(data);
      const relPath = `${folder}/${filename}`;
      for (const ref of refs) {
        if (!GITHUB_ISSUE_REF_TYPES.has(String(ref.type ?? ""))) {
          continue;
        }
        const num = parseIssueNumber(ref);
        if (num !== null) {
          const existing = issueToVbriefs.get(num) ?? [];
          existing.push(relPath);
          issueToVbriefs.set(num, existing);
        }
      }
    }
  }
  return issueToVbriefs;
}

export type ScmCallFn = (
  source: string,
  verb: string,
  args: readonly string[] | null,
  options?: CallOptions,
) => CompletedProcess;

export interface FetchIssuesOptions {
  readonly cwd?: string | null;
  readonly scmCall?: ScmCallFn;
}

function runGhIssueList(
  repo: string,
  limit: string,
  options: FetchIssuesOptions,
): Record<string, unknown>[] | null {
  const scmCall = options.scmCall ?? call;
  let result: CompletedProcess;
  try {
    result = scmCall(
      "github-issue",
      "issue",
      [
        "list",
        "--repo",
        repo,
        "--state",
        "open",
        "--limit",
        limit,
        "--json",
        "number,title,labels,url",
      ],
      { timeout: limit === "0" ? 300 : 60, cwd: options.cwd ?? undefined },
    );
  } catch {
    process.stderr.write("Error: gh CLI not found. Install GitHub CLI.\n");
    return null;
  }

  if (result.returncode !== 0) {
    process.stderr.write(`Error: gh CLI failed: ${result.stderr.trim()}\n`);
    return null;
  }
  try {
    return JSON.parse(result.stdout) as Record<string, unknown>[];
  } catch {
    process.stderr.write("Error: failed to parse gh CLI output.\n");
    return null;
  }
}

export function fetchOpenIssues(
  repo: string,
  options: FetchIssuesOptions = {},
): Record<string, unknown>[] | null {
  const issues = runGhIssueList(repo, String(ISSUE_FETCH_LIMIT), options);
  if (issues !== null && issues.length >= ISSUE_FETCH_LIMIT) {
    process.stderr.write(
      `Warning: fetched ${issues.length} issues (limit ${ISSUE_FETCH_LIMIT}). Report may be incomplete.\n`,
    );
  }
  return issues;
}

export function fetchAllOpenIssues(
  repo: string,
  options: FetchIssuesOptions = {},
): Record<string, unknown>[] | null {
  return runGhIssueList(repo, "0", options);
}

function splitRepoSlug(repo: string): [string, string] | null {
  const parts = repo.split("/", 2);
  if (parts.length !== 2 || parts[0] === "" || parts[1] === "") {
    return null;
  }
  return [parts[0] as string, parts[1] as string];
}

export interface FetchIssueStatesOptions extends FetchIssuesOptions {
  /** @deprecated REST fetch is per-issue; batch size is ignored (#2557 / #954). */
  readonly batchSize?: number;
}

function normalizeRestIssueState(raw: unknown): string {
  if (typeof raw !== "string" || raw.length === 0) {
    return "NOT_FOUND";
  }
  return raw.toUpperCase();
}

function normalizeRestStateReason(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0) {
    return null;
  }
  return raw.toUpperCase();
}

function isRestNotFoundResult(result: CompletedProcess): boolean {
  const stderr = result.stderr.trim();
  return (
    stderr.includes("404") ||
    stderr.includes("Not Found") ||
    stderr.includes("Could not resolve to an Issue")
  );
}

function issueStateFromRestPayload(payload: Record<string, unknown>): IssueState {
  return new IssueState(
    normalizeRestIssueState(payload.state),
    normalizeRestStateReason(payload.state_reason),
  );
}

function fetchOneIssueStateRest(
  owner: string,
  name: string,
  issueNumber: number,
  scmCall: ScmCallFn,
  cwd?: string,
): IssueState | null | "CLI_MISSING" {
  let result: CompletedProcess;
  try {
    result = scmCall("github-issue", "api", [`repos/${owner}/${name}/issues/${issueNumber}`], {
      timeout: 30,
      cwd,
    });
  } catch {
    return "CLI_MISSING";
  }

  if (result.returncode !== 0) {
    if (isRestNotFoundResult(result)) {
      return new IssueState("NOT_FOUND", null);
    }
    process.stderr.write(
      `Error: gh REST failed fetching issue #${issueNumber}: ${result.stderr.trim()}\n`,
    );
    return null;
  }

  try {
    return issueStateFromRestPayload(JSON.parse(result.stdout) as Record<string, unknown>);
  } catch {
    return null;
  }
}

export function fetchIssueStates(
  repo: string,
  issueNumbers: ReadonlySet<number>,
  options: FetchIssueStatesOptions = {},
): Map<number, IssueState> | null {
  if (issueNumbers.size === 0) {
    return new Map();
  }
  const parsed = splitRepoSlug(repo);
  if (parsed === null) {
    process.stderr.write(
      `Error: invalid repo slug ${JSON.stringify(repo)}; expected OWNER/REPO.\n`,
    );
    return null;
  }
  const [owner, name] = parsed;
  const sortedNumbers = [...issueNumbers].sort((a, b) => a - b);
  const states = new Map<number, IssueState>();
  const scmCall = options.scmCall ?? call;

  for (const n of sortedNumbers) {
    const fetched = fetchOneIssueStateRest(owner, name, n, scmCall, options.cwd ?? undefined);
    if (fetched === "CLI_MISSING") {
      process.stderr.write("Error: gh CLI not found. Install GitHub CLI.\n");
      return null;
    }
    if (fetched === null) {
      return null;
    }
    states.set(n, fetched);
  }
  return states;
}

export interface CompletedStatusDriftEntry {
  readonly rel_path: string;
  readonly status: string;
}

export interface ReconcileReport {
  linked: Record<string, unknown>[];
  no_open_issue: Record<string, unknown>[];
  unlinked?: Record<string, unknown>[];
  completed_status_drift?: CompletedStatusDriftEntry[];
  summary: Record<string, number>;
}

export function reconcile(
  issueToVbriefs: Map<number, string[]>,
  issueStateMap: Map<number, IssueState | string>,
): ReconcileReport {
  const linked: Record<string, unknown>[] = [];
  const noOpenIssue: Record<string, unknown>[] = [];

  for (const num of [...issueToVbriefs.keys()].sort((a, b) => a - b)) {
    const raw = issueStateMap.get(num);
    const state = raw instanceof IssueState ? raw.value : String(raw ?? "NOT_FOUND");
    const vbriefFiles = issueToVbriefs.get(num) ?? [];
    if (state === "OPEN") {
      linked.push({ issue_number: num, vbrief_files: vbriefFiles });
    } else {
      const note = state === "CLOSED" ? "Issue is closed" : "Issue is closed or does not exist";
      noOpenIssue.push({
        issue_number: num,
        vbrief_files: vbriefFiles,
        note,
        state,
        state_reason: stateReasonOf(raw),
      });
    }
  }

  return {
    linked,
    no_open_issue: noOpenIssue,
    summary: {
      linked_count: linked.length,
      vbriefs_no_open_issue_count: noOpenIssue.length,
    },
  };
}

export function reconcileWithUnlinked(
  issueToVbriefs: Map<number, string[]>,
  openIssues: Record<string, unknown>[],
): ReconcileReport {
  const openIssueNumbers = new Set(
    openIssues.map((i) => Number(i.number)).filter((n) => !Number.isNaN(n)),
  );

  const linked: Record<string, unknown>[] = [];
  const unlinked: Record<string, unknown>[] = [];
  const noOpenIssue: Record<string, unknown>[] = [];

  for (const issue of [...openIssues].sort((a, b) => Number(a.number) - Number(b.number))) {
    const num = Number(issue.number);
    if (issueToVbriefs.has(num)) {
      linked.push({
        issue_number: num,
        title: issue.title ?? "",
        url: issue.url ?? "",
        vbrief_files: issueToVbriefs.get(num),
      });
    } else {
      unlinked.push({
        issue_number: num,
        title: issue.title ?? "",
        url: issue.url ?? "",
      });
    }
  }

  for (const [num, vbriefFiles] of [...issueToVbriefs.entries()].sort((a, b) => a[0] - b[0])) {
    if (!openIssueNumbers.has(num)) {
      noOpenIssue.push({
        issue_number: num,
        vbrief_files: vbriefFiles,
        note: "Issue is closed or does not exist",
      });
    }
  }

  return {
    linked,
    unlinked,
    no_open_issue: noOpenIssue,
    summary: {
      total_open_issues: openIssues.length,
      linked_count: linked.length,
      unlinked_count: unlinked.length,
      vbriefs_no_open_issue_count: noOpenIssue.length,
    },
  };
}

function parseIssueRefString(raw: unknown): number | null {
  if (typeof raw !== "string") {
    return null;
  }
  const candidate = raw.trim();
  const idMatch = ISSUE_ID_PATTERN.exec(candidate);
  if (idMatch?.[1]) {
    return Number.parseInt(idMatch[1], 10);
  }
  const urlMatch = ISSUE_URL_PATTERN.exec(candidate);
  if (urlMatch?.[3]) {
    return Number.parseInt(urlMatch[3], 10);
  }
  return null;
}

function xTracking(data: Record<string, unknown>): Record<string, unknown> {
  for (const container of [data.plan, data] as unknown[]) {
    if (container === null || typeof container !== "object" || Array.isArray(container)) {
      continue;
    }
    const meta = (container as Record<string, unknown>).metadata;
    if (meta !== null && typeof meta === "object" && !Array.isArray(meta)) {
      const xt = (meta as Record<string, unknown>)["x-tracking"];
      if (xt !== null && typeof xt === "object" && !Array.isArray(xt)) {
        return xt as Record<string, unknown>;
      }
    }
  }
  return {};
}

export function parsePlanRef(data: Record<string, unknown>): number | null {
  const plan = data.plan;
  if (plan === null || typeof plan !== "object" || Array.isArray(plan)) {
    return null;
  }
  return parseIssueRefString((plan as Record<string, unknown>).planRef);
}

export function parseParentIssue(data: Record<string, unknown>): number | null {
  return parseIssueRefString(xTracking(data).parent_issue);
}

export function parseDecompositionOrigin(data: Record<string, unknown>): number | null {
  return parseIssueRefString(xTracking(data).decomposition_origin);
}

export function resolveLifecycleAnchor(data: Record<string, unknown>): [number | null, string] {
  let num = parsePlanRef(data);
  if (num !== null) {
    return [num, "planRef"];
  }
  num = parseParentIssue(data);
  if (num !== null) {
    return [num, "parent_issue"];
  }
  const decompositionOrigin = parseDecompositionOrigin(data);
  for (const ref of extractReferencesFromVbrief(data)) {
    if (!GITHUB_ISSUE_REF_TYPES.has(String(ref.type ?? ""))) {
      continue;
    }
    num = parseIssueNumber(ref);
    if (num === null) {
      continue;
    }
    if (decompositionOrigin !== null && num === decompositionOrigin) {
      continue;
    }
    return [num, "references"];
  }
  return [null, "none"];
}

export function scanLifecycleAnchors(vbriefDir: string): Record<string, unknown>[] {
  const anchors: Record<string, unknown>[] = [];
  for (const folder of LIFECYCLE_FOLDERS) {
    const folderPath = join(vbriefDir, folder);
    try {
      if (!statSync(folderPath).isDirectory()) {
        continue;
      }
    } catch {
      continue;
    }
    const files = readdirSync(folderPath)
      .filter((f) => hasArtifactSuffix(f))
      .sort();
    for (const filename of files) {
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(readFileSync(join(folderPath, filename), "utf8")) as Record<
          string,
          unknown
        >;
      } catch {
        continue;
      }
      const [num, axis] = resolveLifecycleAnchor(data);
      anchors.push({
        rel_path: `${folder}/${filename}`,
        issue_number: num,
        axis,
      });
    }
  }
  return anchors;
}

const COMPLETED_TERMINAL_STATUSES =
  FOLDER_ALLOWED_STATUSES.completed ?? new Set(["completed", "failed"]);

/** Scan completed/ for xBRIEFs whose plan.status is not terminal (D2 drift, #2578). */
export function scanCompletedStatusDrift(vbriefDir: string): CompletedStatusDriftEntry[] {
  const completedDir = join(vbriefDir, "completed");
  const drift: CompletedStatusDriftEntry[] = [];
  try {
    if (!statSync(completedDir).isDirectory()) {
      return drift;
    }
  } catch {
    return drift;
  }

  for (const filename of readdirSync(completedDir)
    .filter((f) => hasArtifactSuffix(f))
    .sort()) {
    const relPath = `completed/${filename}`;
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(readFileSync(join(completedDir, filename), "utf8")) as Record<
        string,
        unknown
      >;
    } catch {
      continue;
    }
    const plan = data.plan;
    if (typeof plan !== "object" || plan === null || Array.isArray(plan)) {
      continue;
    }
    const status = String((plan as Record<string, unknown>).status ?? "");
    if (status.length === 0 || COMPLETED_TERMINAL_STATUSES.has(status)) {
      continue;
    }
    drift.push({ rel_path: relPath, status });
  }
  return drift;
}

export function attachCompletedStatusDrift(
  report: ReconcileReport,
  drift: CompletedStatusDriftEntry[],
): ReconcileReport {
  return {
    ...report,
    completed_status_drift: drift,
    summary: {
      ...report.summary,
      completed_status_drift_count: drift.length,
    },
  };
}

export function buildLifecycleReport(
  anchors: Record<string, unknown>[],
  issueStateMap: Map<number, IssueState | string>,
  log = true,
): ReconcileReport {
  const linked: Record<string, unknown>[] = [];
  const noOpenIssue: Record<string, unknown>[] = [];

  for (const anchor of anchors) {
    const rel = String(anchor.rel_path ?? "");
    const num = anchor.issue_number as number | null;
    const axis = String(anchor.axis ?? "");
    if (num === null) {
      if (log) {
        process.stderr.write(
          `[lifecycle-resolve] vbrief=${rel} axis=none anchor=none state=n/a stateReason=n/a\n`,
        );
      }
      continue;
    }
    const value = issueStateMap.get(num);
    const state = value !== undefined ? String(value) : "NOT_FOUND";
    const reason = stateReasonOf(value);
    if (log) {
      process.stderr.write(
        `[lifecycle-resolve] vbrief=${rel} axis=${axis} anchor=#${num} state=${state} stateReason=${reason}\n`,
      );
    }
    if (state === "OPEN") {
      linked.push({ issue_number: num, vbrief_files: [rel] });
    } else {
      const note = state === "CLOSED" ? "Issue is closed" : "Issue is closed or does not exist";
      noOpenIssue.push({
        issue_number: num,
        vbrief_files: [rel],
        note,
        state,
        state_reason: reason,
      });
    }
  }

  return {
    linked,
    no_open_issue: noOpenIssue,
    summary: {
      linked_count: linked.length,
      vbriefs_no_open_issue_count: noOpenIssue.length,
    },
  };
}

export function formatJson(report: ReconcileReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

export function formatMarkdown(report: ReconcileReport): string {
  const lines: string[] = [];
  const summary = report.summary;
  const hasUnlinked = report.unlinked !== undefined;

  lines.push("# Issue Reconciliation Report", "");
  if (hasUnlinked && summary.total_open_issues !== undefined) {
    lines.push(`- **Open issues**: ${summary.total_open_issues}`);
  }
  lines.push(`- **Linked** (vBRIEF provenance): ${summary.linked_count}`);
  if (hasUnlinked && summary.unlinked_count !== undefined) {
    lines.push(`- **Unlinked** (no vBRIEF): ${summary.unlinked_count}`);
  }
  lines.push(
    `- **vBRIEFs without open issue**: ${summary.vbriefs_no_open_issue_count}`,
    "",
    "## (a) Open issues with matching vBRIEF provenance",
    "",
  );

  if (report.linked.length > 0) {
    for (const entry of report.linked) {
      const files = ((entry.vbrief_files as string[]) ?? []).map((f) => `\`${f}\``).join(", ");
      const title = entry.title !== undefined ? ` ${entry.title}` : "";
      lines.push(`- #${entry.issue_number}${title} -- ${files}`);
    }
  } else {
    lines.push("None.");
  }
  lines.push("");

  if (hasUnlinked && report.unlinked !== undefined) {
    lines.push("## (b) Open issues with NO matching vBRIEF (unlinked)", "");
    if (report.unlinked.length > 0) {
      for (const entry of report.unlinked) {
        lines.push(`- #${entry.issue_number} ${entry.title ?? ""}`);
      }
    } else {
      lines.push("None.");
    }
    lines.push("");
  }

  lines.push("## (c) vBRIEFs with NO matching open issue (potentially resolved)", "");
  if (report.no_open_issue.length > 0) {
    for (const entry of report.no_open_issue) {
      const files = ((entry.vbrief_files as string[]) ?? []).map((f) => `\`${f}\``).join(", ");
      lines.push(`- #${entry.issue_number} -- ${files} (${entry.note})`);
    }
  } else {
    lines.push("None.");
  }
  lines.push("");

  lines.push("## (d) completed/ xBRIEFs with non-terminal plan.status (D2 drift)", "");
  const drift = report.completed_status_drift ?? [];
  if (drift.length > 0) {
    for (const entry of drift) {
      const safeStatus = entry.status.replace(/\r?\n/g, " ");
      lines.push(`- \`${entry.rel_path}\` -- plan.status='${safeStatus}'`);
    }
  } else {
    lines.push("None.");
  }
  lines.push("");
  return lines.join("\n");
}

function utcNowIso(): string {
  return `${new Date().toISOString().replace(/\.\d{3}Z$/, "Z")}`;
}

function propagateItemStatus(items: unknown, itemStatus: string, stamp: string): number {
  if (!Array.isArray(items)) {
    return 0;
  }
  let touched = 0;
  for (const item of items) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      continue;
    }
    const obj = item as Record<string, unknown>;
    obj.status = itemStatus;
    obj.completed = stamp;
    touched += 1;
    touched += propagateItemStatus(obj.subItems, itemStatus, stamp);
    touched += propagateItemStatus(obj.items, itemStatus, stamp);
  }
  return touched;
}

function destinationFolder(stateReason: string | null | undefined): string {
  if (
    stateReason !== null &&
    stateReason !== undefined &&
    CANCELLED_STATE_REASONS.has(stateReason)
  ) {
    return "cancelled";
  }
  return "completed";
}

function gitMv(src: string, dst: string, cwd: string | null): boolean {
  try {
    execFileSync("git", ["mv", src, dst], {
      cwd: cwd ?? undefined,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
    });
    return true;
  } catch {
    try {
      renameSync(src, dst);
      return true;
    } catch {
      return false;
    }
  }
}

export function applyLifecycleFixes(
  vbriefDir: string,
  report: ReconcileReport,
  projectRoot: string | null = null,
): [number, number, string[]] {
  let moved = 0;
  let skipped = 0;
  const failures: string[] = [];
  const cwd = projectRoot ?? resolve(vbriefDir, "..");

  const relReasons = new Map<string, string | null | undefined>();
  for (const entry of report.no_open_issue) {
    const reason = entry.state_reason as string | null | undefined;
    for (const relPath of (entry.vbrief_files as string[]) ?? []) {
      if (!relReasons.has(relPath)) {
        relReasons.set(relPath, reason);
      }
    }
  }

  for (const [relPath, stateReason] of relReasons) {
    const slash = relPath.indexOf("/");
    if (slash < 0) {
      failures.push(`unexpected vBRIEF path shape (no folder): ${JSON.stringify(relPath)}`);
      continue;
    }
    if (isTerminalLifecyclePath(relPath)) {
      skipped += 1;
      continue;
    }
    const folder = relPath.slice(0, slash);
    const filename = relPath.slice(slash + 1);
    const destFolder = destinationFolder(stateReason);
    const src = join(vbriefDir, folder, filename);
    const dst = join(vbriefDir, destFolder, filename);

    try {
      statSync(src);
    } catch {
      failures.push(`vBRIEF file missing: ${relPath}`);
      continue;
    }

    try {
      assertWriteTargetSafe(cwd, src);
      assertProjectionContained(cwd, join(vbriefDir, destFolder));
    } catch (err) {
      if (err instanceof ProjectionContainmentError) {
        failures.push(`${relPath}: ${err.message}`);
        continue;
      }
      throw err;
    }

    let data: Record<string, unknown>;
    try {
      data = JSON.parse(readFileSync(src, "utf8")) as Record<string, unknown>;
    } catch (exc) {
      failures.push(`failed to parse ${relPath}: ${String(exc)}`);
      continue;
    }

    mkdirSync(join(vbriefDir, destFolder), { recursive: true });
    try {
      statSync(dst);
      // Destination already holds this basename (#2622). Treat as already-terminal
      // and continue the sweep. Do not unlink the source — a same-basename collision
      // can be a non-identical artifact; leave removal to the operator / git.
      process.stderr.write(
        `reconcile: skipped ${relPath} — already present in ${destFolder}/ (#2622); ` +
          "left source in place for manual cleanup\n",
      );
      skipped += 1;
      continue;
    } catch {
      // destination free
    }

    const plan = (data.plan ?? {}) as Record<string, unknown>;
    data.plan = plan;
    const terminalStatus = destFolder === "cancelled" ? "cancelled" : "completed";
    plan.status = terminalStatus;
    const stamp = utcNowIso();
    // Stamp `updated` into whichever info envelope the file already uses (#2346).
    // A file carrying neither envelope is already invalid; creating one here hid
    // that cause behind a manufactured version-less `vBRIEFInfo` (#3933), so the
    // sweep now refuses it by name and leaves the artifact in place.
    if (stampExistingEnvelopes(data, stamp).length === 0) {
      failures.push(missingEnvelopeMessage(relPath));
      continue;
    }
    plan.updated = stamp;
    propagateItemStatus(plan.items, terminalStatus, stamp);

    try {
      writeFileSync(src, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    } catch (exc) {
      failures.push(`failed to write ${relPath}: ${String(exc)}`);
      continue;
    }

    if (!gitMv(src, dst, cwd)) {
      failures.push(`failed to move ${relPath} -> ${destFolder}/`);
      continue;
    }
    updateDecomposedChildBackReferences(data, src, dst, vbriefDir);
    moved += 1;
  }

  return [moved, skipped, failures];
}

/** Repair completed/ files whose plan.status is not terminal (#2578). */
export function repairCompletedStatusDrift(
  vbriefDir: string,
  drift: readonly CompletedStatusDriftEntry[],
  projectRoot: string | null = null,
): [number, number, string[]] {
  let repaired = 0;
  let skipped = 0;
  const failures: string[] = [];
  const completedDir = join(vbriefDir, "completed");
  const cwd = projectRoot ?? resolve(vbriefDir, "..");

  for (const entry of drift) {
    const slash = entry.rel_path.indexOf("/");
    if (slash < 0) {
      failures.push(`unexpected vBRIEF path shape (no folder): ${JSON.stringify(entry.rel_path)}`);
      continue;
    }
    const filename = entry.rel_path.slice(slash + 1);
    const src = join(completedDir, filename);

    try {
      assertWriteTargetSafe(cwd, src);
    } catch (err) {
      if (err instanceof ProjectionContainmentError) {
        failures.push(`${entry.rel_path}: ${err.message}`);
        continue;
      }
      throw err;
    }

    let data: Record<string, unknown>;
    try {
      data = JSON.parse(readFileSync(src, "utf8")) as Record<string, unknown>;
    } catch (exc) {
      failures.push(`failed to parse ${entry.rel_path}: ${String(exc)}`);
      continue;
    }

    const plan = (data.plan ?? {}) as Record<string, unknown>;
    data.plan = plan;
    const currentStatus = String(plan.status ?? "");
    if (COMPLETED_TERMINAL_STATUSES.has(currentStatus)) {
      skipped += 1;
      continue;
    }

    const stamp = utcNowIso();
    // Same envelope policy as the closed-issue sweep above (#3933).
    if (stampExistingEnvelopes(data, stamp).length === 0) {
      failures.push(missingEnvelopeMessage(entry.rel_path));
      continue;
    }
    plan.status = "completed";
    plan.updated = stamp;
    propagateItemStatus(plan.items, "completed", stamp);

    try {
      writeFileSync(src, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    } catch (exc) {
      failures.push(`failed to write ${entry.rel_path}: ${String(exc)}`);
      continue;
    }
    repaired += 1;
  }

  return [repaired, skipped, failures];
}

export function detectRepo(): string | null {
  try {
    const stdout = execFileSync("git", ["remote", "get-url", "origin"], {
      encoding: "utf8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const m = stdout.trim().match(/github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?(?:\s|$)/);
    if (m?.[1] && m?.[2]) {
      return `${m[1]}/${m[2]}`;
    }
  } catch {
    return null;
  }
  return null;
}

export interface ReconcileCliArgs {
  vbriefDir?: string;
  repo?: string | null;
  projectRoot?: string | null;
  format?: "json" | "markdown";
  applyLifecycleFixes?: boolean;
  reportUnlinked?: boolean;
  maxOpenIssues?: number;
}

export function reconcileMain(args: ReconcileCliArgs): number {
  const vbriefDir = args.vbriefDir
    ? resolve(args.vbriefDir)
    : resolveLifecycleRoot(args.projectRoot ? resolve(args.projectRoot) : resolve("."));
  try {
    if (!statSync(vbriefDir).isDirectory()) {
      process.stderr.write(`Error: vbrief directory not found: ${vbriefDir}\n`);
      return 1;
    }
  } catch {
    process.stderr.write(`Error: vbrief directory not found: ${vbriefDir}\n`);
    return 1;
  }

  const projectRoot = resolveProjectRoot(args.projectRoot ?? undefined);
  let repo = resolveProjectRepo(args.repo ?? undefined, projectRoot);
  if (repo === null) {
    repo = detectRepo();
  }
  if (repo === null) {
    process.stderr.write(
      "Error: could not detect repo. Pass --repo OWNER/NAME, set $DEFT_PROJECT_REPO, or run from a directory tree whose git remote origin is the consumer repo (#538).\n",
    );
    return 2;
  }

  const issueMap = scanVbriefDir(vbriefDir);
  const issueToVbriefsObj = issueMap;

  let anchors: Record<string, unknown>[] = [];
  const needed = new Set(issueMap.keys());
  if (args.applyLifecycleFixes) {
    anchors = scanLifecycleAnchors(vbriefDir);
    for (const a of anchors) {
      const n = a.issue_number as number | null;
      if (n !== null) {
        needed.add(n);
      }
    }
  }

  let issueStateMap: Map<number, IssueState> | null = null;
  let report: ReconcileReport;

  if (args.reportUnlinked) {
    const openIssues = fetchAllOpenIssues(repo, { cwd: projectRoot });
    if (openIssues === null) {
      return 1;
    }
    const maxOpen = args.maxOpenIssues ?? DEFAULT_MAX_OPEN_ISSUES;
    if (openIssues.length > maxOpen) {
      process.stderr.write(
        `Error: ${openIssues.length} open issues exceeds --max-open-issues=${maxOpen}; raise the cap or drop --report-unlinked\n`,
      );
      return 1;
    }
    report = reconcileWithUnlinked(issueToVbriefsObj, openIssues);
    if (args.applyLifecycleFixes) {
      issueStateMap = fetchIssueStates(repo, needed, { cwd: projectRoot });
      if (issueStateMap === null) {
        return 1;
      }
    }
  } else {
    issueStateMap = fetchIssueStates(repo, needed, { cwd: projectRoot });
    if (issueStateMap === null) {
      return 1;
    }
    report = reconcile(issueToVbriefsObj, issueStateMap);
  }

  const fmt = args.format ?? "markdown";
  const completedDrift = scanCompletedStatusDrift(vbriefDir);
  report = attachCompletedStatusDrift(report, completedDrift);
  if (fmt === "json") {
    process.stdout.write(formatJson(report));
  } else {
    process.stdout.write(formatMarkdown(report));
  }

  if (args.applyLifecycleFixes) {
    const applyReport = buildLifecycleReport(anchors, issueStateMap ?? new Map());
    const candidates = applyReport.no_open_issue.reduce((acc, entry) => {
      for (const rel of (entry.vbrief_files as string[]) ?? []) {
        if (!isTerminalLifecyclePath(rel)) {
          return acc + 1;
        }
      }
      return acc;
    }, 0);
    const [moved, skipped, failures] = applyLifecycleFixes(vbriefDir, applyReport, projectRoot);
    const driftAfterMove = scanCompletedStatusDrift(vbriefDir);
    const [driftRepaired, driftSkipped, driftFailures] = repairCompletedStatusDrift(
      vbriefDir,
      driftAfterMove,
      projectRoot,
    );
    const allFailures = [...failures, ...driftFailures];
    process.stderr.write(
      `[${moved}/${candidates}] vBRIEFs reconciled (moved=${moved}, already-terminal=${skipped}, failures=${failures.length})\n`,
    );
    process.stderr.write(
      `[${driftRepaired}/${completedDrift.length}] completed/ status drift repaired (repaired=${driftRepaired}, already-terminal=${driftSkipped}, failures=${driftFailures.length})\n`,
    );
    for (const f of allFailures) {
      process.stderr.write(`  -- FAIL: ${f}\n`);
    }
    if (allFailures.length > 0) {
      return 1;
    }
  }

  return 0;
}
