#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runCommitLint } from "@deftai/directive-core/task-surface";

function parseProjectRoot(argv: readonly string[]): { projectRoot: string; error?: string } {
  let projectRoot = ".";
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? "";
    if (arg === "--project-root") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { projectRoot, error: "argument --project-root: expected one argument" };
      }
      projectRoot = value;
      i += 1;
    } else if (arg.startsWith("--project-root=")) {
      projectRoot = arg.slice("--project-root=".length);
    } else {
      return { projectRoot, error: `unrecognized argument: ${arg}` };
    }
  }
  return { projectRoot };
}

export function run(argv: readonly string[]): number {
  const args = parseProjectRoot(argv);
  if (args.error !== undefined) {
    process.stderr.write(`commit-lint: ${args.error}\n`);
    return 2;
  }
  return runCommitLint(resolve(args.projectRoot), {
    writeOut: (text) => {
      process.stdout.write(text);
    },
    writeErr: (text) => {
      process.stderr.write(text);
    },
  });
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(run(process.argv.slice(2)));
}
