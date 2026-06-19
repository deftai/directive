#!/usr/bin/env node
import { statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runDefaultMode } from "../../core/dist/triage/welcome/default-mode.js";

interface ParsedArgs {
  projectRoot: string;
  onboard: boolean;
  noHistory: boolean;
  taskPrefix: string;
  error?: string;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    projectRoot: process.env.DEFT_PROJECT_ROOT ?? ".",
    onboard: false,
    noHistory: false,
    taskPrefix: process.env.DEFT_TASK_PREFIX ?? "",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--onboard") parsed.onboard = true;
    else if (arg === "--no-history") parsed.noHistory = true;
    else if (arg === "--project-root") {
      const value = argv[i + 1];
      if (value === undefined)
        return { ...parsed, error: "argument --project-root: expected one argument" };
      parsed.projectRoot = value;
      i += 1;
    } else if (arg?.startsWith("--project-root=")) {
      parsed.projectRoot = arg.slice("--project-root=".length);
    } else if (arg === "--task-prefix") {
      const value = argv[i + 1];
      if (value === undefined)
        return { ...parsed, error: "argument --task-prefix: expected one argument" };
      parsed.taskPrefix = value;
      i += 1;
    } else if (arg?.startsWith("--task-prefix=")) {
      parsed.taskPrefix = arg.slice("--task-prefix=".length);
    } else if (arg === "--no-subprocess" || arg === "--skip-bootstrap") {
      // accepted for argparse parity; default mode ignores them
    } else {
      return { ...parsed, error: `unrecognized argument: ${arg}` };
    }
  }
  return parsed;
}

export function run(argv: string[]): number {
  const args = parseArgs(argv);
  if (args.error !== undefined) {
    process.stderr.write(`triage:welcome: ${args.error}\n`);
    return 2;
  }
  const projectRoot = resolve(args.projectRoot);
  try {
    if (!statSync(projectRoot).isDirectory()) {
      process.stderr.write(`triage:welcome: --project-root ${projectRoot} is not a directory.\n`);
      return 2;
    }
  } catch {
    process.stderr.write(`triage:welcome: --project-root ${projectRoot} is not a directory.\n`);
    return 2;
  }

  if (args.onboard) {
    process.stderr.write(
      "triage:welcome: --onboard is not implemented in the TypeScript CLI yet.\n",
    );
    return 2;
  }

  const outcome = runDefaultMode(projectRoot, {
    writeHistory: !args.noHistory,
    taskPrefix: args.taskPrefix || null,
  });
  return outcome.exitCode;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(run(process.argv.slice(2)));
}
