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
import { mergeFragmentsIntoChangelogText } from "../changelog/effective-unreleased.js";
import { evaluateChangelogGate, readChangelogFragments } from "../changelog/fragment.js";
import { releaseLine } from "../changelog/release-line.js";
import { promoteChangelog } from "../release/changelog.js";
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

  it("against-merge-base exempts a completion whose only non-brief paths are row files (#6335)", () => {
    const existing = "## [Unreleased]\n\n- pre-existing\n\n## [0.1.0]\n";
    const project = initChangelogGit(existing);
    execFileSync("git", ["checkout", "-q", "-b", "lifecycle-rows"], { cwd: project });
    commitNested(project, "xbrief/completed/story.xbrief.json", "{}\n");
    commitNested(project, "xbrief/.audit/spec-drift/story.json", "{}\n");
    const { io } = captureIo();
    expect(runChangelogCheck(project, io, { againstMergeBase: true })).toBe(0);
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

describe("change:changelog:check effective view (#6314)", () => {
  function withFragments(changelog: string, fragments: Record<string, string>): string {
    const project = makeProject();
    writeFileSync(join(project, "CHANGELOG.md"), changelog, "utf8");
    mkdirSync(join(project, "changelog.d"));
    for (const [name, text] of Object.entries(fragments)) {
      writeFileSync(join(project, "changelog.d", name), text, "utf8");
    }
    return project;
  }

  it("counts valid fragment entries with [Unreleased] lines", () => {
    const project = withFragments("## [Unreleased]\n\n- Inline\n\n## [0.1.0]\n", {
      "6314-a.md": "section: Added\n- Frag one\n- Frag two\n",
      "6315-b.md": "section: Fixed\n- Frag three\n",
    });
    const { lines, io } = captureIo();
    expect(runChangelogCheck(project, io)).toBe(0);
    expect(lines.join("")).toContain("4 entries (1 in CHANGELOG.md, 3 in changelog.d/)");
  });

  it("passes on fragments alone and warns on an invalid fragment", () => {
    const project = withFragments("## [Unreleased]\n\n### Added\n\n## [0.1.0]\n", {
      "6314-a.md": "section: Added\n- Frag one\n",
      "6316-bad.md": "section: Notes\n- x\n",
    });
    const { lines, io } = captureIo();
    expect(runChangelogCheck(project, io)).toBe(0);
    const out = lines.join("");
    expect(out).toContain("WARN: ignoring invalid changelog fragment changelog.d/6316-bad.md");
    expect(out).toContain("1 entries (0 in CHANGELOG.md, 1 in changelog.d/)");
  });

  it("still fails when only invalid fragments exist", () => {
    const project = withFragments("## [Unreleased]\n\n## [0.1.0]\n", {
      "6316-bad.md": "",
    });
    const { lines, io } = captureIo();
    expect(runChangelogCheck(project, io)).toBe(1);
    expect(lines.join("")).toContain("has no entries");
  });
});

describe("verify:changelog-unreleased fragment gate (#6315 / #6286 item 4)", () => {
  const BASE_CHANGELOG = "## [Unreleased]\n\n### Added\n\n- pre-existing\n\n## [0.1.0]\n";
  const OTHER_FRAGMENT = "section: Fixed\n- fix from another change (#10)\n";
  const OWN_FRAGMENT = "section: Added\n- this change (#20)\n";

  function git(project: string, args: string[]): void {
    execFileSync("git", ["-c", "user.email=ci@test", "-c", "user.name=ci", ...args], {
      cwd: project,
    });
  }

  function put(project: string, rel: string, contents: string): void {
    mkdirSync(dirname(join(project, rel)), { recursive: true });
    writeFileSync(join(project, rel), contents, "utf8");
  }

  function commitAll(project: string, message: string): void {
    git(project, ["add", "-A"]);
    git(project, ["commit", "-q", "--allow-empty", "-m", message]);
  }

  /** master holds CHANGELOG.md, the mode and another change's fragment; HEAD is a branch. */
  function seed(mode: "inline" | "either" | "fragments"): string {
    const project = makeProject();
    put(project, "CHANGELOG.md", BASE_CHANGELOG);
    put(
      project,
      "xbrief/PROJECT-DEFINITION.xbrief.json",
      JSON.stringify({
        xBRIEFInfo: { version: "0.8" },
        plan: {
          title: "T",
          status: "running",
          items: [],
          "x-directive/policy": { changelog: { mode } },
        },
      }),
    );
    put(project, "changelog.d/10-other-fix.md", OTHER_FRAGMENT);
    execFileSync("git", ["init", "-q", "-b", "master"], { cwd: project });
    commitAll(project, "init");
    execFileSync("git", ["update-ref", "refs/remotes/origin/master", "HEAD"], { cwd: project });
    execFileSync("git", ["checkout", "-q", "-b", "feat"], { cwd: project });
    return project;
  }

  function check(project: string): { code: number; out: string } {
    const { lines, io } = captureIo();
    const code = runChangelogCheck(project, io, { againstMergeBase: true });
    return { code, out: lines.join("") };
  }

  it("fragments: other changes' fragments on the branch never satisfy it; an own fragment does", () => {
    const project = seed("fragments");
    put(project, "src/x.ts", "export {};\n");
    commitAll(project, "feat: product only");
    const without = check(project);
    expect(without.code).toBe(1);
    expect(without.out).toContain("adds no changelog.d/<issue>-<slug>.md fragment");
    expect(without.out).toContain("changelog mode: fragments");

    put(project, "changelog.d/20-own-change.md", OWN_FRAGMENT);
    put(project, "src/x.ts", "export {};\n");
    commitAll(project, "feat: own fragment");
    const withOwn = check(project);
    expect(withOwn.code).toBe(0);
    expect(withOwn.out).toContain("in changelog.d/");
  });

  it("fragments: a fragment merged from master after branching still does not count", () => {
    const project = seed("fragments");
    execFileSync("git", ["checkout", "-q", "master"], { cwd: project });
    put(project, "changelog.d/11-later.md", "section: Changed\n- later change (#11)\n");
    commitAll(project, "later change");
    execFileSync("git", ["update-ref", "refs/remotes/origin/master", "HEAD"], { cwd: project });
    execFileSync("git", ["checkout", "-q", "feat"], { cwd: project });
    put(project, "src/x.ts", "export {};\n");
    commitAll(project, "feat: product");
    git(project, ["merge", "-q", "--no-edit", "master"]);
    expect(check(project).code).toBe(1);
  });

  it("fragments: an own fragment plus any edit to CHANGELOG.md fails", () => {
    const project = seed("fragments");
    put(project, "changelog.d/20-own-change.md", OWN_FRAGMENT);
    put(project, "CHANGELOG.md", BASE_CHANGELOG.replace("pre-existing", "pre-existing, reworded"));
    put(project, "src/x.ts", "export {};\n");
    commitAll(project, "feat: fragment plus changelog edit");
    const result = check(project);
    expect(result.code).toBe(1);
    expect(result.out).toContain("changes CHANGELOG.md");
  });

  it("fragments: an inline line alone fails", () => {
    const project = seed("fragments");
    put(
      project,
      "CHANGELOG.md",
      BASE_CHANGELOG.replace("- pre-existing", "- pre-existing\n- mine"),
    );
    put(project, "src/x.ts", "export {};\n");
    commitAll(project, "feat: inline");
    expect(check(project).code).toBe(1);
  });

  const INLINE_LINE = BASE_CHANGELOG.replace("- pre-existing", "- pre-existing\n- mine");
  const eitherCases: readonly [string, boolean, boolean, number, string][] = [
    ["both forms fail", true, true, 1, "in either mode add exactly one"],
    ["a fragment alone passes", true, false, 0, "in changelog.d/"],
    ["an inline line alone passes", false, true, 0, "2 in CHANGELOG.md"],
    ["neither form fails", false, false, 1, "adds neither"],
  ];
  for (const [name, fragment, inline, code, text] of eitherCases) {
    it(`either: ${name}`, () => {
      const project = seed("either");
      if (fragment) put(project, "changelog.d/20-own-change.md", OWN_FRAGMENT);
      if (inline) put(project, "CHANGELOG.md", INLINE_LINE);
      put(project, "src/x.ts", "export {};\n");
      commitAll(project, "feat: either case");
      const result = check(project);
      expect(result.code).toBe(code);
      expect(result.out).toContain(text);
    });
  }

  it("inline: a fragment does not replace the line (today's behaviour)", () => {
    const project = seed("inline");
    put(project, "changelog.d/20-own-change.md", OWN_FRAGMENT);
    put(project, "src/x.ts", "export {};\n");
    commitAll(project, "feat: fragment in inline mode");
    const result = check(project);
    expect(result.code).toBe(1);
    expect(result.out).toContain('no new "- " entries versus merge-base');
  });

  const inheritedEdits: readonly [string, (project: string) => void][] = [
    [
      "modifying",
      (p) => put(p, "changelog.d/10-other-fix.md", "section: Fixed\n- reworded (#10)\n"),
    ],
    ["renaming", (p) => git(p, ["mv", "changelog.d/10-other-fix.md", "changelog.d/10-renamed.md"])],
    ["deleting", (p) => git(p, ["rm", "-q", "changelog.d/10-other-fix.md"])],
  ];
  for (const [name, edit] of inheritedEdits) {
    it(`fragments: ${name} a merge-base fragment fails even with a valid own fragment`, () => {
      const project = seed("fragments");
      put(project, "changelog.d/20-own-change.md", OWN_FRAGMENT);
      edit(project);
      put(project, "src/x.ts", "export {};\n");
      commitAll(project, "feat: touch an inherited fragment");
      const result = check(project);
      expect(result.code).toBe(1);
      expect(result.out).toContain("a fragment present at the merge base");
    });
  }

  it("inline: deleting a merge-base fragment fails even with a new line", () => {
    const project = seed("inline");
    put(
      project,
      "CHANGELOG.md",
      BASE_CHANGELOG.replace("- pre-existing", "- pre-existing\n- mine"),
    );
    git(project, ["rm", "-q", "changelog.d/10-other-fix.md"]);
    put(project, "src/x.ts", "export {};\n");
    commitAll(project, "feat: delete an inherited fragment");
    const result = check(project);
    expect(result.code).toBe(1);
    expect(result.out).toContain("deletes or renames changelog.d/10-other-fix.md");
  });

  for (const mode of ["inline", "either", "fragments"] as const) {
    it(`${mode}: an invalid added fragment fails`, () => {
      const project = seed(mode);
      put(project, "changelog.d/20-own-change.md", OWN_FRAGMENT);
      put(project, "changelog.d/21-bad.md", "section: Nonsense\n- x\n");
      put(project, "src/x.ts", "export {};\n");
      commitAll(project, "feat: invalid fragment");
      const result = check(project);
      expect(result.code).toBe(1);
      expect(result.out).toContain("invalid changelog fragment changelog.d/21-bad.md");
    });
  }

  it("a lifecycle-only change set stays exempt in fragments mode (#680)", () => {
    const project = seed("fragments");
    put(project, "xbrief/completed/story.xbrief.json", "{}\n");
    commitAll(project, "chore: lifecycle");
    const result = check(project);
    expect(result.code).toBe(0);
  });

  it("a lifecycle-only change set after a release stays exempt (#680)", () => {
    const project = makeProject();
    put(project, "CHANGELOG.md", "## [Unreleased]\n\n## [0.2.0]\n\n- shipped\n");
    put(
      project,
      "xbrief/PROJECT-DEFINITION.xbrief.json",
      JSON.stringify({
        xBRIEFInfo: { version: "0.8" },
        plan: {
          title: "T",
          status: "running",
          items: [],
          "x-directive/policy": { changelog: { mode: "fragments" } },
        },
      }),
    );
    execFileSync("git", ["init", "-q", "-b", "master"], { cwd: project });
    commitAll(project, "init");
    execFileSync("git", ["update-ref", "refs/remotes/origin/master", "HEAD"], { cwd: project });
    execFileSync("git", ["checkout", "-q", "-b", "life"], { cwd: project });
    put(project, "xbrief/completed/story.xbrief.json", "{}\n");
    commitAll(project, "chore: lifecycle");
    const result = check(project);
    expect(result.code).toBe(0);
    expect(result.out).toContain("lifecycle-only change set needs none");
  });

  it("a malformed mode reads as inline with a warning", () => {
    const project = seed("inline");
    put(
      project,
      "xbrief/PROJECT-DEFINITION.xbrief.json",
      JSON.stringify({
        xBRIEFInfo: { version: "0.8" },
        plan: {
          title: "T",
          status: "running",
          items: [],
          "x-directive/policy": { changelog: { mode: "sometimes" } },
        },
      }),
    );
    put(
      project,
      "CHANGELOG.md",
      BASE_CHANGELOG.replace("- pre-existing", "- pre-existing\n- mine"),
    );
    put(project, "src/x.ts", "export {};\n");
    commitAll(project, "feat: inline");
    const result = check(project);
    expect(result.code).toBe(0);
    expect(result.out).toContain("reading changelog mode as inline");
  });
});

describe("evaluateChangelogGate (pure, #6315)", () => {
  const valid = (path: string) => ({ path, section: "Added" as const, entries: [`- ${path}`] });

  for (const mode of ["inline", "either", "fragments"] as const) {
    it(`${mode}: a changed, renamed or deleted merge-base fragment fails in every mode`, () => {
      for (const status of ["M", "D"]) {
        const result = evaluateChangelogGate({
          mode,
          changeSet: [
            { status: "A", path: "changelog.d/20-own.md" },
            { status, path: "changelog.d/10-old.md" },
          ],
          changelogChanged: mode === "inline",
          addedInlineEntries: mode === "inline" ? 1 : 0,
          readFragment: valid,
        });
        expect(result.ok).toBe(false);
        expect(result.problems[0]).toContain("changelog.d/10-old.md");
      }
    });
  }

  it("either: exactly one form passes; both or neither fail", () => {
    const run = (fragment: boolean, inline: number) =>
      evaluateChangelogGate({
        mode: "either",
        changeSet: fragment ? [{ status: "A", path: "changelog.d/20-own.md" }] : [],
        changelogChanged: inline > 0,
        addedInlineEntries: inline,
        readFragment: valid,
      }).ok;
    expect(run(true, 0)).toBe(true);
    expect(run(false, 1)).toBe(true);
    expect(run(true, 1)).toBe(false);
    expect(run(false, 0)).toBe(false);
  });

  it("reports a type change of a merge-base fragment as a modification", () => {
    const result = evaluateChangelogGate({
      mode: "fragments",
      changeSet: [{ status: "T", path: "changelog.d/1-a.md" }],
      changelogChanged: false,
      addedInlineEntries: 0,
      readFragment: valid,
    });
    expect(result.ok).toBe(false);
    expect(result.problems[0]).toContain("modifies changelog.d/1-a.md");
  });

  it("ignores non-fragment paths under changelog.d/ and sorts added fragments", () => {
    const result = evaluateChangelogGate({
      mode: "fragments",
      changeSet: [
        { status: "A", path: "changelog.d/9-b.md" },
        { status: "A", path: "changelog.d/README.MD" },
        { status: "A", path: "changelog.d/2-a.md" },
      ],
      changelogChanged: false,
      addedInlineEntries: 0,
      readFragment: valid,
    });
    expect(result.ok).toBe(true);
    expect(result.addedFragments.map((f) => f.path)).toEqual([
      "changelog.d/2-a.md",
      "changelog.d/9-b.md",
    ]);
  });
});

describe("verify:changelog-unreleased release rule (#6296)", () => {
  const V = "0.2.0";
  const LINK_FOOTER =
    "[Unreleased]: https://github.com/o/r/compare/v0.1.0...HEAD\n" +
    "[0.1.0]: https://github.com/o/r/releases/tag/v0.1.0\n";
  const BASE =
    "# Changelog\n\n## [Unreleased]\n\n- [release-line] v0.1.0\n\n### Added\n\n" +
    "- inline note (#1)\n\n  continued after a blank line\n\n### Fixed\n\n" +
    "## [0.1.0] - 2026-01-01\n\n### Added\n- old entry (#0)\n\n" +
    LINK_FOOTER;

  function git(project: string, args: string[]): string {
    return execFileSync("git", ["-c", "user.email=ci@test", "-c", "user.name=ci", ...args], {
      cwd: project,
      encoding: "utf8",
    });
  }

  function put(project: string, rel: string, contents: string): void {
    mkdirSync(dirname(join(project, rel)), { recursive: true });
    writeFileSync(join(project, rel), contents, "utf8");
  }

  function commitAll(project: string, message: string): void {
    git(project, ["add", "-A"]);
    git(project, ["commit", "-q", "--allow-empty", "-m", message]);
  }

  /** master holds CHANGELOG.md, ROADMAP.md and `fragments`; HEAD is release/v0.2.0. */
  function seed(fragments: Record<string, string> = {}, changelog = BASE): string {
    const project = makeProject();
    put(project, "CHANGELOG.md", changelog);
    put(project, "ROADMAP.md", "# Roadmap\n");
    for (const [name, text] of Object.entries(fragments)) put(project, `changelog.d/${name}`, text);
    execFileSync("git", ["init", "-q", "-b", "master"], { cwd: project });
    git(project, ["config", "core.autocrlf", "false"]);
    commitAll(project, "init");
    execFileSync("git", ["update-ref", "refs/remotes/origin/master", "HEAD"], { cwd: project });
    execFileSync("git", ["checkout", "-q", "-b", `release/v${V}`], { cwd: project });
    return project;
  }

  /** The release change the cut makes: promote with fragments, delete them, rewrite ROADMAP. */
  function cutText(project: string): string {
    const set = readChangelogFragments(project);
    const text = readFileSync(join(project, "CHANGELOG.md"), "utf8");
    return promoteChangelog(
      mergeFragmentsIntoChangelogText(text, set.valid),
      V,
      "o/r",
      "2026-02-01",
    );
  }

  function cut(project: string, edit: (text: string) => string = (t) => t): void {
    const promoted = edit(cutText(project));
    for (const fragment of readChangelogFragments(project).valid) {
      rmSync(join(project, fragment.path));
    }
    put(project, "CHANGELOG.md", promoted);
    put(project, "ROADMAP.md", `# Roadmap\n\n## v${V}\n`);
    commitAll(project, `chore(release): v${V}`);
  }

  function check(project: string): { code: number; out: string } {
    const { lines, io } = captureIo();
    const code = runChangelogCheck(project, io, { againstMergeBase: true });
    return { code, out: lines.join("") };
  }

  const FRAGMENT_A = "section: Added\n- fragment a (#20)\n";
  const FRAGMENT_B = "section: Fixed\n- fragment b (#30)\n  with a continuation line\n";

  it("passes the release PR made by the cut with deleted fragments (merge-base mode)", () => {
    const project = seed({ "20-a.md": FRAGMENT_A, "30-b.md": FRAGMENT_B });
    cut(project);
    const result = check(project);
    expect(result.out).toContain(`OK: release change set for v${V} passes the release rule`);
    expect(result.code).toBe(0);
  });

  it("passes the release PR made by the cut with no fragment and inline entries", () => {
    const project = seed();
    cut(project);
    expect(check(project).code).toBe(0);
  });

  it("fails when a fragment another PR merged to the base after the cut is in the tree, and names it", () => {
    const project = seed({ "20-a.md": FRAGMENT_A });
    cut(project);
    git(project, ["checkout", "-q", "master"]);
    put(project, "changelog.d/40-late.md", "section: Changed\n- landed ahead (#40)\n");
    commitAll(project, "late change");
    execFileSync("git", ["update-ref", "refs/remotes/origin/master", "HEAD"], { cwd: project });
    git(project, ["checkout", "-q", `release/v${V}`]);
    git(project, ["merge", "-q", "--no-edit", "master"]);
    const result = check(project);
    expect(result.code).toBe(1);
    expect(result.out).toContain("changelog.d/40-late.md");
  });

  it("fails a release line and heading that leave another entry under [Unreleased]", () => {
    const project = seed();
    cut(project, (t) => t.replace(releaseLine(V), `${releaseLine(V)}\n- left behind (#9)`));
    const result = check(project);
    expect(result.code).toBe(1);
    expect(result.out).toContain("must hold only the release line");
  });

  it("fails a release attempt that drops a continuation line after a blank line", () => {
    const project = seed();
    cut(project, (t) => t.replace("\n  continued after a blank line\n", "\n"));
    const result = check(project);
    expect(result.code).toBe(1);
    expect(result.out).toContain("continued after a blank line");
  });

  it("fails a release attempt that changes a line of an older version section", () => {
    const project = seed();
    cut(project, (t) => t.replace("- old entry (#0)", "- old entry, reworded (#0)"));
    const result = check(project);
    expect(result.code).toBe(1);
    expect(result.out).toContain("missing at HEAD");
  });

  it("fails a change set that removes a version heading and its release line and adds none", () => {
    const project = seed();
    put(
      project,
      "CHANGELOG.md",
      BASE.replace("- [release-line] v0.1.0\n\n", "").replace(
        "## [0.1.0] - 2026-01-01\n\n### Added\n- old entry (#0)\n\n",
        "",
      ),
    );
    commitAll(project, "revert release");
    const result = check(project);
    expect(result.code).toBe(1);
    expect(result.out).toContain("removes or changes the release line");
  });

  it("fails a release attempt that removes an inline [Unreleased] entry from both sections", () => {
    const project = seed();
    cut(project, (t) => t.replace("- inline note (#1)\n", ""));
    const result = check(project);
    expect(result.code).toBe(1);
    expect(result.out).toContain("inline note (#1)");
  });

  it("passes a cut from fragments with trailing spaces, CRLF and a multi-line entry", () => {
    const project = seed({
      "20-trailing.md": "section: Added\n- trailing spaces (#20)   \n",
      "30-crlf.md": "section: Fixed\r\n- crlf entry (#30)\r\n  crlf continuation\r\n",
      "40-multi.md": "section: Changed\n- multi line (#40)\n  second line\n\n  after blank\n",
    });
    cut(project);
    const result = check(project);
    expect(result.out).toContain("passes the release rule");
    expect(result.code).toBe(0);
  });

  it("fails a release attempt whose version section lacks a deleted fragment's continuation lines", () => {
    const project = seed({ "30-b.md": FRAGMENT_B });
    cut(project, (t) => t.replace("  with a continuation line\n", ""));
    const result = check(project);
    expect(result.code).toBe(1);
    expect(result.out).toContain("with a continuation line");
  });

  it("fails a release line with a source change, also with another entry or a valid new fragment", () => {
    for (const extra of ["entry", "fragment", "none"] as const) {
      const project = seed();
      cut(project, (t) =>
        extra === "entry" ? t.replace(releaseLine(V), `${releaseLine(V)}\n- extra (#5)`) : t,
      );
      put(project, "src/app.ts", "export const x = 1;\n");
      if (extra === "fragment") put(project, "changelog.d/50-new.md", "section: Added\n- new (#50)\n");
      commitAll(project, "release plus source");
      const result = check(project);
      expect(result.code).toBe(1);
      expect(result.out).toContain("A src/app.ts");
    }
  });

  it("fails a release line and empty heading that delete a merge-base fragment", () => {
    const project = seed({ "20-a.md": FRAGMENT_A });
    const text = readFileSync(join(project, "CHANGELOG.md"), "utf8");
    const promoted = promoteChangelog(text, V, "o/r", "2026-02-01");
    rmSync(join(project, "changelog.d/20-a.md"));
    put(project, "CHANGELOG.md", promoted);
    commitAll(project, "release without the fragment's entry");
    const result = check(project);
    expect(result.code).toBe(1);
    expect(result.out).toContain("fragment a (#20)");
  });

  it("fails a release line whose version has no matching new version heading", () => {
    const project = seed();
    cut(project, (t) => t.replace(`## [${V}] - 2026-02-01`, "## [0.1.9] - 2026-02-01"));
    const result = check(project);
    expect(result.code).toBe(1);
    expect(result.out).toContain(`no new ## [${V}] heading`);
  });

  it("fails an ordinary change set that deletes a merge-base fragment, as today", () => {
    const project = seed({ "20-a.md": FRAGMENT_A });
    rmSync(join(project, "changelog.d/20-a.md"));
    put(project, "CHANGELOG.md", BASE.replace("- inline note (#1)", "- inline note (#1)\n- mine"));
    commitAll(project, "delete a fragment");
    const result = check(project);
    expect(result.code).toBe(1);
    expect(result.out).toContain("deletes or renames changelog.d/20-a.md");
  });

  it("fails an ordinary change set that removes the release line", () => {
    const project = seed();
    put(project, "CHANGELOG.md", BASE.replace("- [release-line] v0.1.0\n\n", "- mine (#7)\n\n"));
    commitAll(project, "drop the release line");
    const result = check(project);
    expect(result.code).toBe(1);
    expect(result.out).toContain("removes or changes the release line");
  });

  it("fails an ordinary product change set with no new entry while a release line is present", () => {
    const project = seed();
    put(project, "src/app.ts", "export const x = 1;\n");
    commitAll(project, "product only");
    const result = check(project);
    expect(result.code).toBe(1);
    expect(result.out).toContain("no new");
  });

  it("passes on master's tip when it is a release commit holding only the release line", () => {
    const project = seed();
    cut(project);
    // The release PR merged: master is the release commit, HEAD is the merge base.
    execFileSync("git", ["update-ref", "refs/remotes/origin/master", "HEAD"], { cwd: project });
    const result = check(project);
    expect(result.code).toBe(0);
    expect(result.out).toContain("1 entries");
  });

  it("passes the pin-bump PR after a release: its own entry next to the release line, no hotfix label", () => {
    const project = seed();
    cut(project);
    execFileSync("git", ["update-ref", "refs/remotes/origin/master", "HEAD"], { cwd: project });
    git(project, ["checkout", "-q", "-b", "chore/pin"]);
    const released = readFileSync(join(project, "CHANGELOG.md"), "utf8");
    put(project, "CHANGELOG.md", released.replace(releaseLine(V), `${releaseLine(V)}\n- pin (#8)`));
    put(project, "package.json", '{"name":"x"}\n');
    commitAll(project, "chore: pin");
    const result = check(project);
    expect(result.code).toBe(0);
    expect(readFileSync(join(project, "CHANGELOG.md"), "utf8")).toContain(releaseLine(V));
  });
});
