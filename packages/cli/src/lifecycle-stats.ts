#!/usr/bin/env node
/**
 * CLI: deft lifecycle:stats — local xBRIEF folder counts for process rollups (#2995).
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  collectLifecycleStats,
  formatLifecycleStatsText,
  parseDurationMs,
} from "@deftai/directive-core/lifecycle";

export interface ParsedLifecycleStatsArgs {
  projectRoot: string;
  since: string;
  json: boolean;
  error?: string;
}

/** Parse lifecycle:stats CLI args. */
export function parseArgs(argv: readonly string[]): ParsedLifecycleStatsArgs {
  const parsed: ParsedLifecycleStatsArgs = {
    projectRoot: ".",
    since: "7d",
    json: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === "--json") {
      parsed.json = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      return {
        ...parsed,
        error:
          "usage: lifecycle:stats [--since=7d] [--json] [--project-root <path>]\n" +
          "  Counts xbrief lifecycle folders (filesystem only). See commands.md § lifecycle:stats.",
      };
    }
    if (arg === "--project-root") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...parsed, error: "argument --project-root: expected one argument" };
      }
      parsed.projectRoot = value;
      i += 1;
      continue;
    }
    if (arg.startsWith("--project-root=")) {
      parsed.projectRoot = arg.slice("--project-root=".length);
      continue;
    }
    if (arg === "--since") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...parsed, error: "argument --since: expected one argument" };
      }
      parsed.since = value;
      i += 1;
      continue;
    }
    if (arg.startsWith("--since=")) {
      parsed.since = arg.slice("--since=".length);
      continue;
    }
    if (arg.startsWith("-")) {
      return { ...parsed, error: `unknown flag: ${arg}` };
    }
    return { ...parsed, error: `unexpected argument: ${arg}` };
  }
  return parsed;
}

/** Native lifecycle:stats handler (#2995). */
export function run(argv: readonly string[] = process.argv.slice(2)): number {
  const args = parseArgs(argv);
  if (args.error !== undefined) {
    process.stderr.write(`lifecycle_stats: ${args.error}\n`);
    return 2;
  }
  try {
    parseDurationMs(args.since);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`lifecycle_stats: ${msg}\n`);
    return 2;
  }
  try {
    const stats = collectLifecycleStats({
      projectRoot: resolve(args.projectRoot),
      since: args.since,
    });
    if (args.json) {
      process.stdout.write(`${JSON.stringify(stats, null, 2)}\n`);
    } else {
      process.stdout.write(formatLifecycleStatsText(stats));
    }
    return 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`lifecycle_stats: ${msg}\n`);
    return 1;
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(run(process.argv.slice(2)));
}
