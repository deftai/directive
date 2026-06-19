#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { swarmLaunch } from "./launch.js";

export function parseLaunchArgv(argv: readonly string[]): Parameters<typeof swarmLaunch>[0] {
  const stories: string[] = [];
  const paths: string[] = [];
  let group: string | null = null;
  let worktreeMap: string | null = null;
  let baseBranch = "master";
  let autonomous = false;
  let allocationPlanId: string | null = null;
  let batchingRationale: string | null = null;
  let operatorApproval: string | null = null;
  let noCreateWorktrees = false;
  let output: string | null = null;
  let gateClearancesPath: string | null = null;
  let enforceGatesFlag = false;
  let noAudit = false;
  let projectRoot = ".";

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--stories" && next !== undefined) {
      stories.push(next);
      i += 1;
    } else if (arg === "--paths" && next !== undefined) {
      paths.push(next);
      i += 1;
    } else if (arg === "--group" && next !== undefined) {
      group = next;
      i += 1;
    } else if (arg === "--worktree-map" && next !== undefined) {
      worktreeMap = next;
      i += 1;
    } else if (arg === "--base-branch" && next !== undefined) {
      baseBranch = next;
      i += 1;
    } else if (arg === "--autonomous") {
      autonomous = true;
    } else if (arg === "--allocation-plan-id" && next !== undefined) {
      allocationPlanId = next;
      i += 1;
    } else if (arg === "--batching-rationale" && next !== undefined) {
      batchingRationale = next;
      i += 1;
    } else if (arg === "--operator-approval" && next !== undefined) {
      operatorApproval = next;
      i += 1;
    } else if (arg === "--no-create-worktrees") {
      noCreateWorktrees = true;
    } else if (arg === "--output" && next !== undefined) {
      output = next;
      i += 1;
    } else if (arg === "--gate-clearances" && next !== undefined) {
      gateClearancesPath = next;
      i += 1;
    } else if (arg === "--enforce-gates") {
      enforceGatesFlag = true;
    } else if (arg === "--no-audit") {
      noAudit = true;
    } else if (arg === "--project-root" && next !== undefined) {
      projectRoot = next;
      i += 1;
    }
  }

  return {
    stories,
    paths,
    group,
    worktreeMap,
    baseBranch,
    autonomous,
    allocationPlanId,
    batchingRationale,
    operatorApproval,
    noCreateWorktrees,
    output,
    gateClearancesPath,
    enforceGatesFlag,
    noAudit,
    projectRoot,
  };
}

export function launchMain(argv: string[] = process.argv.slice(2)): number {
  const result = swarmLaunch(parseLaunchArgv(argv));
  if (result.stdout.length > 0) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr.length > 0) {
    process.stderr.write(result.stderr);
  }
  return result.exitCode;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(launchMain());
}
