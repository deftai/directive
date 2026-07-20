import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { sweepScratchDirs } from "../orchestration/subagent-monitor.js";
import {
  EXIT_CONFIG_ERROR,
  EXIT_NOT_READY,
  EXIT_READY,
  MONITORING_TIER_1,
  MONITORING_TIER_3,
} from "./constants.js";
import {
  defaultSubagentStatusDir,
  findActiveMonitorForPr,
  type ReviewMonitorRecord,
  readReviewMonitorFile,
  reviewMonitorPath,
} from "./record.js";
import { isTier1, type MonitoringTierProbe, probeMonitoringTier } from "./tier-detection.js";

export type ReviewMonitorCallSite =
  | "solo"
  | "swarm-phase5-6"
  | "swarm-phase6-cascade"
  | "unspecified";

export interface VerifyReviewMonitorArgs {
  readonly pr: number;
  readonly projectRoot: string;
  readonly repo?: string | null;
  readonly headSha?: string | null;
  readonly callSite?: ReviewMonitorCallSite;
  readonly approach3?: boolean;
  readonly approach3Warned?: boolean;
  readonly staleMinutes?: number;
  readonly now?: Date;
  readonly environ?: NodeJS.ProcessEnv;
}

export interface VerifyReviewMonitorResult {
  readonly exitCode: typeof EXIT_READY | typeof EXIT_NOT_READY | typeof EXIT_CONFIG_ERROR;
  readonly message: string;
  readonly tier: MonitoringTierProbe;
  readonly monitorRecord: ReviewMonitorRecord | null;
  readonly heartbeatActive: boolean;
  readonly callSite: ReviewMonitorCallSite;
}

function spawnRedirect(probe: MonitoringTierProbe): string {
  const primitive = probe.primitive ?? "sub-agent";
  return (
    `Spawn an Approach 1 review-monitor via ${primitive} (background), include ` +
    "`templates/agent-prompt-preamble.md` and `templates/swarm-greptile-poller-prompt.md`, " +
    "then register:\n" +
    "  task review-monitor:register -- --pr <N> --monitor-agent-id <id> " +
    `--platform-primitive ${primitive}\n` +
    "Re-run: task verify:review-monitor -- --pr <N>"
  );
}

export function hasActivePollingHeartbeat(
  projectRoot: string,
  pr: number,
  options: { now?: Date; staleMinutes?: number } = {},
): boolean {
  const dir = defaultSubagentStatusDir(projectRoot);
  if (!existsSync(dir)) {
    return false;
  }
  try {
    if (!statSync(dir).isDirectory()) {
      return false;
    }
  } catch {
    return false;
  }
  const result = sweepScratchDirs([{ readPath: dir, label: dir }], {
    thresholdMinutes: options.staleMinutes ?? 30,
    now: options.now,
  });
  return result.records.some(
    (rec) =>
      rec.pr_number === pr &&
      rec.failures.length === 0 &&
      !rec.is_stale &&
      !rec.is_terminal &&
      (rec.phase === "polling" || rec.phase === "starting"),
  );
}

export function evaluateReviewMonitorGate(
  args: VerifyReviewMonitorArgs,
): VerifyReviewMonitorResult {
  const projectRoot = resolve(args.projectRoot);
  let isDir = false;
  try {
    isDir = statSync(projectRoot).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) {
    return {
      exitCode: EXIT_CONFIG_ERROR,
      message: `verify_review_monitor: --project-root is not a directory: ${projectRoot}`,
      tier: probeMonitoringTier(args.environ),
      monitorRecord: null,
      heartbeatActive: false,
      callSite: args.callSite ?? "unspecified",
    };
  }

  const tier = probeMonitoringTier(args.environ);
  const callSite = args.callSite ?? "unspecified";
  const staleMinutes = args.staleMinutes ?? 30;
  const now = args.now ?? new Date();

  if (args.approach3 === true) {
    if (isTier1(tier)) {
      return {
        exitCode: EXIT_NOT_READY,
        message:
          "verify_review_monitor: Approach 3 blocking poll is forbidden when Tier 1 is available (#2655).\n" +
          `  Detected tier=${tier.tier} descriptor=${tier.descriptor ?? "unknown"} primitive=${tier.primitive ?? "none"}.\n` +
          `  ${spawnRedirect(tier)}`,
        tier,
        monitorRecord: null,
        heartbeatActive: false,
        callSite,
      };
    }
    if (tier.tier === MONITORING_TIER_3 && args.approach3Warned !== true) {
      return {
        exitCode: EXIT_NOT_READY,
        message:
          "verify_review_monitor: Approach 3 requires explicit user warning acknowledgment (#2655).\n" +
          "  Warn the operator that the conversation pane will lock during polling, then re-run with --approach3-warned.",
        tier,
        monitorRecord: null,
        heartbeatActive: false,
        callSite,
      };
    }
    return {
      exitCode: EXIT_READY,
      message: `verify_review_monitor: Tier 3 Approach 3 path allowed (call-site=${callSite}).`,
      tier,
      monitorRecord: null,
      heartbeatActive: false,
      callSite,
    };
  }

  if (!isTier1(tier)) {
    return {
      exitCode: EXIT_READY,
      message:
        `verify_review_monitor: Tier ${tier.tier} (${tier.descriptor ?? "unknown"}) — ` +
        "no active review-monitor required (#2655).",
      tier,
      monitorRecord: null,
      heartbeatActive: false,
      callSite,
    };
  }

  const path = reviewMonitorPath(projectRoot);
  const { data, error } = readReviewMonitorFile(path);
  if (data === null) {
    return {
      exitCode: EXIT_CONFIG_ERROR,
      message: `verify_review_monitor: ${error ?? "could not read review-monitor state"}`,
      tier,
      monitorRecord: null,
      heartbeatActive: false,
      callSite,
    };
  }

  const monitorRecord = findActiveMonitorForPr(data, args.pr, {
    now,
    staleMinutes,
    headSha: args.headSha ?? null,
  });
  const heartbeatActive = hasActivePollingHeartbeat(projectRoot, args.pr, {
    now,
    staleMinutes,
  });

  if (monitorRecord !== null || heartbeatActive) {
    const via = monitorRecord !== null ? "review-monitor record" : "subagent heartbeat";
    return {
      exitCode: EXIT_READY,
      message:
        `verify_review_monitor: active review-monitor for PR #${args.pr} via ${via} ` +
        `(call-site=${callSite}, tier=1, descriptor=${tier.descriptor ?? "unknown"}).`,
      tier,
      monitorRecord,
      heartbeatActive,
      callSite,
    };
  }

  const siteHint =
    callSite === "swarm-phase5-6"
      ? "Swarm Phase 5→6 handoff (#1386)"
      : callSite === "swarm-phase6-cascade"
        ? "Swarm Phase 6 post force-push (#380)"
        : "Solo drive-to merge-ready / review-cycle ownership";

  return {
    exitCode: EXIT_NOT_READY,
    message:
      `verify_review_monitor: Tier 1 available but no active review-monitor for PR #${args.pr} (#2655).\n` +
      `  Call site: ${siteHint}.\n` +
      `  Detected descriptor=${tier.descriptor ?? "unknown"} primitive=${tier.primitive ?? "none"}.\n` +
      `  ${spawnRedirect(tier)}`,
    tier,
    monitorRecord: null,
    heartbeatActive: false,
    callSite,
  };
}

export function verifyResultToJson(result: VerifyReviewMonitorResult): Record<string, unknown> {
  return {
    call_site: result.callSite,
    exit_code: result.exitCode,
    heartbeat_active: result.heartbeatActive,
    message: result.message,
    monitor_agent_id: result.monitorRecord?.monitor_agent_id ?? null,
    monitor_record: result.monitorRecord,
    ready: result.exitCode === EXIT_READY,
    tier: result.tier.tier,
    tier_descriptor: result.tier.descriptor,
    tier_primitive: result.tier.primitive,
  };
}

export { EXIT_CONFIG_ERROR, EXIT_NOT_READY, EXIT_READY, MONITORING_TIER_1, MONITORING_TIER_3 };
