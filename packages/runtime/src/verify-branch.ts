#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluate } from "@deftai/directive-core/branch";

interface ParsedArgs {
  projectRoot: string;
  allowMissingProjectDefinition: boolean;
  defaultBranches: string[] | null;
  quiet: boolean;
  error?: string;
}

/** Parse verify-branch CLI args, mirroring the Python argparse surface. */
export function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    projectRoot: ".",
    allowMissingProjectDefinition: false,
    defaultBranches: null,
    quiet: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--allow-missing-project-definition") {
      parsed.allowMissingProjectDefinition = true;
    } else if (arg === "--quiet") {
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
    } else if (arg === "--default-branch") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...parsed, error: "argument --default-branch: expected one argument" };
      }
      if (parsed.defaultBranches === null) {
        parsed.defaultBranches = [];
      }
      parsed.defaultBranches.push(value);
      i += 1;
    } else if (arg?.startsWith("--default-branch=")) {
      if (parsed.defaultBranches === null) {
        parsed.defaultBranches = [];
      }
      parsed.defaultBranches.push(arg.slice("--default-branch=".length));
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
    process.stderr.write(`preflight_branch: ${args.error}\n`);
    return 2;
  }

  const projectRoot = resolve(args.projectRoot);
  const defaultBranches = args.defaultBranches !== null ? new Set(args.defaultBranches) : undefined;

  const result = evaluate(projectRoot, {
    allowMissingProjectDefinition: args.allowMissingProjectDefinition,
    defaultBranches,
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

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(run(process.argv.slice(2)));
}
