import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const FALLBACK = "0.0.0";

export function readLauncherVersion(): string {
  try {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
    const parsed: unknown = JSON.parse(readFileSync(pkgPath, "utf8"));
    if (parsed !== null && typeof parsed === "object") {
      const version = (parsed as { version?: unknown }).version;
      if (typeof version === "string" && version.length > 0) return version;
    }
  } catch {
    // fall through
  }
  return FALLBACK;
}
