#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { cmdPrCheckClosingKeywords } from "@deftai/directive-core/dist/pr-closing-keywords/main.js";

const DEFAULT_RANGE = "origin/master..HEAD";

/** Build argv that wires the existing detector (#3969 / #737). */
export function buildClosingKeywordsCheckArgv(
  env: NodeJS.ProcessEnv,
  extra: readonly string[] = [],
): string[] {
  const raw = env.GITHUB_PR_NUMBER ?? env.PR_NUMBER;
  const pr = raw?.trim() ?? "";
  if (/^\d+$/.test(pr)) {
    return ["--mode", "fp", "--pr", pr, ...extra];
  }
  return ["--mode", "fp", "--from-git-range", DEFAULT_RANGE, ...extra];
}

export function run(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
  invoke: (args: readonly string[]) => number = cmdPrCheckClosingKeywords,
): number {
  return invoke(buildClosingKeywordsCheckArgv(env, argv));
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(run(process.argv.slice(2)));
}
