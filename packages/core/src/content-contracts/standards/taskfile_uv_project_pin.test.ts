import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readText, repoRoot } from "./_helpers.js";

describe("test_taskfile_uv_project_pin.py", () => {
  const UV_RUN = /(?<![\w-])uv\s+run\b/;
  const PINNED = /uv\s+--project\s+"[^"]+"\s+run\b/;
  describe("architecture.yml", () => {
    it("test_no_unpinned_uv_run_in_command_lines", () => {
      const text = readFileSync(join(repoRoot(), "tasks/architecture.yml"), { encoding: "utf8" });
      const offenders: string[] = [];
      for (const line of text.split("\n")) {
        if (line.trimStart().startsWith("#")) continue;
        if (UV_RUN.test(line) && !PINNED.test(line)) offenders.push(line.trim());
      }
      expect(offenders).toEqual([]);
    });
  });
  describe("cache.yml", () => {
    it("test_no_unpinned_uv_run_in_command_lines", () => {
      const text = readFileSync(join(repoRoot(), "tasks/cache.yml"), { encoding: "utf8" });
      const offenders: string[] = [];
      for (const line of text.split("\n")) {
        if (line.trimStart().startsWith("#")) continue;
        if (UV_RUN.test(line) && !PINNED.test(line)) offenders.push(line.trim());
      }
      expect(offenders).toEqual([]);
    });
  });
  describe("capacity.yml", () => {
    it("test_no_unpinned_uv_run_in_command_lines", () => {
      const text = readFileSync(join(repoRoot(), "tasks/capacity.yml"), { encoding: "utf8" });
      const offenders: string[] = [];
      for (const line of text.split("\n")) {
        if (line.trimStart().startsWith("#")) continue;
        if (UV_RUN.test(line) && !PINNED.test(line)) offenders.push(line.trim());
      }
      expect(offenders).toEqual([]);
    });
  });
  describe("change.yml", () => {
    it("test_no_unpinned_uv_run_in_command_lines", () => {
      const text = readFileSync(join(repoRoot(), "tasks/change.yml"), { encoding: "utf8" });
      const offenders: string[] = [];
      for (const line of text.split("\n")) {
        if (line.trimStart().startsWith("#")) continue;
        if (UV_RUN.test(line) && !PINNED.test(line)) offenders.push(line.trim());
      }
      expect(offenders).toEqual([]);
    });
  });
  describe("changelog.yml", () => {
    it("test_no_unpinned_uv_run_in_command_lines", () => {
      const text = readFileSync(join(repoRoot(), "tasks/changelog.yml"), { encoding: "utf8" });
      const offenders: string[] = [];
      for (const line of text.split("\n")) {
        if (line.trimStart().startsWith("#")) continue;
        if (UV_RUN.test(line) && !PINNED.test(line)) offenders.push(line.trim());
      }
      expect(offenders).toEqual([]);
    });
  });
  describe("ci.yml", () => {
    it("test_no_unpinned_uv_run_in_command_lines", () => {
      const text = readFileSync(join(repoRoot(), "tasks/ci.yml"), { encoding: "utf8" });
      const offenders: string[] = [];
      for (const line of text.split("\n")) {
        if (line.trimStart().startsWith("#")) continue;
        if (UV_RUN.test(line) && !PINNED.test(line)) offenders.push(line.trim());
      }
      expect(offenders).toEqual([]);
    });
  });
  describe("codebase.yml", () => {
    it("test_no_unpinned_uv_run_in_command_lines", () => {
      const text = readFileSync(join(repoRoot(), "tasks/codebase.yml"), { encoding: "utf8" });
      const offenders: string[] = [];
      for (const line of text.split("\n")) {
        if (line.trimStart().startsWith("#")) continue;
        if (UV_RUN.test(line) && !PINNED.test(line)) offenders.push(line.trim());
      }
      expect(offenders).toEqual([]);
    });
  });
  describe("commit.yml", () => {
    it("test_no_unpinned_uv_run_in_command_lines", () => {
      const text = readFileSync(join(repoRoot(), "tasks/commit.yml"), { encoding: "utf8" });
      const offenders: string[] = [];
      for (const line of text.split("\n")) {
        if (line.trimStart().startsWith("#")) continue;
        if (UV_RUN.test(line) && !PINNED.test(line)) offenders.push(line.trim());
      }
      expect(offenders).toEqual([]);
    });
  });
  describe("core.yml", () => {
    it("test_no_unpinned_uv_run_in_command_lines", () => {
      const text = readFileSync(join(repoRoot(), "tasks/core.yml"), { encoding: "utf8" });
      const offenders: string[] = [];
      for (const line of text.split("\n")) {
        if (line.trimStart().startsWith("#")) continue;
        if (UV_RUN.test(line) && !PINNED.test(line)) offenders.push(line.trim());
      }
      expect(offenders).toEqual([]);
    });
  });
  describe("deployments.yml", () => {
    it("test_no_unpinned_uv_run_in_command_lines", () => {
      const text = readFileSync(join(repoRoot(), "tasks/deployments.yml"), { encoding: "utf8" });
      const offenders: string[] = [];
      for (const line of text.split("\n")) {
        if (line.trimStart().startsWith("#")) continue;
        if (UV_RUN.test(line) && !PINNED.test(line)) offenders.push(line.trim());
      }
      expect(offenders).toEqual([]);
    });
  });
  describe("framework.yml", () => {
    it("test_no_unpinned_uv_run_in_command_lines", () => {
      const text = readFileSync(join(repoRoot(), "tasks/framework.yml"), { encoding: "utf8" });
      const offenders: string[] = [];
      for (const line of text.split("\n")) {
        if (line.trimStart().startsWith("#")) continue;
        if (UV_RUN.test(line) && !PINNED.test(line)) offenders.push(line.trim());
      }
      expect(offenders).toEqual([]);
    });
  });
  describe("install.yml", () => {
    it("test_no_unpinned_uv_run_in_command_lines", () => {
      const text = readFileSync(join(repoRoot(), "tasks/install.yml"), { encoding: "utf8" });
      const offenders: string[] = [];
      for (const line of text.split("\n")) {
        if (line.trimStart().startsWith("#")) continue;
        if (UV_RUN.test(line) && !PINNED.test(line)) offenders.push(line.trim());
      }
      expect(offenders).toEqual([]);
    });
  });
  describe("issue.yml", () => {
    it("test_no_unpinned_uv_run_in_command_lines", () => {
      const text = readFileSync(join(repoRoot(), "tasks/issue.yml"), { encoding: "utf8" });
      const offenders: string[] = [];
      for (const line of text.split("\n")) {
        if (line.trimStart().startsWith("#")) continue;
        if (UV_RUN.test(line) && !PINNED.test(line)) offenders.push(line.trim());
      }
      expect(offenders).toEqual([]);
    });
  });
  describe("migrate.yml", () => {
    it("test_no_unpinned_uv_run_in_command_lines", () => {
      const text = readFileSync(join(repoRoot(), "tasks/migrate.yml"), { encoding: "utf8" });
      const offenders: string[] = [];
      for (const line of text.split("\n")) {
        if (line.trimStart().startsWith("#")) continue;
        if (UV_RUN.test(line) && !PINNED.test(line)) offenders.push(line.trim());
      }
      expect(offenders).toEqual([]);
    });
  });
  describe("packs.yml", () => {
    it("test_no_unpinned_uv_run_in_command_lines", () => {
      const text = readFileSync(join(repoRoot(), "tasks/packs.yml"), { encoding: "utf8" });
      const offenders: string[] = [];
      for (const line of text.split("\n")) {
        if (line.trimStart().startsWith("#")) continue;
        if (UV_RUN.test(line) && !PINNED.test(line)) offenders.push(line.trim());
      }
      expect(offenders).toEqual([]);
    });
  });
  describe("policy.yml", () => {
    it("test_no_unpinned_uv_run_in_command_lines", () => {
      const text = readFileSync(join(repoRoot(), "tasks/policy.yml"), { encoding: "utf8" });
      const offenders: string[] = [];
      for (const line of text.split("\n")) {
        if (line.trimStart().startsWith("#")) continue;
        if (UV_RUN.test(line) && !PINNED.test(line)) offenders.push(line.trim());
      }
      expect(offenders).toEqual([]);
    });
  });
  describe("pr.yml", () => {
    it("test_no_unpinned_uv_run_in_command_lines", () => {
      const text = readFileSync(join(repoRoot(), "tasks/pr.yml"), { encoding: "utf8" });
      const offenders: string[] = [];
      for (const line of text.split("\n")) {
        if (line.trimStart().startsWith("#")) continue;
        if (UV_RUN.test(line) && !PINNED.test(line)) offenders.push(line.trim());
      }
      expect(offenders).toEqual([]);
    });
  });
  describe("prd.yml", () => {
    it("test_no_unpinned_uv_run_in_command_lines", () => {
      const text = readFileSync(join(repoRoot(), "tasks/prd.yml"), { encoding: "utf8" });
      const offenders: string[] = [];
      for (const line of text.split("\n")) {
        if (line.trimStart().startsWith("#")) continue;
        if (UV_RUN.test(line) && !PINNED.test(line)) offenders.push(line.trim());
      }
      expect(offenders).toEqual([]);
    });
  });
  describe("project.yml", () => {
    it("test_no_unpinned_uv_run_in_command_lines", () => {
      const text = readFileSync(join(repoRoot(), "tasks/project.yml"), { encoding: "utf8" });
      const offenders: string[] = [];
      for (const line of text.split("\n")) {
        if (line.trimStart().startsWith("#")) continue;
        if (UV_RUN.test(line) && !PINNED.test(line)) offenders.push(line.trim());
      }
      expect(offenders).toEqual([]);
    });
  });
  describe("reconcile.yml", () => {
    it("test_no_unpinned_uv_run_in_command_lines", () => {
      const text = readFileSync(join(repoRoot(), "tasks/reconcile.yml"), { encoding: "utf8" });
      const offenders: string[] = [];
      for (const line of text.split("\n")) {
        if (line.trimStart().startsWith("#")) continue;
        if (UV_RUN.test(line) && !PINNED.test(line)) offenders.push(line.trim());
      }
      expect(offenders).toEqual([]);
    });
  });
  describe("relocate.yml", () => {
    it("test_no_unpinned_uv_run_in_command_lines", () => {
      const text = readFileSync(join(repoRoot(), "tasks/relocate.yml"), { encoding: "utf8" });
      const offenders: string[] = [];
      for (const line of text.split("\n")) {
        if (line.trimStart().startsWith("#")) continue;
        if (UV_RUN.test(line) && !PINNED.test(line)) offenders.push(line.trim());
      }
      expect(offenders).toEqual([]);
    });
  });
  describe("roadmap.yml", () => {
    it("test_no_unpinned_uv_run_in_command_lines", () => {
      const text = readFileSync(join(repoRoot(), "tasks/roadmap.yml"), { encoding: "utf8" });
      const offenders: string[] = [];
      for (const line of text.split("\n")) {
        if (line.trimStart().startsWith("#")) continue;
        if (UV_RUN.test(line) && !PINNED.test(line)) offenders.push(line.trim());
      }
      expect(offenders).toEqual([]);
    });
  });
  describe("scm.yml", () => {
    it("test_no_unpinned_uv_run_in_command_lines", () => {
      const text = readFileSync(join(repoRoot(), "tasks/scm.yml"), { encoding: "utf8" });
      const offenders: string[] = [];
      for (const line of text.split("\n")) {
        if (line.trimStart().startsWith("#")) continue;
        if (UV_RUN.test(line) && !PINNED.test(line)) offenders.push(line.trim());
      }
      expect(offenders).toEqual([]);
    });
  });
  describe("scope-undo.yml", () => {
    it("test_no_unpinned_uv_run_in_command_lines", () => {
      const text = readFileSync(join(repoRoot(), "tasks/scope-undo.yml"), { encoding: "utf8" });
      const offenders: string[] = [];
      for (const line of text.split("\n")) {
        if (line.trimStart().startsWith("#")) continue;
        if (UV_RUN.test(line) && !PINNED.test(line)) offenders.push(line.trim());
      }
      expect(offenders).toEqual([]);
    });
  });
  describe("scope.yml", () => {
    it("test_no_unpinned_uv_run_in_command_lines", () => {
      const text = readFileSync(join(repoRoot(), "tasks/scope.yml"), { encoding: "utf8" });
      const offenders: string[] = [];
      for (const line of text.split("\n")) {
        if (line.trimStart().startsWith("#")) continue;
        if (UV_RUN.test(line) && !PINNED.test(line)) offenders.push(line.trim());
      }
      expect(offenders).toEqual([]);
    });
  });
  describe("session.yml", () => {
    it("test_no_unpinned_uv_run_in_command_lines", () => {
      const text = readFileSync(join(repoRoot(), "tasks/session.yml"), { encoding: "utf8" });
      const offenders: string[] = [];
      for (const line of text.split("\n")) {
        if (line.trimStart().startsWith("#")) continue;
        if (UV_RUN.test(line) && !PINNED.test(line)) offenders.push(line.trim());
      }
      expect(offenders).toEqual([]);
    });
  });
  describe("setup.yml", () => {
    it("test_no_unpinned_uv_run_in_command_lines", () => {
      const text = readFileSync(join(repoRoot(), "tasks/setup.yml"), { encoding: "utf8" });
      const offenders: string[] = [];
      for (const line of text.split("\n")) {
        if (line.trimStart().startsWith("#")) continue;
        if (UV_RUN.test(line) && !PINNED.test(line)) offenders.push(line.trim());
      }
      expect(offenders).toEqual([]);
    });
  });
  describe("slice.yml", () => {
    it("test_no_unpinned_uv_run_in_command_lines", () => {
      const text = readFileSync(join(repoRoot(), "tasks/slice.yml"), { encoding: "utf8" });
      const offenders: string[] = [];
      for (const line of text.split("\n")) {
        if (line.trimStart().startsWith("#")) continue;
        if (UV_RUN.test(line) && !PINNED.test(line)) offenders.push(line.trim());
      }
      expect(offenders).toEqual([]);
    });
  });
  describe("spec.yml", () => {
    it("test_no_unpinned_uv_run_in_command_lines", () => {
      const text = readFileSync(join(repoRoot(), "tasks/spec.yml"), { encoding: "utf8" });
      const offenders: string[] = [];
      for (const line of text.split("\n")) {
        if (line.trimStart().startsWith("#")) continue;
        if (UV_RUN.test(line) && !PINNED.test(line)) offenders.push(line.trim());
      }
      expect(offenders).toEqual([]);
    });
  });
  describe("swarm.yml", () => {
    it("test_no_unpinned_uv_run_in_command_lines", () => {
      const text = readFileSync(join(repoRoot(), "tasks/swarm.yml"), { encoding: "utf8" });
      const offenders: string[] = [];
      for (const line of text.split("\n")) {
        if (line.trimStart().startsWith("#")) continue;
        if (UV_RUN.test(line) && !PINNED.test(line)) offenders.push(line.trim());
      }
      expect(offenders).toEqual([]);
    });
  });
  describe("toolchain.yml", () => {
    it("test_no_unpinned_uv_run_in_command_lines", () => {
      const text = readFileSync(join(repoRoot(), "tasks/toolchain.yml"), { encoding: "utf8" });
      const offenders: string[] = [];
      for (const line of text.split("\n")) {
        if (line.trimStart().startsWith("#")) continue;
        if (UV_RUN.test(line) && !PINNED.test(line)) offenders.push(line.trim());
      }
      expect(offenders).toEqual([]);
    });
  });
  describe("triage-actions.yml", () => {
    it("test_no_unpinned_uv_run_in_command_lines", () => {
      const text = readFileSync(join(repoRoot(), "tasks/triage-actions.yml"), { encoding: "utf8" });
      const offenders: string[] = [];
      for (const line of text.split("\n")) {
        if (line.trimStart().startsWith("#")) continue;
        if (UV_RUN.test(line) && !PINNED.test(line)) offenders.push(line.trim());
      }
      expect(offenders).toEqual([]);
    });
  });
  describe("triage-bootstrap.yml", () => {
    it("test_no_unpinned_uv_run_in_command_lines", () => {
      const text = readFileSync(join(repoRoot(), "tasks/triage-bootstrap.yml"), {
        encoding: "utf8",
      });
      const offenders: string[] = [];
      for (const line of text.split("\n")) {
        if (line.trimStart().startsWith("#")) continue;
        if (UV_RUN.test(line) && !PINNED.test(line)) offenders.push(line.trim());
      }
      expect(offenders).toEqual([]);
    });
  });
  describe("triage-bulk.yml", () => {
    it("test_no_unpinned_uv_run_in_command_lines", () => {
      const text = readFileSync(join(repoRoot(), "tasks/triage-bulk.yml"), { encoding: "utf8" });
      const offenders: string[] = [];
      for (const line of text.split("\n")) {
        if (line.trimStart().startsWith("#")) continue;
        if (UV_RUN.test(line) && !PINNED.test(line)) offenders.push(line.trim());
      }
      expect(offenders).toEqual([]);
    });
  });
  describe("triage-classify.yml", () => {
    it("test_no_unpinned_uv_run_in_command_lines", () => {
      const text = readFileSync(join(repoRoot(), "tasks/triage-classify.yml"), {
        encoding: "utf8",
      });
      const offenders: string[] = [];
      for (const line of text.split("\n")) {
        if (line.trimStart().startsWith("#")) continue;
        if (UV_RUN.test(line) && !PINNED.test(line)) offenders.push(line.trim());
      }
      expect(offenders).toEqual([]);
    });
  });
  describe("triage-queue.yml", () => {
    it("test_no_unpinned_uv_run_in_command_lines", () => {
      const text = readFileSync(join(repoRoot(), "tasks/triage-queue.yml"), { encoding: "utf8" });
      const offenders: string[] = [];
      for (const line of text.split("\n")) {
        if (line.trimStart().startsWith("#")) continue;
        if (UV_RUN.test(line) && !PINNED.test(line)) offenders.push(line.trim());
      }
      expect(offenders).toEqual([]);
    });
  });
  describe("triage-reconcile.yml", () => {
    it("test_no_unpinned_uv_run_in_command_lines", () => {
      const text = readFileSync(join(repoRoot(), "tasks/triage-reconcile.yml"), {
        encoding: "utf8",
      });
      const offenders: string[] = [];
      for (const line of text.split("\n")) {
        if (line.trimStart().startsWith("#")) continue;
        if (UV_RUN.test(line) && !PINNED.test(line)) offenders.push(line.trim());
      }
      expect(offenders).toEqual([]);
    });
  });
  describe("triage-scope-drift.yml", () => {
    it("test_no_unpinned_uv_run_in_command_lines", () => {
      const text = readFileSync(join(repoRoot(), "tasks/triage-scope-drift.yml"), {
        encoding: "utf8",
      });
      const offenders: string[] = [];
      for (const line of text.split("\n")) {
        if (line.trimStart().startsWith("#")) continue;
        if (UV_RUN.test(line) && !PINNED.test(line)) offenders.push(line.trim());
      }
      expect(offenders).toEqual([]);
    });
  });
  describe("triage-scope.yml", () => {
    it("test_no_unpinned_uv_run_in_command_lines", () => {
      const text = readFileSync(join(repoRoot(), "tasks/triage-scope.yml"), { encoding: "utf8" });
      const offenders: string[] = [];
      for (const line of text.split("\n")) {
        if (line.trimStart().startsWith("#")) continue;
        if (UV_RUN.test(line) && !PINNED.test(line)) offenders.push(line.trim());
      }
      expect(offenders).toEqual([]);
    });
  });
  describe("triage-smoketest.yml", () => {
    it("test_no_unpinned_uv_run_in_command_lines", () => {
      const text = readFileSync(join(repoRoot(), "tasks/triage-smoketest.yml"), {
        encoding: "utf8",
      });
      const offenders: string[] = [];
      for (const line of text.split("\n")) {
        if (line.trimStart().startsWith("#")) continue;
        if (UV_RUN.test(line) && !PINNED.test(line)) offenders.push(line.trim());
      }
      expect(offenders).toEqual([]);
    });
  });
  describe("triage-subscribe.yml", () => {
    it("test_no_unpinned_uv_run_in_command_lines", () => {
      const text = readFileSync(join(repoRoot(), "tasks/triage-subscribe.yml"), {
        encoding: "utf8",
      });
      const offenders: string[] = [];
      for (const line of text.split("\n")) {
        if (line.trimStart().startsWith("#")) continue;
        if (UV_RUN.test(line) && !PINNED.test(line)) offenders.push(line.trim());
      }
      expect(offenders).toEqual([]);
    });
  });
  describe("triage-summary.yml", () => {
    it("test_no_unpinned_uv_run_in_command_lines", () => {
      const text = readFileSync(join(repoRoot(), "tasks/triage-summary.yml"), { encoding: "utf8" });
      const offenders: string[] = [];
      for (const line of text.split("\n")) {
        if (line.trimStart().startsWith("#")) continue;
        if (UV_RUN.test(line) && !PINNED.test(line)) offenders.push(line.trim());
      }
      expect(offenders).toEqual([]);
    });
  });
  describe("triage-welcome.yml", () => {
    it("test_no_unpinned_uv_run_in_command_lines", () => {
      const text = readFileSync(join(repoRoot(), "tasks/triage-welcome.yml"), { encoding: "utf8" });
      const offenders: string[] = [];
      for (const line of text.split("\n")) {
        if (line.trimStart().startsWith("#")) continue;
        if (UV_RUN.test(line) && !PINNED.test(line)) offenders.push(line.trim());
      }
      expect(offenders).toEqual([]);
    });
  });
  describe("ts.yml", () => {
    it("test_no_unpinned_uv_run_in_command_lines", () => {
      const text = readFileSync(join(repoRoot(), "tasks/ts.yml"), { encoding: "utf8" });
      const offenders: string[] = [];
      for (const line of text.split("\n")) {
        if (line.trimStart().startsWith("#")) continue;
        if (UV_RUN.test(line) && !PINNED.test(line)) offenders.push(line.trim());
      }
      expect(offenders).toEqual([]);
    });
  });
  describe("vbrief.yml", () => {
    it("test_no_unpinned_uv_run_in_command_lines", () => {
      const text = readFileSync(join(repoRoot(), "tasks/vbrief.yml"), { encoding: "utf8" });
      const offenders: string[] = [];
      for (const line of text.split("\n")) {
        if (line.trimStart().startsWith("#")) continue;
        if (UV_RUN.test(line) && !PINNED.test(line)) offenders.push(line.trim());
      }
      expect(offenders).toEqual([]);
    });
  });
  describe("verify.yml", () => {
    it("test_no_unpinned_uv_run_in_command_lines", () => {
      const text = readFileSync(join(repoRoot(), "tasks/verify.yml"), { encoding: "utf8" });
      const offenders: string[] = [];
      for (const line of text.split("\n")) {
        if (line.trimStart().startsWith("#")) continue;
        if (UV_RUN.test(line) && !PINNED.test(line)) offenders.push(line.trim());
      }
      expect(offenders).toEqual([]);
    });
  });
  it("test_uv_project_env_set_at_root", () => {
    const text = readText("Taskfile.yml");
    expect(text).toContain("UV_PROJECT");
    expect(text).toContain("{{.TASKFILE_DIR}}");
  });
});
