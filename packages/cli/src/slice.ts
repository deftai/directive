#!/usr/bin/env node
/**
 * Thin CLI entry for slice:record-existing / slice:list (#1727).
 * Delegates to the core implementation at packages/core/dist/slice/cli.js.
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function coreCliPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "../../core/dist/slice/cli.js");
}

/** Run slice verbs with argv; returns process exit code. */
export function run(argv: string[]): number {
  const result = spawnSync(process.execPath, [coreCliPath(), ...argv], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (typeof result.stdout === "string" && result.stdout.length > 0) {
    process.stdout.write(result.stdout);
  }
  if (typeof result.stderr === "string" && result.stderr.length > 0) {
    process.stderr.write(result.stderr);
  }
  return result.status ?? 2;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(run(process.argv.slice(2)));
}
