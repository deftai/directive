import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import {
  lintShippedRegistry,
  resolveTaskContract,
  runWithCache,
} from "../cache/task-cache/index.js";
import type { TaskRunResult } from "../cache/task-cache/types.js";
import { readCorePackageVersion } from "../engine-version.js";
import {
  applyProductFirstGateMode,
  isHygieneGate,
  isProductAcGate,
  resolveProductFirstCheckMode,
} from "../product-first-done-gate/index.js";
import {
  evaluateConsumerGateIntegrity,
  formatConsumerGateIntegrityFailure,
} from "./consumer-gate-integrity.js";
import { type CheckOrchestratorSeams, resolveCheckTarget } from "./context.js";
import {
  checkGateId,
  checkGateSpawnArgs,
  gatesForCheckTarget,
  isSuiteCheckGate,
} from "./gate-lists.js";

export interface CachedCheckOptions extends CheckOrchestratorSeams {
  readonly onGateStart?: (gateId: string) => void;
  readonly onGateComplete?: (gateId: string, exitCode: number, fromCache: boolean) => void;
  readonly gateSpawnFn?: (
    gateId: string,
    taskBin: string,
    taskArgs: string[],
    opts: { cwd: string; env?: NodeJS.ProcessEnv },
  ) => Pick<TaskRunResult, "exitCode" | "stdout" | "stderr">;
}

function captureSpawn(
  taskBin: string,
  args: string[],
  opts: { cwd: string; env?: NodeJS.ProcessEnv },
): { exitCode: number; stdout: string; stderr: string } {
  const result = spawnSync(taskBin, args, {
    cwd: opts.cwd,
    encoding: "utf8",
    env: opts.env ?? process.env,
  });
  return {
    exitCode: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

/**
 * Run check gates sequentially with content-hash caching (#1713).
 * Falls back to fail-open execution for undeclared / non-cacheable gates.
 *
 * Gate order (#3284 / #3188):
 *  1. Product AC (`verify:ac`) first — fail-fast; never skippable when commands exist
 *  2. Hygiene preflight (may be advisory under pressure / degraded)
 *  3. Suite last (`ts:check-lane`)
 *
 * Modes (env / ceremony dial / hard budget — see resolveProductFirstCheckMode):
 *  - full: AC hard → hygiene hard → suite
 *  - pressure: AC hard → hygiene advisory → suite
 *  - rapid: AC only (ceremony dial rapid/minimal positive content)
 */
export function dispatchCachedTaskCheck(
  frameworkRoot: string,
  projectRoot: string,
  options: CachedCheckOptions = {},
): number {
  const resolvedFramework = resolve(frameworkRoot);
  const resolvedProject = resolve(projectRoot);
  const taskfilePath = join(resolvedFramework, "Taskfile.yml");
  const taskBin = options.taskBin ?? "task";
  const target = resolveCheckTarget(resolvedFramework, resolvedProject);
  const cwd = target === "check:framework-source" ? resolvedFramework : resolvedProject;
  const modeResolution = resolveProductFirstCheckMode({
    environ: options.env ?? process.env,
    projectRoot: resolvedProject,
  });
  const baseGates = gatesForCheckTarget(target);
  const gates = applyProductFirstGateMode(baseGates, modeResolution.mode, checkGateId);
  const codeVersion = readCorePackageVersion();

  if (modeResolution.mode !== "full") {
    process.stderr.write(
      `check: product-first mode=${modeResolution.mode} ` +
        `(sources=${modeResolution.sources.join(",")}; ` +
        `hygieneAdvisory=${modeResolution.hygieneAdvisory}; acOnly=${modeResolution.acOnly}) (#3284)\n`,
    );
  }

  // #3070: fail loud with deposit-repair guidance when consumer check-graph
  // includes (e.g. tasks/verify.yml for verify:orphan-active) are missing,
  // instead of opaque go-task "Task does not exist" exit 200/201.
  if (target === "check:consumer") {
    const integrity = evaluateConsumerGateIntegrity(resolvedFramework);
    if (!integrity.ok) {
      process.stderr.write(formatConsumerGateIntegrityFailure(integrity));
      return 2;
    }
  }

  const registryLint = lintShippedRegistry();
  if (!registryLint.ok) {
    for (const finding of registryLint.findings.filter((f) => f.kind === "under-declared-input")) {
      process.stderr.write(
        `check: task registry lint failed for ${finding.taskId}: ${finding.detail}\n`,
      );
    }
    return 2;
  }

  if (gates.length === 0) {
    process.stderr.write(`check: no gate list for target ${target}\n`);
    return 2;
  }

  for (const gateSpec of gates) {
    const gateId = checkGateId(gateSpec);
    // #3188: log suite entry so operators/tests can prove fast failures never
    // reach vitest+coverage (suite gates are ordered last in gate-lists).
    if (isSuiteCheckGate(gateSpec)) {
      process.stderr.write(`check: starting suite gate ${gateId} after fast preflight (#3188)\n`);
    }
    if (isProductAcGate(gateId)) {
      process.stderr.write(`check: product AC gate ${gateId} first (#3284)\n`);
    }
    options.onGateStart?.(gateId);
    const contract = resolveTaskContract(gateId);
    const taskArgs = checkGateSpawnArgs(gateSpec, taskfilePath);
    const result = runWithCache({
      projectRoot: cwd,
      contract,
      codeVersion,
      noCache: options.noCache,
      runner: () => {
        const spawned = options.gateSpawnFn
          ? options.gateSpawnFn(gateId, taskBin, taskArgs, {
              cwd,
              env: options.env,
            })
          : captureSpawn(taskBin, taskArgs, { cwd, env: options.env });
        if (spawned.stdout.length > 0) {
          process.stdout.write(spawned.stdout);
        }
        if (spawned.stderr.length > 0) {
          process.stderr.write(spawned.stderr);
        }
        return spawned;
      },
    });
    options.onGateComplete?.(gateId, result.exitCode, result.fromCache);
    // Fail-fast: do not start later gates (including suite) after a failure —
    // unless this is a hygiene gate under pressure mode (advisory only, #3284).
    if (result.exitCode !== 0) {
      if (modeResolution.hygieneAdvisory && isHygieneGate(gateId) && !isProductAcGate(gateId)) {
        process.stderr.write(
          `check: hygiene gate ${gateId} failed (exit ${result.exitCode}) but is ADVISORY ` +
            `under ${modeResolution.mode} mode — continuing (#3284)\n`,
        );
        continue;
      }
      if (isProductAcGate(gateId)) {
        process.stderr.write(
          `check: product AC gate ${gateId} failed (exit ${result.exitCode}); ` +
            `failing closed before hygiene (#3284)\n`,
        );
        return result.exitCode;
      }
      if (!isSuiteCheckGate(gateSpec)) {
        const remaining = gates.some(isSuiteCheckGate)
          ? "skipping remaining gates including suite"
          : "skipping remaining gates";
        process.stderr.write(
          `check: fast gate ${gateId} failed (exit ${result.exitCode}); ${remaining} (#3188)\n`,
        );
      }
      return result.exitCode;
    }
  }

  return 0;
}
