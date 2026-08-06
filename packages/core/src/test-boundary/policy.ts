/**
 * Typed test-boundary policy (#3145).
 *
 * Declares production vs test placement roots and conventional test-file
 * patterns so verify:test-boundary can fail closed with concrete remediation.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/** Explicit exception or production-liveness classification. */
export interface TestBoundaryAllowEntry {
  /** Glob or path prefix (POSIX, repo-relative). */
  readonly path: string;
  /** Human-readable reason recorded for review. */
  readonly reason?: string;
  /**
   * `exception` = narrow reviewed carve-out;
   * `production-liveness` = health probe / canary / operational evidence.
   */
  readonly kind?: "exception" | "production-liveness";
}

/** Machine-checked test/source boundary contract. */
export interface TestBoundaryPolicy {
  readonly sourceRoots: readonly string[];
  readonly testRoots: readonly string[];
  readonly fixtureRoots: readonly string[];
  readonly testFilePatterns: readonly string[];
  /** When false (default), production content must not reference test/fixture roots. */
  readonly productionMayReferenceTestRoots: boolean;
  readonly allow: readonly TestBoundaryAllowEntry[];
  /**
   * `warn` = discovery / migration (exit 0 with findings);
   * `enforce` = fail closed (exit 1). Default `enforce` when policy is present,
   * `warn` when only defaults are inferred (migration path).
   */
  readonly enforcementMode: "warn" | "enforce";
  /** Where the policy was loaded from (for diagnostics). */
  readonly source: "file" | "project-definition" | "defaults";
}

export const DEFAULT_TEST_FILE_PATTERNS: readonly string[] = [
  "**/test_*.py",
  "**/*_test.py",
  "**/*Tests.cs",
  "**/*Test.cs",
  "**/*.test.ts",
  "**/*.test.tsx",
  "**/*.test.js",
  "**/*.test.jsx",
  "**/*.spec.ts",
  "**/*.spec.tsx",
  "**/*.spec.js",
  "**/*.spec.jsx",
  "**/*_test.go",
];

export const DEFAULT_SOURCE_ROOTS: readonly string[] = [
  "src/**",
  "infra/**",
  "packages/*/src/**",
  "cmd/**",
  "Tools/**",
];

export const DEFAULT_TEST_ROOTS: readonly string[] = [
  "tests/**",
  "test/**",
  "**/__tests__/**",
  "packages/*/test/**",
  // Language-idiomatic colocated tests (not production pollution)
  "packages/*/src/**/*.test.*",
  "packages/*/src/**/*.spec.*",
  "cmd/**/*_test.go",
  "**/*_test.go",
];

export const DEFAULT_FIXTURE_ROOTS: readonly string[] = [
  "tests/fixtures/**",
  "test/fixtures/**",
  "**/fixtures/**",
];

/** Built-in allow entries for framework self-check (colocated language tests). */
export const FRAMEWORK_SELF_ALLOW: readonly TestBoundaryAllowEntry[] = [
  {
    path: "packages/*/src/**/*.test.ts",
    reason: "Directive colocated unit tests under packages/*/src",
    kind: "exception",
  },
  {
    path: "packages/*/src/**/*.test.tsx",
    reason: "Directive colocated unit tests under packages/*/src",
    kind: "exception",
  },
  {
    path: "packages/*/src/**/*.spec.ts",
    reason: "Directive colocated unit tests under packages/*/src",
    kind: "exception",
  },
  {
    path: "cmd/**/*_test.go",
    reason: "Go colocated package tests (language convention)",
    kind: "exception",
  },
  {
    path: "**/*_test.go",
    reason: "Go colocated package tests (language convention)",
    kind: "exception",
  },
];

function asStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
    .map((s) => s.trim());
}

function asAllowEntries(raw: unknown): TestBoundaryAllowEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: TestBoundaryAllowEntry[] = [];
  for (const item of raw) {
    if (typeof item === "string" && item.trim().length > 0) {
      out.push({ path: item.trim(), kind: "exception" });
      continue;
    }
    if (item !== null && typeof item === "object" && !Array.isArray(item)) {
      const rec = item as Record<string, unknown>;
      const path = typeof rec.path === "string" ? rec.path.trim() : "";
      if (path.length === 0) continue;
      const kind =
        rec.kind === "production-liveness" || rec.kind === "exception" ? rec.kind : "exception";
      const reason = typeof rec.reason === "string" ? rec.reason : undefined;
      out.push({ path, kind, reason });
    }
  }
  return out;
}

function parsePolicyObject(
  raw: Record<string, unknown>,
  source: TestBoundaryPolicy["source"],
  defaultMode: "warn" | "enforce",
): TestBoundaryPolicy {
  const sourceRoots = asStringArray(raw.sourceRoots);
  const testRoots = asStringArray(raw.testRoots);
  const fixtureRoots = asStringArray(raw.fixtureRoots);
  const testFilePatterns = asStringArray(raw.testFilePatterns);
  const productionMayReferenceTestRoots =
    typeof raw.productionMayReferenceTestRoots === "boolean"
      ? raw.productionMayReferenceTestRoots
      : false;
  const allow = asAllowEntries(raw.allow);
  let enforcementMode: "warn" | "enforce" = defaultMode;
  if (raw.enforcementMode === "warn" || raw.enforcementMode === "enforce") {
    enforcementMode = raw.enforcementMode;
  }
  return {
    sourceRoots: sourceRoots.length > 0 ? sourceRoots : DEFAULT_SOURCE_ROOTS,
    testRoots: testRoots.length > 0 ? testRoots : DEFAULT_TEST_ROOTS,
    fixtureRoots: fixtureRoots.length > 0 ? fixtureRoots : DEFAULT_FIXTURE_ROOTS,
    testFilePatterns: testFilePatterns.length > 0 ? testFilePatterns : DEFAULT_TEST_FILE_PATTERNS,
    productionMayReferenceTestRoots,
    allow,
    enforcementMode,
    source,
  };
}

/** Default inferred policy (migration / discovery). */
export function defaultTestBoundaryPolicy(
  enforcementMode: "warn" | "enforce" = "warn",
): TestBoundaryPolicy {
  return {
    sourceRoots: DEFAULT_SOURCE_ROOTS,
    testRoots: DEFAULT_TEST_ROOTS,
    fixtureRoots: DEFAULT_FIXTURE_ROOTS,
    testFilePatterns: DEFAULT_TEST_FILE_PATTERNS,
    productionMayReferenceTestRoots: false,
    allow: [...FRAMEWORK_SELF_ALLOW],
    enforcementMode,
    source: "defaults",
  };
}

/**
 * Load policy from explicit path, then `.deft/test-boundary.policy.json`,
 * then `plan.policy.testBoundary` in PROJECT-DEFINITION, else defaults (warn).
 */
export function loadTestBoundaryPolicy(
  projectRoot: string,
  options: { readonly policyPath?: string | null } = {},
): TestBoundaryPolicy {
  const root = resolve(projectRoot);

  if (options.policyPath !== null && options.policyPath !== undefined) {
    const p = resolve(options.policyPath);
    if (!existsSync(p)) {
      throw new Error(`test-boundary policy file not found: ${p}`);
    }
    const raw = JSON.parse(readFileSync(p, "utf8")) as unknown;
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(`test-boundary policy must be a JSON object: ${p}`);
    }
    return parsePolicyObject(raw as Record<string, unknown>, "file", "enforce");
  }

  const deftPolicy = join(root, ".deft", "test-boundary.policy.json");
  if (existsSync(deftPolicy)) {
    const raw = JSON.parse(readFileSync(deftPolicy, "utf8")) as unknown;
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(`test-boundary policy must be a JSON object: ${deftPolicy}`);
    }
    return parsePolicyObject(raw as Record<string, unknown>, "file", "enforce");
  }

  const pdPath = join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json");
  if (existsSync(pdPath)) {
    try {
      const pd = JSON.parse(readFileSync(pdPath, "utf8")) as Record<string, unknown>;
      const plan = pd.plan as Record<string, unknown> | undefined;
      const policy = plan?.policy as Record<string, unknown> | undefined;
      const tb = policy?.testBoundary as Record<string, unknown> | undefined;
      if (tb !== undefined && tb !== null && typeof tb === "object" && !Array.isArray(tb)) {
        return parsePolicyObject(tb, "project-definition", "enforce");
      }
    } catch {
      // fall through to defaults
    }
  }

  return defaultTestBoundaryPolicy("warn");
}
