#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { ScmStubError } from "../scm/errors.js";
import { requireScmReady } from "../scm/readiness.js";
import { reconcileMain } from "./reconcile-issues.js";

function parseArgs(argv: string[]) {
  const out: {
    vbriefDir?: string;
    repo?: string;
    projectRoot?: string;
    format?: "json" | "markdown";
    applyLifecycleFixes?: boolean;
    reportUnlinked?: boolean;
    maxOpenIssues?: number;
  } = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (arg === "--apply-lifecycle-fixes") out.applyLifecycleFixes = true;
    else if (arg === "--report-unlinked") out.reportUnlinked = true;
    else if (arg === "--vbrief-dir") out.vbriefDir = argv[++i];
    else if (arg === "--repo") out.repo = argv[++i];
    else if (arg === "--project-root") out.projectRoot = argv[++i];
    else if (arg === "--format") out.format = argv[++i] as "json" | "markdown";
    else if (arg === "--max-open-issues")
      out.maxOpenIssues = Number.parseInt(argv[++i] as string, 10);
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
  return reconcileMain(parseArgs(argv));
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(mainEntry());
}
