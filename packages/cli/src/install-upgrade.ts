#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runInstallUpgrade } from "@deftai/directive-core/install-upgrade";

export interface ParsedInstallUpgradeArgs {
  projectRoot: string;
  frameworkRoot: string;
  error?: string;
}

export function parseArgs(argv: readonly string[]): ParsedInstallUpgradeArgs {
  let projectRoot = ".";
  let frameworkRoot = resolve(import.meta.dirname, "..", "..", "..");

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? "";
    if (arg === "--project-root") {
      const value = argv[i + 1];
      if (value === undefined) {
        return {
          projectRoot,
          frameworkRoot,
          error: "argument --project-root: expected one argument",
        };
      }
      projectRoot = value;
      i += 1;
    } else if (arg.startsWith("--project-root=")) {
      projectRoot = arg.slice("--project-root=".length);
    } else if (arg === "--framework-root") {
      const value = argv[i + 1];
      if (value === undefined) {
        return {
          projectRoot,
          frameworkRoot,
          error: "argument --framework-root: expected one argument",
        };
      }
      frameworkRoot = value;
      i += 1;
    } else if (arg.startsWith("--framework-root=")) {
      frameworkRoot = arg.slice("--framework-root=".length);
    } else {
      return { projectRoot, frameworkRoot, error: `unrecognized argument: ${arg}` };
    }
  }

  if (process.env.DEFT_ROOT && process.env.DEFT_ROOT.length > 0) {
    frameworkRoot = process.env.DEFT_ROOT;
  }

  return { projectRoot, frameworkRoot };
}

export function run(argv: readonly string[]): number {
  const args = parseArgs(argv);
  if (args.error !== undefined) {
    process.stderr.write(`install-upgrade: ${args.error}\n`);
    return 2;
  }

  return runInstallUpgrade(
    { projectRoot: args.projectRoot, frameworkRoot: args.frameworkRoot },
    {
      writeOut: (text) => {
        process.stdout.write(text);
      },
      writeErr: (text) => {
        process.stderr.write(text);
      },
    },
  );
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(run(process.argv.slice(2)));
}
