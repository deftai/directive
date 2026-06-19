import type { QueueGroup } from "./constants.js";

/**
 * Map (latestDecision, inActiveVbrief) to a group bucket.
 * Mirrors scripts/triage_queue.py::derive_group.
 */
export function deriveGroup(
  latestDecision: string | null | undefined,
  inActiveVbrief: boolean,
): QueueGroup {
  if (inActiveVbrief) {
    return "RESUME";
  }
  if (latestDecision === "resume-eligible") {
    return "RESUME";
  }
  if (latestDecision === "needs-ac") {
    return "URGENT";
  }
  if (latestDecision === null || latestDecision === undefined) {
    return "untriaged";
  }
  return "other";
}
