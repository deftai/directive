import { resolve } from "node:path";

/** Resolve a vBRIEF reference URI to an absolute path, or null. */
export function resolveVbriefRef(uri: unknown, vbriefDir: string): string | null {
  if (typeof uri !== "string" || uri.length === 0) {
    return null;
  }
  let rel: string;
  if (uri.startsWith("file://")) {
    rel = uri.slice("file://".length);
  } else if (uri.startsWith("http://") || uri.startsWith("https://") || uri.startsWith("#")) {
    return null;
  } else {
    rel = uri;
  }
  return resolve(vbriefDir, rel);
}

/** Collect planRef values from the plan root and top-level items. */
export function collectPlanRefs(plan: Record<string, unknown>): string[] {
  const refs: string[] = [];
  const rootRef = plan.planRef;
  if (typeof rootRef === "string" && rootRef.length > 0) {
    refs.push(rootRef);
  }
  const items = plan.items;
  if (Array.isArray(items)) {
    for (const item of items) {
      if (typeof item === "object" && item !== null && !Array.isArray(item)) {
        const itemRef = (item as Record<string, unknown>).planRef;
        if (typeof itemRef === "string" && itemRef.length > 0) {
          refs.push(itemRef);
        }
      }
    }
  }
  return refs;
}

/** Collect x-vbrief/plan child reference uris from a parent plan. */
export function collectChildUris(plan: Record<string, unknown>): string[] {
  const uris: string[] = [];
  const refs = plan.references;
  if (!Array.isArray(refs)) {
    return uris;
  }
  for (const ref of refs) {
    if (typeof ref !== "object" || ref === null || Array.isArray(ref)) {
      continue;
    }
    const r = ref as Record<string, unknown>;
    if (r.type !== "x-vbrief/plan") {
      continue;
    }
    const uri = r.uri;
    if (typeof uri === "string" && uri.length > 0) {
      uris.push(uri);
    }
  }
  return uris;
}

/** Return registry IDs that may name a vBRIEF filename. */
export function scopeIdsForFilename(filename: string): Set<string> {
  let fullId: string;
  if (filename.endsWith(".vbrief.json")) {
    fullId = filename.slice(0, -".vbrief.json".length);
  } else {
    fullId = filename.replace(/\.[^.]+$/, "");
  }
  const ids = new Set<string>([fullId]);
  const parts = fullId.split("-");
  if (parts.length >= 4) {
    const [y, m, d, ...rest] = parts;
    if (
      y?.length === 4 &&
      m?.length === 2 &&
      d?.length === 2 &&
      [y, m, d].every((p) => /^\d+$/.test(p)) &&
      rest.length > 0
    ) {
      ids.add(rest.join("-"));
    }
  }
  return ids;
}

export function relativeToVbrief(path: string, vbriefRoot: string): string | null {
  const resolved = resolve(path);
  const root = resolve(vbriefRoot);
  if (!resolved.startsWith(`${root}/`) && resolved !== root) {
    return null;
  }
  return resolved.slice(root.length + 1).replace(/\\/g, "/");
}

export function canonicalRelpath(filePath: string, projectRoot: string): string {
  const resolved = resolve(filePath);
  const root = resolve(projectRoot);
  if (resolved.startsWith(`${root}/`) || resolved === root) {
    return resolved.slice(root.length + (resolved === root ? 0 : 1)).replace(/\\/g, "/");
  }
  return resolved.replace(/\\/g, "/");
}
