import { execFileSync } from "node:child_process";
import { BINARY_PREFERENCE } from "./constants.js";
import { ScmStubError } from "./errors.js";

export type WhichFn = (name: string) => string | null;

/** Default PATH lookup mirroring Python `shutil.which`. Uses the
 * platform-native resolver (`where` on Windows, `which` elsewhere) so
 * executable resolution works cross-platform. */
export function defaultWhich(name: string): string | null {
  const locator = process.platform === "win32" ? "where" : "which";
  try {
    const result = execFileSync(locator, [name], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    // `where` may return multiple lines; take the first non-empty match.
    const first = result.split(/\r?\n/).find((line) => line.trim().length > 0);
    return first !== undefined ? first.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Return `"ghx"` if on PATH, else `"gh"`; raise if neither is present.
 * Mirrors `scripts/scm.py::resolve_binary`.
 *
 * On failure the message is the #2275 fail-loud diagnostic (execution-env
 * boundary + remediation), not an opaque spawn error.
 */
export function resolveBinary(whichFn: WhichFn = defaultWhich): string {
  for (const candidate of BINARY_PREFERENCE) {
    if (whichFn(candidate) !== null) {
      return candidate;
    }
  }
  // Keep the historical substring for existing tests / triage mappers, then
  // append the #2275 execution-env remediation so agents see a named reason.
  throw new ScmStubError(
    "neither 'ghx' nor 'gh' found on PATH in this execution env; " +
      "install GitHub CLI (https://cli.github.com/) or the ghx proxy (#884), " +
      "or pass GH_TOKEN into a matched env and re-run; SCM-dependent gates " +
      "(triage:queue, issue:ingest, pr:*, reconcile:issues, cache:fetch-all, scm:*) " +
      "cannot run here. Framework-local gates do not need SCM. Refs #2275.",
  );
}
