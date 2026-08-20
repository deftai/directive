/**
 * Human merge gate (#1193 R3 / Wave 2 of #2948).
 *
 * When requireHumanMerge is true, agents may open PRs but must not merge.
 * Three enforcement surfaces (mirror #747):
 *  (1) merge preflight refuses agent-initiated merge
 *  (2) verify:branch aggregate surfaces the policy
 *  (3) branch-protection / setup docs require ≥1 human reviewer
 *
 * Override: `task policy:allow-bot-merge -- --confirm` + `DEFT_ALLOW_BOT_MERGE=1`.
 *
 * Head-bound Phase 5→6 approval (#3235): when a `plan:approved` event exists,
 * merge paths also enforce `approved_head_sha == current_head_sha` via
 * `merge-approval-head.ts` (stale head → fail closed + disable auto-merge).
 * That gate is complementary to this policy surface and does not replace it.
 */

import { existsSync, readFileSync } from "node:fs";
import {
  atomicWriteProjectDefinition,
  projectDefinitionMutationLock,
} from "../vbrief-build/project-definition-io.js";
import { migrateLegacyPolicyKey, PLAN_POLICY_KEY, readPlanPolicy } from "./plan-extensions.js";
import { policyColonInvocation } from "./policy-invocation.js";
import {
  appendAuditLog,
  loadProjectDefinition,
  projectDefinitionPath,
  stampChangedToken,
} from "./resolve.js";

export const FIELD_REQUIRE_HUMAN_MERGE = "plan.policy.requireHumanMerge";
export const FIELD_REQUIRE_HUMAN_MERGE_CLI_ALIAS = "requireHumanMerge";
export const FIELD_AUTO_DEPLOY_ON_MERGE = "plan.policy.autoDeployOnMerge";

/** Emergency env-var bypass for agent merge (#1193). */
export const ENV_ALLOW_BOT_MERGE = "DEFT_ALLOW_BOT_MERGE";

/** Legacy narrative key recognized at read time with deprecation warning. */
export const LEGACY_REQUIRE_HUMAN_MERGE_KEY = "Require human merge";

const TRUTHY = new Set(["1", "true", "yes", "on"]);

export type HumanMergeSource =
  | "typed"
  | "legacy-narrative"
  | "auto-deploy-default"
  | "env-bypass"
  | "default";

export interface HumanMergePolicyResult {
  /** True when agents must not merge. */
  readonly requireHumanMerge: boolean;
  readonly source: HumanMergeSource;
  readonly deprecationWarning: string | null;
  readonly error: string | null;
  readonly autoDeployOnMerge: boolean;
}

function envBypassActive(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[ENV_ALLOW_BOT_MERGE] ?? "";
  return TRUTHY.has(raw.trim().toLowerCase());
}

function coerceLegacyNarrative(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return false;
  const low = value.trim().toLowerCase();
  if (["true", "yes", "on", "1"].includes(low)) return true;
  if (/:\s*(true|yes|on|1)\b/.test(low)) return true;
  return false;
}

function readAutoDeploy(policyBlock: Record<string, unknown>): boolean {
  const raw = policyBlock.autoDeployOnMerge;
  return typeof raw === "boolean" ? raw : false;
}

/**
 * Resolve effective human-merge policy (#1193).
 *
 * Order:
 * 1. DEFT_ALLOW_BOT_MERGE=1 → requireHumanMerge effective false (env-bypass)
 * 2. typed plan.policy.requireHumanMerge
 * 3. legacy narrative "Require human merge"
 * 4. autoDeployOnMerge true → default requireHumanMerge true
 * 5. default false (no auto-deploy → agents may merge when other gates allow)
 */
export function resolveHumanMergePolicy(
  projectRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): HumanMergePolicyResult {
  if (envBypassActive(env)) {
    return {
      requireHumanMerge: false,
      source: "env-bypass",
      deprecationWarning: null,
      error: null,
      autoDeployOnMerge: false,
    };
  }

  const [data, err] = loadProjectDefinition(projectRoot);
  if (data === null) {
    return {
      requireHumanMerge: false,
      source: "default",
      deprecationWarning: null,
      error: err,
      autoDeployOnMerge: false,
    };
  }

  const plan = data.plan;
  if (typeof plan !== "object" || plan === null || Array.isArray(plan)) {
    return {
      requireHumanMerge: false,
      source: "default",
      deprecationWarning: null,
      error: "PROJECT-DEFINITION 'plan' is not an object",
      autoDeployOnMerge: false,
    };
  }

  const planObj = plan as Record<string, unknown>;
  const policyRaw = readPlanPolicy(planObj);
  const policyBlock =
    typeof policyRaw === "object" && policyRaw !== null && !Array.isArray(policyRaw)
      ? (policyRaw as Record<string, unknown>)
      : {};
  const autoDeployOnMerge = readAutoDeploy(policyBlock);

  if ("requireHumanMerge" in policyBlock) {
    const raw = policyBlock.requireHumanMerge;
    if (typeof raw !== "boolean") {
      return {
        requireHumanMerge: true, // fail closed on malformed flag when present
        source: "typed",
        deprecationWarning: null,
        error: `plan.policy.requireHumanMerge must be a boolean; got ${typeof raw}`,
        autoDeployOnMerge,
      };
    }
    return {
      requireHumanMerge: raw,
      source: "typed",
      deprecationWarning: null,
      error: null,
      autoDeployOnMerge,
    };
  }

  const narratives = planObj.narratives;
  if (
    typeof narratives === "object" &&
    narratives !== null &&
    !Array.isArray(narratives) &&
    LEGACY_REQUIRE_HUMAN_MERGE_KEY in narratives
  ) {
    const allow = coerceLegacyNarrative(
      (narratives as Record<string, unknown>)[LEGACY_REQUIRE_HUMAN_MERGE_KEY],
    );
    const warn =
      `DEPRECATED: PROJECT-DEFINITION uses the legacy narrative key ` +
      `'${LEGACY_REQUIRE_HUMAN_MERGE_KEY}'. Migrate to typed ` +
      `plan.policy.requireHumanMerge (#1193).`;
    return {
      requireHumanMerge: allow,
      source: "legacy-narrative",
      deprecationWarning: warn,
      error: null,
      autoDeployOnMerge,
    };
  }

  if (autoDeployOnMerge) {
    return {
      requireHumanMerge: true,
      source: "auto-deploy-default",
      deprecationWarning: null,
      error: null,
      autoDeployOnMerge: true,
    };
  }

  return {
    requireHumanMerge: false,
    source: "default",
    deprecationWarning: null,
    error: null,
    autoDeployOnMerge: false,
  };
}

/** Session-start / AGENTS disclosure line when the human merge gate is ON. */
export function humanMergeDisclosureLine(result: HumanMergePolicyResult): string | null {
  if (result.source === "env-bypass") {
    return (
      `[deft policy] ${ENV_ALLOW_BOT_MERGE} is set -- ` +
      "human merge gate bypassed for this session (agent may merge)."
    );
  }
  if (!result.requireHumanMerge) {
    return null;
  }
  return (
    `[deft policy] Human merge gate is ON for this project (source: ${result.source}); ` +
    "agent may open PRs, may not merge."
  );
}

export interface AgentMergeEvaluateResult {
  readonly exitCode: 0 | 1;
  readonly allowed: boolean;
  readonly message: string;
  readonly policy: HumanMergePolicyResult;
}

/**
 * Merge preflight: refuse agent-initiated merge when requireHumanMerge is true.
 * Surface (1) of the three-surface enforcement pattern.
 */
export function evaluateAgentMerge(
  projectRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): AgentMergeEvaluateResult {
  const policy = resolveHumanMergePolicy(projectRoot, env);
  if (!policy.requireHumanMerge) {
    return {
      exitCode: 0,
      allowed: true,
      message:
        policy.source === "env-bypass"
          ? `✓ human-merge gate: ${ENV_ALLOW_BOT_MERGE}=1 bypass -- agent merge allowed.`
          : "✓ human-merge gate: requireHumanMerge is off -- agent merge allowed by policy.",
      policy,
    };
  }

  const parts = [
    "❌ deft human-merge gate: refusing agent-initiated merge (#1193).",
    "",
    `  Source: policy=${policy.source}`,
    "  plan.policy.requireHumanMerge is true — agents may open PRs, may not merge.",
  ];
  if (policy.error !== null) {
    parts.push(`  Error: ${policy.error}`);
  }
  if (policy.deprecationWarning !== null) {
    parts.push(`  Note: ${policy.deprecationWarning}`);
  }
  parts.push(
    "",
    "  How to proceed:",
    "    • Ask a human to review and merge the PR.",
    "    • Or opt out via the typed surface (capability cost):",
    `        ${policyColonInvocation("allow-bot-merge", " -- --confirm")}`,
    `    • Or set the emergency-escape env-var:  ${ENV_ALLOW_BOT_MERGE}=1`,
  );
  return {
    exitCode: 1,
    allowed: false,
    message: parts.join("\n"),
    policy,
  };
}

/**
 * verify:branch aggregate surface (2): advisory line when gate is ON.
 * Does not fail the branch gate on feature branches — merge refuse is surface (1).
 */
export function humanMergeBranchNote(result: HumanMergePolicyResult): string | null {
  if (result.source === "env-bypass") {
    return humanMergeDisclosureLine(result);
  }
  if (!result.requireHumanMerge) return null;
  return (
    `ℹ deft human-merge: requireHumanMerge=true (source: ${result.source}) — ` +
    "agent-initiated merge will be refused; human must merge."
  );
}

export interface HumanMergePolicyField {
  readonly name: string;
  readonly current: boolean;
  readonly default: boolean;
  readonly source: string;
}

/** Inspector for policy:show --field=requireHumanMerge. */
export function inspectRequireHumanMerge(
  data: Record<string, unknown> | null,
  projectRoot?: string,
): HumanMergePolicyField {
  if (projectRoot !== undefined && projectRoot.length > 0) {
    const resolved = resolveHumanMergePolicy(projectRoot);
    return {
      name: FIELD_REQUIRE_HUMAN_MERGE,
      current: resolved.requireHumanMerge,
      default: false,
      source: resolved.source,
    };
  }
  if (data === null) {
    return {
      name: FIELD_REQUIRE_HUMAN_MERGE,
      current: false,
      default: false,
      source: "default",
    };
  }
  const policyBlock = readPlanPolicy(data.plan);
  if (
    typeof policyBlock === "object" &&
    policyBlock !== null &&
    !Array.isArray(policyBlock) &&
    "requireHumanMerge" in (policyBlock as Record<string, unknown>)
  ) {
    const raw = (policyBlock as Record<string, unknown>).requireHumanMerge;
    return {
      name: FIELD_REQUIRE_HUMAN_MERGE,
      current: typeof raw === "boolean" ? raw : true,
      default: false,
      source: "typed",
    };
  }
  if (
    typeof policyBlock === "object" &&
    policyBlock !== null &&
    !Array.isArray(policyBlock) &&
    (policyBlock as Record<string, unknown>).autoDeployOnMerge === true
  ) {
    return {
      name: FIELD_REQUIRE_HUMAN_MERGE,
      current: true,
      default: false,
      source: "auto-deploy-default",
    };
  }
  return {
    name: FIELD_REQUIRE_HUMAN_MERGE,
    current: false,
    default: false,
    source: "default",
  };
}

export const ALLOW_BOT_MERGE_CAPABILITY_COST =
  "\u26a0 Capability-cost disclosure -- allowing bot/agent merge turns OFF the " +
  "deft human merge gate (#1193).\n" +
  "  \u2022 Agents may call `gh pr merge` / `task pr:wait-mergeable-and-merge`.\n" +
  "  \u2022 If autoDeployOnMerge is true, agent merges can reach production unattended.\n" +
  "  \u2022 Reversible: set plan.policy.requireHumanMerge=true or re-run setup.\n" +
  "  \u2022 Change is recorded to meta/policy-changes.log for auditability.";

/** Write requireHumanMerge=false (allow bot merge) with audit trail. */
export function setRequireHumanMerge(
  projectRoot: string,
  options: {
    requireHumanMerge: boolean;
    actor?: string;
    note?: string;
  },
): { changed: boolean; auditEntry: string } {
  const { requireHumanMerge, actor = "agent", note = "" } = options;
  const path = projectDefinitionPath(projectRoot);
  if (!existsSync(path)) {
    throw new Error(`PROJECT-DEFINITION not found at ${path}`);
  }

  return projectDefinitionMutationLock(projectRoot, () => {
    const parsed: unknown = JSON.parse(readFileSync(path, { encoding: "utf8" }));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`PROJECT-DEFINITION at ${path} top-level value is not a JSON object`);
    }
    const data = parsed as Record<string, unknown>;
    if (typeof data.plan !== "object" || data.plan === null || Array.isArray(data.plan)) {
      if (data.plan === undefined) {
        data.plan = {};
      } else {
        throw new Error("PROJECT-DEFINITION 'plan' is not an object");
      }
    }
    const plan = data.plan as Record<string, unknown>;
    migrateLegacyPolicyKey(plan);
    const existingPolicy = plan[PLAN_POLICY_KEY];
    if (
      typeof existingPolicy !== "object" ||
      existingPolicy === null ||
      Array.isArray(existingPolicy)
    ) {
      if (existingPolicy === undefined) {
        plan[PLAN_POLICY_KEY] = {};
      } else {
        throw new Error("plan.policy is not an object");
      }
    }
    const policyBlock = plan[PLAN_POLICY_KEY] as Record<string, unknown>;
    const previous = policyBlock.requireHumanMerge;
    policyBlock.requireHumanMerge = Boolean(requireHumanMerge);

    let legacyDropped = false;
    const narratives = plan.narratives;
    if (
      typeof narratives === "object" &&
      narratives !== null &&
      !Array.isArray(narratives) &&
      LEGACY_REQUIRE_HUMAN_MERGE_KEY in narratives
    ) {
      delete (narratives as Record<string, unknown>)[LEGACY_REQUIRE_HUMAN_MERGE_KEY];
      legacyDropped = true;
    }

    const changed = previous !== Boolean(requireHumanMerge) || legacyDropped;
    const parts = [
      `actor=${actor}`,
      `requireHumanMerge=${requireHumanMerge ? "true" : "false"}`,
      `previous=${previous === undefined ? "None" : String(previous)}`,
    ];
    if (legacyDropped) parts.push("legacy-narrative-migrated=true");
    if (note) {
      parts.push(`note=${note.replace(/\n/g, " ").replace(/\r/g, " ")}`);
    }
    const auditEntry = stampChangedToken(parts.join(" "), changed);
    if (changed) {
      atomicWriteProjectDefinition(path, data);
    }
    appendAuditLog(projectRoot, auditEntry, changed);
    return { changed, auditEntry };
  });
}
