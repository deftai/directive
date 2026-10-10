#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluate } from "@deftai/directive-core/eval-triggers-relocation";

interface ParsedArgs {
  projectRoot: string;
  baseRef?: string;
  staged: boolean;
  quiet: boolean;
  error?: string;
}

/** Parse verify-eval-triggers-relocation CLI args. */
export function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    projectRoot: ".",
    staged: false,
    quiet: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--staged") {
      parsed.staged = true;
    } else if (arg === "--quiet") {
      parsed.quiet = true;
    } else if (arg === "--base-ref") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...parsed, error: "argument --base-ref: expected one argument" };
      }
      parsed.baseRef = value;
      i += 1;
    } else if (arg?.startsWith("--base-ref=")) {
      parsed.baseRef = arg.slice("--base-ref=".length);
    } else if (arg === "--project-root") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...parsed, error: "argument --project-root: expected one argument" };
      }
      parsed.projectRoot = value;
      i += 1;
    } else if (arg?.startsWith("--project-root=")) {
      parsed.projectRoot = arg.slice("--project-root=".length);
    } else {
      return { ...parsed, error: `unrecognized argument: ${arg}` };
    }
  }
  return parsed;
}

/** Run verify:eval-triggers-relocation and return exit code. */
export function run(argv: string[]): number {
  const args = parseArgs(argv);
  if (args.error !== undefined) {
    process.stderr.write(`verify:eval-triggers-relocation: ${args.error}\n`);
    return 2;
  }

  const result = evaluate({
    projectRoot: resolve(args.projectRoot),
    baseRef: args.baseRef,
    staged: args.staged,
    quiet: args.quiet,
  });

  if (result.message.length > 0) {
    if (result.stream === "stderr") {
      process.stderr.write(`${result.message}\n`);
    } else if (result.stream === "stdout") {
      process.stdout.write(`${result.message}\n`);
    }
  }

  return result.code;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(run(process.argv.slice(2)));
}
