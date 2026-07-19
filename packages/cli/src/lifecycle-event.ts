#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runLifecycleEvent } from "@deftai/directive-core/lifecycle";

export interface ParsedLifecycleEventArgs {
  projectRoot: string;
  rest: string[];
  error?: string;
}

/** Parse lifecycle:event CLI args. */
export function parseArgs(argv: readonly string[]): ParsedLifecycleEventArgs {
  const parsed: ParsedLifecycleEventArgs = {
    projectRoot: ".",
    rest: [],
  };
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === "--project-root") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...parsed, error: "argument --project-root: expected one argument" };
      }
      parsed.projectRoot = value;
      i += 2;
      continue;
    }
    if (arg?.startsWith("--project-root=")) {
      parsed.projectRoot = arg.slice("--project-root=".length);
      i += 1;
      continue;
    }
    parsed.rest = argv.slice(i);
    break;
  }
  return parsed;
}

/** Native lifecycle:event handler (#2631). */
export function run(argv: readonly string[]): number {
  const args = parseArgs(argv);
  if (args.error !== undefined) {
    process.stderr.write(`lifecycle_event: ${args.error}\n`);
    return 2;
  }
  return runLifecycleEvent(args.rest, { projectRoot: resolve(args.projectRoot) });
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(run(process.argv.slice(2)));
}
