/**
 * Approach 1 babysitter one-liner for Grok / Tier-1 spawn_subagent (#5219).
 * Prefer this dispatch over a parent-owned shell `pr:watch`.
 */
import {
  formatApproach1BabysitterOneLiner,
  type PlatformPrimitive,
} from "../review-monitor/index.js";

export { formatApproach1BabysitterOneLiner };

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

export function formatApproach1BabysitterCard(
  pr: number,
  monitorAgentId: string,
  platformPrimitive: PlatformPrimitive = "spawn_subagent",
): string {
  return (
    `Approach 1 babysitter (cheaper than parent shell pr:watch) (#5219):\n` +
    `${formatApproach1BabysitterOneLiner(pr, monitorAgentId, platformPrimitive)}\n` +
    "Child owns watch → class A residual handoff → re-watch until CLEAN; " +
    "parent closer runs pr:wait-mergeable-and-merge only after CLEAN."
  );
}
