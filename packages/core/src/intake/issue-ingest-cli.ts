#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { ScmStubError } from "../scm/errors.js";
import { requireScmReady } from "../scm/readiness.js";
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
  // #2275: fail loud when gh/auth is missing in this execution env.
  try {
    requireScmReady();
  } catch (err: unknown) {
    if (err instanceof ScmStubError) {
      process.stderr.write(`error: ${err.message}\n`);
      return 2;
    }
    throw err;
  }
  return issueIngestMain(parseArgs(argv));
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(mainEntry());
}
