#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { syncFromXbriefMain } from "./sync-from-xbrief.js";

function parseArgs(argv: readonly string[]) {
  const out: {
    path?: string;
    dryRun?: boolean;
    projectRoot?: string;
    repo?: string;
  } = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (arg === "--dry-run") {
      out.dryRun = true;
    } else if (arg === "--project-root") {
      out.projectRoot = argv[++i];
    } else if (arg === "--repo") {
      out.repo = argv[++i];
    } else if (!arg.startsWith("-")) {
      out.path = arg;
    }
  }
  return out;
}

export function mainEntry(argv: string[] = process.argv.slice(2)): number {
  return syncFromXbriefMain(parseArgs(argv));
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(mainEntry());
}
