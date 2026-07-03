import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../scope/transition.js", () => ({
  runTransition: vi.fn((verb: string) => ({ ok: true, message: `${verb} ok` })),
}));

import type { RunGhFn } from "../pr-protected-issues/types.js";
import { runTransition } from "../scope/transition.js";
import { finalizeCohort } from "./finalize-cohort.js";
import { finalizeCohortMain } from "./finalize-cohort-cli.js";
import type { TextCaptureResult } from "./subprocess.js";

function writeActiveStory(project: string, storyId: string, issueNumber: number): string {
  const full = join(project, "xbrief", "active", `${storyId}.xbrief.json`);
  mkdirSync(join(project, "xbrief", "active"), { recursive: true });
  writeFileSync(
    join(project, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
    JSON.stringify({
      plan: {
        title: "Project",
        status: "running",
        policy: { allowDirectCommitsToMaster: false, wipCap: 10 },
      },
    }),
    "utf8",
  );
  writeFileSync(
    full,
    JSON.stringify({
      plan: {
        id: storyId,
        title: storyId,
        status: "running",
        references: [
          {
            uri: `https://github.com/deftai/directive/issues/${issueNumber}`,
            type: "x-xbrief/github-issue",
          },
        ],
        items: [{ id: "i1", title: "t", status: "pending" }],
      },
    }),
    "utf8",
  );
  return full;
}

interface MockPrState {
  readonly merged: boolean;
  readonly closingIssues: number[];
  readonly body?: string;
}

function mockRunGh(mergedPrs: Record<number, MockPrState>): RunGhFn {
  return (cmd) => {
    if (cmd.includes("pr") && cmd.includes("view") && cmd.includes("closingIssuesReferences")) {
      const viewIdx = cmd.indexOf("view");
      const prNumber = Number(cmd[viewIdx + 1]);
      const state = mergedPrs[prNumber];
      if (state === undefined) {
        return { returncode: 1, stdout: "", stderr: "not found" };
      }
      return {
        returncode: 0,
        stdout: JSON.stringify({
          closingIssuesReferences: state.closingIssues.map((n) => ({ number: n })),
        }),
        stderr: "",
      };
    }
    const path = cmd.find((part) => part.startsWith("repos/") && part.includes("/pulls/"));
    if (path !== undefined) {
      const match = path.match(/\/pulls\/(\d+)$/);
      const prNumber = match ? Number(match[1]) : 0;
      const state = mergedPrs[prNumber];
      if (state === undefined) {
        return { returncode: 1, stdout: "", stderr: "not found" };
      }
      const body = state.body ?? state.closingIssues.map((n) => `Closes #${n}`).join("\n");
      return {
        returncode: 0,
        stdout: JSON.stringify({
          merged_at: state.merged ? "2026-07-02T12:00:00Z" : null,
          body,
        }),
        stderr: "",
      };
    }
    if (cmd.includes("pr") && cmd.includes("create")) {
      return { returncode: 0, stdout: "https://github.com/deftai/directive/pull/9999", stderr: "" };
    }
    return { returncode: 0, stdout: "", stderr: "" };
  };
}

function mockRunGit(onCommit?: () => void): (command: readonly string[]) => TextCaptureResult {
  let currentBranch = "";
  return (command) => {
    const joined = command.join(" ");
    if (joined.includes("git switch -c")) {
      currentBranch = command[command.length - 1] ?? "";
      return { returncode: 0, stdout: "", stderr: "" };
    }
    if (joined.includes("git symbolic-ref")) {
      return currentBranch.length > 0
        ? { returncode: 0, stdout: `${currentBranch}\n`, stderr: "" }
        : { returncode: 1, stdout: "", stderr: "detached" };
    }
    if (joined.includes("git commit")) {
      onCommit?.();
      return { returncode: 0, stdout: "", stderr: "" };
    }
    if (joined.includes("git rev-parse HEAD")) {
      return { returncode: 0, stdout: "abc123\n", stderr: "" };
    }
    if (joined.includes("git status --short")) {
      return { returncode: 0, stdout: "M xbrief/active/story-a.xbrief.json\n", stderr: "" };
    }
    return { returncode: 0, stdout: "", stderr: "" };
  };
}

describe("finalizeCohort", () => {
  beforeEach(() => {
    vi.mocked(runTransition).mockClear();
  });

  it("finalizes merged PR stories to completed via explicit --stories", () => {
    const project = mkdtempSync(join(tmpdir(), "sw-finalize-"));
    const storyPath = writeActiveStory(project, "story-a", 2225);
    const result = finalizeCohort({
      projectRoot: project,
      storyTokens: [storyPath],
      noCommit: true,
    });
    expect(result.exitCode).toBe(0);
    expect(result.result.ok).toBe(true);
    expect(vi.mocked(runTransition)).toHaveBeenCalledWith("complete", storyPath);
    rmSync(project, { recursive: true, force: true });
  });

  it("resolves stories from merged PR closing issues", () => {
    const project = mkdtempSync(join(tmpdir(), "sw-finalize-pr-"));
    writeActiveStory(project, "story-b", 2115);
    const result = finalizeCohort({
      projectRoot: project,
      prNumbers: [42],
      repo: "deftai/directive",
      noCommit: true,
      runGh: mockRunGh({ 42: { merged: true, closingIssues: [2115] } }),
    });
    expect(result.exitCode).toBe(0);
    expect(result.result.closing_issues).toEqual([2115]);
    rmSync(project, { recursive: true, force: true });
  });

  it("ignores descriptive 'closed #N' prose when structured refs omit that issue", () => {
    const project = mkdtempSync(join(tmpdir(), "sw-finalize-descriptive-"));
    writeActiveStory(project, "story-real", 2115);
    writeActiveStory(project, "story-unrelated", 1997);
    const result = finalizeCohort({
      projectRoot: project,
      prNumbers: [2226],
      repo: "deftai/directive",
      noCommit: true,
      runGh: mockRunGh({
        2226: {
          merged: true,
          closingIssues: [2115],
          body:
            "Fixes incomplete follow-on work.\n\n" +
            "This is the incomplete-fix follow-on to the closed #1997.\n" +
            "Refs #1997\n\nCloses #2115",
        },
      }),
    });
    expect(result.exitCode).toBe(0);
    expect(result.result.closing_issues).toEqual([2115]);
    expect(result.result.story_paths).toHaveLength(1);
    expect(result.result.story_paths[0]).toContain("story-real");
    rmSync(project, { recursive: true, force: true });
  });

  it("rejects unmerged PRs", () => {
    const project = mkdtempSync(join(tmpdir(), "sw-finalize-unmerged-"));
    writeActiveStory(project, "story-c", 2181);
    const result = finalizeCohort({
      projectRoot: project,
      prNumbers: [43],
      repo: "deftai/directive",
      noCommit: true,
      runGh: mockRunGh({ 43: { merged: false, closingIssues: [2181] } }),
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.result.errors.some((e) => e.includes("not merged"))).toBe(true);
    rmSync(project, { recursive: true, force: true });
  });

  it("commits lifecycle moves on a feature branch when requested", () => {
    const project = mkdtempSync(join(tmpdir(), "sw-finalize-commit-"));
    const storyPath = writeActiveStory(project, "story-d", 2225);
    let committed = false;
    const result = finalizeCohort({
      projectRoot: project,
      storyTokens: [storyPath],
      label: "story-d",
      repo: "deftai/directive",
      runGit: mockRunGit(() => {
        committed = true;
      }),
      runGh: mockRunGh({}),
    });
    expect(result.exitCode).toBe(0);
    expect(committed).toBe(true);
    expect(result.result.branch).toBe("swarm/finalize/story-d");
    expect(result.result.pr_url).toContain("9999");
    rmSync(project, { recursive: true, force: true });
  });

  it("opens the sweep PR against the configured base branch (--base)", () => {
    const project = mkdtempSync(join(tmpdir(), "sw-finalize-base-"));
    const storyPath = writeActiveStory(project, "story-f", 2225);
    const ghCalls: string[][] = [];
    const capturingRunGh: (command: readonly string[]) => TextCaptureResult = (cmd) => {
      ghCalls.push([...cmd]);
      if (cmd.includes("pr") && cmd.includes("create")) {
        return {
          returncode: 0,
          stdout: "https://github.com/deftai/directive/pull/9999",
          stderr: "",
        };
      }
      return { returncode: 0, stdout: "", stderr: "" };
    };
    const result = finalizeCohort({
      projectRoot: project,
      storyTokens: [storyPath],
      label: "story-f",
      repo: "deftai/directive",
      baseBranch: "develop",
      runGit: mockRunGit(),
      runGh: capturingRunGh,
    });
    expect(result.exitCode).toBe(0);
    const createCall = ghCalls.find((c) => c.includes("pr") && c.includes("create"));
    expect(createCall).toBeDefined();
    const baseIdx = createCall?.indexOf("--base") ?? -1;
    expect(baseIdx).toBeGreaterThanOrEqual(0);
    expect(createCall?.[baseIdx + 1]).toBe("develop");
    rmSync(project, { recursive: true, force: true });
  });

  it("manual completeCohortMain still works independently", () => {
    const project = mkdtempSync(join(tmpdir(), "sw-finalize-manual-"));
    const storyPath = writeActiveStory(project, "story-e", 2225);
    const code = finalizeCohortMain(["--project-root", project, "--no-commit", storyPath]);
    expect(code).toBe(0);
    rmSync(project, { recursive: true, force: true });
  });
});
