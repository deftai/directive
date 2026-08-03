import { parseProtected } from "../pr-protected-issues/parse.js";
import { waitMergeableAndMerge } from "./cascade.js";
import { EXIT_CONFIG_ERROR, EXIT_MERGED, EXIT_TIMEOUT_OR_ESCALATION } from "./constants.js";
import { toResultDict } from "./result.js";

/** Match Python json.dumps(..., indent=2) default ensure_ascii=True. */
function pythonJsonDumps(value: unknown): string {
  const json = JSON.stringify(value, null, 2);
  return json.replace(/[\u007f-\uffff]/g, (ch) => {
    const code = ch.charCodeAt(0);
    return `\\u${code.toString(16).padStart(4, "0")}`;
  });
}

export interface ParsedWaitMergeableArgs {
  readonly prNumber: number | null;
  readonly repo: string | null;
  readonly capMinutes: number;
  readonly protectedValues: readonly string[];
  readonly emitJson: boolean;
  readonly cascadeMode: boolean;
  readonly requireMasterCiGreen: boolean;
  readonly baseBranch: string | null;
  /** Project root for minGreptileConfidence (#3095 / #3102). Null = cwd at run. */
  readonly projectRoot: string | null;
  readonly error?: string;
}

export function parseWaitMergeableArgs(argv: readonly string[]): ParsedWaitMergeableArgs {
  let prNumber: number | null = null;
  let repo: string | null = null;
  let capMinutes = 60;
  const protectedValues: string[] = [];
  let emitJson = false;
  let cascadeMode = false;
  let requireMasterCiGreen = false;
  let baseBranch: string | null = null;
  let projectRoot: string | null = null;

  const baseReturn = (): Omit<ParsedWaitMergeableArgs, "error"> => ({
    prNumber,
    repo,
    capMinutes,
    protectedValues,
    emitJson,
    cascadeMode,
    requireMasterCiGreen,
    baseBranch,
    projectRoot,
  });

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") {
      emitJson = true;
    } else if (arg === "--cascade") {
      cascadeMode = true;
    } else if (arg === "--require-master-ci-green") {
      requireMasterCiGreen = true;
    } else if (arg === "--base-branch") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...baseReturn(), error: "argument --base-branch: expected one argument" };
      }
      baseBranch = value;
      i += 1;
    } else if (arg?.startsWith("--base-branch=")) {
      baseBranch = arg.slice("--base-branch=".length);
    } else if (arg === "--project-root") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...baseReturn(), error: "argument --project-root: expected one argument" };
      }
      projectRoot = value;
      i += 1;
    } else if (arg?.startsWith("--project-root=")) {
      projectRoot = arg.slice("--project-root=".length);
    } else if (arg === "--repo") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...baseReturn(), error: "argument --repo: expected one argument" };
      }
      repo = value;
      i += 1;
    } else if (arg?.startsWith("--repo=")) {
      repo = arg.slice("--repo=".length);
    } else if (arg === "--cap-minutes") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...baseReturn(), error: "argument --cap-minutes: expected one argument" };
      }
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) {
        return { ...baseReturn(), error: `invalid --cap-minutes value: ${value}` };
      }
      capMinutes = parsed;
      i += 1;
    } else if (arg?.startsWith("--cap-minutes=")) {
      const value = arg.slice("--cap-minutes=".length);
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) {
        return { ...baseReturn(), error: `invalid --cap-minutes value: ${value}` };
      }
      capMinutes = parsed;
    } else if (arg === "--protected") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...baseReturn(), error: "argument --protected: expected one argument" };
      }
      protectedValues.push(value);
      i += 1;
    } else if (arg?.startsWith("--protected=")) {
      protectedValues.push(arg.slice("--protected=".length));
    } else if (arg?.startsWith("-")) {
      return { ...baseReturn(), error: `unrecognized arguments: ${arg}` };
    } else if (prNumber === null) {
      const n = Number(arg);
      if (!Number.isInteger(n)) {
        return { ...baseReturn(), error: `invalid PR number: ${arg}` };
      }
      prNumber = n;
    } else {
      return { ...baseReturn(), error: `unrecognized arguments: ${arg}` };
    }
  }

  if (prNumber === null) {
    return { ...baseReturn(), error: "the following arguments are required: pr_number" };
  }

  return baseReturn();
}

function summaryLabelForExit(exitCode: number): string {
  switch (exitCode) {
    case EXIT_MERGED:
      return "MERGED";
    case EXIT_TIMEOUT_OR_ESCALATION:
      return "TIMEOUT-OR-ESCALATION";
    case EXIT_CONFIG_ERROR:
      return "CONFIG-ERROR";
    default:
      return "UNKNOWN";
  }
}

export interface RunWaitMergeableOptions {
  readonly protectedFn?: Parameters<typeof waitMergeableAndMerge>[2]["protectedFn"];
  readonly monitorFn?: Parameters<typeof waitMergeableAndMerge>[2]["monitorFn"];
  readonly mergeFn?: Parameters<typeof waitMergeableAndMerge>[2]["mergeFn"];
  readonly semanticGreenFn?: Parameters<typeof waitMergeableAndMerge>[2]["semanticGreenFn"];
}

export function runWaitMergeable(
  argv: readonly string[],
  options: RunWaitMergeableOptions = {},
): number {
  const args = parseWaitMergeableArgs(argv);
  if (args.error !== undefined) {
    process.stderr.write(`Error: ${args.error}\n`);
    return EXIT_CONFIG_ERROR;
  }

  const repo = args.repo ?? process.env.GH_REPO ?? null;
  if (repo === null || repo.length === 0) {
    process.stderr.write("Error: --repo OWNER/REPO is required (or set $GH_REPO).\n");
    return EXIT_CONFIG_ERROR;
  }

  let protectedIssues: number[];
  try {
    protectedIssues = parseProtected(args.protectedValues);
  } catch (exc: unknown) {
    const message = exc instanceof Error ? exc.message : String(exc);
    process.stderr.write(`Error: ${message}\n`);
    return EXIT_CONFIG_ERROR;
  }

  const result = waitMergeableAndMerge(args.prNumber as number, repo, {
    capMinutes: args.capMinutes,
    protected: protectedIssues,
    protectedFn: options.protectedFn,
    monitorFn: options.monitorFn,
    mergeFn: options.mergeFn,
    semanticGreenFn: options.semanticGreenFn,
    cascadeMode: args.cascadeMode,
    requireMasterCiGreen: args.requireMasterCiGreen,
    baseBranch: args.baseBranch,
    // Explicit CLI root (or cwd) so remote-target cascade does not resolve
    // minGreptileConfidence from an unrelated directory (#3102).
    projectRoot: args.projectRoot ?? process.cwd(),
  });

  const summaryLabel = summaryLabelForExit(result.exitCode);
  process.stderr.write(
    `[pr_wait_mergeable] PR #${result.prNumber} repo=${result.repo} ` +
      `result=${summaryLabel} outcome=${result.outcome}\n`,
  );

  if (args.emitJson) {
    process.stdout.write(`${pythonJsonDumps(toResultDict(result))}\n`);
  } else {
    const lines: string[] = [];
    lines.push(`PR #${result.prNumber} wait-mergeable-and-merge result: ${summaryLabel}`);
    lines.push(`  outcome: ${result.outcome}`);
    if (result.error !== null) {
      lines.push(`  error:   ${result.error}`);
    }
    if (result.mergeStdout.trim().length > 0) {
      lines.push("  merge stdout:");
      for (const line of result.mergeStdout.trim().split("\n")) {
        lines.push(`    ${line}`);
      }
    }
    process.stdout.write(`${lines.join("\n")}\n`);
  }

  return result.exitCode;
}

export function cmdPrWaitMergeable(
  argv: readonly string[],
  options: RunWaitMergeableOptions = {},
): number {
  return runWaitMergeable(argv, options);
}
