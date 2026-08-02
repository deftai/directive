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

function writeCompletedStory(project: string, storyId: string, issueNumber: number): string {
  const full = join(project, "xbrief", "completed", `${storyId}.xbrief.json`);
  mkdirSync(join(project, "xbrief", "completed"), { recursive: true });
  writeFileSync(
    full,
    JSON.stringify({
      plan: {
        id: storyId,
        title: storyId,
        status: "done",
        references: [
          {
            uri: `https://github.com/deftai/directive/issues/${issueNumber}`,
            type: "x-xbrief/github-issue",
          },
        ],
        items: [{ id: "i1", title: "t", status: "done" }],
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
  /** PR base.ref (defaults to master — delivery branch). */
  readonly baseRef?: string;
  readonly mergeCommitSha?: string | null;
  readonly headSha?: string;
}

function mockRunGh(
  mergedPrs: Record<number, MockPrState>,
  issueStates: Record<number, "open" | "closed"> = {},
): RunGhFn {
  return (cmd) => {
    const issuePath = cmd.find((part) => part.startsWith("repos/") && part.includes("/issues/"));
    if (issuePath !== undefined) {
      const match = issuePath.match(/\/issues\/(\d+)$/);
      const issueNumber = match ? Number(match[1]) : 0;
      const state = issueStates[issueNumber] ?? "open";
      return { returncode: 0, stdout: JSON.stringify({ state }), stderr: "" };
    }
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
      const mergeSha =
        state.mergeCommitSha === null
          ? null
          : (state.mergeCommitSha ?? "deadbeefdelivery000000000000000000000001");
      return {
        returncode: 0,
        stdout: JSON.stringify({
          merged_at: state.merged ? "2026-07-02T12:00:00Z" : null,
          body,
          base: { ref: state.baseRef ?? "master" },
          head: { sha: state.headSha ?? "headsha000000000000000000000000000000001" },
          merge_commit_sha: state.merged ? mergeSha : null,
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

function mockRunGit(
  onCommit?: () => void,
  opts?: { fetchFail?: boolean; notAncestor?: boolean },
): (command: readonly string[]) => TextCaptureResult {
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
    if (joined.includes("git fetch") && opts?.fetchFail) {
      return { returncode: 1, stdout: "", stderr: "network unreachable" };
    }
    if (joined.includes("merge-base") && joined.includes("--is-ancestor")) {
      return {
        returncode: opts?.notAncestor ? 1 : 0,
        stdout: "",
        stderr: opts?.notAncestor ? "not ancestor" : "",
      };
    }
    if (joined.includes("git rev-parse") && joined.includes("origin/")) {
      return { returncode: 0, stdout: "deliverytip000000000000000000000000001\n", stderr: "" };
    }
    if (joined.includes("git rev-parse")) {
      return { returncode: 0, stdout: "abc123\n", stderr: "" };
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
    expect(vi.mocked(runTransition)).toHaveBeenCalledWith(
      "complete",
      storyPath,
      expect.any(Date),
      expect.any(Object),
    );
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
      deliveryBranch: "master",
      runGh: mockRunGh({ 42: { merged: true, closingIssues: [2115] } }),
      runGit: mockRunGit(),
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
      deliveryBranch: "master",
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
      runGit: mockRunGit(),
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
      deliveryBranch: "master",
      runGh: mockRunGh({ 43: { merged: false, closingIssues: [2181] } }),
      runGit: mockRunGit(),
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.result.errors.some((e) => e.includes("not merged"))).toBe(true);
    rmSync(project, { recursive: true, force: true });
  });

  it("rejects PR merged only into an intermediate base (not delivery branch) (#3041)", () => {
    const project = mkdtempSync(join(tmpdir(), "sw-finalize-integration-"));
    writeActiveStory(project, "story-int", 3041);
    const result = finalizeCohort({
      projectRoot: project,
      prNumbers: [100],
      repo: "deftai/directive",
      noCommit: true,
      deliveryBranch: "master",
      // --base-branch is the sweep PR target and must NOT redefine delivery
      baseBranch: "develop",
      runGh: mockRunGh({
        100: { merged: true, closingIssues: [3041], baseRef: "feature/integration" },
      }),
      runGit: mockRunGit(),
    });
    expect(result.exitCode).not.toBe(0);
    expect(
      result.result.errors.some(
        (e) => e.includes("not the delivery branch") || e.includes("delivery"),
      ),
    ).toBe(true);
    expect(vi.mocked(runTransition)).not.toHaveBeenCalled();
    rmSync(project, { recursive: true, force: true });
  });

  it("rejects when remote delivery ref refresh fails (#3041)", () => {
    const project = mkdtempSync(join(tmpdir(), "sw-finalize-stale-"));
    writeActiveStory(project, "story-stale", 3041);
    const result = finalizeCohort({
      projectRoot: project,
      prNumbers: [101],
      repo: "deftai/directive",
      noCommit: true,
      deliveryBranch: "master",
      runGh: mockRunGh({ 101: { merged: true, closingIssues: [3041], baseRef: "master" } }),
      runGit: mockRunGit(undefined, { fetchFail: true }),
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.result.errors.some((e) => e.includes("fetch") || e.includes("delivery"))).toBe(
      true,
    );
    rmSync(project, { recursive: true, force: true });
  });

  it("rejects missing merge_commit_sha (#3041)", () => {
    const project = mkdtempSync(join(tmpdir(), "sw-finalize-no-sha-"));
    writeActiveStory(project, "story-nosha", 3041);
    const result = finalizeCohort({
      projectRoot: project,
      prNumbers: [102],
      repo: "deftai/directive",
      noCommit: true,
      deliveryBranch: "master",
      runGh: mockRunGh({
        102: {
          merged: true,
          closingIssues: [3041],
          baseRef: "master",
          mergeCommitSha: null,
        },
      }),
      runGit: mockRunGit(),
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.result.errors.some((e) => e.includes("merge_commit_sha"))).toBe(true);
    rmSync(project, { recursive: true, force: true });
  });

  it("accepts direct delivery merge with ancestry (#3041)", () => {
    const project = mkdtempSync(join(tmpdir(), "sw-finalize-delivery-"));
    const storyPath = writeActiveStory(project, "story-del", 3041);
    const result = finalizeCohort({
      projectRoot: project,
      prNumbers: [103],
      repo: "deftai/directive",
      noCommit: true,
      deliveryBranch: "master",
      runGh: mockRunGh({ 103: { merged: true, closingIssues: [3041], baseRef: "master" } }),
      runGit: mockRunGit(),
    });
    expect(result.exitCode).toBe(0);
    expect(result.result.ok).toBe(true);
    expect(result.result.delivery_branch).toBe("master");
    expect(vi.mocked(runTransition)).toHaveBeenCalledWith(
      "complete",
      storyPath,
      expect.any(Date),
      expect.objectContaining({
        assumeEvidenceValidated: true,
        deliveryEvidence: expect.objectContaining({
          prNumber: 103,
          prBase: "master",
          mergeCommit: expect.any(String),
        }),
      }),
    );
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

  it("skips an incidental closing ref to an already-completed issue and sweeps the rest (#2115)", () => {
    const project = mkdtempSync(join(tmpdir(), "sw-finalize-skip-completed-"));
    const storyPath = writeActiveStory(project, "story-2240", 2240);
    writeCompletedStory(project, "story-2115", 2115);
    const result = finalizeCohort({
      projectRoot: project,
      prNumbers: [2241],
      repo: "deftai/directive",
      noCommit: true,
      deliveryBranch: "master",
      runGh: mockRunGh({ 2241: { merged: true, closingIssues: [2240, 2115] } }),
      runGit: mockRunGit(),
    });
    expect(result.exitCode).toBe(0);
    expect(result.result.ok).toBe(true);
    expect(result.result.story_paths).toHaveLength(1);
    expect(result.result.story_paths[0]).toContain("story-2240");
    expect(result.result.warnings.some((w) => w.includes("#2115"))).toBe(true);
    expect(result.result.errors).toEqual([]);
    expect(vi.mocked(runTransition)).toHaveBeenCalledWith(
      "complete",
      storyPath,
      expect.any(Date),
      expect.any(Object),
    );
    rmSync(project, { recursive: true, force: true });
  });

  it("skips an incidental closing ref whose issue is already closed on the tracker (#2247)", () => {
    const project = mkdtempSync(join(tmpdir(), "sw-finalize-skip-closed-"));
    writeActiveStory(project, "story-2240", 2240);
    const result = finalizeCohort({
      projectRoot: project,
      prNumbers: [2241],
      repo: "deftai/directive",
      noCommit: true,
      deliveryBranch: "master",
      runGh: mockRunGh({ 2241: { merged: true, closingIssues: [2240, 8888] } }, { 8888: "closed" }),
      runGit: mockRunGit(),
    });
    expect(result.exitCode).toBe(0);
    expect(result.result.ok).toBe(true);
    expect(result.result.story_paths).toHaveLength(1);
    expect(result.result.warnings.some((w) => w.includes("#8888") && w.includes("closed"))).toBe(
      true,
    );
    expect(result.result.errors).toEqual([]);
    rmSync(project, { recursive: true, force: true });
  });

  it("surfaces a closing ref to an open issue with neither active nor completed brief (#2247)", () => {
    const project = mkdtempSync(join(tmpdir(), "sw-finalize-misconfig-"));
    const storyPath = writeActiveStory(project, "story-2240", 2240);
    const result = finalizeCohort({
      projectRoot: project,
      prNumbers: [2241],
      repo: "deftai/directive",
      noCommit: true,
      deliveryBranch: "master",
      runGh: mockRunGh({ 2241: { merged: true, closingIssues: [2240, 9999] } }, { 9999: "open" }),
      runGit: mockRunGit(),
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.result.errors.some((e) => e.includes("#9999"))).toBe(true);
    // The genuine misconfig is surfaced, but the real cohort story still sweeps.
    expect(vi.mocked(runTransition)).toHaveBeenCalledWith(
      "complete",
      storyPath,
      expect.any(Date),
      expect.any(Object),
    );
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
