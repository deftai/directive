#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runCheckUpdates } from "@deftai/directive-core/check-updates";

export interface ParsedCheckUpdatesArgs {
  projectRoot: string;
  deftRoot: string;
  passthrough: string[];
  error?: string;
}

export function parseArgs(argv: readonly string[]): ParsedCheckUpdatesArgs {
  let projectRoot = process.cwd();
  let deftRoot = resolve(import.meta.dirname, "..", "..", "..");
  const passthrough: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? "";
    if (arg === "--project-root") {
      const value = argv[i + 1];
      if (value === undefined) {
        return {
          projectRoot,
          deftRoot,
          passthrough,
          error: "argument --project-root: expected one argument",
        };
      }
      projectRoot = value;
      i += 1;
    } else if (arg.startsWith("--project-root=")) {
      projectRoot = arg.slice("--project-root=".length);
    } else if (arg === "--deft-root") {
      const value = argv[i + 1];
      if (value === undefined) {
        return {
          projectRoot,
          deftRoot,
          passthrough,
          error: "argument --deft-root: expected one argument",
        };
      }
      deftRoot = value;
      i += 1;
    } else if (arg.startsWith("--deft-root=")) {
      deftRoot = arg.slice("--deft-root=".length);
    } else {
      passthrough.push(arg);
    }
  }

  if (
    process.env.DEFT_ROOT &&
    process.env.DEFT_ROOT.length > 0 &&
    !argv.some((a) => a.startsWith("--deft-root"))
  ) {
    deftRoot = process.env.DEFT_ROOT;
  }

  return { projectRoot, deftRoot, passthrough };
}

export function run(argv: readonly string[]): number {
  const args = parseArgs(argv);
  if (args.error !== undefined) {
    process.stderr.write(`framework:check-updates: ${args.error}\n`);
    return 2;
  }

  return runCheckUpdates(args.passthrough, {
    projectRoot: args.projectRoot,
    frameworkRoot: args.deftRoot,
  });
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(run(process.argv.slice(2)));
}
