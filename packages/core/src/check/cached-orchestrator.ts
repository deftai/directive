import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import {
  lintShippedRegistry,
  resolveTaskContract,
  runWithCache,
} from "../cache/task-cache/index.js";
import type { TaskRunResult } from "../cache/task-cache/types.js";
import { readCorePackageVersion } from "../engine-version.js";
import { RunSummaryEmitter } from "../run-summary/emit.js";
import type { CheckGateOutcome } from "../run-summary/types.js";
import {
  runToolchainPreflight,
  type ToolchainPreflightResult,
} from "../session/toolchain-preflight.js";
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
import { formatDegradedSkipReport, formatNamedCauseFailure, remedyForGate } from "./named-cause.js";

export interface CachedCheckOptions extends CheckOrchestratorSeams {
  readonly onGateStart?: (gateId: string) => void;
  readonly onGateComplete?: (gateId: string, exitCode: number, fromCache: boolean) => void;
  readonly gateSpawnFn?: (
    gateId: string,
    taskBin: string,
    taskArgs: string[],
    opts: { cwd: string; env?: NodeJS.ProcessEnv },
  ) => Pick<TaskRunResult, "exitCode" | "stdout" | "stderr"> & { spawnError?: string };
  /**
   * #3282: inject preflight (tests). When omitted, runs live toolchain preflight.
   * Pass `null` to skip preflight entirely (legacy test paths).
   */
  readonly preflight?: ToolchainPreflightResult | null;
  /** #3282: session id for run-summary lines (default: new UUID). */
  readonly sessionId?: string;
  /** #3282: disable run-summary emission (tests). */
  readonly emitRunSummary?: boolean;
}

function captureSpawn(
  taskBin: string,
  args: string[],
  opts: { cwd: string; env?: NodeJS.ProcessEnv },
): { exitCode: number; stdout: string; stderr: string; spawnError?: string } {
  const result = spawnSync(taskBin, args, {
    cwd: opts.cwd,
    encoding: "utf8",
    env: opts.env ?? process.env,
  });
  if (result.error !== undefined) {
    return {
      exitCode: result.status ?? 1,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      spawnError: result.error.message,
    };
  }
  return {
    exitCode: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function writeLines(lines: readonly string[], stream: "stdout" | "stderr" = "stderr"): void {
  const write =
    stream === "stdout"
      ? process.stdout.write.bind(process.stdout)
      : process.stderr.write.bind(process.stderr);
  for (const line of lines) {
    write(`${line}\n`);
  }
}

/**
 * Run check gates sequentially with content-hash caching (#1713).
 * Falls back to fail-open execution for undeclared / non-cacheable gates.
 *
 * Gate order is fast-before-slow (#3188): non-suite gates complete (or fail)
 * before any suite gate (`ts:check-lane` / vitest+coverage) is started. A
 * non-zero exit aborts the loop immediately — the suite never starts after a
 * fast-gate failure (observable via `onGateStart` / suite start log).
 *
 * #3282: toolchain preflight enables degraded skip report when go-task/pnpm
 * are missing; gate failures print named cause + remedy; run-summary JSONL
 * is appended when DEFT_RUN_SUMMARY_PATH is set (fail-open).
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
  const gates = gatesForCheckTarget(target);
  const codeVersion = readCorePackageVersion();
  const sessionId = options.sessionId ?? randomUUID();
  const gateOutcomes: CheckGateOutcome[] = [];

  const emitSummary = (exitCode: number, degraded: boolean): void => {
    if (options.emitRunSummary === false) return;
    try {
      const emitter = new RunSummaryEmitter({
        projectRoot: resolvedProject,
        sessionId,
        frameworkVersion: codeVersion,
        env: options.env,
      });
      emitter.emitCheckInvocation({
        target,
        exit_code: exitCode,
        degraded,
        gates: gateOutcomes,
      });
    } catch {
      // fail-open
    }
  };

  // #3070: fail loud with deposit-repair guidance when consumer check-graph
  // includes (e.g. tasks/verify.yml for verify:orphan-active) are missing,
  // instead of opaque go-task "Task does not exist" exit 200/201.
  if (target === "check:consumer") {
    const integrity = evaluateConsumerGateIntegrity(resolvedFramework);
    if (!integrity.ok) {
      process.stderr.write(formatConsumerGateIntegrityFailure(integrity));
      emitSummary(2, false);
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
    emitSummary(2, false);
    return 2;
  }

  if (gates.length === 0) {
    process.stderr.write(`check: no gate list for target ${target}\n`);
    emitSummary(2, false);
    return 2;
  }

  // #3282: toolchain preflight — degraded skip when framework tools missing.
  const preflight: ToolchainPreflightResult | null =
    options.preflight === undefined
      ? runToolchainPreflight({
          projectRoot: resolvedProject,
          frameworkRoot: resolvedFramework,
        })
      : options.preflight;

  const skipSet = new Set(preflight?.skipGateIds ?? []);
  const degraded = preflight?.degraded === true;

  if (preflight?.degraded) {
    for (const line of preflight.lines) {
      process.stderr.write(`${line}\n`);
    }
  }

  // When task/node are missing, every task-dependent gate is skipped — complete
  // with explicit skip report and exit 0 (do not fail closed solely for missing
  // framework tooling).
  if (degraded && skipSet.size > 0) {
    const allSkipped = gates.every((g) => skipSet.has(checkGateId(g)));
    if (allSkipped) {
      const skipped = gates.map((g) => {
        const id = checkGateId(g);
        const cause =
          preflight?.findings.find((f) => !f.present)?.cause ?? "toolchain preflight degraded";
        const remedy =
          preflight?.findings.find((f) => !f.present)?.remedy ?? remedyForGate(id, cause);
        gateOutcomes.push({ id, status: "skipped", cause, remedy });
        return { id, cause, remedy };
      });
      writeLines(
        formatDegradedSkipReport({
          reason: "done-gate toolchain incomplete at check start",
          skipped,
        }),
      );
      emitSummary(0, true);
      return 0;
    }
  }

  for (const gateSpec of gates) {
    const gateId = checkGateId(gateSpec);

    // #3282: skip gates that require missing tools (e.g. pnpm-only suite).
    if (skipSet.has(gateId)) {
      const missing = preflight?.findings.find((f) => !f.present);
      const cause = missing?.cause ?? "toolchain preflight marked gate skippable";
      const remedy = missing?.remedy ?? remedyForGate(gateId, cause);
      process.stderr.write(
        `check: skipping gate ${gateId} (degraded) — cause: ${cause}; remedy: ${remedy}\n`,
      );
      gateOutcomes.push({ id: gateId, status: "skipped", cause, remedy });
      options.onGateStart?.(gateId);
      options.onGateComplete?.(gateId, 0, false);
      continue;
    }

    // #3188: log suite entry so operators/tests can prove fast failures never
    // reach vitest+coverage (suite gates are ordered last in gate-lists).
    if (isSuiteCheckGate(gateSpec)) {
      process.stderr.write(`check: starting suite gate ${gateId} after fast preflight (#3188)\n`);
    }
    options.onGateStart?.(gateId);
    const contract = resolveTaskContract(gateId);
    const taskArgs = checkGateSpawnArgs(gateSpec, taskfilePath);
    let lastSpawn: {
      exitCode: number;
      stdout: string;
      stderr: string;
      spawnError?: string;
    } = { exitCode: 0, stdout: "", stderr: "" };

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
        lastSpawn = {
          exitCode: spawned.exitCode,
          stdout: spawned.stdout,
          stderr: spawned.stderr,
          spawnError: "spawnError" in spawned ? spawned.spawnError : undefined,
        };
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

    // Fail-fast: do not start later gates (including suite) after a failure.
    if (result.exitCode !== 0) {
      const named = formatNamedCauseFailure({
        gateId,
        exitCode: result.exitCode,
        stdout: lastSpawn.stdout,
        stderr: lastSpawn.stderr,
        spawnError: lastSpawn.spawnError,
      });
      writeLines(named.lines);
      gateOutcomes.push({
        id: gateId,
        status: "failed",
        exit_code: result.exitCode,
        cause: named.cause,
        remedy: named.remedy,
        from_cache: result.fromCache,
      });
      // Mark remaining as skipped for the summary (not run).
      let sawCurrent = false;
      for (const later of gates) {
        const id = checkGateId(later);
        if (!sawCurrent) {
          if (id === gateId) sawCurrent = true;
          continue;
        }
        if (!gateOutcomes.some((o) => o.id === id)) {
          gateOutcomes.push({
            id,
            status: "skipped",
            cause: `skipped after ${gateId} failed`,
            remedy: "Fix the failed gate above, then re-run task check",
          });
        }
      }
      if (!isSuiteCheckGate(gateSpec)) {
        const remaining = gates.some(isSuiteCheckGate)
          ? "skipping remaining gates including suite"
          : "skipping remaining gates";
        process.stderr.write(
          `check: fast gate ${gateId} failed (exit ${result.exitCode}); ${remaining} (#3188)\n`,
        );
      }
      emitSummary(result.exitCode, degraded);
      return result.exitCode;
    }

    gateOutcomes.push({
      id: gateId,
      status: "run",
      exit_code: 0,
      from_cache: result.fromCache,
    });
  }

  // Partial degraded (some gates skipped for pnpm, others ran): surface summary.
  if (degraded && gateOutcomes.some((o) => o.status === "skipped")) {
    const skipped = gateOutcomes
      .filter((o) => o.status === "skipped")
      .map((o) => ({
        id: o.id,
        cause: o.cause ?? "degraded",
        remedy: o.remedy ?? remedyForGate(o.id, o.cause ?? "degraded"),
      }));
    writeLines(
      formatDegradedSkipReport({
        reason: "partial toolchain; product/hygiene gates that could run completed",
        skipped,
        ran: gateOutcomes.filter((o) => o.status === "run").map((o) => o.id),
      }),
    );
  }

  emitSummary(0, degraded);
  return 0;
}
