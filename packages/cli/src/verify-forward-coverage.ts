#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateForwardCoverage, type ForwardCoverageMode } from "@deftai/directive-core";

interface ParsedArgs {
  mode: ForwardCoverageMode;
  projectRoot: string;
  allowList: string | null;
  quiet: boolean;
  error?: string;
}

/** Parse the verify-forward-coverage CLI args, mirroring the verify-encoding surface. */
export function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    mode: "head",
    projectRoot: ".",
    allowList: null,
    quiet: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--staged") {
      parsed.mode = "staged";
    } else if (arg === "--head") {
      parsed.mode = "head";
    } else if (arg === "--quiet") {
      parsed.quiet = true;
    } else if (arg === "--project-root") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...parsed, error: "argument --project-root: expected one argument" };
      }
      parsed.projectRoot = value;
      i += 1;
    } else if (arg?.startsWith("--project-root=")) {
      parsed.projectRoot = arg.slice("--project-root=".length);
    } else if (arg === "--allow-list") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...parsed, error: "argument --allow-list: expected one argument" };
      }
      parsed.allowList = value;
      i += 1;
    } else if (arg?.startsWith("--allow-list=")) {
      parsed.allowList = arg.slice("--allow-list=".length);
    } else {
      return { ...parsed, error: `unrecognized argument: ${arg}` };
    }
  }
  return parsed;
}

/** Run the gate and return the process exit code (argv parse error -> 2). */
export function run(argv: string[]): number {
  const args = parseArgs(argv);
  if (args.error !== undefined) {
    process.stderr.write(`verify_forward_coverage: ${args.error}\n`);
    return 2;
  }
  const projectRoot = resolve(args.projectRoot);
  const allowListPath = args.allowList !== null ? resolve(args.allowList) : null;
  const result = evaluateForwardCoverage(projectRoot, { mode: args.mode, allowListPath });
  if (result.exitCode === 0) {
    if (!args.quiet) {
      process.stdout.write(`${result.message}\n`);
    }
  } else {
    process.stderr.write(`${result.message}\n`);
  }
  return result.exitCode;
}

// Only execute when invoked directly as a binary (not when imported in tests).
// Normalize both sides via fileURLToPath so the guard fires on Windows too.
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(run(process.argv.slice(2)));
}
