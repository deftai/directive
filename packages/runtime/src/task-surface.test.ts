import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { run as runChangelogCheckCli } from "./changelog-check.js";

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
      join(REPO_ROOT, "packages", "runtime", "src", "changelog-check.ts"),
      "utf8",
    );
    expect(text).toContain("--against-merge-base");
    expect(text).toContain("againstMergeBase");
  });

  it("commit.yml dispatches commit-lint via deft-ts", () => {
    expect(readTaskfile("commit.yml")).toContain("commit-lint");
  });

  it("install.yml uninstall is retired and names directive uninstall (#6022)", () => {
    const text = readTaskfile("install.yml");
    expect(text).toContain("error: task uninstall is retired. Run: directive uninstall");
    expect(text).not.toContain("install-uninstall");
  });
});

describe("verify:changelog-unreleased on merge_group (#6296 item 6)", () => {
  function runCli(argv: string[], env: Record<string, string>): { code: number; out: string } {
    const dir = mkdtempSync(join(tmpdir(), "deft-cl-mg-"));
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const code = runChangelogCheckCli(["--project-root", dir, ...argv], env);
      return { code, out: spy.mock.calls.map((c) => String(c[0])).join("") };
    } finally {
      spy.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("prints the skip notice and exits 0 on a merge_group run", () => {
    const result = runCli(["--against-merge-base"], { GITHUB_EVENT_NAME: "merge_group" });
    expect(result.code).toBe(0);
    expect(result.out).toContain("verify:changelog-unreleased: skipped on merge_group");
    // #7147: a change-set check gives its own reason, not "it already ran".
    expect(result.out).toContain("change-set check");
    expect(result.out).not.toMatch(/already ran|PR-context/);
  });

  it("still runs on a pull_request run and in presence-only mode", () => {
    // The temp project has no CHANGELOG.md, so a check that runs fails.
    expect(runCli(["--against-merge-base"], { GITHUB_EVENT_NAME: "pull_request" }).code).toBe(1);
    expect(runCli([], { GITHUB_EVENT_NAME: "merge_group" }).code).toBe(1);
  });

  it("returns 2 on an unknown argument", () => {
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(runChangelogCheckCli(["--bogus"], {})).toBe(2);
    } finally {
      spy.mockRestore();
    }
  });
});
