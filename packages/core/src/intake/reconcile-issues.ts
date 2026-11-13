import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";
import {
  assertProjectionContained,
  assertWriteTargetSafe,
  ProjectionContainmentError,
} from "../fs/projection-containment.js";
import { hasArtifactSuffix, resolveLifecycleRoot } from "../layout/resolve.js";
import { missingEnvelopeMessage, stampExistingEnvelopes } from "../lifecycle/brief-envelope.js";
import { type CallOptions, type CompletedProcess, call } from "../scm/call.js";
import {
  GhRestError,
  InvalidRepoError,
  type RunGhApiFn,
  restIssueListOpenInventory,
} from "../scm/gh-rest.js";
import {
  resolveDecomposedChildTargets,
  updateDecomposedChildBackReferences,
} from "../scope/decomposed-refs.js";
import { hasCompleteTransitionWrite } from "../scope/lifecycle-write.js";
import { resolveProjectRoot } from "../scope/project-context.js";
import { resolveProjectRepo } from "../slice/project-context.js";
import { parseGithubIssueUri } from "../triage/reconcile/parse-uri.js";
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

/** Repository-qualified GitHub issue origin (#4119). */
export interface IssueOrigin {
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
}

/** Stable origin key `owner/repo#number` (lowercased owner/repo). */
export function issueOriginKey(origin: IssueOrigin): string {
  return `${origin.owner.toLowerCase()}/${origin.repo.toLowerCase()}#${origin.number}`;
}

/**
 * Parse owner/repo/number from a github-issue reference.
 * Accepts github.com and api.github.com URIs. Number-only `#N` is not origin-complete.
 */
export function parseIssueOrigin(ref: Record<string, unknown>): IssueOrigin | null {
  for (const key of ["uri", "url"] as const) {
    const value = ref[key];
    if (typeof value !== "string" || value.length === 0) {
      continue;
    }
    const [repo, number] = parseGithubIssueUri(value);
    if (repo === null || number === null) {
      continue;
    }
    const slash = repo.indexOf("/");
    if (slash <= 0 || slash === repo.length - 1) {
      continue;
    }
    return {
      owner: repo.slice(0, slash),
      repo: repo.slice(slash + 1),
      number,
    };
  }
  return null;
}

export function parseIssueNumber(ref: Record<string, unknown>): number | null {
  const origin = parseIssueOrigin(ref);
  if (origin !== null) {
    return origin.number;
  }
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

export interface FetchIssueStatesForApplyOptions extends FetchIssueStatesOptions {
  /**
   * Extra issue numbers that the printed reconcile report still walks.
   * Inventory OPEN overlay covers them; already-terminal numbers are not live-GET.
   */
  readonly reportIssueNumbers?: Iterable<number>;
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

/** IssueState value for an issue the forge reports as deleted (REST 410, #5912). */
export const DELETED_ISSUE_STATE = "DELETED";

/**
 * REST 410 Gone = deleted issue (#5912). Prefer the JSON error body `gh api`
 * prints on stdout (`"status": "410"`); fall back to the stderr text.
 */
export function isRestDeletedResult(result: CompletedProcess): boolean {
  try {
    const body = JSON.parse(result.stdout) as unknown;
    if (body !== null && typeof body === "object" && !Array.isArray(body)) {
      const status = (body as Record<string, unknown>).status;
      if (status === "410" || status === 410) {
        return true;
      }
    }
  } catch {
    // not JSON; use the stderr fallback
  }
  const stderr = result.stderr;
  return stderr.includes("HTTP 410") || stderr.includes("This issue was deleted");
}

/** Whether a fetched issue state is DELETED (#5912). */
export function isDeletedIssueState(value: unknown): boolean {
  const state = value instanceof IssueState ? value.value : value;
  return state === DELETED_ISSUE_STATE;
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
    if (isRestDeletedResult(result)) {
      return new IssueState(DELETED_ISSUE_STATE, null);
    }
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

function scmCallToRunGhApi(scmCall: ScmCallFn, cwd?: string): RunGhApiFn {
  return (args, options) => {
    const result = scmCall("github-issue", "api", args, {
      timeout: options?.timeout ?? 120,
      cwd,
    });
    return {
      returncode: result.returncode,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  };
}

/** Unique issue numbers from non-terminal lifecycle anchors (#4269). */
export function collectNonTerminalApplyIssueNumbers(
  anchors: readonly Record<string, unknown>[],
): Set<number> {
  const numbers = new Set<number>();
  for (const anchor of anchors) {
    const rel = String(anchor.rel_path ?? "");
    if (isTerminalLifecyclePath(rel)) {
      continue;
    }
    const n = anchor.issue_number;
    if (typeof n === "number" && Number.isInteger(n)) {
      numbers.add(n);
    }
  }
  return numbers;
}

/** Unique anchored plus report numbers, including already-terminal paths (#4269). */
export function collectApplyReportIssueNumbers(
  anchors: readonly Record<string, unknown>[],
  extra?: Iterable<number>,
): Set<number> {
  const numbers = new Set<number>();
  if (extra !== undefined) {
    for (const n of extra) {
      if (typeof n === "number" && Number.isInteger(n)) {
        numbers.add(n);
      }
    }
  }
  for (const anchor of anchors) {
    const n = anchor.issue_number;
    if (typeof n === "number" && Number.isInteger(n)) {
      numbers.add(n);
    }
  }
  return numbers;
}

/**
 * Apply-lifecycle-fixes fetch: open-issue inventory for OPEN status,
 * live REST only for remaining non-open non-terminal movers (#4269).
 * Inventory OPEN overlay also covers already-terminal report numbers so the
 * printed reconcile report does not treat a still-open issue as missing.
 */
export function fetchIssueStatesForApply(
  repo: string,
  anchors: readonly Record<string, unknown>[],
  options: FetchIssueStatesForApplyOptions = {},
): Map<number, IssueState> | null {
  const movers = collectNonTerminalApplyIssueNumbers(anchors);
  const reportNumbers = collectApplyReportIssueNumbers(anchors, options.reportIssueNumbers);
  if (movers.size === 0 && reportNumbers.size === 0) {
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
  const scmCall = options.scmCall ?? call;
  const cwd = options.cwd ?? undefined;

  let inventory: Record<string, unknown>[];
  try {
    inventory = restIssueListOpenInventory(repo, {
      runGhApiFn: scmCallToRunGhApi(scmCall, cwd),
    });
  } catch (err) {
    if (err instanceof GhRestError || err instanceof InvalidRepoError) {
      process.stderr.write(`Error: ${err.message}\n`);
      return null;
    }
    process.stderr.write("Error: gh CLI not found. Install GitHub CLI.\n");
    return null;
  }

  const openNumbers = new Set<number>();
  for (const row of inventory) {
    const n = row.number;
    if (typeof n === "number" && Number.isInteger(n)) {
      openNumbers.add(n);
    }
  }

  const states = new Map<number, IssueState>();
  for (const n of [...reportNumbers].sort((a, b) => a - b)) {
    if (openNumbers.has(n)) {
      states.set(n, new IssueState("OPEN"));
    }
  }

  const remaining: number[] = [];
  for (const n of [...movers].sort((a, b) => a - b)) {
    if (!openNumbers.has(n)) {
      remaining.push(n);
    }
  }

  const total = remaining.length;
  for (let i = 0; i < remaining.length; i += 1) {
    const n = remaining[i] as number;
    process.stderr.write(
      `[${i + 1}/${total}] apply-lifecycle-fixes fetching state_reason for #${n}\n`,
    );
    const fetched = fetchOneIssueStateRest(owner, name, n, scmCall, cwd);
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

/** Leftover named for briefs anchored to a deleted issue (#5912 / #5126). */
export const DELETED_ISSUE_LEFTOVER_NOTE =
  "scope:cancel cannot resolve a deleted origin (#5126 leftover); brief left in place";

/**
 * Report note for a no-open-issue entry. Deleted (410) and missing (404) are
 * named separately (#5912); a state absent from the map keeps the legacy note.
 */
export function noOpenIssueNote(state: string, raw: unknown): string {
  if (state === "CLOSED") {
    return "Issue is closed";
  }
  if (state === DELETED_ISSUE_STATE) {
    return `Issue was deleted (HTTP 410); ${DELETED_ISSUE_LEFTOVER_NOTE}`;
  }
  if (state === "NOT_FOUND" && raw instanceof IssueState) {
    return "Issue does not exist (HTTP 404)";
  }
  return "Issue is closed or does not exist";
}

function countDeletedEntries(entries: readonly Record<string, unknown>[]): number {
  return entries.filter((e) => e.state === DELETED_ISSUE_STATE).length;
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
      const note = noOpenIssueNote(state, raw);
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
      deleted_issue_count: countDeletedEntries(noOpenIssue),
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
      noOpenIssue.push({
        issue_number: num,
        vbrief_files: [rel],
        note: noOpenIssueNote(state, value),
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
      deleted_issue_count: countDeletedEntries(noOpenIssue),
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
  lines.push(`- **vBRIEFs without open issue**: ${summary.vbriefs_no_open_issue_count}`);
  if (summary.deleted_issue_count !== undefined) {
    lines.push(`- **Deleted issues (HTTP 410)**: ${summary.deleted_issue_count}`);
  }
  lines.push("", "## (a) Open issues with matching vBRIEF provenance", "");

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

export function destinationFolder(stateReason: string | null | undefined): string {
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

/** Live single-issue GET used by the pre-write child probe (#5912). */
export type IssueStateProbeFn = (issueNumber: number) => IssueState | null | "CLI_MISSING";

export interface ApplyLifecycleFixesOptions {
  /** Apply mover map (from `fetchIssueStatesForApply`); report states are folded in. */
  readonly issueStates?: ReadonlyMap<number, IssueState | string> | null;
  /** Live GET for probed child issues absent from the mover map. */
  readonly probeIssueState?: IssueStateProbeFn | null;
}

/** Every GitHub issue number a brief carries: lifecycle anchor plus issue refs. */
function briefIssueNumbers(data: Record<string, unknown>): number[] {
  const numbers = new Set<number>();
  const [anchor] = resolveLifecycleAnchor(data);
  if (anchor !== null) {
    numbers.add(anchor);
  }
  for (const ref of extractReferencesFromVbrief(data)) {
    if (!GITHUB_ISSUE_REF_TYPES.has(String(ref.type ?? ""))) {
      continue;
    }
    const n = parseIssueNumber(ref);
    if (n !== null) {
      numbers.add(n);
    }
  }
  return [...numbers].sort((a, b) => a - b);
}

function knownStatesFromReport(
  report: ReconcileReport,
  extra: ReadonlyMap<number, IssueState | string> | null | undefined,
): Map<number, IssueState | string> {
  const known = new Map<number, IssueState | string>();
  for (const entry of report.linked) {
    const n = entry.issue_number;
    if (typeof n === "number") {
      known.set(n, new IssueState("OPEN"));
    }
  }
  for (const entry of report.no_open_issue) {
    const n = entry.issue_number;
    // NOT_FOUND here may only mean "never fetched" (absent from the map), so it
    // is not a known state; the probe live-GETs it instead.
    if (
      typeof n === "number" &&
      (entry.state === "CLOSED" || entry.state === DELETED_ISSUE_STATE)
    ) {
      known.set(n, new IssueState(entry.state, (entry.state_reason as string | null) ?? null));
    }
  }
  if (extra) {
    for (const [n, state] of extra) {
      known.set(n, state);
    }
  }
  return known;
}

type ChildProbeVerdict =
  | { readonly kind: "ok"; readonly relatedRels: string[] }
  | { readonly kind: "deleted"; readonly message: string; readonly protectedRels: string[] }
  | { readonly kind: "unresolved"; readonly message: string; readonly protectedRels: string[] };

/**
 * Pre-write probe (#5912): resolve the children `updateDecomposedChildBackReferences`
 * would rewrite, and refuse the related move when any child issue is DELETED or
 * cannot be resolved. Issue-less children are not probe subjects.
 */
function probeDecomposedChildren(
  relPath: string,
  parentData: Record<string, unknown>,
  vbriefDir: string,
  known: Map<number, IssueState | string>,
  probe: IssueStateProbeFn | null | undefined,
): ChildProbeVerdict {
  let targets: string[];
  try {
    targets = resolveDecomposedChildTargets(parentData, vbriefDir);
  } catch (err) {
    return {
      kind: "unresolved",
      message: `${relPath}: related move refused -- child reference did not resolve (${String(err)}); left parent and children unmoved (#5912)`,
      protectedRels: [relPath],
    };
  }
  // A refused move protects the parent and every child from later writes in this run.
  const protectedRels = [
    relPath,
    ...targets.map((t) => relative(vbriefDir, t).replace(/\\/g, "/")),
  ];
  for (const childPath of targets) {
    const childRel = relative(vbriefDir, childPath).replace(/\\/g, "/");
    let childData: Record<string, unknown>;
    try {
      childData = JSON.parse(readFileSync(childPath, "utf8")) as Record<string, unknown>;
    } catch (err) {
      return {
        kind: "unresolved",
        message: `${relPath}: related move refused -- could not read child ${childRel} (${String(err)}); left parent and children unmoved (#5912)`,
        protectedRels,
      };
    }
    for (const n of briefIssueNumbers(childData)) {
      if (!known.has(n)) {
        const fetched = probe ? probe(n) : null;
        if (fetched instanceof IssueState) {
          known.set(n, fetched);
        }
      }
      const state = known.get(n);
      if (state === undefined) {
        return {
          kind: "unresolved",
          message: `${relPath}: related move refused -- child ${childRel} issue #${n} state did not resolve; left parent and children unmoved (#5912)`,
          protectedRels,
        };
      }
      if (isDeletedIssueState(state)) {
        return {
          kind: "deleted",
          message: `${relPath}: related move refused -- child ${childRel} is anchored to deleted issue #${n} (HTTP 410); left parent and children unmoved (#5912)`,
          protectedRels,
        };
      }
    }
  }
  return { kind: "ok", relatedRels: protectedRels.slice(1) };
}

/**
 * Move briefs whose anchor issue is closed into a terminal folder.
 * Returns `[moved, skipped, failures, deletedSkips, protectedRels]`.
 * `deletedSkips` lists briefs left in place because of a DELETED (HTTP 410)
 * issue (#5912); they are not failures. `protectedRels` names every brief this
 * run must not rewrite afterwards (DELETED-anchored briefs, and the parent and
 * children of a refused related move), e.g. in completed/ drift repair.
 */
export function applyLifecycleFixes(
  vbriefDir: string,
  report: ReconcileReport,
  projectRoot: string | null = null,
  options: ApplyLifecycleFixesOptions = {},
): [number, number, string[], string[], Set<string>] {
  let moved = 0;
  let skipped = 0;
  const failures: string[] = [];
  const deletedSkips: string[] = [];
  const protectedRels = new Set<string>();
  const cwd = projectRoot ?? resolve(vbriefDir, "..");
  const known = knownStatesFromReport(report, options.issueStates);

  const relReasons = new Map<string, string | null | undefined>();
  // DELETED wins over any sibling entry for the same brief, in any order (#5912).
  const relDeleted = new Map<string, number>();
  for (const entry of report.no_open_issue) {
    const reason = entry.state_reason as string | null | undefined;
    for (const relPath of (entry.vbrief_files as string[]) ?? []) {
      if (!relReasons.has(relPath)) {
        relReasons.set(relPath, reason);
      }
      if (entry.state === DELETED_ISSUE_STATE && !relDeleted.has(relPath)) {
        relDeleted.set(relPath, Number(entry.issue_number));
      }
    }
  }

  // #5912 pass 1: probe every move candidate's related children before any write,
  // so a path protected by one refused move cannot be moved later in the sweep.
  const refusals = new Map<string, ChildProbeVerdict>();
  const okRelated = new Map<string, string[]>();
  for (const [relPath, stateReason] of relReasons) {
    if (relDeleted.has(relPath)) {
      protectedRels.add(relPath);
      continue;
    }
    const slash = relPath.indexOf("/");
    if (slash < 0 || isTerminalLifecyclePath(relPath)) {
      continue;
    }
    const folder = relPath.slice(0, slash);
    const destFolder = destinationFolder(stateReason);
    if (existsSync(join(vbriefDir, destFolder, relPath.slice(slash + 1)))) {
      continue; // destination collision (#2622): the move pass skips it, so no probe
    }
    let candidate: Record<string, unknown>;
    try {
      candidate = JSON.parse(readFileSync(join(vbriefDir, relPath), "utf8")) as Record<
        string,
        unknown
      >;
    } catch {
      continue; // the move pass reports the missing / unparseable file
    }
    const candidatePlan = (candidate.plan ?? {}) as Record<string, unknown>;
    if (
      folder === "active" &&
      destFolder === "completed" &&
      !hasCompleteTransitionWrite(candidatePlan)
    ) {
      continue; // #4508 refuse in the move pass; this move cannot happen
    }
    const verdict = probeDecomposedChildren(
      relPath,
      candidate,
      vbriefDir,
      known,
      options.probeIssueState,
    );
    if (verdict.kind !== "ok") {
      refusals.set(relPath, verdict);
      for (const rel of verdict.protectedRels) protectedRels.add(rel);
    } else {
      okRelated.set(relPath, verdict.relatedRels);
    }
  }
  // A move that would rewrite a protected brief is refused too; repeat until stable.
  for (let changed = true; changed; ) {
    changed = false;
    for (const [relPath, related] of okRelated) {
      if (!protectedRels.has(relPath) && !related.some((r) => protectedRels.has(r))) {
        continue;
      }
      okRelated.delete(relPath);
      const verdict: ChildProbeVerdict = {
        kind: "deleted",
        message: `${relPath}: related move refused -- a related brief is protected by a refused move this run; left parent and children unmoved (#5912)`,
        protectedRels: [relPath, ...related],
      };
      refusals.set(relPath, verdict);
      for (const rel of verdict.protectedRels) protectedRels.add(rel);
      changed = true;
    }
  }

  for (const [relPath, stateReason] of relReasons) {
    const deletedIssue = relDeleted.get(relPath);
    if (deletedIssue !== undefined) {
      deletedSkips.push(
        `${relPath}: anchored to deleted issue #${deletedIssue} (HTTP 410); ${DELETED_ISSUE_LEFTOVER_NOTE}`,
      );
      continue;
    }
    const refusal = refusals.get(relPath);
    if (refusal !== undefined && refusal.kind !== "ok") {
      (refusal.kind === "deleted" ? deletedSkips : failures).push(refusal.message);
      continue;
    }
    if (protectedRels.has(relPath) && !isTerminalLifecyclePath(relPath)) {
      deletedSkips.push(
        `${relPath}: left in place -- child of a refused related move this run (#5912)`,
      );
      continue;
    }
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
    // #4508: GitHub-closed is not authority to mint lifecycleWrite or pre-mark items.
    // Fail stamps / failed status / cancel stamps are not complete authorization.
    if (folder === "active" && destFolder === "completed" && !hasCompleteTransitionWrite(plan)) {
      process.stderr.write(
        `reconcile: refused ${relPath} — unstamped active/ to completed/ (#4508); ` +
          "left source unmutated. leftover-land (#3476) is the land step after leftover-complete, not this refuse.\n",
      );
      failures.push(
        relPath +
          ": unstamped active/ to completed/ (#4508); left source unmutated. leftover-land (#3476) is the land step after leftover-complete, not this refuse.",
      );
      continue;
    }

    // #5912: re-resolve and re-probe the exact children the write path will
    // visit now (earlier moves may change resolution), before any write.
    const recheck = probeDecomposedChildren(
      relPath,
      data,
      vbriefDir,
      known,
      options.probeIssueState,
    );
    if (recheck.kind !== "ok") {
      for (const rel of recheck.protectedRels) protectedRels.add(rel);
      (recheck.kind === "deleted" ? deletedSkips : failures).push(recheck.message);
      continue;
    }
    if (recheck.relatedRels.some((r) => protectedRels.has(r))) {
      protectedRels.add(relPath);
      for (const rel of recheck.relatedRels) protectedRels.add(rel);
      deletedSkips.push(
        `${relPath}: related move refused -- a related brief is protected by a refused move this run; left parent and children unmoved (#5912)`,
      );
      continue;
    }

    mkdirSync(join(vbriefDir, destFolder), { recursive: true });
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

  return [moved, skipped, failures, deletedSkips, protectedRels];
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
      issueStateMap = fetchIssueStatesForApply(repo, anchors, {
        cwd: projectRoot,
        reportIssueNumbers: needed,
      });
      if (issueStateMap === null) {
        return 1;
      }
    }
  } else if (args.applyLifecycleFixes) {
    issueStateMap = fetchIssueStatesForApply(repo, anchors, {
      cwd: projectRoot,
      reportIssueNumbers: needed,
    });
    if (issueStateMap === null) {
      return 1;
    }
    report = reconcile(issueToVbriefsObj, issueStateMap);
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
    const slug = splitRepoSlug(repo);
    const probeIssueState: IssueStateProbeFn | null =
      slug === null
        ? null
        : (n) => {
            process.stderr.write(`apply-lifecycle-fixes probing child issue #${n}\n`);
            return fetchOneIssueStateRest(slug[0], slug[1], n, call, projectRoot ?? undefined);
          };
    const [moved, skipped, failures, deletedSkips, protectedRels] = applyLifecycleFixes(
      vbriefDir,
      applyReport,
      projectRoot,
      { issueStates: issueStateMap, probeIssueState },
    );
    // #5912: briefs protected by a DELETED skip or a refused related move stay byte-identical.
    const driftAfterMove = scanCompletedStatusDrift(vbriefDir).filter(
      (entry) => !protectedRels.has(entry.rel_path),
    );
    const [driftRepaired, driftSkipped, driftFailures] = repairCompletedStatusDrift(
      vbriefDir,
      driftAfterMove,
      projectRoot,
    );
    const allFailures = [...failures, ...driftFailures];
    process.stderr.write(
      `[${moved}/${candidates}] vBRIEFs reconciled (moved=${moved}, already-terminal=${skipped}, deleted-skipped=${deletedSkips.length}, failures=${failures.length})\n`,
    );
    for (const d of deletedSkips) {
      process.stderr.write(`  -- DELETED (skipped, not a failure): ${d}\n`);
    }
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
