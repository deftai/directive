import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
  issueMeta: Record<number, MockIssueMeta> = {},
): RunGhFn {
  const states: Record<number, "open" | "closed"> = { ...issueStates };
  return (cmd) => {
    const issuePath = cmd.find((part) => part.startsWith("repos/") && part.includes("/issues/"));
    if (issuePath !== undefined) {
      const commentMatch = issuePath.match(/\/issues\/(\d+)\/comments$/);
      if (commentMatch !== null) {
        const issueNumber = Number(commentMatch[1]);
        if (issueMeta[issueNumber]?.commentFail === true) {
          return { returncode: 1, stdout: "", stderr: "comment failed" };
        }
        return { returncode: 0, stdout: JSON.stringify({ id: 1 }), stderr: "" };
      }
      const match = issuePath.match(/\/issues\/(\d+)$/);
      const issueNumber = match ? Number(match[1]) : 0;
      const meta = issueMeta[issueNumber] ?? {};
      if (cmd.includes("PATCH")) {
        if (meta.patchFail === true) {
          return { returncode: 1, stdout: "", stderr: "patch failed" };
        }
        states[issueNumber] = "closed";
        return { returncode: 0, stdout: JSON.stringify({ state: "closed" }), stderr: "" };
      }
      if (meta.getFail === true) {
        return { returncode: 1, stdout: "", stderr: "get failed" };
      }
      const state = states[issueNumber] ?? meta.state ?? "open";
      return {
        returncode: 0,
        stdout: JSON.stringify({
          state,
          title: meta.title ?? "",
          labels: (meta.labels ?? []).map((name) => ({ name })),
        }),
        stderr: "",
      };
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

interface MockIssueMeta {
  readonly state?: "open" | "closed";
  readonly labels?: readonly string[];
  readonly title?: string;
  readonly getFail?: boolean;
  readonly patchFail?: boolean;
  readonly commentFail?: boolean;
}

interface MockGitOpts {
  readonly onCommit?: () => void;
  readonly fetchFail?: boolean;
  readonly lsTreeFail?: boolean;
  readonly showFail?: boolean;
  readonly showMismatchIssue?: number;
  readonly notAncestor?: boolean;
  readonly closedSurfaceAdd?: boolean;
  readonly landedCompleted?: readonly string[];
  readonly ffFail?: boolean;
  readonly checkoutOmitsActive?: boolean;
  readonly worktreeRemoveFail?: boolean;
  readonly landedByRef?: Readonly<Record<string, readonly string[]>>;
}

function mockRunGit(
  opts: MockGitOpts = {},
): (command: readonly string[], options?: { cwd?: string }) => TextCaptureResult {
  let currentBranch = "";
  return (command, options) => {
    const joined = command.join(" ");
    if (command[1] === "worktree" && command[2] === "add") {
      const detachAt = command.indexOf("--detach");
      const dest = detachAt >= 0 ? command[detachAt + 1] : undefined;
      const cwd = options?.cwd;
      if (dest !== undefined && dest.length > 0) {
        mkdirSync(dest, { recursive: true });
        if (cwd !== undefined && existsSync(join(cwd, "xbrief"))) {
          cpSync(join(cwd, "xbrief"), join(dest, "xbrief"), { recursive: true });
          if (opts.checkoutOmitsActive === true) {
            rmSync(join(dest, "xbrief", "active"), { recursive: true, force: true });
          }
        }
      }
      return { returncode: 0, stdout: "", stderr: "" };
    }
    if (joined.includes("--ff-only")) {
      if (opts.ffFail === true) {
        return { returncode: 1, stdout: "", stderr: "Not possible to fast-forward" };
      }
      return { returncode: 0, stdout: "Already up to date\n", stderr: "" };
    }
    if (command[1] === "worktree" && command[2] === "remove") {
      if (opts.worktreeRemoveFail === true) {
        return { returncode: 1, stdout: "", stderr: "worktree remove failed" };
      }
      return { returncode: 0, stdout: "", stderr: "" };
    }
    if (joined.includes("ls-tree")) {
      if (opts.lsTreeFail) {
        return { returncode: 1, stdout: "", stderr: "ls-tree failed" };
      }
      const ref = command.find((part) => part.startsWith("origin/"));
      const names =
        opts.landedByRef !== undefined
          ? ref !== undefined
            ? (opts.landedByRef[ref] ?? [])
            : []
          : (opts.landedCompleted ?? []);
      return {
        returncode: 0,
        stdout: names.join("\n") + (names.length > 0 ? "\n" : ""),
        stderr: "",
      };
    }
    if (command[1] === "show") {
      if (opts.showFail) {
        return { returncode: 1, stdout: "", stderr: "show failed" };
      }
      const spec = String(command[2] ?? "");
      const fromPath = Number((spec.match(/(\d+)/g) ?? []).pop() ?? "0");
      const issue = opts.showMismatchIssue ?? fromPath;
      return {
        returncode: 0,
        stdout: JSON.stringify({
          plan: {
            id: "story",
            references: [
              {
                uri: "https://github.com/deftai/directive/issues/" + String(issue),
                type: "x-xbrief/github-issue",
              },
            ],
          },
        }),
        stderr: "",
      };
    }
    if (opts.closedSurfaceAdd && joined.includes("diff") && joined.includes("--name-status")) {
      return { returncode: 0, stdout: "A\tdocs-site/new.html\n", stderr: "" };
    }
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

  it("dry-run reports FINALIZE INCOMPLETE when acceptance evidence is missing (#4839)", () => {
    const project = mkdtempSync(join(tmpdir(), "sw-finalize-dry-"));
    const storyPath = writeActiveStory(project, "story-dry", 4839);
    const before = readFileSync(storyPath, "utf8");
    const result = finalizeCohort({
      projectRoot: project,
      storyTokens: [storyPath],
      dryRun: true,
      noCommit: true,
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toContain("FINALIZE INCOMPLETE");
    expect(result.stdout).not.toContain("FINALIZE CLEAN");
    expect(result.stdout).toContain("#3240");
    expect(result.stdout).toContain("[FAILED]");
    expect(readFileSync(storyPath, "utf8")).toBe(before);
    expect(vi.mocked(runTransition)).not.toHaveBeenCalled();
    rmSync(project, { recursive: true, force: true });
  });

  it("dry-run reports FINALIZE CLEAN when acceptance evidence passes (#4839)", () => {
    const project = mkdtempSync(join(tmpdir(), "sw-finalize-dry-ok-"));
    const storyPath = writeActiveStory(project, "story-dry-ok", 4839);
    const doc = JSON.parse(readFileSync(storyPath, "utf8")) as {
      plan: { items: Array<Record<string, unknown>> };
    };
    const item = doc.plan.items[0];
    if (item !== undefined) {
      item["x-directive/evidence"] = {
        kind: "test",
        pointer: "packages/core/src/swarm/finalize-cohort.test.ts",
        recorded_at: "2026-09-21T00:00:00Z",
        recorded_by: "vitest",
      };
    }
    writeFileSync(storyPath, JSON.stringify(doc), "utf8");
    const result = finalizeCohort({
      projectRoot: project,
      storyTokens: [storyPath],
      dryRun: true,
      noCommit: true,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("FINALIZE CLEAN");
    expect(result.stdout).toContain("would complete");
    expect(vi.mocked(runTransition)).not.toHaveBeenCalled();
    rmSync(project, { recursive: true, force: true });
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
        landedCompleted: ["xbrief/completed/story-d.xbrief.json"],
      }),
      runGh: mockRunGh({
        9999: { merged: true, closingIssues: [], baseRef: "main" },
      }),
      landProbeLimit: 1,
      sleep: () => {},
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
      if (cmd.some((part) => part.includes("/pulls/9999"))) {
        return {
          returncode: 0,
          stdout: JSON.stringify({ merged_at: "2026-07-02T12:00:00Z", state: "closed" }),
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
      runGit: mockRunGit({ landedCompleted: ["xbrief/completed/story-f.xbrief.json"] }),
      runGh: capturingRunGh,
      landProbeLimit: 1,
      sleep: () => {},
    });
    expect(result.exitCode).toBe(0);
    const createCall = ghCalls.find((c) => c.includes("pr") && c.includes("create"));
    expect(createCall).toBeDefined();
    const baseIdx = createCall?.indexOf("--base") ?? -1;
    expect(baseIdx).toBeGreaterThanOrEqual(0);
    expect(createCall?.[baseIdx + 1]).toBe("develop");
    expect(createCall?.includes("--body")).toBe(false);
    const bodyFileIdx = createCall?.indexOf("--body-file") ?? -1;
    expect(bodyFileIdx).toBeGreaterThanOrEqual(0);
    const uploaded = readFileSync(createCall?.[bodyFileIdx + 1] ?? "", "utf8");
    expect(uploaded).toContain("change_class:");
    expect(uploaded).toContain("surfaces:");
    expect(uploaded).toMatch(/rationale:\s*"/);
    expect(uploaded).toContain("## Summary");
    rmSync(project, { recursive: true, force: true });
  });

  it("refuses PR create when the same body-file fails docs-impact (#4293)", () => {
    const project = mkdtempSync(join(tmpdir(), "sw-finalize-docs-impact-fail-"));
    const storyPath = writeActiveStory(project, "story-docs-fail", 4293);
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
      label: "story-docs-fail",
      repo: "deftai/directive",
      runGit: mockRunGit({ closedSurfaceAdd: true }),
      runGh: capturingRunGh,
      landProbeLimit: 1,
      sleep: () => {},
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.result.errors.some((e) => e.includes("verify:docs-impact"))).toBe(true);
    expect(ghCalls.some((c) => c.includes("pr") && c.includes("create"))).toBe(false);
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
  it("origin-closes leftover --stories after leftover-complete land without scraping Tracking (#4824)", () => {
    const project = mkdtempSync(join(tmpdir(), "sw-finalize-origin-close-"));
    writeCompletedStory(project, "story-4813", 4813);
    const ghCalls: string[][] = [];
    const runGh = mockRunGh(
      {
        4815: {
          merged: true,
          closingIssues: [],
          body: "Tracking #4813\n\nNever Closes #4813",
        },
      },
      { 4813: "open" },
    );
    const capturing: RunGhFn = (cmd) => {
      ghCalls.push([...cmd]);
      return runGh(cmd);
    };
    const result = finalizeCohort({
      projectRoot: project,
      prNumbers: [4815],
      storyTokens: ["4813"],
      repo: "deftai/directive",
      noCommit: true,
      deliveryBranch: "master",
      runGh: capturing,
      runGit: mockRunGit({ landedCompleted: ["xbrief/completed/story-4813.xbrief.json"] }),
    });
    expect(result.exitCode).toBe(0);
    expect(result.result.ok).toBe(true);
    expect(result.result.closing_issues).toEqual([]);
    const patch = ghCalls.find(
      (c) => c.includes("PATCH") && c.some((p) => p.includes("/issues/4813")),
    );
    expect(patch).toBeDefined();
    const comment = ghCalls.find(
      (c) => c.includes("POST") && c.some((p) => p.includes("/issues/4813/comments")),
    );
    expect(comment).toBeDefined();
    expect(comment?.some((p) => p.includes("Completed in #4815"))).toBe(true);
    expect(
      ghCalls.every((c) => !c.includes("issue") || !c.includes("view") || !c.includes("--json")),
    ).toBe(true);
    rmSync(project, { recursive: true, force: true });
  });

  it("refuses DONE when git fetch of deliveryBranch fails (#4824)", () => {
    const project = mkdtempSync(join(tmpdir(), "sw-finalize-fetch-fail-"));
    writeCompletedStory(project, "story-4813", 4813);
    const result = finalizeCohort({
      projectRoot: project,
      prNumbers: [4815],
      storyTokens: ["4813"],
      repo: "deftai/directive",
      noCommit: true,
      deliveryBranch: "master",
      runGh: mockRunGh({ 4815: { merged: true, closingIssues: [] } }, { 4813: "open" }),
      runGit: mockRunGit({
        landedCompleted: ["xbrief/completed/story-4813.xbrief.json"],
        fetchFail: true,
      }),
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.result.errors.some((e) => e.includes("git fetch origin master failed"))).toBe(
      true,
    );
    rmSync(project, { recursive: true, force: true });
  });

  it("refuses DONE when origin completed brief does not reference the story (#4824)", () => {
    const project = mkdtempSync(join(tmpdir(), "sw-finalize-show-mismatch-"));
    writeCompletedStory(project, "story-4813", 4813);
    const result = finalizeCohort({
      projectRoot: project,
      prNumbers: [4815],
      storyTokens: ["4813"],
      repo: "deftai/directive",
      noCommit: true,
      deliveryBranch: "master",
      runGh: mockRunGh({ 4815: { merged: true, closingIssues: [] } }, { 4813: "open" }),
      runGit: mockRunGit({
        landedCompleted: ["xbrief/completed/story-4813.xbrief.json"],
        showMismatchIssue: 9999,
      }),
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.result.errors.some((e) => e.includes("does not reference #4813"))).toBe(true);
    rmSync(project, { recursive: true, force: true });
  });

  it("closes ordinary tracker-titled stories without umbrella labels (#4824)", () => {
    const project = mkdtempSync(join(tmpdir(), "sw-finalize-title-tracker-"));
    writeCompletedStory(project, "story-4813", 4813);
    const ghCalls: string[][] = [];
    const runGh = mockRunGh(
      { 4815: { merged: true, closingIssues: [] } },
      { 4813: "open" },
      { 4813: { title: "Remove legacy tracker" } },
    );
    const capturing = (cmd) => {
      ghCalls.push([...cmd]);
      return runGh(cmd);
    };
    const result = finalizeCohort({
      projectRoot: project,
      prNumbers: [4815],
      storyTokens: ["4813"],
      repo: "deftai/directive",
      noCommit: true,
      deliveryBranch: "master",
      runGh: capturing,
      runGit: mockRunGit({ landedCompleted: ["xbrief/completed/story-4813.xbrief.json"] }),
    });
    expect(result.exitCode).toBe(0);
    expect(
      ghCalls.some((c) => c.includes("PATCH") && c.some((p) => p.includes("/issues/4813"))),
    ).toBe(true);
    rmSync(project, { recursive: true, force: true });
  });

  it("refuses DONE when leftover landed and origin REST GET fails (#4824)", () => {
    const project = mkdtempSync(join(tmpdir(), "sw-finalize-origin-getfail-"));
    writeCompletedStory(project, "story-4813", 4813);
    const result = finalizeCohort({
      projectRoot: project,
      prNumbers: [4815],
      storyTokens: ["4813"],
      repo: "deftai/directive",
      noCommit: true,
      deliveryBranch: "master",
      runGh: mockRunGh(
        { 4815: { merged: true, closingIssues: [] } },
        {},
        { 4813: { getFail: true } },
      ),
      runGit: mockRunGit({ landedCompleted: ["xbrief/completed/story-4813.xbrief.json"] }),
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.result.ok).toBe(false);
    expect(result.result.errors.some((e) => e.includes("refused DONE") && e.includes("4813"))).toBe(
      true,
    );
    rmSync(project, { recursive: true, force: true });
  });

  it("refuses DONE when leftover landed and origin stays open after PATCH (#4824)", () => {
    const project = mkdtempSync(join(tmpdir(), "sw-finalize-origin-patchfail-"));
    writeCompletedStory(project, "story-4813", 4813);
    const result = finalizeCohort({
      projectRoot: project,
      prNumbers: [4815],
      storyTokens: ["4813"],
      repo: "deftai/directive",
      noCommit: true,
      deliveryBranch: "master",
      runGh: mockRunGh(
        { 4815: { merged: true, closingIssues: [] } },
        { 4813: "open" },
        { 4813: { patchFail: true } },
      ),
      runGit: mockRunGit({ landedCompleted: ["xbrief/completed/story-4813.xbrief.json"] }),
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.result.errors.some((e) => e.includes("REST PATCH failed"))).toBe(true);
    rmSync(project, { recursive: true, force: true });
  });

  it("skips protected staying-OPEN umbrellas after leftover land (#4824)", () => {
    const project = mkdtempSync(join(tmpdir(), "sw-finalize-origin-umbrella-"));
    writeCompletedStory(project, "story-701", 701);
    const result = finalizeCohort({
      projectRoot: project,
      prNumbers: [4815],
      storyTokens: ["701"],
      repo: "deftai/directive",
      noCommit: true,
      deliveryBranch: "master",
      runGh: mockRunGh(
        { 4815: { merged: true, closingIssues: [] } },
        { 701: "open" },
        { 701: { labels: ["type:umbrella"], title: "Layer 3 umbrella" } },
      ),
      runGit: mockRunGit({ landedCompleted: ["xbrief/completed/story-701.xbrief.json"] }),
    });
    expect(result.exitCode).toBe(0);
    expect(result.result.ok).toBe(true);
    expect(result.result.warnings.some((w) => w.includes("protected staying-OPEN umbrella"))).toBe(
      true,
    );
    rmSync(project, { recursive: true, force: true });
  });

  it("skips already-closed origins after leftover land (#4824)", () => {
    const project = mkdtempSync(join(tmpdir(), "sw-finalize-origin-closed-"));
    writeCompletedStory(project, "story-4813", 4813);
    const ghCalls: string[][] = [];
    const runGh = mockRunGh({ 4815: { merged: true, closingIssues: [] } }, { 4813: "closed" });
    const capturing: RunGhFn = (cmd) => {
      ghCalls.push([...cmd]);
      return runGh(cmd);
    };
    const result = finalizeCohort({
      projectRoot: project,
      prNumbers: [4815],
      storyTokens: ["4813"],
      repo: "deftai/directive",
      noCommit: true,
      deliveryBranch: "master",
      runGh: capturing,
      runGit: mockRunGit({ landedCompleted: ["xbrief/completed/story-4813.xbrief.json"] }),
    });
    expect(result.exitCode).toBe(0);
    expect(ghCalls.some((c) => c.includes("PATCH"))).toBe(false);
    rmSync(project, { recursive: true, force: true });
  });

  it("refuses DONE when leftover landed and origin comment POST fails (#4824)", () => {
    const project = mkdtempSync(join(tmpdir(), "sw-finalize-origin-commentfail-"));
    writeCompletedStory(project, "story-4813", 4813);
    const result = finalizeCohort({
      projectRoot: project,
      prNumbers: [4815],
      storyTokens: ["4813"],
      repo: "deftai/directive",
      noCommit: true,
      deliveryBranch: "master",
      runGh: mockRunGh(
        { 4815: { merged: true, closingIssues: [] } },
        { 4813: "open" },
        { 4813: { commentFail: true } },
      ),
      runGit: mockRunGit({ landedCompleted: ["xbrief/completed/story-4813.xbrief.json"] }),
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.result.errors.some((e) => e.includes("failed to comment"))).toBe(true);
    rmSync(project, { recursive: true, force: true });
  });

  it("refuses DONE on invalid --repo after leftover land (#4824)", () => {
    const project = mkdtempSync(join(tmpdir(), "sw-finalize-origin-badrepo-"));
    writeCompletedStory(project, "story-4813", 4813);
    const result = finalizeCohort({
      projectRoot: project,
      prNumbers: [4815],
      storyTokens: ["4813"],
      repo: "not-a-repo",
      noCommit: true,
      deliveryBranch: "master",
      runGh: mockRunGh({ 4815: { merged: true, closingIssues: [] } }),
      runGit: mockRunGit({ landedCompleted: ["xbrief/completed/story-4813.xbrief.json"] }),
    });
    expect(result.exitCode).not.toBe(0);
    expect(
      result.result.errors.some(
        (e) => e.includes("invalid --repo") || e.includes("invalid --repo value"),
      ),
    ).toBe(true);
    rmSync(project, { recursive: true, force: true });
  });
  it("skips parked-with-no-merged-PR origin-close (#4824)", () => {
    const project = mkdtempSync(join(tmpdir(), "sw-finalize-origin-parked-"));
    writeCompletedStory(project, "story-4781", 4781);
    const result = finalizeCohort({
      projectRoot: project,
      storyTokens: ["4781"],
      repo: "deftai/directive",
      noCommit: true,
      runGh: mockRunGh({}, { 4781: "open" }),
      runGit: mockRunGit({ landedCompleted: ["xbrief/completed/story-4781.xbrief.json"] }),
    });
    expect(result.exitCode).toBe(0);
    expect(result.result.ok).toBe(true);
    expect(result.result.warnings.some((w) => w.includes("parked-with-no-merged-PR"))).toBe(true);
    rmSync(project, { recursive: true, force: true });
  });

  it("does not origin-close before leftover-complete land (#4824)", () => {
    const project = mkdtempSync(join(tmpdir(), "sw-finalize-origin-noland-"));
    const storyPath = writeActiveStory(project, "story-4813", 4813);
    const ghCalls: string[][] = [];
    const runGh = mockRunGh({ 4815: { merged: true, closingIssues: [4813] } }, { 4813: "open" });
    const capturing: RunGhFn = (cmd) => {
      ghCalls.push([...cmd]);
      return runGh(cmd);
    };
    const result = finalizeCohort({
      projectRoot: project,
      prNumbers: [4815],
      storyTokens: [storyPath],
      repo: "deftai/directive",
      noCommit: true,
      deliveryBranch: "master",
      runGh: capturing,
      runGit: mockRunGit(),
    });
    expect(result.exitCode).toBe(0);
    expect(ghCalls.some((c) => c.includes("PATCH"))).toBe(false);
    expect(result.result.warnings.some((w) => w.includes("leftover-complete not on origin"))).toBe(
      true,
    );
    rmSync(project, { recursive: true, force: true });
  });

  it("does not scrape Tracking/Refs from the product PR body for origin-close (#4824)", () => {
    const project = mkdtempSync(join(tmpdir(), "sw-finalize-origin-noscrape-"));
    writeCompletedStory(project, "story-2115", 2115);
    const ghCalls: string[][] = [];
    const runGh = mockRunGh(
      {
        42: {
          merged: true,
          closingIssues: [],
          body: "Tracking #1997\nRefs #1997",
        },
      },
      { 2115: "open", 1997: "open" },
    );
    const capturing: RunGhFn = (cmd) => {
      ghCalls.push([...cmd]);
      return runGh(cmd);
    };
    const result = finalizeCohort({
      projectRoot: project,
      prNumbers: [42],
      storyTokens: ["2115"],
      repo: "deftai/directive",
      noCommit: true,
      deliveryBranch: "master",
      runGh: capturing,
      runGit: mockRunGit({ landedCompleted: ["xbrief/completed/story-2115.xbrief.json"] }),
    });
    expect(result.exitCode).toBe(0);
    expect(
      ghCalls.some((c) =>
        c.some(
          (part) => part.includes("/issues/2115") && (c.includes("PATCH") || c.includes("POST")),
        ),
      ),
    ).toBe(true);
    expect(ghCalls.some((c) => c.some((part) => part.includes("/issues/1997")))).toBe(false);
    rmSync(project, { recursive: true, force: true });
  });

  it("uses the validated snapshot as delivery evidence when closing refs are empty (#4937)", () => {
    const project = mkdtempSync(join(tmpdir(), "sw-finalize-empty-closing-"));
    const storyPath = writeActiveStory(project, "story-4937", 4937);
    const result = finalizeCohort({
      projectRoot: project,
      storyTokens: [storyPath],
      prNumbers: [42],
      repo: "deftai/directive",
      noCommit: true,
      deliveryBranch: "master",
      runGh: mockRunGh({ 42: { merged: true, closingIssues: [], baseRef: "master" } }),
      runGit: mockRunGit(),
    });
    expect(result.exitCode).toBe(0);
    expect(vi.mocked(runTransition)).toHaveBeenCalledWith(
      "complete",
      storyPath,
      expect.any(Date),
      expect.objectContaining({
        assumeEvidenceValidated: true,
        deliveryEvidence: expect.objectContaining({ prNumber: 42, prBase: "master" }),
      }),
    );
    rmSync(project, { recursive: true, force: true });
  });

  it("does not attach delivery evidence when only issue N is passed (#4937)", () => {
    const project = mkdtempSync(join(tmpdir(), "sw-finalize-n-alone-"));
    const storyPath = writeActiveStory(project, "story-4937", 4937);
    const result = finalizeCohort({
      projectRoot: project,
      storyTokens: [storyPath],
      noCommit: true,
      deliveryBranch: "master",
      runGit: mockRunGit(),
    });
    expect(result.result.warnings.some((w) => w.includes("No --pr supplied"))).toBe(true);
    const delivery = vi.mocked(runTransition).mock.calls[0]?.[3] as
      | { deliveryEvidence?: unknown }
      | undefined;
    expect(delivery?.deliveryEvidence).toBeUndefined();
    rmSync(project, { recursive: true, force: true });
  });

  it("does not treat pull request M alone as the invocation when closing refs are empty (#4937)", () => {
    const project = mkdtempSync(join(tmpdir(), "sw-finalize-m-alone-"));
    writeActiveStory(project, "story-4937", 4937);
    const result = finalizeCohort({
      projectRoot: project,
      prNumbers: [42],
      repo: "deftai/directive",
      noCommit: true,
      deliveryBranch: "master",
      runGh: mockRunGh({ 42: { merged: true, closingIssues: [], baseRef: "master" } }),
      runGit: mockRunGit(),
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.result.errors.some((e) => e.includes("empty cohort"))).toBe(true);
    expect(vi.mocked(runTransition)).not.toHaveBeenCalled();
    rmSync(project, { recursive: true, force: true });
  });

  it("does not attach one snapshot when two validated pull requests have empty closing refs (#4937)", () => {
    const project = mkdtempSync(join(tmpdir(), "sw-finalize-two-pr-"));
    const storyPath = writeActiveStory(project, "story-4937", 4937);
    finalizeCohort({
      projectRoot: project,
      storyTokens: [storyPath],
      prNumbers: [42, 43],
      repo: "deftai/directive",
      noCommit: true,
      deliveryBranch: "master",
      runGh: mockRunGh({
        42: { merged: true, closingIssues: [], baseRef: "master" },
        43: { merged: true, closingIssues: [], baseRef: "master" },
      }),
      runGit: mockRunGit(),
    });
    const delivery = vi.mocked(runTransition).mock.calls[0]?.[3] as
      | { deliveryEvidence?: unknown }
      | undefined;
    expect(delivery?.deliveryEvidence).toBeUndefined();
    rmSync(project, { recursive: true, force: true });
  });

  it("leaves the implement brief unmoved when the lifecycle fast-forward fails (#4937)", () => {
    const project = mkdtempSync(join(tmpdir(), "sw-finalize-ff-"));
    const storyPath = writeActiveStory(project, "story-4937", 4937);
    const before = readFileSync(storyPath, "utf8");
    const calls: { cmd: string[]; cwd?: string }[] = [];
    const inner = mockRunGit({ ffFail: true });
    const result = finalizeCohort({
      projectRoot: project,
      storyTokens: [storyPath],
      label: "ff-fail",
      repo: "deftai/directive",
      deliveryBranch: "master",
      landProbeLimit: 1,
      sleep: () => {},
      runGit: (command, options) => {
        calls.push({ cmd: [...command], cwd: options?.cwd });
        return inner(command, options);
      },
      runGh: mockRunGh({}),
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.result.errors.some((e) => e.toLowerCase().includes("fast-forward"))).toBe(true);
    expect(vi.mocked(runTransition)).not.toHaveBeenCalled();
    expect(readFileSync(storyPath, "utf8")).toBe(before);
    const merges = calls.filter((call) => call.cmd.includes("--ff-only"));
    expect(merges.length).toBeGreaterThan(0);
    expect(merges.every((call) => call.cwd !== project)).toBe(true);
    rmSync(project, { recursive: true, force: true });
  });

  it("commits the lifecycle move in the delivery checkout, not the implement tree (#4937)", () => {
    const project = mkdtempSync(join(tmpdir(), "sw-finalize-checkout-"));
    const storyPath = writeActiveStory(project, "story-4937", 4937);
    const before = readFileSync(storyPath, "utf8");
    const calls: { cmd: string[]; cwd?: string }[] = [];
    const inner = mockRunGit({
      landedCompleted: ["xbrief/completed/story-4937.xbrief.json"],
    });
    const result = finalizeCohort({
      projectRoot: project,
      storyTokens: [storyPath],
      label: "story-4937",
      repo: "deftai/directive",
      deliveryBranch: "master",
      landProbeLimit: 1,
      sleep: () => {},
      runGit: (command, options) => {
        calls.push({ cmd: [...command], cwd: options?.cwd });
        return inner(command, options);
      },
      runGh: mockRunGh({
        9999: { merged: true, closingIssues: [], baseRef: "master" },
      }),
    });
    expect(result.exitCode).toBe(0);
    expect(result.result.branch).toBe("swarm/finalize/story-4937");
    const commit = calls.find((call) => call.cmd.includes("commit"));
    const created = calls.find((call) => call.cmd.includes("switch"));
    expect(commit?.cwd).toBeDefined();
    expect(commit?.cwd).not.toBe(project);
    expect(created?.cwd).not.toBe(project);
    const swept = vi.mocked(runTransition).mock.calls[0]?.[1];
    expect(typeof swept).toBe("string");
    expect(String(swept).startsWith(project)).toBe(false);
    expect(readFileSync(storyPath, "utf8")).toBe(before);
    rmSync(project, { recursive: true, force: true });
  });

  it("does not origin-close or merge before the lifecycle pull request lands (#4937)", () => {
    const project = mkdtempSync(join(tmpdir(), "sw-finalize-wait-"));
    const storyPath = writeActiveStory(project, "story-4937", 4937);
    const ghCalls: string[][] = [];
    const runGh = mockRunGh(
      { 42: { merged: true, closingIssues: [], baseRef: "master" } },
      { 4937: "open" },
    );
    const result = finalizeCohort({
      projectRoot: project,
      storyTokens: [storyPath],
      prNumbers: [42],
      label: "story-4937",
      repo: "deftai/directive",
      deliveryBranch: "master",
      landProbeLimit: 2,
      sleep: () => {},
      runGit: mockRunGit(),
      runGh: (cmd) => {
        ghCalls.push([...cmd]);
        return runGh(cmd);
      },
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.result.errors.some((e) => e.includes("does not merge"))).toBe(true);
    expect(ghCalls.some((cmd) => cmd.includes("PATCH"))).toBe(false);
    expect(ghCalls.some((cmd) => cmd.includes("merge"))).toBe(false);
    expect(existsSync(storyPath)).toBe(true);
    rmSync(project, { recursive: true, force: true });
  });

  it("origin-closes with N and M after the lifecycle pull request lands (#4937)", () => {
    const project = mkdtempSync(join(tmpdir(), "sw-finalize-landed-"));
    const storyPath = writeActiveStory(project, "story-4937", 4937);
    writeCompletedStory(project, "story-4937", 4937);
    const ghCalls: string[][] = [];
    const runGh = mockRunGh(
      {
        42: { merged: true, closingIssues: [], baseRef: "master" },
        9999: { merged: true, closingIssues: [], baseRef: "master" },
      },
      { 4937: "open" },
    );
    const result = finalizeCohort({
      projectRoot: project,
      storyTokens: [storyPath],
      prNumbers: [42],
      label: "story-4937",
      repo: "deftai/directive",
      deliveryBranch: "master",
      landProbeLimit: 1,
      sleep: () => {},
      runGit: mockRunGit({
        landedCompleted: ["xbrief/completed/story-4937.xbrief.json"],
      }),
      runGh: (cmd) => {
        ghCalls.push([...cmd]);
        return runGh(cmd);
      },
    });
    expect(result.exitCode).toBe(0);
    const comment = ghCalls.find((cmd) => cmd.includes("POST"));
    expect(comment?.some((part) => part.includes("Completed in #42"))).toBe(true);
    expect(comment?.some((part) => part.includes("#9999"))).toBe(false);
    expect(
      ghCalls.some(
        (cmd) => cmd.includes("PATCH") && cmd.some((part) => part.includes("/issues/4937")),
      ),
    ).toBe(true);
    expect(ghCalls.some((cmd) => cmd.includes("merge"))).toBe(false);
    rmSync(project, { recursive: true, force: true });
  });

  it("origin-closes without moving the implement brief when the completed file is already on the delivery branch (#4937)", () => {
    const project = mkdtempSync(join(tmpdir(), "sw-finalize-already-"));
    const storyPath = writeActiveStory(project, "story-4937", 4937);
    const before = readFileSync(storyPath, "utf8");
    writeCompletedStory(project, "story-4937", 4937);
    const ghCalls: string[][] = [];
    const runGh = mockRunGh(
      { 42: { merged: true, closingIssues: [], baseRef: "master" } },
      { 4937: "open" },
    );
    const result = finalizeCohort({
      projectRoot: project,
      storyTokens: [storyPath],
      prNumbers: [42],
      repo: "deftai/directive",
      deliveryBranch: "master",
      landProbeLimit: 1,
      sleep: () => {},
      runGit: mockRunGit({
        checkoutOmitsActive: true,
        landedCompleted: ["xbrief/completed/story-4937.xbrief.json"],
      }),
      runGh: (cmd) => {
        ghCalls.push([...cmd]);
        return runGh(cmd);
      },
    });
    expect(result.exitCode).toBe(0);
    expect(vi.mocked(runTransition)).not.toHaveBeenCalled();
    expect(readFileSync(storyPath, "utf8")).toBe(before);
    expect(ghCalls.some((cmd) => cmd.includes("pr") && cmd.includes("create"))).toBe(false);
    expect(
      ghCalls.some(
        (cmd) => cmd.includes("PATCH") && cmd.some((part) => part.includes("/issues/4937")),
      ),
    ).toBe(true);
    rmSync(project, { recursive: true, force: true });
  });

  it("waits on the branch the lifecycle pull request merges into when --base-branch differs (#4937)", () => {
    const project = mkdtempSync(join(tmpdir(), "sw-finalize-alt-base-"));
    const storyPath = writeActiveStory(project, "story-4937", 4937, { deliveryBranch: "main" });
    writeCompletedStory(project, "story-4937", 4937);
    const completed = "xbrief/completed/story-4937.xbrief.json";
    const trees: string[] = [];
    const shows: string[] = [];
    const ghCalls: string[][] = [];
    const inner = mockRunGit({
      landedByRef: {
        "origin/release": [completed],
      },
    });
    const innerGh = mockRunGh(
      {
        42: { merged: true, closingIssues: [], baseRef: "main" },
        9999: { merged: true, closingIssues: [], baseRef: "release" },
      },
      { 4937: "open" },
    );
    const result = finalizeCohort({
      projectRoot: project,
      storyTokens: [storyPath],
      prNumbers: [42],
      label: "story-alt",
      repo: "deftai/directive",
      baseBranch: "develop",
      landProbeLimit: 1,
      sleep: () => {},
      runGit: (command, options) => {
        if (command.includes("ls-tree")) {
          const ref = command.find((part) => part.startsWith("origin/"));
          if (ref !== undefined) {
            trees.push(ref);
          }
        }
        if (command[1] === "show") {
          shows.push(String(command[2] ?? ""));
        }
        return inner(command, options);
      },
      runGh: (cmd) => {
        ghCalls.push([...cmd]);
        return innerGh(cmd);
      },
    });
    expect(result.exitCode).toBe(0);
    expect(result.result.ok).toBe(true);
    expect(result.result.delivery_branch).toBe("main");
    expect(result.result.sweep_base).toBe("develop");
    expect(trees).toContain("origin/release");
    expect(shows.some((spec) => spec.startsWith("origin/release:"))).toBe(true);
    expect(shows.some((spec) => spec.startsWith("origin/main:"))).toBe(false);
    expect(
      ghCalls.some(
        (cmd) => cmd.includes("PATCH") && cmd.some((part) => part.includes("/issues/4937")),
      ),
    ).toBe(true);
    expect(result.result.errors.some((e) => e.includes("origin/main"))).toBe(false);
    expect(result.result.errors.some((e) => e.includes("Issue not closed"))).toBe(false);
    rmSync(project, { recursive: true, force: true });
  });

  it("still requires the completed file on the delivery branch when no alternate base is passed (#4937)", () => {
    const project = mkdtempSync(join(tmpdir(), "sw-finalize-no-alt-"));
    const storyPath = writeActiveStory(project, "story-keep", 4937, { deliveryBranch: "main" });
    const trees: string[] = [];
    const inner = mockRunGit({
      landedByRef: {
        "origin/develop": ["xbrief/completed/story-keep.xbrief.json"],
      },
    });
    const result = finalizeCohort({
      projectRoot: project,
      storyTokens: [storyPath],
      prNumbers: [42],
      label: "story-keep",
      repo: "deftai/directive",
      landProbeLimit: 1,
      sleep: () => {},
      runGit: (command, options) => {
        if (command.includes("ls-tree")) {
          const ref = command.find((part) => part.startsWith("origin/"));
          if (ref !== undefined) {
            trees.push(ref);
          }
        }
        return inner(command, options);
      },
      runGh: mockRunGh({
        42: { merged: true, closingIssues: [], baseRef: "main" },
        9999: { merged: true, closingIssues: [], baseRef: "develop" },
      }),
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.result.errors.some((e) => e.includes("origin/main"))).toBe(true);
    expect(result.result.errors.some((e) => e.includes("does not merge"))).toBe(true);
    expect(trees).toContain("origin/main");
    rmSync(project, { recursive: true, force: true });
  });

  it("reports a successful lifecycle commit and leaves the issue open when --no-open-pr is set (#4937)", () => {
    const project = mkdtempSync(join(tmpdir(), "sw-finalize-no-pr-"));
    const storyPath = writeActiveStory(project, "story-4937", 4937);
    const ghCalls: string[][] = [];
    const runGh = mockRunGh(
      { 42: { merged: true, closingIssues: [], baseRef: "master" } },
      { 4937: "open" },
    );
    const result = finalizeCohort({
      projectRoot: project,
      storyTokens: [storyPath],
      prNumbers: [42],
      label: "story-4937",
      repo: "deftai/directive",
      deliveryBranch: "master",
      noOpenPr: true,
      landProbeLimit: 1,
      sleep: () => {},
      runGit: mockRunGit(),
      runGh: (cmd) => {
        ghCalls.push([...cmd]);
        return runGh(cmd);
      },
    });
    expect(result.exitCode).toBe(0);
    expect(result.result.ok).toBe(true);
    expect(result.result.commit_sha).toBe("abc123");
    expect(result.result.pr_url).toBeNull();
    expect(result.stdout).toContain("Lifecycle commit succeeded");
    expect(result.stdout).toContain("Issue not closed");
    expect(result.stdout).toContain("no pull request was opened");
    expect(result.stdout).toContain("not yet on origin/master");
    expect(result.stdout).not.toContain("FINALIZE INCOMPLETE");
    expect(ghCalls.some((cmd) => cmd.includes("pr") && cmd.includes("create"))).toBe(false);
    expect(ghCalls.some((cmd) => cmd.includes("PATCH"))).toBe(false);
    expect(ghCalls.some((cmd) => cmd.includes("merge"))).toBe(false);
    rmSync(project, { recursive: true, force: true });
  });

  it("leaves the checkout in place when worktree remove fails (#4937)", () => {
    const project = mkdtempSync(join(tmpdir(), "sw-finalize-wt-"));
    const storyPath = writeActiveStory(project, "story-4937", 4937);
    let checkout = "";
    const inner = mockRunGit({
      worktreeRemoveFail: true,
      landedCompleted: ["xbrief/completed/story-4937.xbrief.json"],
    });
    const result = finalizeCohort({
      projectRoot: project,
      storyTokens: [storyPath],
      label: "story-4937",
      repo: "deftai/directive",
      deliveryBranch: "master",
      landProbeLimit: 1,
      sleep: () => {},
      runGit: (command, options) => {
        if (command[1] === "worktree" && command[2] === "add") {
          const detachAt = command.indexOf("--detach");
          checkout = command[detachAt + 1] ?? "";
        }
        return inner(command, options);
      },
      runGh: mockRunGh({
        9999: { merged: true, closingIssues: [], baseRef: "master" },
      }),
    });
    expect(checkout.length).toBeGreaterThan(0);
    expect(existsSync(checkout)).toBe(true);
    expect(result.exitCode).not.toBe(0);
    expect(result.result.errors.some((error) => error.includes("worktree remove"))).toBe(true);
    expect(result.result.errors.some((error) => error.includes("still registered"))).toBe(true);
    rmSync(dirname(checkout), { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  });

  it("does not delete the checkout when worktree remove fails after a fast-forward failure (#4937)", () => {
    const project = mkdtempSync(join(tmpdir(), "sw-finalize-wt-ff-"));
    const storyPath = writeActiveStory(project, "story-4937", 4937);
    let checkout = "";
    const inner = mockRunGit({ ffFail: true, worktreeRemoveFail: true });
    const result = finalizeCohort({
      projectRoot: project,
      storyTokens: [storyPath],
      label: "story-4937",
      repo: "deftai/directive",
      deliveryBranch: "master",
      landProbeLimit: 1,
      sleep: () => {},
      runGit: (command, options) => {
        if (command[1] === "worktree" && command[2] === "add") {
          const detachAt = command.indexOf("--detach");
          checkout = command[detachAt + 1] ?? "";
        }
        return inner(command, options);
      },
      runGh: mockRunGh({}),
    });
    expect(checkout.length).toBeGreaterThan(0);
    expect(existsSync(checkout)).toBe(true);
    expect(result.exitCode).not.toBe(0);
    expect(result.result.errors.some((error) => error.toLowerCase().includes("fast-forward"))).toBe(
      true,
    );
    expect(result.result.errors.some((error) => error.includes("worktree remove"))).toBe(true);
    expect(result.result.errors.some((error) => error.includes("still registered"))).toBe(true);
    rmSync(dirname(checkout), { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  });

  it("fails immediately when the lifecycle pull request status is null or not an object (#4937)", () => {
    for (const stdout of ["null", '"nope"', "[]", "1", "true"]) {
      const project = mkdtempSync(join(tmpdir(), "sw-finalize-null-pr-"));
      const storyPath = writeActiveStory(project, "story-4937", 4937);
      const inner = mockRunGh({
        42: { merged: true, closingIssues: [], baseRef: "master" },
      });
      const sleeps: number[] = [];
      let statusReads = 0;
      const result = finalizeCohort({
        projectRoot: project,
        storyTokens: [storyPath],
        prNumbers: [42],
        label: "story-4937",
        repo: "deftai/directive",
        deliveryBranch: "master",
        landProbeLimit: 120,
        sleep: (ms) => {
          sleeps.push(ms);
        },
        runGit: mockRunGit(),
        runGh: (cmd) => {
          const path = cmd.find((part) => part.startsWith("repos/") && part.includes("/pulls/"));
          if (path?.endsWith("/pulls/9999") === true) {
            statusReads += 1;
            return { returncode: 0, stdout, stderr: "" };
          }
          return inner(cmd);
        },
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.result.errors.some((error) => error.includes("unreadable"))).toBe(true);
      expect(result.result.errors.some((error) => error.includes("does not merge"))).toBe(true);
      expect(statusReads).toBe(1);
      expect(sleeps).toEqual([]);
      rmSync(project, { recursive: true, force: true });
    }
  });
});

describe("finalize-cohort sweep base and argv (#3554)", () => {
  function capturingGit(opts: MockGitOpts = {}): {
    runGit: (command: readonly string[], options?: { cwd?: string }) => TextCaptureResult;
    commands: string[][];
  } {
    const commands: string[][] = [];
    const inner = mockRunGit(opts);
    return {
      commands,
      runGit: (command, options) => {
        commands.push([...command]);
        return inner(command, options);
      },
    };
  }

  it("defaults sweep base to the resolved delivery branch and does not fetch origin/master", () => {
    const project = mkdtempSync(join(tmpdir(), "sw-finalize-main-"));
    const storyPath = writeActiveStory(project, "story-main", 3554, { deliveryBranch: "main" });
    const { runGit, commands } = capturingGit({
      landedCompleted: ["xbrief/completed/story-main.xbrief.json"],
    });
    const result = finalizeCohort({
      projectRoot: project,
      storyTokens: [storyPath],
      label: "story-main",
      repo: "deftai/directive",
      runGit,
      runGh: mockRunGh({
        9999: { merged: true, closingIssues: [], baseRef: "main" },
      }),
      landProbeLimit: 1,
      sleep: () => {},
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
    const { runGit, commands } = capturingGit({
      landedCompleted: ["xbrief/completed/story-over.xbrief.json"],
    });
    const result = finalizeCohort({
      projectRoot: project,
      storyTokens: [storyPath],
      label: "story-over",
      repo: "deftai/directive",
      baseBranch: "develop",
      runGit,
      runGh: mockRunGh({
        9999: { merged: true, closingIssues: [], baseRef: "main" },
      }),
      landProbeLimit: 1,
      sleep: () => {},
    });
    expect(result.exitCode).toBe(0);
    expect(result.result.ok).toBe(true);
    expect(result.result.delivery_branch).toBe("main");
    expect(result.result.sweep_base).toBe("develop");
    expect(result.stdout).toContain("Delivery branch: main");
    expect(result.stdout).toContain("Sweep base: develop");
    const fetches = commands.filter((c) => c.includes("fetch"));
    expect(fetches.some((c) => c.includes("origin") && c.includes("main"))).toBe(true);
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
    for (const flag of [
      "--base-branch=",
      "--stories=",
      "--project-root=",
      "--label=",
      "--pr=",
      "--repo=",
      "--delivery-branch=",
    ]) {
      const parsed = parseFinalizeCohortArgv([flag, "--stories", "story-a"]);
      expect(parsed.error).toBe(`unrecognized argument: ${flag}`);
    }
  });

  it("fails closed on malformed nonempty --pr tokens", () => {
    expect(parseFinalizeCohortArgv(["--pr=abc", "--stories", "story-a"]).error).toBe(
      "unrecognized argument: --pr=abc",
    );
    expect(parseFinalizeCohortArgv(["--pr=12,abc", "--stories", "story-a"]).error).toBe(
      "unrecognized argument: --pr=12,abc",
    );
    expect(parseFinalizeCohortArgv(["--pr", "12,abc"]).error).toBe("unrecognized argument: --pr");
  });

  it("fails closed when a value flag is followed by another flag instead of a value", () => {
    const parsed = parseFinalizeCohortArgv(["--base-branch", "--dry-run", "--stories", "story-a"]);
    expect(parsed.error).toBe("unrecognized argument: --base-branch");
    expect(parsed.dryRun).toBe(true);
    expect(parsed.baseBranch).toBeUndefined();
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
