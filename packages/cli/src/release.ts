#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { cmdRelease } from "../../core/dist/release/main.js";

export function run(argv: string[]): number {
  return cmdRelease(argv);
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(run(process.argv.slice(2)));
}
