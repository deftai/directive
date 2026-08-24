#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { githubAuthModesMain, INSTALLATION_IDENTITY_ISSUE_URL } from "./github-auth-modes.js";

function parseArgs(argv: string[]) {
  const out: {
    githubAuthMode?: string;
    repo?: string;
    json?: boolean;
    expectedLogin?: string;
  } = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (arg === "--json") out.json = true;
    else if (arg === "--repo") out.repo = argv[++i];
    else if (arg === "--github-auth-mode") out.githubAuthMode = argv[++i];
    else if (arg === "--expected-login") out.expectedLogin = argv[++i];
    else if (arg === "--expected-app-slug" || arg === "--expected-installation-id") {
      throw new Error(
        `${arg} is not accepted; GitHub App installation identity is deferred to ${INSTALLATION_IDENTITY_ISSUE_URL}`,
      );
    }
  }
  return out;
}

export function mainEntry(argv: string[] = process.argv.slice(2)): number {
  try {
    return githubAuthModesMain(parseArgs(argv));
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${message}\n`);
    return 2;
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(mainEntry());
}
