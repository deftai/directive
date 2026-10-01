/**
 * Bounded-form deny for Directive `pr:watch` without `--monitor-agent-id` (#5229).
 *
 * Recognizes only bounded vocabulary (`deft pr:watch` / `task deft:pr:watch` /
 * `task pr:watch`). Bespoke `%TEMP%` pollers are a named residual unless the
 * host routes them through deft-hook — this helper does not claim total coverage.
 */
import { isTier1, type MonitoringTierProbe } from "./tier-detection.js";

/** Admission cost: lower is cheaper / preferred (#5229 Prefer-A). */
export type BabysitPathKind =
  | "approach1-spawn"
  | "directive-pr-watch-with-monitor-id"
  | "directive-pr-watch-bare"
  | "host-monitor"
  | "bespoke-temp-poller";

const ADMISSION_COST: Record<BabysitPathKind, number> = {
  "approach1-spawn": 1,
  "directive-pr-watch-with-monitor-id": 2,
  "directive-pr-watch-bare": 50,
  "host-monitor": 60,
  "bespoke-temp-poller": 90,
};

export function babysitPathAdmissionCost(kind: BabysitPathKind): number {
  return ADMISSION_COST[kind];
}

/** True when Approach 1 spawn is strictly cheaper than the compared path. */
export function isApproach1CheapestVs(kind: BabysitPathKind): boolean {
  return babysitPathAdmissionCost("approach1-spawn") < babysitPathAdmissionCost(kind);
}

/**
 * Normalize a shell/command string for form recognition (lowercase, collapse
 * whitespace, strip common PowerShell wrappers).
 */
export function normalizeWatchCommandForm(command: string): string {
  return command.replace(/`/g, "").replace(/\r?\n/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * True when the command is a bounded Directive pr:watch / task deft:pr:watch form.
 * Does not match arbitrary `%TEMP%` scripts or host `monitor` wrappers.
 */
export function isDirectivePrWatchForm(command: string): boolean {
  const n = normalizeWatchCommandForm(command);
  if (n.length === 0) return false;
  // Bound vocabulary only (#5229 Prefer-A limb 6).
  return (
    /\b(?:node\s+[^\s]*bin\.js\s+)?pr:watch\b/.test(n) ||
    /\b(?:node\s+[^\s]*bin\.js\s+)?pr-watch\b/.test(n) ||
    /\bdeft(?:ai)?(?:\.exe)?\s+pr:watch\b/.test(n) ||
    /\bdeft(?:ai)?(?:\.exe)?\s+pr-watch\b/.test(n) ||
    /\btask\s+(?:deft:)?pr:watch\b/.test(n) ||
    /\btask\s+(?:deft:)?pr-watch\b/.test(n)
  );
}

function isPlausibleMonitorAgentId(value: string): boolean {
  const v = value.trim();
  // Reject empty and flag-shaped tokens (`--json` consumed as ID) (#5229 Greptile).
  return v.length > 0 && !v.startsWith("-");
}

export function directivePrWatchHasMonitorAgentId(command: string): boolean {
  const n = normalizeWatchCommandForm(command);
  // Require a non-empty, non-flag value — `--monitor-agent-id=` / `DEFT_MONITOR_AGENT_ID=`
  // alone, or `--monitor-agent-id --json`, fail closed (#5229).
  const fromFlag = n.match(/--monitor-agent-id(?:\s+|=)(\S+)/);
  if (fromFlag?.[1] !== undefined && isPlausibleMonitorAgentId(fromFlag[1])) {
    return true;
  }
  const fromEnv = n.match(/\bdeft_monitor_agent_id=(\S+)/);
  return fromEnv?.[1] !== undefined && isPlausibleMonitorAgentId(fromEnv[1]);
}

export interface BoundedPrWatchDenyInput {
  readonly command: string;
  readonly tier: MonitoringTierProbe;
  readonly pr?: number;
  readonly monitorAgentId?: string;
}

export interface BoundedPrWatchDenyResult {
  readonly deny: boolean;
  readonly recognizedForm: boolean;
  readonly hasMonitorAgentId: boolean;
  readonly message: string;
  readonly residualNamed: string | null;
}

/**
 * Fail closed on bounded Directive pr:watch without `--monitor-agent-id` when
 * Tier 1 is provable. Unrecognized forms (host monitor, `%TEMP%` pollers) are
 * not denied here — they remain a named residual.
 */
export function evaluateBoundedPrWatchDeny(
  input: BoundedPrWatchDenyInput,
): BoundedPrWatchDenyResult {
  const recognizedForm = isDirectivePrWatchForm(input.command);
  const hasMonitorAgentId = directivePrWatchHasMonitorAgentId(input.command);
  const residual =
    "Named residual (#5229): bespoke unsanctioned %TEMP% / host-monitor pollers " +
    "are not covered by this bounded-form deny unless routed through deft-hook.";

  if (!recognizedForm) {
    return {
      deny: false,
      recognizedForm: false,
      hasMonitorAgentId,
      message: `bounded-pr-watch-deny: command is not a Directive pr:watch form — ${residual}`,
      residualNamed: residual,
    };
  }

  if (!isTier1(input.tier)) {
    return {
      deny: false,
      recognizedForm: true,
      hasMonitorAgentId,
      message:
        `bounded-pr-watch-deny: Tier ${input.tier.tier} (${input.tier.descriptor ?? "unknown"}) — ` +
        "bare Directive pr:watch admitted (no Tier-1 primitive).",
      residualNamed: null,
    };
  }

  if (hasMonitorAgentId) {
    return {
      deny: false,
      recognizedForm: true,
      hasMonitorAgentId: true,
      message:
        "bounded-pr-watch-deny: Directive pr:watch carries --monitor-agent-id / DEFT_MONITOR_AGENT_ID.",
      residualNamed: null,
    };
  }

  const pr = input.pr !== undefined && input.pr > 0 ? String(input.pr) : "<N>";
  const id = input.monitorAgentId?.trim() || "<id>";
  const primitive = input.tier.primitive ?? "spawn_subagent";
  return {
    deny: true,
    recognizedForm: true,
    hasMonitorAgentId: false,
    message:
      "bounded-pr-watch-deny: Tier 1 provable — Directive pr:watch without " +
      "--monitor-agent-id is refused (#5229).\n" +
      "  Prefer Approach 1 (cheapest admitted babysit):\n" +
      `  task review-monitor:register -- --pr ${pr} --monitor-agent-id ${id} ` +
      `--platform-primitive ${primitive}\n` +
      `  DEFT_MONITOR_AGENT_ID=${id} task pr:watch -- ${pr} --monitor-agent-id ${id}\n` +
      `  task verify:review-monitor -- --pr ${pr} --merge-path-arm --live-wait\n` +
      `  ${residual}`,
    residualNamed: residual,
  };
}
