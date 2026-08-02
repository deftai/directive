#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { finalizeCohort } from "./finalize-cohort.js";

export function parseFinalizeCohortArgv(
  argv: readonly string[],
): Parameters<typeof finalizeCohort>[0] {
  const prNumbers: number[] = [];
  const storyTokens: string[] = [];
  let repo: string | null = null;
  let projectRoot = ".";
  let baseBranch = "master";
  let deliveryBranch: string | null = null;
  let label: string | null = null;
  let dryRun = false;
  let noCommit = false;
  let noOpenPr = false;
  let emitJson = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--pr" && next !== undefined) {
      for (const piece of next.split(",")) {
        const trimmed = piece.trim();
        if (/^\d+$/.test(trimmed)) {
          prNumbers.push(Number.parseInt(trimmed, 10));
        }
      }
      i += 1;
    } else if (arg?.startsWith("--pr=")) {
      for (const piece of arg.slice("--pr=".length).split(",")) {
        const trimmed = piece.trim();
        if (/^\d+$/.test(trimmed)) {
          prNumbers.push(Number.parseInt(trimmed, 10));
        }
      }
    } else if (arg === "--stories" && next !== undefined) {
      storyTokens.push(next);
      i += 1;
    } else if (arg === "--repo" && next !== undefined) {
      repo = next;
      i += 1;
    } else if (arg?.startsWith("--repo=")) {
      repo = arg.slice("--repo=".length);
    } else if (arg === "--project-root" && next !== undefined) {
      projectRoot = next;
      i += 1;
    } else if (arg === "--base-branch" && next !== undefined) {
      baseBranch = next;
      i += 1;
    } else if (arg === "--delivery-branch" && next !== undefined) {
      deliveryBranch = next;
      i += 1;
    } else if (arg?.startsWith("--delivery-branch=")) {
      deliveryBranch = arg.slice("--delivery-branch=".length);
    } else if (arg === "--label" && next !== undefined) {
      label = next;
      i += 1;
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--no-commit") {
      noCommit = true;
    } else if (arg === "--no-open-pr") {
      noOpenPr = true;
    } else if (arg === "--json") {
      emitJson = true;
    } else if (arg !== undefined && !arg.startsWith("-")) {
      storyTokens.push(arg);
    }
  }

  return {
    prNumbers,
    storyTokens,
    repo,
    projectRoot,
    baseBranch,
    deliveryBranch,
    label,
    dryRun,
    noCommit,
    noOpenPr,
    emitJson,
  };
}

export function finalizeCohortMain(argv: string[] = process.argv.slice(2)): number {
  const result = finalizeCohort(parseFinalizeCohortArgv(argv));
  if (result.stdout.length > 0) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr.length > 0) {
    process.stderr.write(result.stderr);
  }
  return result.exitCode;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(finalizeCohortMain());
}
