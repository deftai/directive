/**
 * Chip-only remaining-set write for design-critique catalog labels (#3642).
 *
 * Parent attach of triage-ready / recut mechanism-shaped MUST use this verb,
 * not `gh api POST .../labels` and not additive `scm:issue:edit --add-label`.
 */

import { spawnSync } from "node:child_process";
import {
  applyDesignCritiqueCatalogChip,
  type DesignCritiqueCatalogChip,
} from "../design-critique/exclusive-chip.js";
import { parseGithubOwnerRepo } from "../policy/sync-default.js";
import { ScmLabelClient } from "../vbrief-reconcile/labels.js";
import type { LabelClient } from "../vbrief-reconcile/types.js";
import { extractFlag, extractValueFlag } from "./argv.js";
import { InvalidRepoError, splitRepo } from "./gh-rest.js";
import { pyRepr } from "./py-format.js";

export const DESIGN_CRITIQUE_CHIP_VERB = "design-critique-chip" as const;

export const CHIP_APPLY_MISS_TOKEN = "chip apply missed (non-blocking convenience)";

export const DESIGN_CRITIQUE_CHIP_USAGE =
  "usage: scm issue design-critique-chip --issue N --chip triage-ready|mechanism-shaped [--repo OWNER/NAME] [--json]\n" +
  "       Parent attach of design-critique:triage-ready / recut mechanism-shaped.\n" +
  "       Closed catalog remaining-set replace. One write. Other facets stay.\n" +
  "       Apply miss is non-blocking convenience; ingest is not blocked.\n";

const CHIP_ALIASES: Readonly<Record<string, DesignCritiqueCatalogChip>> = {
  "triage-ready": "design-critique:triage-ready",
  "mechanism-shaped": "design-critique:mechanism-shaped",
  "design-critique:triage-ready": "design-critique:triage-ready",
  "design-critique:mechanism-shaped": "design-critique:mechanism-shaped",
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
      `unknown design-critique chip ${pyRepr(raw)}; expected triage-ready|mechanism-shaped ` +
        "(or design-critique:triage-ready|design-critique:mechanism-shaped)",
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
  const [repoRaw, afterRepo] = extractValueFlag(remainder, "--repo");
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
    throw new Error("missing --chip triage-ready|mechanism-shaped");
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

class ChipUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChipUsageError";
  }
}

/**
 * GET current labels, remaining-set replace via applyDesignCritiqueCatalogChip.
 * One LabelClient.apply write. Other facets stay.
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
  try {
    const applied = applyDesignCritiqueCatalogChip(client, repo, args.issue, args.chip);
    const payload = {
      repo,
      issue: args.issue,
      chip: args.chip,
      add: [...applied.add],
      remove: [...applied.remove],
      remaining: [...applied.remaining],
    };
    if (args.json) {
      return { exitCode: 0, stdout: `${JSON.stringify(payload)}\n`, stderr: "" };
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
      stderr: "",
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const payload = {
      repo,
      issue: args.issue,
      chip: args.chip,
      applied: false,
      miss: true,
      blocking: false,
      error: message,
    };
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
