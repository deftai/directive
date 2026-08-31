/**
 * Deterministic host tool-surface coverage check (#3987 acceptance item 3).
 *
 * #3990 shipped a Grok-only catalog asserted by a unit test against the
 * generated matcher constants. That cannot catch what the acceptance item
 * names: a host whose deposit went stale, or a host added with no coverage
 * claim at all (5471374558 F7). This check reads the deposited files, walks
 * every supported host, and fails closed on four distinct silences:
 *
 * 1. A supported host with no audit entry — the "new host drops out of
 *    coverage" case. The typed `HOST_TOOL_SURFACE_AUDIT` record makes this a
 *    compile error inside this package; the runtime check covers hosts added
 *    to the deposit list alone.
 * 2. A catalogued mutation tool name that is not a literal token of any
 *    deposited matcher — the "renamed tool drops out of coverage" case. Read
 *    from the deposit, so a stale file fails even when the constants are right.
 * 3. A catalogued mutation tool name the runtime classifier does not place in
 *    the same group. The deposited matcher is a literal alternation while the
 *    classifier lowercases and strips punctuation, so the two layers can
 *    disagree on a name that is present in both.
 * 4. An audit entry that claims something without saying why: an empty
 *    out-of-scope reason, a host claiming a fully observed surface while naming
 *    no mutation tool, or a non-mutation entry the classifier actually gates.
 */

import { HOOK_HOSTS, type HookHost } from "../hooks/dispatcher.js";
import {
  HOST_TOOL_SURFACE_AUDIT,
  type HostToolSurfaceAudit,
  isDirectWriteTool,
  isShellTool,
  isSpawnTool,
  matcherHasLiteralToken,
} from "../hooks/tools.js";
import { type HostHooksPolicy, isHostHookDepositEnabled } from "../policy/host-hooks.js";
import {
  AGENT_HOOK_PATH_BY_HOST,
  type AgentHookPath,
  depositedPreToolUseMatchers,
} from "./agent-hooks.js";

export type HostToolCoverageFindingKind =
  /** Supported host with no entry in the audit table. */
  | "missing-audit"
  /** Catalogued mutation name absent from every deposited matcher. */
  | "uncovered-tool"
  /** Deposited name the runtime classifier does not place in the same group. */
  | "unclassified-tool"
  /** Audit entry that asserts without a written reason. */
  | "unexplained-entry";

export interface HostToolCoverageFinding {
  readonly host: HookHost;
  readonly path: AgentHookPath;
  readonly kind: HostToolCoverageFindingKind;
  readonly toolName: string | null;
  readonly detail: string;
}

type MutationGroup = "directWrite" | "shell" | "spawn";

const CLASSIFIERS: Readonly<Record<MutationGroup, (toolName: string) => boolean>> = {
  directWrite: isDirectWriteTool,
  shell: isShellTool,
  spawn: isSpawnTool,
};

const MUTATION_GROUPS: readonly MutationGroup[] = ["directWrite", "shell", "spawn"];

function auditFor(host: HookHost): HostToolSurfaceAudit | undefined {
  return (HOST_TOOL_SURFACE_AUDIT as Partial<Record<string, HostToolSurfaceAudit>>)[host];
}

function checkAuditShape(
  host: HookHost,
  path: AgentHookPath,
  audit: HostToolSurfaceAudit,
): HostToolCoverageFinding[] {
  const findings: HostToolCoverageFinding[] = [];
  const mutationNames = MUTATION_GROUPS.flatMap((group) => audit.mutation[group]);
  if (audit.unobservedReason !== null && audit.unobservedReason.trim().length === 0) {
    findings.push({
      host,
      path,
      kind: "unexplained-entry",
      toolName: null,
      detail: "unobservedReason is present but empty — say what was not observed, or set it null.",
    });
  }
  if (audit.unobservedReason === null && mutationNames.length === 0) {
    findings.push({
      host,
      path,
      kind: "unexplained-entry",
      toolName: null,
      detail:
        "the audit claims a fully observed surface yet names no mutation tool. Either list the " +
        "host's mutation spellings or record why the surface is unobserved.",
    });
  }
  if (audit.source.trim().length === 0) {
    findings.push({
      host,
      path,
      kind: "unexplained-entry",
      toolName: null,
      detail: "source is empty — a coverage claim must name where it was observed.",
    });
  }
  for (const [toolName, reason] of Object.entries(audit.nonMutation)) {
    if (reason.trim().length === 0) {
      findings.push({
        host,
        path,
        kind: "unexplained-entry",
        toolName,
        detail: "listed out of scope with no written reason.",
      });
      continue;
    }
    const gated = MUTATION_GROUPS.find((group) => CLASSIFIERS[group](toolName));
    if (gated !== undefined) {
      findings.push({
        host,
        path,
        kind: "unexplained-entry",
        toolName,
        detail: `recorded as out of scope, but the runtime classifier gates it as ${gated}.`,
      });
    }
  }
  return findings;
}

/**
 * Read-only per-host coverage probe over the deposited matchers.
 * A host whose deposit is missing or unreadable is skipped: that is a
 * registration failure with its own remediation, reported by
 * `inspectAgentHookDeposit`, and reporting it twice hides which one to fix.
 */
export function inspectHostToolCoverage(
  projectRoot: string,
  hostHooksPolicy: HostHooksPolicy,
): readonly HostToolCoverageFinding[] {
  const findings: HostToolCoverageFinding[] = [];
  for (const host of HOOK_HOSTS) {
    const path = AGENT_HOOK_PATH_BY_HOST[host];
    if (!isHostHookDepositEnabled(host, hostHooksPolicy)) continue;
    const audit = auditFor(host);
    if (audit === undefined) {
      findings.push({
        host,
        path,
        kind: "missing-audit",
        toolName: null,
        detail:
          "supported host has no entry in HOST_TOOL_SURFACE_AUDIT, so nothing states which of " +
          "its tool names must be covered.",
      });
      continue;
    }
    findings.push(...checkAuditShape(host, path, audit));
    const matchers = depositedPreToolUseMatchers(projectRoot, host);
    if (matchers === null) continue;
    for (const group of MUTATION_GROUPS) {
      for (const toolName of audit.mutation[group]) {
        if (!matchers.some((matcher) => matcherHasLiteralToken(matcher, toolName))) {
          findings.push({
            host,
            path,
            kind: "uncovered-tool",
            toolName,
            detail: `${group} tool is absent from every deposited PreToolUse matcher.`,
          });
        }
        if (!CLASSIFIERS[group](toolName)) {
          findings.push({
            host,
            path,
            kind: "unclassified-tool",
            toolName,
            detail: `${group} tool is not recognized by the runtime ${group} classifier.`,
          });
        }
      }
    }
  }
  return findings;
}

/** Remediation line for the coverage class, distinct from the deposit-refresh one. */
export const HOST_TOOL_COVERAGE_RECOVERY =
  "Recovery: run `deft update` to re-deposit the current matchers. If a finding survives that, " +
  "the tool name is missing from Directive's own catalog rather than from your deposit — report " +
  "it upstream with the host and tool name. Audit record: .deft/core/docs/host-tool-surface-audit.md (#3987).";
