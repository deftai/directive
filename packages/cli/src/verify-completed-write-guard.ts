#!/usr/bin/env node
/**
 * CLI for verify:completed-write-guard (#3679).
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateCompletedWriteGuard } from "@deftai/directive-core/lifecycle";

interface ParsedArgs {
  projectRoot: string;
  baseRef: string;
  quiet: boolean;
  error?: string;
}

/** Parse verify-completed-write-guard CLI args (#3679). */
export function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    projectRoot: ".",
    baseRef: "",
    quiet: false,
  };
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
    } else if (arg === "--base-ref") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...parsed, error: "argument --base-ref: expected one argument" };
      }
      parsed.baseRef = value;
      i += 1;
    } else if (arg?.startsWith("--base-ref=")) {
      parsed.baseRef = arg.slice("--base-ref=".length);
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
    process.stderr.write(`verify_completed_write_guard: ${args.error}\n`);
    return 2;
  }
  const projectRoot = resolve(args.projectRoot);
  const result = evaluateCompletedWriteGuard(projectRoot, {
    ...(args.baseRef.length > 0 ? { baseRef: args.baseRef } : {}),
  });
  if (result.message.length > 0 && !args.quiet) {
    if (result.code === 0) {
      process.stdout.write(`${result.message}\n`);
    } else {
      process.stderr.write(`${result.message}\n`);
    }
  }
  return result.code;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(run(process.argv.slice(2)));
}
