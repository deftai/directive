#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluate } from "@deftai/directive-core/orphan-active";

interface ParsedArgs {
  projectRoot: string;
  repo: string | null;
  issue: number | null;
  quiet: boolean;
  skipGh: boolean;
  error?: string;
}

function parseIssueNumber(raw: string): number | null {
  const trimmed = raw.startsWith("#") ? raw.slice(1) : raw;
  if (!/^\d+$/.test(trimmed)) {
    return null;
  }
  const value = Number(trimmed);
  return Number.isInteger(value) && value > 0 ? value : null;
}

/** Parse verify-orphan-active CLI args. */
export function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    projectRoot: ".",
    repo: null,
    issue: null,
    quiet: false,
    skipGh: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--quiet") {
      parsed.quiet = true;
    } else if (arg === "--skip-gh") {
      parsed.skipGh = true;
    } else if (arg === "--project-root") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...parsed, error: "argument --project-root: expected one argument" };
      }
      parsed.projectRoot = value;
      i += 1;
    } else if (arg?.startsWith("--project-root=")) {
      parsed.projectRoot = arg.slice("--project-root=".length);
    } else if (arg === "--repo") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...parsed, error: "argument --repo: expected one argument" };
      }
      parsed.repo = value;
      i += 1;
    } else if (arg?.startsWith("--repo=")) {
      parsed.repo = arg.slice("--repo=".length);
    } else if (arg === "--issue") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...parsed, error: "argument --issue: expected one argument" };
      }
      const issue = parseIssueNumber(value);
      if (issue === null) {
        return { ...parsed, error: `argument --issue: expected a positive integer, got ${value}` };
      }
      parsed.issue = issue;
      i += 1;
    } else if (arg?.startsWith("--issue=")) {
      const value = arg.slice("--issue=".length);
      const issue = parseIssueNumber(value);
      if (issue === null) {
        return { ...parsed, error: `argument --issue: expected a positive integer, got ${value}` };
      }
      parsed.issue = issue;
    } else {
      return { ...parsed, error: `unrecognized argument: ${arg}` };
    }
  }
  return parsed;
}

/** Run the gate and return the process exit code. */
export function run(argv: string[]): number {
  const args = parseArgs(argv);
  if (args.error !== undefined) {
    process.stderr.write(`verify_orphan_active: ${args.error}\n`);
    return 2;
  }

  const projectRoot = resolve(args.projectRoot);
  const result = evaluate(projectRoot, {
    quiet: args.quiet,
    repo: args.repo,
    skipGh: args.skipGh,
    issue: args.issue,
  });

  if (result.message.length > 0) {
    if (result.stream === "stdout") {
      process.stdout.write(`${result.message}\n`);
    } else if (result.stream === "stderr") {
      process.stderr.write(`${result.message}\n`);
    }
  }

  return result.code;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(run(process.argv.slice(2)));
}
