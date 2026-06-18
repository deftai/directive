#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluate, type ScanMode } from "@deftai/core";

interface ParsedArgs {
  mode: ScanMode;
  projectRoot: string;
  allowList: string | null;
  quiet: boolean;
  error?: string;
}

/** Parse the verify-encoding CLI args, mirroring the Python argparse surface. */
export function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    mode: "all",
    projectRoot: ".",
    allowList: null,
    quiet: false,
  };
  let sawAll = false;
  let sawStaged = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--all") {
      sawAll = true;
      parsed.mode = "all";
    } else if (arg === "--staged") {
      sawStaged = true;
      parsed.mode = "staged";
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
  if (sawAll && sawStaged) {
    return { ...parsed, error: "argument --staged: not allowed with argument --all" };
  }
  return parsed;
}

/** Run the gate and return the process exit code (no side effects on argv parse error -> 2). */
export function run(argv: string[]): number {
  const args = parseArgs(argv);
  if (args.error !== undefined) {
    process.stderr.write(`verify_encoding: ${args.error}\n`);
    return 2;
  }
  const projectRoot = resolve(args.projectRoot);
  const allowListPath = args.allowList !== null ? resolve(args.allowList) : null;
  const result = evaluate(projectRoot, { mode: args.mode, allowListPath });
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
// Normalize both sides via fileURLToPath so the guard fires on Windows too,
// where process.argv[1] is a native backslash path and import.meta.url is a
// forward-slash file:// URL -- a raw `file://${process.argv[1]}` never matches.
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(run(process.argv.slice(2)));
}
