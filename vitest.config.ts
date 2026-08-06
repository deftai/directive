import { realpathSync } from "node:fs";
import { cpus, tmpdir } from "node:os";
import { resolve } from "node:path";
import { defineConfig } from "vitest/config";
import { resolveCoverageDebtIssue } from "./packages/core/src/vitest-runner/coverage-debt.ts";

// macOS exposes the same temporary directory through /var and /private/var.
// Give test workers the canonical spelling so cwd/git comparisons and cleanup
// agree across subprocess boundaries. Refs #2526.
const testEnvironment =
  process.platform === "darwin" ? { TMPDIR: realpathSync(tmpdir()) } : undefined;

// Native Windows full-suite + coverage runs can pass every test yet exit non-zero when
// fork workers saturate the coordinator and onTaskUpdate RPC acks time out. Cap fork
// workers for headroom, widen teardown, and ignore unhandled worker RPC flakes when
// the assertion suite is otherwise green (Vitest 3.2.6 has no rpcTimeout knob).
// Refs #2546.
const isWin32 = process.platform === "win32";
const winMaxWorkers = Math.max(1, Math.min(12, Math.floor(cpus().length * 0.25)));

// Coverage chunk writes land in coverage/.tmp; on win32 parallel forks can race the
// directory away mid-suite (ENOENT after a green run). Serialize coverage processing,
// tighten fork caps when --coverage is on, and globalSetup keeps .tmp present plus
// mkdir-before-chunk-write (vitest 3.2.x gap; upstream fix vitest-dev/vitest#10117
// in vitest 4.x — upgrade path tracked in #2634).
// Refs #2580, #2634.
const coverageEnabled = process.argv.some(
  (arg) => arg === "--coverage" || arg.startsWith("--coverage."),
);
const coverageDebt = resolveCoverageDebtIssue(process.argv, process.env);
if (coverageDebt.kind === "invalid") {
  throw new Error(`coverage-debt: ${coverageDebt.reason}`);
}
const coverageDebtIssue = coverageDebt.kind === "valid" ? coverageDebt.issue : null;
const coverageDebtTeardown = resolve(
  import.meta.dirname,
  "packages/core/src/vitest-runner/coverage-debt-teardown.ts",
);
const coverageThresholds = {
  lines: 85,
  functions: 85,
  // Fail-closed at 85 on all platforms; hairline misses use --allow-coverage-debt=#N (#2573).
  // Win32 uses capped workers under --coverage (#2546/#2634) for coordinator headroom, but the
  // floor is identical to Linux CI — a local 84.91% vs CI-green gap was uncovered branches, not
  // threshold asymmetry (#2630).
  branches: 85,
  statements: 85,
} as const;
const winActiveMaxWorkers =
  isWin32 && coverageEnabled ? Math.max(1, Math.min(4, winMaxWorkers)) : winMaxWorkers;
const win32CoverageTmpSetup = resolve(
  import.meta.dirname,
  "packages/core/src/vitest-runner/win32-coverage-tmp-setup.ts",
);

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
  "@deftai/directive-core/orphan-active": sub("core", "orphan-active"),
  "@deftai/directive-core/agents-md-budget": sub("core", "agents-md-budget"),
  "@deftai/directive-core/agents-md-advisory": sub("core", "agents-md-advisory"),
  "@deftai/directive-core/eval-health-relocation": sub("core", "eval-health-relocation"),
  "@deftai/directive-core/eval-triggers-relocation": sub("core", "eval-triggers-relocation"),
  "@deftai/directive-core/scm": sub("core", "scm"),
  "@deftai/directive-core/scope": sub("core", "scope"),
  "@deftai/directive-core/session": sub("core", "session"),
  "@deftai/directive-core/hooks": sub("core", "hooks"),
  "@deftai/directive-core/authz": sub("core", "authz"),
  "@deftai/directive-core/escalation": sub("core", "escalation"),
  "@deftai/directive-core/plan-sequence": sub("core", "plan-sequence"),
  "@deftai/directive-core/slice": sub("core", "slice"),
  "@deftai/directive-core/cache": sub("core", "cache"),
  "@deftai/directive-core/doctor": sub("core", "doctor"),
  "@deftai/directive-core/eval/health": resolve(
    import.meta.dirname,
    "packages/core/src/eval/health.ts",
  ),
  "@deftai/directive-core/eval/crud-telemetry": resolve(
    import.meta.dirname,
    "packages/core/src/eval/crud-telemetry.ts",
  ),
  "@deftai/directive-core/eval/run": resolve(import.meta.dirname, "packages/core/src/eval/run.ts"),
  "@deftai/directive-core/eval/triggers": resolve(
    import.meta.dirname,
    "packages/core/src/eval/triggers.ts",
  ),
  "@deftai/directive-core/eval/report": resolve(
    import.meta.dirname,
    "packages/core/src/eval/report.ts",
  ),
  "@deftai/directive-core/eval": resolve(import.meta.dirname, "packages/core/src/eval/health.ts"),
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
  "@deftai/directive-core/review-monitor": sub("core", "review-monitor"),
  "@deftai/directive-core/packs": sub("core", "packs"),
  "@deftai/directive-core/swarm": sub("core", "swarm"),
  "@deftai/directive-core/tool-events": sub("core", "tool-events"),
  "@deftai/directive-core/delivery-attempt": sub("core", "delivery-attempt"),
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
    env: testEnvironment,
    include: ["packages/*/src/**/*.test.ts"],
    // Windows git fixture suites (session:start) exceed the 5s default under
    // full-suite parallelism; Linux CI stays on the default. Refs #2467.
    testTimeout: isWin32 ? 20_000 : 5_000,
    ...(coverageEnabled
      ? {
          teardownTimeout: 120_000,
          hookTimeout: 30_000,
        }
      : {}),
    ...(isWin32
      ? {
          maxWorkers: winActiveMaxWorkers,
          teardownTimeout: 60_000,
          dangerouslyIgnoreUnhandledErrors: true,
          ...(coverageEnabled
            ? {
                globalSetup: [win32CoverageTmpSetup],
                fileParallelism: false,
              }
            : {}),
          poolOptions: {
            forks: {
              maxForks: winActiveMaxWorkers,
            },
          },
        }
      : {}),
    ...(coverageEnabled && coverageDebtIssue !== null
      ? { globalTeardown: [coverageDebtTeardown] }
      : {}),
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**/*.ts"],
      exclude: [
        "**/*.test.ts",
        "packages/cli/src/bin.ts",
        // Test-support fixture modules extracted from retired parity harnesses (#2083).
        "packages/cli/src/*-fixtures.ts",
        "packages/core/src/**/*.helpers.ts",
      ],
      reporter: ["text", "text-summary"],
      ...(isWin32 && coverageEnabled ? { processingConcurrency: 1 } : {}),
      thresholds:
        coverageDebtIssue !== null
          ? { lines: 0, functions: 0, branches: 0, statements: 0 }
          : coverageThresholds,
    },
  },
});
