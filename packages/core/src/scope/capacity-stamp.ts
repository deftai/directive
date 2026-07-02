import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { resolveProjectDefinitionPath } from "../layout/resolve.js";
import { readPlanPolicy } from "../policy/plan-extensions.js";

function resolveDefaultCapacityBucket(projectRoot: string): string {
  try {
    const path = resolveProjectDefinitionPath(resolve(projectRoot));
    const raw = readFileSync(path, "utf8");
    const data = JSON.parse(raw) as Record<string, unknown>;
    const plan = data.plan;
    if (typeof plan !== "object" || plan === null || Array.isArray(plan)) {
      return "";
    }
    const policy = readPlanPolicy(plan);
    if (typeof policy !== "object" || policy === null || Array.isArray(policy)) {
      return "";
    }
    const allocation = (policy as Record<string, unknown>).capacityAllocation;
    if (typeof allocation !== "object" || allocation === null || Array.isArray(allocation)) {
      return "";
    }
    const defaultBucket = (allocation as Record<string, unknown>).defaultBucket;
    return typeof defaultBucket === "string" ? defaultBucket : "";
  } catch {
    return "";
  }
}

/** Stamp completedAt + capacityBucket onto a completing vBRIEF (#1419). */
export function stampCompletionMetadata(
  plan: Record<string, unknown>,
  projectRoot: string,
  timestamp: string,
): void {
  let metadata = plan.metadata;
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) {
    metadata = {};
    plan.metadata = metadata;
  }
  const meta = metadata as Record<string, unknown>;
  meta.completedAt = timestamp;
  const existing = meta.capacityBucket;
  if (!(typeof existing === "string" && existing.trim().length > 0)) {
    const bucket = resolveDefaultCapacityBucket(projectRoot);
    if (bucket.length > 0) {
      meta.capacityBucket = bucket;
    }
  }
}
