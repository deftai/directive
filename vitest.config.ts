import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

// Alias the workspace packages to their TypeScript source so the suite runs
// against src/ without a prior `tsc -b` build (keeps `vitest --changed` fast
// and decoupled from build order). `tsc -b` remains the type-check + emit
// gate; vitest validates behaviour. (#1717)
const src = (pkg: string): string => resolve(import.meta.dirname, "packages", pkg, "src/index.ts");
const sub = (pkg: string, subpath: string): string =>
  resolve(import.meta.dirname, "packages", pkg, "src", subpath, "index.ts");

export default defineConfig({
  resolve: {
    // Subpath aliases MUST precede the bare "@deftai/core" entry: rollup's alias
    // matcher rewrites the first prefix match, so the more specific gate
    // subpaths have to win before the root alias rewrites them incorrectly.
    alias: {
      "@deftai/types": src("types"),
      "@deftai/core/policy": sub("core", "policy"),
      "@deftai/core/preflight": sub("core", "preflight"),
      "@deftai/core/story-ready": sub("core", "story-ready"),
      "@deftai/core/branch": sub("core", "branch"),
      "@deftai/core/wip-cap": sub("core", "wip-cap"),
      "@deftai/core/scm": sub("core", "scm"),
      "@deftai/core/scope": sub("core", "scope"),
      "@deftai/core/slice": sub("core", "slice"),
      "@deftai/core/cache": sub("core", "cache"),
      "@deftai/core/doctor": sub("core", "doctor"),
      "@deftai/core/triage": sub("core", "triage"),
      "@deftai/core/release": sub("core", "release"),
      "@deftai/core/release-publish": sub("core", "release-publish"),
      "@deftai/core/release-rollback": sub("core", "release-rollback"),
      "@deftai/core/release-e2e": sub("core", "release-e2e"),
      "@deftai/core/pr-merge-readiness": sub("core", "pr-merge-readiness"),
      "@deftai/core/pr-protected-issues": sub("core", "pr-protected-issues"),
      "@deftai/core/pr-closing-keywords": sub("core", "pr-closing-keywords"),
      "@deftai/core/pr-monitor": sub("core", "pr-monitor"),
      "@deftai/core/pr-wait-mergeable": sub("core", "pr-wait-mergeable"),
      "@deftai/core/vbrief-build": sub("core", "vbrief-build"),
      "@deftai/core/vbrief-reconcile": sub("core", "vbrief-reconcile"),
      "@deftai/core/vbrief-validate": sub("core", "vbrief-validate"),
      "@deftai/core/vbrief-validation": sub("core", "vbrief-validation"),
      "@deftai/core/vbrief-activate": sub("core", "vbrief-activate"),
      "@deftai/core/verify-env": sub("core", "verify-env"),
      "@deftai/core/verify-source": sub("core", "verify-source"),
      "@deftai/core/validate-content": sub("core", "validate-content"),
      "@deftai/core": src("core"),
    },
  },
  test: {
    include: ["packages/*/src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**/*.ts"],
      exclude: [
        "**/*.test.ts",
        "packages/cli/src/bin.ts",
        // Cross-toolchain harness runner: spawns the Python oracle, so it is
        // validated by the dedicated `parity` CI job (#1718), not node-only
        // unit tests. Its pure helpers (parseFindings/diffGates/findingKey)
        // are still unit-tested in parity.test.ts.
        "packages/cli/src/parity.ts",
        // Same rationale (#1530 Wave 2): the policy parity runner spawns the
        // Python oracle and is validated by the dedicated parity CI job, not
        // the Python-less node-only TS job. Pure helpers stay unit-tested.
        "packages/cli/src/policy-parity.ts",
        // Same rationale (#1530 Wave 2): the preflight parity runner spawns the
        // Python oracle and is validated by the dedicated parity CI job, not
        // the Python-less node-only TS job. Pure helpers stay unit-tested.
        "packages/cli/src/vbrief-preflight-parity.ts",
        // Same rationale (#1530 Wave 2): the story-ready parity runner spawns
        // the Python oracle and is validated by the dedicated parity CI job,
        // not the Python-less node-only TS job. Pure helpers stay unit-tested.
        "packages/cli/src/story-ready-parity.ts",
        // Same rationale (#1530 Wave 2): the branch parity runner spawns the
        // Python oracle and is validated by the dedicated parity CI job, not
        // the Python-less node-only TS job. Pure helpers stay unit-tested.
        "packages/cli/src/branch-parity.ts",
        // Same rationale (#1530 Wave 2): the wip-cap parity runner spawns the
        // Python oracle and is validated by the dedicated parity CI job, not
        // the Python-less node-only TS job. Pure helpers stay unit-tested.
        "packages/cli/src/wip-cap-parity.ts",
        // Same rationale (#1530 Wave 3): the scm parity runner spawns the
        // Python oracle and is validated by the dedicated parity CI job, not
        // the Python-less node-only TS job. Pure helpers stay unit-tested.
        "packages/cli/src/scm-parity.ts",
        // Same rationale (#1530 Wave 3, #1725): the triage parity runners each
        // spawn the Python oracle and are validated by the dedicated parity CI
        // job, not the Python-less node-only TS job. Pure helpers stay
        // unit-tested in their *-parity.test.ts companions.
        "packages/cli/src/triage-actions-parity.ts",
        "packages/cli/src/triage-aux-a-parity.ts",
        "packages/cli/src/triage-aux-b-parity.ts",
        "packages/cli/src/triage-bootstrap-parity.ts",
        "packages/cli/src/triage-classify-parity.ts",
        "packages/cli/src/triage-queue-parity.ts",
        "packages/cli/src/triage-scope-parity.ts",
        "packages/cli/src/triage-summary-parity.ts",
        // Same rationale (#1530 Wave 3, batch 2): the scope/slice/cache/doctor
        // parity runners spawn the Python oracle and are validated by the
        // dedicated parity CI job, not the node-only TS job.
        "packages/cli/src/scope-lifecycle-parity.ts",
        "packages/cli/src/slice-parity.ts",
        "packages/cli/src/cache-parity.ts",
        "packages/cli/src/doctor-parity.ts",
        // Same rationale (#1530 Wave 4, #1729): the release parity runners spawn
        // the Python oracle and are validated by the dedicated parity CI job, not
        // the Python-less node-only TS job. Pure helpers stay unit-tested.
        "packages/cli/src/release-parity.ts",
        "packages/cli/src/release-publish-parity.ts",
        "packages/cli/src/release-rollback-parity.ts",
        "packages/cli/src/release-e2e-parity.ts",
        // Same rationale (#1530 Wave 4b, #1730): the pr-monitor parity runners
        // spawn the Python oracle and are validated by the dedicated parity CI
        // job, not the Python-less node-only TS job. Pure helpers stay unit-tested.
        "packages/cli/src/pr-merge-readiness-parity.ts",
        "packages/cli/src/pr-protected-issues-parity.ts",
        "packages/cli/src/pr-closing-keywords-parity.ts",
        "packages/cli/src/pr-monitor-parity.ts",
        "packages/cli/src/pr-wait-mergeable-parity.ts",
        "packages/cli/src/vbrief-build-parity.ts",
        "packages/cli/src/vbrief-reconcile-parity.ts",
        "packages/cli/src/vbrief-validation-parity.ts",
        "packages/cli/src/vbrief-validate-parity.ts",
        "packages/cli/src/vbrief-activate-parity.ts",
        "packages/cli/src/verify-env-parity.ts",
        "packages/cli/src/verify-source-parity.ts",
        "packages/cli/src/validate-content-parity.ts",
      ],
      reporter: ["text", "text-summary"],
      thresholds: {
        lines: 85,
        functions: 85,
        branches: 85,
        statements: 85,
      },
    },
  },
});
