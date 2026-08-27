import { readdirSync } from "node:fs";
import { join } from "node:path";
import { hasArtifactSuffix } from "../layout/resolve.js";
import { evaluate } from "../preflight/evaluate.js";

export interface ActiveScopeInspection {
  readonly ready: boolean;
  readonly path: string | null;
  readonly message: string;
}

/**
 * Find an implementation-eligible scope by delegating every candidate to the
 * existing xBRIEF preflight evaluator. This intentionally creates no second
 * lifecycle/status policy stack.
 */
export function inspectActiveScope(projectRoot: string): ActiveScopeInspection {
  const candidates: string[] = [];
  for (const relativeDir of [join("xbrief", "active"), join("vbrief", "active")]) {
    const activeDir = join(projectRoot, relativeDir);
    try {
      for (const entry of readdirSync(activeDir, { withFileTypes: true })) {
        if (entry.isFile() && hasArtifactSuffix(entry.name)) {
          candidates.push(join(activeDir, entry.name));
        }
      }
    } catch {
      // A missing/unreadable active folder contributes no eligible candidate.
    }
  }

  // Stable traversal makes the selected path and first rejection reproducible.
  // This is not a priority rule: every candidate is evaluated until one passes.
  candidates.sort();
  let firstRejection: string | null = null;
  for (const candidate of candidates) {
    // #3736: origin freshness remains fail-closed at explicit xbrief:preflight.
    // The host mutation path must stay local and render before its effective timeout.
    const result = evaluate(candidate, { skipOriginFreshness: true });
    if (result.exitCode === 0) {
      return { ready: true, path: candidate, message: result.message };
    }
    firstRejection ??= result.message;
  }

  if (firstRejection !== null) {
    return { ready: false, path: null, message: firstRejection };
  }
  return {
    ready: false,
    path: null,
    message:
      "No active xBRIEF artifact was found under xbrief/active/ " +
      "(or the legacy vbrief/active/ compatibility path).",
  };
}
