#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { cmdRollback } from "../../core/dist/release-rollback/main.js";

export function run(argv: string[]): number {
  return cmdRollback(argv);
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(run(process.argv.slice(2)));
}
