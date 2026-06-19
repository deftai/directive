import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pyStrRepr } from "../triage/scope/python-repr.js";
import { isRelativeTo, resolveRefPath, scopeIdsForRefUri } from "./paths.js";
import { runProjectDefinitionHooks } from "./plan-hooks.js";
import type { JsonObject } from "./schema.js";
import { validateProjectDefNarratives } from "./schema.js";

function itemLocalScopeUris(item: JsonObject, plan: JsonObject): string[] {
  const uris: string[] = [];

  const metadata = item.metadata;
  if (typeof metadata === "object" && metadata !== null && !Array.isArray(metadata)) {
    const meta = metadata as JsonObject;
    const sourcePath = meta.source_path;
    if (typeof sourcePath === "string" && sourcePath) {
      uris.push(sourcePath);
    }
    const metadataRefs = meta.references;
    if (Array.isArray(metadataRefs)) {
      for (const ref of metadataRefs) {
        if (
          typeof ref === "object" &&
          ref !== null &&
          !Array.isArray(ref) &&
          (ref as JsonObject).type === "x-vbrief/plan"
        ) {
          const uri = (ref as JsonObject).uri;
          if (typeof uri === "string" && uri) {
            uris.push(uri);
          }
        }
      }
    }
  }

  const refs = item.references;
  if (Array.isArray(refs)) {
    for (const ref of refs) {
      if (
        typeof ref === "object" &&
        ref !== null &&
        !Array.isArray(ref) &&
        (ref as JsonObject).type === "x-vbrief/plan"
      ) {
        const uri = (ref as JsonObject).uri;
        if (typeof uri === "string" && uri) {
          uris.push(uri);
        }
      }
    }
  }

  const itemId = item.id;
  const itemTitle = item.title;
  const planRefs = plan.references;
  if (Array.isArray(planRefs)) {
    for (const ref of planRefs) {
      if (typeof ref !== "object" || ref === null || Array.isArray(ref)) {
        continue;
      }
      const refObj = ref as JsonObject;
      if (refObj.type !== "x-vbrief/plan") {
        continue;
      }
      const uri = refObj.uri;
      if (typeof uri !== "string" || !uri) {
        continue;
      }
      const titleMatches = typeof itemTitle === "string" && refObj.title === itemTitle;
      const idMatches = typeof itemId === "string" && scopeIdsForRefUri(uri).has(itemId);
      if (titleMatches || idMatches) {
        uris.push(uri);
      }
    }
  }

  return [...new Set(uris)];
}

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
  for (const uri of itemLocalScopeUris(item, plan)) {
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
      errors.push(
        `${filepath}: items[${itemIndex}] status is ${pyStrRepr(itemStatus)} ` +
          `but referenced scope '${uri}' has plan.status ${pyStrRepr(scopeStatus)} ` +
          "(D3 registry-status)",
      );
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
