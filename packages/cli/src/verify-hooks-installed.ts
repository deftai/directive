#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluate } from "@deftai/directive-core/verify-env";

interface ParsedArgs {
  projectRoot: string;
  quiet: boolean;
  error?: string;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = { projectRoot: ".", quiet: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--quiet") parsed.quiet = true;
    else if (arg === "--project-root") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...parsed, error: "argument --project-root: expected one argument" };
      }
      parsed.projectRoot = value;
      i += 1;
    } else if (arg?.startsWith("--project-root=")) {
      parsed.projectRoot = arg.slice("--project-root=".length);
    } else {
      return { ...parsed, error: `unrecognized arguments: ${arg}` };
    }
  }
  return parsed;
}

export function run(argv: string[]): number {
  const args = parseArgs(argv);
  if (args.error !== undefined) {
    process.stderr.write(`${args.error}\n`);
    return 2;
  }
  const result = evaluate(resolve(args.projectRoot));
  if (!args.quiet) {
    if (result.stream === "stdout") {
      process.stdout.write(`${result.message}\n`);
    } else if (result.stream === "stderr") {
      process.stderr.write(`${result.message}\n`);
    }
  }
  return result.code;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(run(process.argv.slice(2)));
}
