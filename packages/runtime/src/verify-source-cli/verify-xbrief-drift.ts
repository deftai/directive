#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type DriftScanMode, evaluateXbriefDrift } from "@deftai/directive-core/xbrief-migrate";

interface ParsedArgs {
  mode: DriftScanMode;
  projectRoot: string;
  allowList: string | null;
  quiet: boolean;
  error?: string;
}

/** Parse verify-xbrief-drift CLI args (#2109), mirroring the verify-encoding surface. */
export function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = { mode: "all", projectRoot: ".", allowList: null, quiet: false };
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

/** Run the gate and return the process exit code. */
export function run(argv: string[]): number {
  const args = parseArgs(argv);
  if (args.error !== undefined) {
    process.stderr.write(`verify_xbrief_drift: ${args.error}\n`);
    return 2;
  }
  const projectRoot = resolve(args.projectRoot);
  const result = evaluateXbriefDrift(projectRoot, {
    mode: args.mode,
    allowListPath: args.allowList !== null ? resolve(args.allowList) : null,
    quiet: args.quiet,
  });
  if (result.code === 0) {
    if (!args.quiet && result.message.length > 0) {
      process.stdout.write(`${result.message}\n`);
    }
  } else {
    process.stderr.write(`${result.message}\n`);
  }
  return result.code;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(run(process.argv.slice(2)));
}
