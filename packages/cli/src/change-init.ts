#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runChangeInit } from "@deftai/directive-core/task-surface";

function parseArgs(argv: readonly string[]): { projectRoot: string; name: string; error?: string } {
  let projectRoot = ".";
  let name = "";
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? "";
    if (arg === "--project-root") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { projectRoot, name, error: "argument --project-root: expected one argument" };
      }
      projectRoot = value;
      i += 1;
    } else if (arg.startsWith("--project-root=")) {
      projectRoot = arg.slice("--project-root=".length);
    } else if (arg === "--name") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { projectRoot, name, error: "argument --name: expected one argument" };
      }
      name = value;
      i += 1;
    } else if (arg.startsWith("--name=")) {
      name = arg.slice("--name=".length);
    } else if (!arg.startsWith("-") && name.length === 0) {
      name = arg;
    } else {
      return { projectRoot, name, error: `unrecognized argument: ${arg}` };
    }
  }
  return { projectRoot, name };
}

export function run(argv: readonly string[]): number {
  const args = parseArgs(argv);
  if (args.error !== undefined) {
    process.stderr.write(`change-init: ${args.error}\n`);
    return 2;
  }
  return runChangeInit(resolve(args.projectRoot), args.name, {
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
