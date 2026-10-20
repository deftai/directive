#!/usr/bin/env node
/**
 * CLI for verify:test-boundary (#3145).
 */
import { resolve } from "node:path";
import { testBoundary } from "@deftai/directive-core";
import { isDirectEntrypoint } from "./entrypoint.js";

interface ParsedArgs {
  projectRoot: string;
  policyPath: string | null;
  enforce: boolean | undefined;
  quiet: boolean;
  error?: string;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    projectRoot: ".",
    policyPath: null,
    enforce: undefined,
    quiet: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--quiet") {
      parsed.quiet = true;
    } else if (arg === "--enforce") {
      parsed.enforce = true;
    } else if (arg === "--warn") {
      parsed.enforce = false;
    } else if (arg === "--project-root") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...parsed, error: "argument --project-root: expected one argument" };
      }
      parsed.projectRoot = value;
      i += 1;
    } else if (arg?.startsWith("--project-root=")) {
      parsed.projectRoot = arg.slice("--project-root=".length);
    } else if (arg === "--policy") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...parsed, error: "argument --policy: expected one argument" };
      }
      parsed.policyPath = value;
      i += 1;
    } else if (arg?.startsWith("--policy=")) {
      parsed.policyPath = arg.slice("--policy=".length);
    } else {
      return { ...parsed, error: `unrecognized argument: ${arg}` };
    }
  }
  return parsed;
}

export function run(argv: string[]): number {
  const args = parseArgs(argv);
  if (args.error !== undefined) {
    process.stderr.write(`verify_test_boundary: ${args.error}\n`);
    return 2;
  }
  const projectRoot = resolve(args.projectRoot);
  const policyPath = args.policyPath !== null ? resolve(args.policyPath) : null;
  const result = testBoundary.evaluateTestBoundary(projectRoot, {
    policyPath,
    enforce: args.enforce,
    quiet: args.quiet,
  });
  if (result.exitCode === 0) {
    if (!args.quiet) {
      process.stdout.write(`${result.message}\n`);
    }
  } else {
    process.stderr.write(`${result.message}\n`);
  }
  return result.exitCode;
}

if (isDirectEntrypoint(import.meta.url)) {
  process.exit(run(process.argv.slice(2)));
}
