import { existsSync, readdirSync } from "node:fs";
import { join, resolve as pathResolve } from "node:path";
import { loadProjectDefinition } from "./resolve.js";

/** Framework default WIP cap (#1124 / umbrella #1119). */
export const DEFAULT_WIP_CAP = 10;

/** vBRIEF lifecycle folders that count toward the WIP set. */
export const WIP_LIFECYCLE_DIRS = ["pending", "active"] as const;

export type WipCapSource = "typed" | "default" | "default-on-error";

export interface WipCapResult {
  readonly cap: number;
  readonly source: WipCapSource;
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
  if (typeof value === "string") return `'${value}'`;
  if (value === null) return "None";
  if (typeof value === "boolean") return value ? "True" : "False";
  return String(value);
}

/** Resolve plan.policy.wipCap from PROJECT-DEFINITION (#1124). */
export function resolveWipCap(projectRoot: string): WipCapResult {
  const [data, err] = loadProjectDefinition(projectRoot);
  if (data === null) {
    return { cap: DEFAULT_WIP_CAP, source: "default", error: err };
  }

  const plan = data.plan;
  if (typeof plan !== "object" || plan === null || Array.isArray(plan)) {
    return {
      cap: DEFAULT_WIP_CAP,
      source: "default",
      error: "PROJECT-DEFINITION 'plan' is not an object",
    };
  }

  const policyBlock = (plan as Record<string, unknown>).policy;
  if (
    typeof policyBlock !== "object" ||
    policyBlock === null ||
    Array.isArray(policyBlock) ||
    !("wipCap" in policyBlock)
  ) {
    return { cap: DEFAULT_WIP_CAP, source: "default", error: null };
  }

  const raw = (policyBlock as Record<string, unknown>).wipCap;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) {
    return {
      cap: DEFAULT_WIP_CAP,
      source: "default-on-error",
      error: `plan.policy.wipCap must be a non-negative integer; got ${pythonTypeName(raw)} (${pythonRepr(raw)})`,
    };
  }

  return { cap: raw, source: "typed", error: null };
}

/** Count *.vbrief.json files in vbrief/pending/ + vbrief/active/ (#1124). */
export function countVbriefWip(projectRoot: string): number {
  let total = 0;
  const vbriefRoot = join(pathResolve(projectRoot), "vbrief");
  for (const sub of WIP_LIFECYCLE_DIRS) {
    const folder = join(vbriefRoot, sub);
    if (!existsSync(folder)) {
      continue;
    }
    const entries = readdirSync(folder, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".vbrief.json")) {
        total += 1;
      }
    }
  }
  return total;
}
