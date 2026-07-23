#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { run } from "./hook-dispatch.js";

// Keep PreToolUse off the general CLI router's cold path.
export function main(argv: string[] = process.argv.slice(2)): number {
  return run(argv);
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(main());
}
