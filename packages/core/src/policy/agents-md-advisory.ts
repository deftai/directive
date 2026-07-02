import { readPlanPolicy } from "./plan-extensions.js";
import { loadProjectDefinition } from "./resolve.js";

/**
 * Advisory (consumer-side) AGENTS.md legibility budget (#2155).
 *
 * This is the consumer companion to the maintainer-only #645 ratchet
 * (`plan.policy.agentsMdBudget`, fail-closed via `check:framework-source`). A
 * consumer's AGENTS.md has a framework-owned managed section (rendered from the
 * template; the consumer cannot act on its size) and an UNMANAGED region
 * (project header + project-specific rules) that is theirs. Because we cannot
 * know what a given project legitimately needs in that region, the framework
 * has no business failing THEIR build over it. So this budget is:
 *
 * - unmanaged-focused (the managed section is excluded from the count),
 * - a SOFT, operator-adjustable knob, generous by DEFAULT when unset, and
 * - never fail-closing in the default advisory posture (advise -> observe ->
 *   enforce per #1419).
 *
 * Raising `unmanagedSoftMaxLines` is the no-friction, documented way a consumer
 * accepts legitimate growth and silences the advisory nudge.
 */
export interface AgentsMdAdvisoryConfig {
  readonly unmanagedSoftMaxLines: number;
}

export type AgentsMdAdvisorySource = "typed" | "default" | "default-on-error";

export interface AgentsMdAdvisoryResult {
  readonly config: AgentsMdAdvisoryConfig;
  readonly source: AgentsMdAdvisorySource;
  /** Populated only when a malformed field forced a fallback to the default. */
  readonly error: string | null;
}

/**
 * Generous default soft budget for the consumer-authored (unmanaged) region.
 *
 * Deliberately generous: the empirical "map, not a manual" guidance
 * (`content/docs/good-agents-md.md`) is about the whole file's front-door cost,
 * but a compliance-heavy repo or a monorepo with real per-package rules may
 * legitimately need a larger project section. This default only nudges once the
 * unmanaged region gets genuinely large; the consumer raises the field to
 * accept their own trade-off.
 */
export const DEFAULT_UNMANAGED_SOFT_MAX_LINES = 300;

/** Canonical dotted-path name of the typed advisory soft-budget field. */
export const FIELD_AGENTS_MD_ADVISORY_UNMANAGED_SOFT_MAX_LINES =
  "plan.policy.agentsMdAdvisory.unmanagedSoftMaxLines";

function defaultConfig(): AgentsMdAdvisoryConfig {
  return { unmanagedSoftMaxLines: DEFAULT_UNMANAGED_SOFT_MAX_LINES };
}

/**
 * Resolve the advisory soft budget from PROJECT-DEFINITION (#2155).
 *
 * NEVER throws and NEVER surfaces a hard config error: because the advisory is
 * non-blocking by contract, any malformed input degrades gracefully to the
 * generous default (`source: "default-on-error"`, `error` populated for
 * optional display) rather than failing the caller.
 */
export function resolveAgentsMdAdvisory(projectRoot: string): AgentsMdAdvisoryResult {
  const [data, err] = loadProjectDefinition(projectRoot);
  if (data === null) {
    return { config: defaultConfig(), source: "default-on-error", error: err };
  }

  const policyBlock = readPlanPolicy(data.plan);
  if (
    typeof policyBlock !== "object" ||
    policyBlock === null ||
    Array.isArray(policyBlock) ||
    !("agentsMdAdvisory" in (policyBlock as Record<string, unknown>))
  ) {
    return { config: defaultConfig(), source: "default", error: null };
  }

  const rawAdvisory = (policyBlock as Record<string, unknown>).agentsMdAdvisory;
  if (typeof rawAdvisory !== "object" || rawAdvisory === null || Array.isArray(rawAdvisory)) {
    return {
      config: defaultConfig(),
      source: "default-on-error",
      error: "plan.policy.agentsMdAdvisory must be an object with unmanagedSoftMaxLines",
    };
  }

  const block = rawAdvisory as Record<string, unknown>;
  if (!("unmanagedSoftMaxLines" in block)) {
    // Object present but the field unset: treat as unset -> generous default.
    return { config: defaultConfig(), source: "default", error: null };
  }

  const raw = block.unmanagedSoftMaxLines;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) {
    return {
      config: defaultConfig(),
      source: "default-on-error",
      error:
        `${FIELD_AGENTS_MD_ADVISORY_UNMANAGED_SOFT_MAX_LINES} must be a non-negative integer; ` +
        "falling back to the generous default",
    };
  }

  return { config: { unmanagedSoftMaxLines: raw }, source: "typed", error: null };
}
