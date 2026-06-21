import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { repoRoot } from "./_helpers.js";
import { readTaskfile } from "./_taskfile-helpers.js";

describe("test_taskfile_paths.py", () => {
  const ANTIPATTERN_CMD = /^\s*-\s+.*\{\{\s*\.TASKFILE_DIR\s*\}\}\/\.\./m;
  const ANTIPATTERN_FRAGMENT = /\{\{\s*\.TASKFILE_DIR\s*\}\}[\\/]\.\./;
  const DEFT_ROOT_JOINPATH =
    /^\s*DEFT_ROOT\s*:\s*['"]?\{\{\s*joinPath\s+\.TASKFILE_DIR\s+"\.\."\s*\}\}["']?\s*$/m;
  describe("architecture.yml", () => {
    it("test_no_taskfile_dir_traversal_in_command_lines", () => {
      const text = readFileSync(join(repoRoot(), "tasks/architecture.yml"), { encoding: "utf8" });
      const matches: string[] = [];
      for (const line of text.split("\n")) {
        if (line.trimStart().startsWith("#")) continue;
        if (ANTIPATTERN_CMD.test(line) || ANTIPATTERN_FRAGMENT.test(line)) matches.push(line);
      }
      expect(matches).toEqual([]);
    });
  });
  describe("cache.yml", () => {
    it("test_no_taskfile_dir_traversal_in_command_lines", () => {
      const text = readFileSync(join(repoRoot(), "tasks/cache.yml"), { encoding: "utf8" });
      const matches: string[] = [];
      for (const line of text.split("\n")) {
        if (line.trimStart().startsWith("#")) continue;
        if (ANTIPATTERN_CMD.test(line) || ANTIPATTERN_FRAGMENT.test(line)) matches.push(line);
      }
      expect(matches).toEqual([]);
    });
  });
  describe("capacity.yml", () => {
    it("test_no_taskfile_dir_traversal_in_command_lines", () => {
      const text = readFileSync(join(repoRoot(), "tasks/capacity.yml"), { encoding: "utf8" });
      const matches: string[] = [];
      for (const line of text.split("\n")) {
        if (line.trimStart().startsWith("#")) continue;
        if (ANTIPATTERN_CMD.test(line) || ANTIPATTERN_FRAGMENT.test(line)) matches.push(line);
      }
      expect(matches).toEqual([]);
    });
  });
  describe("change.yml", () => {
    it("test_no_taskfile_dir_traversal_in_command_lines", () => {
      const text = readFileSync(join(repoRoot(), "tasks/change.yml"), { encoding: "utf8" });
      const matches: string[] = [];
      for (const line of text.split("\n")) {
        if (line.trimStart().startsWith("#")) continue;
        if (ANTIPATTERN_CMD.test(line) || ANTIPATTERN_FRAGMENT.test(line)) matches.push(line);
      }
      expect(matches).toEqual([]);
    });
  });
  describe("changelog.yml", () => {
    it("test_no_taskfile_dir_traversal_in_command_lines", () => {
      const text = readFileSync(join(repoRoot(), "tasks/changelog.yml"), { encoding: "utf8" });
      const matches: string[] = [];
      for (const line of text.split("\n")) {
        if (line.trimStart().startsWith("#")) continue;
        if (ANTIPATTERN_CMD.test(line) || ANTIPATTERN_FRAGMENT.test(line)) matches.push(line);
      }
      expect(matches).toEqual([]);
    });
  });
  describe("ci.yml", () => {
    it("test_no_taskfile_dir_traversal_in_command_lines", () => {
      const text = readFileSync(join(repoRoot(), "tasks/ci.yml"), { encoding: "utf8" });
      const matches: string[] = [];
      for (const line of text.split("\n")) {
        if (line.trimStart().startsWith("#")) continue;
        if (ANTIPATTERN_CMD.test(line) || ANTIPATTERN_FRAGMENT.test(line)) matches.push(line);
      }
      expect(matches).toEqual([]);
    });
  });
  describe("codebase.yml", () => {
    it("test_no_taskfile_dir_traversal_in_command_lines", () => {
      const text = readFileSync(join(repoRoot(), "tasks/codebase.yml"), { encoding: "utf8" });
      const matches: string[] = [];
      for (const line of text.split("\n")) {
        if (line.trimStart().startsWith("#")) continue;
        if (ANTIPATTERN_CMD.test(line) || ANTIPATTERN_FRAGMENT.test(line)) matches.push(line);
      }
      expect(matches).toEqual([]);
    });
  });
  describe("commit.yml", () => {
    it("test_no_taskfile_dir_traversal_in_command_lines", () => {
      const text = readFileSync(join(repoRoot(), "tasks/commit.yml"), { encoding: "utf8" });
      const matches: string[] = [];
      for (const line of text.split("\n")) {
        if (line.trimStart().startsWith("#")) continue;
        if (ANTIPATTERN_CMD.test(line) || ANTIPATTERN_FRAGMENT.test(line)) matches.push(line);
      }
      expect(matches).toEqual([]);
    });
  });
  describe("core.yml", () => {
    it("test_no_taskfile_dir_traversal_in_command_lines", () => {
      const text = readFileSync(join(repoRoot(), "tasks/core.yml"), { encoding: "utf8" });
      const matches: string[] = [];
      for (const line of text.split("\n")) {
        if (line.trimStart().startsWith("#")) continue;
        if (ANTIPATTERN_CMD.test(line) || ANTIPATTERN_FRAGMENT.test(line)) matches.push(line);
      }
      expect(matches).toEqual([]);
    });
  });
  describe("deployments.yml", () => {
    it("test_no_taskfile_dir_traversal_in_command_lines", () => {
      const text = readFileSync(join(repoRoot(), "tasks/deployments.yml"), { encoding: "utf8" });
      const matches: string[] = [];
      for (const line of text.split("\n")) {
        if (line.trimStart().startsWith("#")) continue;
        if (ANTIPATTERN_CMD.test(line) || ANTIPATTERN_FRAGMENT.test(line)) matches.push(line);
      }
      expect(matches).toEqual([]);
    });
  });
  describe("framework.yml", () => {
    it("test_no_taskfile_dir_traversal_in_command_lines", () => {
      const text = readFileSync(join(repoRoot(), "tasks/framework.yml"), { encoding: "utf8" });
      const matches: string[] = [];
      for (const line of text.split("\n")) {
        if (line.trimStart().startsWith("#")) continue;
        if (ANTIPATTERN_CMD.test(line) || ANTIPATTERN_FRAGMENT.test(line)) matches.push(line);
      }
      expect(matches).toEqual([]);
    });
  });
  describe("install.yml", () => {
    it("test_no_taskfile_dir_traversal_in_command_lines", () => {
      const text = readFileSync(join(repoRoot(), "tasks/install.yml"), { encoding: "utf8" });
      const matches: string[] = [];
      for (const line of text.split("\n")) {
        if (line.trimStart().startsWith("#")) continue;
        if (ANTIPATTERN_CMD.test(line) || ANTIPATTERN_FRAGMENT.test(line)) matches.push(line);
      }
      expect(matches).toEqual([]);
    });
  });
  describe("issue.yml", () => {
    it("test_no_taskfile_dir_traversal_in_command_lines", () => {
      const text = readFileSync(join(repoRoot(), "tasks/issue.yml"), { encoding: "utf8" });
      const matches: string[] = [];
      for (const line of text.split("\n")) {
        if (line.trimStart().startsWith("#")) continue;
        if (ANTIPATTERN_CMD.test(line) || ANTIPATTERN_FRAGMENT.test(line)) matches.push(line);
      }
      expect(matches).toEqual([]);
    });
  });
  describe("migrate.yml", () => {
    it("test_no_taskfile_dir_traversal_in_command_lines", () => {
      const text = readFileSync(join(repoRoot(), "tasks/migrate.yml"), { encoding: "utf8" });
      const matches: string[] = [];
      for (const line of text.split("\n")) {
        if (line.trimStart().startsWith("#")) continue;
        if (ANTIPATTERN_CMD.test(line) || ANTIPATTERN_FRAGMENT.test(line)) matches.push(line);
      }
      expect(matches).toEqual([]);
    });
  });
  describe("packs.yml", () => {
    it("test_no_taskfile_dir_traversal_in_command_lines", () => {
      const text = readFileSync(join(repoRoot(), "tasks/packs.yml"), { encoding: "utf8" });
      const matches: string[] = [];
      for (const line of text.split("\n")) {
        if (line.trimStart().startsWith("#")) continue;
        if (ANTIPATTERN_CMD.test(line) || ANTIPATTERN_FRAGMENT.test(line)) matches.push(line);
      }
      expect(matches).toEqual([]);
    });
  });
  describe("policy.yml", () => {
    it("test_no_taskfile_dir_traversal_in_command_lines", () => {
      const text = readFileSync(join(repoRoot(), "tasks/policy.yml"), { encoding: "utf8" });
      const matches: string[] = [];
      for (const line of text.split("\n")) {
        if (line.trimStart().startsWith("#")) continue;
        if (ANTIPATTERN_CMD.test(line) || ANTIPATTERN_FRAGMENT.test(line)) matches.push(line);
      }
      expect(matches).toEqual([]);
    });
  });
  describe("pr.yml", () => {
    it("test_no_taskfile_dir_traversal_in_command_lines", () => {
      const text = readFileSync(join(repoRoot(), "tasks/pr.yml"), { encoding: "utf8" });
      const matches: string[] = [];
      for (const line of text.split("\n")) {
        if (line.trimStart().startsWith("#")) continue;
        if (ANTIPATTERN_CMD.test(line) || ANTIPATTERN_FRAGMENT.test(line)) matches.push(line);
      }
      expect(matches).toEqual([]);
    });
  });
  describe("prd.yml", () => {
    it("test_no_taskfile_dir_traversal_in_command_lines", () => {
      const text = readFileSync(join(repoRoot(), "tasks/prd.yml"), { encoding: "utf8" });
      const matches: string[] = [];
      for (const line of text.split("\n")) {
        if (line.trimStart().startsWith("#")) continue;
        if (ANTIPATTERN_CMD.test(line) || ANTIPATTERN_FRAGMENT.test(line)) matches.push(line);
      }
      expect(matches).toEqual([]);
    });
  });
  describe("project.yml", () => {
    it("test_no_taskfile_dir_traversal_in_command_lines", () => {
      const text = readFileSync(join(repoRoot(), "tasks/project.yml"), { encoding: "utf8" });
      const matches: string[] = [];
      for (const line of text.split("\n")) {
        if (line.trimStart().startsWith("#")) continue;
        if (ANTIPATTERN_CMD.test(line) || ANTIPATTERN_FRAGMENT.test(line)) matches.push(line);
      }
      expect(matches).toEqual([]);
    });
  });
  describe("reconcile.yml", () => {
    it("test_no_taskfile_dir_traversal_in_command_lines", () => {
      const text = readFileSync(join(repoRoot(), "tasks/reconcile.yml"), { encoding: "utf8" });
      const matches: string[] = [];
      for (const line of text.split("\n")) {
        if (line.trimStart().startsWith("#")) continue;
        if (ANTIPATTERN_CMD.test(line) || ANTIPATTERN_FRAGMENT.test(line)) matches.push(line);
      }
      expect(matches).toEqual([]);
    });
  });
  describe("relocate.yml", () => {
    it("test_no_taskfile_dir_traversal_in_command_lines", () => {
      const text = readFileSync(join(repoRoot(), "tasks/relocate.yml"), { encoding: "utf8" });
      const matches: string[] = [];
      for (const line of text.split("\n")) {
        if (line.trimStart().startsWith("#")) continue;
        if (ANTIPATTERN_CMD.test(line) || ANTIPATTERN_FRAGMENT.test(line)) matches.push(line);
      }
      expect(matches).toEqual([]);
    });
  });
  describe("roadmap.yml", () => {
    it("test_no_taskfile_dir_traversal_in_command_lines", () => {
      const text = readFileSync(join(repoRoot(), "tasks/roadmap.yml"), { encoding: "utf8" });
      const matches: string[] = [];
      for (const line of text.split("\n")) {
        if (line.trimStart().startsWith("#")) continue;
        if (ANTIPATTERN_CMD.test(line) || ANTIPATTERN_FRAGMENT.test(line)) matches.push(line);
      }
      expect(matches).toEqual([]);
    });
  });
  describe("scm.yml", () => {
    it("test_no_taskfile_dir_traversal_in_command_lines", () => {
      const text = readFileSync(join(repoRoot(), "tasks/scm.yml"), { encoding: "utf8" });
      const matches: string[] = [];
      for (const line of text.split("\n")) {
        if (line.trimStart().startsWith("#")) continue;
        if (ANTIPATTERN_CMD.test(line) || ANTIPATTERN_FRAGMENT.test(line)) matches.push(line);
      }
      expect(matches).toEqual([]);
    });
  });
  describe("scope-undo.yml", () => {
    it("test_no_taskfile_dir_traversal_in_command_lines", () => {
      const text = readFileSync(join(repoRoot(), "tasks/scope-undo.yml"), { encoding: "utf8" });
      const matches: string[] = [];
      for (const line of text.split("\n")) {
        if (line.trimStart().startsWith("#")) continue;
        if (ANTIPATTERN_CMD.test(line) || ANTIPATTERN_FRAGMENT.test(line)) matches.push(line);
      }
      expect(matches).toEqual([]);
    });
  });
  describe("scope.yml", () => {
    it("test_no_taskfile_dir_traversal_in_command_lines", () => {
      const text = readFileSync(join(repoRoot(), "tasks/scope.yml"), { encoding: "utf8" });
      const matches: string[] = [];
      for (const line of text.split("\n")) {
        if (line.trimStart().startsWith("#")) continue;
        if (ANTIPATTERN_CMD.test(line) || ANTIPATTERN_FRAGMENT.test(line)) matches.push(line);
      }
      expect(matches).toEqual([]);
    });
  });
  describe("session.yml", () => {
    it("test_no_taskfile_dir_traversal_in_command_lines", () => {
      const text = readFileSync(join(repoRoot(), "tasks/session.yml"), { encoding: "utf8" });
      const matches: string[] = [];
      for (const line of text.split("\n")) {
        if (line.trimStart().startsWith("#")) continue;
        if (ANTIPATTERN_CMD.test(line) || ANTIPATTERN_FRAGMENT.test(line)) matches.push(line);
      }
      expect(matches).toEqual([]);
    });
  });
  describe("setup.yml", () => {
    it("test_no_taskfile_dir_traversal_in_command_lines", () => {
      const text = readFileSync(join(repoRoot(), "tasks/setup.yml"), { encoding: "utf8" });
      const matches: string[] = [];
      for (const line of text.split("\n")) {
        if (line.trimStart().startsWith("#")) continue;
        if (ANTIPATTERN_CMD.test(line) || ANTIPATTERN_FRAGMENT.test(line)) matches.push(line);
      }
      expect(matches).toEqual([]);
    });
  });
  describe("slice.yml", () => {
    it("test_no_taskfile_dir_traversal_in_command_lines", () => {
      const text = readFileSync(join(repoRoot(), "tasks/slice.yml"), { encoding: "utf8" });
      const matches: string[] = [];
      for (const line of text.split("\n")) {
        if (line.trimStart().startsWith("#")) continue;
        if (ANTIPATTERN_CMD.test(line) || ANTIPATTERN_FRAGMENT.test(line)) matches.push(line);
      }
      expect(matches).toEqual([]);
    });
  });
  describe("spec.yml", () => {
    it("test_no_taskfile_dir_traversal_in_command_lines", () => {
      const text = readFileSync(join(repoRoot(), "tasks/spec.yml"), { encoding: "utf8" });
      const matches: string[] = [];
      for (const line of text.split("\n")) {
        if (line.trimStart().startsWith("#")) continue;
        if (ANTIPATTERN_CMD.test(line) || ANTIPATTERN_FRAGMENT.test(line)) matches.push(line);
      }
      expect(matches).toEqual([]);
    });
  });
  describe("swarm.yml", () => {
    it("test_no_taskfile_dir_traversal_in_command_lines", () => {
      const text = readFileSync(join(repoRoot(), "tasks/swarm.yml"), { encoding: "utf8" });
      const matches: string[] = [];
      for (const line of text.split("\n")) {
        if (line.trimStart().startsWith("#")) continue;
        if (ANTIPATTERN_CMD.test(line) || ANTIPATTERN_FRAGMENT.test(line)) matches.push(line);
      }
      expect(matches).toEqual([]);
    });
  });
  describe("toolchain.yml", () => {
    it("test_no_taskfile_dir_traversal_in_command_lines", () => {
      const text = readFileSync(join(repoRoot(), "tasks/toolchain.yml"), { encoding: "utf8" });
      const matches: string[] = [];
      for (const line of text.split("\n")) {
        if (line.trimStart().startsWith("#")) continue;
        if (ANTIPATTERN_CMD.test(line) || ANTIPATTERN_FRAGMENT.test(line)) matches.push(line);
      }
      expect(matches).toEqual([]);
    });
  });
  describe("triage-actions.yml", () => {
    it("test_no_taskfile_dir_traversal_in_command_lines", () => {
      const text = readFileSync(join(repoRoot(), "tasks/triage-actions.yml"), { encoding: "utf8" });
      const matches: string[] = [];
      for (const line of text.split("\n")) {
        if (line.trimStart().startsWith("#")) continue;
        if (ANTIPATTERN_CMD.test(line) || ANTIPATTERN_FRAGMENT.test(line)) matches.push(line);
      }
      expect(matches).toEqual([]);
    });
  });
  describe("triage-bootstrap.yml", () => {
    it("test_no_taskfile_dir_traversal_in_command_lines", () => {
      const text = readFileSync(join(repoRoot(), "tasks/triage-bootstrap.yml"), {
        encoding: "utf8",
      });
      const matches: string[] = [];
      for (const line of text.split("\n")) {
        if (line.trimStart().startsWith("#")) continue;
        if (ANTIPATTERN_CMD.test(line) || ANTIPATTERN_FRAGMENT.test(line)) matches.push(line);
      }
      expect(matches).toEqual([]);
    });
  });
  describe("triage-bulk.yml", () => {
    it("test_no_taskfile_dir_traversal_in_command_lines", () => {
      const text = readFileSync(join(repoRoot(), "tasks/triage-bulk.yml"), { encoding: "utf8" });
      const matches: string[] = [];
      for (const line of text.split("\n")) {
        if (line.trimStart().startsWith("#")) continue;
        if (ANTIPATTERN_CMD.test(line) || ANTIPATTERN_FRAGMENT.test(line)) matches.push(line);
      }
      expect(matches).toEqual([]);
    });
  });
  describe("triage-classify.yml", () => {
    it("test_no_taskfile_dir_traversal_in_command_lines", () => {
      const text = readFileSync(join(repoRoot(), "tasks/triage-classify.yml"), {
        encoding: "utf8",
      });
      const matches: string[] = [];
      for (const line of text.split("\n")) {
        if (line.trimStart().startsWith("#")) continue;
        if (ANTIPATTERN_CMD.test(line) || ANTIPATTERN_FRAGMENT.test(line)) matches.push(line);
      }
      expect(matches).toEqual([]);
    });
  });
  describe("triage-queue.yml", () => {
    it("test_no_taskfile_dir_traversal_in_command_lines", () => {
      const text = readFileSync(join(repoRoot(), "tasks/triage-queue.yml"), { encoding: "utf8" });
      const matches: string[] = [];
      for (const line of text.split("\n")) {
        if (line.trimStart().startsWith("#")) continue;
        if (ANTIPATTERN_CMD.test(line) || ANTIPATTERN_FRAGMENT.test(line)) matches.push(line);
      }
      expect(matches).toEqual([]);
    });
  });
  describe("triage-reconcile.yml", () => {
    it("test_no_taskfile_dir_traversal_in_command_lines", () => {
      const text = readFileSync(join(repoRoot(), "tasks/triage-reconcile.yml"), {
        encoding: "utf8",
      });
      const matches: string[] = [];
      for (const line of text.split("\n")) {
        if (line.trimStart().startsWith("#")) continue;
        if (ANTIPATTERN_CMD.test(line) || ANTIPATTERN_FRAGMENT.test(line)) matches.push(line);
      }
      expect(matches).toEqual([]);
    });
  });
  describe("triage-scope-drift.yml", () => {
    it("test_no_taskfile_dir_traversal_in_command_lines", () => {
      const text = readFileSync(join(repoRoot(), "tasks/triage-scope-drift.yml"), {
        encoding: "utf8",
      });
      const matches: string[] = [];
      for (const line of text.split("\n")) {
        if (line.trimStart().startsWith("#")) continue;
        if (ANTIPATTERN_CMD.test(line) || ANTIPATTERN_FRAGMENT.test(line)) matches.push(line);
      }
      expect(matches).toEqual([]);
    });
  });
  describe("triage-scope.yml", () => {
    it("test_no_taskfile_dir_traversal_in_command_lines", () => {
      const text = readFileSync(join(repoRoot(), "tasks/triage-scope.yml"), { encoding: "utf8" });
      const matches: string[] = [];
      for (const line of text.split("\n")) {
        if (line.trimStart().startsWith("#")) continue;
        if (ANTIPATTERN_CMD.test(line) || ANTIPATTERN_FRAGMENT.test(line)) matches.push(line);
      }
      expect(matches).toEqual([]);
    });
  });
  describe("triage-smoketest.yml", () => {
    it("test_no_taskfile_dir_traversal_in_command_lines", () => {
      const text = readFileSync(join(repoRoot(), "tasks/triage-smoketest.yml"), {
        encoding: "utf8",
      });
      const matches: string[] = [];
      for (const line of text.split("\n")) {
        if (line.trimStart().startsWith("#")) continue;
        if (ANTIPATTERN_CMD.test(line) || ANTIPATTERN_FRAGMENT.test(line)) matches.push(line);
      }
      expect(matches).toEqual([]);
    });
  });
  describe("triage-subscribe.yml", () => {
    it("test_no_taskfile_dir_traversal_in_command_lines", () => {
      const text = readFileSync(join(repoRoot(), "tasks/triage-subscribe.yml"), {
        encoding: "utf8",
      });
      const matches: string[] = [];
      for (const line of text.split("\n")) {
        if (line.trimStart().startsWith("#")) continue;
        if (ANTIPATTERN_CMD.test(line) || ANTIPATTERN_FRAGMENT.test(line)) matches.push(line);
      }
      expect(matches).toEqual([]);
    });
  });
  describe("triage-summary.yml", () => {
    it("test_no_taskfile_dir_traversal_in_command_lines", () => {
      const text = readFileSync(join(repoRoot(), "tasks/triage-summary.yml"), { encoding: "utf8" });
      const matches: string[] = [];
      for (const line of text.split("\n")) {
        if (line.trimStart().startsWith("#")) continue;
        if (ANTIPATTERN_CMD.test(line) || ANTIPATTERN_FRAGMENT.test(line)) matches.push(line);
      }
      expect(matches).toEqual([]);
    });
  });
  describe("triage-welcome.yml", () => {
    it("test_no_taskfile_dir_traversal_in_command_lines", () => {
      const text = readFileSync(join(repoRoot(), "tasks/triage-welcome.yml"), { encoding: "utf8" });
      const matches: string[] = [];
      for (const line of text.split("\n")) {
        if (line.trimStart().startsWith("#")) continue;
        if (ANTIPATTERN_CMD.test(line) || ANTIPATTERN_FRAGMENT.test(line)) matches.push(line);
      }
      expect(matches).toEqual([]);
    });
  });
  describe("ts.yml", () => {
    it("test_no_taskfile_dir_traversal_in_command_lines", () => {
      const text = readFileSync(join(repoRoot(), "tasks/ts.yml"), { encoding: "utf8" });
      const matches: string[] = [];
      for (const line of text.split("\n")) {
        if (line.trimStart().startsWith("#")) continue;
        if (ANTIPATTERN_CMD.test(line) || ANTIPATTERN_FRAGMENT.test(line)) matches.push(line);
      }
      expect(matches).toEqual([]);
    });
  });
  describe("vbrief.yml", () => {
    it("test_no_taskfile_dir_traversal_in_command_lines", () => {
      const text = readFileSync(join(repoRoot(), "tasks/vbrief.yml"), { encoding: "utf8" });
      const matches: string[] = [];
      for (const line of text.split("\n")) {
        if (line.trimStart().startsWith("#")) continue;
        if (ANTIPATTERN_CMD.test(line) || ANTIPATTERN_FRAGMENT.test(line)) matches.push(line);
      }
      expect(matches).toEqual([]);
    });
  });
  describe("verify.yml", () => {
    it("test_no_taskfile_dir_traversal_in_command_lines", () => {
      const text = readFileSync(join(repoRoot(), "tasks/verify.yml"), { encoding: "utf8" });
      const matches: string[] = [];
      for (const line of text.split("\n")) {
        if (line.trimStart().startsWith("#")) continue;
        if (ANTIPATTERN_CMD.test(line) || ANTIPATTERN_FRAGMENT.test(line)) matches.push(line);
      }
      expect(matches).toEqual([]);
    });
  });
  it("deft_root_joinpath architecture.yml", () => {
    expect(DEFT_ROOT_JOINPATH.test(readTaskfile("architecture.yml"))).toBe(true);
  });
  it("deft_root_joinpath cache.yml", () => {
    expect(DEFT_ROOT_JOINPATH.test(readTaskfile("cache.yml"))).toBe(true);
  });
  it("deft_root_joinpath capacity.yml", () => {
    expect(DEFT_ROOT_JOINPATH.test(readTaskfile("capacity.yml"))).toBe(true);
  });
  it("deft_root_joinpath change.yml", () => {
    expect(DEFT_ROOT_JOINPATH.test(readTaskfile("change.yml"))).toBe(true);
  });
  it("deft_root_joinpath changelog.yml", () => {
    expect(DEFT_ROOT_JOINPATH.test(readTaskfile("changelog.yml"))).toBe(true);
  });
  it("deft_root_joinpath ci.yml", () => {
    expect(DEFT_ROOT_JOINPATH.test(readTaskfile("ci.yml"))).toBe(true);
  });
  it("deft_root_joinpath codebase.yml", () => {
    expect(DEFT_ROOT_JOINPATH.test(readTaskfile("codebase.yml"))).toBe(true);
  });
  it("deft_root_joinpath commit.yml", () => {
    expect(DEFT_ROOT_JOINPATH.test(readTaskfile("commit.yml"))).toBe(true);
  });
  it("deft_root_joinpath core.yml", () => {
    expect(DEFT_ROOT_JOINPATH.test(readTaskfile("core.yml"))).toBe(true);
  });
  it("deft_root_joinpath framework.yml", () => {
    expect(DEFT_ROOT_JOINPATH.test(readTaskfile("framework.yml"))).toBe(true);
  });
  it("deft_root_joinpath install.yml", () => {
    expect(DEFT_ROOT_JOINPATH.test(readTaskfile("install.yml"))).toBe(true);
  });
  it("deft_root_joinpath issue.yml", () => {
    expect(DEFT_ROOT_JOINPATH.test(readTaskfile("issue.yml"))).toBe(true);
  });
  it("deft_root_joinpath migrate.yml", () => {
    expect(DEFT_ROOT_JOINPATH.test(readTaskfile("migrate.yml"))).toBe(true);
  });
  it("deft_root_joinpath packs.yml", () => {
    expect(DEFT_ROOT_JOINPATH.test(readTaskfile("packs.yml"))).toBe(true);
  });
  it("deft_root_joinpath policy.yml", () => {
    expect(DEFT_ROOT_JOINPATH.test(readTaskfile("policy.yml"))).toBe(true);
  });
  it("deft_root_joinpath pr.yml", () => {
    expect(DEFT_ROOT_JOINPATH.test(readTaskfile("pr.yml"))).toBe(true);
  });
  it("deft_root_joinpath prd.yml", () => {
    expect(DEFT_ROOT_JOINPATH.test(readTaskfile("prd.yml"))).toBe(true);
  });
  it("deft_root_joinpath project.yml", () => {
    expect(DEFT_ROOT_JOINPATH.test(readTaskfile("project.yml"))).toBe(true);
  });
  it("deft_root_joinpath reconcile.yml", () => {
    expect(DEFT_ROOT_JOINPATH.test(readTaskfile("reconcile.yml"))).toBe(true);
  });
  it("deft_root_joinpath relocate.yml", () => {
    expect(DEFT_ROOT_JOINPATH.test(readTaskfile("relocate.yml"))).toBe(true);
  });
  it("deft_root_joinpath roadmap.yml", () => {
    expect(DEFT_ROOT_JOINPATH.test(readTaskfile("roadmap.yml"))).toBe(true);
  });
  it("deft_root_joinpath scm.yml", () => {
    expect(DEFT_ROOT_JOINPATH.test(readTaskfile("scm.yml"))).toBe(true);
  });
  it("deft_root_joinpath scope-undo.yml", () => {
    expect(DEFT_ROOT_JOINPATH.test(readTaskfile("scope-undo.yml"))).toBe(true);
  });
  it("deft_root_joinpath scope.yml", () => {
    expect(DEFT_ROOT_JOINPATH.test(readTaskfile("scope.yml"))).toBe(true);
  });
  it("deft_root_joinpath session.yml", () => {
    expect(DEFT_ROOT_JOINPATH.test(readTaskfile("session.yml"))).toBe(true);
  });
  it("deft_root_joinpath setup.yml", () => {
    expect(DEFT_ROOT_JOINPATH.test(readTaskfile("setup.yml"))).toBe(true);
  });
  it("deft_root_joinpath slice.yml", () => {
    expect(DEFT_ROOT_JOINPATH.test(readTaskfile("slice.yml"))).toBe(true);
  });
  it("deft_root_joinpath spec.yml", () => {
    expect(DEFT_ROOT_JOINPATH.test(readTaskfile("spec.yml"))).toBe(true);
  });
  it("deft_root_joinpath swarm.yml", () => {
    expect(DEFT_ROOT_JOINPATH.test(readTaskfile("swarm.yml"))).toBe(true);
  });
  it("deft_root_joinpath toolchain.yml", () => {
    expect(DEFT_ROOT_JOINPATH.test(readTaskfile("toolchain.yml"))).toBe(true);
  });
  it("deft_root_joinpath triage-actions.yml", () => {
    expect(DEFT_ROOT_JOINPATH.test(readTaskfile("triage-actions.yml"))).toBe(true);
  });
  it("deft_root_joinpath triage-bootstrap.yml", () => {
    expect(DEFT_ROOT_JOINPATH.test(readTaskfile("triage-bootstrap.yml"))).toBe(true);
  });
  it("deft_root_joinpath triage-bulk.yml", () => {
    expect(DEFT_ROOT_JOINPATH.test(readTaskfile("triage-bulk.yml"))).toBe(true);
  });
  it("deft_root_joinpath triage-classify.yml", () => {
    expect(DEFT_ROOT_JOINPATH.test(readTaskfile("triage-classify.yml"))).toBe(true);
  });
  it("deft_root_joinpath triage-queue.yml", () => {
    expect(DEFT_ROOT_JOINPATH.test(readTaskfile("triage-queue.yml"))).toBe(true);
  });
  it("deft_root_joinpath triage-reconcile.yml", () => {
    expect(DEFT_ROOT_JOINPATH.test(readTaskfile("triage-reconcile.yml"))).toBe(true);
  });
  it("deft_root_joinpath triage-scope-drift.yml", () => {
    expect(DEFT_ROOT_JOINPATH.test(readTaskfile("triage-scope-drift.yml"))).toBe(true);
  });
  it("deft_root_joinpath triage-scope.yml", () => {
    expect(DEFT_ROOT_JOINPATH.test(readTaskfile("triage-scope.yml"))).toBe(true);
  });
  it("deft_root_joinpath triage-smoketest.yml", () => {
    expect(DEFT_ROOT_JOINPATH.test(readTaskfile("triage-smoketest.yml"))).toBe(true);
  });
  it("deft_root_joinpath triage-subscribe.yml", () => {
    expect(DEFT_ROOT_JOINPATH.test(readTaskfile("triage-subscribe.yml"))).toBe(true);
  });
  it("deft_root_joinpath triage-summary.yml", () => {
    expect(DEFT_ROOT_JOINPATH.test(readTaskfile("triage-summary.yml"))).toBe(true);
  });
  it("deft_root_joinpath triage-welcome.yml", () => {
    expect(DEFT_ROOT_JOINPATH.test(readTaskfile("triage-welcome.yml"))).toBe(true);
  });
  it("deft_root_joinpath ts.yml", () => {
    expect(DEFT_ROOT_JOINPATH.test(readTaskfile("ts.yml"))).toBe(true);
  });
  it("deft_root_joinpath vbrief.yml", () => {
    expect(DEFT_ROOT_JOINPATH.test(readTaskfile("vbrief.yml"))).toBe(true);
  });
  it("deft_root_joinpath verify.yml", () => {
    expect(DEFT_ROOT_JOINPATH.test(readTaskfile("verify.yml"))).toBe(true);
  });
});
