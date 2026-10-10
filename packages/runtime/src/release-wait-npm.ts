#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { cmdReleaseWaitNpm } from "@deftai/directive-core/dist/release/cli-drift-report.js";

export function run(argv: string[]): number {
  return cmdReleaseWaitNpm(argv);
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(run(process.argv.slice(2)));
}
