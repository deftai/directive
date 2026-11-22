import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluate as evaluateBranch } from "@deftai/directive-core/branch";
import { CONSUMER_HEADER_PLACEHOLDER_ONELINER } from "@deftai/directive-core/platform";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HEADER_LINE_NEXT_STEP, parseArgs, run } from "./project-write-header-line.js";

const tempDirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of tempDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "cli-header-line-"));
  tempDirs.push(root);
  return root;
}

const SCAFFOLD = `# Garden\n\n${CONSUMER_HEADER_PLACEHOLDER_ONELINER}\n\n## Session orientation\n`;

function withOverview(root: string, overview: string): void {
  mkdirSync(join(root, "xbrief"), { recursive: true });
  writeFileSync(
    join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
    `${JSON.stringify({
      xBRIEFInfo: { version: "0.8" },
      plan: { title: "demo", narratives: { Overview: overview } },
    })}\n`,
    "utf8",
  );
}

function capture(): { out: () => string; err: () => string } {
  let out = "";
  let err = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    out += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    err += String(chunk);
    return true;
  });
  return { out: () => out, err: () => err };
}

function git(root: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  });
}

describe("project:write-header-line CLI (#6973)", () => {
  it("parseArgs accepts --project-root and --line, both forms", () => {
    expect(parseArgs(["--project-root", "/tmp/x", "--line", "A tool."])).toEqual({
      projectRoot: "/tmp/x",
      line: "A tool.",
    });
    expect(parseArgs(["--line=A tool."])).toEqual({ projectRoot: ".", line: "A tool." });
    expect(parseArgs(["--bogus"])).toMatchObject({
      error: expect.stringContaining("unrecognized"),
    });
    expect(parseArgs(["--project-root"])).toMatchObject({
      error: expect.stringContaining("expected"),
    });
  });

  it("writes the first Overview sentence, prints file, line and next step, and does not commit", () => {
    const root = tempRoot();
    git(root, ["init", "-q", "-b", "feat/x"]);
    writeFileSync(join(root, "AGENTS.md"), SCAFFOLD, "utf8");
    withOverview(root, "Garden notes is a CRUD app. It tracks beds. Source: design.md");
    git(root, ["add", "AGENTS.md"]);
    git(root, ["-c", "core.hooksPath=/dev/null", "commit", "-q", "-m", "init"]);
    const io = capture();
    expect(run(["--project-root", root])).toBe(0);
    expect(io.out()).toContain("one-liner: Garden notes is a CRUD app.");
    expect(io.out()).toContain(HEADER_LINE_NEXT_STEP);
    expect(readFileSync(join(root, "AGENTS.md"), "utf8")).toBe(
      SCAFFOLD.replace(CONSUMER_HEADER_PLACEHOLDER_ONELINER, "Garden notes is a CRUD app."),
    );
    // Never commits: the change is still in the working tree only.
    expect(git(root, ["rev-list", "--count", "HEAD"]).trim()).toBe("1");
    expect(git(root, ["status", "--porcelain"])).toContain("AGENTS.md");
  });

  it("refuses an over-long first sentence, prints the candidate and the --line form", () => {
    const root = tempRoot();
    writeFileSync(join(root, "AGENTS.md"), SCAFFOLD, "utf8");
    const long = `${"word ".repeat(30).trim()}.`;
    withOverview(root, long);
    const io = capture();
    expect(run(["--project-root", root])).toBe(1);
    expect(io.err()).toContain(`candidate: ${long}`);
    expect(io.err()).toContain("--line");
    expect(readFileSync(join(root, "AGENTS.md"), "utf8")).toBe(SCAFFOLD);
  });

  it("takes --line and refuses markup", () => {
    const root = tempRoot();
    writeFileSync(join(root, "AGENTS.md"), SCAFFOLD, "utf8");
    capture();
    expect(run(["--project-root", root, "--line", "A tool <!-- x -->"])).toBe(1);
    expect(readFileSync(join(root, "AGENTS.md"), "utf8")).toBe(SCAFFOLD);
    expect(run(["--project-root", root, "--line", "A garden tool."])).toBe(0);
    expect(readFileSync(join(root, "AGENTS.md"), "utf8")).toContain("A garden tool.");
  });

  it("writes nothing in a linked worktree", () => {
    const root = tempRoot();
    writeFileSync(join(root, ".git"), "gitdir: /elsewhere/.git/worktrees/w\n", "utf8");
    writeFileSync(join(root, "AGENTS.md"), SCAFFOLD, "utf8");
    withOverview(root, "Garden notes CRUD app.");
    const io = capture();
    expect(run(["--project-root", root])).toBe(1);
    expect(io.err()).toMatch(/linked worktree/);
    expect(io.err()).toMatch(/primary checkout/);
    expect(readFileSync(join(root, "AGENTS.md"), "utf8")).toBe(SCAFFOLD);
  });

  it("leaves a custom header alone", () => {
    const root = tempRoot();
    writeFileSync(join(root, "AGENTS.md"), "# Garden\n\nCustom.\n", "utf8");
    const io = capture();
    expect(run(["--project-root", root, "--line", "A tool."])).toBe(0);
    expect(io.out()).toContain("not the scaffold placeholder");
    expect(readFileSync(join(root, "AGENTS.md"), "utf8")).toBe("# Garden\n\nCustom.\n");
  });

  it("does not change branch policy: the delivery branch still refuses direct commits", () => {
    const root = tempRoot();
    git(root, ["init", "-q", "-b", "master"]);
    writeFileSync(join(root, "AGENTS.md"), SCAFFOLD, "utf8");
    git(root, ["add", "AGENTS.md"]);
    git(root, ["-c", "core.hooksPath=/dev/null", "commit", "-q", "-m", "init"]);
    capture();
    expect(run(["--project-root", root, "--line", "A garden tool."])).toBe(0);
    expect(evaluateBranch(root, { defaultBranches: new Set(["master"]) }).exitCode).not.toBe(0);
  });
});
