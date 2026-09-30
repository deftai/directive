#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { peekRepoFlag } from "../scm/argv.js";
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
    residual?: boolean;
    vbriefDir?: string;
    repo?: string;
    projectRoot?: string;
  } = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (arg === "--all") out.all = true;
    else if (arg === "--dry-run") out.dryRun = true;
    else if (arg === "--residual" || arg === "--re-scope") out.residual = true;
    else if (arg === "--label") out.label = argv[++i];
    else if (arg === "--status") out.status = argv[++i] as IngestStatus;
    else if (arg === "--vbrief-dir") out.vbriefDir = argv[++i];
    else if (arg === "--repo") out.repo = argv[++i];
    else if (arg.startsWith("--repo=")) out.repo = arg.slice("--repo=".length);
    else if (arg === "-R") out.repo = argv[++i];
    else if (arg.startsWith("-R=") && arg.length > 3) out.repo = arg.slice(3);
    else if (arg === "--project-root") out.projectRoot = argv[++i];
    else if (/^\d+$/.test(arg)) out.number = Number.parseInt(arg, 10);
  }
  if (out.repo === undefined) {
    out.repo = peekRepoFlag(argv);
  }
  return out;
}

export function mainEntry(argv: string[] = process.argv.slice(2)): number {
  const parsed = parseArgs(argv);
  // #2275 / #3858 / #3663: credential-class ban; parse --repo / -R before the gate.
  // Registered workers resolve assignment inside requireScmReady first.
  try {
    requireScmReady({
      depth: "deep",
      repo: parsed.repo,
      expectedPrincipal: null,
    });
  } catch (err: unknown) {
    if (err instanceof ScmStubError) {
      process.stderr.write(`error: ${err.message}\n`);
      return 2;
    }
    throw err;
  }
  return issueIngestMain(parsed);
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(mainEntry());
}
