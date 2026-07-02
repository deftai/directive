import { statSync } from "node:fs";

/** True when `path` exists and is a directory; false on any stat error. */
export function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
