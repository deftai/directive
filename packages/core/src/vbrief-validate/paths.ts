import { basename, relative, resolve, sep } from "node:path";

/** Return true when ``child`` resolves under ``parent``. */
export function isRelativeTo(child: string, parent: string): boolean {
  const resolvedParent = resolve(parent);
  const resolvedChild = resolve(child);
  if (resolvedChild === resolvedParent) {
    return true;
  }
  const prefix = resolvedParent.endsWith(sep) ? resolvedParent : `${resolvedParent}${sep}`;
  return resolvedChild.startsWith(prefix);
}

/** Resolve a reference URI to an absolute filesystem path. */
export function resolveRefPath(uri: string, vbriefDir: string): string | null {
  if (typeof uri !== "string") {
    return null;
  }
  if (uri.startsWith("file://")) {
    const rel = uri.slice("file://".length);
    return resolve(vbriefDir, rel);
  }
  if (uri.startsWith("http://") || uri.startsWith("https://") || uri.startsWith("#")) {
    return null;
  }
  return resolve(vbriefDir, uri);
}

/** Split like Python ``str.split(sep, maxsplit)`` (maxsplit splits, not result length). */
function splitMax(value: string, sep: string, maxsplit: number): string[] {
  if (maxsplit <= 0) {
    return value.split(sep);
  }
  const out: string[] = [];
  let rest = value;
  for (let i = 0; i < maxsplit; i += 1) {
    const idx = rest.indexOf(sep);
    if (idx === -1) {
      break;
    }
    out.push(rest.slice(0, idx));
    rest = rest.slice(idx + sep.length);
  }
  out.push(rest);
  return out;
}

/** Return possible PROJECT-DEFINITION registry IDs for a local scope URI. */
export function scopeIdsForRefUri(uri: string): Set<string> {
  const rel = uri.startsWith("file://") ? uri.slice("file://".length) : uri;
  const name = basename(rel);
  const fullId = name.endsWith(".vbrief.json") ? name.slice(0, -".vbrief.json".length) : name;
  const ids = new Set<string>([fullId]);
  const parts = splitMax(fullId, "-", 3);
  if (
    parts.length === 4 &&
    parts[0]?.length === 4 &&
    parts[1]?.length === 2 &&
    parts[2]?.length === 2 &&
    parts.slice(0, 3).every((part) => /^\d+$/.test(part))
  ) {
    ids.add(parts[3] ?? "");
  }
  return ids;
}

/** Return the lifecycle folder name when ``filePath`` lives under ``vbriefDir``. */
export function lifecycleFolderFor(filePath: string, vbriefDir: string): string | null {
  try {
    const rel = relative(resolve(vbriefDir), resolve(filePath));
    const parts = rel.split(sep).filter(Boolean);
    if (parts.length < 2) {
      return null;
    }
    return parts[0] ?? null;
  } catch {
    return null;
  }
}

/** Display path matching Python ``str(Path)`` for paths discovered under vbriefDir. */
export function displayPath(filePath: string, vbriefDir: string): string {
  try {
    return relative(resolve(vbriefDir, ".."), resolve(filePath)).split(sep).join("/");
  } catch {
    return filePath.split(sep).join("/");
  }
}
