import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const FALLBACK_VERSION = "0.0.0";

/** Reads `@deftai/directive-core` version from the installed package.json adjacent to dist/ or src/. */
export function readCorePackageVersion(): string {
  try {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
    const parsed = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: unknown };
    return typeof parsed.version === "string" && parsed.version.length > 0
      ? parsed.version
      : FALLBACK_VERSION;
  } catch {
    return FALLBACK_VERSION;
  }
}
