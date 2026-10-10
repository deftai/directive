#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { cmdReleasePublish } from "@deftai/directive-core/dist/release-publish/main.js";

export function run(argv: string[]): number {
  return cmdReleasePublish(argv);
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(run(process.argv.slice(2)));
}
