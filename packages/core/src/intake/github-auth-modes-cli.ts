#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { githubAuthModesMain } from "./github-auth-modes.js";

function parseArgs(argv: string[]) {
  const out: { githubAuthMode?: string; repo?: string; json?: boolean } = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (arg === "--json") out.json = true;
    else if (arg === "--repo") out.repo = argv[++i];
    else if (arg === "--github-auth-mode") out.githubAuthMode = argv[++i];
  }
  return out;
}

export function mainEntry(argv: string[] = process.argv.slice(2)): number {
  return githubAuthModesMain(parseArgs(argv));
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(mainEntry());
}
