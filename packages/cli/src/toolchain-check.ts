#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { runToolchainCheck } from "@deftai/core/verify-env";

export function run(): number {
  const result = runToolchainCheck();
  for (const line of result.lines) {
    process.stdout.write(`${line}\n`);
  }
  return result.exitCode;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(run());
}
