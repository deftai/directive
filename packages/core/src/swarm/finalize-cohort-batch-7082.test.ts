import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// #7082: the in-PR completion runs the real transition; the batch sweep uses a
// fake one (as finalize-cohort.test.ts does) so no delivery join is needed.
const transitionMode = vi.hoisted(() => ({ real: false }));
vi.mock("../scope/transition.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../scope/transition.js")>();
  return {
    ...actual,
    runTransition: vi.fn((...args: Parameters<typeof actual.runTransition>) =>
      transitionMode.real ? actual.runTransition(...args) : { ok: true, message: `${args[0]} ok` },
    ),
  };
});

import { evaluateProspectiveScopeCover } from "../hooks/dispatcher.js";
import { evaluateCompletedTracked } from "../lifecycle/completed-tracked-on-delivery.js";
import { evaluate as evaluateOrphanActive } from "../orphan-active/evaluate.js";
import { findAllClosingKeywordHits } from "../pr-closing-keywords/detect.js";
import { evaluateStoryLineRequirement, isLeftoverShapedDiff } from "../pr-closing-keywords/main.js";
import type { RunGhFn } from "../pr-protected-issues/types.js";
import { isDeliveryBriefLandExcluded, type MergeTimeForge } from "../scope/delivery-evidence.js";
import { IN_PR_POST_MERGE_PATH } from "../scope/lands-with-product.js";
import { LANDS_WITH_PRODUCT } from "../scope/lifecycle-write.js";
import { runTransition } from "../scope/transition.js";
import { EXIT_INCOMPLETE, EXIT_OK } from "./constants.js";
import { finalizeCohort } from "./finalize-cohort.js";
import { parseFinalizeCohortArgv } from "./finalize-cohort-cli.js";
import type { TextCaptureResult } from "./subprocess.js";

const REPO = "deftai/directive";
const roots: string[] = [];

function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function storyName(issue: number): string {
  return `story-${String(issue)}.xbrief.json`;
}

/** A clause-bearing story brief the #6277 in-PR completion can admit. */
function writeStory(
  project: string,
  folder: "active" | "completed",
  issue: number,
  itemExtra: Record<string, unknown> = {},
): string {
  mkdirSync(join(project, "xbrief", folder), { recursive: true });
  writeFileSync(
    join(project, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
    JSON.stringify({
      xBRIEFInfo: { version: "0.8" },
      plan: { title: "Project", status: "running", policy: { allowDirectCommitsToMaster: false } },
    }),
    "utf8",
  );
  const path = join(project, "xbrief", folder, storyName(issue));
  writeFileSync(
    path,
    JSON.stringify({
      xBRIEFInfo: { version: "0.8" },
      plan: {
        id: `github.issue.${String(issue)}`,
        title: `story ${String(issue)}`,
        status: folder === "active" ? "running" : "completed",
        references: [
          {
            uri: `https://github.com/${REPO}/issues/${String(issue)}`,
            type: "x-xbrief/github-issue",
          },
        ],
        acceptance: {
          commands: [],
          none_stated: true,
          source_rung: "derived",
          ambiguity_attestation: "none_found",
          clauses: [{ id: 1, text: "Given x, then y.", artifact_path: null, ambiguous: false }],
        },
        items: [
          {
            id: "clause.1",
            title: "Given x, then y.",
            status: "pending",
            "x-directive/evidence": {
              kind: "test",
              pointer: "src/app.test.ts",
              recorded_at: "2026-11-22T00:00:00Z",
              recorded_by: "vitest",
            },
            ...itemExtra,
          },
        ],
        metadata: { swarm: { file_scope: ["src/app.ts"] } },
      },
    }),
    "utf8",
  );
  return path;
}

interface MockPr {
  readonly merged: boolean;
  readonly body: string;
  readonly closingIssues?: readonly number[];
}

function mockRunGh(
  prs: Record<number, MockPr>,
  issueStates: Record<number, "open" | "closed">,
  calls: string[][],
): RunGhFn {
  const states = { ...issueStates };
  return (cmd) => {
    calls.push([...cmd]);
    const issuePath = cmd.find((part) => part.startsWith("repos/") && part.includes("/issues/"));
    if (issuePath !== undefined) {
      if (/\/comments$/.test(issuePath)) {
        return { returncode: 0, stdout: JSON.stringify({ id: 1 }), stderr: "" };
      }
      const issue = Number(issuePath.match(/\/issues\/(\d+)$/)?.[1] ?? "0");
      if (cmd.includes("PATCH")) {
        states[issue] = "closed";
        return { returncode: 0, stdout: JSON.stringify({ state: "closed" }), stderr: "" };
      }
      return {
        returncode: 0,
        stdout: JSON.stringify({ state: states[issue] ?? "open", title: "", labels: [] }),
        stderr: "",
      };
    }
    if (cmd.includes("pr") && cmd.includes("view") && cmd.includes("closingIssuesReferences")) {
      const pr = prs[Number(cmd[cmd.indexOf("view") + 1])];
      if (pr === undefined) return { returncode: 1, stdout: "", stderr: "not found" };
      const refs = (pr.closingIssues ?? []).map((n) => ({ number: n }));
      return {
        returncode: 0,
        stdout: JSON.stringify({ closingIssuesReferences: refs }),
        stderr: "",
      };
    }
    const pullPath = cmd.find((part) => part.startsWith("repos/") && part.includes("/pulls/"));
    if (pullPath !== undefined) {
      const pr = prs[Number(pullPath.match(/\/pulls\/(\d+)$/)?.[1] ?? "0")];
      if (pr === undefined) return { returncode: 1, stdout: "", stderr: "not found" };
      return {
        returncode: 0,
        stdout: JSON.stringify({
          merged_at: pr.merged ? "2026-11-22T12:00:00Z" : null,
          state: pr.merged ? "closed" : "open",
          body: pr.body,
          base: { ref: "master" },
          head: { sha: "headsha000000000000000000000000000000001" },
          merge_commit_sha: pr.merged ? "deadbeefdelivery000000000000000000000001" : null,
        }),
        stderr: "",
      };
    }
    if (cmd.includes("pr") && cmd.includes("create")) {
      return { returncode: 0, stdout: `https://github.com/${REPO}/pull/9999`, stderr: "" };
    }
    return { returncode: 0, stdout: "", stderr: "" };
  };
}

/** Offline git for the lifecycle checkout, land probe and origin-close reads. */
function mockRunGit(
  landedCompleted: readonly string[],
  calls: string[][],
): (command: readonly string[], options?: { cwd?: string }) => TextCaptureResult {
  let branch = "";
  return (command, options) => {
    calls.push([...command]);
    const joined = command.join(" ");
    const ok = (stdout = ""): TextCaptureResult => ({ returncode: 0, stdout, stderr: "" });
    if (command[1] === "worktree" && command[2] === "add") {
      const dest = command[command.indexOf("--detach") + 1];
      if (dest !== undefined) {
        mkdirSync(dest, { recursive: true });
        const cwd = options?.cwd;
        if (cwd !== undefined && existsSync(join(cwd, "xbrief"))) {
          cpSync(join(cwd, "xbrief"), join(dest, "xbrief"), { recursive: true });
        }
      }
      return ok();
    }
    if (joined.includes("ls-tree")) {
      return ok(landedCompleted.length > 0 ? `${landedCompleted.join("\n")}\n` : "");
    }
    if (command[1] === "show") {
      const issue = Number((String(command[2] ?? "").match(/(\d+)/g) ?? []).pop() ?? "0");
      return ok(
        JSON.stringify({
          plan: {
            id: "story",
            references: [
              {
                uri: `https://github.com/${REPO}/issues/${String(issue)}`,
                type: "x-xbrief/github-issue",
              },
            ],
          },
        }),
      );
    }
    if (joined.includes("git switch -c")) {
      branch = command[command.length - 1] ?? "";
      return ok();
    }
    if (joined.includes("git symbolic-ref")) {
      return branch.length > 0 ? ok(`${branch}\n`) : { returncode: 1, stdout: "", stderr: "x" };
    }
    if (joined.includes("git rev-parse") && joined.includes("origin/")) {
      return ok("deliverytip000000000000000000000000001\n");
    }
    if (joined.includes("git rev-parse")) return ok("abc123\n");
    if (joined.includes("--ff-only")) return ok("Already up to date\n");
    return ok();
  };
}

/** Offline forge for the #6317 same-mark scan. */
function markForge(): MergeTimeForge {
  const page = <T>(nodes: readonly T[]) => ({
    ok: true as const,
    nodes,
    hasNextPage: false,
    endCursor: null,
  });
  return {
    listMergedPrsPage: () => page([]),
    fetchBodyRevisionsPage: () => page([]),
    fetchConnectionEventsPage: () => page([]),
    fetchPrFilesPage: () => page([{ status: "modified", filename: "src/app.ts" }]),
    probeRateLimit: () => ({ graphqlRemaining: 5000, coreRemaining: 5000 }),
    nowMs: () => 0,
  };
}

const productFiles = () => [{ status: "modified", filename: "src/app.ts" }];

beforeEach(() => {
  transitionMode.real = false;
  vi.mocked(runTransition).mockClear();
});

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("cohort lifecycle: in-PR completion first (#7082 clauses 1, 5)", () => {
  it("completes an admitted story in its product PR; the closer then opens no lifecycle PR", () => {
    const project = tempRoot("w7082-inpr-");
    const active = writeStory(project, "active", 7101);
    transitionMode.real = true;
    const inPr = runTransition("complete", active, new Date("2026-11-22T01:00:00Z"), {
      inPr: true,
      inPrChangedPaths: ["src/app.ts", `xbrief/active/${storyName(7101)}`],
      skipAcceptanceEvidenceGate: true,
    });
    transitionMode.real = false;
    expect(inPr.ok, inPr.message).toBe(true);
    const done = join(project, "xbrief", "completed", storyName(7101));
    const plan = (JSON.parse(readFileSync(done, "utf8")) as { plan: Record<string, unknown> }).plan;
    expect((plan.metadata as Record<string, unknown>).lifecycleWrite).toMatchObject({
      completionDisposition: LANDS_WITH_PRODUCT,
    });

    // The product PR carries the closing keyword the in-PR verb requires.
    const gh: string[][] = [];
    const git: string[][] = [];
    const result = finalizeCohort({
      projectRoot: project,
      prNumbers: [101],
      cohortStories: ["7101"],
      repo: REPO,
      deliveryBranch: "master",
      runGh: mockRunGh(
        { 101: { merged: true, body: "Closes #7101", closingIssues: [7101] } },
        { 7101: "closed" },
        gh,
      ),
      runGit: mockRunGit([], git),
      landProbeLimit: 1,
      sleep: () => {},
    });
    expect(result.result.errors).toEqual([]);
    expect(result.exitCode).toBe(EXIT_OK);
    expect(result.result.story_paths).toEqual([]);
    expect(result.result.left_active).toEqual([]);
    expect(gh.some((c) => c.includes("pr") && c.includes("create"))).toBe(false);
    expect(git.some((c) => c.includes("commit"))).toBe(false);
    expect(vi.mocked(runTransition)).toHaveBeenCalledTimes(1);
  });

  it("names a cohort story no listed PR binds when only in-PR stories merged", () => {
    const project = tempRoot("w7082-inpr-left-");
    writeStory(project, "completed", 7101);
    const left = writeStory(project, "active", 7104);
    const gh: string[][] = [];
    const result = finalizeCohort({
      projectRoot: project,
      prNumbers: [101],
      cohortStories: ["7101", "7104"],
      repo: REPO,
      deliveryBranch: "master",
      runGh: mockRunGh(
        { 101: { merged: true, body: "Closes #7101", closingIssues: [7101] } },
        { 7101: "closed", 7104: "open" },
        gh,
      ),
      runGit: mockRunGit([], []),
    });
    expect(result.result.errors).toEqual([]);
    expect(result.exitCode).toBe(EXIT_INCOMPLETE);
    expect(result.result.left_active).toEqual([{ story: "#7104", issue: 7104, reason: "omitted" }]);
    expect(result.stdout).toContain(
      "Result: FINALIZE INCOMPLETE -- cohort stories left active for a later run: #7104 (omitted).",
    );
    expect(existsSync(left)).toBe(true);
    expect(gh.some((c) => c.includes("pr") && c.includes("create"))).toBe(false);
  });

  it("treats a member completed on the delivery tip as done when the closer's checkout is stale", () => {
    const project = tempRoot("w7082-stale-");
    writeStory(project, "active", 7101); // stale: completed in its product PR upstream
    writeStory(project, "active", 7102);
    const result = finalizeCohort({
      projectRoot: project,
      prNumbers: [102],
      cohortStories: ["7101", "7102"],
      repo: REPO,
      deliveryBranch: "master",
      noCommit: true,
      runGh: mockRunGh(
        { 102: { merged: true, body: "Refs #7102\n\ndeft-story: 7102\n" } },
        { 7101: "closed", 7102: "open" },
        [],
      ),
      runGit: mockRunGit([`xbrief/completed/${storyName(7101)}`], []),
      fetchPrChangedFiles: productFiles,
      mergeTimeForge: markForge(),
    });
    expect(result.result.errors).toEqual([]);
    expect(result.result.left_active).toEqual([]);
    expect(result.result.story_paths.map((p) => basename(p))).toEqual([storyName(7102)]);
  });

  it("accepts a reused cohort list naming a completed story by id or path", () => {
    const project = tempRoot("w7082-reuse-");
    writeStory(project, "completed", 7101);
    writeStory(project, "active", 7104);
    const result = finalizeCohort({
      projectRoot: project,
      prNumbers: [101],
      cohortStories: [
        "github.issue.7101",
        join(project, "xbrief", "active", storyName(7101)),
        join(project, "xbrief", "completed", storyName(7101)),
        "7104",
      ],
      repo: REPO,
      deliveryBranch: "master",
      runGh: mockRunGh(
        { 101: { merged: true, body: "Closes #7101", closingIssues: [7101] } },
        { 7101: "closed", 7104: "open" },
        [],
      ),
      runGit: mockRunGit([], []),
    });
    expect(result.result.errors).toEqual([]);
    expect(result.result.left_active).toEqual([{ story: "#7104", issue: 7104, reason: "omitted" }]);
  });

  it("refuses a cohort token with no active or completed brief", () => {
    const project = tempRoot("w7082-unknown-");
    writeStory(project, "active", 7104);
    const result = finalizeCohort({
      projectRoot: project,
      storyTokens: ["7104"],
      cohortStories: ["7999"],
      noCommit: true,
      dryRun: true,
    });
    expect(result.result.errors.some((e) => e.startsWith("cohort story 7999:"))).toBe(true);
    expect(result.exitCode).not.toBe(EXIT_OK);
  });

  it("refuses a post-merge story in-PR, so it stops at merge with deft-story for the closer", () => {
    const project = tempRoot("w7082-refused-");
    const active = writeStory(project, "active", 7102, { "x-directive/requires": "merge" });
    transitionMode.real = true;
    const inPr = runTransition("complete", active, new Date(), {
      inPr: true,
      inPrChangedPaths: ["src/app.ts"],
      skipAcceptanceEvidenceGate: true,
    });
    transitionMode.real = false;
    expect(inPr.ok).toBe(false);
    expect(inPr.message).toContain(IN_PR_POST_MERGE_PATH);
    expect(existsSync(active)).toBe(true);
  });
});

describe("cohort lifecycle: one closer run, one lifecycle PR (#7082 clauses 2, 4, 5, 6)", () => {
  function cohortRun(project: string, landed: readonly number[] = [7102, 7103]) {
    const gh: string[][] = [];
    const git: string[][] = [];
    const result = finalizeCohort({
      projectRoot: project,
      // The closer passes only merged product PRs; #7104's PR is unmerged and left off.
      prNumbers: [102, 103],
      cohortStories: ["7101", "#7102", "7103", "7104"],
      label: "cohort-7082",
      repo: REPO,
      deliveryBranch: "master",
      runGh: mockRunGh(
        {
          102: { merged: true, body: "Refs #7102\n\ndeft-story: 7102\n" },
          103: { merged: true, body: "Refs #7103\n\ndeft-story: 7103\n" },
          104: { merged: false, body: "Refs #7104\n\ndeft-story: 7104\n" },
          9999: { merged: true, body: "" },
        },
        { 7101: "closed", 7102: "open", 7103: "open", 7104: "open" },
        gh,
      ),
      runGit: mockRunGit(
        landed.map((issue) => `xbrief/completed/${storyName(issue)}`),
        git,
      ),
      fetchPrChangedFiles: productFiles,
      mergeTimeForge: markForge(),
      landProbeLimit: 1,
      sleep: () => {},
    });
    return { result, gh, git };
  }

  function seedCohort(project: string): Record<number, string> {
    writeStory(project, "completed", 7101);
    return {
      7102: writeStory(project, "active", 7102),
      7103: writeStory(project, "active", 7103),
      7104: writeStory(project, "active", 7104),
    };
  }

  it("completes several deft-story PRs in one fragment-free lifecycle PR that passes the PR checks", () => {
    const project = tempRoot("w7082-batch-");
    seedCohort(project);
    const { result, gh, git } = cohortRun(project);

    expect(result.result.errors).toEqual([]);
    const creates = gh.filter((c) => c.includes("pr") && c.includes("create"));
    expect(creates).toHaveLength(1);
    expect(result.result.pr_url).toContain("/pull/9999");
    const completed = vi
      .mocked(runTransition)
      .mock.calls.filter((call) => call[0] === "complete")
      .map((call) => basename(String(call[1])))
      .sort();
    expect(completed).toEqual([storyName(7102), storyName(7103)]);

    // No changelog fragment: the lifecycle commit stages only the lifecycle trees.
    const adds = git.filter((c) => c[1] === "add");
    expect(adds.length).toBeGreaterThan(0);
    for (const add of adds) expect(add.slice(2)).toEqual(["-A", "xbrief/"]);
    expect(git.flat().some((part) => part.includes("changelog.d"))).toBe(false);

    const files = [7102, 7103].flatMap((issue) => [
      { status: "removed", filename: `xbrief/active/${storyName(issue)}` },
      { status: "added", filename: `xbrief/completed/${storyName(issue)}` },
    ]);
    const registry = { status: "modified", filename: "xbrief/PROJECT-DEFINITION.xbrief.json" };
    // verify:changelog-unreleased: a delivery-brief-land change set needs no entry (#680 / #6764).
    expect(isDeliveryBriefLandExcluded(files)).toBe(true);
    expect(
      isDeliveryBriefLandExcluded([...files, registry], { projectDefinitionRegistryOnly: true }),
    ).toBe(true);
    // #5656 scope-cover: a lifecycle-only staged set needs no product scope.
    const cover = evaluateProspectiveScopeCover({
      projectRoot: project,
      stagedRelPaths: [...files, registry].map((f) => f.filename),
    });
    expect(cover.ok, cover.message).toBe(true);
    // Closing keywords: the lifecycle body closes nothing and needs no story line.
    const body = readFileSync(String(creates[0]?.[creates[0].indexOf("--body-file") + 1]), "utf8");
    expect(findAllClosingKeywordHits(body, "body")).toEqual([]);
    expect(isLeftoverShapedDiff(files.map((f) => ({ path: f.filename, status: f.status })))).toBe(
      true,
    );
    const storyLine = evaluateStoryLineRequirement({
      bodyText: body,
      prNumber: 9999,
      projectRoot: project,
      repo: REPO,
      files: files.map((f) => ({ path: f.filename, status: f.status })),
    });
    expect(storyLine.ok, storyLine.messages.join("\n")).toBe(true);
  });

  it("names the unmerged story left off the list and keeps it active for a later run", () => {
    const project = tempRoot("w7082-left-");
    const paths = seedCohort(project);
    const before = readFileSync(paths[7104] ?? "", "utf8");
    const { result, gh } = cohortRun(project);

    expect(result.result.left_active).toEqual([{ story: "#7104", issue: 7104, reason: "omitted" }]);
    expect(result.exitCode).toBe(EXIT_INCOMPLETE);
    expect(result.stdout).toContain("Left active for a later run: #7104 (omitted)");
    expect(readFileSync(paths[7104] ?? "", "utf8")).toBe(before);
    expect(gh.some((c) => c.some((p) => p.endsWith("/pulls/104")))).toBe(false);
    // Only the completed stories' origins are owed a close; #7104 is never closed.
    expect(result.result.pending?.issues).toEqual([7102, 7103]);
    expect(gh.some((c) => c.includes("PATCH") && c.some((p) => p.endsWith("/issues/7104")))).toBe(
      false,
    );
  });

  it("names a refused story by id and keeps it active", () => {
    const project = tempRoot("w7082-refusedmark-");
    const paths = seedCohort(project);
    // #7103 is stamped to another PR, so its mark on #103 is refused.
    const doc = JSON.parse(readFileSync(paths[7103] ?? "", "utf8")) as {
      plan: { metadata: Record<string, unknown> };
    };
    doc.plan.metadata.productPullRequest = 1111;
    writeFileSync(paths[7103] ?? "", JSON.stringify(doc), "utf8");
    const { result } = cohortRun(project, [7102]);

    expect(result.result.errors).toEqual([]);
    expect(result.result.left_active).toEqual([
      { story: "#7103", issue: 7103, reason: "refused" },
      { story: "#7104", issue: 7104, reason: "omitted" },
    ]);
    expect(result.result.refused_marks?.map((m) => m.issue)).toEqual([7103]);
    expect(result.exitCode).toBe(EXIT_INCOMPLETE);
  });

  it("passes verify:completed-tracked and verify:orphan-active for every story it completed", () => {
    const project = tempRoot("w7082-verify-");
    seedCohort(project);
    const { result } = cohortRun(project);
    expect(result.result.errors).toEqual([]);

    // Land the run's own moves on a delivery tip, then run both DONE verifiers.
    const swept = result.result.story_paths.map((p) => basename(p));
    expect(swept.sort()).toEqual([storyName(7102), storyName(7103)]);
    for (const name of swept) {
      renameSync(
        join(project, "xbrief", "active", name),
        join(project, "xbrief", "completed", name),
      );
    }
    const git = (...args: string[]) =>
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
        cwd: project,
        stdio: "pipe",
      });
    git("init", "-q");
    git("add", "-A");
    git("commit", "-q", "-m", "land");

    const states: Record<number, "open" | "closed"> = {
      7102: "closed",
      7103: "closed",
      7104: "open",
    };
    const runGh: RunGhFn = (cmd) => {
      const issue = Number(cmd.find((p) => /\/issues\/\d+$/.test(p))?.match(/(\d+)$/)?.[1] ?? "0");
      return issue > 0
        ? { returncode: 0, stdout: JSON.stringify({ state: states[issue] ?? "open" }), stderr: "" }
        : { returncode: 0, stdout: "[]", stderr: "" };
    };
    for (const issue of [7102, 7103]) {
      const tracked = evaluateCompletedTracked(project, {
        issue,
        repo: REPO,
        tip: "HEAD",
        quiet: true,
        resolveIssueState: () => "closed",
      });
      expect(tracked.code, tracked.message).toBe(0);
      const orphan = evaluateOrphanActive(project, { issue, repo: REPO, runGh, quiet: true });
      expect(orphan.code, orphan.message).toBe(0);
    }
    // The story left active is still active with an open issue: no orphan.
    const left = evaluateOrphanActive(project, { issue: 7104, repo: REPO, runGh, quiet: true });
    expect(left.code, left.message).toBe(0);
  });
});

describe("swarm:finalize-cohort --cohort argv (#7082)", () => {
  it("parses repeatable --cohort values into the closer list", () => {
    const parsed = parseFinalizeCohortArgv([
      "--pr",
      "102,103",
      "--cohort",
      "7101,7102",
      "--cohort",
      "7103",
    ]);
    expect(parsed.error).toBeNull();
    expect(parsed.cohortStories).toEqual(["7101,7102", "7103"]);
    expect(parseFinalizeCohortArgv(["--cohort"]).error).toContain("--cohort");
    expect(parseFinalizeCohortArgv(["--pr", "1"]).cohortStories).toBeUndefined();
  });
});
