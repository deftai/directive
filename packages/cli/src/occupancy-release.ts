#!/usr/bin/env node
import { resolve } from "node:path";
import { releaseOccupancy } from "@deftai/directive-core/session";

export function parseArgs(argv: readonly string[]): {
  projectRoot: string;
  error?: string;
} {
  const parsed = { projectRoot: "." };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--project-root") {
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

export function run(argv: readonly string[]): number {
  const args = parseArgs(argv);
  if (args.error !== undefined) {
    process.stderr.write(`occupancy:release: ${args.error}\n`);
    return 2;
  }
  const result = releaseOccupancy(resolve(args.projectRoot), {
    env: process.env,
  });
  const sink = result.code === 0 ? process.stdout : process.stderr;
  sink.write(`${result.message}\n`);
  return result.code;
}
