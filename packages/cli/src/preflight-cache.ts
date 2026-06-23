#!/usr/bin/env node
/**
 * preflight-cache.ts -- CLI for the cache-freshness gate (#1127).
 *
 * Usage:
 *   deft-ts preflight-cache --project-root <path> --allow-missing-bootstrap
 *   deft-ts preflight-cache --project-root <path> --for-issue <N>
 *
 * Thin shim -- delegates to @deftai/directive-core/preflight-cache.
 */
import { fileURLToPath } from "node:url";
import { evaluate } from "@deftai/directive-core/preflight-cache";

interface ParsedArgs {
  projectRoot?: string;
  source?: string;
  repo?: string;
  maxAgeHours?: number;
  forIssue?: number;
  allowStale?: boolean;
  allowMissingBootstrap?: boolean;
  quiet?: boolean;
  error?: string;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    if (arg === "--project-root") {
      const next = argv[i + 1];
      if (next === undefined)
        return { ...parsed, error: "argument --project-root: expected one argument" };
      parsed.projectRoot = next;
      i++;
    } else if (arg.startsWith("--project-root=")) {
      parsed.projectRoot = arg.slice("--project-root=".length);
    } else if (arg === "--source") {
      const next = argv[i + 1];
      if (next === undefined)
        return { ...parsed, error: "argument --source: expected one argument" };
      parsed.source = next;
      i++;
    } else if (arg === "--repo") {
      const next = argv[i + 1];
      if (next === undefined) return { ...parsed, error: "argument --repo: expected one argument" };
      parsed.repo = next;
      i++;
    } else if (arg === "--max-age-hours") {
      const next = argv[i + 1];
      if (next === undefined)
        return { ...parsed, error: "argument --max-age-hours: expected one argument" };
      parsed.maxAgeHours = Number.parseInt(next, 10);
      i++;
    } else if (arg === "--for-issue") {
      const next = argv[i + 1];
      if (next === undefined)
        return { ...parsed, error: "argument --for-issue: expected one argument" };
      parsed.forIssue = Number.parseInt(next, 10);
      i++;
    } else if (arg === "--allow-stale") {
      parsed.allowStale = true;
    } else if (arg === "--allow-missing-bootstrap") {
      parsed.allowMissingBootstrap = true;
    } else if (arg === "--quiet") {
      parsed.quiet = true;
    } else {
      return { ...parsed, error: `unrecognized argument: ${arg}` };
    }
  }
  return parsed;
}

export function run(argv: string[]): number {
  const args = parseArgs(argv);
  if (args.error !== undefined) {
    process.stderr.write(`preflight-cache: ${args.error}\n`);
    return 2;
  }

  const projectRoot = args.projectRoot ?? ".";
  const result = evaluate(projectRoot, {
    source: args.source,
    repo: args.repo,
    maxAgeHours: args.maxAgeHours ?? null,
    forIssue: args.forIssue ?? null,
    allowStale: args.allowStale ?? false,
    allowMissingBootstrap: args.allowMissingBootstrap ?? false,
  });

  const quiet = args.quiet ?? false;
  if (result.code === 0) {
    if (!quiet) {
      if (result.message.startsWith("⚠")) {
        process.stderr.write(`${result.message}\n`);
      } else {
        process.stdout.write(`${result.message}\n`);
      }
    }
  } else {
    process.stderr.write(`${result.message}\n`);
  }
  return result.code;
}

/* v8 ignore start -- entry guard */
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(run(process.argv.slice(2)));
}
/* v8 ignore stop */
