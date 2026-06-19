import { loadProjectDefinition } from "../policy/resolve.js";

export interface SessionRitualStalenessResult {
  readonly hours: number;
  readonly source: "default" | "typed" | "default-on-error";
  readonly error: string | null;
}

const DEFAULT_SESSION_RITUAL_STALENESS_HOURS = 4;

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

function validateSessionRitualStalenessHoursValue(value: unknown): string[] {
  if (value === null || value === undefined) {
    return [];
  }
  if (typeof value !== "number" || !Number.isInteger(value)) {
    return [
      "plan.policy.sessionRitualStalenessHours must be an integer; got " +
        `${pythonTypeName(value)} (${pythonRepr(value)})`,
    ];
  }
  if (value <= 0) {
    return [`plan.policy.sessionRitualStalenessHours must be > 0; got ${value}`];
  }
  return [];
}

/** Resolve ``plan.policy.sessionRitualStalenessHours`` (#1348). */
export function resolveSessionRitualStalenessHours(
  projectRoot: string,
): SessionRitualStalenessResult {
  const [data, err] = loadProjectDefinition(projectRoot);
  if (data === null) {
    return {
      hours: DEFAULT_SESSION_RITUAL_STALENESS_HOURS,
      source: "default",
      error: err,
    };
  }
  const plan = data.plan;
  if (typeof plan !== "object" || plan === null || Array.isArray(plan)) {
    return {
      hours: DEFAULT_SESSION_RITUAL_STALENESS_HOURS,
      source: "default",
      error: "PROJECT-DEFINITION 'plan' is not an object",
    };
  }
  const policyBlock = (plan as Record<string, unknown>).policy;
  if (
    typeof policyBlock !== "object" ||
    policyBlock === null ||
    Array.isArray(policyBlock) ||
    !("sessionRitualStalenessHours" in policyBlock)
  ) {
    return {
      hours: DEFAULT_SESSION_RITUAL_STALENESS_HOURS,
      source: "default",
      error: null,
    };
  }
  const raw = (policyBlock as Record<string, unknown>).sessionRitualStalenessHours;
  if (raw === null) {
    return {
      hours: DEFAULT_SESSION_RITUAL_STALENESS_HOURS,
      source: "default",
      error: null,
    };
  }
  const errors = validateSessionRitualStalenessHoursValue(raw);
  if (errors.length > 0) {
    return {
      hours: DEFAULT_SESSION_RITUAL_STALENESS_HOURS,
      source: "default-on-error",
      error: errors[0] ?? null,
    };
  }
  return { hours: raw as number, source: "typed", error: null };
}
