#!/usr/bin/env node
import { statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { listProject, validateProject } from "../../core/dist/triage/classify/index.js";

interface ParsedArgs {
  projectRoot: string;
  doList: boolean;
  doValidate: boolean;
  error?: string;
}

/** Parse triage-classify CLI args, mirroring the Python argparse surface. */
export function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    projectRoot: ".",
    doList: false,
    doValidate: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--list") {
      parsed.doList = true;
    } else if (arg === "--validate") {
      parsed.doValidate = true;
    } else if (arg === "--project-root") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...parsed, error: "argument --project-root: expected one argument" };
      }
      parsed.projectRoot = value;
      i += 1;
    } else if (arg?.startsWith("--project-root=")) {
      parsed.projectRoot = arg.slice("--project-root=".length);
    } else if (arg === "--help" || arg === "-h") {
      return parsed;
    } else if (arg?.startsWith("-")) {
      return { ...parsed, error: `unrecognized arguments: ${arg}` };
    }
  }
  return parsed;
}

/** Run the CLI and return the process exit code. */
export function run(argv: string[]): number {
  const args = parseArgs(argv);
  if (args.error !== undefined) {
    process.stderr.write(`ERR: ${args.error}\n`);
    return 2;
  }

  const projectRoot = resolve(args.projectRoot);
  try {
    const st = statSync(projectRoot);
    if (!st.isDirectory()) {
      process.stderr.write(
        `ERR: --project-root ${projectRoot} does not exist or is not a directory.\n`,
      );
      return 2;
    }
  } catch {
    process.stderr.write(
      `ERR: --project-root ${projectRoot} does not exist or is not a directory.\n`,
    );
    return 2;
  }

  if (args.doValidate) {
    const result = validateProject(projectRoot);
    if (result.stdout.length > 0) {
      process.stdout.write(result.stdout);
    }
    if (result.stderr.length > 0) {
      process.stderr.write(result.stderr);
    }
    return result.code;
  }

  process.stdout.write(listProject(projectRoot));
  return 0;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(run(process.argv.slice(2)));
}
