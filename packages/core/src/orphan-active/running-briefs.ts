import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { hasArtifactSuffix, resolveLifecycleRoot } from "../layout/resolve.js";

/** Active lifecycle brief whose plan.status is running. */
export interface ActiveRunningBrief {
  readonly path: string;
  readonly plan: Record<string, unknown>;
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function planOf(data: Record<string, unknown> | null): Record<string, unknown> | null {
  const plan = data?.plan;
  return typeof plan === "object" && plan !== null && !Array.isArray(plan)
    ? (plan as Record<string, unknown>)
    : null;
}

/**
 * Enumerate running briefs under an already-resolved lifecycle root.
 * Shared by orphan-active, closeout-attestable, and --allow-close (#4628).
 */
export function listActiveRunningBriefsFromLifecycleRoot(
  lifecycleRoot: string,
): ActiveRunningBrief[] {
  const activeDir = join(lifecycleRoot, "active");
  if (!existsSync(activeDir)) {
    return [];
  }
  const out: ActiveRunningBrief[] = [];
  for (const entry of readdirSync(activeDir, { withFileTypes: true })) {
    if (!entry.isFile() || !hasArtifactSuffix(entry.name)) {
      continue;
    }
    const path = join(activeDir, entry.name);
    const plan = planOf(readJson(path));
    if (plan === null || String(plan.status ?? "").toLowerCase() !== "running") {
      continue;
    }
    out.push({ path, plan });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Enumerate running briefs from a project root. Missing xbrief/ layout is empty,
 * not a throw -- callers that need a config error resolve the layout themselves.
 */
export function listActiveRunningBriefs(projectRoot: string): ActiveRunningBrief[] {
  let lifecycleRoot: string;
  try {
    lifecycleRoot = resolveLifecycleRoot(projectRoot);
  } catch {
    return [];
  }
  return listActiveRunningBriefsFromLifecycleRoot(lifecycleRoot);
}
