/**
 * Class-check policy (#4980 / #3145 class).
 *
 * Protected globs and test-marker tokens. Test-boundary roots/patterns/allow
 * come from the merge-base test-boundary policy copy, not this file.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/** Machine-checked class-check contract (protected globs + class-3 markers). */
export interface ClassChecksPolicy {
  readonly protectedGlobs: readonly string[];
  /** Basename / resource tokens that mark test-only infra identities. */
  readonly testMarkers: readonly string[];
  readonly source: "file" | "project-definition" | "defaults";
}

/** Default protected destinations for class 4 (#4980). */
export const DEFAULT_PROTECTED_GLOBS: readonly string[] = [
  ".githooks/**",
  ".cursor/hooks.json",
  ".cursor/hooks/**",
  "hooks/**",
  "packages/core/src/authz/**",
  "packages/core/src/class-checks/**",
  "packages/core/src/test-boundary/**",
  "packages/core/src/release-publish/**",
  "packages/cli/src/verify-class-checks.ts",
  "packages/cli/src/verify-test-boundary.ts",
  ".github/workflows/npm-publish.yml",
  ".deft/approved-scope/**",
];

/** Default class-3 test-marker tokens (name / bound resource). */
export const DEFAULT_TEST_MARKERS: readonly string[] = [
  "smoke",
  "test",
  "fixture",
  "mock",
  "canary",
  "e2e-only",
];

function asStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
    .map((s) => s.trim());
}

function parsePolicyObject(
  raw: Record<string, unknown>,
  source: ClassChecksPolicy["source"],
): ClassChecksPolicy {
  const protectedGlobs = asStringArray(raw.protectedGlobs);
  const testMarkers = asStringArray(raw.testMarkers);
  return {
    protectedGlobs: protectedGlobs.length > 0 ? protectedGlobs : DEFAULT_PROTECTED_GLOBS,
    testMarkers: testMarkers.length > 0 ? testMarkers : DEFAULT_TEST_MARKERS,
    source,
  };
}

/** Built-in defaults when no authored class-checks policy exists. */
export function defaultClassChecksPolicy(): ClassChecksPolicy {
  return {
    protectedGlobs: DEFAULT_PROTECTED_GLOBS,
    testMarkers: DEFAULT_TEST_MARKERS,
    source: "defaults",
  };
}

/**
 * Load class-checks policy from explicit path, `.deft/class-checks.policy.json`,
 * then `plan.policy.classChecks` in PROJECT-DEFINITION, else defaults.
 */
export function loadClassChecksPolicy(
  projectRoot: string,
  options: { readonly policyPath?: string | null; readonly fileText?: string | null } = {},
): ClassChecksPolicy {
  if (options.fileText !== undefined && options.fileText !== null) {
    const raw = JSON.parse(options.fileText) as unknown;
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("class-checks policy must be a JSON object");
    }
    return parsePolicyObject(raw as Record<string, unknown>, "file");
  }

  const root = resolve(projectRoot);

  if (options.policyPath !== null && options.policyPath !== undefined) {
    const p = resolve(options.policyPath);
    if (!existsSync(p)) {
      throw new Error(`class-checks policy file not found: ${p}`);
    }
    const raw = JSON.parse(readFileSync(p, "utf8")) as unknown;
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(`class-checks policy must be a JSON object: ${p}`);
    }
    return parsePolicyObject(raw as Record<string, unknown>, "file");
  }

  const deftPolicy = join(root, ".deft", "class-checks.policy.json");
  if (existsSync(deftPolicy)) {
    const raw = JSON.parse(readFileSync(deftPolicy, "utf8")) as unknown;
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(`class-checks policy must be a JSON object: ${deftPolicy}`);
    }
    return parsePolicyObject(raw as Record<string, unknown>, "file");
  }

  const pdPath = join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json");
  if (existsSync(pdPath)) {
    try {
      const pd = JSON.parse(readFileSync(pdPath, "utf8")) as Record<string, unknown>;
      const plan = pd.plan as Record<string, unknown> | undefined;
      const policy = plan?.policy as Record<string, unknown> | undefined;
      const cc = policy?.classChecks as Record<string, unknown> | undefined;
      if (cc !== undefined && cc !== null && typeof cc === "object" && !Array.isArray(cc)) {
        return parsePolicyObject(cc, "project-definition");
      }
    } catch {
      // fall through to defaults
    }
  }

  return defaultClassChecksPolicy();
}
