import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const FALLBACK_VERSION = "0.0.0";
const VERSION_PACKAGE_NAMES = new Set(["@deftai/directive-core", "@deftai/directive-runtime"]);

function parsePackageVersion(raw: string): string {
  const parsed: unknown = JSON.parse(raw);
  if (parsed === null || typeof parsed !== "object") {
    return FALLBACK_VERSION;
  }
  const version = (parsed as { version?: unknown }).version;
  return typeof version === "string" && version.length > 0 ? version : FALLBACK_VERSION;
}

/**
 * Reads engine version from the nearest package.json named `@deftai/directive-core`
 * (workspace) or `@deftai/directive-runtime` (published stage: vendor/ has no
 * nested package.json, so walk up to the runtime root).
 */
export function readCorePackageVersion(): string {
  try {
    let dir = dirname(fileURLToPath(import.meta.url));
    for (;;) {
      const pkgPath = join(dir, "package.json");
      try {
        if (statSync(pkgPath).isFile()) {
          const raw = readFileSync(pkgPath, "utf8");
          const parsed: unknown = JSON.parse(raw);
          if (
            parsed !== null &&
            typeof parsed === "object" &&
            VERSION_PACKAGE_NAMES.has(String((parsed as { name?: string }).name ?? ""))
          ) {
            return parsePackageVersion(raw);
          }
        }
      } catch {
        // Missing / unreadable — keep walking.
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    // Fall through.
  }
  return FALLBACK_VERSION;
}
