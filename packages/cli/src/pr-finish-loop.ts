#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { cmdPrFinishLoop } from "@deftai/directive-core/dist/finish-loop/main.js";

export function run(argv: string[]): number {
  return cmdPrFinishLoop(argv);
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(run(process.argv.slice(2)));
}
