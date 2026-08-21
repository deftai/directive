import { resolve } from "node:path";
import { resolveFrameworkRootForProject } from "../doctor/paths.js";
import type { HookHost } from "../hooks/dispatcher.js";
import type { AgentHookInspection } from "../init-deposit/agent-hooks.js";
import type { HostHooksPolicy } from "../policy/host-hooks.js";
import {
  loadHostHooksPolicyFromProject,
  UNUSED_HOST_HOOKS_RECOVERY,
} from "../policy/host-hooks.js";
import { type AgentHookHealthResult, evaluateAgentHooks } from "./agent-hooks.js";
import {
  type AgentHookLiveProbeResult,
  type AgentHookLiveProbeSeams,
  probeAgentHooksLive,
} from "./agent-hooks-live-probe.js";
import type { OutputStream } from "./verify-hooks-installed.js";

export type AgentHookReadinessRegistration =
  | "registered"
  | "disabled"
  | "missing"
  | "drifted"
  | "not-applicable";
export type AgentHookReadinessFunctionality =
  | "functional"
  | "non-functional"
  | "unavailable"
  | "timed-out"
  | "not-run"
  | "disabled"
  | "not-applicable";
export type AgentHookReadinessTrust = "manual-review-required" | "not-applicable" | "disabled";
export type AgentHookReadinessInterception =
  | "not-directly-verified"
  | "not-applicable"
  | "disabled";
export type AgentHookReadinessLiveStatus =
  | "functional"
  | "non-functional"
  | "unavailable"
  | "timed-out"
  | "not-run"
  | "disabled"
  | "skipped";

export interface AgentHookReadinessHostResult {
  readonly host: HookHost;
  readonly registration: AgentHookReadinessRegistration;
  readonly functionality: AgentHookReadinessFunctionality;
  readonly trust: AgentHookReadinessTrust;
  readonly interception: AgentHookReadinessInterception;
}

export interface AgentHookReadinessResult {
  readonly code: 0 | 1 | 2;
  readonly message: string;
  readonly stream: OutputStream;
  readonly skipped: boolean;
  readonly liveStatus: AgentHookReadinessLiveStatus;
  readonly hosts: readonly AgentHookReadinessHostResult[];
  readonly registrations: readonly AgentHookInspection[];
  readonly liveProbe: AgentHookLiveProbeResult | null;
}

export interface AgentHookReadinessOptions {
  readonly hostHooksPolicy?: HostHooksPolicy;
  readonly consumerContext?: (projectRoot: string) => boolean;
  readonly evaluateStructural?: (
    projectRoot: string,
    policy: HostHooksPolicy,
  ) => AgentHookHealthResult;
  readonly probeLive?: (
    projectRoot: string,
    seams?: AgentHookLiveProbeSeams,
  ) => AgentHookLiveProbeResult;
  readonly liveProbeSeams?: Omit<AgentHookLiveProbeSeams, "hosts">;
}

/** Stable CLI JSON projection; keep the four readiness dimensions orthogonal. */
export function agentHookReadinessJson(result: AgentHookReadinessResult): Record<string, unknown> {
  return {
    ready: result.code === 0,
    exit_code: result.code,
    skipped: result.skipped,
    live_status: result.liveStatus,
    hosts: result.hosts.map((entry) => ({ ...entry })),
    message: result.message,
  };
}

/** Preserve fail-closed readiness semantics when an unexpected evaluator dependency throws. */
export function evaluateAgentHookReadinessSafely(
  projectRoot: string,
  evaluate: (projectRoot: string) => AgentHookReadinessResult = evaluateAgentHookReadiness,
): AgentHookReadinessResult {
  try {
    return evaluate(projectRoot);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    return {
      code: 2,
      message: `❌ deft agent hook readiness unavailable: ${detail}`,
      stream: "stderr",
      skipped: false,
      liveStatus: "unavailable",
      hosts: [],
      registrations: [],
      liveProbe: null,
    };
  }
}

function isConsumerContext(projectRoot: string): boolean {
  return resolve(projectRoot) !== resolve(resolveFrameworkRootForProject(projectRoot));
}

function registrationState(entry: AgentHookInspection): AgentHookReadinessRegistration {
  if (entry.status === "healthy") return "registered";
  return entry.status;
}

function renderHosts(hosts: readonly AgentHookReadinessHostResult[]): string {
  return hosts
    .map(
      (entry) =>
        `  - ${entry.host}: registration=${entry.registration}; functionality=${entry.functionality}; ` +
        `trust=${entry.trust}; interception=${entry.interception}`,
    )
    .join("\n");
}

function baseHostResult(
  entry: AgentHookInspection,
  policy: HostHooksPolicy,
): AgentHookReadinessHostResult {
  if (!policy[entry.host]) {
    return {
      host: entry.host,
      registration: "disabled",
      functionality: "disabled",
      trust: "disabled",
      interception: "disabled",
    };
  }
  return {
    host: entry.host,
    registration: registrationState(entry),
    functionality: "not-run",
    trust: entry.host === "codex" ? "manual-review-required" : "not-applicable",
    interception: "not-directly-verified",
  };
}

/** Fail-closed consumer readiness: structural registration first, installed-shim live probe second. */
export function evaluateAgentHookReadiness(
  projectRoot: string,
  options: AgentHookReadinessOptions = {},
): AgentHookReadinessResult {
  const root = resolve(projectRoot);
  const consumerContext = options.consumerContext ?? isConsumerContext;
  if (!consumerContext(root)) {
    return {
      code: 0,
      message:
        "✓ deft agent hook readiness skipped: maintainer source checkout; consumer hook deposit is not applicable.",
      stream: "stdout",
      skipped: true,
      liveStatus: "skipped",
      hosts: [],
      registrations: [],
      liveProbe: null,
    };
  }

  const policy = options.hostHooksPolicy ?? loadHostHooksPolicyFromProject(root);
  const structural = (options.evaluateStructural ?? evaluateAgentHooks)(root, policy);
  const hosts = structural.registrations.map((entry) => baseHostResult(entry, policy));
  if (structural.code !== 0) {
    return {
      code: structural.code,
      message: `${structural.message}\n${renderHosts(hosts)}`,
      stream: "stderr",
      skipped: false,
      liveStatus: "not-run",
      hosts,
      registrations: structural.registrations,
      liveProbe: null,
    };
  }

  const enabledHosts = structural.registrations
    .filter((entry) => policy[entry.host])
    .map((entry) => entry.host);
  const liveProbe = (options.probeLive ?? probeAgentHooksLive)(root, {
    ...options.liveProbeSeams,
    hosts: enabledHosts,
  });
  const liveByHost = new Map(liveProbe.hosts.map((entry) => [entry.host, entry.status]));
  const evaluatedHosts = hosts.map((entry): AgentHookReadinessHostResult => {
    if (entry.functionality === "disabled") return entry;
    const liveStatus = liveByHost.get(entry.host);
    return {
      ...entry,
      functionality:
        liveStatus === "functional"
          ? "functional"
          : liveStatus === "unavailable"
            ? "unavailable"
            : liveStatus === "timed-out"
              ? "timed-out"
              : liveStatus === "non-functional"
                ? "non-functional"
                : "not-run",
    };
  });
  const allDisabled = enabledHosts.length === 0;
  const timeoutOnly =
    liveProbe.cases.length > 0 && liveProbe.cases.every((entry) => entry.issue === "timed-out");
  const liveStatus: AgentHookReadinessLiveStatus = allDisabled
    ? "disabled"
    : liveProbe.code === 0
      ? "functional"
      : liveProbe.code === 2
        ? "unavailable"
        : timeoutOnly
          ? "timed-out"
          : "non-functional";
  const trustReview = policy.codex
    ? "\n  Codex trust: manual-review-required. Open `/hooks` and approve the exact project hook commands. " +
      "The live probe validates the shim and codec, not host interception."
    : "";
  const unusedHostRecovery =
    liveProbe.code === 0 || timeoutOnly ? "" : `\n  ${UNUSED_HOST_HOOKS_RECOVERY}`;
  return {
    code: liveProbe.code,
    message:
      `${liveProbe.code === 0 ? "✓" : "❌"} deft agent hook readiness: ${liveProbe.message}\n` +
      renderHosts(evaluatedHosts) +
      trustReview +
      unusedHostRecovery,
    stream: liveProbe.code === 0 ? "stdout" : "stderr",
    skipped: false,
    liveStatus,
    hosts: evaluatedHosts,
    registrations: structural.registrations,
    liveProbe,
  };
}
