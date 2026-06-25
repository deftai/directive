#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  appendHistory,
  computeSummary,
  formatSummary,
  pythonStyleStringify,
  SUMMARY_HISTORY_REL_PATH,
  summaryResultToRecord,
  utcIso,
} from "@deftai/directive-core/dist/triage/summary/index.js";

interface ParsedArgs {
  projectRoot: string;
  cacheRoot: string | null;
  noHistory: boolean;
  json: boolean;
  error?: string;
}

/** Parse triage-summary CLI args, mirroring the Python argparse surface. */
export function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    projectRoot: ".",
    cacheRoot: null,
    noHistory: false,
    json: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--no-history") {
      parsed.noHistory = true;
    } else if (arg === "--json") {
      parsed.json = true;
    } else if (arg === "--project-root") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...parsed, error: "argument --project-root: expected one argument" };
      }
      parsed.projectRoot = value;
      i += 1;
    } else if (arg?.startsWith("--project-root=")) {
      parsed.projectRoot = arg.slice("--project-root=".length);
    } else if (arg === "--cache-root") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...parsed, error: "argument --cache-root: expected one argument" };
      }
      parsed.cacheRoot = value;
      i += 1;
    } else if (arg?.startsWith("--cache-root=")) {
      parsed.cacheRoot = arg.slice("--cache-root=".length);
    } else if (arg !== undefined && arg.length > 0) {
      return { ...parsed, error: `unrecognized argument: ${arg}` };
    }
  }
  return parsed;
}

/** Run the triage:summary CLI — always returns exit code 0. */
export function run(argv: string[]): number {
  const args = parseArgs(argv);
  if (args.error !== undefined) {
    process.stderr.write(`triage_summary: ${args.error}\n`);
    return 2;
  }

  const projectRoot = resolve(args.projectRoot);
  const cacheRoot = args.cacheRoot !== null ? resolve(args.cacheRoot) : undefined;

  const result = computeSummary(projectRoot, { cacheRoot });
  const line = formatSummary(result);
  const emittedAt = utcIso();

  if (args.json) {
    const record = summaryResultToRecord(result, { emittedAt, line });
    process.stdout.write(`${pythonStyleStringify(record)}\n`);
  } else {
    process.stdout.write(`${line}\n`);
  }

  if (!args.noHistory) {
    const historyPath = resolve(projectRoot, SUMMARY_HISTORY_REL_PATH);
    appendHistory(historyPath, result, line, { emittedAt });
  }

  return 0;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(run(process.argv.slice(2)));
}
