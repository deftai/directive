import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * True when this module is the process entrypoint, including npm bin symlinks.
 * Node passes the symlink path in argv[1]; compare via realpath on both sides.
 */
export function isDirectEntrypoint(moduleUrl: string | URL): boolean {
  const argv1 = process.argv[1];
  if (argv1 === undefined) return false;
  try {
    const modulePath = fileURLToPath(moduleUrl);
    return realpathSync(argv1) === realpathSync(modulePath);
  } catch {
    return false;
  }
}
