#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluate } from "@deftai/directive-core/pr-closeout-attestable";

interface ParsedArgs {
  projectRoot: string;
  repo: string | null;
  pr: number | null;
  quiet: boolean;
  error?: string;
}

function parsePrNumber(raw: string): number | null {
  const trimmed = raw.startsWith("#") ? raw.slice(1) : raw;
  if (!/^\d+$/.test(trimmed)) {
    return null;
  }
  const value = Number(trimmed);
  return Number.isInteger(value) && value > 0 ? value : null;
}

/** Parse verify-pr-closeout-attestable CLI args. */
export function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = { projectRoot: ".", repo: null, pr: null, quiet: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--quiet") {
      parsed.quiet = true;
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
    } else if (arg === "--pr") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...parsed, error: "argument --pr: expected one argument" };
      }
      const pr = parsePrNumber(value);
      if (pr === null) {
        return { ...parsed, error: `argument --pr: expected a positive integer, got ${value}` };
      }
      parsed.pr = pr;
      i += 1;
    } else if (arg?.startsWith("--pr=")) {
      const value = arg.slice("--pr=".length);
      const pr = parsePrNumber(value);
      if (pr === null) {
        return { ...parsed, error: `argument --pr: expected a positive integer, got ${value}` };
      }
      parsed.pr = pr;
    } else {
      return { ...parsed, error: `unrecognized argument: ${arg}` };
    }
  }
  if (parsed.pr === null) {
    return { ...parsed, error: "argument --pr is required" };
  }
  return parsed;
}

/** Run the gate and return the process exit code. */
export function run(argv: string[]): number {
  const args = parseArgs(argv);
  if (args.error !== undefined) {
    process.stderr.write(`verify_pr_closeout_attestable: ${args.error}\n`);
    return 2;
  }

  const result = evaluate(resolve(args.projectRoot), args.pr as number, {
    repo: args.repo,
    quiet: args.quiet,
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
