#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { type CommandRunner, runToolchainCheck } from "@deftai/directive-core/verify-env";

export interface ToolchainCheckRunOptions {
  readonly runner?: CommandRunner;
  readonly env?: NodeJS.ProcessEnv;
}

interface ToolchainCheckArgs {
  readonly consumer: boolean;
  readonly projectRoot: string;
  readonly error?: string;
}

function parseArgs(argv: readonly string[]): ToolchainCheckArgs {
  let consumer = false;
  let projectRoot = process.cwd();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";
    if (arg === "--consumer") {
      consumer = true;
      continue;
    }
    if (arg === "--project-root") {
      const value = argv[index + 1];
      if (value === undefined || value.trim() === "" || value.startsWith("-")) {
        return { consumer, projectRoot, error: "--project-root requires a path" };
      }
      projectRoot = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--project-root=")) {
      const value = arg.slice("--project-root=".length);
      if (value.trim() === "") {
        return { consumer, projectRoot, error: "--project-root requires a path" };
      }
      projectRoot = value;
      continue;
    }
    return { consumer, projectRoot, error: `unrecognized argument: ${arg}` };
  }
  return { consumer, projectRoot };
}

export function run(
  argv: readonly string[] = process.argv.slice(2),
  options: ToolchainCheckRunOptions = {},
): number {
  const parsed = parseArgs(argv);
  if (parsed.error !== undefined) {
    process.stderr.write(`toolchain-check: ${parsed.error}\n`);
    process.stderr.write("Usage: deft toolchain-check [--consumer] [--project-root <path>]\n");
    return 2;
  }
  const result = runToolchainCheck(options.runner, {
    consumer: parsed.consumer,
    projectRoot: parsed.projectRoot,
    env: options.env ?? process.env,
  });
  for (const line of result.lines) {
    process.stdout.write(`${line}\n`);
  }
  return result.exitCode;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(run());
}
