#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { type IngestStatus, issueIngestMain } from "./issue-ingest.js";

function parseArgs(argv: string[]) {
  const out: {
    number?: number;
    all?: boolean;
    label?: string;
    status?: IngestStatus;
    dryRun?: boolean;
    vbriefDir?: string;
    repo?: string;
    projectRoot?: string;
  } = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (arg === "--all") out.all = true;
    else if (arg === "--dry-run") out.dryRun = true;
    else if (arg === "--label") out.label = argv[++i];
    else if (arg === "--status") out.status = argv[++i] as IngestStatus;
    else if (arg === "--vbrief-dir") out.vbriefDir = argv[++i];
    else if (arg === "--repo") out.repo = argv[++i];
    else if (arg === "--project-root") out.projectRoot = argv[++i];
    else if (/^\d+$/.test(arg)) out.number = Number.parseInt(arg, 10);
  }
  return out;
}

export function mainEntry(argv: string[] = process.argv.slice(2)): number {
  return issueIngestMain(parseArgs(argv));
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(mainEntry());
}
