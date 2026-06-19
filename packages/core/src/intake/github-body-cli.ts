#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { type GitHubBodyCliArgs, githubBodyMain } from "./github-body.js";

function parseArgs(argv: string[]): GitHubBodyCliArgs {
  const out: GitHubBodyCliArgs = { command: argv[0] ?? "" };
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (arg === "--repo") out.repo = argv[++i];
    else if (arg === "--title") out.title = argv[++i];
    else if (arg === "--issue") out.issue = Number.parseInt(argv[++i] as string, 10);
    else if (arg === "--comment") out.comment = Number.parseInt(argv[++i] as string, 10);
    else if (arg === "--pr") out.pr = Number.parseInt(argv[++i] as string, 10);
    else if (arg === "--body-file") out.bodyFile = argv[++i];
  }
  return out;
}

export function mainEntry(argv: string[] = process.argv.slice(2)): number {
  const parsed = parseArgs(argv);
  return githubBodyMain(parsed);
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(mainEntry());
}
