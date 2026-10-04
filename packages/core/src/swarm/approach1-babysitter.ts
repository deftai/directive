/**
 * Approach 1 babysitter one-liner for Grok / Tier-1 spawn_subagent (#5219 / #5229).
 * Prefer this dispatch over a parent-owned shell `pr:watch` or host `monitor`.
 */
import {
  babysitPathAdmissionCost,
  evaluateBoundedPrWatchDeny,
  formatApproach1BabysitterOneLiner,
  isApproach1CheapestVs,
  type PlatformPrimitive,
  writeHostCapabilityStamp,
} from "../review-monitor/index.js";

export {
  babysitPathAdmissionCost,
  evaluateBoundedPrWatchDeny,
  formatApproach1BabysitterOneLiner,
  isApproach1CheapestVs,
  writeHostCapabilityStamp,
};

/** Child register + watch; parent verify after heartbeat is live (#5219 P3). */
export function approach1BabysitterCommands(
  pr: number,
  monitorAgentId: string,
  platformPrimitive: PlatformPrimitive = "spawn_subagent",
): readonly string[] {
  const id = monitorAgentId.trim().length > 0 ? monitorAgentId.trim() : "<id>";
  return [
    `task review-monitor:register -- --pr ${pr} --monitor-agent-id ${id} --platform-primitive ${platformPrimitive}`,
    `DEFT_MONITOR_AGENT_ID=${id} task pr:watch -- ${pr} --monitor-agent-id ${id}`,
    `task verify:review-monitor -- --pr ${pr} --merge-path-arm --live-wait`,
  ];
}

/**
 * Cheapest admitted babysit path when Tier-1 spawn exists (#5229 Prefer-A).
 * Admission cost: Approach 1 spawn < child-bound Directive pr:watch << bare
 * shell watch / host monitor / bespoke %TEMP% pollers.
 */
export function formatApproach1CheapestAdmissionCard(
  pr: number,
  monitorAgentId: string,
  platformPrimitive: PlatformPrimitive = "spawn_subagent",
): string {
  const vsShell = isApproach1CheapestVs("directive-pr-watch-bare");
  const vsHost = isApproach1CheapestVs("host-monitor");
  return (
    `Approach 1 babysitter — cheapest admitted path (#5219 / #5229):\n` +
    `  admission: approach1-spawn=${babysitPathAdmissionCost("approach1-spawn")} ` +
    `< bare-pr-watch=${babysitPathAdmissionCost("directive-pr-watch-bare")} ` +
    `< host-monitor=${babysitPathAdmissionCost("host-monitor")} ` +
    `(cheaperThanShell=${vsShell}, cheaperThanHostMonitor=${vsHost})\n` +
    `${formatApproach1BabysitterOneLiner(pr, monitorAgentId, platformPrimitive)}\n` +
    "Before CLI verify/subprocess: writeHostCapabilityStamp(projectRoot) so Tier probe stays spawn_subagent.\n" +
    "Bounded deny: Directive pr:watch / task deft:pr:watch without --monitor-agent-id when Tier 1 is provable.\n" +
    "Named residual: bespoke unsanctioned %TEMP% pollers unless routed through deft-hook.\n" +
    "Child owns watch → class A residual handoff → re-watch until CLEAN; " +
    "parent closer runs pr:wait-mergeable-and-merge only after CLEAN."
  );
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
