#!/usr/bin/env node
import { resolve } from "node:path";
import { stealOccupancy } from "@deftai/directive-core/session";

export function parseArgs(argv: readonly string[]): {
  projectRoot: string;
  confirm: boolean;
  occupant: string | null;
  error?: string;
} {
  const parsed = { projectRoot: ".", confirm: false, occupant: null as string | null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--confirm") {
      parsed.confirm = true;
    } else if (arg === "--occupant") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...parsed, error: "argument --occupant: expected one argument" };
      }
      parsed.occupant = value;
      i += 1;
    } else if (arg?.startsWith("--occupant=")) {
      parsed.occupant = arg.slice("--occupant=".length);
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

export function run(argv: readonly string[]): number {
  const args = parseArgs(argv);
  if (args.error !== undefined) {
    process.stderr.write(`occupancy:steal: ${args.error}\n`);
    return 2;
  }
  const result = stealOccupancy(resolve(args.projectRoot), {
    confirm: args.confirm,
    occupant: args.occupant ?? undefined,
    env: process.env,
  });
  const sink = result.code === 0 ? process.stdout : process.stderr;
  sink.write(`${result.message}\n`);
  return result.code;
}
