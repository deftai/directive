#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateForwardCoverage, type ForwardCoverageMode } from "@deftai/directive-core";

interface ParsedArgs {
  mode: ForwardCoverageMode;
  projectRoot: string;
  allowList: string | null;
  quiet: boolean;
  enforce: boolean;
  coverageReport: string | null;
  coverageDir: string | null;
  help?: boolean;
  error?: string;
}

const HELP_TEXT =
  "Usage: verify-forward-coverage [--project-root <path>] [--staged|--head] [--allow-list <path>]\n" +
  "                               [--coverage-dir <path>] [--coverage-report <path>]\n" +
  "                               [--enforce] [--quiet]\n" +
  "  Fail-closed new-source-file existence (#1310) plus warn-first diff coverage of\n" +
  "  added/modified branches (#3514). The 90% per-diff threshold is not the 75\n" +
  "  global floor. Missing coverage reports skip the diff half.\n" +
  "  --enforce: fail closed when uncovered changed branches are below 90%.\n";

function takeValue(
  argv: string[],
  i: number,
  flag: string,
): { value: string; next: number } | { error: string } {
  const value = argv[i + 1];
  if (value === undefined) {
    return { error: `argument ${flag}: expected one argument` };
  }
  return { value, next: i + 1 };
}

/** Parse the verify-forward-coverage CLI args, mirroring the verify-encoding surface. */
export function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    mode: "head",
    projectRoot: ".",
    allowList: null,
    quiet: false,
    enforce: false,
    coverageReport: null,
    coverageDir: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--staged") {
      parsed.mode = "staged";
    } else if (arg === "--head") {
      parsed.mode = "head";
    } else if (arg === "--quiet") {
      parsed.quiet = true;
    } else if (arg === "--enforce") {
      parsed.enforce = true;
    } else if (arg === "--help" || arg === "-h") {
      return { ...parsed, help: true };
    } else if (arg === "--project-root") {
      const taken = takeValue(argv, i, "--project-root");
      if ("error" in taken) {
        return { ...parsed, error: taken.error };
      }
      parsed.projectRoot = taken.value;
      i = taken.next;
    } else if (arg?.startsWith("--project-root=")) {
      parsed.projectRoot = arg.slice("--project-root=".length);
    } else if (arg === "--allow-list") {
      const taken = takeValue(argv, i, "--allow-list");
      if ("error" in taken) {
        return { ...parsed, error: taken.error };
      }
      parsed.allowList = taken.value;
      i = taken.next;
    } else if (arg?.startsWith("--allow-list=")) {
      parsed.allowList = arg.slice("--allow-list=".length);
    } else if (arg === "--coverage-report") {
      const taken = takeValue(argv, i, "--coverage-report");
      if ("error" in taken) {
        return { ...parsed, error: taken.error };
      }
      parsed.coverageReport = taken.value;
      i = taken.next;
    } else if (arg?.startsWith("--coverage-report=")) {
      parsed.coverageReport = arg.slice("--coverage-report=".length);
    } else if (arg === "--coverage-dir") {
      const taken = takeValue(argv, i, "--coverage-dir");
      if ("error" in taken) {
        return { ...parsed, error: taken.error };
      }
      parsed.coverageDir = taken.value;
      i = taken.next;
    } else if (arg?.startsWith("--coverage-dir=")) {
      parsed.coverageDir = arg.slice("--coverage-dir=".length);
    } else {
      return { ...parsed, error: `unrecognized argument: ${arg}` };
    }
  }
  return parsed;
}

function resolveCoverageReport(args: ParsedArgs): string | undefined {
  if (args.coverageReport !== null) {
    return resolve(args.coverageReport);
  }
  if (args.coverageDir !== null) {
    return resolve(args.coverageDir, "coverage-final.json");
  }
  return undefined;
}

/** Run the gate and return the process exit code (argv parse error -> 2). */
export function run(argv: string[]): number {
  const args = parseArgs(argv);
  if (args.help === true) {
    process.stdout.write(HELP_TEXT);
    return 0;
  }
  if (args.error !== undefined) {
    process.stderr.write(`verify_forward_coverage: ${args.error}\n`);
    return 2;
  }
  const projectRoot = resolve(args.projectRoot);
  const allowListPath = args.allowList !== null ? resolve(args.allowList) : null;
  const result = evaluateForwardCoverage(projectRoot, {
    mode: args.mode,
    allowListPath,
    enforceDiffCoverage: args.enforce,
    coverageReportPath: resolveCoverageReport(args),
  });
  if (result.exitCode === 0) {
    if (!args.quiet) {
      process.stdout.write(`${result.message}\n`);
    } else if (result.message.includes("ADVISORY")) {
      process.stdout.write(`${result.message}\n`);
    }
  } else {
    process.stderr.write(`${result.message}\n`);
  }
  return result.exitCode;
}

// Only execute when invoked directly as a binary (not when imported in tests).
// Normalize both sides via fileURLToPath so the guard fires on Windows too.
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(run(process.argv.slice(2)));
}
