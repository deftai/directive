#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateSemanticSingleSource } from "@deftai/directive-core/verify-source";

interface ParsedArgs {
  projectRoot: string;
  error?: string;
}

/** Parse verify-semantic-single-source CLI args (#3600 / #3899 C2). */
export function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = { projectRoot: "." };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--project-root" || arg === "--pack-root") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...parsed, error: `argument ${arg}: expected one argument` };
      }
      parsed.projectRoot = value;
      i += 1;
    } else if (arg?.startsWith("--project-root=")) {
      parsed.projectRoot = arg.slice("--project-root=".length);
    } else if (arg?.startsWith("--pack-root=")) {
      parsed.projectRoot = arg.slice("--pack-root=".length);
    } else {
      return { ...parsed, error: `unrecognized argument: ${arg}` };
    }
  }
  return parsed;
}

/** Run the C2 gate and return the process exit code. */
export function run(argv: string[]): number {
  const args = parseArgs(argv);
  if (args.error !== undefined) {
    process.stderr.write(`verify_semantic_single_source: ${args.error}\n`);
    return 2;
  }
  const result = evaluateSemanticSingleSource(resolve(args.projectRoot));
  if (result.stream === "stdout") {
    process.stdout.write(`${result.message}\n`);
  } else {
    process.stderr.write(`${result.message}\n`);
  }
  return result.code;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(run(process.argv.slice(2)));
}
