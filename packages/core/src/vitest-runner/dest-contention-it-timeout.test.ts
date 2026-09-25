import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEST_CONTENTION_IT_TIMEOUT_MS,
  destContentionItTimeout,
  WIN32_SPAWN_IT_TIMEOUT_MS,
} from "./dest-contention-it-timeout.helper.test.js";

const repoRoot = join(import.meta.dirname, "..", "..", "..", "..");

/** First-ship dest-class titles from #4847 Bound. */
const FIRST_SHIP_DEST_CLASS_ITS: ReadonlyArray<{ file: string; titlePrefix: string }> = [
  {
    file: "packages/core/src/deposit/stage-content-pack.test.ts",
    titlePrefix: "validate-links on a packed fixture",
  },
  {
    file: "packages/core/src/cache/fetch-branches.test.ts",
    titlePrefix: "emits progress on large cohorts",
  },
  {
    file: "packages/core/src/init-deposit/refresh.test.ts",
    titlePrefix: "refreshes .deft/core and rewrites a stale managed section",
  },
  {
    file: "packages/core/src/init-deposit/refresh.test.ts",
    titlePrefix: "uses yarn install argv for yarn.lock",
  },
  {
    file: "packages/core/src/init-deposit/refresh.test.ts",
    titlePrefix: "wires Taskfile.yml and stages it on upgrade",
  },
  {
    file: "packages/core/src/init-deposit/refresh.test.ts",
    titlePrefix: "--allow-dirty-no-stage applies without git add and keeps hooksPath (#4158)",
  },
  {
    file: "packages/core/src/cache/cache-final.test.ts",
    titlePrefix: "emitFetchProgress survives flusher failures",
  },
];

/** Loaded-lane 5s-edge titles at dest HEAD that were not already timed. */
const LOADED_LANE_EDGE_ITS: ReadonlyArray<{ file: string; titlePrefix: string }> = [
  {
    file: "packages/core/src/init-deposit/greenfield-pin-clone.harness.test.ts",
    titlePrefix:
      "after init + commit + fresh clone, the pin is present and .deft/core is reconstitutable",
  },
  {
    file: "packages/cli/src/verify-ac.test.ts",
    titlePrefix: "runs stated plan.acceptance.commands and exits 0 on pass",
  },
  {
    file: "packages/core/src/init-deposit/refresh.test.ts",
    titlePrefix: "writes the .gitignore entry but NEVER un-tracks .deft/core",
  },
  {
    file: "packages/core/src/init-deposit/refresh.test.ts",
    titlePrefix: "#2148: does NOT deposit deft-core-guard.yml when .deft/core is gitignored",
  },
  {
    file: "packages/core/src/init-deposit/refresh.test.ts",
    titlePrefix: "#2148: DOES deposit deft-core-guard.yml when .deft/core is git-tracked",
  },
  {
    file: "packages/core/src/content-contracts/standards/deposit_required_closure.test.ts",
    titlePrefix: "every declared required path exists after running content-package prepack",
  },
];

describe("destContentionItTimeout (#4847)", () => {
  it("exports one Darwin/win32 pairing (20s / 240s), not a 15-20s range", () => {
    expect(DEST_CONTENTION_IT_TIMEOUT_MS).toBe(20_000);
    expect(WIN32_SPAWN_IT_TIMEOUT_MS).toBe(240_000);
  });

  it("object-form timeout matches the #4638 platform ternary", () => {
    expect(destContentionItTimeout()).toEqual({
      timeout:
        process.platform === "win32" ? WIN32_SPAWN_IT_TIMEOUT_MS : DEST_CONTENTION_IT_TIMEOUT_MS,
    });
  });

  it("annotates first-ship dest-class its with the exported pairing", () => {
    for (const { file, titlePrefix } of FIRST_SHIP_DEST_CLASS_ITS) {
      const source = readFileSync(join(repoRoot, file), "utf8");
      const escaped = titlePrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      expect(source, `${file} ${titlePrefix}`).toMatch(
        new RegExp(`it\\(\\s*"${escaped}[^"]*"\\s*,\\s*destContentionItTimeout\\(\\)`),
      );
    }
  });

  it("annotates further loaded-lane 5s-edge its with the exported pairing", () => {
    for (const { file, titlePrefix } of LOADED_LANE_EDGE_ITS) {
      const source = readFileSync(join(repoRoot, file), "utf8");
      const escaped = titlePrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      expect(source, `${file} ${titlePrefix}`).toMatch(
        new RegExp(`it\\(\\s*"${escaped}[^"]*"\\s*,\\s*destContentionItTimeout\\(\\)`),
      );
    }
  });

  it("does not file-wide or describe-wide timeout the dest-class files", () => {
    const files = [
      "packages/core/src/deposit/stage-content-pack.test.ts",
      "packages/core/src/cache/fetch-branches.test.ts",
      "packages/core/src/init-deposit/refresh.test.ts",
    ];
    for (const file of files) {
      const source = readFileSync(join(repoRoot, file), "utf8");
      expect(source, file).not.toMatch(/describe\([^)]*\{\s*timeout\s*:/);
      expect(source, file).not.toMatch(/\btestTimeout\s*:/);
    }
  });

  it("does not apply the 20s pairing to the F7 npm-ops pass-through that already exceeds 20s", () => {
    const source = readFileSync(
      join(repoRoot, "packages/core/src/release-e2e/npm-ops-4507.test.ts"),
      "utf8",
    );
    expect(source).toContain("locks live dest CLI update plus unstubbed git status --porcelain");
    expect(source).not.toContain("destContentionItTimeout");
  });

  it("leaves unit and root Darwin/Linux testTimeout at 5s", () => {
    const source = readFileSync(join(repoRoot, "vitest.config.ts"), "utf8");
    expect(source).toMatch(/testTimeout:\s*isWin32\s*\?\s*240_000\s*:\s*5_000/);
    expect(source).not.toMatch(/coverageEnabled[\s\S]{0,80}testTimeout/);
  });
});
