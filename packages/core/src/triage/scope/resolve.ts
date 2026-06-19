import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DEFAULT_TRIAGE_SCOPE, PROJECT_DEFINITION_REL_PATH } from "./constants.js";

export function projectDefinitionPath(projectRoot: string): string {
  return join(resolve(projectRoot), PROJECT_DEFINITION_REL_PATH);
}

export function loadProjectDefinition(projectRoot: string): Record<string, unknown> | null {
  const path = projectDefinitionPath(projectRoot);
  if (!existsSync(path)) return null;
  try {
    const data = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return typeof data === "object" && data !== null && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function isDefaultApplied(data: Record<string, unknown> | null): boolean {
  if (data === null) return true;
  const plan = data.plan;
  if (typeof plan !== "object" || plan === null || Array.isArray(plan)) return true;
  const policy = (plan as Record<string, unknown>).policy;
  if (typeof policy !== "object" || policy === null || Array.isArray(policy)) return true;
  const scope = (policy as Record<string, unknown>).triageScope;
  return !Array.isArray(scope) || scope.length === 0;
}

export function getRawScope(data: Record<string, unknown> | null): unknown {
  if (data === null) return undefined;
  const plan = data.plan;
  if (typeof plan !== "object" || plan === null || Array.isArray(plan)) return undefined;
  const policy = (plan as Record<string, unknown>).policy;
  if (typeof policy !== "object" || policy === null || Array.isArray(policy)) return undefined;
  return (policy as Record<string, unknown>).triageScope;
}

export function getRawIgnores(data: Record<string, unknown> | null): Record<string, unknown>[] {
  if (data === null) return [];
  const plan = data.plan;
  if (typeof plan !== "object" || plan === null || Array.isArray(plan)) return [];
  const policy = (plan as Record<string, unknown>).policy;
  if (typeof policy !== "object" || policy === null || Array.isArray(policy)) return [];
  const raw = (policy as Record<string, unknown>).triageScopeIgnores;
  return Array.isArray(raw)
    ? raw.filter(
        (e): e is Record<string, unknown> =>
          typeof e === "object" && e !== null && !Array.isArray(e),
      )
    : [];
}

/** Resolve effective plan.policy.triageScope rule list (#1131). */
export function resolveScopeRules(
  projectRoot: string,
  projectDefinition?: Record<string, unknown> | null,
): Record<string, unknown>[] {
  const data =
    projectDefinition !== undefined ? projectDefinition : loadProjectDefinition(projectRoot);
  if (data === null) {
    return DEFAULT_TRIAGE_SCOPE.map((r) => ({ ...r }));
  }
  const plan = data.plan;
  if (typeof plan !== "object" || plan === null || Array.isArray(plan)) {
    return DEFAULT_TRIAGE_SCOPE.map((r) => ({ ...r }));
  }
  const policy = (plan as Record<string, unknown>).policy;
  if (typeof policy !== "object" || policy === null || Array.isArray(policy)) {
    return DEFAULT_TRIAGE_SCOPE.map((r) => ({ ...r }));
  }
  const scope = (policy as Record<string, unknown>).triageScope;
  if (!Array.isArray(scope) || scope.length === 0) {
    return DEFAULT_TRIAGE_SCOPE.map((r) => ({ ...r }));
  }
  const rules = scope.filter(
    (r): r is Record<string, unknown> => typeof r === "object" && r !== null && !Array.isArray(r),
  );
  return rules.length > 0
    ? rules.map((r) => ({ ...r }))
    : DEFAULT_TRIAGE_SCOPE.map((x) => ({ ...x }));
}

export interface ResolvedIgnores {
  readonly labels: Set<string>;
  readonly milestones: Set<string>;
  readonly authors: Set<string>;
}

/** Resolve plan.policy.triageScopeIgnores into typed sets (#1133 / #1182). */
export function resolveScopeIgnores(
  projectRoot: string,
  projectDefinition?: Record<string, unknown> | null,
): ResolvedIgnores {
  const data =
    projectDefinition !== undefined ? projectDefinition : loadProjectDefinition(projectRoot);
  const out: ResolvedIgnores = {
    labels: new Set(),
    milestones: new Set(),
    authors: new Set(),
  };
  if (data === null) return out;
  const plan = data.plan;
  if (typeof plan !== "object" || plan === null || Array.isArray(plan)) return out;
  const policy = (plan as Record<string, unknown>).policy;
  if (typeof policy !== "object" || policy === null || Array.isArray(policy)) return out;
  const raw = (policy as Record<string, unknown>).triageScopeIgnores;
  if (!Array.isArray(raw)) return out;
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
    const rec = entry as Record<string, unknown>;
    const label = rec.label;
    if (typeof label === "string" && label.trim()) out.labels.add(label);
    const milestone = rec.milestone;
    if (typeof milestone === "string" && milestone.trim()) out.milestones.add(milestone);
    if (rec.rule === "author") {
      const anyOf = rec["any-of"];
      if (Array.isArray(anyOf)) {
        for (const name of anyOf) {
          if (typeof name === "string" && name.trim()) out.authors.add(name);
        }
      }
    }
  }
  return out;
}
