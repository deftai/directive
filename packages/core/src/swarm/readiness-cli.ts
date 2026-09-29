#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import {
  expandReadinessPaths,
  readinessReport,
  SWARM_BLOCK_REMEDIATION_HINT,
  scaffoldSwarmDraft,
} from "./readiness.js";

function takeValue(
  argv: string[],
  i: number,
  arg: string,
): { value: string | null; next: number; error?: string } {
  const value = argv[i + 1];
  if (value === undefined || value.startsWith("--")) {
    return { value: null, next: i, error: `argument ${arg}: expected one argument` };
  }
  return { value, next: i + 1 };
}

function parseBool(raw: string): boolean | null {
  const v = raw.trim().toLowerCase();
  if (v === "true" || v === "1" || v === "yes") return true;
  if (v === "false" || v === "0" || v === "no") return false;
  return null;
}

export function readinessMain(argv: string[] = process.argv.slice(2)): number {
  let projectRoot = ".";
  let scaffold = false;
  let scaffoldPath: string | null = null;
  let soloHeadless = false;
  const paths: string[] = [];
  const fileScope: string[] = [];
  const verifyCommands: string[] = [];
  const expectedOutputs: string[] = [];
  const dependsOn: string[] = [];
  let conflictGroup: string | undefined;
  let size: string | undefined;
  let fileScopeConfidence: string | undefined;
  let modelTier: string | undefined;
  let readiness = "ready";
  let parallelSafe: boolean | null = null;
  let parseError: string | null = null;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--project-root") {
      const taken = takeValue(argv, i, arg);
      if (taken.error) {
        parseError ??= taken.error;
        continue;
      }
      projectRoot = taken.value ?? ".";
      i = taken.next;
    } else if (arg === "--scaffold") {
      scaffold = true;
      const taken = takeValue(argv, i, arg);
      if (taken.error) {
        parseError ??= taken.error;
        continue;
      }
      scaffoldPath = taken.value;
      i = taken.next;
    } else if (arg === "--solo-headless") {
      soloHeadless = true;
    } else if (arg === "--file-scope") {
      const taken = takeValue(argv, i, arg);
      if (taken.error) {
        parseError ??= taken.error;
        continue;
      }
      if (taken.value) fileScope.push(taken.value);
      i = taken.next;
    } else if (arg === "--verify-command") {
      const taken = takeValue(argv, i, arg);
      if (taken.error) {
        parseError ??= taken.error;
        continue;
      }
      if (taken.value) verifyCommands.push(taken.value);
      i = taken.next;
    } else if (arg === "--expected-output") {
      const taken = takeValue(argv, i, arg);
      if (taken.error) {
        parseError ??= taken.error;
        continue;
      }
      if (taken.value) expectedOutputs.push(taken.value);
      i = taken.next;
    } else if (arg === "--depends-on") {
      const taken = takeValue(argv, i, arg);
      if (taken.error) {
        parseError ??= taken.error;
        continue;
      }
      if (taken.value) dependsOn.push(taken.value);
      i = taken.next;
    } else if (arg === "--conflict-group") {
      const taken = takeValue(argv, i, arg);
      if (taken.error) {
        parseError ??= taken.error;
        continue;
      }
      conflictGroup = taken.value ?? undefined;
      i = taken.next;
    } else if (arg === "--size") {
      const taken = takeValue(argv, i, arg);
      if (taken.error) {
        parseError ??= taken.error;
        continue;
      }
      size = taken.value ?? undefined;
      i = taken.next;
    } else if (arg === "--file-scope-confidence") {
      const taken = takeValue(argv, i, arg);
      if (taken.error) {
        parseError ??= taken.error;
        continue;
      }
      fileScopeConfidence = taken.value ?? undefined;
      i = taken.next;
    } else if (arg === "--model-tier") {
      const taken = takeValue(argv, i, arg);
      if (taken.error) {
        parseError ??= taken.error;
        continue;
      }
      modelTier = taken.value ?? undefined;
      i = taken.next;
    } else if (arg === "--readiness") {
      const taken = takeValue(argv, i, arg);
      if (taken.error) {
        parseError ??= taken.error;
        continue;
      }
      readiness = taken.value ?? readiness;
      i = taken.next;
    } else if (arg === "--parallel-safe") {
      const taken = takeValue(argv, i, arg);
      if (taken.error) {
        parseError ??= taken.error;
        continue;
      }
      const parsed = taken.value !== null ? parseBool(taken.value) : null;
      if (parsed === null) {
        parseError ??= "argument --parallel-safe: expected true|false";
      } else {
        parallelSafe = parsed;
      }
      i = taken.next;
    } else if (arg !== undefined && !arg.startsWith("-")) {
      paths.push(arg);
    }
  }

  if (parseError !== null) {
    process.stderr.write(`${parseError}\n`);
    return 2;
  }

  if (scaffold) {
    if (scaffoldPath === null || scaffoldPath.trim().length === 0) {
      process.stderr.write("argument --scaffold: expected xBRIEF path\n");
      return 2;
    }
    if (parallelSafe === null) {
      process.stderr.write(
        "scaffold requires explicit --parallel-safe true|false (no invent from issue text)\n",
      );
      return 2;
    }
    if (size === undefined || fileScopeConfidence === undefined) {
      process.stderr.write("scaffold requires explicit --size and --file-scope-confidence\n");
      return 2;
    }
    const result = scaffoldSwarmDraft({
      projectRoot,
      vbriefPath: scaffoldPath,
      fileScope,
      verifyCommands,
      expectedOutputs: expectedOutputs.length > 0 ? expectedOutputs : undefined,
      dependsOn: dependsOn.length > 0 ? dependsOn : undefined,
      conflictGroup,
      size,
      fileScopeConfidence,
      modelTier,
      readiness,
      parallelSafe,
    });
    if (!result.ok) {
      process.stderr.write(`${result.error}\n${SWARM_BLOCK_REMEDIATION_HINT}\n`);
      return 1;
    }
    process.stdout.write(
      `OK scaffold wrote plan.metadata.swarm keys [${result.writtenKeys.join(", ")}] to ${result.path}\n`,
    );
    return 0;
  }

  const expanded = expandReadinessPaths(projectRoot, paths);
  const { exitCode, report } = readinessReport(projectRoot, expanded, {
    soloHeadless,
  });
  process.stdout.write(`${report}\n`);
  return exitCode;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(readinessMain());
}
