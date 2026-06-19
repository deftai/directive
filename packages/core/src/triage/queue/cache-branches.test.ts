import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  collectOrphanIssueNumbers,
  loadCachedIssues,
  loadSliceRecords,
  resolveSlicesLogPath,
} from "./cache.js";
import type { CachedIssue } from "./types.js";

const REPO = "owner/repo";

function issue(n: number, overrides: Partial<CachedIssue> = {}): CachedIssue {
  return {
    number: n,
    title: overrides.title ?? `Issue ${n}`,
    state: overrides.state ?? "open",
    labels: overrides.labels ?? [],
    updatedAt: overrides.updatedAt ?? "2026-05-17T20:00:00Z",
    createdAt: overrides.createdAt ?? "",
    metadataRank: overrides.metadataRank ?? null,
    continuation: overrides.continuation ?? false,
    continuationOrder: overrides.continuationOrder ?? "",
    bucketDeficit: overrides.bucketDeficit ?? null,
    blocked: overrides.blocked ?? false,
  };
}

const roots: string[] = [];
afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.length = 0;
});

function makeTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "cache-branches-"));
  roots.push(root);
  return root;
}

describe("resolveSlicesLogPath branches", () => {
  it("prefers explicit slicesLogPath override", () => {
    expect(resolveSlicesLogPath({ slicesLogPath: "/custom/slices.jsonl" })).toBe(
      "/custom/slices.jsonl",
    );
  });

  it("falls back to DEFT_ROOT env when frameworkRoot is null", () => {
    const root = makeTempRoot();
    const prev = process.env.DEFT_ROOT;
    process.env.DEFT_ROOT = root;
    expect(resolveSlicesLogPath({ frameworkRoot: null })).toBe(
      join(root, "vbrief", ".eval", "slices.jsonl"),
    );
    process.env.DEFT_ROOT = prev;
  });
});

describe("loadSliceRecords branches", () => {
  it("skips blank and malformed jsonl lines", () => {
    const root = makeTempRoot();
    const path = join(root, "slices.jsonl");
    writeFileSync(path, `\nnot-json\n${JSON.stringify({ ok: true })}\n`, "utf8");
    const rows = loadSliceRecords({ slicesLogPath: path });
    expect(rows).toEqual([{ ok: true }]);
  });

  it("skips non-object json values", () => {
    const root = makeTempRoot();
    const path = join(root, "slices.jsonl");
    writeFileSync(path, `"string"\n42\n`, "utf8");
    expect(loadSliceRecords({ slicesLogPath: path })).toEqual([]);
  });
});

describe("collectOrphanIssueNumbers branches", () => {
  it("ignores records with non-numeric umbrella or invalid children", () => {
    const issues = new Map<number, CachedIssue>([[101, issue(101, { state: "open" })]]);
    expect(
      collectOrphanIssueNumbers([{ umbrella: "bad", children: [{ n: 101 }] }], issues),
    ).toEqual(new Set());
    expect(collectOrphanIssueNumbers([{ umbrella: 1, children: "bad" }], issues)).toEqual(
      new Set(),
    );
    expect(
      collectOrphanIssueNumbers([{ umbrella: 1, children: [null, { n: "x" }] }], new Map()),
    ).toEqual(new Set());
  });

  it("ignores closed child issues", () => {
    const records = [{ umbrella: 100, children: [{ n: 101 }] }];
    const issues = new Map<number, CachedIssue>([
      [100, issue(100, { state: "closed" })],
      [101, issue(101, { state: "closed" })],
    ]);
    expect([...collectOrphanIssueNumbers(records, issues)]).toEqual([]);
  });
});

describe("loadCachedIssues branches", () => {
  it("rejects malformed repo slugs", () => {
    const root = makeTempRoot();
    expect(() => loadCachedIssues("owneronly", { projectRoot: root })).toThrow(/owner\/name/);
    expect(() => loadCachedIssues("owner/", { projectRoot: root })).toThrow(/owner\/name/);
    expect(() => loadCachedIssues("/name", { projectRoot: root })).toThrow(/owner\/name/);
  });

  it("skips non-numeric cache directories and missing raw.json", () => {
    const root = makeTempRoot();
    const base = join(root, ".deft-cache", "github-issue", "owner", "repo");
    mkdirSync(join(base, "notes"), { recursive: true });
    mkdirSync(join(base, "5"), { recursive: true });
    expect(loadCachedIssues(REPO, { projectRoot: root })).toEqual([]);
  });

  it("skips invalid raw.json and derives number from directory name", () => {
    const root = makeTempRoot();
    const base = join(root, ".deft-cache", "github-issue", "owner", "repo");
    mkdirSync(join(base, "7"), { recursive: true });
    writeFileSync(join(base, "7", "raw.json"), "not-json", "utf8");
    mkdirSync(join(base, "8"), { recursive: true });
    writeFileSync(
      join(base, "8", "raw.json"),
      JSON.stringify({ title: "No number field", state: "open", labels: ["a"] }),
      "utf8",
    );
    const rows = loadCachedIssues(REPO, { projectRoot: root });
    expect(rows.map((r) => r.number)).toEqual([8]);
  });

  it("parses string label arrays and non-string states", () => {
    const root = makeTempRoot();
    const dir = join(root, ".deft-cache", "github-issue", "owner", "repo", "9");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "raw.json"),
      JSON.stringify({
        number: 9,
        title: "Mixed labels",
        state: 123,
        labels: ["plain", { name: "named" }, { bad: true }],
      }),
      "utf8",
    );
    const rows = loadCachedIssues(REPO, { projectRoot: root });
    expect(rows[0]?.labels).toEqual(["plain", "named"]);
    expect(rows[0]?.state).toBe("open");
  });

  it("skips entries when number cannot be resolved", () => {
    const root = makeTempRoot();
    const dir = join(root, ".deft-cache", "github-issue", "owner", "repo", "bad");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "raw.json"), JSON.stringify({ title: "x" }), "utf8");
    expect(loadCachedIssues(REPO, { projectRoot: root })).toEqual([]);
  });
});
