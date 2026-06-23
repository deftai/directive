import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const FALLBACK_VERSION = "0.0.0";

function parsePackageVersion(raw: string): string {
  const parsed: unknown = JSON.parse(raw);
  if (parsed === null || typeof parsed !== "object") {
    return FALLBACK_VERSION;
  }
  const version = (parsed as { version?: unknown }).version;
  return typeof version === "string" && version.length > 0 ? version : FALLBACK_VERSION;
}

/** Reads `@deftai/directive-core` version from the installed package.json adjacent to dist/ or src/. */
export function readCorePackageVersion(): string {
  try {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
    return parsePackageVersion(readFileSync(pkgPath, "utf8"));
  } catch {
    return FALLBACK_VERSION;
  }
}
