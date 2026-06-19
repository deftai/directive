#!/usr/bin/env node
/** Thin CLI seam for vbrief-validation parity scenarios (#1782 s2). */
import { fileURLToPath } from "node:url";
import { cmdVbriefValidation } from "@deftai/core/vbrief-validation";

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(cmdVbriefValidation(process.argv.slice(2)));
}
