#!/usr/bin/env node
/** Thin CLI seam for vbrief-build parity scenarios (#1782 s1). */
import { fileURLToPath } from "node:url";
import { cmdVbriefBuild } from "@deftai/directive-core/vbrief-build";

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(cmdVbriefBuild(process.argv.slice(2)));
}
