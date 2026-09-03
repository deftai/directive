#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { runSpecPrdFreshCli } from "@deftai/directive-core/verify-source";

export function run(argv: string[]): number {
  const result = runSpecPrdFreshCli(argv);
  if (result.stdout.length > 0) process.stdout.write(result.stdout);
  if (result.stderr.length > 0) process.stderr.write(result.stderr);
  return result.exitCode;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(run(process.argv.slice(2)));
}
