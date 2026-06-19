#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { run } from "@deftai/core/vbrief-activate";

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(run(process.argv.slice(2)));
}
