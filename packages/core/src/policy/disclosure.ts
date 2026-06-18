import type { PolicyResult } from "./resolve.js";
import { ENV_BYPASS } from "./resolve.js";

/** One-liner disclosure phrasing for AGENTS.md / setup interview echo. */
export function disclosureLine(result: PolicyResult): string {
  if (result.allowDirectCommits) {
    if (result.source === "env-bypass") {
      return (
        `[deft policy] ${ENV_BYPASS} is set -- ` +
        "branch-protection policy bypassed for this session."
      );
    }
    return (
      "[deft policy] Direct commits to the default branch are ENABLED " +
      `(source: ${result.source}). Branch-protection policy is OFF.`
    );
  }
  if (result.error !== null) {
    return (
      "[deft policy] Branch-protection policy is ON (fail-closed: " +
      `${result.error}). Direct commits to the default branch are blocked.`
    );
  }
  return (
    "[deft policy] Branch-protection policy is ON. Direct commits to the " +
    "default branch are blocked. Use a feature branch."
  );
}
