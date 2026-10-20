#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import {
  parseCurrentShapeArgv,
  runCurrentShape,
} from "@deftai/directive-core/umbrella-current-shape";

export interface ParsedUmbrellaCurrentShapeArgs {
  projectRoot: string;
  passthrough: string[];
  error?: string;
}

export function parseArgs(argv: readonly string[]): ParsedUmbrellaCurrentShapeArgs {
  let projectRoot = process.cwd();
  const passthrough: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? "";
    if (arg === "--project-root") {
      const value = argv[i + 1];
      if (value === undefined) {
        return {
          projectRoot,
          passthrough,
          error: "argument --project-root: expected one argument",
        };
      }
      projectRoot = value;
      i += 1;
    } else if (arg.startsWith("--project-root=")) {
      projectRoot = arg.slice("--project-root=".length);
    } else {
      passthrough.push(arg);
    }
  }

  return { projectRoot, passthrough };
}

export function run(argv: readonly string[]): number {
  const args = parseArgs(argv);
  if (args.error !== undefined) {
    process.stderr.write(`umbrella:current-shape: ${args.error}\n`);
    return 2;
  }

  const parsed = parseCurrentShapeArgv(args.passthrough);
  if (parsed.passthroughError !== undefined) {
    process.stderr.write(`umbrella:current-shape: ${parsed.passthroughError}\n`);
    return 2;
  }
  if (parsed.issueNumber === null) {
    process.stderr.write("umbrella:current-shape: issue number required\n");
    return 2;
  }

  return runCurrentShape({
    issueNumber: parsed.issueNumber,
    projectRoot: args.projectRoot,
    repo: parsed.repo,
    jsonMode: parsed.jsonMode,
    strict: parsed.strict,
  });
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(run(process.argv.slice(2)));
}
