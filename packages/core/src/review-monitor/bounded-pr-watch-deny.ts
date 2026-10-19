/**
 * Bounded-form deny for Directive `pr:watch` without `--monitor-agent-id` (#5229).
 *
 * Recognizes only bounded vocabulary (`deft pr:watch` / `task deft:pr:watch` /
 * `task pr:watch`). Bespoke `%TEMP%` pollers are a named residual unless the
 * host routes them through deft-hook — this helper does not claim total coverage.
 *
 * Claimed-wait deny (#5727 Prefer-A Recut-2 P4) refuses forge-poll /
 * bespoke-temp / host-monitor / bare pr:watch when Tier 1 is proven. Undeclared
 * shell interception before execution remains leftover #5732.
 */
import { isTier1, type MonitoringTierProbe, type PlatformPrimitive } from "./tier-detection.js";

/** Admission cost: lower is cheaper / preferred (#5229 Prefer-A / #5727). */
export type BabysitPathKind =
  | "approach1-spawn"
  | "directive-pr-watch-with-monitor-id"
  | "directive-pr-watch-bare"
  | "host-monitor"
  | "forge-poll"
  | "bespoke-temp-poller";

const ADMISSION_COST: Record<BabysitPathKind, number> = {
  "approach1-spawn": 1,
  "directive-pr-watch-with-monitor-id": 2,
  "directive-pr-watch-bare": 50,
  "host-monitor": 60,
  "forge-poll": 80,
  "bespoke-temp-poller": 90,
};

/** Forbidden claimed pre-CLEAN waits when Tier-1 spawn_subagent is proven (#5727). */
export const FORBIDDEN_CLAIMED_WAIT_KINDS_WHEN_TIER1: ReadonlySet<BabysitPathKind> = new Set([
  "forge-poll",
  "bespoke-temp-poller",
  "host-monitor",
  "directive-pr-watch-bare",
]);

/** Lawful pre-CLEAN claimed kinds when bound evidence is present (#5727). */
export const LAWFUL_PRE_CLEAN_CLAIMED_KINDS: ReadonlySet<BabysitPathKind> = new Set([
  "approach1-spawn",
  "directive-pr-watch-with-monitor-id",
]);

/**
 * Tier-1 Approach 1 register primitives admitted by bound-evidence (#5727).
 * Matches host-capability stamp / merge-path-arm Approach 1 set — not every
 * PlatformPrimitive (arbitrary nonempty strings stay rejected).
 */
export const APPROACH1_BOUND_PLATFORM_PRIMITIVES: ReadonlySet<string> = new Set([
  "spawn_subagent",
  "cursor-task",
  "claude-agent",
]);

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

/** Bound evidence required to admit Approach 1 / child-bound watch claims (#5727). */
export interface ClaimedBabysitBoundEvidence {
  readonly pr: number;
  readonly monitorAgentId?: string | null;
  readonly registeredPlatformPrimitive?: PlatformPrimitive | string | null;
  /** Child `pr:watch` carries the same `--monitor-agent-id` as the lease. */
  readonly childWatchBoundToMonitorId?: boolean;
  /**
   * PR the wait evidence is actually bound to. When set and different from
   * `pr`, deny as different-PR arm (#5727 negative).
   */
  readonly evidencePr?: number | null;
}

export interface ClaimedBabysitPathDenyInput {
  readonly claimedKind: BabysitPathKind;
  readonly tier: MonitoringTierProbe;
  readonly boundEvidence?: ClaimedBabysitBoundEvidence | null;
  /** Defaults to pre-clean; post-clean admits `pr:wait-mergeable-and-merge`. */
  readonly phase?: "pre-clean" | "post-clean";
  readonly claimedPostCleanWait?: "pr-wait-mergeable-and-merge" | null;
}

export type ClaimedBabysitPathDenyReason =
  | "admitted"
  | "admitted-post-clean"
  | "admitted-not-tier1"
  | "forbidden-claimed-kind"
  | "approach1-unbound"
  | "different-pr-arm"
  | "missing-post-clean-wait";

export interface ClaimedBabysitPathDenyResult {
  readonly deny: boolean;
  readonly claimedKind: BabysitPathKind;
  readonly reason: ClaimedBabysitPathDenyReason;
  readonly message: string;
}

function hasApproach1BoundEvidence(
  evidence: ClaimedBabysitBoundEvidence | null | undefined,
): boolean {
  if (evidence === null || evidence === undefined) return false;
  if (!(evidence.pr > 0)) return false;
  const id = evidence.monitorAgentId?.trim() ?? "";
  if (id.length === 0 || id.startsWith("-")) return false;
  if (evidence.childWatchBoundToMonitorId !== true) return false;
  // Approach 1 register: spawn_subagent | cursor-task | claude-agent (#5727 Greptile).
  const prim = (evidence.registeredPlatformPrimitive ?? "").toString().trim();
  return APPROACH1_BOUND_PLATFORM_PRIMITIVES.has(prim);
}

/**
 * Fail closed on claimed babysit path when Tier 1 proves spawn_subagent and the
 * claim is forge-poll / bespoke-temp / host-monitor / bare Directive pr:watch,
 * or Approach 1 without bound evidence / different-PR arm (#5727 P4).
 *
 * Does not intercept undeclared shell before execution (#5732 residual).
 * Keep `evaluateBoundedPrWatchDeny` for Directive command-form recognition.
 */
export function evaluateClaimedBabysitPathDeny(
  input: ClaimedBabysitPathDenyInput,
): ClaimedBabysitPathDenyResult {
  const claimedKind = input.claimedKind;

  if (!isTier1(input.tier)) {
    return {
      deny: false,
      claimedKind,
      reason: "admitted-not-tier1",
      message:
        `claimed-babysit-path-deny: Tier ${input.tier.tier} ` +
        `(${input.tier.descriptor ?? "unknown"}) — claimed path admitted (no Tier-1 primitive).`,
    };
  }

  if (input.phase === "post-clean") {
    if (input.claimedPostCleanWait === "pr-wait-mergeable-and-merge") {
      return {
        deny: false,
        claimedKind,
        reason: "admitted-post-clean",
        message:
          "claimed-babysit-path-deny: post-CLEAN pr:wait-mergeable-and-merge is a lawful closer wait (#5727).",
      };
    }
    // Do not fall through to pre-CLEAN Approach 1 admit without a closer claim (#5727 Greptile).
    return {
      deny: true,
      claimedKind,
      reason: "missing-post-clean-wait",
      message:
        "claimed-babysit-path-deny: phase post-clean requires claimedPostCleanWait " +
        "'pr-wait-mergeable-and-merge' — pre-CLEAN Approach 1 evidence alone is not a closer (#5727).",
    };
  }

  if (FORBIDDEN_CLAIMED_WAIT_KINDS_WHEN_TIER1.has(claimedKind)) {
    const pr =
      input.boundEvidence !== undefined &&
      input.boundEvidence !== null &&
      input.boundEvidence.pr > 0
        ? String(input.boundEvidence.pr)
        : "<N>";
    const primitive = input.tier.primitive ?? "spawn_subagent";
    return {
      deny: true,
      claimedKind,
      reason: "forbidden-claimed-kind",
      message:
        `claimed-babysit-path-deny: Tier 1 provable — claimed wait kind ` +
        `'${claimedKind}' is forbidden as pre-CLEAN babysit (#5727).\n` +
        "  Exclusive lawful waits: Approach 1 child pr:watch --monitor-agent-id after " +
        "review-monitor:register --platform-primitive spawn_subagent with " +
        "verify:review-monitor --merge-path-arm --live-wait green; after CLEAN, " +
        "parent-retained pr:wait-mergeable-and-merge.\n" +
        "  Forbidden: parent forge-poll / gh check-runs+mergeable_state sleep / " +
        "bespoke %TEMP% PowerShell watchers / host-monitor / bare directive-pr-watch.\n" +
        `  Prefer: task review-monitor:register -- --pr ${pr} --monitor-agent-id <id> ` +
        `--platform-primitive ${primitive}`,
    };
  }

  if (LAWFUL_PRE_CLEAN_CLAIMED_KINDS.has(claimedKind)) {
    const evidence = input.boundEvidence;
    if (
      evidence !== undefined &&
      evidence !== null &&
      evidence.evidencePr !== undefined &&
      evidence.evidencePr !== null &&
      evidence.evidencePr > 0 &&
      evidence.evidencePr !== evidence.pr
    ) {
      return {
        deny: true,
        claimedKind,
        reason: "different-pr-arm",
        message:
          `claimed-babysit-path-deny: different-PR arm — evidence bound to PR ` +
          `${evidence.evidencePr} but claim targets PR ${evidence.pr} (#5727).`,
      };
    }

    if (!hasApproach1BoundEvidence(evidence)) {
      return {
        deny: true,
        claimedKind,
        reason: "approach1-unbound",
        message:
          "claimed-babysit-path-deny: Approach 1 / child-bound watch claim lacks " +
          "bound evidence (register --platform-primitive + monitor-agent-id + " +
          "childWatchBoundToMonitorId) (#5727).",
      };
    }

    return {
      deny: false,
      claimedKind,
      reason: "admitted",
      message:
        "claimed-babysit-path-deny: Approach 1 / child-bound watch admitted with bound evidence.",
    };
  }

  return {
    deny: true,
    claimedKind,
    reason: "forbidden-claimed-kind",
    message:
      `claimed-babysit-path-deny: Tier 1 provable — unrecognized claimed kind ` +
      `'${claimedKind}' refused (#5727).`,
  };
}
