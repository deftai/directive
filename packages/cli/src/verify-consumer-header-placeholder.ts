#!/usr/bin/env node
/**
 * CLI for verify:consumer-header-placeholder (#4544 Prefer-A).
 *
 * Fail closed when product-mutation completion still leaves the unmanaged
 * AGENTS.md header on the exact scaffold edit-me placeholder. Process-only
 * and custom headers pass. Returned failure only.
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateConsumerHeaderPlaceholderAtRoot } from "@deftai/directive-core/check";

interface ParsedArgs {
  projectRoot: string;
  quiet: boolean;
  error?: string;
}

function takeProjectRootValue(
  argv: readonly string[],
  index: number,
): { readonly value?: string; readonly error?: string; readonly next: number } {
  const next = argv[index + 1];
  if (next === undefined || next.length === 0 || next.startsWith("-")) {
    return { error: "argument --project-root: expected one argument", next: index };
  }
  return { value: next, next: index + 1 };
}

/** Parse verify-consumer-header-placeholder CLI args. */
export function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    projectRoot: ".",
    quiet: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--quiet") {
      parsed.quiet = true;
    } else if (arg === "--project-root") {
      const taken = takeProjectRootValue(argv, i);
      if (taken.error !== undefined) {
        return { ...parsed, error: taken.error };
      }
      parsed.projectRoot = taken.value ?? parsed.projectRoot;
      i = taken.next;
    } else if (arg?.startsWith("--project-root=")) {
      const value = arg.slice("--project-root=".length);
      if (value.length === 0 || value.startsWith("-")) {
        return { ...parsed, error: "argument --project-root: expected one argument" };
      }
      parsed.projectRoot = value;
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
    process.stderr.write(`verify_consumer_header_placeholder: ${args.error}\n`);
    return 2;
  }
  const projectRoot = resolve(args.projectRoot);
  const result = evaluateConsumerHeaderPlaceholderAtRoot(projectRoot);
  if (result.message.length > 0 && !args.quiet) {
    if (result.ok) {
      process.stdout.write(`${result.message}\n`);
    } else {
      process.stderr.write(`${result.message}\n`);
    }
  }
  return result.ok ? 0 : 1;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(run(process.argv.slice(2)));
}
