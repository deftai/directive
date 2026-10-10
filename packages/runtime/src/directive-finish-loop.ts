#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { cmdDirectiveFinishLoop } from "@deftai/directive-core/dist/finish-loop/main.js";

export function run(argv: string[]): number {
  return cmdDirectiveFinishLoop(argv);
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(run(process.argv.slice(2)));
}
