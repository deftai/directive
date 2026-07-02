#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { verifyReviewClean } from "./verify-review-clean.js";

export function verifyReviewCleanMain(argv: string[] = process.argv.slice(2)): number {
  const prNumbers: number[] = [];
  const cohortGlobs: string[] = [];
  const ciIgnoreChecks: string[] = [];
  let repo: string | null = null;
  let emitJson = false;
  let skipCi = false;
  let skipSlizard = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--cohort" && argv[i + 1] !== undefined) {
      cohortGlobs.push(argv[i + 1] ?? "");
      i += 1;
    } else if (arg === "--repo" && argv[i + 1] !== undefined) {
      repo = argv[i + 1] ?? null;
      i += 1;
    } else if (arg === "--json") {
      emitJson = true;
    } else if (arg === "--skip-ci") {
      skipCi = true;
    } else if (arg === "--skip-slizard") {
      skipSlizard = true;
    } else if (arg === "--ci-ignore-check" && argv[i + 1] !== undefined) {
      ciIgnoreChecks.push(argv[i + 1] ?? "");
      i += 1;
    } else if (arg?.startsWith("--ci-ignore-check=")) {
      ciIgnoreChecks.push(arg.slice("--ci-ignore-check=".length));
    } else if (arg !== undefined && /^\d+$/.test(arg)) {
      prNumbers.push(Number.parseInt(arg, 10));
    }
  }
  const result = verifyReviewClean({
    prNumbers,
    cohortGlobs,
    repo,
    emitJson,
    skipCi,
    skipSlizard,
    ciIgnoreChecks,
  });
  if (result.stdout.length > 0) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr.length > 0) {
    process.stderr.write(result.stderr);
  }
  return result.exitCode;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(verifyReviewCleanMain());
}
