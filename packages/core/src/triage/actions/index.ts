import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { call } from "../../scm/call.js";
import { ScmStubError } from "../../scm/errors.js";
import { createCandidatesLog, resolveAuditLogPath, rollbackAuditEntry } from "./candidates-log.js";
import { TriageError, UpstreamCloseError } from "./errors.js";
import { parseResumeOn } from "./resume-on.js";
import type {
  AcceptOptions,
  AuditEntry,
  DeferOptions,
  IssueIngest,
  RejectOptions,
  ScmRunner,
  TriageActionsDeps,
} from "./types.js";

export {
  AUDIT_LOG_REL_PATH,
  createCandidatesLog,
  resolveAuditLogPath,
  rollbackAuditEntry,
} from "./candidates-log.js";
export {
  CandidatesLogError,
  ResumeGrammarError,
  TriageError,
  UpstreamCloseError,
} from "./errors.js";
export { parseResumeOn } from "./resume-on.js";
export type {
  AcceptOptions,
  AuditEntry,
  CandidatesLog,
  DeferOptions,
  IssueIngest,
  RejectOptions,
  ScmRunner,
  TriageActionsDeps,
} from "./types.js";

export const REJECTED_LABEL = "triage-rejected";
export const REJECTED_LABEL_COLOR = "B60205";
export const REJECTED_LABEL_DESCRIPTION = "Issue rejected during deft triage";

const TERMINAL_DECISIONS = new Set(["accept", "reject", "mark-duplicate"]);
const DEFAULT_ACTOR = "agent:triage";

function resolveDeftRoot(): string {
  if (process.env.DEFT_ROOT !== undefined && process.env.DEFT_ROOT.length > 0) {
    return resolve(process.env.DEFT_ROOT);
  }
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "..");
}

function defaultNowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function resolveActor(actor: string | null | undefined): string {
  if (actor) return actor;
  return process.env.USER ?? process.env.USERNAME ?? DEFAULT_ACTOR;
}

function defaultScmRunner(): ScmRunner {
  return {
    call(source, verb, args, options = {}) {
      try {
        const result = call(source, verb, args, {
          check: options.check ?? false,
          captureOutput: true,
        });
        if ((options.check ?? false) && result.returncode !== 0) {
          const stderr = result.stderr.trim();
          throw new UpstreamCloseError(`gh ${verb} ${args.join(" ")} failed: ${stderr}`);
        }
        return {
          returncode: result.returncode,
          stdout: result.stdout,
          stderr: result.stderr,
        };
      } catch (err) {
        if (err instanceof UpstreamCloseError) throw err;
        if (err instanceof ScmStubError) {
          throw new UpstreamCloseError(`gh resolution failed: ${err.message}`);
        }
        const message = err instanceof Error ? err.message : String(err);
        throw new UpstreamCloseError(message);
      }
    },
  };
}

function defaultIssueIngest(deftRoot: string): IssueIngest {
  return {
    ingestSingleForAccept(issueNumber, repo, options = {}) {
      const projectRoot = options.projectRoot ?? process.cwd();
      const script = [
        "import sys",
        "from pathlib import Path",
        `sys.path.insert(0, ${JSON.stringify(join(deftRoot, "scripts"))})`,
        "import issue_ingest",
        "issue_ingest.ingest_single_for_accept(",
        `${issueNumber},`,
        `${JSON.stringify(repo)},`,
        `project_root=Path(${JSON.stringify(projectRoot)}),`,
        ")",
      ].join("\n");
      const result = spawnSync("uv", ["run", "python", "-c", script], {
        cwd: deftRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      if (result.status !== 0) {
        const stderr = (result.stderr ?? "").trim();
        throw new Error(stderr || "issue:ingest delegation failed");
      }
    },
  };
}

/** Default dependency bundle for production CLI use. */
export function createDefaultDeps(projectRoot: string): TriageActionsDeps {
  const deftRoot = resolveDeftRoot();
  return {
    candidatesLog: createCandidatesLog(projectRoot),
    issueIngest: defaultIssueIngest(deftRoot),
    scm: defaultScmRunner(),
    nowIso: defaultNowIso,
    stderr: (message) => process.stderr.write(`${message}\n`),
  };
}

function buildEntry(
  deps: TriageActionsDeps,
  decision: string,
  issueNumber: number,
  repo: string,
  actor: string,
  extras: Partial<AuditEntry> = {},
): AuditEntry {
  const entry: AuditEntry = {
    decision_id: deps.candidatesLog.newDecisionId(),
    timestamp: (deps.nowIso ?? defaultNowIso)(),
    repo,
    issue_number: issueNumber,
    decision,
    actor,
    ...extras,
  };
  return entry;
}

function logPathFor(projectRoot: string): string {
  return resolveAuditLogPath(projectRoot);
}

function isIdempotentRepeat(
  deps: TriageActionsDeps,
  issueNumber: number,
  repo: string,
  decision: string,
  projectRoot: string,
  linkedTo?: number,
): AuditEntry | null {
  if (!TERMINAL_DECISIONS.has(decision)) return null;
  const prior = deps.candidatesLog.latestDecision(issueNumber, repo, {
    path: logPathFor(projectRoot),
  });
  if (prior === null || prior.decision !== decision) return null;
  if (decision === "mark-duplicate" && prior.linked_to !== linkedTo) return null;
  return prior;
}

function runGh(
  deps: TriageActionsDeps,
  args: readonly string[],
): { returncode: number; stdout: string; stderr: string } {
  if (args.length === 0) {
    throw new UpstreamCloseError("scm.call requires at least a verb; got empty args");
  }
  const verb = args[0];
  if (verb === undefined) {
    throw new UpstreamCloseError("scm.call requires at least a verb; got empty args");
  }
  try {
    const result = deps.scm.call("github-issue", verb, args.slice(1), { check: true });
    return result;
  } catch (err) {
    if (err instanceof UpstreamCloseError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("ENOENT") || message.toLowerCase().includes("not found on path")) {
      throw new UpstreamCloseError(`gh CLI not found on PATH: ${message}`);
    }
    throw new UpstreamCloseError(`gh ${args.join(" ")} failed: ${message.trim()}`);
  }
}

function looksLikeMissingLabel(exc: UpstreamCloseError): boolean {
  const text = exc.message.toLowerCase();
  return text.includes("not found") || text.includes("could not add label");
}

function ensureLabelExists(deps: TriageActionsDeps, repo: string): void {
  try {
    runGh(deps, [
      "label",
      "create",
      REJECTED_LABEL,
      "--repo",
      repo,
      "--description",
      REJECTED_LABEL_DESCRIPTION,
      "--color",
      REJECTED_LABEL_COLOR,
    ]);
  } catch (err) {
    if (err instanceof UpstreamCloseError && err.message.toLowerCase().includes("already exists")) {
      return;
    }
    throw err;
  }
}

function ensureRejectedLabelApplied(
  deps: TriageActionsDeps,
  issueNumber: number,
  repo: string,
): void {
  const writeErr = deps.stderr ?? ((message: string) => process.stderr.write(`${message}\n`));
  try {
    runGh(deps, [
      "issue",
      "edit",
      String(issueNumber),
      "--repo",
      repo,
      "--add-label",
      REJECTED_LABEL,
    ]);
    return;
  } catch (addExc) {
    if (!(addExc instanceof UpstreamCloseError) || !looksLikeMissingLabel(addExc)) {
      writeErr(
        `triage_actions: reject #${issueNumber} (${repo}) closed successfully but the '${REJECTED_LABEL}' label could not be applied: ${addExc instanceof Error ? addExc.message : String(addExc)}`,
      );
      return;
    }
  }
  try {
    ensureLabelExists(deps, repo);
    runGh(deps, [
      "issue",
      "edit",
      String(issueNumber),
      "--repo",
      repo,
      "--add-label",
      REJECTED_LABEL,
    ]);
  } catch (healExc) {
    writeErr(
      `triage_actions: reject #${issueNumber} (${repo}) closed successfully but the '${REJECTED_LABEL}' label is missing and auto-create/re-add failed: ${healExc instanceof Error ? healExc.message : String(healExc)}`,
    );
  }
}

/** Record an accept audit entry and delegate vBRIEF authoring to issue_ingest. */
export function accept(
  issueNumber: number,
  repo: string,
  deps: TriageActionsDeps,
  options: AcceptOptions = {},
): string {
  const projectRoot = options.projectRoot ?? process.cwd();
  const actor = resolveActor(options.actor);
  const prior = isIdempotentRepeat(deps, issueNumber, repo, "accept", projectRoot);
  if (prior !== null) {
    return prior.decision_id;
  }

  const entry = buildEntry(deps, "accept", issueNumber, repo, actor);
  const logPath = logPathFor(projectRoot);
  const decisionId = deps.candidatesLog.append(entry, { path: logPath });
  try {
    deps.issueIngest.ingestSingleForAccept(issueNumber, repo, { projectRoot });
  } catch (exc) {
    rollbackAuditEntry(decisionId, projectRoot, logPath);
    throw new TriageError(
      `accept #${issueNumber} (${repo}): issue:ingest delegation failed; audit entry rolled back. Cause: ${exc instanceof Error ? exc.message : String(exc)}`,
    );
  }
  return decisionId;
}

/** Close upstream, best-effort label, record reject audit entry. */
export function reject(
  issueNumber: number,
  repo: string,
  reason: string,
  deps: TriageActionsDeps,
  options: RejectOptions = {},
): string {
  const projectRoot = options.projectRoot ?? process.cwd();
  const actor = resolveActor(options.actor);
  const prior = isIdempotentRepeat(deps, issueNumber, repo, "reject", projectRoot);
  if (prior !== null) {
    return prior.decision_id;
  }

  const entry = buildEntry(deps, "reject", issueNumber, repo, actor, { reason });
  const logPath = logPathFor(projectRoot);
  const decisionId = deps.candidatesLog.append(entry, { path: logPath });
  try {
    runGh(deps, [
      "issue",
      "close",
      String(issueNumber),
      "--repo",
      repo,
      "--comment",
      reason,
      "--reason",
      "not planned",
    ]);
  } catch (err) {
    rollbackAuditEntry(decisionId, projectRoot, logPath);
    throw err;
  }
  ensureRejectedLabelApplied(deps, issueNumber, repo);
  return decisionId;
}

/** Record a defer audit entry (#1123 -- structured reason + resume_on). */
export function deferAction(
  issueNumber: number,
  repo: string,
  reason: string | null | undefined,
  deps: TriageActionsDeps,
  options: DeferOptions = {},
): string {
  const projectRoot = options.projectRoot ?? process.cwd();
  const resumeOn = options.resumeOn ?? null;
  if (resumeOn !== null) {
    try {
      parseResumeOn(resumeOn);
    } catch (exc) {
      throw new TriageError(
        `defer #${issueNumber} (${repo}): invalid --resume-on expression -- ${exc instanceof Error ? exc.message : String(exc)}`,
      );
    }
  }

  const actor = resolveActor(options.actor);
  const entry = buildEntry(deps, "defer", issueNumber, repo, actor, {
    ...(reason !== null && reason !== undefined ? { reason } : {}),
    ...(resumeOn !== null ? { resume_on: resumeOn } : {}),
  });
  const logPath = logPathFor(projectRoot);
  return deps.candidatesLog.append(entry, { path: logPath });
}

/** Format a decision entry for CLI ``status`` / ``history`` output. */
export function formatDecision(entry: AuditEntry | null): string {
  if (entry === null) {
    return "(no decision recorded)";
  }
  const parts = [
    `decision=${entry.decision}`,
    `issue=#${entry.issue_number}`,
    `repo=${entry.repo}`,
    `actor=${entry.actor}`,
    `timestamp=${entry.timestamp}`,
    `decision_id=${entry.decision_id}`,
  ];
  if (entry.reason !== undefined) {
    const escaped = String(entry.reason).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    parts.push(`reason='${escaped}'`);
  }
  if (entry.linked_to !== undefined) {
    parts.push(`linked_to=#${entry.linked_to}`);
  }
  if (entry.prior_decision_id !== undefined) {
    parts.push(`prior_decision_id=${entry.prior_decision_id}`);
  }
  return `  ${parts.join(" | ")}`;
}
