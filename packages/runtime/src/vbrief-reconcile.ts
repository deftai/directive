#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { cmdVbriefReconcile } from "@deftai/directive-core/vbrief-reconcile";

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(cmdVbriefReconcile(process.argv.slice(2)));
}
