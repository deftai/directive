#!/usr/bin/env node
/**
 * CLI for verify:consumer-check-contract (#3145).
 */
import { resolve } from "node:path";
import { consumerCheckContract } from "@deftai/directive-core";
import { isDirectEntrypoint } from "./entrypoint.js";

interface ParsedArgs {
  projectRoot: string;
  frameworkSource: boolean;
  enforce: boolean;
  quiet: boolean;
  error?: string;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    projectRoot: ".",
    frameworkSource: false,
    enforce: true,
    quiet: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--quiet") {
      parsed.quiet = true;
    } else if (arg === "--enforce") {
      parsed.enforce = true;
    } else if (arg === "--warn") {
      parsed.enforce = false;
    } else if (arg === "--framework-source") {
      parsed.frameworkSource = true;
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

export function run(argv: string[]): number {
  const args = parseArgs(argv);
  if (args.error !== undefined) {
    process.stderr.write(`verify_consumer_check_contract: ${args.error}\n`);
    return 2;
  }
  const projectRoot = resolve(args.projectRoot);
  const result = consumerCheckContract.evaluateConsumerCheckContract(projectRoot, {
    frameworkSource: args.frameworkSource,
    enforce: args.enforce,
  });
  if (result.exitCode === 0) {
    if (!args.quiet) {
      process.stdout.write(`${result.message}\n`);
    }
  } else {
    process.stderr.write(`${result.message}\n`);
  }
  return result.exitCode;
}

if (isDirectEntrypoint(import.meta.url)) {
  process.exit(run(process.argv.slice(2)));
}
