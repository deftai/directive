import { EXIT_CONFIG_ERROR, EXIT_MERGED, EXIT_TIMEOUT_OR_ESCALATION } from "./constants.js";

/** Map monitor_pr exit code onto helper outcome + exit code. */
export function classifyMonitorOutcome(
  monitorReturncode: number,
  monitorPayload: Record<string, unknown>,
): readonly [string, number] {
  if (monitorReturncode === 0) {
    return ["clean", EXIT_MERGED] as const;
  }
  if (monitorReturncode === 1) {
    return ["cap-reached", EXIT_TIMEOUT_OR_ESCALATION] as const;
  }
  if (monitorReturncode === 2) {
    return ["config-error", EXIT_CONFIG_ERROR] as const;
  }
  if (monitorReturncode === 3) {
    const readiness =
      typeof monitorPayload.readiness === "object" &&
      monitorPayload.readiness !== null &&
      !Array.isArray(monitorPayload.readiness)
        ? (monitorPayload.readiness as Record<string, unknown>)
        : {};
    const partial =
      typeof readiness.partial_data === "object" &&
      readiness.partial_data !== null &&
      !Array.isArray(readiness.partial_data)
        ? (readiness.partial_data as Record<string, unknown>)
        : {};
    if (partial.merged === true) {
      return ["merged-by-sibling", EXIT_MERGED] as const;
    }
    return ["pr-closed", EXIT_TIMEOUT_OR_ESCALATION] as const;
  }
  return ["config-error", EXIT_CONFIG_ERROR] as const;
}

/** Parse the monitor's --json envelope. Returns {} on failure. */
export function parseMonitorPayload(stdout: string): Record<string, unknown> {
  if (stdout.trim().length === 0) {
    return {};
  }
  try {
    const payload = JSON.parse(stdout) as unknown;
    if (typeof payload === "object" && payload !== null && !Array.isArray(payload)) {
      return payload as Record<string, unknown>;
    }
  } catch {
    return {};
  }
  return {};
}
