#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateScmBoundary } from "@deftai/directive-core/verify-source";

interface ParsedArgs {
  projectRoot: string;
  allowList: string | null;
  quiet: boolean;
  error?: string;
}

/** Parse verify-scm-boundary CLI args, mirroring scripts/verify_scm_boundary.py. */
export function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = { projectRoot: ".", allowList: null, quiet: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--quiet") {
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

/** Run the gate and return the process exit code. */
export function run(argv: string[]): number {
  const args = parseArgs(argv);
  if (args.error !== undefined) {
    process.stderr.write(`verify_scm_boundary: ${args.error}\n`);
    return 2;
  }
  const projectRoot = resolve(args.projectRoot);
  const result = evaluateScmBoundary(projectRoot, {
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
