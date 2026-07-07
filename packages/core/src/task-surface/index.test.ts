import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runChangeInit, runChangelogCheck, runCommitLint, runInstallUninstall } from "./index.js";

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeProject(): string {
  const base = mkdtempSync(join(tmpdir(), "deft-task-surface-"));
  temps.push(base);
  return base;
}

function initGitRepo(project: string, message: string): void {
  writeFileSync(join(project, "README.md"), "seed\n", "utf8");
  execFileSync("git", ["init", "-q"], { cwd: project });
  execFileSync("git", ["-c", "user.email=ci@test", "-c", "user.name=ci", "add", "-A"], {
    cwd: project,
  });
  execFileSync(
    "git",
    ["-c", "user.email=ci@test", "-c", "user.name=ci", "commit", "-q", "-m", message],
    { cwd: project },
  );
}

function captureIo(): {
  lines: string[];
  io: { writeOut: (t: string) => void; writeErr: (t: string) => void };
} {
  const lines: string[] = [];
  return {
    lines,
    io: {
      writeOut: (text) => {
        lines.push(text);
      },
      writeErr: (text) => {
        lines.push(text);
      },
    },
  };
}

describe("task-surface", () => {
  it("changelog-check passes with unreleased entries", () => {
    const project = makeProject();
    writeFileSync(
      join(project, "CHANGELOG.md"),
      "## [Unreleased]\n\n- Added thing\n\n## [0.1.0]\n",
      "utf8",
    );
    const { lines, io } = captureIo();
    expect(runChangelogCheck(project, io)).toBe(0);
    expect(lines.join("")).toContain("1 entries");
  });

  it("changelog-check passes on a CRLF working tree (#2329)", () => {
    // Windows checkouts with core.autocrlf=true yield a CRLF working tree.
    // Before #2329 the `[ \t]*\n` header pattern did not consume the `\r`,
    // so a valid section false-failed as "No [Unreleased] section found".
    const project = makeProject();
    writeFileSync(
      join(project, "CHANGELOG.md"),
      "## [Unreleased]\r\n\r\n- Added thing\r\n\r\n## [0.1.0]\r\n",
      "utf8",
    );
    const { lines, io } = captureIo();
    expect(runChangelogCheck(project, io)).toBe(0);
    expect(lines.join("")).toContain("1 entries");
  });

  it("changelog-check fails when changelog is missing", () => {
    const project = makeProject();
    const { lines, io } = captureIo();
    expect(runChangelogCheck(project, io)).toBe(1);
    expect(lines.join("")).toContain("not found");
  });

  it("change-init creates proposal scaffold", () => {
    const project = makeProject();
    const { lines, io } = captureIo();
    expect(runChangeInit(project, "my-change", io)).toBe(0);
    expect(
      existsSync(join(project, "history", "changes", "my-change", "proposal.xbrief.json")),
    ).toBe(true);
    expect(lines.join("")).toContain("OK: Created change proposal");
  });

  it("change-init rejects invalid names", () => {
    const project = makeProject();
    const { io } = captureIo();
    expect(runChangeInit(project, "bad name", io)).toBe(1);
  });

  it("commit-lint accepts conventional commits", () => {
    const project = makeProject();
    initGitRepo(project, "feat(scope): add thing");
    const { lines, io } = captureIo();
    expect(runCommitLint(project, io)).toBe(0);
    expect(lines.join("")).toContain("valid conventional commit");
  });

  it("commit-lint rejects invalid subject", () => {
    const project = makeProject();
    initGitRepo(project, "not conventional");
    const { io } = captureIo();
    expect(runCommitLint(project, io)).toBe(1);
  });

  it("changelog-check fails when unreleased section is empty", () => {
    const project = makeProject();
    writeFileSync(
      join(project, "CHANGELOG.md"),
      "## [Unreleased]\n\n### Added\n\n## [0.1.0]\n",
      "utf8",
    );
    const { io } = captureIo();
    expect(runChangelogCheck(project, io)).toBe(1);
  });

  it("change-init rejects duplicate directory", () => {
    const project = makeProject();
    const { io } = captureIo();
    expect(runChangeInit(project, "dup", io)).toBe(0);
    expect(runChangeInit(project, "dup", io)).toBe(1);
  });

  it("change-init rejects empty name", () => {
    const project = makeProject();
    const { io } = captureIo();
    expect(runChangeInit(project, "   ", io)).toBe(1);
  });

  it("install-uninstall is noop when AGENTS.md is missing", () => {
    const project = makeProject();
    const { lines, io } = captureIo();
    expect(runInstallUninstall(project, io)).toBe(0);
    expect(lines.join("")).toContain("No deft entry found");
  });

  it("install-uninstall strips legacy deft lines", () => {
    const project = makeProject();
    writeFileSync(
      join(project, "AGENTS.md"),
      "See deft/main.md for guidelines\nKeep me\nSkills: deft/skills/foo\n",
      "utf8",
    );
    const { lines, io } = captureIo();
    expect(runInstallUninstall(project, io)).toBe(0);
    expect(readFileSync(join(project, "AGENTS.md"), "utf8")).toBe("Keep me\n");
    expect(lines.join("")).toContain("Removed deft entry");
  });
});
