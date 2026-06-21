import { execFileSync, execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { repoRoot } from "./_helpers.js";
import {
  blockBody,
  cachingKeyOnLine,
  iterTaskBlocks,
  nonCommentLines,
} from "./_taskfile-helpers.js";

const taskAvailable = (() => {
  try {
    execSync("task --version", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe("test_taskfile_caching.py", () => {
  describe("architecture.yml", () => {
    it("test_cli_args_tasks_declare_no_caching", () => {
      const text = readFileSync(join(repoRoot(), "tasks/architecture.yml"), { encoding: "utf8" });
      const offenders: string[] = [];
      for (const { name: taskName, start, end } of iterTaskBlocks(text)) {
        const body = blockBody(text, start, end);
        const nonComment = nonCommentLines(body).join("\n");
        if (!nonComment.includes("{{.CLI_ARGS}}") || !nonComment.includes("uv run python"))
          continue;
        const badKeys: string[] = [];
        for (const line of nonCommentLines(body)) {
          const key = cachingKeyOnLine(line);
          if (key) badKeys.push(key);
        }
        if (badKeys.length) offenders.push(`${taskName}: ${badKeys.join(", ")}`);
      }
      expect(offenders).toEqual([]);
    });
  });
  describe("cache.yml", () => {
    it("test_cli_args_tasks_declare_no_caching", () => {
      const text = readFileSync(join(repoRoot(), "tasks/cache.yml"), { encoding: "utf8" });
      const offenders: string[] = [];
      for (const { name: taskName, start, end } of iterTaskBlocks(text)) {
        const body = blockBody(text, start, end);
        const nonComment = nonCommentLines(body).join("\n");
        if (!nonComment.includes("{{.CLI_ARGS}}") || !nonComment.includes("uv run python"))
          continue;
        const badKeys: string[] = [];
        for (const line of nonCommentLines(body)) {
          const key = cachingKeyOnLine(line);
          if (key) badKeys.push(key);
        }
        if (badKeys.length) offenders.push(`${taskName}: ${badKeys.join(", ")}`);
      }
      expect(offenders).toEqual([]);
    });
  });
  describe("capacity.yml", () => {
    it("test_cli_args_tasks_declare_no_caching", () => {
      const text = readFileSync(join(repoRoot(), "tasks/capacity.yml"), { encoding: "utf8" });
      const offenders: string[] = [];
      for (const { name: taskName, start, end } of iterTaskBlocks(text)) {
        const body = blockBody(text, start, end);
        const nonComment = nonCommentLines(body).join("\n");
        if (!nonComment.includes("{{.CLI_ARGS}}") || !nonComment.includes("uv run python"))
          continue;
        const badKeys: string[] = [];
        for (const line of nonCommentLines(body)) {
          const key = cachingKeyOnLine(line);
          if (key) badKeys.push(key);
        }
        if (badKeys.length) offenders.push(`${taskName}: ${badKeys.join(", ")}`);
      }
      expect(offenders).toEqual([]);
    });
  });
  describe("change.yml", () => {
    it("test_cli_args_tasks_declare_no_caching", () => {
      const text = readFileSync(join(repoRoot(), "tasks/change.yml"), { encoding: "utf8" });
      const offenders: string[] = [];
      for (const { name: taskName, start, end } of iterTaskBlocks(text)) {
        const body = blockBody(text, start, end);
        const nonComment = nonCommentLines(body).join("\n");
        if (!nonComment.includes("{{.CLI_ARGS}}") || !nonComment.includes("uv run python"))
          continue;
        const badKeys: string[] = [];
        for (const line of nonCommentLines(body)) {
          const key = cachingKeyOnLine(line);
          if (key) badKeys.push(key);
        }
        if (badKeys.length) offenders.push(`${taskName}: ${badKeys.join(", ")}`);
      }
      expect(offenders).toEqual([]);
    });
  });
  describe("changelog.yml", () => {
    it("test_cli_args_tasks_declare_no_caching", () => {
      const text = readFileSync(join(repoRoot(), "tasks/changelog.yml"), { encoding: "utf8" });
      const offenders: string[] = [];
      for (const { name: taskName, start, end } of iterTaskBlocks(text)) {
        const body = blockBody(text, start, end);
        const nonComment = nonCommentLines(body).join("\n");
        if (!nonComment.includes("{{.CLI_ARGS}}") || !nonComment.includes("uv run python"))
          continue;
        const badKeys: string[] = [];
        for (const line of nonCommentLines(body)) {
          const key = cachingKeyOnLine(line);
          if (key) badKeys.push(key);
        }
        if (badKeys.length) offenders.push(`${taskName}: ${badKeys.join(", ")}`);
      }
      expect(offenders).toEqual([]);
    });
  });
  describe("ci.yml", () => {
    it("test_cli_args_tasks_declare_no_caching", () => {
      const text = readFileSync(join(repoRoot(), "tasks/ci.yml"), { encoding: "utf8" });
      const offenders: string[] = [];
      for (const { name: taskName, start, end } of iterTaskBlocks(text)) {
        const body = blockBody(text, start, end);
        const nonComment = nonCommentLines(body).join("\n");
        if (!nonComment.includes("{{.CLI_ARGS}}") || !nonComment.includes("uv run python"))
          continue;
        const badKeys: string[] = [];
        for (const line of nonCommentLines(body)) {
          const key = cachingKeyOnLine(line);
          if (key) badKeys.push(key);
        }
        if (badKeys.length) offenders.push(`${taskName}: ${badKeys.join(", ")}`);
      }
      expect(offenders).toEqual([]);
    });
  });
  describe("codebase.yml", () => {
    it("test_cli_args_tasks_declare_no_caching", () => {
      const text = readFileSync(join(repoRoot(), "tasks/codebase.yml"), { encoding: "utf8" });
      const offenders: string[] = [];
      for (const { name: taskName, start, end } of iterTaskBlocks(text)) {
        const body = blockBody(text, start, end);
        const nonComment = nonCommentLines(body).join("\n");
        if (!nonComment.includes("{{.CLI_ARGS}}") || !nonComment.includes("uv run python"))
          continue;
        const badKeys: string[] = [];
        for (const line of nonCommentLines(body)) {
          const key = cachingKeyOnLine(line);
          if (key) badKeys.push(key);
        }
        if (badKeys.length) offenders.push(`${taskName}: ${badKeys.join(", ")}`);
      }
      expect(offenders).toEqual([]);
    });
  });
  describe("commit.yml", () => {
    it("test_cli_args_tasks_declare_no_caching", () => {
      const text = readFileSync(join(repoRoot(), "tasks/commit.yml"), { encoding: "utf8" });
      const offenders: string[] = [];
      for (const { name: taskName, start, end } of iterTaskBlocks(text)) {
        const body = blockBody(text, start, end);
        const nonComment = nonCommentLines(body).join("\n");
        if (!nonComment.includes("{{.CLI_ARGS}}") || !nonComment.includes("uv run python"))
          continue;
        const badKeys: string[] = [];
        for (const line of nonCommentLines(body)) {
          const key = cachingKeyOnLine(line);
          if (key) badKeys.push(key);
        }
        if (badKeys.length) offenders.push(`${taskName}: ${badKeys.join(", ")}`);
      }
      expect(offenders).toEqual([]);
    });
  });
  describe("core.yml", () => {
    it("test_cli_args_tasks_declare_no_caching", () => {
      const text = readFileSync(join(repoRoot(), "tasks/core.yml"), { encoding: "utf8" });
      const offenders: string[] = [];
      for (const { name: taskName, start, end } of iterTaskBlocks(text)) {
        const body = blockBody(text, start, end);
        const nonComment = nonCommentLines(body).join("\n");
        if (!nonComment.includes("{{.CLI_ARGS}}") || !nonComment.includes("uv run python"))
          continue;
        const badKeys: string[] = [];
        for (const line of nonCommentLines(body)) {
          const key = cachingKeyOnLine(line);
          if (key) badKeys.push(key);
        }
        if (badKeys.length) offenders.push(`${taskName}: ${badKeys.join(", ")}`);
      }
      expect(offenders).toEqual([]);
    });
  });
  describe("deployments.yml", () => {
    it("test_cli_args_tasks_declare_no_caching", () => {
      const text = readFileSync(join(repoRoot(), "tasks/deployments.yml"), { encoding: "utf8" });
      const offenders: string[] = [];
      for (const { name: taskName, start, end } of iterTaskBlocks(text)) {
        const body = blockBody(text, start, end);
        const nonComment = nonCommentLines(body).join("\n");
        if (!nonComment.includes("{{.CLI_ARGS}}") || !nonComment.includes("uv run python"))
          continue;
        const badKeys: string[] = [];
        for (const line of nonCommentLines(body)) {
          const key = cachingKeyOnLine(line);
          if (key) badKeys.push(key);
        }
        if (badKeys.length) offenders.push(`${taskName}: ${badKeys.join(", ")}`);
      }
      expect(offenders).toEqual([]);
    });
  });
  describe("framework.yml", () => {
    it("test_cli_args_tasks_declare_no_caching", () => {
      const text = readFileSync(join(repoRoot(), "tasks/framework.yml"), { encoding: "utf8" });
      const offenders: string[] = [];
      for (const { name: taskName, start, end } of iterTaskBlocks(text)) {
        const body = blockBody(text, start, end);
        const nonComment = nonCommentLines(body).join("\n");
        if (!nonComment.includes("{{.CLI_ARGS}}") || !nonComment.includes("uv run python"))
          continue;
        const badKeys: string[] = [];
        for (const line of nonCommentLines(body)) {
          const key = cachingKeyOnLine(line);
          if (key) badKeys.push(key);
        }
        if (badKeys.length) offenders.push(`${taskName}: ${badKeys.join(", ")}`);
      }
      expect(offenders).toEqual([]);
    });
  });
  describe("install.yml", () => {
    it("test_cli_args_tasks_declare_no_caching", () => {
      const text = readFileSync(join(repoRoot(), "tasks/install.yml"), { encoding: "utf8" });
      const offenders: string[] = [];
      for (const { name: taskName, start, end } of iterTaskBlocks(text)) {
        const body = blockBody(text, start, end);
        const nonComment = nonCommentLines(body).join("\n");
        if (!nonComment.includes("{{.CLI_ARGS}}") || !nonComment.includes("uv run python"))
          continue;
        const badKeys: string[] = [];
        for (const line of nonCommentLines(body)) {
          const key = cachingKeyOnLine(line);
          if (key) badKeys.push(key);
        }
        if (badKeys.length) offenders.push(`${taskName}: ${badKeys.join(", ")}`);
      }
      expect(offenders).toEqual([]);
    });
  });
  describe("issue.yml", () => {
    it("test_cli_args_tasks_declare_no_caching", () => {
      const text = readFileSync(join(repoRoot(), "tasks/issue.yml"), { encoding: "utf8" });
      const offenders: string[] = [];
      for (const { name: taskName, start, end } of iterTaskBlocks(text)) {
        const body = blockBody(text, start, end);
        const nonComment = nonCommentLines(body).join("\n");
        if (!nonComment.includes("{{.CLI_ARGS}}") || !nonComment.includes("uv run python"))
          continue;
        const badKeys: string[] = [];
        for (const line of nonCommentLines(body)) {
          const key = cachingKeyOnLine(line);
          if (key) badKeys.push(key);
        }
        if (badKeys.length) offenders.push(`${taskName}: ${badKeys.join(", ")}`);
      }
      expect(offenders).toEqual([]);
    });
  });
  describe("migrate.yml", () => {
    it("test_cli_args_tasks_declare_no_caching", () => {
      const text = readFileSync(join(repoRoot(), "tasks/migrate.yml"), { encoding: "utf8" });
      const offenders: string[] = [];
      for (const { name: taskName, start, end } of iterTaskBlocks(text)) {
        const body = blockBody(text, start, end);
        const nonComment = nonCommentLines(body).join("\n");
        if (!nonComment.includes("{{.CLI_ARGS}}") || !nonComment.includes("uv run python"))
          continue;
        const badKeys: string[] = [];
        for (const line of nonCommentLines(body)) {
          const key = cachingKeyOnLine(line);
          if (key) badKeys.push(key);
        }
        if (badKeys.length) offenders.push(`${taskName}: ${badKeys.join(", ")}`);
      }
      expect(offenders).toEqual([]);
    });
  });
  describe("packs.yml", () => {
    it("test_cli_args_tasks_declare_no_caching", () => {
      const text = readFileSync(join(repoRoot(), "tasks/packs.yml"), { encoding: "utf8" });
      const offenders: string[] = [];
      for (const { name: taskName, start, end } of iterTaskBlocks(text)) {
        const body = blockBody(text, start, end);
        const nonComment = nonCommentLines(body).join("\n");
        if (!nonComment.includes("{{.CLI_ARGS}}") || !nonComment.includes("uv run python"))
          continue;
        const badKeys: string[] = [];
        for (const line of nonCommentLines(body)) {
          const key = cachingKeyOnLine(line);
          if (key) badKeys.push(key);
        }
        if (badKeys.length) offenders.push(`${taskName}: ${badKeys.join(", ")}`);
      }
      expect(offenders).toEqual([]);
    });
  });
  describe("policy.yml", () => {
    it("test_cli_args_tasks_declare_no_caching", () => {
      const text = readFileSync(join(repoRoot(), "tasks/policy.yml"), { encoding: "utf8" });
      const offenders: string[] = [];
      for (const { name: taskName, start, end } of iterTaskBlocks(text)) {
        const body = blockBody(text, start, end);
        const nonComment = nonCommentLines(body).join("\n");
        if (!nonComment.includes("{{.CLI_ARGS}}") || !nonComment.includes("uv run python"))
          continue;
        const badKeys: string[] = [];
        for (const line of nonCommentLines(body)) {
          const key = cachingKeyOnLine(line);
          if (key) badKeys.push(key);
        }
        if (badKeys.length) offenders.push(`${taskName}: ${badKeys.join(", ")}`);
      }
      expect(offenders).toEqual([]);
    });
  });
  describe("pr.yml", () => {
    it("test_cli_args_tasks_declare_no_caching", () => {
      const text = readFileSync(join(repoRoot(), "tasks/pr.yml"), { encoding: "utf8" });
      const offenders: string[] = [];
      for (const { name: taskName, start, end } of iterTaskBlocks(text)) {
        const body = blockBody(text, start, end);
        const nonComment = nonCommentLines(body).join("\n");
        if (!nonComment.includes("{{.CLI_ARGS}}") || !nonComment.includes("uv run python"))
          continue;
        const badKeys: string[] = [];
        for (const line of nonCommentLines(body)) {
          const key = cachingKeyOnLine(line);
          if (key) badKeys.push(key);
        }
        if (badKeys.length) offenders.push(`${taskName}: ${badKeys.join(", ")}`);
      }
      expect(offenders).toEqual([]);
    });
  });
  describe("prd.yml", () => {
    it("test_cli_args_tasks_declare_no_caching", () => {
      const text = readFileSync(join(repoRoot(), "tasks/prd.yml"), { encoding: "utf8" });
      const offenders: string[] = [];
      for (const { name: taskName, start, end } of iterTaskBlocks(text)) {
        const body = blockBody(text, start, end);
        const nonComment = nonCommentLines(body).join("\n");
        if (!nonComment.includes("{{.CLI_ARGS}}") || !nonComment.includes("uv run python"))
          continue;
        const badKeys: string[] = [];
        for (const line of nonCommentLines(body)) {
          const key = cachingKeyOnLine(line);
          if (key) badKeys.push(key);
        }
        if (badKeys.length) offenders.push(`${taskName}: ${badKeys.join(", ")}`);
      }
      expect(offenders).toEqual([]);
    });
  });
  describe("project.yml", () => {
    it("test_cli_args_tasks_declare_no_caching", () => {
      const text = readFileSync(join(repoRoot(), "tasks/project.yml"), { encoding: "utf8" });
      const offenders: string[] = [];
      for (const { name: taskName, start, end } of iterTaskBlocks(text)) {
        const body = blockBody(text, start, end);
        const nonComment = nonCommentLines(body).join("\n");
        if (!nonComment.includes("{{.CLI_ARGS}}") || !nonComment.includes("uv run python"))
          continue;
        const badKeys: string[] = [];
        for (const line of nonCommentLines(body)) {
          const key = cachingKeyOnLine(line);
          if (key) badKeys.push(key);
        }
        if (badKeys.length) offenders.push(`${taskName}: ${badKeys.join(", ")}`);
      }
      expect(offenders).toEqual([]);
    });
  });
  describe("reconcile.yml", () => {
    it("test_cli_args_tasks_declare_no_caching", () => {
      const text = readFileSync(join(repoRoot(), "tasks/reconcile.yml"), { encoding: "utf8" });
      const offenders: string[] = [];
      for (const { name: taskName, start, end } of iterTaskBlocks(text)) {
        const body = blockBody(text, start, end);
        const nonComment = nonCommentLines(body).join("\n");
        if (!nonComment.includes("{{.CLI_ARGS}}") || !nonComment.includes("uv run python"))
          continue;
        const badKeys: string[] = [];
        for (const line of nonCommentLines(body)) {
          const key = cachingKeyOnLine(line);
          if (key) badKeys.push(key);
        }
        if (badKeys.length) offenders.push(`${taskName}: ${badKeys.join(", ")}`);
      }
      expect(offenders).toEqual([]);
    });
  });
  describe("relocate.yml", () => {
    it("test_cli_args_tasks_declare_no_caching", () => {
      const text = readFileSync(join(repoRoot(), "tasks/relocate.yml"), { encoding: "utf8" });
      const offenders: string[] = [];
      for (const { name: taskName, start, end } of iterTaskBlocks(text)) {
        const body = blockBody(text, start, end);
        const nonComment = nonCommentLines(body).join("\n");
        if (!nonComment.includes("{{.CLI_ARGS}}") || !nonComment.includes("uv run python"))
          continue;
        const badKeys: string[] = [];
        for (const line of nonCommentLines(body)) {
          const key = cachingKeyOnLine(line);
          if (key) badKeys.push(key);
        }
        if (badKeys.length) offenders.push(`${taskName}: ${badKeys.join(", ")}`);
      }
      expect(offenders).toEqual([]);
    });
  });
  describe("roadmap.yml", () => {
    it("test_cli_args_tasks_declare_no_caching", () => {
      const text = readFileSync(join(repoRoot(), "tasks/roadmap.yml"), { encoding: "utf8" });
      const offenders: string[] = [];
      for (const { name: taskName, start, end } of iterTaskBlocks(text)) {
        const body = blockBody(text, start, end);
        const nonComment = nonCommentLines(body).join("\n");
        if (!nonComment.includes("{{.CLI_ARGS}}") || !nonComment.includes("uv run python"))
          continue;
        const badKeys: string[] = [];
        for (const line of nonCommentLines(body)) {
          const key = cachingKeyOnLine(line);
          if (key) badKeys.push(key);
        }
        if (badKeys.length) offenders.push(`${taskName}: ${badKeys.join(", ")}`);
      }
      expect(offenders).toEqual([]);
    });
  });
  describe("scm.yml", () => {
    it("test_cli_args_tasks_declare_no_caching", () => {
      const text = readFileSync(join(repoRoot(), "tasks/scm.yml"), { encoding: "utf8" });
      const offenders: string[] = [];
      for (const { name: taskName, start, end } of iterTaskBlocks(text)) {
        const body = blockBody(text, start, end);
        const nonComment = nonCommentLines(body).join("\n");
        if (!nonComment.includes("{{.CLI_ARGS}}") || !nonComment.includes("uv run python"))
          continue;
        const badKeys: string[] = [];
        for (const line of nonCommentLines(body)) {
          const key = cachingKeyOnLine(line);
          if (key) badKeys.push(key);
        }
        if (badKeys.length) offenders.push(`${taskName}: ${badKeys.join(", ")}`);
      }
      expect(offenders).toEqual([]);
    });
  });
  describe("scope-undo.yml", () => {
    it("test_cli_args_tasks_declare_no_caching", () => {
      const text = readFileSync(join(repoRoot(), "tasks/scope-undo.yml"), { encoding: "utf8" });
      const offenders: string[] = [];
      for (const { name: taskName, start, end } of iterTaskBlocks(text)) {
        const body = blockBody(text, start, end);
        const nonComment = nonCommentLines(body).join("\n");
        if (!nonComment.includes("{{.CLI_ARGS}}") || !nonComment.includes("uv run python"))
          continue;
        const badKeys: string[] = [];
        for (const line of nonCommentLines(body)) {
          const key = cachingKeyOnLine(line);
          if (key) badKeys.push(key);
        }
        if (badKeys.length) offenders.push(`${taskName}: ${badKeys.join(", ")}`);
      }
      expect(offenders).toEqual([]);
    });
  });
  describe("scope.yml", () => {
    it("test_cli_args_tasks_declare_no_caching", () => {
      const text = readFileSync(join(repoRoot(), "tasks/scope.yml"), { encoding: "utf8" });
      const offenders: string[] = [];
      for (const { name: taskName, start, end } of iterTaskBlocks(text)) {
        const body = blockBody(text, start, end);
        const nonComment = nonCommentLines(body).join("\n");
        if (!nonComment.includes("{{.CLI_ARGS}}") || !nonComment.includes("uv run python"))
          continue;
        const badKeys: string[] = [];
        for (const line of nonCommentLines(body)) {
          const key = cachingKeyOnLine(line);
          if (key) badKeys.push(key);
        }
        if (badKeys.length) offenders.push(`${taskName}: ${badKeys.join(", ")}`);
      }
      expect(offenders).toEqual([]);
    });
  });
  describe("session.yml", () => {
    it("test_cli_args_tasks_declare_no_caching", () => {
      const text = readFileSync(join(repoRoot(), "tasks/session.yml"), { encoding: "utf8" });
      const offenders: string[] = [];
      for (const { name: taskName, start, end } of iterTaskBlocks(text)) {
        const body = blockBody(text, start, end);
        const nonComment = nonCommentLines(body).join("\n");
        if (!nonComment.includes("{{.CLI_ARGS}}") || !nonComment.includes("uv run python"))
          continue;
        const badKeys: string[] = [];
        for (const line of nonCommentLines(body)) {
          const key = cachingKeyOnLine(line);
          if (key) badKeys.push(key);
        }
        if (badKeys.length) offenders.push(`${taskName}: ${badKeys.join(", ")}`);
      }
      expect(offenders).toEqual([]);
    });
  });
  describe("setup.yml", () => {
    it("test_cli_args_tasks_declare_no_caching", () => {
      const text = readFileSync(join(repoRoot(), "tasks/setup.yml"), { encoding: "utf8" });
      const offenders: string[] = [];
      for (const { name: taskName, start, end } of iterTaskBlocks(text)) {
        const body = blockBody(text, start, end);
        const nonComment = nonCommentLines(body).join("\n");
        if (!nonComment.includes("{{.CLI_ARGS}}") || !nonComment.includes("uv run python"))
          continue;
        const badKeys: string[] = [];
        for (const line of nonCommentLines(body)) {
          const key = cachingKeyOnLine(line);
          if (key) badKeys.push(key);
        }
        if (badKeys.length) offenders.push(`${taskName}: ${badKeys.join(", ")}`);
      }
      expect(offenders).toEqual([]);
    });
  });
  describe("slice.yml", () => {
    it("test_cli_args_tasks_declare_no_caching", () => {
      const text = readFileSync(join(repoRoot(), "tasks/slice.yml"), { encoding: "utf8" });
      const offenders: string[] = [];
      for (const { name: taskName, start, end } of iterTaskBlocks(text)) {
        const body = blockBody(text, start, end);
        const nonComment = nonCommentLines(body).join("\n");
        if (!nonComment.includes("{{.CLI_ARGS}}") || !nonComment.includes("uv run python"))
          continue;
        const badKeys: string[] = [];
        for (const line of nonCommentLines(body)) {
          const key = cachingKeyOnLine(line);
          if (key) badKeys.push(key);
        }
        if (badKeys.length) offenders.push(`${taskName}: ${badKeys.join(", ")}`);
      }
      expect(offenders).toEqual([]);
    });
  });
  describe("spec.yml", () => {
    it("test_cli_args_tasks_declare_no_caching", () => {
      const text = readFileSync(join(repoRoot(), "tasks/spec.yml"), { encoding: "utf8" });
      const offenders: string[] = [];
      for (const { name: taskName, start, end } of iterTaskBlocks(text)) {
        const body = blockBody(text, start, end);
        const nonComment = nonCommentLines(body).join("\n");
        if (!nonComment.includes("{{.CLI_ARGS}}") || !nonComment.includes("uv run python"))
          continue;
        const badKeys: string[] = [];
        for (const line of nonCommentLines(body)) {
          const key = cachingKeyOnLine(line);
          if (key) badKeys.push(key);
        }
        if (badKeys.length) offenders.push(`${taskName}: ${badKeys.join(", ")}`);
      }
      expect(offenders).toEqual([]);
    });
  });
  describe("swarm.yml", () => {
    it("test_cli_args_tasks_declare_no_caching", () => {
      const text = readFileSync(join(repoRoot(), "tasks/swarm.yml"), { encoding: "utf8" });
      const offenders: string[] = [];
      for (const { name: taskName, start, end } of iterTaskBlocks(text)) {
        const body = blockBody(text, start, end);
        const nonComment = nonCommentLines(body).join("\n");
        if (!nonComment.includes("{{.CLI_ARGS}}") || !nonComment.includes("uv run python"))
          continue;
        const badKeys: string[] = [];
        for (const line of nonCommentLines(body)) {
          const key = cachingKeyOnLine(line);
          if (key) badKeys.push(key);
        }
        if (badKeys.length) offenders.push(`${taskName}: ${badKeys.join(", ")}`);
      }
      expect(offenders).toEqual([]);
    });
  });
  describe("toolchain.yml", () => {
    it("test_cli_args_tasks_declare_no_caching", () => {
      const text = readFileSync(join(repoRoot(), "tasks/toolchain.yml"), { encoding: "utf8" });
      const offenders: string[] = [];
      for (const { name: taskName, start, end } of iterTaskBlocks(text)) {
        const body = blockBody(text, start, end);
        const nonComment = nonCommentLines(body).join("\n");
        if (!nonComment.includes("{{.CLI_ARGS}}") || !nonComment.includes("uv run python"))
          continue;
        const badKeys: string[] = [];
        for (const line of nonCommentLines(body)) {
          const key = cachingKeyOnLine(line);
          if (key) badKeys.push(key);
        }
        if (badKeys.length) offenders.push(`${taskName}: ${badKeys.join(", ")}`);
      }
      expect(offenders).toEqual([]);
    });
  });
  describe("triage-actions.yml", () => {
    it("test_cli_args_tasks_declare_no_caching", () => {
      const text = readFileSync(join(repoRoot(), "tasks/triage-actions.yml"), { encoding: "utf8" });
      const offenders: string[] = [];
      for (const { name: taskName, start, end } of iterTaskBlocks(text)) {
        const body = blockBody(text, start, end);
        const nonComment = nonCommentLines(body).join("\n");
        if (!nonComment.includes("{{.CLI_ARGS}}") || !nonComment.includes("uv run python"))
          continue;
        const badKeys: string[] = [];
        for (const line of nonCommentLines(body)) {
          const key = cachingKeyOnLine(line);
          if (key) badKeys.push(key);
        }
        if (badKeys.length) offenders.push(`${taskName}: ${badKeys.join(", ")}`);
      }
      expect(offenders).toEqual([]);
    });
  });
  describe("triage-bootstrap.yml", () => {
    it("test_cli_args_tasks_declare_no_caching", () => {
      const text = readFileSync(join(repoRoot(), "tasks/triage-bootstrap.yml"), {
        encoding: "utf8",
      });
      const offenders: string[] = [];
      for (const { name: taskName, start, end } of iterTaskBlocks(text)) {
        const body = blockBody(text, start, end);
        const nonComment = nonCommentLines(body).join("\n");
        if (!nonComment.includes("{{.CLI_ARGS}}") || !nonComment.includes("uv run python"))
          continue;
        const badKeys: string[] = [];
        for (const line of nonCommentLines(body)) {
          const key = cachingKeyOnLine(line);
          if (key) badKeys.push(key);
        }
        if (badKeys.length) offenders.push(`${taskName}: ${badKeys.join(", ")}`);
      }
      expect(offenders).toEqual([]);
    });
  });
  describe("triage-bulk.yml", () => {
    it("test_cli_args_tasks_declare_no_caching", () => {
      const text = readFileSync(join(repoRoot(), "tasks/triage-bulk.yml"), { encoding: "utf8" });
      const offenders: string[] = [];
      for (const { name: taskName, start, end } of iterTaskBlocks(text)) {
        const body = blockBody(text, start, end);
        const nonComment = nonCommentLines(body).join("\n");
        if (!nonComment.includes("{{.CLI_ARGS}}") || !nonComment.includes("uv run python"))
          continue;
        const badKeys: string[] = [];
        for (const line of nonCommentLines(body)) {
          const key = cachingKeyOnLine(line);
          if (key) badKeys.push(key);
        }
        if (badKeys.length) offenders.push(`${taskName}: ${badKeys.join(", ")}`);
      }
      expect(offenders).toEqual([]);
    });
  });
  describe("triage-classify.yml", () => {
    it("test_cli_args_tasks_declare_no_caching", () => {
      const text = readFileSync(join(repoRoot(), "tasks/triage-classify.yml"), {
        encoding: "utf8",
      });
      const offenders: string[] = [];
      for (const { name: taskName, start, end } of iterTaskBlocks(text)) {
        const body = blockBody(text, start, end);
        const nonComment = nonCommentLines(body).join("\n");
        if (!nonComment.includes("{{.CLI_ARGS}}") || !nonComment.includes("uv run python"))
          continue;
        const badKeys: string[] = [];
        for (const line of nonCommentLines(body)) {
          const key = cachingKeyOnLine(line);
          if (key) badKeys.push(key);
        }
        if (badKeys.length) offenders.push(`${taskName}: ${badKeys.join(", ")}`);
      }
      expect(offenders).toEqual([]);
    });
  });
  describe("triage-queue.yml", () => {
    it("test_cli_args_tasks_declare_no_caching", () => {
      const text = readFileSync(join(repoRoot(), "tasks/triage-queue.yml"), { encoding: "utf8" });
      const offenders: string[] = [];
      for (const { name: taskName, start, end } of iterTaskBlocks(text)) {
        const body = blockBody(text, start, end);
        const nonComment = nonCommentLines(body).join("\n");
        if (!nonComment.includes("{{.CLI_ARGS}}") || !nonComment.includes("uv run python"))
          continue;
        const badKeys: string[] = [];
        for (const line of nonCommentLines(body)) {
          const key = cachingKeyOnLine(line);
          if (key) badKeys.push(key);
        }
        if (badKeys.length) offenders.push(`${taskName}: ${badKeys.join(", ")}`);
      }
      expect(offenders).toEqual([]);
    });
  });
  describe("triage-reconcile.yml", () => {
    it("test_cli_args_tasks_declare_no_caching", () => {
      const text = readFileSync(join(repoRoot(), "tasks/triage-reconcile.yml"), {
        encoding: "utf8",
      });
      const offenders: string[] = [];
      for (const { name: taskName, start, end } of iterTaskBlocks(text)) {
        const body = blockBody(text, start, end);
        const nonComment = nonCommentLines(body).join("\n");
        if (!nonComment.includes("{{.CLI_ARGS}}") || !nonComment.includes("uv run python"))
          continue;
        const badKeys: string[] = [];
        for (const line of nonCommentLines(body)) {
          const key = cachingKeyOnLine(line);
          if (key) badKeys.push(key);
        }
        if (badKeys.length) offenders.push(`${taskName}: ${badKeys.join(", ")}`);
      }
      expect(offenders).toEqual([]);
    });
  });
  describe("triage-scope-drift.yml", () => {
    it("test_cli_args_tasks_declare_no_caching", () => {
      const text = readFileSync(join(repoRoot(), "tasks/triage-scope-drift.yml"), {
        encoding: "utf8",
      });
      const offenders: string[] = [];
      for (const { name: taskName, start, end } of iterTaskBlocks(text)) {
        const body = blockBody(text, start, end);
        const nonComment = nonCommentLines(body).join("\n");
        if (!nonComment.includes("{{.CLI_ARGS}}") || !nonComment.includes("uv run python"))
          continue;
        const badKeys: string[] = [];
        for (const line of nonCommentLines(body)) {
          const key = cachingKeyOnLine(line);
          if (key) badKeys.push(key);
        }
        if (badKeys.length) offenders.push(`${taskName}: ${badKeys.join(", ")}`);
      }
      expect(offenders).toEqual([]);
    });
  });
  describe("triage-scope.yml", () => {
    it("test_cli_args_tasks_declare_no_caching", () => {
      const text = readFileSync(join(repoRoot(), "tasks/triage-scope.yml"), { encoding: "utf8" });
      const offenders: string[] = [];
      for (const { name: taskName, start, end } of iterTaskBlocks(text)) {
        const body = blockBody(text, start, end);
        const nonComment = nonCommentLines(body).join("\n");
        if (!nonComment.includes("{{.CLI_ARGS}}") || !nonComment.includes("uv run python"))
          continue;
        const badKeys: string[] = [];
        for (const line of nonCommentLines(body)) {
          const key = cachingKeyOnLine(line);
          if (key) badKeys.push(key);
        }
        if (badKeys.length) offenders.push(`${taskName}: ${badKeys.join(", ")}`);
      }
      expect(offenders).toEqual([]);
    });
  });
  describe("triage-smoketest.yml", () => {
    it("test_cli_args_tasks_declare_no_caching", () => {
      const text = readFileSync(join(repoRoot(), "tasks/triage-smoketest.yml"), {
        encoding: "utf8",
      });
      const offenders: string[] = [];
      for (const { name: taskName, start, end } of iterTaskBlocks(text)) {
        const body = blockBody(text, start, end);
        const nonComment = nonCommentLines(body).join("\n");
        if (!nonComment.includes("{{.CLI_ARGS}}") || !nonComment.includes("uv run python"))
          continue;
        const badKeys: string[] = [];
        for (const line of nonCommentLines(body)) {
          const key = cachingKeyOnLine(line);
          if (key) badKeys.push(key);
        }
        if (badKeys.length) offenders.push(`${taskName}: ${badKeys.join(", ")}`);
      }
      expect(offenders).toEqual([]);
    });
  });
  describe("triage-subscribe.yml", () => {
    it("test_cli_args_tasks_declare_no_caching", () => {
      const text = readFileSync(join(repoRoot(), "tasks/triage-subscribe.yml"), {
        encoding: "utf8",
      });
      const offenders: string[] = [];
      for (const { name: taskName, start, end } of iterTaskBlocks(text)) {
        const body = blockBody(text, start, end);
        const nonComment = nonCommentLines(body).join("\n");
        if (!nonComment.includes("{{.CLI_ARGS}}") || !nonComment.includes("uv run python"))
          continue;
        const badKeys: string[] = [];
        for (const line of nonCommentLines(body)) {
          const key = cachingKeyOnLine(line);
          if (key) badKeys.push(key);
        }
        if (badKeys.length) offenders.push(`${taskName}: ${badKeys.join(", ")}`);
      }
      expect(offenders).toEqual([]);
    });
  });
  describe("triage-summary.yml", () => {
    it("test_cli_args_tasks_declare_no_caching", () => {
      const text = readFileSync(join(repoRoot(), "tasks/triage-summary.yml"), { encoding: "utf8" });
      const offenders: string[] = [];
      for (const { name: taskName, start, end } of iterTaskBlocks(text)) {
        const body = blockBody(text, start, end);
        const nonComment = nonCommentLines(body).join("\n");
        if (!nonComment.includes("{{.CLI_ARGS}}") || !nonComment.includes("uv run python"))
          continue;
        const badKeys: string[] = [];
        for (const line of nonCommentLines(body)) {
          const key = cachingKeyOnLine(line);
          if (key) badKeys.push(key);
        }
        if (badKeys.length) offenders.push(`${taskName}: ${badKeys.join(", ")}`);
      }
      expect(offenders).toEqual([]);
    });
  });
  describe("triage-welcome.yml", () => {
    it("test_cli_args_tasks_declare_no_caching", () => {
      const text = readFileSync(join(repoRoot(), "tasks/triage-welcome.yml"), { encoding: "utf8" });
      const offenders: string[] = [];
      for (const { name: taskName, start, end } of iterTaskBlocks(text)) {
        const body = blockBody(text, start, end);
        const nonComment = nonCommentLines(body).join("\n");
        if (!nonComment.includes("{{.CLI_ARGS}}") || !nonComment.includes("uv run python"))
          continue;
        const badKeys: string[] = [];
        for (const line of nonCommentLines(body)) {
          const key = cachingKeyOnLine(line);
          if (key) badKeys.push(key);
        }
        if (badKeys.length) offenders.push(`${taskName}: ${badKeys.join(", ")}`);
      }
      expect(offenders).toEqual([]);
    });
  });
  describe("ts.yml", () => {
    it("test_cli_args_tasks_declare_no_caching", () => {
      const text = readFileSync(join(repoRoot(), "tasks/ts.yml"), { encoding: "utf8" });
      const offenders: string[] = [];
      for (const { name: taskName, start, end } of iterTaskBlocks(text)) {
        const body = blockBody(text, start, end);
        const nonComment = nonCommentLines(body).join("\n");
        if (!nonComment.includes("{{.CLI_ARGS}}") || !nonComment.includes("uv run python"))
          continue;
        const badKeys: string[] = [];
        for (const line of nonCommentLines(body)) {
          const key = cachingKeyOnLine(line);
          if (key) badKeys.push(key);
        }
        if (badKeys.length) offenders.push(`${taskName}: ${badKeys.join(", ")}`);
      }
      expect(offenders).toEqual([]);
    });
  });
  describe("vbrief.yml", () => {
    it("test_cli_args_tasks_declare_no_caching", () => {
      const text = readFileSync(join(repoRoot(), "tasks/vbrief.yml"), { encoding: "utf8" });
      const offenders: string[] = [];
      for (const { name: taskName, start, end } of iterTaskBlocks(text)) {
        const body = blockBody(text, start, end);
        const nonComment = nonCommentLines(body).join("\n");
        if (!nonComment.includes("{{.CLI_ARGS}}") || !nonComment.includes("uv run python"))
          continue;
        const badKeys: string[] = [];
        for (const line of nonCommentLines(body)) {
          const key = cachingKeyOnLine(line);
          if (key) badKeys.push(key);
        }
        if (badKeys.length) offenders.push(`${taskName}: ${badKeys.join(", ")}`);
      }
      expect(offenders).toEqual([]);
    });
  });
  describe("verify.yml", () => {
    it("test_cli_args_tasks_declare_no_caching", () => {
      const text = readFileSync(join(repoRoot(), "tasks/verify.yml"), { encoding: "utf8" });
      const offenders: string[] = [];
      for (const { name: taskName, start, end } of iterTaskBlocks(text)) {
        const body = blockBody(text, start, end);
        const nonComment = nonCommentLines(body).join("\n");
        if (!nonComment.includes("{{.CLI_ARGS}}") || !nonComment.includes("uv run python"))
          continue;
        const badKeys: string[] = [];
        for (const line of nonCommentLines(body)) {
          const key = cachingKeyOnLine(line);
          if (key) badKeys.push(key);
        }
        if (badKeys.length) offenders.push(`${taskName}: ${badKeys.join(", ")}`);
      }
      expect(offenders).toEqual([]);
    });
  });
  it.skipIf(!taskAvailable)("test_prd_render_force_overwrites_hand_authored_prd", () => {
    const fixture = mkdtempSync(join(tmpdir(), "deft-prd-render-574-"));
    try {
      mkdirSync(join(fixture, "vbrief"));
      writeFileSync(
        join(fixture, "vbrief", "specification.vbrief.json"),
        `${JSON.stringify(
          {
            vBRIEFInfo: { version: "0.6" },
            plan: {
              title: "#574 regression fixture",
              status: "draft",
              narratives: { Overview: "Throwaway fixture." },
              items: [],
            },
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      const prdPath = join(fixture, "PRD.md");
      writeFileSync(
        prdPath,
        "# Hand-authored PRD\n\nThis file was not generated by deft.\n",
        "utf8",
      );
      execFileSync(
        "task",
        ["-t", join(repoRoot(), "Taskfile.yml"), "prd:render", "--", "--force"],
        {
          cwd: fixture,
          encoding: "utf8",
          env: { ...process.env, PYTHONUTF8: "1" },
        },
      );
      const prdText = readFileSync(prdPath, { encoding: "utf8" });
      expect(prdText.split("\n")[0]).toContain("AUTO-GENERATED by task prd:render");
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});
