#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { cmdDoctor } from "../../core/dist/doctor/main.js";

export function run(argv: string[]): number {
  return cmdDoctor(argv);
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(run(process.argv.slice(2)));
}
