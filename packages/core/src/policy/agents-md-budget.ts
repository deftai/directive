import { readPlanPolicy } from "./plan-extensions.js";
import { loadProjectDefinition } from "./resolve.js";

/**
 * Per-region line-budget ratchet for AGENTS.md (#645).
 *
 * The budget is seeded at the CURRENT per-region line counts and forbids
 * INCREASE, rather than encoding a static absolute ceiling. This decouples the
 * gate from the reduction work (#1882): the file is by definition within its
 * own seeded baseline, so the gate ships green, while any growth past the
 * ratchet fails. Lowering a budget (a reduction PR) is always allowed; raising
 * it is an explicit, reviewed diff to this typed field -- that diff IS the
 * "was this growth deliberate?" checkpoint.
 */
export type HarnessProfile = "cursor" | "none";
export type SkillFrontmatterTier = "daily-core" | "all" | "none";

export interface AgentsMdBudget {
  readonly managedMaxLines: number;
  readonly unmanagedMaxLines: number;
  /**
   * Fail-closed UTF-8 byte ratchet for the managed section (#2452).
   * Seeded at the current measured size so the gate ships green; growth past
   * this ceiling fails. The <=8192 B north-star is reported separately.
   */
  readonly absoluteMaxBytes?: number;
  /**
   * Harness profile for DD-3 skill-frontmatter measurement (#2463).
   * When unset, the gate auto-detects `cursor` when `content/skills/` exists.
   */
  readonly harnessProfile?: HarnessProfile;
  /**
   * Skill tier for DD-3 frontmatter caps (`daily-core` vs `all` vs `none`).
   * Defaults to `all` for reporting when unset.
   */
  readonly skillFrontmatterTier?: SkillFrontmatterTier;
  /**
   * Optional fail-closed ratchet for DD-3 skill-frontmatter bytes (#2463).
   * Advisory when unset; growth past this ceiling fails when set.
   */
  readonly skillFrontmatterMaxBytes?: number;
}

export type AgentsMdBudgetSource = "typed" | "unset" | "default-on-error";

export interface AgentsMdBudgetResult {
  readonly budget: AgentsMdBudget | null;
  readonly source: AgentsMdBudgetSource;
  readonly error: string | null;
}

function pythonTypeName(value: unknown): string {
  if (value === null) return "None";
  if (Array.isArray(value)) return "list";
  if (typeof value === "boolean") return "bool";
  if (typeof value === "number") return Number.isInteger(value) ? "int" : "float";
  if (typeof value === "string") return "str";
  if (typeof value === "object") return "dict";
  return typeof value;
}

function pythonRepr(value: unknown): string {
  if (value === undefined) return "None";
  if (typeof value === "string") return `'${value}'`;
  if (value === null) return "None";
  if (typeof value === "boolean") return value ? "True" : "False";
  return String(value);
}

function readRegion(
  block: Record<string, unknown>,
  key: string,
): { value: number | null; error: string | null } {
  if (!(key in block)) {
    return { value: null, error: `plan.policy.agentsMdBudget.${key} is required` };
  }
  const raw = block[key];
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) {
    return {
      value: null,
      error: `plan.policy.agentsMdBudget.${key} must be a non-negative integer; got ${pythonTypeName(raw)} (${pythonRepr(raw)})`,
    };
  }
  return { value: raw, error: null };
}

function readOptionalRegion(
  block: Record<string, unknown>,
  key: string,
): { value: number | undefined; error: string | null } {
  if (!(key in block)) {
    return { value: undefined, error: null };
  }
  const raw = block[key];
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) {
    return {
      value: undefined,
      error: `plan.policy.agentsMdBudget.${key} must be a non-negative integer; got ${pythonTypeName(raw)} (${pythonRepr(raw)})`,
    };
  }
  return { value: raw, error: null };
}

/** Resolve plan.policy.agentsMdBudget from PROJECT-DEFINITION (#645). */
export function resolveAgentsMdBudget(projectRoot: string): AgentsMdBudgetResult {
  const [data, err] = loadProjectDefinition(projectRoot);
  if (data === null) {
    return { budget: null, source: "default-on-error", error: err };
  }

  const plan = data.plan;
  if (typeof plan !== "object" || plan === null || Array.isArray(plan)) {
    return {
      budget: null,
      source: "default-on-error",
      error: "PROJECT-DEFINITION 'plan' is not an object",
    };
  }

  const policyBlock = readPlanPolicy(plan);
  if (
    typeof policyBlock !== "object" ||
    policyBlock === null ||
    Array.isArray(policyBlock) ||
    !("agentsMdBudget" in policyBlock)
  ) {
    return { budget: null, source: "unset", error: null };
  }

  const rawBudget = (policyBlock as Record<string, unknown>).agentsMdBudget;
  if (typeof rawBudget !== "object" || rawBudget === null || Array.isArray(rawBudget)) {
    return {
      budget: null,
      source: "default-on-error",
      error: `plan.policy.agentsMdBudget must be an object with managedMaxLines and unmanagedMaxLines; got ${pythonTypeName(rawBudget)}`,
    };
  }

  const block = rawBudget as Record<string, unknown>;
  const managed = readRegion(block, "managedMaxLines");
  if (managed.error !== null) {
    return { budget: null, source: "default-on-error", error: managed.error };
  }
  const unmanaged = readRegion(block, "unmanagedMaxLines");
  if (unmanaged.error !== null) {
    return { budget: null, source: "default-on-error", error: unmanaged.error };
  }

  const absolute = readOptionalRegion(block, "absoluteMaxBytes");
  if (absolute.error !== null) {
    return { budget: null, source: "default-on-error", error: absolute.error };
  }

  const skillFrontmatterMax = readOptionalRegion(block, "skillFrontmatterMaxBytes");
  if (skillFrontmatterMax.error !== null) {
    return { budget: null, source: "default-on-error", error: skillFrontmatterMax.error };
  }

  const harnessProfile = readOptionalHarnessProfile(block, "harnessProfile");
  if (harnessProfile.error !== null) {
    return { budget: null, source: "default-on-error", error: harnessProfile.error };
  }

  const skillFrontmatterTier = readOptionalSkillTier(block, "skillFrontmatterTier");
  if (skillFrontmatterTier.error !== null) {
    return { budget: null, source: "default-on-error", error: skillFrontmatterTier.error };
  }

  const budget: AgentsMdBudget = {
    managedMaxLines: managed.value as number,
    unmanagedMaxLines: unmanaged.value as number,
  };
  const withOptional: AgentsMdBudget = {
    ...budget,
    ...(absolute.value !== undefined ? { absoluteMaxBytes: absolute.value } : {}),
    ...(skillFrontmatterMax.value !== undefined
      ? { skillFrontmatterMaxBytes: skillFrontmatterMax.value }
      : {}),
    ...(harnessProfile.value !== undefined ? { harnessProfile: harnessProfile.value } : {}),
    ...(skillFrontmatterTier.value !== undefined
      ? { skillFrontmatterTier: skillFrontmatterTier.value }
      : {}),
  };

  return {
    budget: withOptional,
    source: "typed",
    error: null,
  };
}

const HARNESS_PROFILES = new Set<HarnessProfile>(["cursor", "none"]);
const SKILL_FRONTMATTER_TIERS = new Set<SkillFrontmatterTier>(["daily-core", "all", "none"]);

function readOptionalHarnessProfile(
  block: Record<string, unknown>,
  key: string,
): { value: HarnessProfile | undefined; error: string | null } {
  if (!(key in block)) {
    return { value: undefined, error: null };
  }
  const raw = block[key];
  if (typeof raw !== "string" || !HARNESS_PROFILES.has(raw as HarnessProfile)) {
    return {
      value: undefined,
      error:
        `plan.policy.agentsMdBudget.${key} must be one of ${[...HARNESS_PROFILES].join(", ")}; ` +
        `got ${pythonTypeName(raw)} (${pythonRepr(raw)})`,
    };
  }
  return { value: raw as HarnessProfile, error: null };
}

function readOptionalSkillTier(
  block: Record<string, unknown>,
  key: string,
): { value: SkillFrontmatterTier | undefined; error: string | null } {
  if (!(key in block)) {
    return { value: undefined, error: null };
  }
  const raw = block[key];
  if (typeof raw !== "string" || !SKILL_FRONTMATTER_TIERS.has(raw as SkillFrontmatterTier)) {
    return {
      value: undefined,
      error:
        `plan.policy.agentsMdBudget.${key} must be one of ${[...SKILL_FRONTMATTER_TIERS].join(", ")}; ` +
        `got ${pythonTypeName(raw)} (${pythonRepr(raw)})`,
    };
  }
  return { value: raw as SkillFrontmatterTier, error: null };
}
