import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");

function readTaskfile(name: string): string {
  return readFileSync(join(REPO_ROOT, "tasks", name), "utf8");
}

describe("consumer task surface inline python cleanup (#2022 Phase 2)", () => {
  const consumerFiles = ["change.yml", "commit.yml", "framework.yml", "install.yml"] as const;

  it.each(consumerFiles)("%s has no uv run python -c entrypoints", (file) => {
    const text = readTaskfile(file);
    expect(text).not.toMatch(/uv\s+--project\s+"\{\{\.DEFT_ROOT\}\}"\s+run\s+python\s+-c/);
  });

  it("change.yml dispatches changelog-check via deft-ts", () => {
    expect(readTaskfile("change.yml")).toContain("changelog-check");
  });

  it("verify.yml changelog-unreleased reuses changelog-check --against-merge-base (#633)", () => {
    const text = readTaskfile("verify.yml");
    expect(text).toContain("changelog-unreleased:");
    expect(text).toContain(
      "ENGINE_CMD: 'changelog-check --project-root \"{{.USER_WORKING_DIR}}\" --against-merge-base'",
    );
  });

  it("change.yml changelog-check stays presence-only (#633)", () => {
    const text = readTaskfile("change.yml");
    expect(text).toContain("changelog-check --project-root");
    expect(text).not.toContain("--against-merge-base");
  });

  it("changelog-check CLI parses --against-merge-base (#633)", () => {
    const text = readFileSync(
      join(REPO_ROOT, "packages", "cli", "src", "changelog-check.ts"),
      "utf8",
    );
    expect(text).toContain("--against-merge-base");
    expect(text).toContain("againstMergeBase");
  });

  it("commit.yml dispatches commit-lint via deft-ts", () => {
    expect(readTaskfile("commit.yml")).toContain("commit-lint");
  });

  it("install.yml dispatches install-uninstall via deft-ts", () => {
    expect(readTaskfile("install.yml")).toContain("install-uninstall");
  });
});
