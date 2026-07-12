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
export interface AgentsMdBudget {
  readonly managedMaxLines: number;
  readonly unmanagedMaxLines: number;
  /**
   * Fail-closed UTF-8 byte ratchet for the managed section (#2452).
   * Seeded at the current measured size so the gate ships green; growth past
   * this ceiling fails. The <=8192 B north-star is reported separately.
   */
  readonly absoluteMaxBytes?: number;
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

  const budget: AgentsMdBudget = {
    managedMaxLines: managed.value as number,
    unmanagedMaxLines: unmanaged.value as number,
  };
  if (absolute.value !== undefined) {
    return {
      budget: { ...budget, absoluteMaxBytes: absolute.value },
      source: "typed",
      error: null,
    };
  }

  return {
    budget,
    source: "typed",
    error: null,
  };
}
