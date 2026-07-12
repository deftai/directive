#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluate } from "@deftai/directive-core/agents-md-budget";

interface ParsedArgs {
  projectRoot: string;
  quiet: boolean;
  error?: string;
}

/** Parse verify-agents-md-budget CLI args. */
export function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    projectRoot: ".",
    quiet: false,
  };
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
    process.stderr.write(`verify_agents_md_budget: ${args.error}\n`);
    return 2;
  }

  const projectRoot = resolve(args.projectRoot);
  const result = evaluate(projectRoot, { quiet: args.quiet });

  if (result.message.length > 0) {
    if (result.stream === "stdout") {
      process.stdout.write(`${result.message}\n`);
    } else if (result.stream === "stderr") {
      process.stderr.write(`${result.message}\n`);
    }
  }

  if (result.advisoryMessage !== undefined && result.advisoryMessage.length > 0) {
    if (result.advisoryStream === "stdout") {
      process.stdout.write(`${result.advisoryMessage}\n`);
    } else if (result.advisoryStream === "stderr") {
      process.stderr.write(`${result.advisoryMessage}\n`);
    }
  }

  return result.code;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(run(process.argv.slice(2)));
}
