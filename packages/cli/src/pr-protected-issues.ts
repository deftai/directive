#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { cmdPrProtectedIssues } from "@deftai/directive-core/dist/pr-protected-issues/main.js";

export function run(argv: string[]): number {
  return cmdPrProtectedIssues(argv);
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(run(process.argv.slice(2)));
}
