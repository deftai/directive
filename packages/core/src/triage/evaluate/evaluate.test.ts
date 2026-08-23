import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writePlanSequence } from "../../plan-sequence/store.js";
import type { PlanSequence } from "../../plan-sequence/types.js";
import { EvaluateError, evaluateIssues, renderEvaluateText } from "./evaluate.js";
import { evaluatorWorktreePath, sha12Of, sinkDir } from "./paths.js";
import type { GithubIssueSnapshot, GithubPullSnapshot, GitRunner } from "./types.js";
import { RESERVED_CLEARANCE_RE } from "./types.js";
import { evaluateValidity, joinValidityWithGithub } from "./validity.js";
import { buildValueAdvice, formatValueField, ReservedClearanceError } from "./value.js";
import { collectWipCensus } from "./wip-census.js";

const temps: string[] = [];

afterEach(() => {
  for (const root of temps.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "deft-issue-eval-"));
  temps.push(root);
  return root;
}

function writeXbrief(dir: string, issue: number, title: string): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `2026-08-23-${issue}-sample.xbrief.json`);
  writeFileSync(
    path,
    JSON.stringify({
      xBRIEFInfo: { version: "0.8" },
      plan: {
        title,
        references: [
          {
            uri: `https://github.com/deftai/directive/issues/${issue}`,
            type: "x-xbrief/github-issue",
            title: `Issue #${issue}`,
          },
        ],
      },
    }),
    "utf8",
  );
  return path;
}

function issueSnap(
  partial: Partial<GithubIssueSnapshot> & { number: number },
): GithubIssueSnapshot {
  return {
    state: "open",
    title: `Issue ${partial.number}`,
    body: "",
    labels: [],
    htmlUrl: `https://github.com/deftai/directive/issues/${partial.number}`,
    pullRequest: false,
    duplicateOf: null,
    ...partial,
  };
}

function fakeGit(originSha = "abcdef1234567890aaaa"): GitRunner {
  return (args, cwd) => {
    if (args[0] === "rev-parse") {
      return { returncode: 0, stdout: `${originSha}\n`, stderr: "" };
    }
    if (args[0] === "worktree" && args[1] === "add") {
      const dest = args[3];
      if (typeof dest === "string") {
        mkdirSync(dest, { recursive: true });
        mkdirSync(join(dest, "xbrief", "completed"), { recursive: true });
        mkdirSync(join(dest, "docs", "decisions"), { recursive: true });
        mkdirSync(join(dest, "content", "contracts"), { recursive: true });
      }
      return { returncode: 0, stdout: `added in ${cwd}`, stderr: "" };
    }
    if (args[0] === "worktree" && args[1] === "remove") {
      const dest = args[3];
      if (typeof dest === "string") {
        rmSync(dest, { recursive: true, force: true });
      }
      return { returncode: 0, stdout: "", stderr: "" };
    }
    return { returncode: 0, stdout: "", stderr: "" };
  };
}

describe("collectWipCensus", () => {
  it("reads live active, pending, and plan-sequence only", () => {
    const root = tempRoot();
    writeXbrief(join(root, "xbrief", "active"), 10, "active ten");
    writeXbrief(join(root, "xbrief", "pending"), 11, "pending eleven");
    writeXbrief(join(root, "xbrief", "completed"), 10, "completed should not count as WIP");
    const sequence: PlanSequence = {
      sequence_id: "s1",
      sequence_kind: "triage",
      entries: [{ id: "10", kind: "issue", issue: 10, title: "ten" }],
      current_index: 0,
      batching_allowed: false,
      continuation_past_final: false,
      exhausted: false,
      authorized_by: "test",
      created_at: "2026-08-23T00:00:00Z",
      updated_at: "2026-08-23T00:00:00Z",
    };
    writePlanSequence(root, sequence);
    const census = collectWipCensus(root, [10, 11, 12]);
    expect(census.active.map((h) => h.issue)).toEqual([10]);
    expect(census.pending.map((h) => h.issue)).toEqual([11]);
    expect(census.planSequence.map((h) => h.issue)).toEqual([10]);
  });
});

describe("evaluateValidity", () => {
  it("does not see parent WIP files", () => {
    const parent = tempRoot();
    writeXbrief(join(parent, "xbrief", "active"), 22, "live active");
    const worktree = join(parent, "detached");
    mkdirSync(join(worktree, "xbrief", "completed"), { recursive: true });
    const verdict = evaluateValidity(worktree, 22);
    expect(verdict.state).toBe("still-open");
    expect(verdict.evidence).not.toMatch(/active/);
  });

  it("reports likely-shipped from completed xbrief on the worktree", () => {
    const worktree = tempRoot();
    writeXbrief(join(worktree, "xbrief", "completed"), 22, "shipped");
    const verdict = evaluateValidity(worktree, 22);
    expect(verdict.state).toBe("likely-shipped");
  });

  it("reports partial from a committed pending xbrief", () => {
    const worktree = tempRoot();
    writeXbrief(join(worktree, "xbrief", "pending"), 22, "in flight on master");
    const verdict = evaluateValidity(worktree, 22);
    expect(verdict.state).toBe("partial");
  });
});

describe("buildValueAdvice", () => {
  it("uses critique-recommend and refuses reserved clearance grammar", () => {
    const advice = buildValueAdvice(
      issueSnap({ number: 1, labels: ["design-critique:mechanism-shaped"] }),
    );
    expect(advice["critique-recommend"]).toBe(true);
    expect(JSON.stringify(advice)).not.toMatch(RESERVED_CLEARANCE_RE);
    expect(() => {
      if (
        RESERVED_CLEARANCE_RE.test("design-critique: warranted, because the lean inverts a default")
      ) {
        throw new ReservedClearanceError("reserved");
      }
    }).toThrow(ReservedClearanceError);
  });
});

describe("evaluateIssues", () => {
  it("splits parent WIP from evaluator validity, writes sink, tears down worktrees", async () => {
    const root = tempRoot();
    writeXbrief(join(root, "xbrief", "active"), 42, "live wip");
    const sessionCalls: string[] = [];
    const gitCalls: string[][] = [];
    const git: GitRunner = (args, cwd) => {
      gitCalls.push([cwd, ...args]);
      return fakeGit()(args, cwd);
    };
    const result = await evaluateIssues({
      projectRoot: root,
      repo: "deftai/directive",
      issues: [42],
      invocationId: "inv-1",
      git,
      sessionStart: (path) => {
        sessionCalls.push(path);
      },
      github: {
        viewIssue: (_repo, n) => issueSnap({ number: n }),
        listOpenIssues: () => [issueSnap({ number: 42 })],
        listOpenPulls: () => [
          {
            number: 99,
            title: "WIP for 42",
            body: "Fixes #42",
            htmlUrl: "https://github.com/deftai/directive/pull/99",
            mentions: [42],
          } satisfies GithubPullSnapshot,
        ],
      },
    });
    expect(result.sha12).toBe("abcdef123456");
    expect(result.invocationId).toBe("inv-1");
    expect(result.concurrency).toBe(4);
    expect(sessionCalls).toHaveLength(1);
    expect(sessionCalls[0]).toContain("issue-eval-42-inv-1");
    const verdict = result.verdicts[0];
    expect(verdict?.validity?.state).toBe("still-open");
    expect(verdict?.wip.some((hit) => hit.kind === "active-xbrief")).toBe(true);
    expect(verdict?.openPulls.map((p) => p.number)).toEqual([99]);
    expect(verdict?.value["critique-recommend"]).toBe(false);
    const sink = sinkDir(root, result.sha12, result.invocationId);
    const manifest = JSON.parse(readFileSync(join(sink, "manifest.json"), "utf8")) as {
      verdicts: unknown[];
    };
    expect(manifest.verdicts).toHaveLength(1);
    expect(existsSync(join(sink, "issue-42.json"))).toBe(true);
    expect(existsSync(evaluatorWorktreePath(root, 42, "inv-1"))).toBe(false);
    expect(gitCalls.some((c) => c.includes("remove"))).toBe(true);
    expect(
      gitCalls.some(
        (c) => c.includes("add") && c.includes("--detach") && c.includes("abcdef1234567890aaaa"),
      ),
    ).toBe(true);
    expect(gitCalls.every((c) => !(c.includes("add") && c.includes("origin/master")))).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(RESERVED_CLEARANCE_RE);
    expect(JSON.stringify(result)).not.toContain("candidates.jsonl");
    expect(JSON.stringify(result)).not.toContain("xbrief/.eval");
  });

  it("removes the worktree when the evaluator throws", async () => {
    const root = tempRoot();
    const removes: string[] = [];
    const git: GitRunner = (args, cwd) => {
      if (args[0] === "worktree" && args[1] === "remove") {
        removes.push(String(args[3]));
      }
      return fakeGit()(args, cwd);
    };
    const result = await evaluateIssues({
      projectRoot: root,
      repo: "deftai/directive",
      issues: [7],
      invocationId: "inv-fail",
      git,
      sessionStart: () => {
        throw new Error("session boom");
      },
      github: {
        viewIssue: (_repo, n) => issueSnap({ number: n }),
        listOpenIssues: () => [],
        listOpenPulls: () => [],
      },
    });
    expect(result.verdicts[0]?.error).toMatch(/session boom/);
    expect(removes.some((p) => p.includes("issue-eval-7-inv-fail"))).toBe(true);
  });

  it("records teardown failure instead of swallowing it", async () => {
    const root = tempRoot();
    const git: GitRunner = (args, cwd) => {
      if (args[0] === "worktree" && args[1] === "remove") {
        return { returncode: 1, stdout: "", stderr: "locked" };
      }
      return fakeGit()(args, cwd);
    };
    const result = await evaluateIssues({
      projectRoot: root,
      repo: "deftai/directive",
      issues: [7],
      invocationId: "inv-teardown",
      git,
      sessionStart: () => {},
      github: {
        viewIssue: (_repo, n) => issueSnap({ number: n }),
        listOpenIssues: () => [],
        listOpenPulls: () => [],
      },
    });
    expect(result.verdicts[0]?.error).toMatch(/locked/);
  });

  it("GCs stale sha12 directories", async () => {
    const root = tempRoot();
    const stale = join(root, ".deft-scratch", "issue-eval", "deadbeefdead");
    mkdirSync(stale, { recursive: true });
    writeFileSync(join(stale, "old.json"), "{}", "utf8");
    await evaluateIssues({
      projectRoot: root,
      repo: "deftai/directive",
      issues: [1],
      invocationId: "inv-gc",
      git: fakeGit("ffffffffffffffffffffffffffff"),
      sessionStart: () => {},
      github: {
        viewIssue: (_repo, n) => issueSnap({ number: n }),
        listOpenIssues: () => [],
        listOpenPulls: () => [],
      },
    });
    expect(existsSync(join(root, ".deft-scratch", "issue-eval", "ffffffffffff"))).toBe(true);
    expect(existsSync(stale)).toBe(false);
  });

  it("never passes WIP census into evaluateValidity (signature lock)", () => {
    expect(evaluateValidity.length).toBe(2);
  });

  it("rejects empty issues and non-positive concurrency", async () => {
    const root = tempRoot();
    await expect(
      evaluateIssues({
        projectRoot: root,
        repo: "deftai/directive",
        issues: [],
        git: fakeGit(),
        sessionStart: () => {},
        github: {
          viewIssue: () => issueSnap({ number: 1 }),
          listOpenIssues: () => [],
          listOpenPulls: () => [],
        },
      }),
    ).rejects.toBeInstanceOf(EvaluateError);
    await expect(
      evaluateIssues({
        projectRoot: root,
        repo: "deftai/directive",
        issues: [1],
        concurrency: 0,
        git: fakeGit(),
        sessionStart: () => {},
        github: {
          viewIssue: () => issueSnap({ number: 1 }),
          listOpenIssues: () => [],
          listOpenPulls: () => [],
        },
      }),
    ).rejects.toMatchObject({ message: expect.stringMatching(/concurrency/) });
  });

  it("joins closed GitHub with still-open validity as likely-shipped", async () => {
    const root = tempRoot();
    const result = await evaluateIssues({
      projectRoot: root,
      repo: "deftai/directive",
      issues: [5],
      invocationId: "inv-closed",
      git: fakeGit(),
      sessionStart: () => {},
      github: {
        viewIssue: (_repo, n) => issueSnap({ number: n, state: "closed" }),
        listOpenIssues: () => [],
        listOpenPulls: () => [],
      },
    });
    expect(result.verdicts[0]?.validity?.state).toBe("likely-shipped");
    expect(renderEvaluateText(result)).toContain("critique-recommend: false");
  });

  it("sets critique-recommend when mechanism-shaped is labeled", async () => {
    const root = tempRoot();
    const result = await evaluateIssues({
      projectRoot: root,
      repo: "deftai/directive",
      issues: [6],
      invocationId: "inv-value",
      git: fakeGit(),
      sessionStart: () => {},
      github: {
        viewIssue: (_repo, n) =>
          issueSnap({ number: n, labels: ["design-critique:mechanism-shaped"] }),
        listOpenIssues: () => [],
        listOpenPulls: () => [],
      },
    });
    const value = result.verdicts[0]?.value;
    expect(value?.["critique-recommend"]).toBe(true);
    expect(value !== undefined ? formatValueField(value) : "").toContain(
      "critique-recommend: true",
    );
  });
});

describe("sha12Of and joinValidityWithGithub", () => {
  it("slices a full SHA and rejects junk", () => {
    expect(sha12Of("ABCDEF1234567890")).toBe("abcdef123456");
    expect(() => sha12Of("not-a-sha")).toThrow(/git object id/);
  });

  it("marks needs-re-scope when master shipped but GitHub is open", () => {
    const joined = joinValidityWithGithub(
      {
        state: "likely-shipped",
        evidence: "completed xbrief",
        worktreePath: "/wt",
        sessionStartReadOnly: true,
      },
      "open",
    );
    expect(joined.state).toBe("needs-re-scope");
  });
});
