#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { cmdPrMergeReadiness } from "../../core/dist/pr-merge-readiness/main.js";

export function run(argv: string[]): number {
  return cmdPrMergeReadiness(argv);
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(run(process.argv.slice(2)));
}
