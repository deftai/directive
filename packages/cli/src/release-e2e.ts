#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { cmdReleaseE2e } from "../../core/dist/release-e2e/main.js";

export function run(argv: string[]): number {
  return cmdReleaseE2e(argv);
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(run(process.argv.slice(2)));
}
