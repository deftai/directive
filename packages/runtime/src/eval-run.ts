#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runGoldenEval } from "@deftai/directive-core/eval/run";

interface ParsedArgs {
  projectRoot: string;
  model: string;
  seeds: number[];
  directiveVersion?: string;
  harness?: string;
  json: boolean;
  noPersist: boolean;
  error?: string;
}

/** Parse eval-run CLI args. */
export function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    projectRoot: ".",
    model: "",
    seeds: [],
    json: false,
    noPersist: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") {
      parsed.json = true;
    } else if (arg === "--no-persist") {
      parsed.noPersist = true;
    } else if (arg === "--model") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...parsed, error: "argument --model: expected one argument" };
      }
      parsed.model = value;
      i += 1;
    } else if (arg?.startsWith("--model=")) {
      parsed.model = arg.slice("--model=".length);
    } else if (arg === "--seed") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...parsed, error: "argument --seed: expected one argument" };
      }
      const seedNum = Number(value);
      if (!Number.isFinite(seedNum)) {
        return { ...parsed, error: `argument --seed: expected an integer, got: ${value}` };
      }
      parsed.seeds.push(seedNum);
      i += 1;
    } else if (arg?.startsWith("--seed=")) {
      const rawSeed = arg.slice("--seed=".length);
      const seedNum = Number(rawSeed);
      if (!Number.isFinite(seedNum)) {
        return { ...parsed, error: `argument --seed: expected an integer, got: ${rawSeed}` };
      }
      parsed.seeds.push(seedNum);
    } else if (arg === "--directive-version") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...parsed, error: "argument --directive-version: expected one argument" };
      }
      parsed.directiveVersion = value;
      i += 1;
    } else if (arg?.startsWith("--directive-version=")) {
      parsed.directiveVersion = arg.slice("--directive-version=".length);
    } else if (arg === "--harness") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...parsed, error: "argument --harness: expected one argument" };
      }
      parsed.harness = value;
      i += 1;
    } else if (arg?.startsWith("--harness=")) {
      parsed.harness = arg.slice("--harness=".length);
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

/** Run eval:run and return the process exit code. */
export function run(argv: string[]): number {
  const args = parseArgs(argv);
  if (args.error !== undefined) {
    process.stderr.write(`eval:run: ${args.error}\n`);
    return 2;
  }

  const result = runGoldenEval({
    projectRoot: resolve(args.projectRoot),
    model: args.model,
    seeds: args.seeds.length > 0 ? args.seeds : undefined,
    directiveVersion: args.directiveVersion,
    harness: args.harness,
    persist: !args.noPersist,
  });

  if (result.record === null) {
    process.stderr.write(`${result.message}\n`);
    return result.code;
  }

  if (args.json) {
    process.stdout.write(`${JSON.stringify(result.record, null, 2)}\n`);
  } else {
    process.stdout.write(`${result.message}\n`);
  }

  return result.code;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(run(process.argv.slice(2)));
}
