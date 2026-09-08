import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import {
  lintShippedRegistry,
  resolveTaskContract,
  runWithCache,
} from "../cache/task-cache/index.js";
import type { TaskRunResult } from "../cache/task-cache/types.js";
import { defaultWhich } from "../doctor/which.js";
import { readCorePackageVersion } from "../engine-version.js";
import { containedRemove } from "../fs/contained-write.js";
import {
  applyProductFirstGateMode,
  EMPTY_AC_CAUSE,
  EMPTY_AC_REMEDY,
  isHygieneGate,
  isProductAcGate,
  isSoftEmptyAcText,
  resolveProductFirstCheckMode,
} from "../product-first-done-gate/index.js";
import { RunSummaryEmitter } from "../run-summary/emit.js";
import type { CheckGateOutcome } from "../run-summary/types.js";
import {
  runToolchainPreflight,
  SKIP_ALL_GATES,
  type ToolchainPreflightResult,
} from "../session/toolchain-preflight.js";
import { SUBPROCESS_MAX_BUFFER } from "../subprocess/max-buffer.js";
import {
  checkGateCliArgv,
  cliSpawnPlan,
  resolveGateDispatch,
  resolveGlobalCliBin,
} from "./cli-native-gates.js";
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
import {
  pruneSuiteTees,
  readTeeText,
  runSupervisedGate,
  type SupervisedGatePlan,
  type SupervisedGateResult,
  selectFailureSignalLines,
} from "./suite-gate-supervisor.js";

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
  /** #3282 / #3399: session id for run-summary lines (default: resolver). */
  readonly sessionId?: string;
  /** #3282: disable run-summary emission (tests). */
  readonly emitRunSummary?: boolean;
  /** PATH lookup seam (tests). */
  readonly which?: (name: string) => string | null;
  /** Override global CLI binary when dispatching CLI-native gates (#3335). */
  readonly cliBin?: string | null;
  /** Suite-gate supervisor seam (tests). Production uses `runSupervisedGate`. */
  readonly superviseSuite?: (plan: SupervisedGatePlan) => SupervisedGateResult;
}

function captureSpawn(
  taskBin: string,
  args: string[],
  opts: { cwd: string; env?: NodeJS.ProcessEnv; cli?: boolean },
): { exitCode: number; stdout: string; stderr: string; spawnError?: string } {
  const plan = opts.cli === true ? cliSpawnPlan(taskBin, args) : { command: taskBin, args };
  const result = spawnSync(plan.command, plan.args, {
    cwd: opts.cwd,
    encoding: "utf8",
    env: opts.env ?? process.env,
    maxBuffer: SUBPROCESS_MAX_BUFFER,
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

function firstImpactingMissingFinding(
  preflight: ToolchainPreflightResult | null,
): ToolchainPreflightResult["findings"][number] | undefined {
  const missing = preflight?.findings.filter((finding) => !finding.present) ?? [];
  const impacting = missing.filter((finding) => finding.impact !== "none");
  const priority = [
    "node",
    "task",
    "cli_dist",
    "package_manager",
    preflight?.packageManager,
    "npm",
    "pnpm",
  ];
  for (const tool of priority) {
    if (tool === null || tool === undefined) continue;
    const finding = impacting.find((candidate) => candidate.tool === tool);
    if (finding !== undefined) return finding;
  }
  return impacting[0] ?? missing[0];
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
  const modeResolution = resolveProductFirstCheckMode({
    environ: options.env ?? process.env,
    projectRoot: resolvedProject,
  });
  const baseGates = gatesForCheckTarget(target);
  const gates = applyProductFirstGateMode(baseGates, modeResolution.mode, checkGateId);
  const codeVersion = readCorePackageVersion();
  const sessionId = options.sessionId;
  const gateOutcomes: CheckGateOutcome[] = [];
  let lastSuiteTeeText = "";
  let lastSuiteTeeRel: string | null = null;
  pruneSuiteTees({ projectRoot: resolvedProject });

  const emitSummary = (exitCode: number, degraded: boolean): void => {
    if (options.emitRunSummary === false) return;
    try {
      const emitter = new RunSummaryEmitter({
        projectRoot: resolvedProject,
        sessionId,
        frameworkVersion: codeVersion,
        env: options.env,
        component: "check",
      });
      emitter.emitCheckInvocation({
        target,
        exit_code: exitCode,
        degraded,
        gates: gateOutcomes,
      });
      emitter.emitKnownToolTurnDenominator();
    } catch {
      // fail-open
    }
  };

  const finish = (exitCode: number, degradedFlag: boolean): number => {
    options.onCheckComplete?.({
      exitCode,
      gates: gateOutcomes,
      suiteTeeText: lastSuiteTeeText,
    });
    emitSummary(exitCode, degradedFlag);
    return exitCode;
  };

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
      return finish(2, false);
    }
  }

  const registryLint = lintShippedRegistry();
  if (!registryLint.ok) {
    for (const finding of registryLint.findings.filter((f) => f.kind === "under-declared-input")) {
      process.stderr.write(
        `check: task registry lint failed for ${finding.taskId}: ${finding.detail}\n`,
      );
    }
    return finish(2, false);
  }

  if (gates.length === 0) {
    process.stderr.write(`check: no gate list for target ${target}\n`);
    return finish(2, false);
  }

  // #3282: toolchain preflight — degraded skip when framework tools missing.
  const which = options.which ?? defaultWhich;
  const preflight: ToolchainPreflightResult | null =
    options.preflight === undefined
      ? runToolchainPreflight({
          projectRoot: resolvedProject,
          frameworkRoot: resolvedFramework,
          composedGates: gates,
          consumerDeposit: target === "check:consumer",
          which,
          env: options.env,
        })
      : options.preflight;
  const taskPresent =
    preflight === null || !preflight.findings.some((f) => f.tool === "task" && !f.present);
  const cliBin = options.cliBin !== undefined ? options.cliBin : resolveGlobalCliBin(which);

  // Expand SKIP_ALL_GATES sentinel to the live composition (avoids hardcode drift).
  const skipSet = new Set<string>();
  for (const id of preflight?.skipGateIds ?? []) {
    if (id === SKIP_ALL_GATES) {
      for (const g of gates) {
        skipSet.add(checkGateId(g));
      }
    } else {
      skipSet.add(id);
    }
  }
  const degraded = preflight?.degraded === true;

  if (preflight?.degraded) {
    for (const line of preflight.lines) {
      process.stderr.write(`${line}\n`);
    }
  }

  // When task/node are missing, every gate is skipped — report named skips and
  // exit 2 (config/environment), never exit 0 green (#3282 Greptile P1).
  // Missing framework tooling must not look like a clean product pass.
  if (degraded && skipSet.size > 0) {
    const allSkipped = gates.every((g) => skipSet.has(checkGateId(g)));
    if (allSkipped) {
      const skipped = gates.map((g) => {
        const id = checkGateId(g);
        const missing = firstImpactingMissingFinding(preflight);
        const cause = missing?.cause ?? "toolchain preflight degraded";
        const remedy = missing?.remedy ?? remedyForGate(id, cause);
        gateOutcomes.push({ id, status: "skipped", cause, remedy });
        return { id, cause, remedy };
      });
      writeLines(
        formatDegradedSkipReport({
          reason: "done-gate toolchain incomplete at check start",
          skipped,
          exitCode: 2,
        }),
      );
      return finish(2, true);
    }
  }

  for (const gateSpec of gates) {
    const gateId = checkGateId(gateSpec);

    // #3282: skip gates that require missing tools (e.g. pnpm-only suite).
    if (skipSet.has(gateId)) {
      const missing = firstImpactingMissingFinding(preflight);
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
    if (isProductAcGate(gateId)) {
      process.stderr.write(`check: product AC gate ${gateId} first (#3284)\n`);
    }
    options.onGateStart?.(gateId);
    const contract = resolveTaskContract(gateId);
    const dispatch = resolveGateDispatch({
      gateId,
      taskPresent,
      cliBin,
    });
    if ("skip" in dispatch) {
      process.stderr.write(
        `check: skipping gate ${gateId} (no runner) — cause: ${dispatch.cause}; remedy: ${dispatch.remedy}\n`,
      );
      gateOutcomes.push({
        id: gateId,
        status: "skipped",
        cause: dispatch.cause,
        remedy: dispatch.remedy,
      });
      options.onGateComplete?.(gateId, 0, false);
      continue;
    }
    const spawnBin = dispatch.mode === "cli" ? dispatch.bin : taskBin;
    const spawnArgs =
      dispatch.mode === "cli"
        ? checkGateCliArgv(gateSpec)
        : checkGateSpawnArgs(gateSpec, taskfilePath);
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
        if (
          isSuiteCheckGate(gateSpec) &&
          (options.superviseSuite !== undefined || options.gateSpawnFn === undefined)
        ) {
          const plan =
            dispatch.mode === "cli"
              ? cliSpawnPlan(spawnBin, spawnArgs)
              : { command: spawnBin, args: spawnArgs };
          const supervised = (options.superviseSuite ?? runSupervisedGate)({
            command: plan.command,
            args: plan.args,
            cwd,
            projectRoot: resolvedProject,
            env: options.env,
            timeoutMs: options.timeoutMs,
            sessionId,
            platform: process.platform,
          });
          lastSpawn = {
            exitCode: supervised.exitCode,
            stdout: supervised.stdout,
            stderr: supervised.stderr,
            spawnError: supervised.spawnError,
          };
          lastSuiteTeeRel = supervised.teeRel.length > 0 ? supervised.teeRel : null;
          lastSuiteTeeText =
            (supervised.teePath.length > 0 ? readTeeText(supervised.teePath) : "") ||
            `${supervised.stdout}\n${supervised.stderr}`;
          return {
            exitCode: supervised.exitCode,
            stdout: supervised.stdout,
            stderr: supervised.stderr,
            spawnError: supervised.spawnError,
          };
        }
        const spawned = options.gateSpawnFn
          ? options.gateSpawnFn(gateId, spawnBin, spawnArgs, {
              cwd,
              env: options.env,
            })
          : captureSpawn(spawnBin, spawnArgs, {
              cwd,
              env: options.env,
              cli: dispatch.mode === "cli",
            });
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

    // Fail-fast: do not start later gates (including suite) after a failure —
    // unless this is a hygiene gate under pressure mode (advisory only, #3284).
    if (result.exitCode !== 0) {
      const combinedOut = `${lastSpawn.stdout}\n${lastSpawn.stderr}`;
      if (isProductAcGate(gateId) && isSoftEmptyAcText(combinedOut)) {
        process.stderr.write(
          `check: verify:ac empty-resolution is not a green run (soft_empty); ` +
            `degraded (#3334) — cause: ${EMPTY_AC_CAUSE}; remedy: ${EMPTY_AC_REMEDY}\n`,
        );
        gateOutcomes.push({
          id: gateId,
          status: "skipped",
          exit_code: result.exitCode,
          cause: EMPTY_AC_CAUSE,
          remedy: EMPTY_AC_REMEDY,
          from_cache: result.fromCache,
        });
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
              cause: `skipped after ${gateId} soft_empty`,
              remedy: EMPTY_AC_REMEDY,
            });
          }
        }
        return finish(1, true);
      }
      if (modeResolution.hygieneAdvisory && isHygieneGate(gateId) && !isProductAcGate(gateId)) {
        process.stderr.write(
          `check: hygiene gate ${gateId} failed (exit ${result.exitCode}) but is ADVISORY ` +
            `under ${modeResolution.mode} mode — continuing (#3284)\n`,
        );
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
          status: "run",
          exit_code: result.exitCode,
          cause: `advisory hygiene failure: ${named.cause}`,
          remedy: named.remedy,
          from_cache: result.fromCache,
        });
        continue;
      }
      const named = formatNamedCauseFailure({
        gateId,
        exitCode: result.exitCode,
        stdout:
          isSuiteCheckGate(gateSpec) && lastSuiteTeeText.length > 0
            ? selectFailureSignalLines(lastSuiteTeeText)
            : lastSpawn.stdout,
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
      if (isProductAcGate(gateId)) {
        process.stderr.write(
          `check: product AC gate ${gateId} failed (exit ${result.exitCode}); ` +
            `failing closed before hygiene (#3284)\n`,
        );
        return finish(result.exitCode, degraded);
      }
      if (!isSuiteCheckGate(gateSpec)) {
        const remaining = gates.some(isSuiteCheckGate)
          ? "skipping remaining gates including suite"
          : "skipping remaining gates";
        process.stderr.write(
          `check: fast gate ${gateId} failed (exit ${result.exitCode}); ${remaining} (#3188)\n`,
        );
      }
      return finish(result.exitCode, degraded);
    }

    if (isSuiteCheckGate(gateSpec) && lastSuiteTeeRel !== null) {
      try {
        containedRemove({ root: resolvedProject, target: lastSuiteTeeRel });
      } catch {
        // best-effort green cleanup
      }
      lastSuiteTeeRel = null;
    }
    gateOutcomes.push({
      id: gateId,
      status: "run",
      exit_code: 0,
      from_cache: result.fromCache,
    });
  }

  // Partial degraded (some gates skipped for pnpm, others ran): never report a
  // green pass when required suite/toolchain gates were skipped (#3282 Greptile P1).
  const skippedOutcomes = gateOutcomes.filter((o) => o.status === "skipped");
  if (degraded && skippedOutcomes.length > 0) {
    const skipped = skippedOutcomes.map((o) => ({
      id: o.id,
      cause: o.cause ?? "degraded",
      remedy: o.remedy ?? remedyForGate(o.id, o.cause ?? "degraded"),
    }));
    writeLines(
      formatDegradedSkipReport({
        reason: "partial toolchain; skipped gates did not run",
        skipped,
        ran: gateOutcomes.filter((o) => o.status === "run").map((o) => o.id),
        exitCode: 2,
      }),
    );
    return finish(2, true);
  }

  return finish(0, degraded);
}
