#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { formatScanResult, scan } from "@deftai/directive-core/verify-env";

export function run(): number {
  const findings = scan();
  const result = formatScanResult(findings);
  if (result.stdout.length > 0) process.stdout.write(result.stdout);
  if (result.stderr.length > 0) process.stderr.write(result.stderr);
  return result.exitCode;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(run());
}
