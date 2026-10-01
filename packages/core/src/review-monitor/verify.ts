import { existsSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { ContainedWriteError, containedWrite } from "../fs/contained-write.js";
import { sweepScratchDirs } from "../orchestration/subagent-monitor.js";
import { defaultRunGh, fetchPrHeadShaRest } from "../pr-merge-readiness/gh.js";
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
import {
  isTier1,
  type MonitoringTierProbe,
  type PlatformPrimitive,
  probeMonitoringTier,
} from "./tier-detection.js";

/**
 * Heartbeat `parent_id` written by post-CLEAN `pr:wait-mergeable-and-merge` (#5020).
 * Identity join (#5219) accepts this closer path only with a local CLEAN attestation
 * from `pr:watch` (premature closer must not arm --merge-path-arm --live-wait).
 */
export const POST_CLEAN_WAIT_PARENT_ID = "pr-wait-mergeable";

/** Local CLEAN attestation sink for post-CLEAN closer arm (#5219 Greptile). */
export function mergePathCleanAttestationRelPath(pr: number): string {
  return [".deft-scratch", "merge-path-arm", `pr-${pr}.clean.json`].join("/");
}

export type MergePathCleanAttestationWriteResult =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly reason: string };

/**
 * Record that `pr:watch` reached CLEAN for this PR HEAD. Closer
 * `pr-wait-mergeable` heartbeats arm only when attestation SHA matches live HEAD.
 */
export function writeMergePathCleanAttestation(
  projectRoot: string,
  pr: number,
  headSha: string | null = null,
  now: Date = new Date(),
): MergePathCleanAttestationWriteResult {
  if (!Number.isInteger(pr) || pr <= 0) {
    return { ok: false, reason: `invalid pr for CLEAN attestation: ${pr}` };
  }
  const sha = typeof headSha === "string" && headSha.trim().length > 0 ? headSha.trim() : null;
  if (sha === null) {
    return { ok: false, reason: `CLEAN attestation requires head SHA for PR #${pr}` };
  }
  const rootAbs = resolve(projectRoot);
  const relTarget = mergePathCleanAttestationRelPath(pr);
  const path = join(rootAbs, relTarget);
  const escaped = relative(rootAbs, path);
  if (escaped.startsWith("..") || escaped.length === 0) {
    return { ok: false, reason: `CLEAN attestation path escapes project root: ${path}` };
  }
  const payload = {
    pr_number: pr,
    head_sha: sha,
    cleaned_at: now.toISOString(),
    source: "pr:watch",
  };
  try {
    containedWrite({
      root: rootAbs,
      target: relTarget,
      data: `${JSON.stringify(payload)}\n`,
      mode: "replace",
      mkdir: true,
    });
    return { ok: true, path };
  } catch (err) {
    const detail =
      err instanceof ContainedWriteError
        ? `${err.code}: ${err.message}`
        : err instanceof Error
          ? err.message
          : String(err);
    return { ok: false, reason: `CLEAN attestation write failed: ${detail}` };
  }
}

/**
 * True when local CLEAN attestation SHA exactly matches expected HEAD.
 * Omitting expected HEAD fails closed — stale tip A must not arm tip B (#5219).
 */
export function hasMergePathCleanAttestation(
  projectRoot: string,
  pr: number,
  headSha: string | null = null,
): boolean {
  if (!Number.isInteger(pr) || pr <= 0) return false;
  const want = typeof headSha === "string" && headSha.trim().length > 0 ? headSha.trim() : null;
  if (want === null) return false;
  const path = join(resolve(projectRoot), mergePathCleanAttestationRelPath(pr));
  try {
    const raw = readFileSync(path, "utf8");
    const payload = JSON.parse(raw) as unknown;
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
      return false;
    }
    const rec = payload as Record<string, unknown>;
    if (rec.pr_number !== pr) return false;
    const got = typeof rec.head_sha === "string" ? rec.head_sha.trim() : "";
    return got.length > 0 && got === want;
  } catch {
    return false;
  }
} /** Default `parent_id` for a parent-owned / unbound native `pr:watch` (#5020 / #5219). */
export const DEFAULT_PR_WATCH_PARENT_ID = "pr-watch";

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
  /**
   * Resolve live PR HEAD when `--head-sha` omitted so CLEAN attestation cannot
   * arm a newer tip from a stale tip-A file (#5219). Inject in tests.
   */
  readonly fetchPrHeadShaFn?: (pr: number, repo: string) => string | null;
}
export interface VerifyReviewMonitorResult {
  readonly exitCode: typeof EXIT_READY | typeof EXIT_NOT_READY | typeof EXIT_CONFIG_ERROR;
  readonly message: string;
  readonly tier: MonitoringTierProbe;
  readonly monitorRecord: ReviewMonitorRecord | null;
  readonly heartbeatActive: boolean;
  readonly callSite: ReviewMonitorCallSite;
}

/** Approach 1 spawn + register redirect for Tier-1 hosts (#2655 / #5219). */
export function spawnRedirect(probe: MonitoringTierProbe): string {
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
    /**
     * When non-empty, heartbeat `parent_id` MUST match one of these ids (#5219).
     * Used to join a leased `monitor_agent_id` (and post-CLEAN wait-merge) to the
     * live wait so a parent-shell `pr:watch` (`parent_id=pr-watch`) cannot arm.
     */
    expectedParentIds?: readonly string[];
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
  const expectedParentIds = options.expectedParentIds ?? [];
  const requireParentJoin = expectedParentIds.length > 0;
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
    if (requireParentJoin) {
      const parentId = typeof rec.parent_id === "string" ? rec.parent_id : "";
      if (!expectedParentIds.includes(parentId)) {
        return false;
      }
    }
    // When pid is published, it must still be alive — force-kill never runs finally (#5020).
    const pid = readWaitHeartbeatPid(rec.path);
    if (pid !== null && !alive(pid)) {
      return false;
    }
    return true;
  });
}

/**
 * Merge-path live-wait heartbeat with Tier-1 `spawn_subagent` identity join (#5219).
 *
 * When the host primitive is `spawn_subagent` and a sticky lease exists:
 * - lease `platform_primitive` MUST be `spawn_subagent`
 * - live wait `parent_id` MUST be the lease `monitor_agent_id` (Approach 1 child), or
 * - {@link POST_CLEAN_WAIT_PARENT_ID} **and** CLEAN attestation for the **live** PR HEAD
 * Parent-shell native `pr:watch` (`parent_id=pr-watch`) does not count.
 * Live HEAD is resolved only on the closer path (child heartbeat skips the lookup).
 * Caller `--head-sha` cannot override a newer live tip (#5219 Greptile).
 *
 * Non-`spawn_subagent` tiers keep the unscoped #5020 heartbeat predicate.
 */
export function heartbeatActiveForMergePathArm(
  projectRoot: string,
  pr: number,
  input: {
    readonly tierPrimitive: PlatformPrimitive | null;
    readonly lease: ReviewMonitorRecord | null;
    now?: Date;
    staleMinutes?: number;
    isProcessAlive?: (pid: number) => boolean;
    /** Hint only; live HEAD from {@link resolveLiveHeadSha} wins for attestation. */
    headSha?: string | null;
    /** Lazy live PR HEAD — invoked only when child heartbeat is absent (#5219 P2). */
    resolveLiveHeadSha?: () => string | null;
  },
): boolean {
  const base = {
    now: input.now,
    staleMinutes: input.staleMinutes,
    isProcessAlive: input.isProcessAlive,
  };
  if (input.tierPrimitive === "spawn_subagent" && input.lease !== null) {
    if (input.lease.platform_primitive !== "spawn_subagent") {
      return false;
    }
    const monitorId = input.lease.monitor_agent_id.trim();
    if (monitorId.length === 0) {
      return false;
    }
    if (
      hasActivePollingHeartbeat(projectRoot, pr, {
        ...base,
        expectedParentIds: [monitorId],
      })
    ) {
      return true;
    }
    // Closer path requires a successful live HEAD lookup — never fall back to a
    // caller --head-sha (stale tip-A must not arm when lookup fails) (#5219).
    const liveRaw = input.resolveLiveHeadSha?.() ?? null;
    const live = typeof liveRaw === "string" && liveRaw.trim().length > 0 ? liveRaw.trim() : null;
    if (live === null) {
      return false;
    }
    if (!hasMergePathCleanAttestation(projectRoot, pr, live)) {
      return false;
    }
    return hasActivePollingHeartbeat(projectRoot, pr, {
      ...base,
      expectedParentIds: [POST_CLEAN_WAIT_PARENT_ID],
    });
  }
  return hasActivePollingHeartbeat(projectRoot, pr, base);
}

/**
 * Cheap Approach 1 babysitter one-liner (#5219 P3): child register + watch first
 * (heartbeat live), then parent `verify --merge-path-arm --live-wait`.
 */
export function formatApproach1BabysitterOneLiner(
  pr: number,
  monitorAgentId: string,
  platformPrimitive: PlatformPrimitive = "spawn_subagent",
): string {
  const id = monitorAgentId.trim().length > 0 ? monitorAgentId.trim() : "<id>";
  return (
    `task review-monitor:register -- --pr ${pr} --monitor-agent-id ${id} ` +
    `--platform-primitive ${platformPrimitive}\n` +
    `DEFT_MONITOR_AGENT_ID=${id} task pr:watch -- ${pr} --monitor-agent-id ${id}\n` +
    `# parent after child watch is live:\n` +
    `task verify:review-monitor -- --pr ${pr} --merge-path-arm --live-wait`
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
  const fetchHead =
    args.fetchPrHeadShaFn ??
    ((prNum: number, r: string) => {
      const got = fetchPrHeadShaRest(prNum, r, defaultRunGh);
      return got.sha;
    });
  const heartbeatActive = heartbeatActiveForMergePathArm(projectRoot, args.pr, {
    tierPrimitive: tier.primitive,
    lease: monitorRecord,
    now,
    staleMinutes,
    headSha: args.headSha ?? null,
    // Lazy: only runs when Approach 1 child heartbeat is absent (#5219 P2).
    resolveLiveHeadSha: () => fetchHead(args.pr, repo),
  });

  if (monitorRecord !== null) {
    return {
      exitCode: EXIT_READY,
      message:
        `verify_review_monitor: active GitHub review-owner lease for PR #${args.pr} ` +
        `(monitor_agent_id=${monitorRecord.monitor_agent_id}, owner=${monitorRecord.owner}, ` +
        `platform_primitive=${monitorRecord.platform_primitive}, ` +
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
