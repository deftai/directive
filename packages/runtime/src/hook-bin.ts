#!/usr/bin/env node
import { isDirectEntrypoint } from "./entrypoint.js";
import { run } from "./hook-dispatch.js";

// Keep PreToolUse off the general CLI router's cold path.
export function main(argv: string[] = process.argv.slice(2)): number {
  return run(argv);
}

if (isDirectEntrypoint(import.meta.url)) {
  process.exit(main());
}
