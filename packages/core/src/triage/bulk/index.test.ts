import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  bulkAction,
  bulkActionWithDefaults,
  CacheEmptyError,
  createFilesystemCacheModule,
  createFilesystemCandidatesLogModule,
  excludeLogged,
  filterIssues,
  iterCacheKeys,
  listCachedCandidates,
  parseRepo,
} from "./index.js";

const temps: string[] = [];
afterAll(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true });
});

function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "deft-bulk-test-"));
  temps.push(root);
  return root;
}

describe("parseRepo", () => {
  it("accepts owner/name", () => {
    expect(parseRepo("deftai/directive")).toEqual(["deftai", "directive"]);
  });
  it("rejects invalid repo", () => {
    expect(() => parseRepo("bad")).toThrow(/invalid repo/);
    expect(() => parseRepo("a/b/c")).toThrow(/invalid repo/);
    expect(() => parseRepo("bad name/repo")).toThrow(/invalid repo/);
  });
});

describe("filterIssues", () => {
  const issues = [
    {
      number: 1,
      labels: [{ name: "bug" }],
      author: { login: "alice" },
      createdAt: "2020-01-01T00:00:00Z",
    },
    {
      number: 2,
      labels: [{ name: "feature" }],
      author: { login: "bob" },
      createdAt: new Date().toISOString(),
    },
  ];

  it("filters by label and author with AND semantics", () => {
    const matched = filterIssues(issues, { label: "bug", author: "alice" });
    expect(matched).toHaveLength(1);
    expect(matched[0]?.number).toBe(1);
    expect(filterIssues(issues, { author: "nobody" })).toHaveLength(0);
  });

  it("filters by age-days", () => {
    const matched = filterIssues(issues, { ageDays: 30, now: new Date() });
    expect(matched.map((i) => i.number)).toEqual([1]);
  });

  it("skips issues without createdAt when age-days set", () => {
    const matched = filterIssues([{ number: 9, labels: [] }], { ageDays: 1, now: new Date() });
    expect(matched).toHaveLength(0);
  });

  it("skips issues with invalid createdAt when age-days set", () => {
    const matched = filterIssues([{ number: 9, labels: [], createdAt: "not-a-date" }], {
      ageDays: 1,
      now: new Date(),
    });
    expect(matched).toHaveLength(0);
  });

  it("filters by cluster label or bare slug", () => {
    const withCluster = [
      { number: 3, labels: [{ name: "cluster:foo" }], createdAt: "2020-01-01T00:00:00Z" },
      { number: 4, labels: [{ name: "foo" }], createdAt: "2020-01-01T00:00:00Z" },
    ];
    expect(filterIssues(withCluster, { cluster: "foo" })).toHaveLength(2);
  });
});

describe("excludeLogged", () => {
  it("skips terminal decisions always", () => {
    const log = {
      readAll: () => [
        { issue_number: 1, timestamp: "2026-01-01T00:00:00Z", decision: "accept", repo: "o/r" },
      ],
    };
    const kept = excludeLogged([{ number: 1 }], {
      repo: "o/r",
      reAction: false,
      candidatesLogModule: log,
    });
    expect(kept).toHaveLength(0);
  });

  it("allows defer re-action when reAction is true", () => {
    const log = {
      readAll: () => [
        { issue_number: 2, timestamp: "2026-01-01T00:00:00Z", decision: "defer", repo: "o/r" },
      ],
    };
    const kept = excludeLogged([{ number: 2 }], {
      repo: "o/r",
      reAction: true,
      candidatesLogModule: log,
    });
    expect(kept).toHaveLength(1);
  });

  it("allows needs-ac re-action when reAction is true", () => {
    const log = {
      readAll: () => [
        { issue_number: 3, timestamp: "2026-01-01T00:00:00Z", decision: "needs-ac", repo: "o/r" },
      ],
    };
    const kept = excludeLogged([{ number: 3 }], {
      repo: "o/r",
      reAction: true,
      candidatesLogModule: log,
    });
    expect(kept).toHaveLength(1);
  });
});

describe("bulkAction", () => {
  it("raises CacheEmptyError when cache has no candidates", () => {
    expect(() =>
      bulkAction("accept", "deftai/directive", {
        issuesProvider: () => [],
      }),
    ).toThrow(CacheEmptyError);
    expect(iterCacheKeys("deftai/directive", makeRepo())).toEqual([]);
  });

  it("returns zero and prints message when filters match nothing", () => {
    const lines: string[] = [];
    const out = { write: (t: string) => lines.push(t) };
    const actions = {
      accept: () => {},
      reject: () => {},
      defer: () => {},
      needs_ac: () => {},
    };
    const count = bulkAction("defer", "deftai/directive", {
      issuesProvider: () => [{ number: 1, labels: [{ name: "x" }] }],
      label: "missing",
      actionsModule: actions,
      candidatesLogModule: { readAll: () => [] },
      out,
    });
    expect(count).toBe(0);
    expect(lines.join("")).toContain("zero matches");
  });

  it("invokes action for matched issues", () => {
    const calls: number[] = [];
    const lines: string[] = [];
    bulkAction("accept", "deftai/directive", {
      issuesProvider: () => [
        { number: 7, labels: [] },
        { number: 8, labels: [] },
      ],
      actionsModule: {
        accept: (n: number) => {
          calls.push(n);
        },
        reject: () => {},
        defer: () => {},
        needs_ac: () => {},
      },
      candidatesLogModule: { readAll: () => [] },
      out: { write: (t: string) => lines.push(t) },
    });
    expect(calls).toEqual([7, 8]);
    expect(lines.join("")).toContain("total: 2");
  });

  it("re-action bypasses prior defer audit records", () => {
    const calls: number[] = [];
    const log = {
      readAll: () => [
        { issue_number: 11, timestamp: "2026-01-01T00:00:00Z", decision: "defer", repo: "o/r" },
      ],
    };
    bulkAction("defer", "o/r", {
      issuesProvider: () => [{ number: 11, labels: [] }],
      reAction: true,
      actionsModule: {
        accept: () => {},
        reject: () => {},
        defer: (n: number) => {
          calls.push(n);
        },
        needs_ac: () => {},
      },
      candidatesLogModule: log,
      out: { write: () => {} },
    });
    expect(calls).toEqual([11]);
  });
});

describe("filesystem cache integration", () => {
  it("reads cached issues via listCachedCandidates", () => {
    const root = makeRepo();
    const base = join(root, "github-issue", "deftai", "directive", "42");
    mkdirSync(base, { recursive: true });
    writeFileSync(
      join(base, "raw.json"),
      JSON.stringify({ number: 42, labels: [], createdAt: "2020-01-01T00:00:00Z" }),
      "utf8",
    );
    writeFileSync(
      join(base, "meta.json"),
      JSON.stringify({ source: "github-issue", key: "deftai/directive/42" }),
      "utf8",
    );
    const cache = createFilesystemCacheModule();
    const issues = listCachedCandidates("deftai/directive", {
      cacheRoot: root,
      cacheModule: cache,
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.number).toBe(42);
  });

  it("bulkActionWithDefaults hits zero-match path", () => {
    const root = makeRepo();
    const base = join(root, ".deft-cache", "github-issue", "deftai", "parity", "1");
    mkdirSync(base, { recursive: true });
    writeFileSync(join(base, "raw.json"), JSON.stringify({ number: 1, labels: [] }), "utf8");
    writeFileSync(join(base, "meta.json"), JSON.stringify({ ok: true }), "utf8");
    const lines: string[] = [];
    const count = bulkActionWithDefaults("defer", "deftai/parity", {
      deftRoot: root,
      cacheRoot: join(root, ".deft-cache"),
      label: "missing-label",
      actionsModule: { accept: () => {}, reject: () => {}, defer: () => {}, needs_ac: () => {} },
      candidatesLogModule: createFilesystemCandidatesLogModule(),
      out: { write: (t) => lines.push(t) },
    });
    expect(count).toBe(0);
    expect(lines.join("")).toContain("zero matches");
  });
});

describe("iterCacheKeys", () => {
  it("walks numeric issue directories only", () => {
    const root = makeRepo();
    const base = join(root, "github-issue", "deftai", "directive");
    mkdirSync(join(base, "1"), { recursive: true });
    mkdirSync(join(base, "notes"), { recursive: true });
    mkdirSync(join(base, "2"), { recursive: true });
    writeFileSync(join(base, "2", "raw.json"), "{}", "utf8");
    expect(iterCacheKeys("deftai/directive", root)).toEqual([
      "deftai/directive/1",
      "deftai/directive/2",
    ]);
  });
});

describe("bulk edge paths", () => {
  it("skips malformed issue numbers and logs skip line", () => {
    const lines: string[] = [];
    bulkAction("accept", "deftai/directive", {
      issuesProvider: () => [{ number: "bad" as unknown as number }, { number: 5, labels: [] }],
      actionsModule: {
        accept: () => {},
        reject: () => {},
        defer: () => {},
        needs_ac: () => {},
      },
      candidatesLogModule: { readAll: () => [] },
      out: { write: (t) => lines.push(t) },
    });
    expect(lines.join("")).toContain("skipping malformed");
    expect(lines.join("")).toContain("#5");
  });

  it("reject uses reason fallback when kwargs signature mismatches", () => {
    const calls: unknown[] = [];
    const rejectFn = (n: number, repo: string, reason?: string) => {
      if (reason === undefined) {
        throw new TypeError("missing 1 required positional argument 'reason'");
      }
      calls.push([n, repo, reason]);
    };
    bulkAction("reject", "deftai/directive", {
      issuesProvider: () => [{ number: 9, labels: [] }],
      reason: "duplicate",
      actionsModule: {
        accept: () => {},
        reject: rejectFn,
        defer: () => {},
        needs_ac: () => {},
      },
      candidatesLogModule: { readAll: () => [] },
      out: { write: () => {} },
    });
    expect(calls).toEqual([[9, "deftai/directive", { reason: "duplicate" }]]);
  });

  it("excludeLogged writes skip message when audit records exist", () => {
    const lines: string[] = [];
    const log = {
      readAll: () => [
        { issue_number: 1, timestamp: "2026-01-01T00:00:00Z", decision: "defer", repo: "o/r" },
      ],
    };
    bulkAction("defer", "o/r", {
      issuesProvider: () => [{ number: 1, labels: [] }],
      actionsModule: { accept: () => {}, reject: () => {}, defer: () => {}, needs_ac: () => {} },
      candidatesLogModule: log,
      out: { write: (t) => lines.push(t) },
    });
    expect(lines.join("")).toContain("skipped 1 candidate");
  });

  it("listCachedCandidates warns on cache miss and malformed raw", () => {
    const root = makeRepo();
    const base = join(root, "github-issue", "deftai", "directive");
    mkdirSync(join(base, "1"), { recursive: true });
    mkdirSync(join(base, "2"), { recursive: true });
    writeFileSync(join(base, "2", "meta.json"), "not-json", "utf8");
    writeFileSync(join(base, "2", "raw.json"), "[]", "utf8");
    const cache = createFilesystemCacheModule();
    const lines: string[] = [];
    const issues = listCachedCandidates("deftai/directive", {
      cacheRoot: root,
      cacheModule: cache,
      out: { write: (t) => lines.push(t) },
    });
    expect(issues).toHaveLength(0);
    expect(lines.join("")).toMatch(/WARN/);
  });

  it("listCachedCandidates warns on array raw payload", () => {
    const root = makeRepo();
    const base = join(root, "github-issue", "deftai", "directive", "4");
    mkdirSync(base, { recursive: true });
    writeFileSync(join(base, "meta.json"), JSON.stringify({ ok: true }), "utf8");
    writeFileSync(join(base, "raw.json"), "[]", "utf8");
    const cache = createFilesystemCacheModule();
    const lines: string[] = [];
    listCachedCandidates("deftai/directive", {
      cacheRoot: root,
      cacheModule: cache,
      out: { write: (t) => lines.push(t) },
    });
    expect(lines.join("")).toContain("non-object raw.json");
  });

  it("createFilesystemCandidatesLogModule filters by repo", () => {
    const root = makeRepo();
    mkdirSync(join(root, "vbrief", ".eval"), { recursive: true });
    writeFileSync(
      join(root, "vbrief", ".eval", "candidates.jsonl"),
      `${JSON.stringify({ repo: "a/b", issue_number: 1, decision: "defer" })}\n` +
        `${JSON.stringify({ repo: "c/d", issue_number: 2, decision: "accept" })}\n` +
        `not-json\n`,
      "utf8",
    );
    const mod = createFilesystemCandidatesLogModule(
      join(root, "vbrief", ".eval", "candidates.jsonl"),
    );
    expect(mod.readAll({ repo: "a/b" })).toHaveLength(1);
    expect(mod.readAll({ repo: "missing/r" })).toHaveLength(0);
  });

  it("bulkAction rejects unknown action", () => {
    expect(() => bulkAction("nope", "deftai/directive", { issuesProvider: () => [] })).toThrow(
      /Unknown bulk action/,
    );
  });

  it("bulkAction requires actions module when matches exist", () => {
    expect(() =>
      bulkAction("accept", "deftai/directive", {
        issuesProvider: () => [{ number: 1, labels: [] }],
        candidatesLogModule: { readAll: () => [] },
      }),
    ).toThrow(/triage_actions module not available/);
  });

  it("parseRepo rejects empty string", () => {
    expect(() => parseRepo("")).toThrow(/non-empty/);
  });

  it("filesystem cache rejects invalid cache keys", () => {
    const cache = createFilesystemCacheModule();
    expect(() =>
      cache.cacheGet("github-issue", "only/two", { cacheRoot: makeRepo(), allowStale: true }),
    ).toThrow(/invalid cache key/);
  });

  it("listCachedCandidates warns on unreadable raw.json", () => {
    const root = makeRepo();
    const base = join(root, "github-issue", "deftai", "directive", "3");
    mkdirSync(base, { recursive: true });
    writeFileSync(join(base, "meta.json"), JSON.stringify({ ok: true }), "utf8");
    const cache = createFilesystemCacheModule();
    const lines: string[] = [];
    listCachedCandidates("deftai/directive", {
      cacheRoot: root,
      cacheModule: cache,
      out: { write: (t) => lines.push(t) },
    });
    expect(lines.join("")).toContain("unreadable raw.json");
  });

  it("bulkAction reject with null reason calls reject without kwargs", () => {
    const calls: unknown[] = [];
    const rejectFn = (n: number, repo: string, ...args: unknown[]) => {
      calls.push([n, repo, ...args]);
    };
    bulkAction("reject", "deftai/directive", {
      issuesProvider: () => [{ number: 9, labels: [] }],
      reason: null,
      actionsModule: {
        accept: () => {},
        reject: rejectFn,
        defer: () => {},
        needs_ac: () => {},
      },
      candidatesLogModule: { readAll: () => [] },
      out: { write: () => {} },
    });
    expect(calls).toEqual([[9, "deftai/directive"]]);
  });
});
