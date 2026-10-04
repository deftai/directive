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
  let sessionId: string | null = null;
  let parseError: string | null = null;
  let workerGithubAuthMode: string | null = null;
  let expectedWorkerLogin: string | null = null;
  let skipRouting = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const takeValue = (): string | null => {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        parseError ??= `argument ${arg}: expected one argument`;
        return null;
      }
      i += 1;
      return value;
    };
    if (arg === "--stories") {
      const value = takeValue();
      if (value !== null) stories.push(value);
    } else if (arg === "--paths") {
      const value = takeValue();
      if (value !== null) paths.push(value);
    } else if (arg === "--group") {
      group = takeValue();
    } else if (arg === "--worktree-map") {
      worktreeMap = takeValue();
    } else if (arg === "--base-branch") {
      baseBranch = takeValue() ?? baseBranch;
    } else if (arg === "--autonomous") {
      autonomous = true;
    } else if (arg === "--allocation-plan-id") {
      allocationPlanId = takeValue();
    } else if (arg === "--batching-rationale") {
      batchingRationale = takeValue();
    } else if (arg === "--operator-approval") {
      operatorApproval = takeValue();
    } else if (arg === "--no-create-worktrees") {
      noCreateWorktrees = true;
    } else if (arg === "--output") {
      output = takeValue();
    } else if (arg === "--gate-clearances") {
      gateClearancesPath = takeValue();
    } else if (arg === "--enforce-gates") {
      enforceGatesFlag = true;
    } else if (arg === "--no-audit") {
      noAudit = true;
    } else if (arg === "--project-root") {
      projectRoot = takeValue() ?? projectRoot;
    } else if (arg === "--session-id") {
      const value = takeValue();
      if (value === null) {
        // Keep an explicit invalid sentinel so swarmLaunch fails closed rather
        // than falling back to ambient identity or minting a different owner.
        sessionId = "";
      } else {
        sessionId = value;
      }
    } else if (arg?.startsWith("--session-id=") === true) {
      const value = arg.slice("--session-id=".length);
      sessionId = value.startsWith("--") ? "" : value;
    } else if (arg === "--worker-github-auth-mode") {
      workerGithubAuthMode = takeValue();
    } else if (arg?.startsWith("--worker-github-auth-mode=") === true) {
      workerGithubAuthMode = arg.slice("--worker-github-auth-mode=".length);
    } else if (arg === "--expected-worker-login") {
      expectedWorkerLogin = takeValue();
    } else if (arg?.startsWith("--expected-worker-login=") === true) {
      expectedWorkerLogin = arg.slice("--expected-worker-login=".length);
    } else if (arg === "--skip-routing") {
      skipRouting = true;
    }
  }

  return {
    parseError,
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
    sessionId,
    workerGithubAuthMode,
    skipRouting,
    expectedPrincipal:
      expectedWorkerLogin !== null && expectedWorkerLogin.trim().length > 0
        ? { kind: "user", login: expectedWorkerLogin.trim() }
        : null,
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
