import { statSync } from "node:fs";
import { resolve } from "node:path";
import { type AgentHookInspection, inspectAgentHookDeposit } from "../init-deposit/agent-hooks.js";
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
import type { OutputStream } from "./verify-hooks-installed.js";

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
    return {
      code: 1,
      message:
        "❌ deft agent hook registration INCOMPLETE:\n" +
        unhealthy
          .map((entry) => `  - ${entry.host}: ${entry.status} at ${entry.path} — ${entry.detail}`)
          .join("\n") +
        "\n  Recovery: run `deft update` (or `directive init`) to refresh project hooks. " +
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
      "DEFT_HOOK_READ_ONLY=1 and explore subagent_type. Codex runtime trust is user-controlled and must be reviewed with `/hooks`; shell/MCP policy is deferred." +
      (disabledHosts.length > 0
        ? ` Intentional hostHooks disabled: ${disabledHosts.join(", ")}.`
        : "") +
      " Per-host mutation tool names verified against the deposited matchers (#3987).",
    stream: "stdout",
    registrations,
    coverage,
  };
}
