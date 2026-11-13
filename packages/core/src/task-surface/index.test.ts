import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { LEGACY_VBRIEF_VERSION } from "@deftai/directive-types";
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

  it("change-init scaffolds proposal and tasks at current history/changes vBRIEF version (#2524)", () => {
    const project = makeProject();
    const { io } = captureIo();
    expect(runChangeInit(project, "version-check", io)).toBe(0);
    const base = join(project, "history", "changes", "version-check");
    const proposal = JSON.parse(readFileSync(join(base, "proposal.xbrief.json"), "utf8")) as {
      vBRIEFInfo: { version: string };
    };
    const tasks = JSON.parse(readFileSync(join(base, "tasks.xbrief.json"), "utf8")) as {
      vBRIEFInfo: { version: string };
    };
    expect(proposal.vBRIEFInfo.version).toBe(LEGACY_VBRIEF_VERSION);
    expect(tasks.vBRIEFInfo.version).toBe(LEGACY_VBRIEF_VERSION);
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

  function initChangelogGit(changelog: string): string {
    const project = makeProject();
    writeFileSync(join(project, "CHANGELOG.md"), changelog, "utf8");
    execFileSync("git", ["init", "-q", "-b", "master"], { cwd: project });
    execFileSync("git", ["-c", "user.email=ci@test", "-c", "user.name=ci", "add", "CHANGELOG.md"], {
      cwd: project,
    });
    execFileSync(
      "git",
      ["-c", "user.email=ci@test", "-c", "user.name=ci", "commit", "-q", "-m", "init changelog"],
      { cwd: project },
    );
    execFileSync("git", ["update-ref", "refs/remotes/origin/master", "HEAD"], { cwd: project });
    return project;
  }

  function commitFile(project: string, rel: string, contents: string, message: string): void {
    writeFileSync(join(project, rel), contents, "utf8");
    execFileSync("git", ["-c", "user.email=ci@test", "-c", "user.name=ci", "add", rel], {
      cwd: project,
    });
    execFileSync(
      "git",
      ["-c", "user.email=ci@test", "-c", "user.name=ci", "commit", "-q", "-m", message],
      { cwd: project },
    );
  }

  it("against-merge-base fails when Unreleased - set is unchanged vs merge-base (#633)", () => {
    const existing = "## [Unreleased]\n\n- pre-existing\n\n## [0.1.0]\n";
    const project = initChangelogGit(existing);
    execFileSync("git", ["checkout", "-q", "-b", "feat"], { cwd: project });
    commitFile(project, "README.md", "no changelog\n", "feat: other change");
    const { lines, io } = captureIo();
    expect(runChangelogCheck(project, io, { againstMergeBase: true })).toBe(1);
    expect(lines.join("")).toContain('no new "- " entries versus merge-base');
  });

  it("against-merge-base passes when a - bullet is added vs merge-base (#633)", () => {
    const existing = "## [Unreleased]\n\n- pre-existing\n\n## [0.1.0]\n";
    const project = initChangelogGit(existing);
    execFileSync("git", ["checkout", "-q", "-b", "feat"], { cwd: project });
    commitFile(project, "README.md", "no changelog\n", "feat: other change");
    writeFileSync(
      join(project, "CHANGELOG.md"),
      "## [Unreleased]\n\n- pre-existing\n- added this PR\n\n## [0.1.0]\n",
      "utf8",
    );
    const { lines, io } = captureIo();
    expect(runChangelogCheck(project, io, { againstMergeBase: true })).toBe(0);
    expect(lines.join("")).toContain("2 entries");
  });

  it("changelog-check without --against-merge-base stays presence-only (#633)", () => {
    const existing = "## [Unreleased]\n\n- pre-existing\n\n## [0.1.0]\n";
    const project = initChangelogGit(existing);
    execFileSync("git", ["checkout", "-q", "-b", "feat"], { cwd: project });
    commitFile(project, "README.md", "no changelog\n", "feat: other change");
    const { lines, io } = captureIo();
    expect(runChangelogCheck(project, io)).toBe(0);
    expect(lines.join("")).toContain("1 entries");
  });

  it("against-merge-base skips added-bullet when HEAD equals merge-base", () => {
    const existing = "## [Unreleased]\n\n- pre-existing\n\n## [0.1.0]\n";
    const project = initChangelogGit(existing);
    const { lines, io } = captureIo();
    expect(runChangelogCheck(project, io, { againstMergeBase: true })).toBe(0);
    expect(lines.join("")).toContain("1 entries");
  });

  it("against-merge-base is config-fail when merge-base cannot be resolved", () => {
    const project = makeProject();
    writeFileSync(
      join(project, "CHANGELOG.md"),
      "## [Unreleased]\n\n- added thing\n\n## [0.1.0]\n",
      "utf8",
    );
    execFileSync("git", ["init", "-q"], { cwd: project });
    execFileSync("git", ["-c", "user.email=ci@test", "-c", "user.name=ci", "add", "CHANGELOG.md"], {
      cwd: project,
    });
    execFileSync(
      "git",
      ["-c", "user.email=ci@test", "-c", "user.name=ci", "commit", "-q", "-m", "init"],
      { cwd: project },
    );
    const { lines, io } = captureIo();
    expect(runChangelogCheck(project, io, { againstMergeBase: true })).toBe(2);
    expect(lines.join("")).toContain("no merge-base");
  });

  function commitNested(project: string, rel: string, contents: string): void {
    mkdirSync(dirname(join(project, rel)), { recursive: true });
    commitFile(project, rel, contents, `chore: ${rel}`);
  }

  it("against-merge-base exempts a delivery-brief-land change set from the new entry (#680 P4)", () => {
    const existing = "## [Unreleased]\n\n- pre-existing\n\n## [0.1.0]\n";
    const project = initChangelogGit(existing);
    execFileSync("git", ["checkout", "-q", "-b", "lifecycle"], { cwd: project });
    commitNested(project, "xbrief/completed/story.xbrief.json", "{}\n");
    commitNested(project, "xbrief/.audit/spec-drift-ledger.json", "{}\n");
    const { lines, io } = captureIo();
    expect(runChangelogCheck(project, io, { againstMergeBase: true })).toBe(0);
    expect(lines.join("")).toContain("1 entries");
  });

  it("against-merge-base keeps the new entry for a brief plus product change (#680 P4)", () => {
    const existing = "## [Unreleased]\n\n- pre-existing\n\n## [0.1.0]\n";
    const project = initChangelogGit(existing);
    execFileSync("git", ["checkout", "-q", "-b", "mixed"], { cwd: project });
    commitNested(project, "xbrief/active/story.xbrief.json", "{}\n");
    commitNested(project, "packages/core/src/x.ts", "export {};\n");
    const { lines, io } = captureIo();
    expect(runChangelogCheck(project, io, { againstMergeBase: true })).toBe(1);
    expect(lines.join("")).toContain('no new "- " entries versus merge-base');
  });

  it("against-merge-base does not exempt a brief renamed in from a product path (#680 P4)", () => {
    const existing = "## [Unreleased]\n\n- pre-existing\n\n## [0.1.0]\n";
    const project = initChangelogGit(existing);
    commitNested(project, "docs/story.xbrief.json", "{}\n");
    execFileSync("git", ["update-ref", "refs/remotes/origin/master", "HEAD"], { cwd: project });
    execFileSync("git", ["checkout", "-q", "-b", "rename"], { cwd: project });
    mkdirSync(join(project, "xbrief", "active"), { recursive: true });
    execFileSync("git", ["mv", "docs/story.xbrief.json", "xbrief/active/story.xbrief.json"], {
      cwd: project,
    });
    execFileSync(
      "git",
      ["-c", "user.email=ci@test", "-c", "user.name=ci", "commit", "-q", "-m", "mv"],
      { cwd: project },
    );
    const { io } = captureIo();
    expect(runChangelogCheck(project, io, { againstMergeBase: true })).toBe(1);
  });

  it("against-merge-base keeps the new entry for an empty change set (#680 P4)", () => {
    const existing = "## [Unreleased]\n\n- pre-existing\n\n## [0.1.0]\n";
    const project = initChangelogGit(existing);
    execFileSync("git", ["checkout", "-q", "-b", "empty"], { cwd: project });
    execFileSync(
      "git",
      [
        "-c",
        "user.email=ci@test",
        "-c",
        "user.name=ci",
        "commit",
        "-q",
        "--allow-empty",
        "-m",
        "e",
      ],
      { cwd: project },
    );
    const { lines, io } = captureIo();
    expect(runChangelogCheck(project, io, { againstMergeBase: true })).toBe(1);
    expect(lines.join("")).toContain('no new "- " entries versus merge-base');
  });

  it("against-merge-base passes a lifecycle-only set after a release empties Unreleased (#680 P4)", () => {
    const released = "## [Unreleased]\n\n## [0.2.0]\n\n- shipped\n";
    const project = initChangelogGit(released);
    execFileSync("git", ["checkout", "-q", "-b", "post-release"], { cwd: project });
    commitNested(project, "xbrief/active/story.xbrief.json", "{}\n");
    const { lines, io } = captureIo();
    expect(runChangelogCheck(project, io, { againstMergeBase: true })).toBe(0);
    expect(lines.join("")).toContain("lifecycle-only change set needs none");
    // Presence-only mode is unchanged: an empty section still fails.
    const presence = captureIo();
    expect(runChangelogCheck(project, presence.io)).toBe(1);
  });

  it("against-merge-base still fails a product change after a release empties Unreleased (#680 P4)", () => {
    const released = "## [Unreleased]\n\n## [0.2.0]\n\n- shipped\n";
    const project = initChangelogGit(released);
    execFileSync("git", ["checkout", "-q", "-b", "post-release-product"], { cwd: project });
    commitNested(project, "packages/core/src/x.ts", "export {};\n");
    const { lines, io } = captureIo();
    expect(runChangelogCheck(project, io, { againstMergeBase: true })).toBe(1);
    expect(lines.join("")).toContain("has no entries");
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

const itSymlink = it.skipIf(process.platform === "win32");

describe("task-surface symlink containment (#2807)", () => {
  itSymlink("install-uninstall refuses AGENTS.md symlink escape before rewrite", () => {
    const project = makeProject();
    const escapeDir = mkdtempSync(join(tmpdir(), "deft-task-surface-agents-victim-"));
    const victim = join(escapeDir, "AGENTS.md");
    writeFileSync(victim, "See deft/main.md for guidelines\nKeep me\n", "utf8");
    symlinkSync(victim, join(project, "AGENTS.md"));
    const { lines, io } = captureIo();
    expect(runInstallUninstall(project, io)).toBe(2);
    expect(lines.join("")).toMatch(/projection write refused|symlink/);
    expect(readFileSync(victim, "utf8")).toBe("See deft/main.md for guidelines\nKeep me\n");
    rmSync(escapeDir, { recursive: true, force: true });
  });

  itSymlink("change-init refuses history/ directory symlink escape before materialization", () => {
    const project = makeProject();
    const escapeDir = mkdtempSync(join(tmpdir(), "deft-task-surface-history-victim-"));
    symlinkSync(escapeDir, join(project, "history"), "dir");
    const { lines, io } = captureIo();
    expect(runChangeInit(project, "symlink-escape", io)).toBe(2);
    expect(lines.join("")).toMatch(/projection write refused|symlink escaping/);
    expect(existsSync(join(escapeDir, "changes", "symlink-escape"))).toBe(false);
    rmSync(escapeDir, { recursive: true, force: true });
  });
});
