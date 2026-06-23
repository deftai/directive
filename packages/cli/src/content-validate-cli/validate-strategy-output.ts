#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateStrategyOutput } from "@deftai/directive-core/validate-content";

interface ParsedArgs {
  projectRoot: string;
  strict: boolean;
  quiet: boolean;
  error?: string;
}

/** Parse validate-strategy-output CLI args, mirroring scripts/validate_strategy_output.py. */
export function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = { projectRoot: ".", strict: false, quiet: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--strict") {
      parsed.strict = true;
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
    process.stderr.write(`validate_strategy_output: ${args.error}\n`);
    return 2;
  }
  const result = validateStrategyOutput.evaluate({
    projectRoot: resolve(args.projectRoot),
    strict: args.strict,
    quiet: args.quiet,
  });
  if (result.stream === "stdout" && result.message.length > 0) {
    process.stdout.write(`${result.message}\n`);
  } else if (result.stream === "stderr" && result.message.length > 0) {
    process.stderr.write(`${result.message}\n`);
  }
  return result.code;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(run(process.argv.slice(2)));
}
