#!/usr/bin/env node
/**
 * CLI for verify:scope-provenance (#3145 / #4956 / #4774 / #5057).
 *
 * Membership against the declared allowlist (mint / brief file_scope) is
 * evaluated inside evaluateScopeProvenance. This CLI forwards --base-ref.
 * `--enforce` / `--warn` stay parsed for compatibility; `--enforce` is a
 * no-op after #4956 / #5002 and prints a stderr notice when present.
 *
 * `--pr N` / `--repo OWNER/NAME` (env fallback GITHUB_PR_NUMBER /
 * GITHUB_REPOSITORY) supply PR context for the forge-approved head-brief
 * membership admit (#6203). Without a PR number the admit is never consulted.
 *
 * A one-PR mint-level admit (#6273) prints its block on stdout and appends the
 * same block to `$GITHUB_STEP_SUMMARY` when that variable is set.
 *
 * #6378: one line per phase on fd 2 (synchronous write) unless `--quiet`, and
 * `--git-timeout-seconds <n>` (0 = no limit; env
 * `DEFT_SCOPE_PROVENANCE_GIT_TIMEOUT_SECONDS`; default 120) for every git call.
 */
import { appendFileSync, writeSync } from "node:fs";
import { resolve } from "node:path";
import { scopeProvenance } from "@deftai/directive-core";
import { readLiveDelegation } from "@deftai/directive-core/authz";
import { formatMintLevelAdmitBlock, type MintLevelAdmit } from "@deftai/directive-core/policy";
import { mergeGroupSkip } from "@deftai/directive-core/pr-wait-mergeable";
import { isDirectEntrypoint } from "./entrypoint.js";

/** Stderr line when argv includes `--enforce`. Exit code is unchanged. */
export const ENFORCE_NOOP_NOTICE =
  "verify_scope_provenance: --enforce has no effect after #4956 / #5002";

interface ParsedArgs {
  projectRoot: string;
  baseRef: string;
  enforce: boolean;
  /** Raw `--enforce` token present, even when a later `--warn` wins `enforce`. */
  enforcePresent: boolean;
  quiet: boolean;
  /** PR number for the forge-approval admit (#6203); null when absent. */
  prNumber: number | null;
  /** OWNER/NAME for the forge-approval admit; empty means resolve. */
  repo: string;
  /** `--git-timeout-seconds` value (#6378); null when absent. */
  gitTimeoutSeconds: number | null;
  error?: string;
}

/** Prefix of each phase line on fd 2 (#6378 item 7). */
export const PHASE_LINE_PREFIX = "verify_scope_provenance: phase: ";

const GIT_TIMEOUT_FLAG = "--git-timeout-seconds";

const PR_DIGITS = /^[1-9][0-9]*$/;

function parsePr(value: string): number | null {
  const t = value.trim();
  return PR_DIGITS.test(t) ? Number(t) : null;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    projectRoot: ".",
    // Empty means use PR-aware default (origin/master...), not bare HEAD.
    baseRef: "",
    enforce: false,
    enforcePresent: false,
    quiet: false,
    prNumber: null,
    repo: "",
    gitTimeoutSeconds: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === GIT_TIMEOUT_FLAG || arg?.startsWith(`${GIT_TIMEOUT_FLAG}=`)) {
      const value = arg === GIT_TIMEOUT_FLAG ? argv[i + 1] : arg.slice(GIT_TIMEOUT_FLAG.length + 1);
      if (arg === GIT_TIMEOUT_FLAG) i += 1;
      const seconds = value === undefined ? null : scopeProvenance.parseGitTimeoutSeconds(value);
      if (seconds === null) {
        return {
          ...parsed,
          error: `argument ${GIT_TIMEOUT_FLAG}: expected a whole number of seconds (0 = no limit)`,
        };
      }
      parsed.gitTimeoutSeconds = seconds;
    } else if (arg === "--quiet") {
      parsed.quiet = true;
    } else if (arg === "--enforce") {
      parsed.enforce = true;
      parsed.enforcePresent = true;
    } else if (arg === "--warn") {
      parsed.enforce = false;
    } else if (arg === "--project-root") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...parsed, error: "argument --project-root: expected one argument" };
      }
      parsed.projectRoot = value;
      i += 1;
    } else if (arg?.startsWith("--project-root=")) {
      parsed.projectRoot = arg.slice("--project-root=".length);
    } else if (arg === "--base-ref") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...parsed, error: "argument --base-ref: expected one argument" };
      }
      parsed.baseRef = value;
      i += 1;
    } else if (arg?.startsWith("--base-ref=")) {
      parsed.baseRef = arg.slice("--base-ref=".length);
    } else if (arg === "--pr" || arg?.startsWith("--pr=")) {
      const value = arg === "--pr" ? argv[i + 1] : arg.slice("--pr=".length);
      if (arg === "--pr") i += 1;
      const pr = value === undefined ? null : parsePr(value);
      if (pr === null) {
        return { ...parsed, error: "argument --pr: expected a positive PR number" };
      }
      parsed.prNumber = pr;
    } else if (arg === "--repo" || arg?.startsWith("--repo=")) {
      const value = arg === "--repo" ? argv[i + 1] : arg.slice("--repo=".length);
      if (arg === "--repo") i += 1;
      if (value === undefined || value.trim().length === 0) {
        return { ...parsed, error: "argument --repo: expected OWNER/NAME" };
      }
      parsed.repo = value.trim();
    } else {
      return { ...parsed, error: `unrecognized argument: ${arg}` };
    }
  }
  return parsed;
}

/**
 * PR context for the forge-approval admit (#6203): flags win, then
 * GITHUB_PR_NUMBER (digits only) / GITHUB_REPOSITORY. Null without a PR.
 */
export function resolveForgeContext(
  args: Pick<ParsedArgs, "prNumber" | "repo">,
  env: NodeJS.ProcessEnv,
): { prNumber: number; repo: string | null } | null {
  const prNumber = args.prNumber ?? parsePr(env.GITHUB_PR_NUMBER ?? "");
  if (prNumber === null) return null;
  const repo = args.repo.length > 0 ? args.repo : (env.GITHUB_REPOSITORY ?? "").trim();
  return { prNumber, repo: repo.length > 0 ? repo : null };
}

/**
 * Print each mint-level admit block (#6273) and append it to the step summary
 * when `GITHUB_STEP_SUMMARY` is set. A summary write failure is reported on
 * stderr and never changes the exit code.
 */
export function reportMintLevelAdmits(
  admits: readonly MintLevelAdmit[],
  env: NodeJS.ProcessEnv,
): void {
  if (admits.length === 0) return;
  const block = admits.map((a) => formatMintLevelAdmitBlock(a)).join("");
  process.stdout.write(block);
  const summaryPath = (env.GITHUB_STEP_SUMMARY ?? "").trim();
  if (summaryPath.length === 0) return;
  const fence = "```";
  try {
    appendFileSync(summaryPath, `\n${fence}text\n${block}${fence}\n`, "utf8");
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `verify_scope_provenance: could not append to GITHUB_STEP_SUMMARY: ${detail}\n`,
    );
  }
}

/**
 * Print the success report of extra paths (#6221 P4): each extra path with its
 * class and spend, from the shared assessment. Also appended to the step
 * summary when `GITHUB_STEP_SUMMARY` is set; a write failure never changes the
 * exit code. The refusal output keeps its own hard-refused wording.
 */
export function reportExtraPaths(lines: readonly string[], env: NodeJS.ProcessEnv): void {
  if (lines.length === 0) return;
  const block = `${lines.join("\n")}\n`;
  process.stdout.write(block);
  const summaryPath = (env.GITHUB_STEP_SUMMARY ?? "").trim();
  if (summaryPath.length === 0) return;
  const fence = "```";
  try {
    appendFileSync(summaryPath, `\n${fence}text\n${block}${fence}\n`, "utf8");
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `verify_scope_provenance: could not append to GITHUB_STEP_SUMMARY: ${detail}\n`,
    );
  }
}

/**
 * Quote one argument for the printed remedy only when it needs it. Single
 * quotes keep `$` and backticks literal in both bash and PowerShell; an
 * embedded single quote is doubled (the PowerShell form).
 */
function remedyArg(arg: string): string {
  return /^[^\s"'`$&|;<>()*?[\]{}#~!]+$/.test(arg) ? arg : `'${arg.replace(/'/g, "''")}'`;
}

/**
 * The verb as it was run, with a larger `--git-timeout-seconds` value (#6378
 * item 10). Running it exactly as printed repeats this check with that limit.
 */
export function formatGitTimeoutRemedy(argv: readonly string[], largerSeconds: number): string {
  const kept: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (arg === GIT_TIMEOUT_FLAG) {
      i += 1;
      continue;
    }
    if (arg.startsWith(`${GIT_TIMEOUT_FLAG}=`)) continue;
    kept.push(arg);
  }
  return ["deft", "verify:scope-provenance", ...kept, GIT_TIMEOUT_FLAG, String(largerSeconds)]
    .map(remedyArg)
    .join(" ");
}

/** Test seams for {@link run}. */
export interface RunSeams {
  /** Synchronous stderr writer (default: `fs.writeSync(2, ...)`). */
  readonly writeStderrSync?: (text: string) => void;
  /** spawnSync seam for every git call. */
  readonly gitSpawn?: scopeProvenance.GitSpawn;
  /** Mode of `scope-provenance-git-call-timeout` (default: the declared mode). */
  readonly gitTimeoutMode?: scopeProvenance.DeclaredRefusalMode;
  /** Live TOTP delegation resolver for the fence's delegated-stamp admission (#7420 B4). */
  readonly readLiveDelegation?: typeof readLiveDelegation;
}

function writeFd2(text: string): void {
  try {
    writeSync(2, text);
  } catch {
    // stderr closed: phase lines are diagnostics only.
  }
}

export function run(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
  seams: RunSeams = {},
): number {
  // #6295: PR-context check; skipped on the merge queue's group commit.
  const skip = mergeGroupSkip("verify:scope-provenance", env);
  if (skip !== null) {
    process.stdout.write(`${skip}\n`);
    return 0;
  }
  const args = parseArgs(argv);
  if (args.error !== undefined) {
    process.stderr.write(`verify_scope_provenance: ${args.error}\n`);
    return 2;
  }
  const projectRoot = resolve(args.projectRoot);
  const forgeApproval = resolveForgeContext(args, env);
  const writeStderrSync = seams.writeStderrSync ?? writeFd2;
  const result = scopeProvenance.evaluateScopeProvenance(projectRoot, {
    ...(args.baseRef.length > 0 ? { baseRef: args.baseRef } : {}),
    enforce: args.enforce,
    ...(forgeApproval !== null ? { forgeApproval } : {}),
    // #7420 B4: the fence is the one reader that admits a delegated stamp, and only
    // while the delegation that minted it is live.
    delegation: (seams.readLiveDelegation ?? readLiveDelegation)(projectRoot),
    gitTimeoutSeconds: scopeProvenance.resolveGitTimeoutSeconds(args.gitTimeoutSeconds, env),
    ...(seams.gitTimeoutMode !== undefined ? { gitTimeoutMode: seams.gitTimeoutMode } : {}),
    ...(seams.gitSpawn !== undefined ? { gitSpawn: seams.gitSpawn } : {}),
    gitTimeoutRemedy: (larger: number) => formatGitTimeoutRemedy(argv, larger),
    onGitTimeoutWarning: (line: string) => writeStderrSync(`${line}\n`),
    // Phase lines go out with a synchronous write before each phase starts (#6378 item 7).
    ...(args.quiet
      ? {}
      : { onPhase: (phase: string) => writeStderrSync(`${PHASE_LINE_PREFIX}${phase}\n`) }),
  });
  if (args.enforcePresent) {
    process.stderr.write(`${ENFORCE_NOOP_NOTICE}\n`);
  }
  reportMintLevelAdmits(result.mintLevelAdmits ?? [], env);
  if (result.exitCode === 0) {
    if (!args.quiet) {
      process.stdout.write(`${result.message}\n`);
    }
    reportExtraPaths(result.extraPathReport ?? [], env);
  } else {
    process.stderr.write(`${result.message}\n`);
  }
  return result.exitCode;
}

if (isDirectEntrypoint(import.meta.url)) {
  process.exit(run(process.argv.slice(2)));
}
