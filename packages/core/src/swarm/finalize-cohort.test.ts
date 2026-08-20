import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../scope/transition.js", () => ({
  runTransition: vi.fn((verb: string) => ({ ok: true, message: `${verb} ok` })),
}));

import { CLAUSE_STAMP_IMPLEMENTATION_ONLY_REMEDIATION } from "../intake/clause-derivation.js";
import type { RunGhFn } from "../pr-protected-issues/types.js";
import { runTransition } from "../scope/transition.js";
import { EXIT_CONFIG_ERROR, EXIT_OK } from "./constants.js";
import { finalizeCohort } from "./finalize-cohort.js";
import { finalizeCohortMain, parseFinalizeCohortArgv } from "./finalize-cohort-cli.js";
import type { TextCaptureResult } from "./subprocess.js";

function writeActiveStory(
  project: string,
  storyId: string,
  issueNumber: number,
  opts: { deliveryBranch?: string } = {},
): string {
  const full = join(project, "xbrief", "active", `${storyId}.xbrief.json`);
  mkdirSync(join(project, "xbrief", "active"), { recursive: true });
  writeFileSync(
    join(project, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
    JSON.stringify({
      plan: {
        title: "Project",
        status: "running",
        policy: {
          allowDirectCommitsToMaster: false,
          wipCap: 10,
          ...(opts.deliveryBranch !== undefined ? { deliveryBranch: opts.deliveryBranch } : {}),
        },
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

interface MockGitOpts {
  readonly onCommit?: () => void;
  readonly fetchFail?: boolean;
  readonly notAncestor?: boolean;
}

function mockRunGit(opts: MockGitOpts = {}): (command: readonly string[]) => TextCaptureResult {
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
      opts.onCommit?.();
      return { returncode: 0, stdout: "", stderr: "" };
    }
    if (joined.includes("git rev-parse HEAD")) {
      return { returncode: 0, stdout: "abc123\n", stderr: "" };
    }
    if (joined.includes("git status --short")) {
      return { returncode: 0, stdout: "M xbrief/active/story-a.xbrief.json\n", stderr: "" };
    }
    if (joined.includes("git fetch") && opts.fetchFail) {
      return { returncode: 1, stdout: "", stderr: "network unreachable" };
    }
    if (joined.includes("merge-base") && joined.includes("--is-ancestor")) {
      return {
        returncode: opts.notAncestor ? 1 : 0,
        stdout: "",
        stderr: opts.notAncestor ? "not ancestor" : "",
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
      runGit: mockRunGit({ fetchFail: true }),
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
      runGit: mockRunGit({
        onCommit: () => {
          committed = true;
        },
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

  it("forwards refused-stamp sweep details when complete-cohort refuses an implementation-only stamp (#3398)", () => {
    vi.mocked(runTransition).mockImplementation((verb: string) => {
      if (verb === "complete") {
        return { ok: false, message: CLAUSE_STAMP_IMPLEMENTATION_ONLY_REMEDIATION };
      }
      return { ok: true, message: `${verb} ok` };
    });
    const project = mkdtempSync(join(tmpdir(), "sw-finalize-refuse-"));
    const storyPath = writeActiveStory(project, "story-impl-only", 3398);
    const result = finalizeCohort({
      projectRoot: project,
      storyTokens: [storyPath],
      noCommit: true,
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.result.sweep).not.toBeNull();
    expect(result.result.sweep?.stories.some((s) => !s.ok)).toBe(true);
    expect(result.stdout).toContain(CLAUSE_STAMP_IMPLEMENTATION_ONLY_REMEDIATION);
    expect(
      result.result.errors.some((err) =>
        err.includes(CLAUSE_STAMP_IMPLEMENTATION_ONLY_REMEDIATION),
      ),
    ).toBe(true);
    rmSync(project, { recursive: true, force: true });
  });

  it("prints refused-stamp activate remediation from a successful parent sweep (#3398)", () => {
    vi.mocked(runTransition).mockImplementation((verb: string) => {
      if (verb === "activate") {
        return {
          ok: true,
          message:
            "Activated pending/parent-notice.xbrief.json -> active/.\n" +
            CLAUSE_STAMP_IMPLEMENTATION_ONLY_REMEDIATION,
        };
      }
      return { ok: true, message: `${verb} ok` };
    });
    const project = mkdtempSync(join(tmpdir(), "sw-finalize-notice-"));
    mkdirSync(join(project, "xbrief", "pending"), { recursive: true });
    mkdirSync(join(project, "xbrief", "completed"), { recursive: true });
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
    const childCompleted = join(project, "xbrief", "completed", "child-notice.xbrief.json");
    writeFileSync(
      childCompleted,
      JSON.stringify({
        plan: {
          id: "child-notice",
          title: "child-notice",
          status: "completed",
          planRef: "pending/parent-notice.xbrief.json",
          items: [{ id: "i1", title: "t", status: "done" }],
        },
      }),
      "utf8",
    );
    writeFileSync(
      join(project, "xbrief", "pending", "parent-notice.xbrief.json"),
      JSON.stringify({
        plan: {
          id: "parent-notice",
          title: "parent-notice",
          status: "pending",
          references: [{ type: "x-vbrief/plan", uri: "completed/child-notice.xbrief.json" }],
          metadata: { kind: "epic" },
        },
      }),
      "utf8",
    );
    const result = finalizeCohort({
      projectRoot: project,
      storyTokens: [childCompleted],
      noCommit: true,
    });
    expect(result.exitCode).toBe(0);
    expect(result.result.sweep).not.toBeNull();
    expect(result.result.sweep?.parents.some((p) => p.action === "activate+complete")).toBe(true);
    expect(result.stdout).toContain(CLAUSE_STAMP_IMPLEMENTATION_ONLY_REMEDIATION);
    rmSync(project, { recursive: true, force: true });
  });
});

describe("finalize-cohort sweep base and argv (#3554)", () => {
  function capturingGit(): {
    runGit: (command: readonly string[]) => TextCaptureResult;
    commands: string[][];
  } {
    const commands: string[][] = [];
    const inner = mockRunGit();
    return {
      commands,
      runGit: (command) => {
        commands.push([...command]);
        return inner(command);
      },
    };
  }

  it("defaults sweep base to the resolved delivery branch and does not fetch origin/master", () => {
    const project = mkdtempSync(join(tmpdir(), "sw-finalize-main-"));
    const storyPath = writeActiveStory(project, "story-main", 3554, { deliveryBranch: "main" });
    const { runGit, commands } = capturingGit();
    const result = finalizeCohort({
      projectRoot: project,
      storyTokens: [storyPath],
      label: "story-main",
      repo: "deftai/directive",
      runGit,
      runGh: mockRunGh({}),
    });
    expect(result.exitCode).toBe(0);
    expect(result.result.sweep_base).toBe("main");
    expect(result.result.delivery_branch).toBe("main");
    expect(result.stdout).toContain("Delivery branch: main");
    expect(result.stdout).toContain("Sweep base: main");
    const fetches = commands.filter((c) => c.includes("fetch"));
    expect(fetches.some((c) => c.includes("origin") && c.includes("master"))).toBe(false);
    expect(fetches.some((c) => c.includes("origin") && c.includes("main"))).toBe(true);
    rmSync(project, { recursive: true, force: true });
  });

  it("prints both names and proceeds when an explicit --base-branch differs from delivery", () => {
    const project = mkdtempSync(join(tmpdir(), "sw-finalize-override-"));
    const storyPath = writeActiveStory(project, "story-over", 3554, { deliveryBranch: "main" });
    const { runGit, commands } = capturingGit();
    const result = finalizeCohort({
      projectRoot: project,
      storyTokens: [storyPath],
      label: "story-over",
      repo: "deftai/directive",
      baseBranch: "develop",
      runGit,
      runGh: mockRunGh({}),
    });
    expect(result.exitCode).toBe(0);
    expect(result.result.ok).toBe(true);
    expect(result.result.delivery_branch).toBe("main");
    expect(result.result.sweep_base).toBe("develop");
    expect(result.stdout).toContain("Delivery branch: main");
    expect(result.stdout).toContain("Sweep base: develop");
    const fetches = commands.filter((c) => c.includes("fetch"));
    expect(fetches.some((c) => c.includes("origin") && c.includes("develop"))).toBe(true);
    expect(fetches.some((c) => c.includes("origin") && c.includes("master"))).toBe(false);
    rmSync(project, { recursive: true, force: true });
  });

  it("omits baseBranch unless --base-branch is passed (space and equals form)", () => {
    const omitted = parseFinalizeCohortArgv(["--stories", "story-a", "--no-commit"]);
    expect(omitted.error).toBeNull();
    expect(omitted.help).toBe(false);
    expect(omitted.baseBranch).toBeUndefined();

    const space = parseFinalizeCohortArgv(["--base-branch", "develop", "--stories", "story-a"]);
    expect(space.error).toBeNull();
    expect(space.baseBranch).toBe("develop");

    const equals = parseFinalizeCohortArgv(["--base-branch=main", "--stories", "story-a"]);
    expect(equals.error).toBeNull();
    expect(equals.baseBranch).toBe("main");
  });

  it("parses remaining value flags in space and equals form", () => {
    const space = parseFinalizeCohortArgv([
      "--pr",
      "9,10",
      "--stories",
      "story-b",
      "--repo",
      "acme/app",
      "--project-root",
      "/tmp/space",
      "--delivery-branch",
      "trunk",
      "--label",
      "wave2",
      "--no-commit",
    ]);
    expect(space.error).toBeNull();
    expect(space.prNumbers).toEqual([9, 10]);
    expect(space.storyTokens).toEqual(["story-b"]);
    expect(space.repo).toBe("acme/app");
    expect(space.projectRoot).toBe("/tmp/space");
    expect(space.deliveryBranch).toBe("trunk");
    expect(space.label).toBe("wave2");
    expect(space.noCommit).toBe(true);

    const parsed = parseFinalizeCohortArgv([
      "--pr=12",
      "--stories=story-a",
      "--repo=deftai/directive",
      "--project-root=/tmp/proj",
      "--delivery-branch=main",
      "--label=wave1",
      "--dry-run",
      "--no-open-pr",
      "--json",
    ]);
    expect(parsed.error).toBeNull();
    expect(parsed.prNumbers).toEqual([12]);
    expect(parsed.storyTokens).toEqual(["story-a"]);
    expect(parsed.repo).toBe("deftai/directive");
    expect(parsed.projectRoot).toBe("/tmp/proj");
    expect(parsed.deliveryBranch).toBe("main");
    expect(parsed.label).toBe("wave1");
    expect(parsed.dryRun).toBe(true);
    expect(parsed.noOpenPr).toBe(true);
    expect(parsed.emitJson).toBe(true);
  });

  it("rejects empty equals-form values as unrecognized arguments", () => {
    for (const flag of ["--base-branch=", "--stories=", "--project-root=", "--label="]) {
      const parsed = parseFinalizeCohortArgv([flag]);
      expect(parsed.error).toBe(`unrecognized argument: ${flag}`);
    }
  });

  it("fails closed on unrecognized arguments including boolean equals forms", () => {
    for (const flag of ["--dry-run=true", "--no-commit=1", "--wat"]) {
      const parsed = parseFinalizeCohortArgv([flag, "--stories", "story-a"]);
      expect(parsed.error).toBe(`unrecognized argument: ${flag}`);
    }
  });

  it("prints usage and exits 0 on --help / -h before any git mutation", () => {
    const chunks: string[] = [];
    const errChunks: string[] = [];
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      chunks.push(String(chunk));
      return true;
    });
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      errChunks.push(String(chunk));
      return true;
    });
    try {
      for (const flag of ["--help", "-h"]) {
        chunks.length = 0;
        const code = finalizeCohortMain([flag, "--project-root", "/definitely-not-a-repo"]);
        expect(code).toBe(EXIT_OK);
        expect(chunks.join("")).toMatch(/Usage:/);
        expect(chunks.join("")).toMatch(/--base-branch/);
      }
      expect(finalizeCohortMain(["--dry-run=true"])).toBe(EXIT_CONFIG_ERROR);
      expect(errChunks.join("")).toContain("unrecognized argument: --dry-run=true");
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
    }
  });
});
