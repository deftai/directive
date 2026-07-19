#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { syncFromXbriefMain } from "./sync-from-xbrief.js";

export interface ParsedSyncFromXbriefCliArgs {
  path?: string;
  dryRun?: boolean;
  projectRoot?: string;
  repo?: string;
  allowCrossRepo?: boolean;
  error?: string;
}

export function parseArgs(argv: readonly string[]): ParsedSyncFromXbriefCliArgs {
  const out: ParsedSyncFromXbriefCliArgs = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (arg === "--dry-run") {
      out.dryRun = true;
    } else if (arg === "--allow-cross-repo") {
      out.allowCrossRepo = true;
    } else if (arg === "--project-root") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...out, error: "argument --project-root: expected one argument" };
      }
      out.projectRoot = value;
      i += 1;
    } else if (arg === "--repo") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...out, error: "argument --repo: expected one argument" };
      }
      out.repo = value;
      i += 1;
    } else if (!arg.startsWith("-")) {
      out.path = arg;
    }
  }
  return out;
}

export function mainEntry(argv: string[] = process.argv.slice(2)): number {
  const args = parseArgs(argv);
  if (args.error !== undefined) {
    process.stderr.write(`issue:sync-from-xbrief: ${args.error}\n`);
    return 2;
  }
  return syncFromXbriefMain(args);
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(mainEntry());
}
