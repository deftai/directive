#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { lifecycleMain } from "./main.js";

/** Direct entry for tests and `node packages/core/dist/scope/cli.js`. */
export function mainEntry(argv: string[] = process.argv.slice(2)): number {
  return lifecycleMain(argv);
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(mainEntry());
}
