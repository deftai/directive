#!/usr/bin/env node
/**
 * check.ts -- CLI wrapper for the context-aware `task check` orchestrator (#1854).
 *
 * Usage: deft-ts check --framework-root <path> --project-root <path>
 *
 * Thin shim: parses args and delegates to dispatchTaskCheck in @deftai/directive-core/check.
 */
import { fileURLToPath } from "node:url";
import { dispatchTaskCheck } from "@deftai/directive-core/check";

interface ParsedArgs {
  frameworkRoot?: string;
  projectRoot?: string;
  error?: string;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    if (arg === "--framework-root") {
      const next = argv[i + 1];
      if (next === undefined) {
        return { ...parsed, error: "argument --framework-root: expected one argument" };
      }
      parsed.frameworkRoot = next;
      i++;
    } else if (arg.startsWith("--framework-root=")) {
      parsed.frameworkRoot = arg.slice("--framework-root=".length);
    } else if (arg === "--project-root") {
      const next = argv[i + 1];
      if (next === undefined) {
        return { ...parsed, error: "argument --project-root: expected one argument" };
      }
      parsed.projectRoot = next;
      i++;
    } else if (arg.startsWith("--project-root=")) {
      parsed.projectRoot = arg.slice("--project-root=".length);
    } else {
      return { ...parsed, error: `unrecognized argument: ${arg}` };
    }
  }
  return parsed;
}

export function run(argv: string[]): number {
  const args = parseArgs(argv);
  if (args.error !== undefined) {
    process.stderr.write(`check: ${args.error}\n`);
    return 2;
  }
  if (args.frameworkRoot === undefined || args.projectRoot === undefined) {
    process.stderr.write("check: --framework-root and --project-root are required\n");
    return 2;
  }
  return dispatchTaskCheck(args.frameworkRoot, args.projectRoot);
}

/* v8 ignore start -- entry guard */
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(run(process.argv.slice(2)));
}
/* v8 ignore stop */
