import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { formatVbriefJson } from "./vbrief-json.js";
import { collectChildUris, collectPlanRefs, resolveVbriefRef } from "./vbrief-ref.js";

function rewriteOnePlanRef(
  value: unknown,
  oldParentResolved: string,
  newParentRel: string,
  vbriefDir: string,
): [unknown, boolean] {
  if (typeof value !== "string" || value.length === 0) {
    return [value, false];
  }
  const resolved = resolveVbriefRef(value, vbriefDir);
  if (resolved === null || resolve(resolved) !== resolve(oldParentResolved)) {
    return [value, false];
  }
  const newValue = value.startsWith("file://") ? `file://${newParentRel}` : newParentRel;
  return [newValue, newValue !== value];
}

function rewriteParentChildReference(
  parentPath: string,
  oldChildResolved: string,
  newChildRel: string,
  vbriefDir: string,
): boolean {
  let parentData: Record<string, unknown>;
  try {
    parentData = JSON.parse(readFileSync(parentPath, "utf8")) as Record<string, unknown>;
  } catch {
    return false;
  }
  const parentPlan = parentData.plan;
  if (typeof parentPlan !== "object" || parentPlan === null || Array.isArray(parentPlan)) {
    return false;
  }
  const plan = parentPlan as Record<string, unknown>;
  const refs = plan.references;
  if (!Array.isArray(refs)) {
    return false;
  }
  let changed = false;
  for (const ref of refs) {
    if (typeof ref !== "object" || ref === null || Array.isArray(ref)) {
      continue;
    }
    const r = ref as Record<string, unknown>;
    if (r.type !== "x-vbrief/plan") {
      continue;
    }
    const resolved = resolveVbriefRef(r.uri, vbriefDir);
    if (resolved === null || resolve(resolved) !== resolve(oldChildResolved)) {
      continue;
    }
    const uri = r.uri;
    const newUri =
      typeof uri === "string" && uri.startsWith("file://") ? `file://${newChildRel}` : newChildRel;
    if (newUri !== uri) {
      r.uri = newUri;
      changed = true;
    }
  }
  if (changed) {
    try {
      writeFileSync(parentPath, formatVbriefJson(parentData), "utf8");
    } catch {
      return false;
    }
  }
  return changed;
}

/** Sync decomposed parents' forward references after a child move (#1485). */
export function updateDecomposedParentBackReferences(
  childData: Record<string, unknown>,
  oldChildPath: string,
  newChildPath: string,
  vbriefDir: string,
): string[] {
  const plan = childData.plan;
  if (typeof plan !== "object" || plan === null || Array.isArray(plan)) {
    return [];
  }
  const oldResolved = resolve(oldChildPath);
  let newRel: string;
  try {
    newRel = relative(resolve(vbriefDir), resolve(newChildPath)).replace(/\\/g, "/");
  } catch {
    return [];
  }
  const updated: string[] = [];
  const seen = new Set<string>();
  for (const planRef of collectPlanRefs(plan as Record<string, unknown>)) {
    const parentPath = resolveVbriefRef(planRef, vbriefDir);
    if (parentPath === null || seen.has(parentPath)) {
      continue;
    }
    seen.add(parentPath);
    if (!existsSync(parentPath)) {
      continue;
    }
    if (rewriteParentChildReference(parentPath, oldResolved, newRel, vbriefDir)) {
      updated.push(parentPath);
    }
  }
  return updated;
}

function rewriteChildParentReference(
  childPath: string,
  oldParentResolved: string,
  newParentRel: string,
  vbriefDir: string,
): boolean {
  let childData: Record<string, unknown>;
  try {
    childData = JSON.parse(readFileSync(childPath, "utf8")) as Record<string, unknown>;
  } catch {
    return false;
  }
  const childPlan = childData.plan;
  if (typeof childPlan !== "object" || childPlan === null || Array.isArray(childPlan)) {
    return false;
  }
  const plan = childPlan as Record<string, unknown>;
  let changed = false;
  const [newRoot, rootChanged] = rewriteOnePlanRef(
    plan.planRef,
    oldParentResolved,
    newParentRel,
    vbriefDir,
  );
  if (rootChanged) {
    plan.planRef = newRoot;
    changed = true;
  }
  const items = plan.items;
  if (Array.isArray(items)) {
    for (const item of items) {
      if (typeof item !== "object" || item === null || Array.isArray(item)) {
        continue;
      }
      const i = item as Record<string, unknown>;
      const [newItem, itemChanged] = rewriteOnePlanRef(
        i.planRef,
        oldParentResolved,
        newParentRel,
        vbriefDir,
      );
      if (itemChanged) {
        i.planRef = newItem;
        changed = true;
      }
    }
  }
  if (changed) {
    try {
      writeFileSync(childPath, formatVbriefJson(childData), "utf8");
    } catch {
      return false;
    }
  }
  return changed;
}

/** Sync decomposed children's planRefs after a parent move (#1487). */
export function updateDecomposedChildBackReferences(
  parentData: Record<string, unknown>,
  oldParentPath: string,
  newParentPath: string,
  vbriefDir: string,
): string[] {
  const plan = parentData.plan;
  if (typeof plan !== "object" || plan === null || Array.isArray(plan)) {
    return [];
  }
  const oldResolved = resolve(oldParentPath);
  let newRel: string;
  try {
    newRel = relative(resolve(vbriefDir), resolve(newParentPath)).replace(/\\/g, "/");
  } catch {
    return [];
  }
  const updated: string[] = [];
  const seen = new Set<string>();
  for (const childUri of collectChildUris(plan as Record<string, unknown>)) {
    const childPath = resolveVbriefRef(childUri, vbriefDir);
    if (childPath === null || seen.has(childPath)) {
      continue;
    }
    seen.add(childPath);
    if (!existsSync(childPath)) {
      continue;
    }
    if (rewriteChildParentReference(childPath, oldResolved, newRel, vbriefDir)) {
      updated.push(childPath);
    }
  }
  return updated;
}

export function detectLifecycleFolder(filePath: string): string | null {
  const parentName = dirname(filePath).split(/[/\\]/).pop() ?? "";
  const folders = new Set(["proposed", "pending", "active", "completed", "cancelled"]);
  return folders.has(parentName) ? parentName : null;
}
