import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  main,
  parseQueueHeadRef,
  prNumberFromCommitMessage,
  runMergeGroupCheckFromEvent,
} from "./merge-group-cli.js";
import { InProcessAppStore } from "./simulator.js";

describe("merge-group CLI", () => {
  it("fails closed on missing head sha", () => {
    const result = runMergeGroupCheckFromEvent({ action: "checks_requested" });
    expect(result.conclusion).toBe("failure");
  });

  it("passes a single-origin constituent when the App store has no grant", () => {
    const store = new InProcessAppStore();
    const result = runMergeGroupCheckFromEvent(
      { action: "checks_requested", merge_group: { head_sha: "abc" } },
      {
        store,
        loadConstituents: () => [
          {
            prNodeId: "PR_1",
            repo: "deftai/directive",
            closingIssuesReferences: [4494],
            body: "Closes #4494",
            commitMessages: [],
          },
        ],
      },
    );
    expect(result.conclusion).toBe("success");
  });
});

describe("merge-group CLI entry", () => {
  it("fails closed without GITHUB_EVENT_PATH", () => {
    expect(main(["node", "merge-group-cli.js"], {})).toBe(1);
  });

  it("reads GITHUB_EVENT_PATH and fails on empty merge_group", () => {
    const dir = mkdtempSync(join(tmpdir(), "mg-"));
    const path = join(dir, "event.json");
    writeFileSync(path, '{"action":"checks_requested"}\n');
    expect(main(["node", "merge-group-cli.js"], { GITHUB_EVENT_PATH: path })).toBe(1);
  });
});

const REPO = "deftai/directive";
const BASE = "b".repeat(40);
const HEAD = "a".repeat(40);

interface Fixture {
  readonly compare?: unknown;
  readonly compareRc?: number;
  readonly pullRc?: Record<number, number>;
  readonly closing?: Record<number, number[]>;
  readonly closingRc?: number;
  readonly rawCompare?: string;
  readonly rawPull?: string;
}

function ghFixture(f: Fixture, calls: string[] = []) {
  return (cmd: readonly string[]) => {
    const joined = cmd.join(" ");
    calls.push(joined);
    if (joined.includes("/compare/")) {
      return {
        returncode: f.compareRc ?? 0,
        stdout: f.rawCompare ?? JSON.stringify(f.compare ?? { commits: [] }),
        stderr: f.compareRc ? "compare boom" : "",
      };
    }
    if (joined.startsWith("gh pr view")) {
      const n = Number(cmd[3]);
      return {
        returncode: f.closingRc ?? 0,
        stdout: JSON.stringify({
          closingIssuesReferences: (f.closing?.[n] ?? []).map((x) => ({ number: x })),
        }),
        stderr: f.closingRc ? "graphql boom" : "",
      };
    }
    if (/pulls\/(\d+)\/commits/.test(joined)) return { returncode: 0, stdout: "[]", stderr: "" };
    const pullMatch = /pulls\/(\d+)$/.exec(joined);
    if (pullMatch) {
      const n = Number(pullMatch[1]);
      const rc = f.pullRc?.[n] ?? 0;
      return {
        returncode: rc,
        stdout: f.rawPull ?? JSON.stringify({ number: n, node_id: `PR_${n}`, body: "" }),
        stderr: rc ? "pull boom" : "",
      };
    }
    return { returncode: 1, stdout: "", stderr: "unexpected" };
  };
}

function event(over: { head_ref?: string; base_sha?: string; repo?: string } = {}) {
  return {
    action: "checks_requested",
    merge_group: {
      head_sha: HEAD,
      head_ref: over.head_ref ?? `refs/heads/gh-readonly-queue/master/pr-7001-${HEAD}`,
      base_sha: over.base_sha ?? BASE,
      base_ref: "refs/heads/master",
    },
    repository: { full_name: over.repo ?? REPO },
  };
}

const squash = (...ns: number[]) => ({
  commits: ns.map((n) => ({ sha: `c${n}`, commit: { message: `fix: thing (#${n})\n\nbody` } })),
});

describe("merge-queue constituent discovery (#6424)", () => {
  it("parses queue refs: slash base, optional refs/heads, rejects others", () => {
    expect(parseQueueHeadRef(`gh-readonly-queue/master/pr-12-${HEAD}`)).toBe(12);
    expect(parseQueueHeadRef(`refs/heads/gh-readonly-queue/release/0.1/pr-9-${HEAD}`)).toBe(9);
    expect(parseQueueHeadRef("feature/pr-9-abc")).toBeNull();
    expect(parseQueueHeadRef("")).toBeNull();
    expect(prNumberFromCommitMessage("feat: x (#42)\n\nCloses #1 (#9)")).toBe(42);
    expect(prNumberFromCommitMessage("Merge pull request #7 from a/b")).toBe(7);
    expect(prNumberFromCommitMessage("no marker")).toBeNull();
  });

  it("passes a single-entry group loaded over REST pulls/N", () => {
    const calls: string[] = [];
    const result = runMergeGroupCheckFromEvent(event(), {
      store: new InProcessAppStore(),
      runGh: ghFixture({ compare: squash(7001), closing: { 7001: [6424] } }, calls),
    });
    expect(result.conclusion).toBe("success");
    expect(calls.some((c) => c.endsWith("repos/deftai/directive/pulls/7001"))).toBe(true);
    expect(calls.some((c) => c.includes("/commits/") && c.endsWith("/pulls"))).toBe(false);
  });

  it("loads every PR of a 3-entry group and dedupes the tip", () => {
    const calls: string[] = [];
    const result = runMergeGroupCheckFromEvent(event(), {
      store: new InProcessAppStore(),
      runGh: ghFixture({ compare: squash(6999, 7000, 7001) }, calls),
    });
    expect(result.conclusion).toBe("success");
    for (const n of [6999, 7000, 7001]) {
      expect(calls.filter((c) => c.endsWith(`repos/deftai/directive/pulls/${n}`))).toHaveLength(1);
    }
  });

  it("fails on a member that a tip-only census would miss", () => {
    const result = runMergeGroupCheckFromEvent(event(), {
      store: new InProcessAppStore(),
      runGh: ghFixture({ compare: squash(7000, 7001), closing: { 7000: [1, 2], 7001: [3] } }),
    });
    expect(result.conclusion).toBe("failure");
    expect(result.summary).toMatch(/unbound claim/);
  });

  it("names a nonzero compare failure with its stderr", () => {
    const result = runMergeGroupCheckFromEvent(event(), {
      store: new InProcessAppStore(),
      runGh: ghFixture({ compareRc: 1 }),
    });
    expect(result.conclusion).toBe("failure");
    expect(result.summary).toMatch(/compare .* failed \(exit 1: compare boom\)/);
    expect(result.summary).not.toMatch(/missing constituent/);
  });

  it("names invalid and wrong-shape JSON", () => {
    const bad = runMergeGroupCheckFromEvent(event(), {
      store: new InProcessAppStore(),
      runGh: ghFixture({ rawCompare: "not json" }),
    });
    expect(bad.summary).toMatch(/compare returned unparseable or wrong-shape/);
    const shape = runMergeGroupCheckFromEvent(event(), {
      store: new InProcessAppStore(),
      runGh: ghFixture({ compare: squash(7001), rawPull: "[1,2]" }),
    });
    expect(shape.summary).toMatch(/PR #7001 lookup returned unparseable or wrong-shape/);
  });

  it("names a failed PR lookup and failed closing references", () => {
    const pull = runMergeGroupCheckFromEvent(event(), {
      store: new InProcessAppStore(),
      runGh: ghFixture({ compare: squash(7001), pullRc: { 7001: 1 } }),
    });
    expect(pull.summary).toMatch(/PR #7001 lookup failed \(exit 1: pull boom\)/);
    const closing = runMergeGroupCheckFromEvent(event(), {
      store: new InProcessAppStore(),
      runGh: ghFixture({ compare: squash(7001), closingRc: 1 }),
    });
    expect(closing.summary).toMatch(
      /PR #7001 closing references unreadable \(exit 1: graphql boom\)/,
    );
  });

  it("fails closed on a range commit whose title names no PR", () => {
    const range = squash(7001);
    range.commits.unshift({ sha: "cX", commit: { message: "chore: untitled" } });
    const result = runMergeGroupCheckFromEvent(event(), {
      store: new InProcessAppStore(),
      runGh: ghFixture({ compare: range }),
    });
    expect(result.conclusion).toBe("failure");
    expect(result.summary).toMatch(/commit cX has no PR number/);
  });

  it("fails on a truncated compare range", () => {
    const result = runMergeGroupCheckFromEvent(event(), {
      store: new InProcessAppStore(),
      runGh: ghFixture({ compare: { total_commits: 150, ...squash(7001) } }),
    });
    expect(result.summary).toMatch(/compare range truncated/);
  });

  it("fails on missing repository.full_name and missing base_sha", () => {
    const noRepo = runMergeGroupCheckFromEvent(event({ repo: " " }), {
      store: new InProcessAppStore(),
      runGh: ghFixture({}),
    });
    expect(noRepo.summary).toMatch(/missing repository.full_name/);
    const noBase = runMergeGroupCheckFromEvent(event({ base_sha: "" }), {
      store: new InProcessAppStore(),
      runGh: ghFixture({}),
    });
    expect(noBase.summary).toMatch(/missing merge_group.base_sha/);
  });

  it("falls back to commit-to-PR discovery when head_ref is unparseable, keeping the reason", () => {
    const ok = runMergeGroupCheckFromEvent(event({ head_ref: "weird" }), {
      store: new InProcessAppStore(),
      runGh: (cmd) =>
        cmd.join(" ").includes(`/commits/${HEAD}/pulls`)
          ? { returncode: 0, stdout: JSON.stringify([{ number: 7001 }]), stderr: "" }
          : ghFixture({})(cmd),
    });
    expect(ok.conclusion).toBe("success");
    const bad = runMergeGroupCheckFromEvent(event({ head_ref: "weird" }), {
      store: new InProcessAppStore(),
      runGh: (cmd) =>
        cmd.join(" ").includes(`/commits/${HEAD}/pulls`)
          ? { returncode: 1, stdout: "", stderr: "no access" }
          : ghFixture({})(cmd),
    });
    expect(bad.summary).toMatch(/unparseable merge_group.head_ref "weird".*exit 1: no access/);
  });
});
