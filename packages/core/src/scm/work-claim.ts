/**
 * List-visible same-issue busy flag (#4200).
 *
 * A GitHub label plus a `task` / `deft` verb. Not occupancy, not `kind: pass`,
 * not a PR review-owner lease, not an exclusive lock. Last-write-wins: labels
 * do not carry agent_id, so the board can lie about who. v1 does not detect
 * two-issue path overlap.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveProjectRoot } from "../scope/project-context.js";
import { liveOccupant } from "../session/occupancy.js";
import { extractIssueRef } from "../triage/reconcile/parse-uri.js";
import { ScmLabelClient } from "../vbrief-reconcile/labels.js";
import type { LabelClient } from "../vbrief-reconcile/types.js";
import { extractFlag, extractValueFlag } from "./argv.js";
import { resolveRepoFromGitOrigin } from "./design-critique-chip.js";
import { InvalidRepoError, splitRepo } from "./gh-rest.js";
import { pyRepr } from "./py-format.js";

export const WORK_CLAIM_VERB = "work-claim" as const;
export const WORK_CLAIM_LABEL = "status:claimed" as const;
export const WORK_CLAIM_ACTIONS = ["claim", "show", "release"] as const;
export type WorkClaimAction = (typeof WORK_CLAIM_ACTIONS)[number];

export const WORK_CLAIM_USAGE =
  "usage: scm issue work-claim <claim|show|release> --issue N [--repo OWNER/NAME] [--project-root PATH] [--json]\n" +
  "       Same-issue busy flag. Catalog label status:claimed. Not a lock.\n" +
  "       claim refuses read-only / no occupancy. release clears abandoned tags without occupancy.\n" +
  "       Warn is success for show. Last-write-wins: the board can lie about who.\n" +
  "       v1 does not detect two-issue path overlap.\n";

const LIFECYCLE_ROOTS = ["xbrief", "vbrief"] as const;
const LIFECYCLE_FOLDERS = ["proposed", "pending", "active"] as const;
/** Session-start MUST scan; active-only so proposed backlog does not fan out GitHub GETs. */
const SESSION_SCAN_FOLDERS = ["active"] as const;

const REFUSE_NO_OCCUPANCY =
  "work-claim refuses: no occupancy on this tree. Read-only and forge-only sessions must not claim (#4020 / #4200). Run mutation session:start first.";
const REFUSE_READ_ONLY = "work-claim refuses: read-only session must not claim (#4020 / #4200).";

export interface WorkClaimArgs {
  readonly action: WorkClaimAction;
  readonly issue: number;
  readonly repo: string | null;
  readonly projectRoot: string | null;
  readonly json: boolean;
  readonly readOnly: boolean;
}

export interface WorkClaimSeams {
  readonly client?: LabelClient;
  readonly resolveDefaultRepo?: () => string | null;
  readonly occupancyLive?: (projectRoot: string) => boolean;
  readonly cwd?: string;
}

export interface WorkClaimResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface LifecycleOriginIssue {
  readonly path: string;
  readonly repo: string | null;
  readonly issue: number;
}

class WorkClaimUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkClaimUsageError";
  }
}

function parseIssueNumber(raw: string, source: string): number {
  const issueN = Number.parseInt(raw, 10);
  if (Number.isNaN(issueN) || issueN <= 0 || String(issueN) !== raw) {
    throw new Error(`${source} must be a positive integer; got ${pyRepr(raw)}`);
  }
  return issueN;
}

function isWorkClaimAction(value: string): value is WorkClaimAction {
  return (WORK_CLAIM_ACTIONS as readonly string[]).includes(value);
}

export function parseWorkClaimArgs(extra: readonly string[]): WorkClaimArgs {
  let remainder = [...extra];
  const [help] = extractFlag(remainder, "--help");
  const [helpShort] = extractFlag(remainder, "-h");
  if (help || helpShort) {
    throw new WorkClaimUsageError(WORK_CLAIM_USAGE.trimEnd());
  }

  const [json, afterJson] = extractFlag(remainder, "--json");
  remainder = afterJson;
  const [readOnly, afterReadOnly] = extractFlag(remainder, "--read-only");
  remainder = afterReadOnly;
  const [repoRaw, afterRepo] = extractValueFlag(remainder, "--repo");
  remainder = afterRepo;
  const [issueFlag, afterIssue] = extractValueFlag(remainder, "--issue");
  remainder = afterIssue;
  const [projectRootRaw, afterRoot] = extractValueFlag(remainder, "--project-root");
  remainder = afterRoot;

  const leftoverFlags = remainder.filter((t) => t.startsWith("-"));
  if (leftoverFlags.length > 0) {
    throw new Error(
      `unrecognized flags: ${pyRepr(leftoverFlags)}. Supported: --issue, --repo, --project-root, --json, --read-only.`,
    );
  }

  const positionals = remainder.filter((t) => !t.startsWith("-"));
  const actionRaw = positionals[0];
  if (actionRaw === undefined || !isWorkClaimAction(actionRaw)) {
    throw new Error(
      `missing action claim|show|release; got ${pyRepr(actionRaw ?? "")}. ${WORK_CLAIM_USAGE.trim()}`,
    );
  }

  const extraPositionals = positionals.slice(1);
  let issueRaw = issueFlag;
  if (extraPositionals.length > 1) {
    throw new Error(
      `expected at most one positional issue number; got ${pyRepr(extraPositionals)}`,
    );
  }
  if (extraPositionals.length === 1) {
    const positional = extraPositionals[0] ?? "";
    if (issueRaw !== null && issueRaw !== positional) {
      throw new Error(
        `--issue ${pyRepr(issueRaw)} conflicts with positional ${pyRepr(positional)}`,
      );
    }
    issueRaw = positional;
  }
  if (issueRaw === null || issueRaw.length === 0) {
    throw new Error("missing --issue N");
  }
  const issue = parseIssueNumber(issueRaw, "--issue");

  if (repoRaw !== null && repoRaw.length > 0) {
    splitRepo(repoRaw);
  }

  return {
    action: actionRaw,
    issue,
    repo: repoRaw !== null && repoRaw.length > 0 ? repoRaw : null,
    projectRoot: projectRootRaw !== null && projectRootRaw.length > 0 ? projectRootRaw : null,
    json,
    readOnly,
  };
}

export function formatWorkClaimBusyWarning(repo: string, issue: number): string {
  return (
    `[deft work-claim] warning: ${repo}#${issue} carries ${WORK_CLAIM_LABEL} (busy). ` +
    "Warn is success; this is not a GitHub lock. Last-write-wins: the board can lie about who. " +
    "v1 does not detect two-issue path overlap."
  );
}

export function defaultOccupancyLive(projectRoot: string): boolean {
  return liveOccupant(projectRoot) !== null;
}

function resolveRepo(args: WorkClaimArgs, seams: WorkClaimSeams): string {
  const repo = args.repo ?? (seams.resolveDefaultRepo ?? resolveRepoFromGitOrigin)();
  if (repo === null || repo.length === 0) {
    throw new Error("missing --repo OWNER/NAME (could not resolve from git origin)");
  }
  splitRepo(repo);
  return repo;
}

function occupancyRoot(args: WorkClaimArgs, seams: WorkClaimSeams): string {
  if (args.projectRoot !== null && args.projectRoot.length > 0) {
    return args.projectRoot;
  }
  const start = seams.cwd ?? process.cwd();
  return resolveProjectRoot(null, start) ?? start;
}

function mutationAllowed(
  args: WorkClaimArgs,
  seams: WorkClaimSeams,
  kind: "claim" | "release",
): { ok: true; projectRoot: string } | { ok: false; message: string } {
  if (args.readOnly) {
    return { ok: false, message: REFUSE_READ_ONLY };
  }
  const projectRoot = occupancyRoot(args, seams);
  if (kind === "claim") {
    const occupancyLive = seams.occupancyLive ?? defaultOccupancyLive;
    if (!occupancyLive(projectRoot)) {
      return { ok: false, message: REFUSE_NO_OCCUPANCY };
    }
  }
  return { ok: true, projectRoot };
}

function resultPayload(
  args: WorkClaimArgs,
  repo: string,
  extra: Record<string, unknown>,
): Record<string, unknown> {
  return {
    action: args.action,
    repo,
    issue: args.issue,
    label: WORK_CLAIM_LABEL,
    lock: false,
    last_write_wins: true,
    path_overlap: false,
    ...extra,
  };
}

function printResult(
  args: WorkClaimArgs,
  payload: Record<string, unknown>,
  text: string,
  exitCode: number,
  stderr = "",
): WorkClaimResult {
  if (args.json) {
    return { exitCode, stdout: `${JSON.stringify(payload)}\n`, stderr };
  }
  return { exitCode, stdout: text.length > 0 ? `${text}\n` : "", stderr };
}

function runShow(args: WorkClaimArgs, repo: string, client: LabelClient): WorkClaimResult {
  const labels = client.fetchLabels(repo, args.issue);
  const claimed = labels.includes(WORK_CLAIM_LABEL);
  const payload = resultPayload(args, repo, { claimed, labels });
  if (claimed) {
    return printResult(args, payload, formatWorkClaimBusyWarning(repo, args.issue), 0);
  }
  return printResult(args, payload, `${repo}#${args.issue} is free (no ${WORK_CLAIM_LABEL})`, 0);
}

function runClaim(
  args: WorkClaimArgs,
  repo: string,
  client: LabelClient,
  seams: WorkClaimSeams,
): WorkClaimResult {
  const gate = mutationAllowed(args, seams, "claim");
  if (!gate.ok) {
    const payload = resultPayload(args, repo, {
      claimed: false,
      refused: true,
      reason: gate.message,
    });
    if (args.json) {
      return { exitCode: 1, stdout: `${JSON.stringify(payload)}\n`, stderr: `${gate.message}\n` };
    }
    return { exitCode: 1, stdout: "", stderr: `${gate.message}\n` };
  }
  const labels = client.fetchLabels(repo, args.issue);
  const already = labels.includes(WORK_CLAIM_LABEL);
  if (!already) {
    client.apply(repo, args.issue, [WORK_CLAIM_LABEL], []);
  }
  const payload = resultPayload(args, repo, {
    claimed: true,
    unchanged: already,
  });
  const text = already
    ? `unchanged ${WORK_CLAIM_LABEL} on ${repo}#${args.issue} (already claimed; last-write-wins)`
    : `claimed ${WORK_CLAIM_LABEL} on ${repo}#${args.issue}`;
  return printResult(args, payload, text, 0);
}

function runRelease(
  args: WorkClaimArgs,
  repo: string,
  client: LabelClient,
  seams: WorkClaimSeams,
): WorkClaimResult {
  const gate = mutationAllowed(args, seams, "release");
  if (!gate.ok) {
    const payload = resultPayload(args, repo, {
      claimed: true,
      refused: true,
      reason: gate.message,
    });
    if (args.json) {
      return { exitCode: 1, stdout: `${JSON.stringify(payload)}\n`, stderr: `${gate.message}\n` };
    }
    return { exitCode: 1, stdout: "", stderr: `${gate.message}\n` };
  }
  const labels = client.fetchLabels(repo, args.issue);
  const present = labels.includes(WORK_CLAIM_LABEL);
  if (present) {
    client.apply(repo, args.issue, [], [WORK_CLAIM_LABEL]);
  }
  const payload = resultPayload(args, repo, {
    claimed: false,
    unchanged: !present,
  });
  const text = present
    ? `released ${WORK_CLAIM_LABEL} on ${repo}#${args.issue}`
    : `unchanged ${repo}#${args.issue} (no ${WORK_CLAIM_LABEL})`;
  return printResult(args, payload, text, 0);
}

export function runWorkClaim(
  extra: readonly string[],
  seams: WorkClaimSeams = {},
): WorkClaimResult {
  let args: WorkClaimArgs;
  try {
    args = parseWorkClaimArgs(extra);
  } catch (err: unknown) {
    if (err instanceof WorkClaimUsageError) {
      return { exitCode: 0, stdout: `${err.message}\n`, stderr: "" };
    }
    if (err instanceof InvalidRepoError) {
      return { exitCode: 2, stdout: "", stderr: `error: invalid --repo value: ${err.message}\n` };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { exitCode: 2, stdout: "", stderr: `error: ${message}\n` };
  }

  let repo: string;
  try {
    repo = resolveRepo(args, seams);
  } catch (err: unknown) {
    if (err instanceof InvalidRepoError) {
      return { exitCode: 2, stdout: "", stderr: `error: invalid --repo value: ${err.message}\n` };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { exitCode: 2, stdout: "", stderr: `error: ${message}\n` };
  }

  const client = seams.client ?? new ScmLabelClient();
  try {
    if (args.action === "show") return runShow(args, repo, client);
    if (args.action === "claim") return runClaim(args, repo, client, seams);
    return runRelease(args, repo, client, seams);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { exitCode: 1, stdout: "", stderr: `error: ${message}\n` };
  }
}

function isBriefFile(name: string): boolean {
  return name.endsWith(".xbrief.json") || name.endsWith(".vbrief.json");
}

export function collectLifecycleOriginIssues(
  projectRoot: string,
  folders: readonly string[] = LIFECYCLE_FOLDERS,
): LifecycleOriginIssue[] {
  const found: LifecycleOriginIssue[] = [];
  const seen = new Set<string>();
  for (const rootName of LIFECYCLE_ROOTS) {
    for (const folder of folders) {
      const dir = join(projectRoot, rootName, folder);
      if (!existsSync(dir)) continue;
      let names: string[] = [];
      try {
        names = readdirSync(dir);
      } catch {
        continue;
      }
      for (const name of names) {
        if (!isBriefFile(name)) continue;
        const path = join(dir, name);
        let payload: unknown;
        try {
          payload = JSON.parse(readFileSync(path, { encoding: "utf8" }));
        } catch {
          continue;
        }
        if (payload === null || typeof payload !== "object" || Array.isArray(payload)) continue;
        const [repo, issue] = extractIssueRef(payload as Record<string, unknown>);
        if (issue === null) continue;
        const key = `${repo ?? ""}#${issue}`;
        if (seen.has(key)) continue;
        seen.add(key);
        found.push({ path, repo, issue });
      }
    }
  }
  return found;
}

export function scanLifecycleWorkClaims(projectRoot: string, seams: WorkClaimSeams = {}): string[] {
  const origins = collectLifecycleOriginIssues(projectRoot, SESSION_SCAN_FOLDERS);
  if (origins.length === 0) return [];
  const resolveRepoFn = seams.resolveDefaultRepo ?? resolveRepoFromGitOrigin;
  const client = seams.client ?? new ScmLabelClient();
  const lines: string[] = [];
  let scanned = 0;
  let claimed = 0;
  for (const origin of origins) {
    const repo = origin.repo ?? resolveRepoFn();
    if (repo === null || repo.length === 0) {
      lines.push(
        `[deft work-claim] warning: scan skipped for #${origin.issue} (missing repo / git origin). Warn is success.`,
      );
      continue;
    }
    try {
      const labels = client.fetchLabels(repo, origin.issue);
      scanned += 1;
      if (labels.includes(WORK_CLAIM_LABEL)) {
        claimed += 1;
        lines.push(formatWorkClaimBusyWarning(repo, origin.issue));
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      lines.push(
        `[deft work-claim] warning: scan failed for ${repo}#${origin.issue}: ${message}. Warn is success.`,
      );
    }
  }
  if (claimed === 0 && scanned > 0) {
    lines.push(`[deft work-claim] scanned ${scanned} issue(s); none tagged ${WORK_CLAIM_LABEL}`);
  }
  return lines;
}

export function workClaimSessionScanLines(
  projectRoot: string,
  scan?: (root: string) => readonly string[],
): string[] {
  try {
    return [...(scan ?? scanLifecycleWorkClaims)(projectRoot)];
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return [
      `[deft work-claim] warning: scan failed (${message}). Warn is success; this is not a GitHub lock.`,
    ];
  }
}

export function scanWorkClaimForBriefPath(briefPath: string, seams: WorkClaimSeams = {}): string[] {
  let payload: unknown;
  try {
    payload = JSON.parse(readFileSync(briefPath, { encoding: "utf8" }));
  } catch {
    return [];
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return [];
  const [repoRef, issue] = extractIssueRef(payload as Record<string, unknown>);
  if (issue === null) return [];
  const repo = repoRef ?? (seams.resolveDefaultRepo ?? resolveRepoFromGitOrigin)();
  if (repo === null || repo.length === 0) {
    return [
      `[deft work-claim] warning: scan skipped for #${issue} (missing repo / git origin). Warn is success.`,
    ];
  }
  const client = seams.client ?? new ScmLabelClient();
  try {
    const labels = client.fetchLabels(repo, issue);
    if (labels.includes(WORK_CLAIM_LABEL)) {
      return [formatWorkClaimBusyWarning(repo, issue)];
    }
    return [`[deft work-claim] scanned ${repo}#${issue}; not tagged ${WORK_CLAIM_LABEL}`];
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return [
      `[deft work-claim] warning: scan failed for ${repo}#${issue}: ${message}. Warn is success.`,
    ];
  }
}

export function releaseWorkClaimForBrief(
  briefPath: string,
  seams: WorkClaimSeams = {},
): { released: boolean; message: string } {
  let payload: unknown;
  try {
    payload = JSON.parse(readFileSync(briefPath, { encoding: "utf8" }));
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { released: false, message: `work-claim release skipped: ${message}` };
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return { released: false, message: "work-claim release skipped: brief is not an object" };
  }
  const [repoRef, issue] = extractIssueRef(payload as Record<string, unknown>);
  if (issue === null) {
    return { released: false, message: "work-claim release skipped: no github-issue origin" };
  }
  const repo = repoRef ?? (seams.resolveDefaultRepo ?? resolveRepoFromGitOrigin)();
  if (repo === null || repo.length === 0) {
    return { released: false, message: "work-claim release skipped: missing repo / git origin" };
  }
  const extra = [
    "release",
    "--issue",
    String(issue),
    "--repo",
    repo,
    ...(seams.cwd !== undefined ? ["--project-root", seams.cwd] : []),
  ];
  const result = runWorkClaim(extra, seams);
  return {
    released: result.exitCode === 0,
    message: (result.stdout || result.stderr).trim(),
  };
}
