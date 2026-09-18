import { statSync } from "node:fs";
import { resolve } from "node:path";
import { readCorePackageVersion } from "../engine-version.js";
import {
  type AgentHookDepositResult,
  type AgentHookInspection,
  inspectAgentHookDeposit,
  writeAgentHookDeposit,
} from "../init-deposit/agent-hooks.js";
import type { InitDepositIo } from "../init-deposit/constants.js";
import {
  HOST_TOOL_COVERAGE_RECOVERY,
  type HostToolCoverageFinding,
  inspectHostToolCoverage,
} from "../init-deposit/host-tool-coverage.js";
import type { HostHooksPolicy } from "../policy/host-hooks.js";
import {
  loadHostHooksPolicyFromProject,
  UNUSED_HOST_HOOKS_RECOVERY,
} from "../policy/host-hooks.js";
import { compareSemver, readPin } from "../resolution/pin.js";
import {
  type AgentHookLiveProbeResult,
  type AgentHookLiveProbeSeams,
  probeAgentHooksLive,
} from "./agent-hooks-live-probe.js";
import type { OutputStream } from "./verify-hooks-installed.js";

/** #4716 no-swap recovery copy. Disclosure on `deft update` is not P1 relief. */
export const AGENT_HOOK_NO_SWAP_RECOVERY =
  "Recovery: rewrite still-enabled host hook registrations with writeAgentHookDeposit " +
  "(does not swap `.deft/core`). Then re-run `deft verify:hooks-installed --scope=agent --live`. " +
  "`deft update` (or `directive init`) is a repo-wide payload file-swap when VERSION differs " +
  "and is not required to clear this gate. ";

export interface RepairAgentHookRegistrationsOptions {
  readonly io?: InitDepositIo;
  readonly hostHooksPolicy?: HostHooksPolicy;
  /** Override post-write evaluation. Default is structural then live probe. */
  readonly reevaluate?: (projectRoot: string) => { readonly code: 0 | 1 | 2 };
  /** Test seam for the default live probe. */
  readonly probeLive?: (
    projectRoot: string,
    seams?: AgentHookLiveProbeSeams,
  ) => AgentHookLiveProbeResult;
}

/**
 * #4716: write still-enabled host hook files without `runRefreshDeposit` file-swap,
 * then re-run the live probe. Structural inspect stays fail-closed before live.
 */
export function repairAgentHookRegistrations(
  projectRoot: string,
  options: RepairAgentHookRegistrationsOptions = {},
): {
  readonly written: AgentHookDepositResult;
  readonly after: { readonly code: 0 | 1 | 2 };
} {
  const written = writeAgentHookDeposit(projectRoot, options.io, options.hostHooksPolicy);
  if (options.reevaluate) {
    return { written, after: options.reevaluate(projectRoot) };
  }
  const policy = options.hostHooksPolicy ?? loadHostHooksPolicyFromProject(projectRoot);
  const structural = evaluateAgentHooks(projectRoot, policy);
  if (structural.code !== 0) {
    return { written, after: { code: structural.code } };
  }
  const enabledHosts = structural.registrations
    .filter((entry) => policy[entry.host])
    .map((entry) => entry.host);
  const live = (options.probeLive ?? probeAgentHooksLive)(projectRoot, { hosts: enabledHosts });
  return { written, after: { code: live.code } };
}

export interface AgentHookHealthResult {
  readonly code: 0 | 1 | 2;
  readonly message: string;
  readonly stream: OutputStream;
  readonly registrations: readonly AgentHookInspection[];
  /** Host tool-surface coverage gaps found alongside registration health (#3987). */
  readonly coverage: readonly HostToolCoverageFinding[];
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Surface pin/engine skew beside a true valid() fail; do not replace that fail (#4692). */
function formatPinEngineSkewVisibility(projectRoot: string): string | null {
  const pinVersion = readPin(projectRoot).pinVersion;
  if (pinVersion === null) return null;
  const engineVersion = readCorePackageVersion();
  const cmp = compareSemver(engineVersion, pinVersion);
  if (cmp === 0 || cmp === null) return null;
  return (
    `Pin/engine skew is also present (engine ${engineVersion}, pin ${pinVersion}). ` +
    "That is not this valid() fail; `deft update` is not the skew fix."
  );
}

/** Read-only P0 agent-host registration health, independent of git hooks. */
export function evaluateAgentHooks(
  projectRoot: string,
  hostHooksPolicy: HostHooksPolicy = loadHostHooksPolicyFromProject(projectRoot),
  /** Test seam for the #3987 tool-surface coverage probe. */
  inspectCoverage: typeof inspectHostToolCoverage = inspectHostToolCoverage,
): AgentHookHealthResult {
  const root = resolve(projectRoot);
  if (!isDirectory(root)) {
    return {
      code: 2,
      message: `❌ deft agent hooks: project root ${root} does not exist (config error).`,
      stream: "stderr",
      registrations: [],
      coverage: [],
    };
  }

  const registrations = inspectAgentHookDeposit(root, hostHooksPolicy);
  const coverage = inspectCoverage(root, hostHooksPolicy);
  const unhealthy = registrations.filter(
    (entry) => entry.status === "missing" || entry.status === "drifted",
  );
  if (unhealthy.length > 0) {
    const skewNote = formatPinEngineSkewVisibility(root);
    const recovery = `\n  ${AGENT_HOOK_NO_SWAP_RECOVERY}${skewNote === null ? "" : `${skewNote} `}`;
    return {
      code: 1,
      message:
        "❌ deft agent hook registration INCOMPLETE:\n" +
        unhealthy
          .map((entry) => `  - ${entry.host}: ${entry.status} at ${entry.path} — ${entry.detail}`)
          .join("\n") +
        recovery +
        UNUSED_HOST_HOOKS_RECOVERY,
      stream: "stderr",
      registrations,
      coverage,
    };
  }
  // #3987: a structurally current registration can still leave a host tool
  // uncovered, which is the failure this issue is about — a deposit the host
  // never matches is enforcement that never runs.
  if (coverage.length > 0) {
    return {
      code: 1,
      message:
        "❌ deft agent hook tool-surface coverage INCOMPLETE:\n" +
        coverage
          .map(
            (finding) =>
              `  - ${finding.host}: ${finding.kind}` +
              `${finding.toolName === null ? "" : ` \`${finding.toolName}\``} ` +
              `at ${finding.path} — ${finding.detail}`,
          )
          .join("\n") +
        `\n  ${HOST_TOOL_COVERAGE_RECOVERY}`,
      stream: "stderr",
      registrations,
      coverage,
    };
  }

  const disabledHosts = registrations
    .filter((entry) => entry.status === "disabled")
    .map((entry) => entry.host[0]?.toUpperCase() + entry.host.slice(1));
  return {
    code: 0,
    message:
      "✓ deft agent hooks registered and structurally valid for Claude, Grok, Cursor, Codex " +
      "(SessionStart + PreToolUse direct-write and spawn/Task tools; compact re-arm deposited for Claude/Grok/Cursor; " +
      "Codex has no native compact hook — re-run session ritual manually after compaction). " +
      'Read-only explore: prefer Grok role `default_capability_mode = "read-only"`; hooks also honor ' +
      "DEFT_HOOK_READ_ONLY=1 and explore subagent_type. Codex runtime trust is user-controlled and remains manual-review-required; shell/MCP policy is deferred." +
      (disabledHosts.length > 0
        ? ` Intentional hostHooks disabled: ${disabledHosts.join(", ")}.`
        : "") +
      " Per-host mutation tool names verified against the deposited matchers (#3987).",
    stream: "stdout",
    registrations,
    coverage,
  };
}
