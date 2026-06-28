#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  emitMigratePreflight,
  runMigratePreflight,
} from "@deftai/directive-core/migrate-preflight";

export interface ParsedMigratePreflightArgs {
  projectRoot: string;
  deftRoot: string;
  quiet: boolean;
  error?: string;
}

export function parseArgs(argv: readonly string[]): ParsedMigratePreflightArgs {
  let projectRoot = ".";
  let deftRoot = resolve(import.meta.dirname, "..", "..", "..");
  let quiet = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? "";
    if (arg === "--quiet") {
      quiet = true;
    } else if (arg === "--project-root") {
      const value = argv[i + 1];
      if (value === undefined) {
        return {
          projectRoot,
          deftRoot,
          quiet,
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
          quiet,
          error: "argument --deft-root: expected one argument",
        };
      }
      deftRoot = value;
      i += 1;
    } else if (arg.startsWith("--deft-root=")) {
      deftRoot = arg.slice("--deft-root=".length);
    } else {
      return { projectRoot, deftRoot, quiet, error: `unrecognized argument: ${arg}` };
    }
  }

  if (
    process.env.DEFT_ROOT &&
    process.env.DEFT_ROOT.length > 0 &&
    !argv.some((a) => a.startsWith("--deft-root"))
  ) {
    deftRoot = process.env.DEFT_ROOT;
  }

  return { projectRoot, deftRoot, quiet };
}

export function run(argv: readonly string[]): number {
  const args = parseArgs(argv);
  if (args.error !== undefined) {
    process.stderr.write(`migrate-preflight: ${args.error}\n`);
    return 2;
  }

  const outcome = runMigratePreflight({
    projectRoot: args.projectRoot,
    deftRoot: args.deftRoot,
    quiet: args.quiet,
  });

  if (outcome.kind === "config") {
    process.stderr.write(`migrate-preflight: ${outcome.message}\n`);
    return 2;
  }

  return emitMigratePreflight(
    outcome,
    {
      writeOut: (text) => {
        process.stdout.write(text);
      },
      writeErr: (text) => {
        process.stderr.write(text);
      },
    },
    args.quiet,
  );
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(run(process.argv.slice(2)));
}
