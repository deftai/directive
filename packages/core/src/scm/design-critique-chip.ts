/**
 * Chip-only remaining-set write for design-critique catalog labels (#3642).
 *
 * Parent attach of ingest-ready / in-progress / later-arc mechanism-shaped MUST use this verb,
 * not `gh api POST .../labels` and not additive `scm:issue:edit --add-label`.
 */

import { spawnSync } from "node:child_process";
import {
  ensureCatalogChipLabel,
  formatDesignCritiqueJudgmentGatesRemediation,
  hasDesignCritiqueJudgmentGate,
  isDesignCritiqueDeposited,
} from "../design-critique/catalog-chip-ensure.js";
import {
  applyIngestReadyRemainingSet,
  DesignCritiqueIngestBlockedError,
  evaluateTargetDigestAdmission,
  IngestReadyCompletedArcProofError,
  proveLiveThreadCompletedArcForIngestReady,
  type ThreadComment,
  threadCommentsFromIssueComments,
} from "../design-critique/completed-arc-record.js";
import {
  applyDesignCritiqueCatalogChip,
  type DesignCritiqueCatalogChip,
} from "../design-critique/exclusive-chip.js";
import {
  formatStaleIngestReadyDiagnostic,
  INGEST_READY_CHIP,
} from "../design-critique/stale-ingest-ready-diagnostic.js";
import { fetchIssueBody, GitHubBodyError } from "../intake/github-body.js";
import { fetchIssueComments, IssueCommentFetchError } from "../intake/issue-ingest.js";
import { parseGithubOwnerRepo } from "../policy/sync-default.js";
import { ScmLabelClient } from "../vbrief-reconcile/labels.js";
import type { LabelClient } from "../vbrief-reconcile/types.js";
import { extractFlag, extractRepoFlag, extractValueFlag } from "./argv.js";
import { type GhRestSeams, InvalidRepoError, splitRepo } from "./gh-rest.js";
import { pyRepr } from "./py-format.js";

export const DESIGN_CRITIQUE_CHIP_VERB = "design-critique-chip" as const;

export const CHIP_APPLY_MISS_TOKEN = "chip apply missed (non-blocking convenience)";
export const CHIP_ENSURE_FAILED_TOKEN = "ensure-failed";

export const DESIGN_CRITIQUE_CHIP_USAGE =
  "usage: scm issue design-critique-chip --issue N --chip mechanism-shaped|in-progress|ingest-ready [--repo OWNER/NAME] [--json]\n" +
  "       Parent attach of design-critique:ingest-ready / in-progress / later-arc mechanism-shaped.\n" +
  "       Closed catalog remaining-set replace. One write. Other facets stay.\n" +
  "       ingest-ready fetches comments + live REST body and refuses unless completed-arc is complete\n" +
  "       and Target-digest admission matches (or is unpinned). Digest mismatch reports stale-target.\n" +
  "       Proof-fail is blocking. Apply miss after a passing proof is non-blocking convenience; ingest is not blocked.\n";

export const CHIP_ALIASES: Readonly<Record<string, DesignCritiqueCatalogChip>> = {
  "mechanism-shaped": "design-critique:mechanism-shaped",
  "in-progress": "design-critique:in-progress",
  "ingest-ready": "design-critique:ingest-ready",
  "design-critique:mechanism-shaped": "design-critique:mechanism-shaped",
  "design-critique:in-progress": "design-critique:in-progress",
  "design-critique:ingest-ready": "design-critique:ingest-ready",
};

export interface DesignCritiqueChipArgs {
  readonly issue: number;
  readonly chip: DesignCritiqueCatalogChip;
  readonly repo: string | null;
  readonly json: boolean;
}

export interface DesignCritiqueChipSeams {
  readonly client?: LabelClient;
  /** Default OWNER/NAME when --repo is omitted (git origin). */
  readonly resolveDefaultRepo?: () => string | null;
  /** Live-thread comments for ingest-ready proof. Default: fetchIssueComments. */
  readonly fetchComments?: (repo: string, issueNumber: number) => readonly ThreadComment[];
  /** Live REST issue body for Target-digest admission (#4995). Default: fetchIssueBody. */
  readonly fetchIssueBody?: (repo: string, issueNumber: number) => string;
  /** REST seams for catalog label probe/create (#5326). */
  readonly ghRest?: GhRestSeams;
  /** Project root for deposit / judgmentGates first-arc advisory (#5326). */
  readonly projectRoot?: string;
  /** Override ensure attach (tests). Default: ensureCatalogChipLabel. */
  readonly ensureCatalogChip?: typeof ensureCatalogChipLabel;
}

export interface DesignCritiqueChipResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Fail-closed chip name. Closed catalog only. */
export function resolveDesignCritiqueChipArg(raw: string): DesignCritiqueCatalogChip {
  const chip = CHIP_ALIASES[raw];
  if (chip === undefined) {
    throw new Error(
      `unknown design-critique chip ${pyRepr(raw)}; expected mechanism-shaped|in-progress|ingest-ready ` +
        "(or design-critique:mechanism-shaped|design-critique:in-progress|design-critique:ingest-ready)",
    );
  }
  return chip;
}

function parseIssueNumber(raw: string, source: string): number {
  const issueN = Number.parseInt(raw, 10);
  if (Number.isNaN(issueN) || issueN <= 0 || String(issueN) !== raw) {
    throw new Error(`${source} must be a positive integer; got ${pyRepr(raw)}`);
  }
  return issueN;
}

export function parseDesignCritiqueChipArgs(extra: readonly string[]): DesignCritiqueChipArgs {
  let remainder = [...extra];
  const [help] = extractFlag(remainder, "--help");
  const [helpShort] = extractFlag(remainder, "-h");
  if (help || helpShort) {
    throw new ChipUsageError(DESIGN_CRITIQUE_CHIP_USAGE.trimEnd());
  }

  const [json, afterJson] = extractFlag(remainder, "--json");
  remainder = afterJson;
  const [repoRaw, afterRepo] = extractRepoFlag(remainder);
  remainder = afterRepo;
  const [chipRaw, afterChip] = extractValueFlag(remainder, "--chip");
  remainder = afterChip;
  const [issueFlag, afterIssue] = extractValueFlag(remainder, "--issue");
  remainder = afterIssue;

  const leftoverFlags = remainder.filter((t) => t.startsWith("-"));
  if (leftoverFlags.length > 0) {
    throw new Error(
      `unrecognized flags: ${pyRepr(leftoverFlags)}. Supported: --issue, --chip, --repo, --json.`,
    );
  }

  const positionals = remainder.filter((t) => !t.startsWith("-"));
  if (chipRaw === null || chipRaw.length === 0) {
    throw new Error("missing --chip mechanism-shaped|in-progress|ingest-ready");
  }
  const chip = resolveDesignCritiqueChipArg(chipRaw);

  let issueRaw = issueFlag;
  if (positionals.length > 1) {
    throw new Error(`expected at most one positional issue number; got ${pyRepr(positionals)}`);
  }
  if (positionals.length === 1) {
    const positional = positionals[0] ?? "";
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

  return { issue, chip, repo: repoRaw !== null && repoRaw.length > 0 ? repoRaw : null, json };
}

/** Resolve OWNER/NAME from `git remote get-url origin`. */
export function resolveRepoFromGitOrigin(): string | null {
  const result = spawnSync("git", ["remote", "get-url", "origin"], {
    encoding: "utf8",
    env: process.env,
  });
  if (result.status !== 0) return null;
  const stdout = typeof result.stdout === "string" ? result.stdout : "";
  return parseGithubOwnerRepo(stdout);
}

/** Repo toplevel for deposit/judgmentGates advisory when CLI omits projectRoot. */
export function resolveProjectRootFromGit(): string | null {
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf8",
    env: process.env,
  });
  if (result.status !== 0) return null;
  const stdout = typeof result.stdout === "string" ? result.stdout.trim() : "";
  return stdout.length > 0 ? stdout : null;
}

class ChipUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChipUsageError";
  }
}

function defaultFetchComments(repo: string, issueNumber: number): ThreadComment[] {
  return threadCommentsFromIssueComments(fetchIssueComments(repo, issueNumber));
}

function defaultFetchIssueBody(repo: string, issueNumber: number): string {
  return fetchIssueBody(repo, issueNumber);
}

function proofFailResult(
  args: DesignCritiqueChipArgs,
  repo: string,
  err: Error,
): DesignCritiqueChipResult {
  const payload = {
    repo,
    issue: args.issue,
    chip: args.chip,
    applied: false,
    miss: false,
    blocking: true,
    error: err.message,
  };
  if (args.json) {
    return { exitCode: 1, stdout: `${JSON.stringify(payload)}\n`, stderr: "" };
  }
  return { exitCode: 1, stdout: "", stderr: `error: ${err.message}\n` };
}

/**
 * GET current labels, remaining-set replace via applyDesignCritiqueCatalogChip.
 * ingest-ready remaining-set proves live-thread completed-arc + Target-digest
 * admission first (#4700 / #4995). mechanism-shaped and in-progress stay
 * labels-only. One LabelClient.apply write.
 */
export function runDesignCritiqueChip(
  extra: readonly string[],
  seams: DesignCritiqueChipSeams = {},
): DesignCritiqueChipResult {
  let args: DesignCritiqueChipArgs;
  try {
    args = parseDesignCritiqueChipArgs(extra);
  } catch (err: unknown) {
    if (err instanceof ChipUsageError) {
      return { exitCode: 0, stdout: `${err.message}\n`, stderr: "" };
    }
    if (err instanceof InvalidRepoError) {
      return { exitCode: 2, stdout: "", stderr: `error: invalid --repo value: ${err.message}\n` };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { exitCode: 2, stdout: "", stderr: `error: ${message}\n` };
  }

  const repo = args.repo ?? (seams.resolveDefaultRepo ?? resolveRepoFromGitOrigin)();
  if (repo === null || repo.length === 0) {
    return {
      exitCode: 2,
      stdout: "",
      stderr: "error: missing --repo OWNER/NAME (could not resolve from git origin)\n",
    };
  }
  try {
    splitRepo(repo);
  } catch (err: unknown) {
    if (err instanceof InvalidRepoError) {
      return { exitCode: 2, stdout: "", stderr: `error: invalid --repo value: ${err.message}\n` };
    }
    throw err;
  }

  const client = seams.client ?? new ScmLabelClient();
  const fetchComments = seams.fetchComments ?? defaultFetchComments;
  const fetchBody = seams.fetchIssueBody ?? defaultFetchIssueBody;
  const ensureChip = seams.ensureCatalogChip ?? ensureCatalogChipLabel;
  // Chip path proves once above the write. ScmLabelClient.apply would re-fetch
  // and re-admit; route the post-proof write through applyWithoutCatalogGate.
  const writeClient: LabelClient =
    client instanceof ScmLabelClient
      ? {
          fetchLabels: (r, n) => client.fetchLabels(r, n),
          apply: (r, n, a, rem) => client.applyWithoutCatalogGate(r, n, a, rem),
        }
      : client;

  const ensureOrMiss = ():
    | { readonly ok: true }
    | { readonly ok: false; readonly result: DesignCritiqueChipResult } => {
    const ensured = ensureChip(repo, args.chip, seams.ghRest);
    if (ensured.ok) {
      return { ok: true };
    }
    const missClass = ensured.missClass;
    const message = `${CHIP_ENSURE_FAILED_TOKEN} (${missClass}): ${ensured.error}`;
    const payload = {
      repo,
      issue: args.issue,
      chip: args.chip,
      applied: false,
      miss: true,
      missClass,
      blocking: false,
      error: message,
    };
    if (args.json) {
      return {
        ok: false,
        result: { exitCode: 0, stdout: `${JSON.stringify(payload)}\n`, stderr: "" },
      };
    }
    return {
      ok: false,
      result: {
        exitCode: 0,
        stdout: "",
        stderr:
          `${CHIP_APPLY_MISS_TOKEN}: ${message}\n` +
          "ingest is not blocked; remaining-set hygiene is optional for a write-capable identity\n",
      },
    };
  };

  try {
    let applied: { remaining: string[]; add: readonly string[]; remove: readonly string[] };
    if (args.chip === "design-critique:ingest-ready") {
      // Arc + digest proof before ensure so ensure-fail cannot bypass proof
      // refusal and refused writes do not leave a new repo-wide label (#5326).
      const comments = fetchComments(repo, args.issue);
      const liveIssueBody = fetchBody(repo, args.issue);
      const verdict = proveLiveThreadCompletedArcForIngestReady({
        comments,
        issueNumber: args.issue,
      });
      if (verdict.status !== "complete") {
        const proofErr = new IngestReadyCompletedArcProofError(args.issue, verdict, comments);
        let standingLabels: string[] = [];
        try {
          standingLabels = client.fetchLabels(repo, args.issue);
        } catch {
          standingLabels = [];
        }
        if (standingLabels.includes(INGEST_READY_CHIP)) {
          const overlay = formatStaleIngestReadyDiagnostic({
            repo,
            issueNumber: args.issue,
            labels: standingLabels,
            verdict,
          }).text;
          return proofFailResult(args, repo, new Error(`${proofErr.message}\n${overlay}`));
        }
        return proofFailResult(args, repo, proofErr);
      }
      const cited = comments.find((comment) => comment.id === verdict.citedLeanId);
      const citedLeanBody = cited?.body ?? "";
      const digestAdmission = evaluateTargetDigestAdmission({
        citedLeanBody,
        liveIssueBody,
      });
      if (digestAdmission.status === "blocked") {
        const blockedVerdict = {
          status: "blocked" as const,
          reason: "stale-target" as const,
          detail: digestAdmission.detail,
        };
        const proofErr = new IngestReadyCompletedArcProofError(
          args.issue,
          blockedVerdict,
          comments,
        );
        let standingLabels: string[] = [];
        try {
          standingLabels = client.fetchLabels(repo, args.issue);
        } catch {
          standingLabels = [];
        }
        if (standingLabels.includes(INGEST_READY_CHIP)) {
          const overlay = formatStaleIngestReadyDiagnostic({
            repo,
            issueNumber: args.issue,
            labels: standingLabels,
            verdict: blockedVerdict,
            digestAdmission,
            liveIssueBody,
            citedLeanBody,
          }).text;
          return proofFailResult(args, repo, new Error(`${proofErr.message}\n${overlay}`));
        }
        return proofFailResult(args, repo, proofErr);
      }

      const ensured = ensureOrMiss();
      if (!ensured.ok) {
        return ensured.result;
      }

      const outcome = applyIngestReadyRemainingSet(
        writeClient,
        repo,
        args.issue,
        comments,
        liveIssueBody,
      );
      if (!outcome.ok) {
        const proofErr = new IngestReadyCompletedArcProofError(
          args.issue,
          outcome.verdict,
          comments,
        );
        let standingLabels: string[] = [];
        try {
          standingLabels = client.fetchLabels(repo, args.issue);
        } catch {
          standingLabels = [];
        }
        if (standingLabels.includes(INGEST_READY_CHIP)) {
          const overlay = formatStaleIngestReadyDiagnostic({
            repo,
            issueNumber: args.issue,
            labels: standingLabels,
            verdict: outcome.verdict,
            digestAdmission: outcome.digestAdmission,
            liveIssueBody: outcome.liveIssueBody,
            citedLeanBody: outcome.citedLeanBody,
          }).text;
          return proofFailResult(args, repo, new Error(`${proofErr.message}\n${overlay}`));
        }
        return proofFailResult(args, repo, proofErr);
      }
      applied = outcome;
    } else {
      // Ensure-on-write for non-ingest catalog chips (#5326).
      const ensured = ensureOrMiss();
      if (!ensured.ok) {
        return ensured.result;
      }
      applied = applyDesignCritiqueCatalogChip(writeClient, repo, args.issue, args.chip);
    }

    // First-arc judgmentGates advisory: no pin-present durable policy writer for
    // judgmentGates (S1); loud advisory when deposited and gate dark (#5326).
    let gateAdvisory = "";
    const projectRoot = seams.projectRoot ?? resolveProjectRootFromGit() ?? process.cwd();
    if (isDesignCritiqueDeposited(projectRoot) && !hasDesignCritiqueJudgmentGate(projectRoot)) {
      gateAdvisory = formatDesignCritiqueJudgmentGatesRemediation();
    }

    const payload = {
      repo,
      issue: args.issue,
      chip: args.chip,
      add: [...applied.add],
      remove: [...applied.remove],
      remaining: [...applied.remaining],
      ...(gateAdvisory.length > 0 ? { judgmentGatesAdvisory: gateAdvisory } : {}),
    };
    if (args.json) {
      return {
        exitCode: 0,
        stdout: `${JSON.stringify(payload)}\n`,
        stderr: gateAdvisory.length > 0 ? `${gateAdvisory}\n` : "",
      };
    }
    const wrote = applied.add.length > 0 || applied.remove.length > 0;
    const detail =
      applied.remove.length > 0
        ? `removed ${applied.remove.join(", ")}`
        : wrote
          ? "added"
          : "already exclusive";
    return {
      exitCode: 0,
      stdout: `${wrote ? "applied" : "unchanged"} ${args.chip} on ${repo}#${args.issue} (${detail})\n`,
      stderr: gateAdvisory.length > 0 ? `${gateAdvisory}\n` : "",
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const proofFail =
      err instanceof IngestReadyCompletedArcProofError ||
      err instanceof DesignCritiqueIngestBlockedError ||
      err instanceof IssueCommentFetchError ||
      err instanceof GitHubBodyError;
    const payload = {
      repo,
      issue: args.issue,
      chip: args.chip,
      applied: false,
      miss: !proofFail,
      blocking: proofFail,
      error: message,
    };
    if (proofFail) {
      if (args.json) {
        return { exitCode: 1, stdout: `${JSON.stringify(payload)}\n`, stderr: "" };
      }
      return { exitCode: 1, stdout: "", stderr: `error: ${message}\n` };
    }
    if (args.json) {
      return { exitCode: 0, stdout: `${JSON.stringify(payload)}\n`, stderr: "" };
    }
    return {
      exitCode: 0,
      stdout: "",
      stderr:
        `${CHIP_APPLY_MISS_TOKEN}: ${message}\n` +
        "ingest is not blocked; remaining-set hygiene is optional for a write-capable identity\n",
    };
  }
}
