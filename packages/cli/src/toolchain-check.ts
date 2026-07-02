#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { type CommandRunner, runToolchainCheck } from "@deftai/directive-core/verify-env";

export interface ToolchainCheckRunOptions {
  readonly runner?: CommandRunner;
}

export function run(
  argv: readonly string[] = process.argv.slice(2),
  options: ToolchainCheckRunOptions = {},
): number {
  const consumer = argv.includes("--consumer");
  const result = runToolchainCheck(options.runner, { consumer });
  for (const line of result.lines) {
    process.stdout.write(`${line}\n`);
  }
  return result.exitCode;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(run());
}
