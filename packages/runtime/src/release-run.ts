#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { cmdReleaseRun } from "@deftai/directive-core/dist/release/run.js";

export function run(argv: string[]): number {
  return cmdReleaseRun(argv);
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(run(process.argv.slice(2)));
}
