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

/** Normalize repo-relative path separators for twin pairing (#4919). */
export function normalizeBriefRelPath(raw: string): string {
  return raw.replace(/\\/g, "/").replace(/^\.\//, "");
}

/**
 * Twin pairing key: family + basename (`xbrief/<file>`), not issue number (#4919).
 * Multi-brief issues must not share twins via first-match N.
 */
export function briefPairingKey(relPath: string): string | null {
  const n = normalizeBriefRelPath(relPath);
  const family = n.startsWith("xbrief/") ? "xbrief" : n.startsWith("vbrief/") ? "vbrief" : null;
  const slash = n.lastIndexOf("/");
  const base = slash === -1 ? n : n.slice(slash + 1);
  if (family === null || base.length === 0) {
    return null;
  }
  return `${family}/${base}`;
}

/**
 * Stable brief identity for twin checks: title + origin issue key (#4919).
 * Distinct from pairingKey; both must agree for active↔completed twins.
 */
export function briefPlanIdentity(plan: Record<string, unknown>): string {
  const title = String(plan.title ?? "").trim();
  const refs = plan.references;
  const origins: string[] = [];
  if (Array.isArray(refs)) {
    for (const ref of refs) {
      if (typeof ref !== "object" || ref === null || Array.isArray(ref)) {
        continue;
      }
      const rec = ref as Record<string, unknown>;
      const type = String(rec.type ?? "");
      if (!type.toLowerCase().includes("github-issue")) {
        continue;
      }
      const uri = rec.uri;
      if (typeof uri === "string" && uri.trim().length > 0) {
        origins.push(uri.trim().toLowerCase());
      }
    }
  }
  const origin = origins.join("|");
  return [title, origin].filter((part) => part.length > 0).join("\n");
}

/**
 * Map a nonterminal brief path to its completed twin path by pairingKey (#4919).
 */
export function completedTwinRelPath(relPath: string): string | null {
  const n = normalizeBriefRelPath(relPath);
  const slash = n.lastIndexOf("/");
  const base = slash === -1 ? n : n.slice(slash + 1);
  if (base.length === 0) {
    return null;
  }
  if (
    n.startsWith("xbrief/proposed/") ||
    n.startsWith("xbrief/pending/") ||
    n.startsWith("xbrief/active/")
  ) {
    return `xbrief/completed/${base}`;
  }
  if (
    n.startsWith("vbrief/proposed/") ||
    n.startsWith("vbrief/pending/") ||
    n.startsWith("vbrief/active/")
  ) {
    return `vbrief/completed/${base}`;
  }
  return null;
}

/**
 * Brief-side full-story mark (#4864 / #4919): plan.metadata.productPullRequest.
 * Equivalent durable mark to PR-body `deft-story: N`. Digits-only; null when absent.
 */
export function productPullRequestFromPlan(plan: Record<string, unknown>): number | null {
  const metadata = plan.metadata;
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) {
    return null;
  }
  const raw = (metadata as Record<string, unknown>).productPullRequest;
  if (typeof raw === "number" && Number.isInteger(raw) && raw > 0) {
    return raw;
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (/^\d+$/.test(trimmed)) {
      const n = Number(trimmed);
      return n > 0 ? n : null;
    }
  }
  return null;
}

/**
 * Record or preserve full-story delivery bind (#4864): set metadata.productPullRequest.
 * No-op success when already equal. Refuses overwrite of a different positive stamp.
 * Leftover-complete must keep this field so completed briefs still bind the product PR.
 */
export function stampProductPullRequestOntoPlan(
  plan: Record<string, unknown>,
  prNumber: number,
): boolean {
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    return false;
  }
  const existing = productPullRequestFromPlan(plan);
  if (existing !== null && existing !== prNumber) {
    return false;
  }
  const metadata = plan.metadata;
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) {
    plan.metadata = { productPullRequest: prNumber };
    return true;
  }
  (metadata as Record<string, unknown>).productPullRequest = prNumber;
  return true;
}
