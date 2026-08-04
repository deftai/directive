import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isRelativeTo, resolveRefPath } from "./paths.js";
import { runProjectDefinitionHooks } from "./plan-hooks.js";
import { formatRegistryStatusMismatch, registryStatusScopeUris } from "./registry-status.js";
import type { JsonObject } from "./schema.js";
import { validateProjectDefNarratives } from "./schema.js";

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJsonObject(path: string): JsonObject | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  return isJsonObject(parsed) ? parsed : null;
}

function validateProjectRegistryScopeStatus(
  item: JsonObject,
  itemIndex: number,
  filepath: string,
  vbriefDir: string,
): string[] {
  const errors: string[] = [];
  const itemStatus = item.status;
  if (typeof itemStatus !== "string") {
    return errors;
  }

  const resolvedRoot = resolve(vbriefDir);
  for (const uri of registryStatusScopeUris(item)) {
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
    const parsedScope = readJsonObject(scopePath);
    if (parsedScope === null) {
      continue;
    }
    const scopePlan = parsedScope.plan;
    if (!isJsonObject(scopePlan)) {
      continue;
    }
    const scopeStatus = scopePlan.status;
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
  if (!isJsonObject(plan)) {
    return errors;
  }
  const planObj = plan;

  errors.push(...validateProjectDefNarratives(filepath, planObj));
  errors.push(...runProjectDefinitionHooks(planObj, filepath));

  const items = planObj.items;
  if (Array.isArray(items)) {
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i];
      if (!isJsonObject(item)) {
        continue;
      }
      const itemObj = item;
      errors.push(...validateProjectRegistryScopeStatus(itemObj, i, filepath, vbriefDir));

      const rawRefs = itemObj.references;
      const refs: unknown[] = Array.isArray(rawRefs) ? rawRefs : [];
      for (const ref of refs) {
        if (!isJsonObject(ref)) {
          continue;
        }
        const uriRaw = ref.uri;
        const uri = typeof uriRaw === "string" ? uriRaw : "";
        if (uri.startsWith("file://")) {
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
