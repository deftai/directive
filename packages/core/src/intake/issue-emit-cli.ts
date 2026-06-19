#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { issueEmitMain } from "./issue-emit.js";

function parseArgs(argv: string[]) {
  const patterns: string[] = [];
  const out: {
    patterns: string[];
    umbrella?: boolean;
    perVbrief?: boolean;
    title?: string;
    dryRun?: boolean;
    json?: boolean;
    repo?: string;
    projectRoot?: string;
  } = { patterns };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (arg === "--umbrella") out.umbrella = true;
    else if (arg === "--per-vbrief") out.perVbrief = true;
    else if (arg === "--dry-run") out.dryRun = true;
    else if (arg === "--json") out.json = true;
    else if (arg === "--title") out.title = argv[++i];
    else if (arg === "--repo") out.repo = argv[++i];
    else if (arg === "--project-root") out.projectRoot = argv[++i];
    else if (!arg.startsWith("-")) patterns.push(arg);
  }
  return out;
}

export function mainEntry(argv: string[] = process.argv.slice(2)): number {
  return issueEmitMain(parseArgs(argv));
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(mainEntry());
}
