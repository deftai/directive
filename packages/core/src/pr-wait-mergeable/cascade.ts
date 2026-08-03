import { evaluateIntentCeilingFromEnv } from "../policy/intent-ceiling.js";
import {
  type AgentMergeEvaluateResult,
  evaluateAgentMerge,
} from "../policy/require-human-merge.js";
import { reconcileUmbrellas, renderUmbrellasReport } from "../vbrief-reconcile/umbrellas.js";
import { classifyMonitorOutcome, parseMonitorPayload } from "./classify.js";
import { EXIT_CONFIG_ERROR, EXIT_MERGED, EXIT_TIMEOUT_OR_ESCALATION } from "./constants.js";
import { makeResult } from "./result.js";
import { evaluateSemanticGreen, type SemanticGreenFn } from "./semantic-green.js";
import type { MergeFn, MonitorFn, ProtectedCheckFn, WaitMergeableResult } from "./types.js";
import { runGhMerge, runMonitor, runProtectedCheck } from "./wrappers.js";

/** Node module-not-found / missing script — not a protected-issue overlap (#2667). */
function isProtectedCheckConfigFailure(stderr: string): boolean {
  const tail = stderr.trim();
  return (
    tail.includes("MODULE_NOT_FOUND") ||
    tail.includes("Cannot find module") ||
    tail.includes("protected-check script not found:")
  );
}

/** Post-merge umbrella checklist + current-shape refresh (#1649). */
export type UmbrellaReconcileFn = (projectRoot: string, repo: string) => void;

function defaultPostMergeUmbrellaReconcile(projectRoot: string, repo: string): void {
  const [, umOutcome] = reconcileUmbrellas(projectRoot, { repo });
  if (umOutcome.changed.length > 0 || umOutcome.errors.length > 0) {
    process.stderr.write(`${renderUmbrellasReport(umOutcome)}\n`);
  }
}

export interface WaitMergeableOptions {
  readonly protectedFn?: ProtectedCheckFn;
  readonly monitorFn?: MonitorFn;
  readonly mergeFn?: MergeFn;
  readonly semanticGreenFn?: SemanticGreenFn;
  /** Enable merge-cascade semantic-green gate (#2385). */
  readonly cascadeMode?: boolean;
  /** After a prior cascade merge, require target-branch CI green at HEAD. */
  readonly requireMasterCiGreen?: boolean;
  /** Target branch override for stale-base comparison (defaults to PR base.ref). */
  readonly baseBranch?: string | null;
  /**
   * Project root for human-merge + intent-ceiling preflight (#1193).
   * Defaults to process.cwd(). Pass explicitly in tests.
   */
  readonly projectRoot?: string;
  /** Inject agent-merge evaluator (unit tests). */
  readonly agentMergeFn?: (projectRoot: string) => AgentMergeEvaluateResult;
  /** When true, skip human-merge / intent preflight (tests only). */
  readonly skipHumanMergeGate?: boolean;
  /**
   * Post-merge umbrella reconcile (#1649). Defaults to live reconcileUmbrellas.
   * Pass `null` to skip (unit tests that inject mergeFn must pass null so they
   * never mutate real GitHub current-shape comments from the worktree cwd).
   */
  readonly umbrellaReconcileFn?: UmbrellaReconcileFn | null;
}

/** Run protected-check -> wait -> merge cascade (#1369). */
export function waitMergeableAndMerge(
  prNumber: number,
  repo: string,
  options: {
    readonly capMinutes: number;
    readonly protected: readonly number[];
  } & WaitMergeableOptions,
): WaitMergeableResult {
  const protectedFn = options.protectedFn ?? runProtectedCheck;
  const monitorFn = options.monitorFn ?? runMonitor;
  const mergeFn = options.mergeFn ?? runGhMerge;
  const semanticGreenFn = options.semanticGreenFn ?? evaluateSemanticGreen;
  const protectedIssues = options.protected;
  const projectRoot = options.projectRoot ?? process.cwd();

  // #1193 surface (1): refuse agent merge when requireHumanMerge is true,
  // and refuse when slash-command intent ceiling does not authorize merge.
  if (options.skipHumanMergeGate !== true) {
    const intent = evaluateIntentCeilingFromEnv("merge");
    if (!intent.allowed) {
      return makeResult({
        prNumber,
        repo,
        outcome: "config-error",
        exitCode: EXIT_CONFIG_ERROR,
        error: intent.reason,
      });
    }
    const agentMergeFn = options.agentMergeFn ?? evaluateAgentMerge;
    const hm = agentMergeFn(projectRoot);
    if (!hm.allowed) {
      return makeResult({
        prNumber,
        repo,
        outcome: "config-error",
        exitCode: EXIT_CONFIG_ERROR,
        error: hm.message,
      });
    }
  }

  let protectedCheckPayload: Record<string, unknown> = {};

  if (protectedIssues.length > 0) {
    const [prcRc, prcStdout, prcStderr] = protectedFn(prNumber, repo, protectedIssues);
    protectedCheckPayload = {
      returncode: prcRc,
      stdout: prcStdout,
      stderr: prcStderr,
      protected: [...protectedIssues],
    };

    if (prcRc === 1 && !isProtectedCheckConfigFailure(prcStderr)) {
      return makeResult({
        prNumber,
        repo,
        outcome: "protected-linked",
        exitCode: EXIT_TIMEOUT_OR_ESCALATION,
        protectedCheck: protectedCheckPayload,
        error:
          "PR has a persistent closingIssuesReferences link to a " +
          "protected issue (#701). Unlink via the PR's Development " +
          "sidebar before re-running.",
      });
    }

    if (prcRc !== 0) {
      return makeResult({
        prNumber,
        repo,
        outcome: "config-error",
        exitCode: EXIT_CONFIG_ERROR,
        protectedCheck: protectedCheckPayload,
        error:
          `protected-issue check exited ${prcRc} (config error). ` + `stderr: ${prcStderr.trim()}`,
      });
    }
  }

  const semanticGreen = semanticGreenFn(prNumber, repo, {
    cascadeMode: options.cascadeMode,
    requireMasterCiGreen: options.requireMasterCiGreen,
    baseBranch: options.baseBranch,
  });
  if (!semanticGreen.ok) {
    return makeResult({
      prNumber,
      repo,
      outcome: semanticGreen.outcome ?? "semantic-green-blocked",
      exitCode: semanticGreen.exitCode ?? EXIT_TIMEOUT_OR_ESCALATION,
      protectedCheck: protectedCheckPayload,
      semanticGreen: { ...semanticGreen.payload } as Record<string, unknown>,
      error: semanticGreen.error,
    });
  }

  const [monRc, monStdout, monStderr] = monitorFn(prNumber, repo, options.capMinutes);
  const monitorPayload = parseMonitorPayload(monStdout);
  const [outcome, monitorExit] = classifyMonitorOutcome(monRc, monitorPayload);

  if (outcome !== "clean") {
    const errorPayload =
      monitorExit === EXIT_MERGED
        ? null
        : monStderr.trim().length > 0
          ? `monitor exited ${monRc} (outcome=${outcome}). stderr tail: ${monStderr.trim().slice(-200)}`
          : `monitor exited ${monRc} (outcome=${outcome})`;

    return makeResult({
      prNumber,
      repo,
      outcome,
      exitCode: monitorExit,
      monitorResult: monitorPayload,
      protectedCheck: protectedCheckPayload,
      error: errorPayload,
    });
  }

  const [mergeRc, mergeStdout, mergeStderr] = mergeFn(prNumber, repo);

  if (mergeRc === 0) {
    // Best-effort umbrella checklist + current-shape refresh after child merge (#1649).
    // Failures must not flip a successful merge into an error exit.
    // null = skip; undefined = live default (skipped under VITEST unless injected).
    const umbrellaFn =
      options.umbrellaReconcileFn === null
        ? null
        : options.umbrellaReconcileFn !== undefined
          ? options.umbrellaReconcileFn
          : process.env.VITEST === "true"
            ? null
            : defaultPostMergeUmbrellaReconcile;
    if (umbrellaFn !== null) {
      try {
        umbrellaFn(projectRoot, repo);
      } catch {
        /* best-effort; merge remains authoritative */
      }
    }
    return makeResult({
      prNumber,
      repo,
      outcome: "merged",
      exitCode: EXIT_MERGED,
      monitorResult: monitorPayload,
      protectedCheck: protectedCheckPayload,
      mergeStdout,
      mergeStderr,
      error: null,
    });
  }

  if (mergeRc === -1) {
    const tail = mergeStderr.trim();
    return makeResult({
      prNumber,
      repo,
      outcome: "config-error",
      exitCode: EXIT_CONFIG_ERROR,
      monitorResult: monitorPayload,
      protectedCheck: protectedCheckPayload,
      mergeStdout,
      mergeStderr,
      error:
        tail.length > 0
          ? `gh pr merge wrapper failed at OS layer (rc=-1). stderr: ${tail.slice(-200)}`
          : "gh pr merge wrapper failed at OS layer (rc=-1).",
    });
  }

  const mergeTail = mergeStderr.trim();
  return makeResult({
    prNumber,
    repo,
    outcome: "merge-failed",
    exitCode: EXIT_TIMEOUT_OR_ESCALATION,
    monitorResult: monitorPayload,
    protectedCheck: protectedCheckPayload,
    mergeStdout,
    mergeStderr,
    error:
      mergeTail.length > 0
        ? `gh pr merge exited ${mergeRc}. stderr: ${mergeTail.slice(-200)}`
        : `gh pr merge exited ${mergeRc}`,
  });
}
