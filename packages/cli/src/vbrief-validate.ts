#!/usr/bin/env node
/** Thin CLI seam for vbrief:validate + verify:vbrief-conformance (#1782 s3). */
import { fileURLToPath } from "node:url";
import { cmdVbriefValidate } from "@deftai/core/vbrief-validate";

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(cmdVbriefValidate(process.argv.slice(2)));
}
