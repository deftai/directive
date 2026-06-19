#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { verificationResultToJson, verifyRequiredTools } from "@deftai/core/verify-env";

interface ParsedArgs {
  install: boolean;
  yes: boolean;
  emitJson: boolean;
  includeTask: boolean;
  platform: string | undefined;
  error?: string;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    install: false,
    yes: false,
    emitJson: false,
    includeTask: false,
    platform: undefined,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--install") parsed.install = true;
    else if (arg === "--yes") parsed.yes = true;
    else if (arg === "--json") parsed.emitJson = true;
    else if (arg === "--include-task") parsed.includeTask = true;
    else if (arg === "--platform") {
      const value = argv[i + 1];
      if (value === undefined)
        return { ...parsed, error: "argument --platform: expected one argument" };
      parsed.platform = value;
      i += 1;
    } else if (arg?.startsWith("--platform=")) {
      parsed.platform = arg.slice("--platform=".length);
    } else {
      return { ...parsed, error: `unrecognized arguments: ${arg}` };
    }
  }
  return parsed;
}

export function run(argv: string[]): number {
  const args = parseArgs(argv);
  if (args.error !== undefined) {
    process.stderr.write(`verify_tools.py: error: ${args.error}\n`);
    return 2;
  }
  const captured: string[] = [];
  const result = verifyRequiredTools({
    install: args.install,
    assumeYes: args.yes,
    includeTask: args.includeTask,
    platformId: args.platform,
    outputFn: (line) => {
      captured.push(line);
    },
  });
  if (args.emitJson) {
    process.stdout.write(`${verificationResultToJson(result)}\n`);
  } else {
    for (const line of captured) {
      process.stdout.write(`${line}\n`);
    }
  }
  return result.exitCode;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(run(process.argv.slice(2)));
}
