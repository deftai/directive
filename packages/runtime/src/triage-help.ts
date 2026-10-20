#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { runHelp } from "@deftai/directive-core/dist/triage/help/index.js";

export function run(argv: string[]): number {
  return runHelp(argv);
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(run(process.argv.slice(2)));
}
