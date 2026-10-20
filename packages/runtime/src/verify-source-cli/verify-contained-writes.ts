#!/usr/bin/env node
/**
 * CLI for task verify:contained-writes (#2951 Phase 1).
 * Fail-open by default; pass --enforce for fail-closed (later phases).
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateContainedWrites } from "@deftai/directive-core/verify-source";

interface ParsedArgs {
  projectRoot: string;
  enforce: boolean;
  help?: boolean;
  error?: string;
}

/** Parse verify-contained-writes CLI args (#2951). */
export function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = { projectRoot: ".", enforce: false };
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
    } else if (arg === "--enforce") {
      parsed.enforce = true;
    } else if (arg === "--help" || arg === "-h") {
      return { ...parsed, help: true };
    } else {
      return { ...parsed, error: `unrecognized argument: ${arg}` };
    }
  }
  return parsed;
}

const HELP_TEXT =
  "Usage: verify-contained-writes [--project-root <path>] [--enforce]\n" +
  "  Inventory raw write sinks outside the allowlist (#2951).\n" +
  "  Default: fail-open (exit 0 with advisory report).\n" +
  "  --enforce: fail closed (exit 1) when non-allowlisted sinks remain.\n";

/** Run the gate and return the process exit code. */
export function run(argv: string[]): number {
  const args = parseArgs(argv);
  if (args.help === true) {
    process.stdout.write(HELP_TEXT);
    return 0;
  }
  if (args.error !== undefined) {
    process.stderr.write(`verify_contained_writes: ${args.error}\n`);
    return 2;
  }
  const result = evaluateContainedWrites({
    projectRoot: resolve(args.projectRoot),
    enforce: args.enforce,
  });
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
