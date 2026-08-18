import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { parseArgs, run } from "./verify-completed-tracked.js";

const temps: string[] = [];
afterAll(() => {
  for (const t of temps) {
    rmSync(t, { recursive: true, force: true });
  }
});

function git(root: string, args: string[]): void {
  execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function buildRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "deft-cli-completed-tracked-"));
  temps.push(root);
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "t@t.dev"]);
  git(root, ["config", "user.name", "t"]);
  git(root, ["checkout", "-q", "-b", "master"]);
  writeFileSync(join(root, "README.md"), "fixture\n", "utf8");
  git(root, ["add", "README.md"]);
  git(root, ["commit", "-q", "-m", "init"]);
  mkdirSync(join(root, "xbrief", "completed"), { recursive: true });
  return root;
}

function silentRun(argv: string[]): number {
  const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const err = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  try {
    return run(argv);
  } finally {
    out.mockRestore();
    err.mockRestore();
  }
}

describe("parseArgs", () => {
  it("parses defaults", () => {
    expect(parseArgs([])).toMatchObject({
      projectRoot: ".",
      repo: null,
      tip: null,
      issue: null,
      quiet: false,
      skipGh: false,
    });
  });

  it("parses all flags", () => {
    expect(
      parseArgs([
        "--project-root",
        "/root",
        "--repo",
        "deftai/directive",
        "--tip",
        "origin/master",
        "--issue",
        "3476",
        "--quiet",
        "--skip-gh",
      ]),
    ).toMatchObject({
      projectRoot: "/root",
      repo: "deftai/directive",
      tip: "origin/master",
      issue: 3476,
      quiet: true,
      skipGh: true,
    });
  });

  it("parses equals-form flags", () => {
    expect(
      parseArgs([
        "--project-root=/root",
        "--repo=deftai/directive",
        "--tip=origin/main",
        "--issue=#3476",
      ]),
    ).toMatchObject({
      projectRoot: "/root",
      repo: "deftai/directive",
      tip: "origin/main",
      issue: 3476,
    });
  });

  it("errors when --tip is missing its value", () => {
    expect(parseArgs(["--tip"]).error).toMatch(/--tip/);
  });

  it("rejects a non-positive --issue", () => {
    expect(parseArgs(["--issue", "0"]).error).toContain("positive integer");
    expect(parseArgs(["--issue"]).error).toContain("expected one argument");
  });
});

describe("run", () => {
  it("returns 0 when nothing is scoped", () => {
    const root = buildRepo();
    expect(silentRun(["--project-root", root, "--tip", "HEAD", "--skip-gh"])).toBe(0);
  });

  it("returns 1 for closed issue with untracked completed only", () => {
    const root = buildRepo();
    writeFileSync(
      join(root, "xbrief", "completed", "orphan.xbrief.json"),
      JSON.stringify({
        xBRIEFInfo: { version: "0.8" },
        plan: {
          status: "completed",
          references: [
            {
              uri: "https://github.com/deftai/directive/issues/1001",
              type: "x-xbrief/github-issue",
            },
          ],
        },
      }),
      "utf8",
    );
    mkdirSync(join(root, ".deft-cache", "github-issue", "deftai", "directive", "1001"), {
      recursive: true,
    });
    writeFileSync(
      join(root, ".deft-cache", "github-issue", "deftai", "directive", "1001", "raw.json"),
      JSON.stringify({ number: 1001, state: "closed" }),
      "utf8",
    );
    expect(
      silentRun([
        "--project-root",
        root,
        "--repo",
        "deftai/directive",
        "--tip",
        "HEAD",
        "--skip-gh",
      ]),
    ).toBe(1);
  });

  it("returns 2 for bad args", () => {
    expect(silentRun(["--bogus"])).toBe(2);
  });

  it("returns 1 for --issue N when only that closed issue is untracked", () => {
    const root = buildRepo();
    writeFileSync(
      join(root, "xbrief", "completed", "orphan.xbrief.json"),
      JSON.stringify({
        xBRIEFInfo: { version: "0.8" },
        plan: {
          status: "completed",
          references: [
            {
              uri: "https://github.com/deftai/directive/issues/3476",
              type: "x-xbrief/github-issue",
            },
          ],
        },
      }),
      "utf8",
    );
    mkdirSync(join(root, ".deft-cache", "github-issue", "deftai", "directive", "3476"), {
      recursive: true,
    });
    writeFileSync(
      join(root, ".deft-cache", "github-issue", "deftai", "directive", "3476", "raw.json"),
      JSON.stringify({ number: 3476, state: "closed" }),
      "utf8",
    );
    expect(
      silentRun([
        "--project-root",
        root,
        "--repo",
        "deftai/directive",
        "--tip",
        "HEAD",
        "--skip-gh",
        "--issue",
        "3476",
      ]),
    ).toBe(1);
  });
});
