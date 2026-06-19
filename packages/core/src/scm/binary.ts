import { execFileSync } from "node:child_process";
import { BINARY_PREFERENCE } from "./constants.js";
import { ScmStubError } from "./errors.js";

export type WhichFn = (name: string) => string | null;

/** Default PATH lookup mirroring Python `shutil.which`. */
export function defaultWhich(name: string): string | null {
  try {
    const result = execFileSync("which", [name], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const trimmed = result.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

/**
 * Return `"ghx"` if on PATH, else `"gh"`; raise if neither is present.
 * Mirrors `scripts/scm.py::resolve_binary`.
 */
export function resolveBinary(whichFn: WhichFn = defaultWhich): string {
  for (const candidate of BINARY_PREFERENCE) {
    if (whichFn(candidate) !== null) {
      return candidate;
    }
  }
  throw new ScmStubError(
    "neither 'ghx' nor 'gh' found on PATH; install GitHub CLI " +
      "(https://cli.github.com/) or the ghx proxy (#884)",
  );
}
