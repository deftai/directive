#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { runToolchainCheck } from "@deftai/directive-core/verify-env";

export function run(argv: readonly string[] = process.argv.slice(2)): number {
  const consumer = argv.includes("--consumer");
  const result = runToolchainCheck(undefined, { consumer });
  for (const line of result.lines) {
    process.stdout.write(`${line}\n`);
  }
  return result.exitCode;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(run());
}
