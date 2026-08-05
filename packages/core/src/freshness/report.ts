/**
 * Freshness report assembly + human formatting (#3117).
 */

import { readRitualState } from "../session/ritual-sentinel.js";
import { readBoundGeneration } from "./bind.js";
import { compareFreshness } from "./compare.js";
import { readLiveGeneration } from "./generation.js";
import type { FreshnessReport } from "./types.js";

export interface ReportFreshnessOptions {
  /**
   * Host session identity. When set, only that session's bind is read
   * (multi-agent isolation).
   *
   * When omitted, recover the current ritual `session_id` from
   * `.deft/ritual-state.json` (written by `session:start`) so bare
   * `freshness:report` matches the bind just created. Pass `null` to force
   * the default project bind path only.
   */
  readonly sessionId?: string | null;
}

/**
 * Resolve which bind identity a report/bind should use.
 *
 * Precedence:
 * 1. Explicit non-empty `sessionId`
 * 2. `DEFT_SESSION_ID` env (per-process; multi-agent safe)
 * 3. Ritual `session_id` from `.deft/ritual-state.json` (same-worktree operator)
 * 4. `null` → default bind path only
 *
 * Trusted `current`/`ready` still requires a **pinned** identity (explicit or env).
 * Ritual recovery alone is convenience for bind write target, not for trusted ready.
 */
export function resolveReportSessionId(
  projectRoot: string,
  explicit?: string | null,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (explicit === null) {
    return null;
  }
  if (typeof explicit === "string" && explicit.trim().length > 0) {
    return explicit.trim();
  }
  const fromEnv = (env.DEFT_SESSION_ID ?? "").trim();
  if (fromEnv.length > 0) {
    return fromEnv;
  }
  try {
    const [state] = readRitualState(projectRoot);
    const id = state?.sessionId?.trim();
    return id && id.length > 0 ? id : null;
  } catch {
    return null;
  }
}

/** True when the caller pinned identity via explicit arg or DEFT_SESSION_ID. */
export function hasPinnedSessionIdentity(
  explicit?: string | null,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (typeof explicit === "string" && explicit.trim().length > 0) {
    return true;
  }
  return (env.DEFT_SESSION_ID ?? "").trim().length > 0;
}

/** Build a freshness report for the project (bound vs live on disk). */
export function reportFreshness(
  projectRoot: string,
  options: ReportFreshnessOptions = {},
): FreshnessReport {
  const sessionId = resolveReportSessionId(projectRoot, options.sessionId);
  const bound = readBoundGeneration(projectRoot, { sessionId });
  const live = readLiveGeneration(projectRoot);
  const report = compareFreshness(bound, live);
  // Multi-agent safety: never claim ready/current without a pinned session identity.
  // Ritual recovery alone can point at another concurrent session's bind on a
  // shared worktree (Greptile). Hosts set DEFT_SESSION_ID or pass --session-id.
  if (report.ready && !hasPinnedSessionIdentity(options.sessionId)) {
    return {
      ...report,
      state: "stale_soft",
      ready: false,
      rebindGuidance:
        "Session identity is not pinned. Set DEFT_SESSION_ID to this session's id " +
        "(printed by session:start) or pass --session-id before trusted work. " +
        "Bare reports without a pinned id cannot certify readiness when multiple " +
        "sessions share a worktree.",
    };
  }
  // Host must attest payload surfaces were loaded for this generation (session:start
  // does; CLI bind requires --confirm-payload-loaded). Disk bind alone is insufficient.
  if (report.ready && bound?.payloadLoaded !== true) {
    return {
      ...report,
      state: "stale_soft",
      ready: false,
      rebindGuidance:
        "Bind has no payload-loaded attestation. Re-load skills/rituals/templates into " +
        "the session, then rebind with payloadLoaded (session:start, or " +
        "`deft freshness:bind -- --confirm-payload-loaded`).",
    };
  }
  return report;
}

/** Human-readable multi-line freshness report. */
export function formatFreshnessReport(report: FreshnessReport): string {
  const lines: string[] = [
    "[deft freshness] bound vs live generation",
    `  state              : ${report.state}`,
    `  ready              : ${report.ready ? "yes" : "no"}`,
    `  bound generation   : ${report.boundGeneration ?? "(none)"}`,
    `  live generation    : ${report.liveGeneration ?? "(none)"}`,
    `  bound content      : ${report.boundContentVersion ?? "(none)"}`,
    `  live content       : ${report.liveContentVersion ?? "(none)"}`,
  ];
  if (report.differingSurfaces.length > 0) {
    lines.push(`  differing surfaces: ${report.differingSurfaces.join(", ")}`);
    if (report.hardDiffs.length > 0) {
      lines.push(`  hard diffs         : ${report.hardDiffs.join(", ")}`);
    }
    if (report.softDiffs.length > 0) {
      lines.push(`  soft diffs         : ${report.softDiffs.join(", ")}`);
    }
  } else if (report.state !== "unbound") {
    lines.push("  differing surfaces: (none)");
  }
  lines.push(`  rebind             : ${report.rebindGuidance}`);
  if (report.state === "stale_hard" || report.state === "unbound") {
    lines.push(`  mid-mission        : ${report.midMissionSafety}`);
  }
  return `${lines.join("\n")}\n`;
}

/** JSON-serializable shape for --json output. */
export function freshnessReportToJson(report: FreshnessReport): Record<string, unknown> {
  return {
    state: report.state,
    ready: report.ready,
    bound_generation: report.boundGeneration,
    live_generation: report.liveGeneration,
    bound_content_version: report.boundContentVersion,
    live_content_version: report.liveContentVersion,
    differing_surfaces: report.differingSurfaces,
    hard_diffs: report.hardDiffs,
    soft_diffs: report.softDiffs,
    rebind_guidance: report.rebindGuidance,
    mid_mission_safety: report.midMissionSafety,
    live: report.live,
    bound: report.bound,
  };
}

/**
 * Exit code for freshness:report.
 * 0 = current (ready); 1 = stale_soft or unbound (caution); 2 = stale_hard (must rebind).
 */
export function freshnessReportExitCode(report: FreshnessReport): 0 | 1 | 2 {
  if (report.state === "current") return 0;
  if (report.state === "stale_hard") return 2;
  return 1;
}
