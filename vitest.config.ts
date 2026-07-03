import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

// Alias the workspace packages to their TypeScript source so the suite runs
// against src/ without a prior `tsc -b` build (keeps `vitest --changed` fast
// and decoupled from build order). `tsc -b` remains the type-check + emit
// gate; vitest validates behaviour. (#1717)
const src = (pkg: string): string => resolve(import.meta.dirname, "packages", pkg, "src/index.ts");
const sub = (pkg: string, subpath: string): string =>
  resolve(import.meta.dirname, "packages", pkg, "src", subpath, "index.ts");

// Subpath aliases MUST precede the bare "@deftai/directive-core" entry: rollup's alias
// matcher rewrites the first prefix match, so the more specific gate
// subpaths have to win before the root alias rewrites them incorrectly.
const subpathAliases: Record<string, string> = {
  "@deftai/directive-types": src("types"),
  "@deftai/directive-core/policy": sub("core", "policy"),
  "@deftai/directive-core/preflight": sub("core", "preflight"),
  "@deftai/directive-core/story-ready": sub("core", "story-ready"),
  "@deftai/directive-core/branch": sub("core", "branch"),
  "@deftai/directive-core/wip-cap": sub("core", "wip-cap"),
  "@deftai/directive-core/agents-md-budget": sub("core", "agents-md-budget"),
  "@deftai/directive-core/agents-md-advisory": sub("core", "agents-md-advisory"),
  "@deftai/directive-core/scm": sub("core", "scm"),
  "@deftai/directive-core/scope": sub("core", "scope"),
  "@deftai/directive-core/session": sub("core", "session"),
  "@deftai/directive-core/slice": sub("core", "slice"),
  "@deftai/directive-core/cache": sub("core", "cache"),
  "@deftai/directive-core/doctor": sub("core", "doctor"),
  "@deftai/directive-core/triage": sub("core", "triage"),
  "@deftai/directive-core/release": sub("core", "release"),
  "@deftai/directive-core/release-publish": sub("core", "release-publish"),
  "@deftai/directive-core/release-rollback": sub("core", "release-rollback"),
  "@deftai/directive-core/release-e2e": sub("core", "release-e2e"),
  "@deftai/directive-core/pr-merge-readiness": sub("core", "pr-merge-readiness"),
  "@deftai/directive-core/pr-protected-issues": sub("core", "pr-protected-issues"),
  "@deftai/directive-core/pr-closing-keywords": sub("core", "pr-closing-keywords"),
  "@deftai/directive-core/pr-monitor": sub("core", "pr-monitor"),
  "@deftai/directive-core/pr-wait-mergeable": sub("core", "pr-wait-mergeable"),
  "@deftai/directive-core/vbrief-build": sub("core", "vbrief-build"),
  "@deftai/directive-core/vbrief-reconcile": sub("core", "vbrief-reconcile"),
  "@deftai/directive-core/vbrief-validate": sub("core", "vbrief-validate"),
  "@deftai/directive-core/vbrief-validation": sub("core", "vbrief-validation"),
  "@deftai/directive-core/vbrief-activate": sub("core", "vbrief-activate"),
  "@deftai/directive-core/verify-env": sub("core", "verify-env"),
  "@deftai/directive-core/verify-source": sub("core", "verify-source"),
  "@deftai/directive-core/validate-content": sub("core", "validate-content"),
  "@deftai/directive-core/render": sub("core", "render"),
  "@deftai/directive-core/codebase": sub("core", "codebase"),
  "@deftai/directive-core/capacity": sub("core", "capacity"),
  "@deftai/directive-core/intake": sub("core", "intake"),
  "@deftai/directive-core/intake/parity-scenarios": resolve(
    import.meta.dirname,
    "packages/core/src/intake/parity-scenarios.ts",
  ),
  "@deftai/directive-core/legacy-bridge": sub("core", "legacy-bridge"),
  "@deftai/directive-core/lifecycle": sub("core", "lifecycle"),
  "@deftai/directive-core/orchestration": sub("core", "orchestration"),
  "@deftai/directive-core/packs": sub("core", "packs"),
  "@deftai/directive-core/swarm": sub("core", "swarm"),
  "@deftai/directive-core/platform": sub("core", "platform"),
  "@deftai/directive-core/init-deposit": sub("core", "init-deposit"),
  "@deftai/directive-core/migrate-preflight": sub("core", "migrate-preflight"),
  "@deftai/directive-core/xbrief-migrate": sub("core", "xbrief-migrate"),
  "@deftai/directive-core/category-b-namespace": sub("core", "category-b-namespace"),
  "@deftai/directive-core/check-updates": sub("core", "check-updates"),
  "@deftai/directive-core/umbrella-current-shape": sub("core", "umbrella-current-shape"),
  "@deftai/directive-core/ts-check-lane": sub("core", "ts-check-lane"),
  "@deftai/directive-core": src("core"),
};

export default defineConfig({
  resolve: {
    alias: [
      // #1993: deep "@deftai/directive-core/dist/<path>.js" imports (CLI entrypoints
      // such as cache/main, doctor/main, swarm/*-cli) resolve to core's TS source
      // under vitest; in production core's "./dist/*.js" package export resolves them
      // to the built files. This regex MUST precede the curated subpath aliases.
      {
        find: /^@deftai\/directive-core\/dist\/(.*)\.js$/,
        replacement: resolve(import.meta.dirname, "packages/core/src/$1.ts"),
      },
      ...Object.entries(subpathAliases).map(([find, replacement]) => ({ find, replacement })),
    ],
  },
  test: {
    include: ["packages/*/src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**/*.ts"],
      exclude: [
        "**/*.test.ts",
        "packages/cli/src/bin.ts",
        // Test-support fixture modules extracted from retired parity harnesses (#2083).
        "packages/cli/src/*-fixtures.ts",
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
