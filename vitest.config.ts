import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

// Alias the workspace packages to their TypeScript source so the suite runs
// against src/ without a prior `tsc -b` build (keeps `vitest --changed` fast
// and decoupled from build order). `tsc -b` remains the type-check + emit
// gate; vitest validates behaviour. (#1717)
const src = (pkg: string): string => resolve(import.meta.dirname, "packages", pkg, "src/index.ts");

export default defineConfig({
  resolve: {
    alias: {
      "@deftai/types": src("types"),
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
