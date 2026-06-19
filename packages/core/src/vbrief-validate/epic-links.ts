import { existsSync } from "node:fs";
import { basename, resolve } from "node:path";
import { resolveRefPath } from "./paths.js";
import type { JsonObject } from "./schema.js";

function collectPlanRefs(plan: JsonObject): string[] {
  const refs: string[] = [];
  const rootRef = plan.planRef;
  if (typeof rootRef === "string" && rootRef) {
    refs.push(rootRef);
  }
  const items = plan.items;
  if (Array.isArray(items)) {
    for (const item of items) {
      if (typeof item === "object" && item !== null && !Array.isArray(item)) {
        const itemRef = (item as JsonObject).planRef;
        if (typeof itemRef === "string" && itemRef) {
          refs.push(itemRef);
        }
      }
    }
  }
  return refs;
}

function hasPlanRefTo(childPlan: JsonObject, parentPath: string, vbriefDir: string): boolean {
  const planRef = childPlan.planRef;
  if (typeof planRef === "string" && planRef) {
    const resolved = resolveRefPath(planRef, vbriefDir);
    if (resolved !== null && resolve(resolved) === resolve(parentPath)) {
      return true;
    }
  }
  const items = childPlan.items;
  if (Array.isArray(items)) {
    for (const item of items) {
      if (typeof item === "object" && item !== null && !Array.isArray(item)) {
        const itemRef = (item as JsonObject).planRef;
        if (typeof itemRef === "string" && itemRef) {
          const resolved = resolveRefPath(itemRef, vbriefDir);
          if (resolved !== null && resolve(resolved) === resolve(parentPath)) {
            return true;
          }
        }
      }
    }
  }
  return false;
}

function pathInRefs(filepath: string, uris: Set<string>, vbriefDir: string): boolean {
  const resolvedFile = resolve(filepath);
  for (const uri of uris) {
    const resolved = resolveRefPath(uri, vbriefDir);
    if (resolved !== null && resolve(resolved) === resolvedFile) {
      return true;
    }
  }
  return false;
}

/** Validate bidirectional references between epic and story vBRIEFs (D4). */
export function validateEpicStoryLinks(
  allVbriefs: ReadonlyMap<string, JsonObject>,
  vbriefDir: string,
  resolvedToOriginal: ReadonlyMap<string, string>,
): string[] {
  const errors: string[] = [];
  const display = (p: string): string => resolvedToOriginal.get(p) ?? p;

  for (const [filepath, data] of allVbriefs) {
    const plan = data.plan;
    if (typeof plan !== "object" || plan === null || Array.isArray(plan)) {
      continue;
    }
    const planObj = plan as JsonObject;
    const fpDisplay = display(filepath);

    const refs = planObj.references;
    if (Array.isArray(refs)) {
      for (const ref of refs) {
        if (typeof ref !== "object" || ref === null || Array.isArray(ref)) {
          continue;
        }
        const refObj = ref as JsonObject;
        const uri = refObj.uri;
        const refType = refObj.type;
        if (typeof uri !== "string" || !uri || typeof refType !== "string" || !refType) {
          continue;
        }
        if (refType !== "x-vbrief/plan") {
          continue;
        }
        const childPath = resolveRefPath(uri, vbriefDir);
        if (childPath === null) {
          continue;
        }
        const resolvedChild = resolve(childPath);
        if (!allVbriefs.has(resolvedChild)) {
          if (existsSync(resolvedChild)) {
            continue;
          }
          errors.push(`${fpDisplay}: references child '${uri}' which does not exist (D4)`);
          continue;
        }
        const childData = allVbriefs.get(resolvedChild);
        if (childData === undefined) {
          continue;
        }
        const childPlan = childData.plan;
        if (typeof childPlan !== "object" || childPlan === null || Array.isArray(childPlan)) {
          continue;
        }
        if (!hasPlanRefTo(childPlan as JsonObject, filepath, vbriefDir)) {
          errors.push(
            `${display(resolvedChild)}: missing planRef back ` +
              `to parent '${basename(display(filepath))}' (D4)`,
          );
        }
      }
    }

    for (const planRef of collectPlanRefs(planObj)) {
      const parentPath = resolveRefPath(planRef, vbriefDir);
      if (parentPath !== null) {
        const resolvedParent = resolve(parentPath);
        if (allVbriefs.has(resolvedParent)) {
          const parentData = allVbriefs.get(resolvedParent);
          if (parentData !== undefined) {
            const parentPlan = parentData.plan;
            if (
              typeof parentPlan === "object" &&
              parentPlan !== null &&
              !Array.isArray(parentPlan)
            ) {
              const parentRefs = (parentPlan as JsonObject).references;
              if (Array.isArray(parentRefs)) {
                const childUris = new Set<string>();
                for (const pref of parentRefs) {
                  if (
                    typeof pref === "object" &&
                    pref !== null &&
                    !Array.isArray(pref) &&
                    (pref as JsonObject).type === "x-vbrief/plan"
                  ) {
                    const u = (pref as JsonObject).uri;
                    if (typeof u === "string") {
                      childUris.add(u);
                    }
                  }
                }
                if (!pathInRefs(filepath, childUris, vbriefDir)) {
                  errors.push(
                    `${fpDisplay}: has planRef to ` +
                      `'${basename(resolvedParent)}' but parent ` +
                      "does not list this file in " +
                      "references (D4)",
                  );
                }
              }
            }
          }
        } else if (!existsSync(resolvedParent)) {
          errors.push(`${fpDisplay}: planRef references '${planRef}' which does not exist (D4)`);
        }
      }
    }
  }

  return errors;
}
