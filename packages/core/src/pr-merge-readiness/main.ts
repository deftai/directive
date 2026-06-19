import { computeGateResult } from "./compute.js";
import { defaultRunGh } from "./gh.js";
import { emitJson, exitCodeFor, printHuman } from "./output.js";
import type { RunGhFn } from "./types.js";

export interface ParsedArgs {
  readonly prNumber: number | null;
  readonly repo: string | null;
  readonly emitJson: boolean;
  readonly error?: string;
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  let prNumber: number | null = null;
  let repo: string | null = null;
  let json = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") {
      json = true;
    } else if (arg === "--repo") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { prNumber, repo, emitJson: json, error: "argument --repo: expected one argument" };
      }
      repo = value;
      i += 1;
    } else if (arg?.startsWith("--repo=")) {
      repo = arg.slice("--repo=".length);
    } else if (arg?.startsWith("-")) {
      return { prNumber, repo, emitJson: json, error: `unrecognized arguments: ${arg}` };
    } else if (prNumber === null) {
      const n = Number(arg);
      if (!Number.isInteger(n) || n <= 0) {
        return { prNumber, repo, emitJson: json, error: `invalid PR number: ${arg}` };
      }
      prNumber = n;
    } else {
      return { prNumber, repo, emitJson: json, error: `unrecognized arguments: ${arg}` };
    }
  }

  if (prNumber === null) {
    return {
      prNumber,
      repo,
      emitJson: json,
      error: "the following arguments are required: pr_number",
    };
  }
  return { prNumber, repo, emitJson: json };
}

export interface RunOptions {
  readonly runGh?: RunGhFn;
}

export function run(argv: readonly string[], options: RunOptions = {}): number {
  const args = parseArgs(argv);
  if (args.error !== undefined) {
    process.stderr.write(`pr_merge_readiness: ${args.error}\n`);
    return 2;
  }

  const runGh = options.runGh ?? defaultRunGh;
  const result = computeGateResult(args.prNumber as number, args.repo, runGh);

  if (args.emitJson) {
    process.stdout.write(emitJson(result));
  } else {
    process.stdout.write(printHuman(result));
  }
  return exitCodeFor(result);
}

export function cmdPrMergeReadiness(argv: readonly string[], options: RunOptions = {}): number {
  return run(argv, options);
}
