#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { runSpecReconstructCli } from "@deftai/directive-core/spec-reconstruct";

export function runSpecReconstructCliEntry(argv: string[]): number {
  const result = runSpecReconstructCli(argv);
  if (result.stdout.length > 0) process.stdout.write(result.stdout);
  if (result.stderr.length > 0) process.stderr.write(result.stderr);
  return result.exitCode;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(runSpecReconstructCliEntry(process.argv.slice(2)));
}
