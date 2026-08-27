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
// workers for headroom (same cap with or without coverage), widen teardown, and ignore
// unhandled worker RPC flakes when the assertion suite is otherwise green. Refs #2546.
const isWin32 = process.platform === "win32";
const winMaxWorkers = Math.max(1, Math.min(12, Math.floor(cpus().length * 0.25)));

// Coverage chunk writes land in coverage/.tmp. Vitest 4.x includes the upstream
// mkdir fix (vitest-dev/vitest#10117 / #2634). Keep win32 globalSetup keepalive
// until a full coverage run proves the directory race is gone. Do not serialize
// files or coverage processing (#3480). Refs #2580, #2634, #3480.
const coverageEnabled = process.argv.some(
  (arg) => arg === "--coverage" || arg.startsWith("--coverage."),
);
const coverageDebt = resolveCoverageDebtIssue(process.argv, process.env);
if (coverageDebt.kind === "invalid") {
  throw new Error(`coverage-debt: ${coverageDebt.reason}`);
}
// Lane-private env (#2618): ts-check-lane sets DEFT_TS_LANE_COVERAGE_DEBT because
// vitest CAC rejects unknown --allow-coverage-debt CLI tokens.
const laneDebtRaw = process.env.DEFT_TS_LANE_COVERAGE_DEBT;
const laneDebtIssue =
  laneDebtRaw !== undefined && /^\d+$/.test(laneDebtRaw.trim())
    ? Number.parseInt(laneDebtRaw.trim(), 10)
    : null;
const coverageDebtIssue =
  coverageDebt.kind === "valid"
    ? coverageDebt.issue
    : laneDebtIssue !== null && laneDebtIssue > 0
      ? laneDebtIssue
      : null;
const coverageDebtTeardown = resolve(
  import.meta.dirname,
  "packages/core/src/vitest-runner/coverage-debt-teardown.ts",
);
// Coverage floor: 75 on all four metrics, identical on win32 and Linux CI —
// no platform carve-out (#3512, preserving #2573 / #2630). Win32 runner caps
// affect timing only, never the floor.
//
// INSTRUMENT: measured under vitest 4 AST-aware remapping (ast-v8-to-istanbul).
// A coverage percentage is not comparable across instruments — the same suite
// read 85.35% branches (46194/54121) under vitest 3's v8-to-istanbul and 81.23%
// (50892/62651) under vitest 4, because v4 discovers ~16% more branches. Covered
// branches ROSE by 4,698; only the denominator moved. Never compare a reading
// here against one taken under a different provider without re-deriving.
//
// WHY 75, not a number scaled off the old one: 75 is Google's published
// "commendable" band (60 acceptable / 75 commendable / 90 exemplary), an
// external anchor rather than a self-referential one. Inozemtseva & Holmes
// (ICSE 2014) found aggregate coverage only weakly predictive of defect
// detection once suite size is controlled, and that stronger coverage forms add
// no further insight — so a high aggregate floor buys less than it costs.
//
// ROLE: this floor is a COLLAPSE DETECTOR, not a quality ratchet. Per-change
// rigor belongs in the diff gate: `verify:forward-coverage` (#3514) reports
// uncovered added/modified branches against a 90% per-diff threshold
// (warn-first; `--enforce` fail-closes). That 90% is coverage of new code;
// this 75 floor is the aggregate collapse detector. They are not
// interchangeable. New-file existence stays fail-closed (#1310).
//
// Hairline misses still use --allow-coverage-debt=#N (#2573).
const coverageThresholds = {
  lines: 75,
  functions: 75,
  branches: 75,
  statements: 75,
} as const;
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
  "@deftai/directive-core/eval/version-pin": resolve(
    import.meta.dirname,
    "packages/core/src/eval/version-pin.ts",
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
  "@deftai/directive-core/pr-closeout-attestable": sub("core", "pr-closeout-attestable"),
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
  "@deftai/directive-core/lifecycle-visible": sub("core", "lifecycle-visible"),
  "@deftai/directive-core/lifecycle": sub("core", "lifecycle"),
  "@deftai/directive-core/literal-acceptance": sub("core", "literal-acceptance"),
  "@deftai/directive-core/product-first-done-gate": sub("core", "product-first-done-gate"),
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
  "@deftai/directive-core/check": sub("core", "check"),
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
    //
    // 120s, not 20s (#3616). Windows process creation drains through a
    // fixed-rate chokepoint (AV filter drivers scan on execute), measured at
    // ~2.4-3.5 spawns/s at ANY concurrency: a serial `git --version` costs
    // ~400ms and 16 concurrent cost ~4.6s each, while throughput stays flat.
    // A git-fixture test issuing 10-30 sequential spawns therefore takes
    // 25-80s, and the whole suite grazes the old cap -- a full run produced
    // 164 failures, every one a timeout (min 20.04s, max 81.5s), zero
    // assertion failures. The 20s value was calibrated when #3480 still ran
    // files serially and was never revisited after it parallelised.
    //
    // ⊗ Do not "fix" this by lowering maxWorkers or re-serialising files.
    // Spawn throughput is concurrency-independent, so capping parallelism buys
    // nothing but wall-clock and regresses #3480. If timeouts return, the next
    // step is partitioning spawn-heavy suites into their own vitest project
    // (71 of 1028 files hold 79% of the failures) -- not trading cores away.
    testTimeout: isWin32 ? 120_000 : 5_000,
    ...(coverageEnabled
      ? {
          teardownTimeout: 120_000,
          hookTimeout: 30_000,
        }
      : {}),
    ...(isWin32
      ? {
          maxWorkers: winMaxWorkers,
          teardownTimeout: 60_000,
          dangerouslyIgnoreUnhandledErrors: true,
          ...(coverageEnabled
            ? {
                globalSetup: [win32CoverageTmpSetup],
              }
            : {}),
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
      thresholds:
        coverageDebtIssue !== null
          ? { lines: 0, functions: 0, branches: 0, statements: 0 }
          : coverageThresholds,
    },
  },
});
