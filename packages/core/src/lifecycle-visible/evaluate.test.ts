/**
 * Tests for verify:lifecycle-visible (#3505).
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { GitRunner } from "../session/git.js";
import {
  displayIgnoreSource,
  evaluateLifecycleVisible,
  formatLifecycleVisibleSessionLines,
  indexFlagKind,
  isSelectiveLifecyclePath,
  lifecycleRootRelPaths,
  parseCheckIgnoreVerboseLine,
  parseLsFilesVerboseRecord,
} from "./evaluate.js";

const temps: string[] = [];
afterEach(() => {
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

function freshDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

function git(root: string, args: readonly string[]): void {
  execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function initLifecycleRepo(): string {
  const root = freshDir("lifecycle-visible-");
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "t@t.dev"]);
  git(root, ["config", "user.name", "t"]);
  git(root, ["checkout", "-q", "-b", "master"]);
  for (const stage of ["proposed", "pending", "active", "completed", "cancelled"]) {
    mkdirSync(join(root, "xbrief", stage), { recursive: true });
    writeFileSync(join(root, "xbrief", stage, ".gitkeep"), "", "utf8");
  }
  writeFileSync(
    join(root, "xbrief", "active", "story.xbrief.json"),
    '{"xBRIEFInfo":{"version":"0.8"},"plan":{"title":"s","status":"running"}}\n',
    "utf8",
  );
  git(root, ["add", "."]);
  git(root, ["commit", "-q", "-m", "init"]);
  return root;
}

function fakeGit(script: GitRunner): GitRunner {
  return script;
}

describe("parsers (#3505)", () => {
  it("parses check-ignore -v including a Windows drive colon in the source", () => {
    const parsed = parseCheckIgnoreVerboseLine(
      "C:/Repos/deft/directive/.git/info/exclude:33:xbrief/active/\txbrief/active/",
    );
    expect(parsed).toEqual({
      source: "C:/Repos/deft/directive/.git/info/exclude",
      line: 33,
      pattern: "xbrief/active/",
      path: "xbrief/active/",
    });
  });

  it("returns null for a check-ignore line without a tab", () => {
    expect(parseCheckIgnoreVerboseLine("not-a-match")).toBeNull();
    expect(parseCheckIgnoreVerboseLine("no-colons\tpath")).toBeNull();
    expect(parseCheckIgnoreVerboseLine(":abc:\tpath")).toBeNull();
    expect(parseCheckIgnoreVerboseLine(":1:\tpath")).toBeNull();
  });

  it("maps info/exclude to .git/info/exclude and in-repo gitignore to a relative path", () => {
    const root = freshDir("src-map-");
    expect(displayIgnoreSource("C:/foo/.git/info/exclude", root)).toBe(".git/info/exclude");
    expect(displayIgnoreSource("/work/.git/info/exclude", root)).toBe(".git/info/exclude");
    writeFileSync(join(root, ".gitignore"), "x\n", "utf8");
    expect(displayIgnoreSource(join(root, ".gitignore"), root).replace(/\\/g, "/")).toBe(
      ".gitignore",
    );
    expect(displayIgnoreSource("/home/x/.config/git/ignore", root)).toBe(
      "/home/x/.config/git/ignore",
    );
  });

  it("parses ls-files -v tags and classifies skip-worktree vs assume-unchanged", () => {
    expect(parseLsFilesVerboseRecord("S xbrief/active/a.xbrief.json")).toEqual({
      tag: "S",
      path: "xbrief/active/a.xbrief.json",
    });
    expect(parseLsFilesVerboseRecord("h")).toBeNull();
    expect(indexFlagKind("S")).toBe("skip-worktree");
    expect(indexFlagKind("s")).toBe("skip-worktree");
    expect(indexFlagKind("h")).toBe("assume-unchanged");
    expect(indexFlagKind("H")).toBeNull();
  });

  it("treats .triage-cache paths as selective hybrid entries", () => {
    expect(isSelectiveLifecyclePath("xbrief/.triage-cache/candidates.jsonl")).toBe(true);
    expect(isSelectiveLifecyclePath("xbrief/active/.triage-cache/foo.jsonl")).toBe(true);
    expect(isSelectiveLifecyclePath("xbrief/active/story.xbrief.json")).toBe(false);
  });

  it("lists xbrief and vbrief stage roots", () => {
    const roots = lifecycleRootRelPaths();
    expect(roots).toContain("xbrief/active/");
    expect(roots).toContain("vbrief/cancelled/");
    expect(roots).toHaveLength(10);
  });
});

describe("evaluateLifecycleVisible with injected git (#3505)", () => {
  it("exits 2 when the project root is missing", () => {
    const missing = join(tmpdir(), `lv-missing-${Date.now()}`);
    const result = evaluateLifecycleVisible({ projectRoot: missing });
    expect(result.code).toBe(2);
    expect(result.stream).toBe("stderr");
    expect(result.message).toContain("project root not found");
  });

  it("scans the git top-level when invoked from a subdirectory", () => {
    const root = freshDir("lv-nested-");
    mkdirSync(join(root, "xbrief", "active"), { recursive: true });
    mkdirSync(join(root, "packages", "core"), { recursive: true });
    const nested = join(root, "packages", "core");
    const result = evaluateLifecycleVisible({
      projectRoot: nested,
      runGit: fakeGit((_cwd, args) => {
        if (args[0] === "rev-parse" && args.includes("--show-toplevel")) {
          return { code: 0, stdout: root, stderr: "" };
        }
        if (args[0] === "check-ignore") {
          expect(args).toContain("xbrief/active/");
          return {
            code: 0,
            stdout: ".git/info/exclude:1:xbrief/active/\txbrief/active/",
            stderr: "",
          };
        }
        return { code: 0, stdout: "", stderr: "" };
      }),
    });
    expect(result.findings[0]?.path).toBe("xbrief/active/");
  });

  it("reports a bare xbrief/active/ exclude rule with file and line", () => {
    const root = freshDir("lv-exclude-");
    mkdirSync(join(root, "xbrief", "active"), { recursive: true });
    const runGit = fakeGit((_r, args) => {
      if (args[0] === "check-ignore") {
        return {
          code: 0,
          stdout: ".git/info/exclude:33:xbrief/active/\txbrief/active/",
          stderr: "",
        };
      }
      if (args[0] === "ls-files")
        return { code: 0, stdout: "H xbrief/active/.gitkeep", stderr: "" };
      return { code: 1, stdout: "", stderr: "" };
    });
    const result = evaluateLifecycleVisible({ projectRoot: root, runGit });
    expect(result.code).toBe(0);
    expect(result.failOpen).toBe(true);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.path).toBe("xbrief/active/");
    expect(result.findings[0]?.source).toBe(".git/info/exclude");
    expect(result.findings[0]?.line).toBe(33);
    expect(result.findings[0]?.rule).toBe("xbrief/active/");
    expect(result.message).toContain(".git/info/exclude:33:xbrief/active/");
    expect(result.message).toMatch(/ADVISORY|warn-only/i);
  });

  it("reports the same hide via .gitignore and via core.excludesFile", () => {
    const root = freshDir("lv-gi-");
    mkdirSync(join(root, "xbrief", "active"), { recursive: true });
    const gitignore = evaluateLifecycleVisible({
      projectRoot: root,
      runGit: fakeGit((_r, args) => {
        if (args[0] === "check-ignore") {
          return {
            code: 0,
            stdout: `${join(root, ".gitignore").replace(/\\/g, "/")}:2:xbrief/active/\txbrief/active/`,
            stderr: "",
          };
        }
        return { code: 0, stdout: "", stderr: "" };
      }),
    });
    expect(gitignore.findings[0]?.source.replace(/\\/g, "/")).toBe(".gitignore");
    expect(gitignore.message).toContain("xbrief/active/");

    const excludesFile = evaluateLifecycleVisible({
      projectRoot: root,
      runGit: fakeGit((_r, args) => {
        if (args[0] === "check-ignore") {
          return {
            code: 0,
            stdout: "/home/x/.config/git/ignore:4:xbrief/active/\txbrief/active/",
            stderr: "",
          };
        }
        return { code: 0, stdout: "", stderr: "" };
      }),
    });
    expect(excludesFile.findings[0]?.source).toBe("/home/x/.config/git/ignore");
    expect(excludesFile.findings[0]?.line).toBe(4);
    expect(excludesFile.message).toContain("/home/x/.config/git/ignore:4:xbrief/active/");
  });

  it("reports skip-worktree on a tracked brief", () => {
    const root = freshDir("lv-skip-");
    mkdirSync(join(root, "xbrief", "active"), { recursive: true });
    const result = evaluateLifecycleVisible({
      projectRoot: root,
      runGit: fakeGit((_r, args) => {
        if (args[0] === "check-ignore") return { code: 1, stdout: "", stderr: "" };
        if (args[0] === "ls-files") {
          return { code: 0, stdout: "S xbrief/active/story.xbrief.json", stderr: "" };
        }
        return { code: 1, stdout: "", stderr: "" };
      }),
    });
    expect(result.findings[0]).toMatchObject({
      path: "xbrief/active/story.xbrief.json",
      kind: "skip-worktree",
      rule: "skip-worktree",
      source: "index",
    });
    expect(result.message).toContain("skip-worktree");
  });

  it("reports assume-unchanged on a tracked brief", () => {
    const root = freshDir("lv-assume-");
    mkdirSync(join(root, "xbrief", "active"), { recursive: true });
    const result = evaluateLifecycleVisible({
      projectRoot: root,
      runGit: fakeGit((_r, args) => {
        if (args[0] === "check-ignore") return { code: 1, stdout: "", stderr: "" };
        if (args[0] === "ls-files") {
          return { code: 0, stdout: "h xbrief/active/story.xbrief.json", stderr: "" };
        }
        return { code: 1, stdout: "", stderr: "" };
      }),
    });
    expect(result.findings[0]?.kind).toBe("assume-unchanged");
  });

  it("does not trip on .triage-cache jsonl skip-worktree or a clean root", () => {
    const root = freshDir("lv-sel-");
    mkdirSync(join(root, "xbrief", "active"), { recursive: true });
    const result = evaluateLifecycleVisible({
      projectRoot: root,
      runGit: fakeGit((_r, args) => {
        if (args[0] === "check-ignore") return { code: 1, stdout: "", stderr: "" };
        if (args[0] === "ls-files") {
          return {
            code: 0,
            stdout:
              "S xbrief/active/.triage-cache/candidates.jsonl\nH xbrief/active/story.xbrief.json",
            stderr: "",
          };
        }
        return { code: 1, stdout: "", stderr: "" };
      }),
    });
    expect(result.findings).toEqual([]);
    expect(result.code).toBe(0);
    expect(result.message).toMatch(/^OK:/);
  });

  it("fails closed under --enforce when a root is hidden", () => {
    const root = freshDir("lv-enf-");
    mkdirSync(join(root, "xbrief", "active"), { recursive: true });
    const result = evaluateLifecycleVisible({
      projectRoot: root,
      enforce: true,
      runGit: fakeGit((_r, args) => {
        if (args[0] === "check-ignore") {
          return {
            code: 0,
            stdout: ".git/info/exclude:1:xbrief/active/\txbrief/active/",
            stderr: "",
          };
        }
        return { code: 0, stdout: "", stderr: "" };
      }),
    });
    expect(result.code).toBe(1);
    expect(result.failOpen).toBe(false);
    expect(result.stream).toBe("stderr");
    expect(result.message).toContain("FAIL:");
  });

  it("exits 2 when git is missing", () => {
    const root = freshDir("lv-nogit-");
    mkdirSync(join(root, "xbrief", "active"), { recursive: true });
    const result = evaluateLifecycleVisible({
      projectRoot: root,
      runGit: () => ({ code: 127, stdout: "", stderr: "git executable not found on PATH" }),
    });
    expect(result.code).toBe(2);
    expect(result.message).toContain("git executable not found");
  });

  it("exits 2 when the tree is not a git repository", () => {
    const root = freshDir("lv-norepo-");
    mkdirSync(join(root, "xbrief", "active"), { recursive: true });
    const result = evaluateLifecycleVisible({
      projectRoot: root,
      runGit: () => ({ code: 128, stdout: "", stderr: "not a git repository" }),
    });
    expect(result.code).toBe(2);
    expect(result.message).toContain("not a git repository");
  });

  it("is clean when no lifecycle roots exist on disk", () => {
    const root = freshDir("lv-empty-");
    const result = evaluateLifecycleVisible({
      projectRoot: root,
      runGit: fakeGit(() => ({ code: 0, stdout: "", stderr: "" })),
    });
    expect(result.findings).toEqual([]);
    expect(result.message).toMatch(/^OK:/);
  });

  it("skips unparseable check-ignore lines and paths outside the root list", () => {
    const root = freshDir("lv-skip-line-");
    mkdirSync(join(root, "xbrief", "active"), { recursive: true });
    const result = evaluateLifecycleVisible({
      projectRoot: root,
      runGit: fakeGit((_r, args) => {
        if (args[0] === "check-ignore") {
          return {
            code: 0,
            stdout: "not-a-match\n.git/info/exclude:1:README\tREADME.md\n",
            stderr: "",
          };
        }
        return { code: 0, stdout: "not-a-record\nH xbrief/active/.gitkeep", stderr: "" };
      }),
    });
    expect(result.findings).toEqual([]);
  });

  it("treats ls-files exit 1 with empty stdout as no flags", () => {
    const root = freshDir("lv-ls1-");
    mkdirSync(join(root, "xbrief", "active"), { recursive: true });
    const result = evaluateLifecycleVisible({
      projectRoot: root,
      runGit: fakeGit((_r, args) => {
        if (args[0] === "check-ignore") return { code: 1, stdout: "", stderr: "" };
        return { code: 1, stdout: "", stderr: "" };
      }),
    });
    expect(result.findings).toEqual([]);
  });

  it("uses ls-files stderr when index probing fails after a clean check-ignore", () => {
    const root = freshDir("lv-lsfail-");
    mkdirSync(join(root, "xbrief", "active"), { recursive: true });
    const result = evaluateLifecycleVisible({
      projectRoot: root,
      runGit: fakeGit((_r, args) => {
        if (args[0] === "check-ignore") return { code: 1, stdout: "", stderr: "" };
        return { code: 2, stdout: "x", stderr: "ls-files boom" };
      }),
    });
    expect(result.code).toBe(2);
    expect(result.message).toContain("ls-files boom");
  });

  it("uses the git error detail for non-127/128 probe failures", () => {
    const root = freshDir("lv-probe-");
    mkdirSync(join(root, "xbrief", "active"), { recursive: true });
    const result = evaluateLifecycleVisible({
      projectRoot: root,
      runGit: () => ({ code: 2, stdout: "", stderr: "" }),
    });
    expect(result.code).toBe(2);
    expect(result.message).toContain("git check-ignore failed");
  });

  it("stringifies a non-Error throw from the git runner", () => {
    const root = freshDir("lv-throw-");
    mkdirSync(join(root, "xbrief", "active"), { recursive: true });
    const result = evaluateLifecycleVisible({
      projectRoot: root,
      runGit: () => {
        throw "boom-string";
      },
    });
    expect(result.code).toBe(2);
    expect(result.message).toContain("boom-string");
  });

  it("still check-ignore a missing canonical root so the hide is reported", () => {
    const root = freshDir("lv-absent-");
    mkdirSync(join(root, "xbrief", "proposed"), { recursive: true });
    const result = evaluateLifecycleVisible({
      projectRoot: root,
      runGit: fakeGit((_r, args) => {
        if (args[0] === "check-ignore") {
          const paths = args.slice(args.indexOf("--") + 1);
          expect(paths).toContain("xbrief/active/");
          expect(paths).toContain("vbrief/active/");
          return {
            code: 0,
            stdout: ".git/info/exclude:1:xbrief/active/\txbrief/active/",
            stderr: "",
          };
        }
        return { code: 0, stdout: "", stderr: "" };
      }),
    });
    expect(result.findings.some((f) => f.path === "xbrief/active/")).toBe(true);
  });
});

describe("formatLifecycleVisibleSessionLines (#3505)", () => {
  it("is silent when clean", () => {
    expect(
      formatLifecycleVisibleSessionLines({
        code: 0,
        message: "OK",
        stream: "stdout",
        findings: [],
        enforce: false,
        failOpen: true,
      }),
    ).toEqual([]);
  });

  it("names the rule on the session:start advisory line", () => {
    const lines = formatLifecycleVisibleSessionLines({
      code: 0,
      message: "x",
      stream: "stdout",
      findings: [
        {
          path: "xbrief/active/",
          kind: "ignored",
          source: ".git/info/exclude",
          line: 33,
          rule: "xbrief/active/",
          raw: ".git/info/exclude:33:xbrief/active/\txbrief/active/",
        },
        {
          path: "xbrief/active/story.xbrief.json",
          kind: "skip-worktree",
          source: "index",
          line: null,
          rule: "skip-worktree",
          raw: "S xbrief/active/story.xbrief.json",
        },
      ],
      enforce: false,
      failOpen: true,
    });
    expect(lines[0]).toBe(
      "[deft lifecycle-visible] hidden xbrief/active/  (.git/info/exclude:33:xbrief/active/)",
    );
    expect(lines[1]).toBe(
      "[deft lifecycle-visible] skip-worktree on xbrief/active/story.xbrief.json",
    );
    expect(lines.at(-1)).toContain("ADVISORY");
  });

  it("formats an ignored finding with a missing line number", () => {
    const lines = formatLifecycleVisibleSessionLines({
      code: 0,
      message: "x",
      stream: "stdout",
      findings: [
        {
          path: "xbrief/active/",
          kind: "ignored",
          source: ".gitignore",
          line: null,
          rule: "xbrief/active/",
          raw: "x",
        },
      ],
      enforce: false,
      failOpen: true,
    });
    expect(lines[0]).toBe(
      "[deft lifecycle-visible] hidden xbrief/active/  (.gitignore:xbrief/active/)",
    );
  });
});

describe("evaluateLifecycleVisible live git fixtures (#3505)", () => {
  it("reports a bare xbrief/active/ in .git/info/exclude with file and line", () => {
    const root = initLifecycleRepo();
    writeFileSync(join(root, ".git", "info", "exclude"), "xbrief/active/\n", "utf8");
    const result = evaluateLifecycleVisible({ projectRoot: root });
    expect(result.findings.some((f) => f.path === "xbrief/active/")).toBe(true);
    const hit = result.findings.find((f) => f.path === "xbrief/active/");
    expect(hit?.source).toBe(".git/info/exclude");
    expect(hit?.line).toBe(1);
    expect(hit?.rule).toContain("xbrief/active");
    expect(result.message).toMatch(/\.git\/info\/exclude:1:xbrief\/active/);
  });

  it("reports the same hide via .gitignore and via core.excludesFile", () => {
    const gitignoreRoot = initLifecycleRepo();
    writeFileSync(join(gitignoreRoot, ".gitignore"), "xbrief/active/\n", "utf8");
    const gi = evaluateLifecycleVisible({ projectRoot: gitignoreRoot });
    const giHit = gi.findings.find((f) => f.path === "xbrief/active/");
    expect(giHit?.source.replace(/\\/g, "/")).toBe(".gitignore");
    expect(giHit?.rule).toContain("xbrief/active");

    const excludesRoot = initLifecycleRepo();
    const excludesFile = join(excludesRoot, "global-excludes");
    writeFileSync(excludesFile, "xbrief/active/\n", "utf8");
    git(excludesRoot, ["config", "core.excludesFile", excludesFile.replace(/\\/g, "/")]);
    const ex = evaluateLifecycleVisible({ projectRoot: excludesRoot });
    const exHit = ex.findings.find((f) => f.path === "xbrief/active/");
    expect(exHit).toBeDefined();
    expect(exHit?.source.replace(/\\/g, "/")).toContain("global-excludes");
    expect(ex.message).toContain("xbrief/active");
  });

  it("reports skip-worktree on a tracked brief", () => {
    const root = initLifecycleRepo();
    git(root, ["update-index", "--skip-worktree", "xbrief/active/story.xbrief.json"]);
    const result = evaluateLifecycleVisible({ projectRoot: root });
    expect(
      result.findings.some(
        (f) =>
          f.kind === "skip-worktree" &&
          f.path.replace(/\\/g, "/") === "xbrief/active/story.xbrief.json",
      ),
    ).toBe(true);
  });

  it("does not trip on deliberate .triage-cache jsonl gitignore entries", () => {
    const root = initLifecycleRepo();
    mkdirSync(join(root, "xbrief", ".triage-cache"), { recursive: true });
    writeFileSync(join(root, "xbrief", ".triage-cache", "candidates.jsonl"), "{}\n", "utf8");
    writeFileSync(join(root, ".gitignore"), "xbrief/.triage-cache/*.jsonl\n", "utf8");
    const result = evaluateLifecycleVisible({ projectRoot: root });
    expect(result.findings).toEqual([]);
    expect(result.code).toBe(0);
  });
});
