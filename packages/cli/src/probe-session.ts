#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { cmdProbeSession } from "@deftai/core/orchestration";

export function run(argv: string[]): number {
  return cmdProbeSession(argv);
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(run(process.argv.slice(2)));
}
