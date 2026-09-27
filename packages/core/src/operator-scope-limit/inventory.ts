import { existsSync, globSync, readFileSync } from "node:fs";
import { join, posix, relative } from "node:path";
import type { ShippedSurface } from "./types.js";

const SKIP_DIR_RE =
  /(?:^|\/)(?:node_modules|\.git|\.deft|dist|build|coverage|\.next|out|\.turbo)(?:\/|$)/;

const ACTION_FILE_GLOBS = [
  "**/actions.ts",
  "**/actions.tsx",
  "**/actions.js",
  "**/actions.jsx",
  "**/actions/**/*.ts",
  "**/actions/**/*.tsx",
  "**/actions/**/*.js",
  "**/actions/**/*.jsx",
] as const;

const PAGE_GLOBS = [
  "**/app/**/page.ts",
  "**/app/**/page.tsx",
  "**/app/**/page.js",
  "**/app/**/page.jsx",
  "**/src/app/**/page.ts",
  "**/src/app/**/page.tsx",
  "**/src/app/**/page.js",
  "**/src/app/**/page.jsx",
] as const;

const ROUTE_GLOBS = [
  "**/app/**/route.ts",
  "**/app/**/route.tsx",
  "**/app/**/route.js",
  "**/app/**/route.jsx",
  "**/src/app/**/route.ts",
  "**/src/app/**/route.tsx",
  "**/src/app/**/route.js",
  "**/src/app/**/route.jsx",
] as const;

const EXPORT_FN = /\bexport\s+(?:async\s+)?function\s+([A-Za-z_][A-Za-z0-9_]*)\b/g;
const EXPORT_CONST = /\bexport\s+const\s+([A-Za-z_][A-Za-z0-9_]*)\s*=/g;

/**
 * Cheap default inventory of shipped surfaces when callers omit --surfaces-file.
 * Walks common Next.js app/actions layouts under projectRoot; never throws.
 */
export function inventoryDefaultSurfaces(projectRoot: string): ShippedSurface[] {
  if (typeof projectRoot !== "string" || projectRoot.trim().length === 0) {
    return [];
  }
  if (!existsSync(projectRoot)) return [];

  const out: ShippedSurface[] = [];
  const seen = new Set<string>();

  for (const rel of expandGlobs(projectRoot, ACTION_FILE_GLOBS)) {
    const abs = join(projectRoot, rel);
    let text = "";
    try {
      text = readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    for (const name of collectExportedNames(text)) {
      pushSurface(out, seen, { kind: "server-action", id: name, path: rel });
    }
  }

  for (const rel of expandGlobs(projectRoot, PAGE_GLOBS)) {
    const id = routeIdFromAppFile(rel, "page");
    if (id !== null) {
      pushSurface(out, seen, { kind: "page", id, path: rel });
    }
  }

  for (const rel of expandGlobs(projectRoot, ROUTE_GLOBS)) {
    const id = routeIdFromAppFile(rel, "route");
    if (id !== null) {
      pushSurface(out, seen, { kind: "route", id, path: rel });
    }
  }

  return out;
}

function expandGlobs(projectRoot: string, globs: readonly string[]): string[] {
  const hits = new Set<string>();
  for (const pattern of globs) {
    let matches: string[] = [];
    try {
      matches = globSync(pattern, { cwd: projectRoot });
    } catch {
      matches = [];
    }
    for (const match of matches) {
      const rel = toPosix(relative(projectRoot, join(projectRoot, match)));
      if (SKIP_DIR_RE.test(rel)) continue;
      hits.add(rel);
    }
  }
  return [...hits].sort((a, b) => a.localeCompare(b));
}

function collectExportedNames(source: string): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const re of [EXPORT_FN, EXPORT_CONST]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null = re.exec(source);
    while (m !== null) {
      const name = m[1];
      if (typeof name === "string" && name.length > 0 && !seen.has(name)) {
        seen.add(name);
        names.push(name);
      }
      m = re.exec(source);
    }
  }
  return names;
}

/** Map `app/vehicles/new/page.tsx` → `/vehicles/new`. */
function routeIdFromAppFile(rel: string, leaf: "page" | "route"): string | null {
  const posixRel = toPosix(rel);
  const markers = ["/app/", "app/"] as const;
  let afterApp: string | null = null;
  for (const marker of markers) {
    const idx = posixRel.lastIndexOf(marker);
    if (idx >= 0) {
      afterApp = posixRel.slice(idx + marker.length);
      break;
    }
  }
  if (afterApp === null) return null;
  const leafSuffix = new RegExp(`(?:^|/)${leaf}\\.(?:ts|tsx|js|jsx)$`);
  if (!leafSuffix.test(afterApp)) return null;
  const withoutLeaf = afterApp.replace(leafSuffix, "");
  const segments = withoutLeaf
    .split("/")
    .filter((s) => s.length > 0 && !s.startsWith("(") && !s.endsWith(")"));
  if (segments.length === 0) return "/";
  return `/${segments.join("/")}`;
}

function pushSurface(out: ShippedSurface[], seen: Set<string>, surface: ShippedSurface): void {
  const key = `${surface.kind}:${surface.id}`;
  if (seen.has(key)) return;
  seen.add(key);
  out.push(surface);
}

function toPosix(p: string): string {
  return p.split("\\").join(posix.sep);
}
