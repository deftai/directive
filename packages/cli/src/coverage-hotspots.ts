#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateCoverageHotspots, formatJsonReport } from "@deftai/directive-core";

interface ParsedArgs {
  projectRoot: string;
  coverageDir: string | null;
  minHeadroomPp: number | null;
  baseRef: string | null;
  pathFilter: string[];
  useDiffPaths: boolean;
  json: boolean;
  quiet: boolean;
  error?: string;
}

function parseNumber(raw: string): number | null {
  const value = Number.parseFloat(raw);
  if (!Number.isFinite(value)) {
    return null;
  }
  return value;
}

/** Parse coverage-hotspots CLI args. */
export function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    projectRoot: ".",
    coverageDir: null,
    minHeadroomPp: null,
    baseRef: null,
    pathFilter: [],
    useDiffPaths: true,
    json: false,
    quiet: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") {
      parsed.json = true;
    } else if (arg === "--quiet") {
      parsed.quiet = true;
    } else if (arg === "--no-diff-filter") {
      parsed.useDiffPaths = false;
    } else if (arg === "--project-root") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...parsed, error: "argument --project-root: expected one argument" };
      }
      parsed.projectRoot = value;
      i += 1;
    } else if (arg?.startsWith("--project-root=")) {
      parsed.projectRoot = arg.slice("--project-root=".length);
    } else if (arg === "--coverage-dir") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...parsed, error: "argument --coverage-dir: expected one argument" };
      }
      parsed.coverageDir = value;
      i += 1;
    } else if (arg?.startsWith("--coverage-dir=")) {
      parsed.coverageDir = arg.slice("--coverage-dir=".length);
    } else if (arg === "--min-headroom-pp") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...parsed, error: "argument --min-headroom-pp: expected one argument" };
      }
      const num = parseNumber(value);
      if (num === null) {
        return { ...parsed, error: "argument --min-headroom-pp: expected a number" };
      }
      parsed.minHeadroomPp = num;
      i += 1;
    } else if (arg?.startsWith("--min-headroom-pp=")) {
      const num = parseNumber(arg.slice("--min-headroom-pp=".length));
      if (num === null) {
        return { ...parsed, error: "argument --min-headroom-pp: expected a number" };
      }
      parsed.minHeadroomPp = num;
    } else if (arg === "--base-ref") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...parsed, error: "argument --base-ref: expected one argument" };
      }
      parsed.baseRef = value;
      i += 1;
    } else if (arg?.startsWith("--base-ref=")) {
      parsed.baseRef = arg.slice("--base-ref=".length);
    } else if (arg === "--path" || arg === "--paths") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...parsed, error: `argument ${arg}: expected one argument` };
      }
      parsed.pathFilter.push(
        ...value
          .split(",")
          .map((part) => part.trim())
          .filter(Boolean),
      );
      parsed.useDiffPaths = false;
      i += 1;
    } else if (arg?.startsWith("--path=") || arg?.startsWith("--paths=")) {
      const prefix = arg.startsWith("--path=") ? "--path=" : "--paths=";
      parsed.pathFilter.push(
        ...arg
          .slice(prefix.length)
          .split(",")
          .map((part) => part.trim())
          .filter(Boolean),
      );
      parsed.useDiffPaths = false;
    } else {
      return { ...parsed, error: `unrecognized argument: ${arg}` };
    }
  }

  return parsed;
}

/** Run coverage-hotspots and return the process exit code. */
export function run(argv: string[]): number {
  const args = parseArgs(argv);
  if (args.error !== undefined) {
    process.stderr.write(`coverage-hotspots: ${args.error}\n`);
    return 2;
  }

  const projectRoot = resolve(args.projectRoot);
  const result = evaluateCoverageHotspots({
    projectRoot,
    coverageDir: args.coverageDir ?? undefined,
    minHeadroomPp: args.minHeadroomPp ?? undefined,
    baseRef: args.baseRef,
    pathFilter: args.pathFilter.length > 0 ? args.pathFilter : null,
    useDiffPaths: args.useDiffPaths,
  });

  if (result.exitCode === 2 || result.report === null) {
    process.stderr.write(`${result.message}\n`);
    return result.exitCode;
  }

  const payload = args.json ? formatJsonReport(result.report) : result.message;
  if (result.exitCode === 0) {
    if (!args.quiet) {
      process.stdout.write(payload);
    }
  } else {
    process.stderr.write(payload);
  }
  return result.exitCode;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(run(process.argv.slice(2)));
}
