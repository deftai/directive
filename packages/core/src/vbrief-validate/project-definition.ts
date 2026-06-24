import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isRelativeTo, resolveRefPath } from "./paths.js";
import { runProjectDefinitionHooks } from "./plan-hooks.js";
import { formatRegistryStatusMismatch, registryStatusScopeUris } from "./registry-status.js";
import type { JsonObject } from "./schema.js";
import { validateProjectDefNarratives } from "./schema.js";

function validateProjectRegistryScopeStatus(
  item: JsonObject,
  itemIndex: number,
  plan: JsonObject,
  filepath: string,
  vbriefDir: string,
): string[] {
  const errors: string[] = [];
  const itemStatus = item.status;
  if (typeof itemStatus !== "string") {
    return errors;
  }

  const resolvedRoot = resolve(vbriefDir);
  for (const uri of registryStatusScopeUris(item, plan)) {
    if (uri.startsWith("http://") || uri.startsWith("https://") || uri.startsWith("#")) {
      continue;
    }
    const scopePath = resolveRefPath(uri, vbriefDir);
    if (scopePath === null) {
      continue;
    }
    if (!isRelativeTo(scopePath, resolvedRoot) || !existsSync(scopePath)) {
      continue;
    }
    let scopeData: JsonObject;
    try {
      scopeData = JSON.parse(readFileSync(scopePath, "utf8")) as JsonObject;
    } catch {
      continue;
    }
    const scopePlan = scopeData.plan;
    if (typeof scopePlan !== "object" || scopePlan === null || Array.isArray(scopePlan)) {
      continue;
    }
    const scopeStatus = (scopePlan as JsonObject).status;
    if (typeof scopeStatus === "string" && scopeStatus !== itemStatus) {
      errors.push(formatRegistryStatusMismatch(filepath, itemIndex, itemStatus, uri, scopeStatus));
    }
  }
  return errors;
}

/** Validate PROJECT-DEFINITION.vbrief.json specific requirements (D3). */
export function validateProjectDefinition(
  filepath: string,
  data: JsonObject,
  vbriefDir: string,
): string[] {
  const errors: string[] = [];
  const resolvedRoot = resolve(vbriefDir);

  const plan = data.plan;
  if (typeof plan !== "object" || plan === null || Array.isArray(plan)) {
    return errors;
  }
  const planObj = plan as JsonObject;

  errors.push(...validateProjectDefNarratives(filepath, planObj));
  errors.push(...runProjectDefinitionHooks(planObj, filepath));

  const items = planObj.items;
  if (Array.isArray(items)) {
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i];
      if (typeof item !== "object" || item === null || Array.isArray(item)) {
        continue;
      }
      const itemObj = item as JsonObject;
      errors.push(...validateProjectRegistryScopeStatus(itemObj, i, planObj, filepath, vbriefDir));

      const rawRefs = itemObj.references;
      const refs: unknown[] = Array.isArray(rawRefs) ? rawRefs : [];
      for (const ref of refs) {
        if (typeof ref !== "object" || ref === null || Array.isArray(ref)) {
          continue;
        }
        const refObj = ref as JsonObject;
        const uriRaw = refObj.uri;
        const uri = typeof uriRaw === "string" ? uriRaw : "";
        if (uri && uri.startsWith("file://")) {
          const refPath = uri.replace("file://", "");
          const fullPath = resolve(vbriefDir, refPath);
          if (!isRelativeTo(fullPath, resolvedRoot)) {
            errors.push(
              `${filepath}: items[${i}] references ` + `'${refPath}' outside vbrief directory (D3)`,
            );
            continue;
          }
          if (!existsSync(fullPath)) {
            errors.push(
              `${filepath}: items[${i}] references ` + `'${refPath}' which does not exist (D3)`,
            );
          }
        } else if (
          uri &&
          !uri.startsWith("http://") &&
          !uri.startsWith("https://") &&
          !uri.startsWith("#")
        ) {
          const fullPath = resolve(vbriefDir, uri);
          if (!isRelativeTo(fullPath, resolvedRoot)) {
            errors.push(
              `${filepath}: items[${i}] references ` + `'${uri}' outside vbrief directory (D3)`,
            );
            continue;
          }
          if (!existsSync(fullPath)) {
            errors.push(`${filepath}: items[${i}] references '${uri}' which does not exist (D3)`);
          }
        }
      }
    }
  }

  return errors;
}
