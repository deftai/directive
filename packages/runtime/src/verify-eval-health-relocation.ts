#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluate } from "@deftai/directive-core/eval-health-relocation";

interface ParsedArgs {
  projectRoot: string;
  baseRef?: string;
  staged: boolean;
  quiet: boolean;
  seedBaseline: boolean;
  paths: string[];
  error?: string;
}

/** Parse verify-eval-health-relocation CLI args. */
export function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    projectRoot: ".",
    staged: false,
    quiet: false,
    seedBaseline: false,
    paths: [],
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--quiet") {
      parsed.quiet = true;
    } else if (arg === "--staged") {
      parsed.staged = true;
    } else if (arg === "--seed-baseline") {
      parsed.seedBaseline = true;
    } else if (arg === "--project-root") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...parsed, error: "argument --project-root: expected one argument" };
      }
      parsed.projectRoot = value;
      i += 1;
    } else if (arg?.startsWith("--project-root=")) {
      parsed.projectRoot = arg.slice("--project-root=".length);
    } else if (arg === "--base-ref") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...parsed, error: "argument --base-ref: expected one argument" };
      }
      parsed.baseRef = value;
      i += 1;
    } else if (arg?.startsWith("--base-ref=")) {
      parsed.baseRef = arg.slice("--base-ref=".length);
    } else if (arg === "--path") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...parsed, error: "argument --path: expected one argument" };
      }
      parsed.paths.push(value);
      i += 1;
    } else if (arg?.startsWith("--path=")) {
      parsed.paths.push(arg.slice("--path=".length));
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
    process.stderr.write(`verify_eval_health_relocation: ${args.error}\n`);
    return 2;
  }

  const projectRoot = resolve(args.projectRoot);
  const result = evaluate({
    projectRoot,
    baseRef: args.baseRef,
    staged: args.staged,
    quiet: args.quiet,
    seedBaseline: args.seedBaseline,
    paths: args.paths.length > 0 ? args.paths : undefined,
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
