/**
 * Approach 1 babysitter one-liner for Grok / Tier-1 spawn_subagent (#5219 / #5229 / #5727 / #4781).
 * Prefer this dispatch over a parent-owned shell `pr:watch`, host `monitor`, or forge-poll.
 */
import {
  babysitPathAdmissionCost,
  type ClaimedBabysitPathDenyInput,
  type ClaimedBabysitPathDenyResult,
  evaluateBoundedPrWatchDeny,
  evaluateClaimedBabysitPathDeny,
  formatApproach1BabysitterOneLiner,
  isApproach1CheapestVs,
  type PlatformPrimitive,
  writeHostCapabilityStamp,
} from "../review-monitor/index.js";

export {
  babysitPathAdmissionCost,
  evaluateBoundedPrWatchDeny,
  evaluateClaimedBabysitPathDeny,
  formatApproach1BabysitterOneLiner,
  isApproach1CheapestVs,
  writeHostCapabilityStamp,
};

/**
 * Approach 1 / independent validation monitor-only spawn shape (#4781 Prefer-A Bound).
 * Emit process_only + dest cwd for stop-at:pr-open + worker_role:review-monitor watch/report
 * seats only. Implement-class never sets process_only. Dest-path is not the skip class.
 * Do not blanket-flag the fix-capable greptile poller — hand fixes to an authorized implement owner.
 */
export const APPROACH1_PROCESS_ONLY_SPAWN_SHAPE =
  "spawn_subagent process_only=true cwd=<linked-dest> worker_role=review-monitor stop-at=pr-open " +
  "(watch/report seats only; implement-class never sets process_only; dest-path is not skip class)";

/** True when the envelope is a monitor-only watch/report seat (#4781). */
export function isApproach1MonitorOnlySeat(input: {
  readonly stopAt?: string | null;
  readonly workerRole?: string | null;
}): boolean {
  const stop = (input.stopAt ?? "").toLowerCase().replace(/[_\s]/g, "-");
  const role = (input.workerRole ?? "").toLowerCase().replace(/[_\s]/g, "-");
  return stop === "pr-open" && role === "review-monitor";
}

/** Named spawn shape string for cards / recipes before register/pr:watch (#4781). */
export function formatApproach1ProcessOnlySpawnShape(destCwd: string = "<linked-dest>"): string {
  return (
    `Approach 1 spawn shape (#4781): process_only+cwd before register/pr:watch — ` +
    `spawn_subagent({ process_only: true, cwd: "${destCwd}", worker_role: "review-monitor", ` +
    `/* stop-at: pr-open watch/report only */ })`
  );
}

/** process_only+cwd spawn shape, then child register + watch; parent verify after heartbeat (#5219 / #4781). */
export function approach1BabysitterCommands(
  pr: number,
  monitorAgentId: string,
  platformPrimitive: PlatformPrimitive = "spawn_subagent",
  destCwd: string = "<linked-dest>",
): readonly string[] {
  const id = monitorAgentId.trim().length > 0 ? monitorAgentId.trim() : "<id>";
  return [
    formatApproach1ProcessOnlySpawnShape(destCwd),
    `task review-monitor:register -- --pr ${pr} --monitor-agent-id ${id} --platform-primitive ${platformPrimitive}`,
    `DEFT_MONITOR_AGENT_ID=${id} task pr:watch -- ${pr} --monitor-agent-id ${id}`,
    `task verify:review-monitor -- --pr ${pr} --merge-path-arm --live-wait`,
  ];
}

/**
 * Exclusive lawful waits + cheapest admitted babysit when Tier-1 spawn exists
 * (#5229 Prefer-A / #5727 Prefer-A Recut-2 P3 / #4781 process_only+cwd spawn shape).
 * Admission cost: Approach 1 spawn < child-bound Directive pr:watch << bare
 * shell watch / host monitor / forge-poll / bespoke %TEMP% pollers.
 */
export function formatApproach1CheapestAdmissionCard(
  pr: number,
  monitorAgentId: string,
  platformPrimitive: PlatformPrimitive = "spawn_subagent",
): string {
  const vsShell = isApproach1CheapestVs("directive-pr-watch-bare");
  const vsHost = isApproach1CheapestVs("host-monitor");
  const vsForge = isApproach1CheapestVs("forge-poll");
  return (
    `Approach 1 babysitter — exclusive lawful waits / cheapest admitted path (#5219 / #5229 / #5727):\n` +
    `  exclusive lawful pre-CLEAN: Approach 1 child pr:watch --monitor-agent-id after ` +
    `review-monitor:register --platform-primitive spawn_subagent with ` +
    `verify:review-monitor --merge-path-arm --live-wait green\n` +
    `  exclusive lawful post-CLEAN: parent-retained pr:wait-mergeable-and-merge\n` +
    `  forbidden (BabysitPathKind): forge-poll / gh check-runs+mergeable_state sleep / ` +
    `bespoke %TEMP% PowerShell / host-monitor / directive-pr-watch-bare\n` +
    `  admission: approach1-spawn=${babysitPathAdmissionCost("approach1-spawn")} ` +
    `< bare-pr-watch=${babysitPathAdmissionCost("directive-pr-watch-bare")} ` +
    `< host-monitor=${babysitPathAdmissionCost("host-monitor")} ` +
    `< forge-poll=${babysitPathAdmissionCost("forge-poll")} ` +
    `(cheaperThanShell=${vsShell}, cheaperThanHostMonitor=${vsHost}, cheaperThanForgePoll=${vsForge})\n` +
    `${formatApproach1BabysitterOneLiner(pr, monitorAgentId, platformPrimitive)}\n` +
    `${formatApproach1ProcessOnlySpawnShape()}\n` +
    "Monitor-only seat (#4781): emit process_only+cwd for stop-at:pr-open + worker_role:review-monitor " +
    "watch/report seats only; do not blanket-flag the fix-capable greptile poller.\n" +
    "Before CLI verify/subprocess: writeHostCapabilityStamp(projectRoot) so Tier probe stays spawn_subagent.\n" +
    "Bounded deny: Directive pr:watch / task deft:pr:watch without --monitor-agent-id when Tier 1 is provable.\n" +
    "Claimed-wait deny: admitClaimedBabysitPath / evaluateClaimedBabysitPathDeny (#5727).\n" +
    "Named residual (#5732): undeclared-shell interception before execution (not this ship).\n" +
    "Child owns watch → class A residual handoff → re-watch until CLEAN; " +
    "parent closer runs pr:wait-mergeable-and-merge only after CLEAN."
  );
}

/**
 * Named production caller for claimed babysit-path admission (#5727 P4).
 * Composes `evaluateClaimedBabysitPathDeny` with cheapest-admission inventory;
 * attaches the exclusive lawful-waits card when denied.
 */
export function admitClaimedBabysitPath(
  input: ClaimedBabysitPathDenyInput & {
    readonly pr?: number;
    readonly monitorAgentId?: string;
    readonly platformPrimitive?: PlatformPrimitive;
  },
): ClaimedBabysitPathDenyResult & { readonly cheapestAdmissionCard: string | null } {
  const targetPr =
    input.pr !== undefined && input.pr > 0
      ? input.pr
      : input.boundEvidence !== undefined &&
          input.boundEvidence !== null &&
          input.boundEvidence.pr > 0
        ? input.boundEvidence.pr
        : 0;
  const id = input.monitorAgentId?.trim() || input.boundEvidence?.monitorAgentId?.trim() || "<id>";
  const primitive = input.platformPrimitive ?? input.tier.primitive ?? "spawn_subagent";
  const attachCard = (
    result: ClaimedBabysitPathDenyResult,
  ): ClaimedBabysitPathDenyResult & { readonly cheapestAdmissionCard: string | null } => {
    if (!result.deny) {
      return { ...result, cheapestAdmissionCard: null };
    }
    const card = formatApproach1CheapestAdmissionCard(
      targetPr > 0 ? targetPr : 0,
      id,
      (primitive as PlatformPrimitive) || "spawn_subagent",
    );
    return {
      ...result,
      message: `${result.message}\n${card}`,
      cheapestAdmissionCard: card,
    };
  };

  // Top-level claim PR must match evidence PR / evidencePr when both are set (#5727 Greptile).
  if (
    input.pr !== undefined &&
    input.pr > 0 &&
    input.boundEvidence !== undefined &&
    input.boundEvidence !== null
  ) {
    const evidence = input.boundEvidence;
    const evidenceTarget = evidence.pr > 0 ? evidence.pr : null;
    const evidenceBound =
      evidence.evidencePr !== undefined && evidence.evidencePr !== null && evidence.evidencePr > 0
        ? evidence.evidencePr
        : evidenceTarget;
    if (
      (evidenceTarget !== null && evidenceTarget !== input.pr) ||
      (evidenceBound !== null && evidenceBound !== input.pr)
    ) {
      return attachCard({
        deny: true,
        claimedKind: input.claimedKind,
        reason: "different-pr-arm",
        message:
          `claimed-babysit-path-deny: different-PR arm — top-level claim targets PR ` +
          `${input.pr} but evidence is bound to PR ` +
          `${evidenceBound ?? evidenceTarget} (#5727).`,
      });
    }
  }

  return attachCard(evaluateClaimedBabysitPathDeny(input));
}

export function formatApproach1BabysitterCard(
  pr: number,
  monitorAgentId: string,
  platformPrimitive: PlatformPrimitive = "spawn_subagent",
): string {
  return formatApproach1CheapestAdmissionCard(pr, monitorAgentId, platformPrimitive);
}

/**
 * Cohort inventory remediation (#5318): one Approach 1 babysitter per unarmed PR.
 * Occupancy serializes product writes only — parallel babysitters are OK.
 */
export function approach1RemediationForUnarmedPrs(
  unarmedPrs: readonly number[],
  monitorAgentIdFor: (pr: number) => string = (pr) => `approach1-${pr}`,
  platformPrimitive: PlatformPrimitive = "spawn_subagent",
): readonly string[] {
  const out: string[] = [];
  for (const pr of unarmedPrs) {
    out.push(...approach1BabysitterCommands(pr, monitorAgentIdFor(pr), platformPrimitive));
  }
  return out;
}

/**
 * Production write path for the durable host→CLI stamp before CLI verify/watch (#5229).
 * Prefer calling this (or `review-monitor:register`, which also stamps) before spawning
 * a bare CLI subprocess that lacks GROK_BUILD / DEFT_HAS_SPAWN_SUBAGENT.
 */
export function ensureHostCapabilityStampForBabysit(
  projectRoot: string,
  input: {
    readonly primitive?: PlatformPrimitive;
    readonly hostSessionId?: string | null;
    readonly source?: string;
    readonly now?: Date;
  } = {},
): ReturnType<typeof writeHostCapabilityStamp> {
  return writeHostCapabilityStamp(projectRoot, {
    primitive: input.primitive ?? "spawn_subagent",
    hostSessionId: input.hostSessionId ?? null,
    source: input.source ?? "approach1-babysitter",
    now: input.now,
  });
}
