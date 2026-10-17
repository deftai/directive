import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CacheNotFoundError } from "../../cache/errors.js";
import { cacheGet } from "../../cache/operations.js";
import {
  briefOwnsExactIssueAndRepo,
  ingestSingleForAccept as ingestSingleForAcceptTs,
  numberOnlyOriginKey,
  scanProvenanceOrigins,
  scanProvenanceRefs,
} from "../../intake/issue-ingest.js";
import { issueOriginKey } from "../../intake/reconcile-issues.js";
import {
  formatCompletedDuplicateWithResidualRecovery,
  isTerminalRelPath,
} from "../../intake/residual-identity.js";
import { resolveLifecycleRoot } from "../../layout/resolve.js";
import { call } from "../../scm/call.js";
import { ScmStubError } from "../../scm/errors.js";
import {
  findLifecycleArtifactsForIssue,
  findProposedArtifactsForIssue,
  promoteFromIssue,
} from "../../scope/promote-from-issue.js";
import { promotePath } from "../../scope/promote-path.js";
import {
  createCandidatesLog,
  findByIssue,
  resolveAuditLogPath,
  rollbackAuditEntry,
} from "./candidates-log.js";
import { TriageError, UpstreamCloseError } from "./errors.js";
import { parseResumeOn } from "./resume-on.js";
import type {
  AcceptIngestResult,
  AcceptOptions,
  AcceptOutcome,
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
  findByIssue,
  latestDecisionForIssue,
  latestDecisions,
  readAuditLog,
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
  AcceptIngestResult,
  AcceptOptions,
  AcceptOutcome,
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
const DEFAULT_NEEDS_AC_COMMENT =
  "This issue lacks acceptance criteria. Please add a Test/Acceptance " +
  "narrative before this can be triaged. (deft #845)";

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
          check: false,
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

function normalizeAcceptIngest(
  value: AcceptIngestResult | string | null | undefined,
): AcceptIngestResult {
  if (value !== null && typeof value === "object" && "result" in value) {
    return value;
  }
  if (typeof value === "string" && value.length > 0) {
    return { result: "created", path: value, message: `CREATED ${value}` };
  }
  return { result: "created", path: null, message: "CREATED (path unknown)" };
}

function toRelativeLifecyclePath(projectRoot: string, absPath: string | null): string | null {
  if (absPath === null || absPath.length === 0) {
    return null;
  }
  const normalized = absPath.replace(/\\/g, "/");
  const markers = ["/xbrief/", "/vbrief/"];
  for (const marker of markers) {
    const idx = normalized.toLowerCase().lastIndexOf(marker);
    if (idx >= 0) {
      return normalized.slice(idx + marker.length);
    }
  }
  try {
    const root = resolveLifecycleRoot(projectRoot).replace(/\\/g, "/");
    if (normalized.startsWith(`${root}/`)) {
      return normalized.slice(root.length + 1);
    }
  } catch {
    /* ignore */
  }
  return normalized;
}

type OwningBriefResolution =
  | { kind: "none" }
  | { kind: "single"; relPath: string }
  | { kind: "ambiguous"; relPaths: string[] }
  | { kind: "terminal"; relPath: string; message: string };

function formatMultipleOwningBriefsMessage(
  issueNumber: number,
  relPaths: readonly string[],
): string {
  return (
    `#${issueNumber} refuse: multiple owning briefs for the same issue+repo:\n` +
    [...relPaths].map((p) => `  - ${p}`).join("\n") +
    "\nNo new proposed artifact written."
  );
}

function resolveOwningBriefs(
  projectRoot: string,
  issueNumber: number,
  repo: string,
): OwningBriefResolution {
  try {
    const lifecycleRoot = resolveLifecycleRoot(projectRoot);
    const byIssue = scanProvenanceRefs(lifecycleRoot);
    const raw = byIssue.get(issueNumber) ?? [];
    const live: string[] = [];
    const consider = (rel: string): void => {
      const folder = rel.split(/[/\\]/)[0] ?? "";
      if (
        folder !== "proposed" &&
        folder !== "pending" &&
        folder !== "active" &&
        folder !== "completed" &&
        folder !== "cancelled"
      ) {
        return;
      }
      try {
        const data = JSON.parse(readFileSync(join(lifecycleRoot, rel), "utf8")) as Record<
          string,
          unknown
        >;
        if (briefOwnsExactIssueAndRepo(data, issueNumber, repo)) {
          live.push(rel.replace(/\\/g, "/"));
        }
      } catch {
        /* skip */
      }
    };
    for (const rel of raw) {
      consider(rel);
    }
    // Merge Origin owners so a typed-ref brief + Origin-only peer refuse on re-accept.
    const origins = scanProvenanceOrigins(lifecycleRoot);
    const slash = repo.indexOf("/");
    const originKeys = [numberOnlyOriginKey(issueNumber)];
    if (slash > 0 && slash < repo.length - 1) {
      originKeys.unshift(
        issueOriginKey({
          owner: repo.slice(0, slash),
          repo: repo.slice(slash + 1),
          number: issueNumber,
        }),
      );
    }
    for (const key of originKeys) {
      for (const hit of origins.get(key) ?? []) {
        consider(hit);
      }
    }
    const unique = [...new Set(live)].sort();
    const terminals = unique.filter((p) => isTerminalRelPath(p));
    const nonTerminals = unique.filter((p) => !isTerminalRelPath(p));
    if (terminals.length > 0 && nonTerminals.length === 0) {
      if (terminals.length === 1) {
        const relPath = terminals[0] as string;
        return {
          kind: "terminal",
          relPath,
          message: formatCompletedDuplicateWithResidualRecovery(issueNumber, relPath),
        };
      }
      return { kind: "ambiguous", relPaths: terminals };
    }
    if (nonTerminals.length > 1 || (nonTerminals.length >= 1 && terminals.length >= 1)) {
      return { kind: "ambiguous", relPaths: unique };
    }
    if (nonTerminals.length === 1) {
      return { kind: "single", relPath: nonTerminals[0] as string };
    }
  } catch {
    /* ignore */
  }
  const proposed = findProposedArtifactsForIssue(projectRoot, issueNumber, repo);
  if (proposed.length === 1) {
    const rel = toRelativeLifecyclePath(projectRoot, proposed[0] ?? null);
    return rel !== null ? { kind: "single", relPath: rel } : { kind: "none" };
  }
  if (proposed.length > 1) {
    const relPaths = proposed
      .map((p) => toRelativeLifecyclePath(projectRoot, p))
      .filter((p): p is string => p !== null)
      .sort();
    if (relPaths.length > 1) {
      return { kind: "ambiguous", relPaths };
    }
    if (relPaths.length === 1) {
      return { kind: "single", relPath: relPaths[0] as string };
    }
  }
  return { kind: "none" };
}

function defaultIssueIngest(): IssueIngest {
  return {
    ingestSingleForAccept(issueNumber, repo, options = {}) {
      const projectRoot = options.projectRoot ?? process.cwd();
      // Delegate to the native TS intake path (#2350). The legacy Python
      // `scripts/issue_ingest.py` shell-out was orphaned when #1933 removed the
      // Python surface, leaving `triage:accept` raising ModuleNotFoundError.
      const [result, path, msg] = ingestSingleForAcceptTs(issueNumber, repo, { projectRoot });
      if (typeof msg === "string" && msg.includes("\n")) {
        process.stderr.write(`${msg}\n`);
      }
      return { result, path, message: msg };
    },
  };
}

/** Default dependency bundle for production CLI use. */
export function createDefaultDeps(projectRoot: string): TriageActionsDeps {
  const deps: TriageActionsDeps = {
    candidatesLog: createCandidatesLog(projectRoot),
    issueIngest: defaultIssueIngest(),
    scm: defaultScmRunner(),
    nowIso: defaultNowIso,
    stderr: (message) => process.stderr.write(`${message}\n`),
  };
  if (process.env.DEFT_TRIAGE_ACTIONS_PARITY === "1") {
    return {
      ...deps,
      scm: {
        call() {
          throw new UpstreamCloseError("gh disabled for parity");
        },
      },
    };
  }
  return deps;
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

function cacheRootFor(projectRoot: string): string {
  return join(projectRoot, ".deft-cache");
}

/** Return audit entries for ``issueNumber`` ordered ascending by timestamp. */
export function history(
  issueNumber: number,
  repo: string,
  _deps: TriageActionsDeps,
  options: { projectRoot?: string } = {},
): AuditEntry[] {
  const projectRoot = options.projectRoot ?? process.cwd();
  const entries = findByIssue(issueNumber, repo, logPathFor(projectRoot));
  entries.sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
  return entries;
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

/**
 * After a successful accept (or idempotent re-accept), promote proposed → pending (#1136).
 * Surfaces WIP-cap refusals with the same messaging as scope:promote.
 * Returns the lifecycle-relative destination (pending/ or already live path).
 */
function runAutoPromote(
  issueNumber: number,
  repo: string,
  projectRoot: string,
  decisionId: string,
  ingestedPath: string | null | undefined,
  force: boolean | undefined,
): string | null {
  // Already pending/active for this issue → idempotent success (repeat accept --auto-promote).
  const alreadyLive = findLifecycleArtifactsForIssue(projectRoot, issueNumber, {
    folders: ["pending", "active"],
    repo,
  });
  if (alreadyLive.length >= 1) {
    return toRelativeLifecyclePath(projectRoot, alreadyLive[0] ?? null);
  }

  let path = typeof ingestedPath === "string" && ingestedPath.length > 0 ? ingestedPath : null;
  if (path === null) {
    const matches = findProposedArtifactsForIssue(projectRoot, issueNumber, repo);
    if (matches.length === 1) {
      path = matches[0] ?? null;
    } else if (matches.length > 1) {
      throw new TriageError(
        `accept #${issueNumber} (${repo}): --auto-promote found multiple proposed artifacts:\n` +
          matches.map((p) => `  - ${p}`).join("\n") +
          `\nPromote one with: task scope:promote -- <path>`,
      );
    }
  }
  if (path === null) {
    // Fall back to full from-issue resolution (may still fail on missing artifact).
    const fromIssue = promoteFromIssue({
      issueNumber,
      repo,
      projectRoot,
      force: force === true,
    });
    if (!fromIssue.ok) {
      throw new TriageError(
        `accept #${issueNumber} (${repo}): accept recorded but --auto-promote failed: ${fromIssue.message}`,
      );
    }
    const matched = fromIssue.matchedPaths?.[0] ?? null;
    return toRelativeLifecyclePath(projectRoot, matched);
  }
  const result = promotePath(path, {
    projectRoot,
    force: force === true,
    fromIssue: issueNumber,
    cacheDecisionId: decisionId,
    cacheStateAtPromote: "accept",
    requireAudit: true,
  });
  if (!result.ok) {
    throw new TriageError(
      `accept #${issueNumber} (${repo}): accept recorded but --auto-promote failed: ${result.message}`,
    );
  }
  return toRelativeLifecyclePath(projectRoot, result.destPath ?? null);
}

/** Record an accept audit entry and delegate vBRIEF authoring to issue_ingest. */
export function accept(
  issueNumber: number,
  repo: string,
  deps: TriageActionsDeps,
  options: AcceptOptions = {},
): AcceptOutcome {
  const projectRoot = options.projectRoot ?? process.cwd();
  const actor = resolveActor(options.actor);
  const prior = isIdempotentRepeat(deps, issueNumber, repo, "accept", projectRoot);
  if (prior !== null) {
    const owning = resolveOwningBriefs(projectRoot, issueNumber, repo);
    if (owning.kind === "ambiguous") {
      return {
        decisionId: null,
        disposition: "refused",
        relativePath: null,
        ingestMessage: formatMultipleOwningBriefsMessage(issueNumber, owning.relPaths),
      };
    }
    if (owning.kind === "terminal") {
      return {
        decisionId: null,
        disposition: "refused",
        relativePath: owning.relPath,
        ingestMessage: owning.message,
      };
    }
    const owningRel = owning.kind === "single" ? owning.relPath : null;
    let relativePath = owningRel;
    if (options.autoPromote === true) {
      let owningAbs: string | null = null;
      if (owningRel !== null) {
        try {
          owningAbs = join(resolveLifecycleRoot(projectRoot), owningRel);
        } catch {
          owningAbs = null;
        }
      }
      const promoted = runAutoPromote(
        issueNumber,
        repo,
        projectRoot,
        prior.decision_id,
        owningAbs,
        options.force,
      );
      if (promoted !== null) {
        relativePath = promoted;
      }
    }
    return {
      decisionId: prior.decision_id,
      disposition: "idempotent",
      relativePath,
      ingestMessage:
        relativePath !== null
          ? `#${issueNumber} already ingested at ${relativePath}`
          : `#${issueNumber} already accepted (nothing new written)`,
    };
  }

  // Ingest before audit append so refuse-before-write never leaves a success audit (#4962).
  let ingest: AcceptIngestResult;
  try {
    ingest = normalizeAcceptIngest(
      deps.issueIngest.ingestSingleForAccept(issueNumber, repo, { projectRoot }),
    );
  } catch (exc) {
    // Operational deny: ingest delegation failure returns refused (no throw-site hard fact) (#4962).
    return {
      decisionId: null,
      disposition: "refused",
      relativePath: null,
      ingestMessage: `accept #${issueNumber} (${repo}): issue:ingest delegation failed. Cause: ${exc instanceof Error ? exc.message : String(exc)}`,
    };
  }

  let relativePath =
    toRelativeLifecyclePath(projectRoot, ingest.path) ??
    ingest.message.match(/\b((?:proposed|pending|active|completed|cancelled)\/\S+)/)?.[1] ??
    null;

  if (ingest.result === "refused") {
    return {
      decisionId: null,
      disposition: "refused",
      relativePath,
      ingestMessage: ingest.message,
    };
  }

  const entry = buildEntry(deps, "accept", issueNumber, repo, actor);
  const logPath = logPathFor(projectRoot);
  const decisionId = deps.candidatesLog.append(entry, { path: logPath });
  const disposition: AcceptOutcome["disposition"] =
    ingest.result === "duplicate" ? "duplicate" : "created";

  if (options.autoPromote === true) {
    const promoted = runAutoPromote(
      issueNumber,
      repo,
      projectRoot,
      decisionId,
      typeof ingest.path === "string" ? ingest.path : null,
      options.force,
    );
    if (promoted !== null) {
      relativePath = promoted;
    }
  }
  return {
    decisionId,
    disposition,
    relativePath,
    ingestMessage: ingest.message,
  };
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

/** Record a needs-ac audit entry and best-effort post an AC-request comment upstream. */
export function needsAc(
  issueNumber: number,
  repo: string,
  deps: TriageActionsDeps,
  options: { actor?: string | null; comment?: string | null; projectRoot?: string } = {},
): string {
  const projectRoot = options.projectRoot ?? process.cwd();
  const body = options.comment ?? DEFAULT_NEEDS_AC_COMMENT;
  const actor = resolveActor(options.actor);
  const entry = buildEntry(deps, "needs-ac", issueNumber, repo, actor, { reason: body });
  const logPath = logPathFor(projectRoot);
  const decisionId = deps.candidatesLog.append(entry, { path: logPath });
  const writeErr = deps.stderr ?? ((message: string) => process.stderr.write(`${message}\n`));
  try {
    runGh(deps, ["issue", "comment", String(issueNumber), "--repo", repo, "--body", body]);
  } catch (exc) {
    writeErr(
      `triage_actions: needs-ac comment not posted for #${issueNumber} (${repo}): ${exc instanceof Error ? exc.message : String(exc)}`,
    );
  }
  return decisionId;
}

/** Validate duplicate target in cache and record a mark-duplicate audit entry. */
export function markDuplicate(
  issueNumber: number,
  repo: string,
  ofN: number,
  deps: TriageActionsDeps,
  options: { actor?: string | null; projectRoot?: string } = {},
): string {
  const projectRoot = options.projectRoot ?? process.cwd();
  if (ofN === issueNumber) {
    throw new TriageError(`mark-duplicate target #${ofN} cannot equal source #${issueNumber}`);
  }
  const key = `${repo}/${ofN}`;
  try {
    cacheGet("github-issue", key, { allowStale: true, cacheRoot: cacheRootFor(projectRoot) });
  } catch (exc) {
    if (exc instanceof CacheNotFoundError) {
      throw new TriageError(
        `mark-duplicate target #${ofN} not found in cache for ${repo}: ${exc.message}`,
      );
    }
    throw exc;
  }
  const prior = isIdempotentRepeat(deps, issueNumber, repo, "mark-duplicate", projectRoot, ofN);
  if (prior !== null) {
    return prior.decision_id;
  }
  const actor = resolveActor(options.actor);
  const entry = buildEntry(deps, "mark-duplicate", issueNumber, repo, actor, { linked_to: ofN });
  const logPath = logPathFor(projectRoot);
  return deps.candidatesLog.append(entry, { path: logPath });
}

/** Return the latest decision for ``issueNumber`` in ``repo`` (null if none). */
export function status(
  issueNumber: number,
  repo: string,
  deps: TriageActionsDeps,
  options: { projectRoot?: string } = {},
): AuditEntry | null {
  const projectRoot = options.projectRoot ?? process.cwd();
  return deps.candidatesLog.latestDecision(issueNumber, repo, {
    path: logPathFor(projectRoot),
  });
}

/** Record a reset audit entry referencing the prior decision_id (history is never deleted). */
export function reset(
  issueNumber: number,
  repo: string,
  deps: TriageActionsDeps,
  options: { actor?: string | null; projectRoot?: string } = {},
): string {
  const projectRoot = options.projectRoot ?? process.cwd();
  const logPath = logPathFor(projectRoot);
  const prior = deps.candidatesLog.latestDecision(issueNumber, repo, { path: logPath });
  if (prior === null) {
    throw new TriageError(`cannot reset #${issueNumber}: no prior decision recorded for ${repo}`);
  }
  if (prior.decision === "reset") {
    return prior.decision_id;
  }
  const actor = resolveActor(options.actor);
  const entry = buildEntry(deps, "reset", issueNumber, repo, actor, {
    prior_decision_id: prior.decision_id,
  });
  return deps.candidatesLog.append(entry, { path: logPath });
}

/** Success line for ``triage:accept``, plus the optional design-critique affordance (#3708 / #4962). */
export function formatAcceptOutput(
  issueNumber: number,
  repo: string,
  decisionId: string | null,
  options: {
    autoPromote?: boolean;
    disposition?: AcceptOutcome["disposition"];
    relativePath?: string | null;
    ingestMessage?: string | null;
  } = {},
): string {
  const disposition = options.disposition ?? "created";
  const promoteNote = options.autoPromote === true ? " + auto-promote" : "";
  const idPart = decisionId !== null && decisionId.length > 0 ? ` -> ${decisionId}` : "";
  const head = `accept #${issueNumber} (${repo})${idPart}${promoteNote}`;

  let outcomeLine: string;
  if (disposition === "refused") {
    outcomeLine =
      options.ingestMessage !== null &&
      options.ingestMessage !== undefined &&
      options.ingestMessage.length > 0
        ? options.ingestMessage
        : `refused (no new proposed artifact)`;
  } else if (disposition === "duplicate" || disposition === "idempotent") {
    const rel = options.relativePath;
    outcomeLine =
      rel !== null && rel !== undefined && rel.length > 0
        ? `already-ingested/reuse ${rel}`
        : (options.ingestMessage ?? `#${issueNumber} already ingested (nothing new written)`);
  } else {
    const rel = options.relativePath;
    if (rel !== null && rel !== undefined && rel.length > 0) {
      outcomeLine = rel.startsWith("CREATED ") ? rel : `CREATED ${rel}`;
    } else if (options.ingestMessage?.startsWith("CREATED ")) {
      outcomeLine = options.ingestMessage.split("\n")[0] ?? options.ingestMessage;
    } else {
      outcomeLine = "CREATED (path unknown)";
    }
  }

  return (
    `${head}\n${outcomeLine}\n` +
    "optional: deft-directive-design-critique (declining writes nothing)"
  );
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
