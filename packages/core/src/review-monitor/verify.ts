import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { sweepScratchDirs } from "../orchestration/subagent-monitor.js";
import { resolveRepo } from "../triage/queue/repo.js";
import {
  EXIT_CONFIG_ERROR,
  EXIT_NOT_READY,
  EXIT_READY,
  MONITORING_TIER_1,
  MONITORING_TIER_3,
} from "./constants.js";
import type { ReviewOwnerGithubSeams } from "./github-lease.js";
import {
  defaultSubagentStatusDir,
  fetchActiveMonitorFromGithub,
  type ReviewMonitorRecord,
  readReviewMonitorFile,
  reviewMonitorPath,
} from "./record.js";
import { isTier1, type MonitoringTierProbe, probeMonitoringTier } from "./tier-detection.js";

/** Same ESRCH/EPERM contract as authz / delivery-attempt claim locks. */
export function isWaitHeartbeatProcessAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // ESRCH → dead. EPERM → exists but unsignalable — treat as alive.
    if (code === "EPERM") return true;
    return false;
  }
}

/** Optional `pid` on a subagent-status heartbeat (native wait identity, #5020). */
export function readWaitHeartbeatPid(filePath: string): number | null {
  try {
    const raw = readFileSync(filePath, "utf8");
    const payload = JSON.parse(raw) as unknown;
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
      return null;
    }
    const pid = (payload as Record<string, unknown>).pid;
    const n = typeof pid === "number" ? pid : Number(pid);
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

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
  readonly seams?: ReviewOwnerGithubSeams;
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
  // Claude Code / Cursor nested-leaf boundary (#2797 / #3134): lead with leaf-safe
  // ownership so implementation leaves never treat nested Task/Agent spawn as the
  // default instruction. Top-level parents that own the primitive still get the
  // Approach 1 background path second.
  if (
    primitive === "claude-agent" ||
    primitive === "cursor-task" ||
    primitive === "grok-bot-executor"
  ) {
    const issueRef = primitive === "grok-bot-executor" ? "#4201" : "#2797 / #3134";
    return (
      `Ownership path for ${primitive} (${issueRef}):\n` +
      "  1. Implementation leaf (drive-to: merge-ready): keep ownership in THIS process " +
      "via blocking dual-invoke `pr:watch` (`deft pr:watch <N>` then `task deft:pr:watch -- <N>`). " +
      `Do NOT nested-spawn another ${primitive} review-monitor.\n` +
      "  2. Or scope leaf `stop-at: pr-open` so the parent/orchestrator that owns " +
      `${primitive} spawns a sibling monitor and registers it.\n` +
      "  3. Top-level parent/orchestrator only: spawn Approach 1 via " +
      `${primitive} (background), include templates/agent-prompt-preamble.md and ` +
      "templates/swarm-greptile-poller-prompt.md, then:\n" +
      "       task review-monitor:register -- --pr <N> --monitor-agent-id <id> " +
      `--platform-primitive ${primitive}\n` +
      "Re-run: task verify:review-monitor -- --pr <N>"
    );
  }
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
  options: {
    now?: Date;
    staleMinutes?: number;
    /** Inject for tests; defaults to `isWaitHeartbeatProcessAlive`. */
    isProcessAlive?: (pid: number) => boolean;
  } = {},
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
  const alive = options.isProcessAlive ?? isWaitHeartbeatProcessAlive;
  return result.records.some((rec) => {
    if (
      rec.pr_number !== pr ||
      rec.failures.length > 0 ||
      rec.is_stale ||
      rec.is_terminal ||
      (rec.phase !== "polling" && rec.phase !== "starting")
    ) {
      return false;
    }
    // When pid is published, it must still be alive — force-kill never runs finally (#5020).
    const pid = readWaitHeartbeatPid(rec.path);
    if (pid !== null && !alive(pid)) {
      return false;
    }
    return true;
  });
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

  // Legacy `.deft/review-monitor.json` is obsolete (#2814); explicit no-op read documents migration.
  readReviewMonitorFile(reviewMonitorPath(projectRoot));

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

  const repo = resolveRepo(args.repo ?? null, projectRoot);
  if (repo === null) {
    return {
      exitCode: EXIT_CONFIG_ERROR,
      message:
        "verify_review_monitor: could not resolve owner/repo — pass --repo OWNER/REPO or run inside a git repo with origin",
      tier,
      monitorRecord: null,
      heartbeatActive: false,
      callSite,
    };
  }

  const githubMonitor = fetchActiveMonitorFromGithub(repo, args.pr, {
    now,
    headSha: args.headSha ?? null,
    seams: args.seams,
  });
  if (githubMonitor !== null && typeof githubMonitor === "object" && "error" in githubMonitor) {
    return {
      exitCode: EXIT_CONFIG_ERROR,
      message: `verify_review_monitor: ${githubMonitor.error}`,
      tier,
      monitorRecord: null,
      heartbeatActive: false,
      callSite,
    };
  }

  const monitorRecord = githubMonitor;
  const heartbeatActive = hasActivePollingHeartbeat(projectRoot, args.pr, {
    now,
    staleMinutes,
  });

  if (monitorRecord !== null) {
    return {
      exitCode: EXIT_READY,
      message:
        `verify_review_monitor: active GitHub review-owner lease for PR #${args.pr} ` +
        `(monitor_agent_id=${monitorRecord.monitor_agent_id}, owner=${monitorRecord.owner}, ` +
        `call-site=${callSite}, tier=1, descriptor=${tier.descriptor ?? "unknown"}).`,
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

  const heartbeatHint = heartbeatActive
    ? "  Note: local subagent heartbeat is present but is not a GitHub review-owner lease (#2814).\n"
    : "";

  return {
    exitCode: EXIT_NOT_READY,
    message:
      `verify_review_monitor: Tier 1 available but no active GitHub review-owner lease for PR #${args.pr} (#2814).\n` +
      heartbeatHint +
      `  Call site: ${siteHint}.\n` +
      `  Detected descriptor=${tier.descriptor ?? "unknown"} primitive=${tier.primitive ?? "none"}.\n` +
      `  Legacy .deft/review-monitor.json is ignored.\n` +
      `  ${spawnRedirect(tier)}`,
    tier,
    monitorRecord: null,
    heartbeatActive,
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
    monitor_owner: result.monitorRecord?.owner ?? null,
    monitor_record: result.monitorRecord,
    ready: result.exitCode === EXIT_READY,
    tier: result.tier.tier,
    tier_descriptor: result.tier.descriptor,
    tier_primitive: result.tier.primitive,
  };
}

export { EXIT_CONFIG_ERROR, EXIT_NOT_READY, EXIT_READY, MONITORING_TIER_1, MONITORING_TIER_3 };
