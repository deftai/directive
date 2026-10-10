#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateGoFreeze, FREEZE_BYPASS_ENV } from "@deftai/directive-core/legacy-bridge";

interface ParsedArgs {
  projectRoot: string | null;
  error?: string;
}

/** Parse verify-go-freeze CLI args (#1912). */
export function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = { projectRoot: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--project-root") {
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

/** Run the freeze gate and return the process exit code (three-state). */
export function run(argv: string[]): number {
  const args = parseArgs(argv);
  if (args.error !== undefined) {
    process.stderr.write(`verify_go_freeze: ${args.error}\n`);
    return 2;
  }
  const root = resolve(args.projectRoot ?? ".");
  const allowBump = process.env[FREEZE_BYPASS_ENV] === "1";
  const result = evaluateGoFreeze(root, { allowBump });
  if (result.stream === "stdout") {
    process.stdout.write(`${result.message}\n`);
  } else {
    process.stderr.write(`${result.message}\n`);
  }
  return result.code;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(run(process.argv.slice(2)));
}
