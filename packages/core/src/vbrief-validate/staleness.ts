import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isCurrentGeneratedSpecification, isDeprecationRedirect } from "./precutover.js";
import type { JsonObject } from "./schema.js";

function checkPrdStaleness(prdPath: string, narratives: JsonObject, title: string): string[] {
  let content: string;
  try {
    content = readFileSync(prdPath, "utf8");
  } catch {
    return [];
  }

  if (Object.keys(narratives).length === 0) {
    return [];
  }

  for (const value of Object.values(narratives)) {
    if (typeof value === "string" && value.trim() && !content.includes(value.trim())) {
      return [
        "PRD.md may be stale relative to " +
          "vbrief/specification.vbrief.json -- " +
          "run `task prd:render` to refresh",
      ];
    }
  }

  if (title && !content.includes(title)) {
    return [
      "PRD.md may be stale relative to " +
        "vbrief/specification.vbrief.json -- " +
        "run `task prd:render` to refresh",
    ];
  }

  return [];
}

function checkSpecStaleness(
  specMdPath: string,
  narratives: JsonObject,
  items: unknown[],
  title: string,
): string[] {
  let content: string;
  try {
    content = readFileSync(specMdPath, "utf8");
  } catch {
    return [];
  }

  const projectRoot = join(specMdPath, "..");
  if (isDeprecationRedirect(content) || isCurrentGeneratedSpecification(projectRoot, content)) {
    return [];
  }

  const msg =
    "SPECIFICATION.md may be stale relative to " +
    "vbrief/specification.vbrief.json -- " +
    "run `task spec:render` to refresh";

  if (Array.isArray(items)) {
    for (const item of items) {
      if (typeof item !== "object" || item === null || Array.isArray(item)) {
        continue;
      }
      const itemTitle = (item as JsonObject).title;
      if (typeof itemTitle === "string" && itemTitle && !content.includes(itemTitle)) {
        return [msg];
      }
    }
  }

  for (const value of Object.values(narratives)) {
    if (typeof value === "string" && value.trim() && !content.includes(value.trim())) {
      return [msg];
    }
  }

  if (title && !content.includes(title)) {
    return [msg];
  }

  return [];
}

/** Warn if PRD.md or SPECIFICATION.md are stale relative to specification.vbrief.json (#398). */
export function checkRenderStaleness(vbriefDir: string): string[] {
  const warnings: string[] = [];
  const projectRoot = join(vbriefDir, "..");
  const specPath = join(vbriefDir, "specification.vbrief.json");

  if (!existsSync(specPath)) {
    return warnings;
  }

  let data: JsonObject;
  try {
    data = JSON.parse(readFileSync(specPath, "utf8")) as JsonObject;
  } catch {
    return warnings;
  }

  const plan = data.plan;
  if (typeof plan !== "object" || plan === null || Array.isArray(plan)) {
    return warnings;
  }
  const planObj = plan as JsonObject;
  const narratives =
    typeof planObj.narratives === "object" &&
    planObj.narratives !== null &&
    !Array.isArray(planObj.narratives)
      ? (planObj.narratives as JsonObject)
      : {};
  const items = Array.isArray(planObj.items) ? planObj.items : [];
  const title = typeof planObj.title === "string" ? planObj.title : "";

  const prdPath = join(projectRoot, "PRD.md");
  if (existsSync(prdPath)) {
    warnings.push(...checkPrdStaleness(prdPath, narratives, title));
  }

  const specMdPath = join(projectRoot, "SPECIFICATION.md");
  if (existsSync(specMdPath)) {
    warnings.push(...checkSpecStaleness(specMdPath, narratives, items, title));
  }

  return warnings;
}
