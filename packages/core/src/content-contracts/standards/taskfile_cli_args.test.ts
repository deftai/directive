import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { repoRoot } from "./_helpers.js";

const DOUBLE_QUOTED_CLI_ARGS = /"\s*\{\{\s*\.CLI_ARGS\s*\}\}\s*"/;

describe("test_taskfile_cli_args.py", () => {
  it("test_no_double_quoted_cli_args[architecture.yml]", () => {
    const text = readFileSync(join(repoRoot(), "tasks", "architecture.yml"), { encoding: "utf8" });
    const matches: string[] = [];
    for (const line of text.split("\n")) {
      if (line.trimStart().startsWith("#")) continue;
      if (DOUBLE_QUOTED_CLI_ARGS.test(line)) matches.push(line.trim());
    }
    expect(matches).toEqual([]);
  });
  it("test_no_double_quoted_cli_args[cache.yml]", () => {
    const text = readFileSync(join(repoRoot(), "tasks", "cache.yml"), { encoding: "utf8" });
    const matches: string[] = [];
    for (const line of text.split("\n")) {
      if (line.trimStart().startsWith("#")) continue;
      if (DOUBLE_QUOTED_CLI_ARGS.test(line)) matches.push(line.trim());
    }
    expect(matches).toEqual([]);
  });
  it("test_no_double_quoted_cli_args[capacity.yml]", () => {
    const text = readFileSync(join(repoRoot(), "tasks", "capacity.yml"), { encoding: "utf8" });
    const matches: string[] = [];
    for (const line of text.split("\n")) {
      if (line.trimStart().startsWith("#")) continue;
      if (DOUBLE_QUOTED_CLI_ARGS.test(line)) matches.push(line.trim());
    }
    expect(matches).toEqual([]);
  });
  it("test_no_double_quoted_cli_args[change.yml]", () => {
    const text = readFileSync(join(repoRoot(), "tasks", "change.yml"), { encoding: "utf8" });
    const matches: string[] = [];
    for (const line of text.split("\n")) {
      if (line.trimStart().startsWith("#")) continue;
      if (DOUBLE_QUOTED_CLI_ARGS.test(line)) matches.push(line.trim());
    }
    expect(matches).toEqual([]);
  });
  it("test_no_double_quoted_cli_args[changelog.yml]", () => {
    const text = readFileSync(join(repoRoot(), "tasks", "changelog.yml"), { encoding: "utf8" });
    const matches: string[] = [];
    for (const line of text.split("\n")) {
      if (line.trimStart().startsWith("#")) continue;
      if (DOUBLE_QUOTED_CLI_ARGS.test(line)) matches.push(line.trim());
    }
    expect(matches).toEqual([]);
  });
  it("test_no_double_quoted_cli_args[ci.yml]", () => {
    const text = readFileSync(join(repoRoot(), "tasks", "ci.yml"), { encoding: "utf8" });
    const matches: string[] = [];
    for (const line of text.split("\n")) {
      if (line.trimStart().startsWith("#")) continue;
      if (DOUBLE_QUOTED_CLI_ARGS.test(line)) matches.push(line.trim());
    }
    expect(matches).toEqual([]);
  });
  it("test_no_double_quoted_cli_args[codebase.yml]", () => {
    const text = readFileSync(join(repoRoot(), "tasks", "codebase.yml"), { encoding: "utf8" });
    const matches: string[] = [];
    for (const line of text.split("\n")) {
      if (line.trimStart().startsWith("#")) continue;
      if (DOUBLE_QUOTED_CLI_ARGS.test(line)) matches.push(line.trim());
    }
    expect(matches).toEqual([]);
  });
  it("test_no_double_quoted_cli_args[commit.yml]", () => {
    const text = readFileSync(join(repoRoot(), "tasks", "commit.yml"), { encoding: "utf8" });
    const matches: string[] = [];
    for (const line of text.split("\n")) {
      if (line.trimStart().startsWith("#")) continue;
      if (DOUBLE_QUOTED_CLI_ARGS.test(line)) matches.push(line.trim());
    }
    expect(matches).toEqual([]);
  });
  it("test_no_double_quoted_cli_args[core.yml]", () => {
    const text = readFileSync(join(repoRoot(), "tasks", "core.yml"), { encoding: "utf8" });
    const matches: string[] = [];
    for (const line of text.split("\n")) {
      if (line.trimStart().startsWith("#")) continue;
      if (DOUBLE_QUOTED_CLI_ARGS.test(line)) matches.push(line.trim());
    }
    expect(matches).toEqual([]);
  });
  it("test_no_double_quoted_cli_args[deployments.yml]", () => {
    const text = readFileSync(join(repoRoot(), "tasks", "deployments.yml"), { encoding: "utf8" });
    const matches: string[] = [];
    for (const line of text.split("\n")) {
      if (line.trimStart().startsWith("#")) continue;
      if (DOUBLE_QUOTED_CLI_ARGS.test(line)) matches.push(line.trim());
    }
    expect(matches).toEqual([]);
  });
  it("test_no_double_quoted_cli_args[framework.yml]", () => {
    const text = readFileSync(join(repoRoot(), "tasks", "framework.yml"), { encoding: "utf8" });
    const matches: string[] = [];
    for (const line of text.split("\n")) {
      if (line.trimStart().startsWith("#")) continue;
      if (DOUBLE_QUOTED_CLI_ARGS.test(line)) matches.push(line.trim());
    }
    expect(matches).toEqual([]);
  });
  it("test_no_double_quoted_cli_args[install.yml]", () => {
    const text = readFileSync(join(repoRoot(), "tasks", "install.yml"), { encoding: "utf8" });
    const matches: string[] = [];
    for (const line of text.split("\n")) {
      if (line.trimStart().startsWith("#")) continue;
      if (DOUBLE_QUOTED_CLI_ARGS.test(line)) matches.push(line.trim());
    }
    expect(matches).toEqual([]);
  });
  it("test_no_double_quoted_cli_args[issue.yml]", () => {
    const text = readFileSync(join(repoRoot(), "tasks", "issue.yml"), { encoding: "utf8" });
    const matches: string[] = [];
    for (const line of text.split("\n")) {
      if (line.trimStart().startsWith("#")) continue;
      if (DOUBLE_QUOTED_CLI_ARGS.test(line)) matches.push(line.trim());
    }
    expect(matches).toEqual([]);
  });
  it("test_no_double_quoted_cli_args[migrate.yml]", () => {
    const text = readFileSync(join(repoRoot(), "tasks", "migrate.yml"), { encoding: "utf8" });
    const matches: string[] = [];
    for (const line of text.split("\n")) {
      if (line.trimStart().startsWith("#")) continue;
      if (DOUBLE_QUOTED_CLI_ARGS.test(line)) matches.push(line.trim());
    }
    expect(matches).toEqual([]);
  });
  it("test_no_double_quoted_cli_args[packs.yml]", () => {
    const text = readFileSync(join(repoRoot(), "tasks", "packs.yml"), { encoding: "utf8" });
    const matches: string[] = [];
    for (const line of text.split("\n")) {
      if (line.trimStart().startsWith("#")) continue;
      if (DOUBLE_QUOTED_CLI_ARGS.test(line)) matches.push(line.trim());
    }
    expect(matches).toEqual([]);
  });
  it("test_no_double_quoted_cli_args[policy.yml]", () => {
    const text = readFileSync(join(repoRoot(), "tasks", "policy.yml"), { encoding: "utf8" });
    const matches: string[] = [];
    for (const line of text.split("\n")) {
      if (line.trimStart().startsWith("#")) continue;
      if (DOUBLE_QUOTED_CLI_ARGS.test(line)) matches.push(line.trim());
    }
    expect(matches).toEqual([]);
  });
  it("test_no_double_quoted_cli_args[pr.yml]", () => {
    const text = readFileSync(join(repoRoot(), "tasks", "pr.yml"), { encoding: "utf8" });
    const matches: string[] = [];
    for (const line of text.split("\n")) {
      if (line.trimStart().startsWith("#")) continue;
      if (DOUBLE_QUOTED_CLI_ARGS.test(line)) matches.push(line.trim());
    }
    expect(matches).toEqual([]);
  });
  it("test_no_double_quoted_cli_args[prd.yml]", () => {
    const text = readFileSync(join(repoRoot(), "tasks", "prd.yml"), { encoding: "utf8" });
    const matches: string[] = [];
    for (const line of text.split("\n")) {
      if (line.trimStart().startsWith("#")) continue;
      if (DOUBLE_QUOTED_CLI_ARGS.test(line)) matches.push(line.trim());
    }
    expect(matches).toEqual([]);
  });
  it("test_no_double_quoted_cli_args[project.yml]", () => {
    const text = readFileSync(join(repoRoot(), "tasks", "project.yml"), { encoding: "utf8" });
    const matches: string[] = [];
    for (const line of text.split("\n")) {
      if (line.trimStart().startsWith("#")) continue;
      if (DOUBLE_QUOTED_CLI_ARGS.test(line)) matches.push(line.trim());
    }
    expect(matches).toEqual([]);
  });
  it("test_no_double_quoted_cli_args[reconcile.yml]", () => {
    const text = readFileSync(join(repoRoot(), "tasks", "reconcile.yml"), { encoding: "utf8" });
    const matches: string[] = [];
    for (const line of text.split("\n")) {
      if (line.trimStart().startsWith("#")) continue;
      if (DOUBLE_QUOTED_CLI_ARGS.test(line)) matches.push(line.trim());
    }
    expect(matches).toEqual([]);
  });
  it("test_no_double_quoted_cli_args[relocate.yml]", () => {
    const text = readFileSync(join(repoRoot(), "tasks", "relocate.yml"), { encoding: "utf8" });
    const matches: string[] = [];
    for (const line of text.split("\n")) {
      if (line.trimStart().startsWith("#")) continue;
      if (DOUBLE_QUOTED_CLI_ARGS.test(line)) matches.push(line.trim());
    }
    expect(matches).toEqual([]);
  });
  it("test_no_double_quoted_cli_args[roadmap.yml]", () => {
    const text = readFileSync(join(repoRoot(), "tasks", "roadmap.yml"), { encoding: "utf8" });
    const matches: string[] = [];
    for (const line of text.split("\n")) {
      if (line.trimStart().startsWith("#")) continue;
      if (DOUBLE_QUOTED_CLI_ARGS.test(line)) matches.push(line.trim());
    }
    expect(matches).toEqual([]);
  });
  it("test_no_double_quoted_cli_args[scm.yml]", () => {
    const text = readFileSync(join(repoRoot(), "tasks", "scm.yml"), { encoding: "utf8" });
    const matches: string[] = [];
    for (const line of text.split("\n")) {
      if (line.trimStart().startsWith("#")) continue;
      if (DOUBLE_QUOTED_CLI_ARGS.test(line)) matches.push(line.trim());
    }
    expect(matches).toEqual([]);
  });
  it("test_no_double_quoted_cli_args[scope-undo.yml]", () => {
    const text = readFileSync(join(repoRoot(), "tasks", "scope-undo.yml"), { encoding: "utf8" });
    const matches: string[] = [];
    for (const line of text.split("\n")) {
      if (line.trimStart().startsWith("#")) continue;
      if (DOUBLE_QUOTED_CLI_ARGS.test(line)) matches.push(line.trim());
    }
    expect(matches).toEqual([]);
  });
  it("test_no_double_quoted_cli_args[scope.yml]", () => {
    const text = readFileSync(join(repoRoot(), "tasks", "scope.yml"), { encoding: "utf8" });
    const matches: string[] = [];
    for (const line of text.split("\n")) {
      if (line.trimStart().startsWith("#")) continue;
      if (DOUBLE_QUOTED_CLI_ARGS.test(line)) matches.push(line.trim());
    }
    expect(matches).toEqual([]);
  });
  it("test_no_double_quoted_cli_args[session.yml]", () => {
    const text = readFileSync(join(repoRoot(), "tasks", "session.yml"), { encoding: "utf8" });
    const matches: string[] = [];
    for (const line of text.split("\n")) {
      if (line.trimStart().startsWith("#")) continue;
      if (DOUBLE_QUOTED_CLI_ARGS.test(line)) matches.push(line.trim());
    }
    expect(matches).toEqual([]);
  });
  it("test_no_double_quoted_cli_args[setup.yml]", () => {
    const text = readFileSync(join(repoRoot(), "tasks", "setup.yml"), { encoding: "utf8" });
    const matches: string[] = [];
    for (const line of text.split("\n")) {
      if (line.trimStart().startsWith("#")) continue;
      if (DOUBLE_QUOTED_CLI_ARGS.test(line)) matches.push(line.trim());
    }
    expect(matches).toEqual([]);
  });
  it("test_no_double_quoted_cli_args[slice.yml]", () => {
    const text = readFileSync(join(repoRoot(), "tasks", "slice.yml"), { encoding: "utf8" });
    const matches: string[] = [];
    for (const line of text.split("\n")) {
      if (line.trimStart().startsWith("#")) continue;
      if (DOUBLE_QUOTED_CLI_ARGS.test(line)) matches.push(line.trim());
    }
    expect(matches).toEqual([]);
  });
  it("test_no_double_quoted_cli_args[spec.yml]", () => {
    const text = readFileSync(join(repoRoot(), "tasks", "spec.yml"), { encoding: "utf8" });
    const matches: string[] = [];
    for (const line of text.split("\n")) {
      if (line.trimStart().startsWith("#")) continue;
      if (DOUBLE_QUOTED_CLI_ARGS.test(line)) matches.push(line.trim());
    }
    expect(matches).toEqual([]);
  });
  it("test_no_double_quoted_cli_args[swarm.yml]", () => {
    const text = readFileSync(join(repoRoot(), "tasks", "swarm.yml"), { encoding: "utf8" });
    const matches: string[] = [];
    for (const line of text.split("\n")) {
      if (line.trimStart().startsWith("#")) continue;
      if (DOUBLE_QUOTED_CLI_ARGS.test(line)) matches.push(line.trim());
    }
    expect(matches).toEqual([]);
  });
  it("test_no_double_quoted_cli_args[toolchain.yml]", () => {
    const text = readFileSync(join(repoRoot(), "tasks", "toolchain.yml"), { encoding: "utf8" });
    const matches: string[] = [];
    for (const line of text.split("\n")) {
      if (line.trimStart().startsWith("#")) continue;
      if (DOUBLE_QUOTED_CLI_ARGS.test(line)) matches.push(line.trim());
    }
    expect(matches).toEqual([]);
  });
  it("test_no_double_quoted_cli_args[triage-actions.yml]", () => {
    const text = readFileSync(join(repoRoot(), "tasks", "triage-actions.yml"), {
      encoding: "utf8",
    });
    const matches: string[] = [];
    for (const line of text.split("\n")) {
      if (line.trimStart().startsWith("#")) continue;
      if (DOUBLE_QUOTED_CLI_ARGS.test(line)) matches.push(line.trim());
    }
    expect(matches).toEqual([]);
  });
  it("test_no_double_quoted_cli_args[triage-bootstrap.yml]", () => {
    const text = readFileSync(join(repoRoot(), "tasks", "triage-bootstrap.yml"), {
      encoding: "utf8",
    });
    const matches: string[] = [];
    for (const line of text.split("\n")) {
      if (line.trimStart().startsWith("#")) continue;
      if (DOUBLE_QUOTED_CLI_ARGS.test(line)) matches.push(line.trim());
    }
    expect(matches).toEqual([]);
  });
  it("test_no_double_quoted_cli_args[triage-bulk.yml]", () => {
    const text = readFileSync(join(repoRoot(), "tasks", "triage-bulk.yml"), { encoding: "utf8" });
    const matches: string[] = [];
    for (const line of text.split("\n")) {
      if (line.trimStart().startsWith("#")) continue;
      if (DOUBLE_QUOTED_CLI_ARGS.test(line)) matches.push(line.trim());
    }
    expect(matches).toEqual([]);
  });
  it("test_no_double_quoted_cli_args[triage-classify.yml]", () => {
    const text = readFileSync(join(repoRoot(), "tasks", "triage-classify.yml"), {
      encoding: "utf8",
    });
    const matches: string[] = [];
    for (const line of text.split("\n")) {
      if (line.trimStart().startsWith("#")) continue;
      if (DOUBLE_QUOTED_CLI_ARGS.test(line)) matches.push(line.trim());
    }
    expect(matches).toEqual([]);
  });
  it("test_no_double_quoted_cli_args[triage-queue.yml]", () => {
    const text = readFileSync(join(repoRoot(), "tasks", "triage-queue.yml"), { encoding: "utf8" });
    const matches: string[] = [];
    for (const line of text.split("\n")) {
      if (line.trimStart().startsWith("#")) continue;
      if (DOUBLE_QUOTED_CLI_ARGS.test(line)) matches.push(line.trim());
    }
    expect(matches).toEqual([]);
  });
  it("test_no_double_quoted_cli_args[triage-reconcile.yml]", () => {
    const text = readFileSync(join(repoRoot(), "tasks", "triage-reconcile.yml"), {
      encoding: "utf8",
    });
    const matches: string[] = [];
    for (const line of text.split("\n")) {
      if (line.trimStart().startsWith("#")) continue;
      if (DOUBLE_QUOTED_CLI_ARGS.test(line)) matches.push(line.trim());
    }
    expect(matches).toEqual([]);
  });
  it("test_no_double_quoted_cli_args[triage-scope-drift.yml]", () => {
    const text = readFileSync(join(repoRoot(), "tasks", "triage-scope-drift.yml"), {
      encoding: "utf8",
    });
    const matches: string[] = [];
    for (const line of text.split("\n")) {
      if (line.trimStart().startsWith("#")) continue;
      if (DOUBLE_QUOTED_CLI_ARGS.test(line)) matches.push(line.trim());
    }
    expect(matches).toEqual([]);
  });
  it("test_no_double_quoted_cli_args[triage-scope.yml]", () => {
    const text = readFileSync(join(repoRoot(), "tasks", "triage-scope.yml"), { encoding: "utf8" });
    const matches: string[] = [];
    for (const line of text.split("\n")) {
      if (line.trimStart().startsWith("#")) continue;
      if (DOUBLE_QUOTED_CLI_ARGS.test(line)) matches.push(line.trim());
    }
    expect(matches).toEqual([]);
  });
  it("test_no_double_quoted_cli_args[triage-smoketest.yml]", () => {
    const text = readFileSync(join(repoRoot(), "tasks", "triage-smoketest.yml"), {
      encoding: "utf8",
    });
    const matches: string[] = [];
    for (const line of text.split("\n")) {
      if (line.trimStart().startsWith("#")) continue;
      if (DOUBLE_QUOTED_CLI_ARGS.test(line)) matches.push(line.trim());
    }
    expect(matches).toEqual([]);
  });
  it("test_no_double_quoted_cli_args[triage-subscribe.yml]", () => {
    const text = readFileSync(join(repoRoot(), "tasks", "triage-subscribe.yml"), {
      encoding: "utf8",
    });
    const matches: string[] = [];
    for (const line of text.split("\n")) {
      if (line.trimStart().startsWith("#")) continue;
      if (DOUBLE_QUOTED_CLI_ARGS.test(line)) matches.push(line.trim());
    }
    expect(matches).toEqual([]);
  });
  it("test_no_double_quoted_cli_args[triage-summary.yml]", () => {
    const text = readFileSync(join(repoRoot(), "tasks", "triage-summary.yml"), {
      encoding: "utf8",
    });
    const matches: string[] = [];
    for (const line of text.split("\n")) {
      if (line.trimStart().startsWith("#")) continue;
      if (DOUBLE_QUOTED_CLI_ARGS.test(line)) matches.push(line.trim());
    }
    expect(matches).toEqual([]);
  });
  it("test_no_double_quoted_cli_args[triage-welcome.yml]", () => {
    const text = readFileSync(join(repoRoot(), "tasks", "triage-welcome.yml"), {
      encoding: "utf8",
    });
    const matches: string[] = [];
    for (const line of text.split("\n")) {
      if (line.trimStart().startsWith("#")) continue;
      if (DOUBLE_QUOTED_CLI_ARGS.test(line)) matches.push(line.trim());
    }
    expect(matches).toEqual([]);
  });
  it("test_no_double_quoted_cli_args[ts.yml]", () => {
    const text = readFileSync(join(repoRoot(), "tasks", "ts.yml"), { encoding: "utf8" });
    const matches: string[] = [];
    for (const line of text.split("\n")) {
      if (line.trimStart().startsWith("#")) continue;
      if (DOUBLE_QUOTED_CLI_ARGS.test(line)) matches.push(line.trim());
    }
    expect(matches).toEqual([]);
  });
  it("test_no_double_quoted_cli_args[vbrief.yml]", () => {
    const text = readFileSync(join(repoRoot(), "tasks", "vbrief.yml"), { encoding: "utf8" });
    const matches: string[] = [];
    for (const line of text.split("\n")) {
      if (line.trimStart().startsWith("#")) continue;
      if (DOUBLE_QUOTED_CLI_ARGS.test(line)) matches.push(line.trim());
    }
    expect(matches).toEqual([]);
  });
  it("test_no_double_quoted_cli_args[verify.yml]", () => {
    const text = readFileSync(join(repoRoot(), "tasks", "verify.yml"), { encoding: "utf8" });
    const matches: string[] = [];
    for (const line of text.split("\n")) {
      if (line.trimStart().startsWith("#")) continue;
      if (DOUBLE_QUOTED_CLI_ARGS.test(line)) matches.push(line.trim());
    }
    expect(matches).toEqual([]);
  });
});
