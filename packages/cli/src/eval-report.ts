#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { reportGoldenEval } from "@deftai/directive-core/eval/report";

interface ParsedArgs {
  projectRoot: string;
  championVersion: string;
  challengerVersion: string;
  model: string;
  json: boolean;
  error?: string;
}

/** Parse eval-report CLI args. */
export function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    projectRoot: ".",
    championVersion: "",
    challengerVersion: "",
    model: "",
    json: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") {
      parsed.json = true;
    } else if (arg === "--champion") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...parsed, error: "argument --champion: expected one argument" };
      }
      parsed.championVersion = value;
      i += 1;
    } else if (arg?.startsWith("--champion=")) {
      parsed.championVersion = arg.slice("--champion=".length);
    } else if (arg === "--challenger") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...parsed, error: "argument --challenger: expected one argument" };
      }
      parsed.challengerVersion = value;
      i += 1;
    } else if (arg?.startsWith("--challenger=")) {
      parsed.challengerVersion = arg.slice("--challenger=".length);
    } else if (arg === "--model") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...parsed, error: "argument --model: expected one argument" };
      }
      parsed.model = value;
      i += 1;
    } else if (arg?.startsWith("--model=")) {
      parsed.model = arg.slice("--model=".length);
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

/** Run eval:report and return the process exit code. */
export function run(argv: string[]): number {
  const args = parseArgs(argv);
  if (args.error !== undefined) {
    process.stderr.write(`eval:report: ${args.error}\n`);
    return 2;
  }

  const result = reportGoldenEval({
    projectRoot: resolve(args.projectRoot),
    championVersion: args.championVersion,
    challengerVersion: args.challengerVersion,
    model: args.model,
  });

  if (result.report === null) {
    process.stderr.write(`${result.message}\n`);
    return result.code;
  }

  if (args.json) {
    process.stdout.write(`${JSON.stringify(result.report, null, 2)}\n`);
  } else {
    process.stdout.write(`${result.message}\n`);
  }

  return result.code;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(run(process.argv.slice(2)));
}
