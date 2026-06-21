#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateVerifyStubs } from "@deftai/core/verify-source";

interface ParsedArgs {
  projectRoot: string;
  error?: string;
}

/** Parse verify-stubs CLI args (mirrors scripts/verify-stubs.py -- no flags). */
export function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = { projectRoot: "." };
  for (const arg of argv) {
    return { ...parsed, error: `unrecognized argument: ${arg}` };
  }
  return parsed;
}

/** Run the gate and return the process exit code. */
export function run(argv: string[]): number {
  const args = parseArgs(argv);
  if (args.error !== undefined) {
    process.stderr.write(`verify-stubs: ${args.error}\n`);
    return 2;
  }
  const result = evaluateVerifyStubs(resolve(args.projectRoot));
  process.stdout.write(`${result.message}\n`);
  return result.code;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(run(process.argv.slice(2)));
}
