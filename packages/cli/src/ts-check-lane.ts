#!/usr/bin/env node
/**
 * ts-check-lane.ts -- CLI for the Node-toolchain-aware TS lane (#1530, #1790).
 *
 * Usage:
 *   deft-ts ts-check-lane --project-root <path>
 *
 * Thin shim -- delegates to @deftai/core/ts-check-lane.
 */
import { fileURLToPath } from "node:url";
import { resolvePnpm, runTsLane } from "@deftai/core/ts-check-lane";

interface ParsedArgs {
  projectRoot?: string;
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
      const value = arg.slice("--project-root=".length);
      if (value === "")
        return { ...parsed, error: "argument --project-root: expected one argument" };
      parsed.projectRoot = value;
    } else {
      return { ...parsed, error: `unrecognized argument: ${arg}` };
    }
  }
  return parsed;
}

export function run(argv: string[]): number {
  const args = parseArgs(argv);
  if (args.error !== undefined) {
    process.stderr.write(`ts-check-lane: ${args.error}\n`);
    return 2;
  }
  const projectRoot = args.projectRoot ?? ".";
  return runTsLane(projectRoot, { pnpm: resolvePnpm() });
}

/* v8 ignore start -- entry guard */
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(run(process.argv.slice(2)));
}
/* v8 ignore stop */
