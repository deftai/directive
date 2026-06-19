import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const PROJECT_DEFINITION_REL_PATH = "vbrief/PROJECT-DEFINITION.vbrief.json";
const DEFAULT_TRIAGE_SCOPE = [{ rule: "all-open" }] as const;

function loadProjectDefinition(projectRoot: string): Record<string, unknown> | null {
  const path = join(resolve(projectRoot), PROJECT_DEFINITION_REL_PATH);
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

/** Resolve effective `plan.policy.triageScope` rules. */
export function resolveScopeRules(
  projectRoot: string,
  projectDefinition?: Record<string, unknown> | null,
): Array<Record<string, unknown>> {
  const data = projectDefinition ?? loadProjectDefinition(projectRoot);
  if (data === null) return DEFAULT_TRIAGE_SCOPE.map((r) => ({ ...r }));
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

export interface ScopeIgnores {
  readonly labels: Set<string>;
  readonly milestones: Set<string>;
  readonly authors: Set<string>;
}

/** Return label/milestone/author ignore sets from PROJECT-DEFINITION. */
export function resolveScopeIgnores(
  projectRoot: string,
  projectDefinition?: Record<string, unknown> | null,
): ScopeIgnores {
  const out: ScopeIgnores = { labels: new Set(), milestones: new Set(), authors: new Set() };
  const data = projectDefinition ?? loadProjectDefinition(projectRoot);
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

export function subscribedLabels(rules: Array<Record<string, unknown>>): Set<string> {
  const out = new Set<string>();
  for (const rule of rules) {
    if (rule.rule !== "labels") continue;
    for (const key of ["any-of", "all-of"] as const) {
      const value = rule[key];
      if (Array.isArray(value)) {
        for (const label of value) {
          if (typeof label === "string" && label) out.add(label);
        }
      }
    }
  }
  return out;
}

export function collectMilestoneSubscribedNames(
  rules: Array<Record<string, unknown>>,
): Set<string> {
  const out = new Set<string>();
  for (const rule of rules) {
    if (rule.rule !== "milestone") continue;
    const name = rule.name;
    if (typeof name === "string" && name) out.add(name);
    const anyOf = rule["any-of"];
    if (Array.isArray(anyOf)) {
      for (const item of anyOf) {
        if (typeof item === "string" && item) out.add(item);
      }
    }
  }
  return out;
}

export function rulesRequestIsOpen(rules: Array<Record<string, unknown>>): boolean {
  return rules.some((r) => r.rule === "milestone" && r["is-open"] === true);
}

export function subscribedMilestones(
  rules: Array<Record<string, unknown>>,
  openMilestonesSnapshot?: Set<string>,
): Set<string> {
  const out = collectMilestoneSubscribedNames(rules);
  if (rulesRequestIsOpen(rules) && openMilestonesSnapshot) {
    for (const name of openMilestonesSnapshot) out.add(name);
  }
  return out;
}

const GITHUB_HOSTNAMES = new Set(["github.com", "api.github.com"]);

/** Best-effort owner/name inference from cached issue payloads. */
export function inferRepoFromIssues(issues: Array<Record<string, unknown>>): string | null {
  for (const issue of issues) {
    for (const key of ["repository_url", "html_url"] as const) {
      const value = issue[key];
      if (typeof value !== "string" || !value) continue;
      try {
        const parsed = new URL(value);
        const host = (parsed.hostname || "").toLowerCase();
        if (!GITHUB_HOSTNAMES.has(host)) continue;
        const segments = parsed.pathname.split("/").filter(Boolean);
        if (host === "api.github.com" && segments[0] === "repos" && segments.length >= 3) {
          return `${segments[1]}/${segments[2]}`;
        }
        if (segments.length >= 2) return `${segments[0]}/${segments[1]}`;
      } catch {}
    }
  }
  return null;
}
