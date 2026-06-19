import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readAuditEntries, resolveAuditLogPath } from "./audit.js";
import { buildQueue } from "./build-queue.js";
import {
  collectOrphanIssueNumbers,
  loadCachedIssues,
  loadSliceRecords,
  resolveSlicesLogPath,
} from "./cache.js";
import { deriveGroup } from "./derive-group.js";
import { resolveRankingLabels, validateRankingLabels } from "./ranking-labels.js";
import { renderQueue } from "./render.js";
import { inferRepoFromGit, resolveRepo } from "./repo.js";
import {
  activeReferencedIssueNumbers,
  blockedByIssueNumber,
  issueNumbersFromPlan,
  rankByIssueNumber,
  scopeIsBlocked,
  scopeMetadataRank,
} from "./scope-walk.js";
import {
  compareSelectionKeys,
  dateSortKey,
  selectionOrderingKey,
  withinGroupSortKey,
} from "./selection.js";
import type { AuditEntry, CachedIssue } from "./types.js";

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

function auditEntry(n: number, decision: string, timestamp?: string): AuditEntry {
  return {
    decision_id: "test-id",
    timestamp: timestamp ?? "2026-05-17T20:00:00Z",
    repo: REPO,
    issue_number: n,
    decision,
    actor: "tester",
  };
}

function writeCachedIssue(root: string, row: CachedIssue): void {
  const dir = join(root, ".deft-cache", "github-issue", "owner", "repo", String(row.number));
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "raw.json"),
    JSON.stringify({
      number: row.number,
      title: row.title,
      state: row.state,
      labels: row.labels.map((label) => ({ name: label })),
      updated_at: row.updatedAt,
      created_at: row.createdAt,
    }),
    { encoding: "utf8" },
  );
}

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root !== undefined) {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

function makeTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "deft-triage-queue-test-"));
  tempRoots.push(root);
  return root;
}

describe("deriveGroup", () => {
  it("prioritises RESUME over URGENT when active vBRIEF exists", () => {
    expect(deriveGroup("needs-ac", true)).toBe("RESUME");
  });

  it("maps needs-ac to URGENT", () => {
    expect(deriveGroup("needs-ac", false)).toBe("URGENT");
  });

  it("maps resume-eligible to RESUME", () => {
    expect(deriveGroup("resume-eligible", false)).toBe("RESUME");
  });

  it("maps missing decision to untriaged", () => {
    expect(deriveGroup(null, false)).toBe("untriaged");
  });

  it.each([
    "accept",
    "reject",
    "defer",
    "mark-duplicate",
    "reset",
  ])("maps terminal decision %s to other", (decision) => {
    expect(deriveGroup(decision, false)).toBe("other");
  });
});

describe("buildQueue", () => {
  it("orders RESUME, URGENT, untriaged, other", () => {
    const issues = [issue(1), issue(2), issue(3), issue(4)];
    const audit = [
      auditEntry(3, "needs-ac", "2026-05-17T19:00:00Z"),
      auditEntry(4, "defer", "2026-05-17T18:00:00Z"),
    ];
    const items = buildQueue(issues, audit, {
      repo: REPO,
      queue: { activeReferenced: new Set([2]) },
    });
    expect(items.map((row) => row.number)).toEqual([2, 3, 1, 4]);
    expect(items.map((row) => row.group)).toEqual(["RESUME", "URGENT", "untriaged", "other"]);
  });

  it("places ORPHAN above RESUME", () => {
    const issues = [issue(1), issue(2), issue(3)];
    const items = buildQueue(issues, [], {
      repo: REPO,
      queue: {
        activeReferenced: new Set([2]),
        orphanIssueNumbers: new Set([3]),
      },
    });
    expect(items.map((row) => row.number)).toEqual([3, 2, 1]);
    expect(items.map((row) => row.group)).toEqual(["ORPHAN", "RESUME", "untriaged"]);
  });

  it("sorts untriaged by updated_at descending", () => {
    const issues = [
      issue(10, { updatedAt: "2026-05-15T10:00:00Z" }),
      issue(11, { updatedAt: "2026-05-17T10:00:00Z" }),
      issue(12, { updatedAt: "2026-05-16T10:00:00Z" }),
    ];
    const items = buildQueue(issues, [], { repo: REPO });
    expect(items.map((row) => row.number)).toEqual([11, 12, 10]);
  });

  it("applies consumer ranking labels before updated_at", () => {
    const issues = [
      issue(20, { updatedAt: "2026-05-17T10:00:00Z" }),
      issue(21, { labels: ["breaking-change"], updatedAt: "2026-05-15T10:00:00Z" }),
      issue(22, { labels: ["urgent"], updatedAt: "2026-05-16T10:00:00Z" }),
    ];
    const items = buildQueue(issues, [], {
      repo: REPO,
      queue: { rankingLabels: ["urgent", "breaking-change"] },
    });
    expect(items.map((row) => row.number)).toEqual([22, 21, 20]);
    expect(items[0]?.matchedLabel).toBe("urgent");
    expect(items[1]?.matchedLabel).toBe("breaking-change");
  });

  it("demotes blocked items into BLOCKED group by default", () => {
    const issues = [issue(1), issue(2)];
    const items = buildQueue(issues, [], {
      repo: REPO,
      queue: { blockedIssueNumbers: new Set([1]) },
    });
    expect(items.map((row) => row.number)).toEqual([2, 1]);
    expect(items.find((row) => row.number === 1)?.group).toBe("BLOCKED");
  });

  it("respects limit", () => {
    const issues = Array.from({ length: 10 }, (_, index) => issue(index + 1));
    const items = buildQueue(issues, [], {
      repo: REPO,
      queue: { limit: 3 },
    });
    expect(items).toHaveLength(3);
  });

  it("drops net-new work when finishBeforeStart and wipAtCap are set", () => {
    const issues = [issue(1), issue(2, { continuation: true })];
    const items = buildQueue(issues, [], {
      repo: REPO,
      queue: { finishBeforeStart: true, wipAtCap: true },
    });
    expect(items.map((row) => row.number)).toEqual([2]);
  });

  it("re-surfaces blocked items when includeBlocked is true", () => {
    const issues = [issue(1), issue(2)];
    const items = buildQueue(issues, [], {
      repo: REPO,
      queue: { blockedIssueNumbers: new Set([1]), includeBlocked: true },
    });
    expect(items.every((row) => row.group !== "BLOCKED")).toBe(true);
  });

  it("skips issues without numeric number", () => {
    const issues = [{ title: "bad" } as ReturnType<typeof issue>, issue(2)];
    const items = buildQueue(issues, [], { repo: REPO });
    expect(items.map((row) => row.number)).toEqual([2]);
  });

  it("keeps latest audit decision by timestamp", () => {
    const entries = [
      auditEntry(5, "defer", "2026-05-01T00:00:00Z"),
      auditEntry(5, "needs-ac", "2026-05-02T00:00:00Z"),
    ];
    const items = buildQueue([issue(5)], entries, { repo: REPO });
    expect(items[0]?.group).toBe("URGENT");
  });

  it("sorts continuation work by oldest-started epic order", () => {
    const left = selectionOrderingKey({
      labelIndex: 1,
      isContinuation: true,
      continuationOrder: "2026-01-01-epic.vbrief.json",
    });
    const right = selectionOrderingKey({
      labelIndex: 1,
      isContinuation: true,
      continuationOrder: "2026-02-01-epic.vbrief.json",
    });
    expect(compareSelectionKeys(left, right)).toBeLessThan(0);
  });

  it("keeps orphan rows when finishBeforeStart drops net-new work", () => {
    const issues = [issue(1), issue(2)];
    const items = buildQueue(issues, [], {
      repo: REPO,
      queue: {
        finishBeforeStart: true,
        wipAtCap: true,
        orphanIssueNumbers: new Set([2]),
      },
    });
    expect(items.map((row) => row.number)).toEqual([2]);
  });
});

describe("module exports", () => {
  it("re-exports queue surface from index", async () => {
    const mod = await import("./index.js");
    expect(typeof mod.buildQueue).toBe("function");
    expect(typeof mod.renderQueue).toBe("function");
  });
});

describe("loadCachedIssues", () => {
  it("walks open issues and excludes closed by default", () => {
    const root = makeTempRoot();
    writeCachedIssue(root, issue(1, { title: "Open" }));
    writeCachedIssue(root, issue(2, { title: "Closed", state: "closed" }));
    const rows = loadCachedIssues(REPO, { projectRoot: root });
    expect(rows.map((row) => row.number)).toEqual([1]);
  });

  it("normalises uppercase OPEN state", () => {
    const root = makeTempRoot();
    writeCachedIssue(root, issue(3, { state: "OPEN" }));
    const rows = loadCachedIssues(REPO, { projectRoot: root });
    expect(rows[0]?.state).toBe("open");
  });

  it("returns empty when cache directory is absent", () => {
    const root = makeTempRoot();
    expect(loadCachedIssues(REPO, { projectRoot: root })).toEqual([]);
  });
});

describe("resolveAuditLogPath", () => {
  it("uses explicit audit log override", () => {
    expect(resolveAuditLogPath({ auditLogPath: "/tmp/custom.jsonl" })).toBe("/tmp/custom.jsonl");
  });

  it("uses frameworkRoot when no override is provided", () => {
    const root = makeTempRoot();
    expect(resolveAuditLogPath({ frameworkRoot: root })).toBe(
      join(root, "vbrief", ".eval", "candidates.jsonl"),
    );
  });

  it("prefers DEFT_ROOT env for default resolution", () => {
    const root = makeTempRoot();
    const previous = process.env.DEFT_ROOT;
    process.env.DEFT_ROOT = root;
    expect(resolveAuditLogPath({})).toBe(join(root, "vbrief", ".eval", "candidates.jsonl"));
    process.env.DEFT_ROOT = previous;
  });
});

describe("readAuditEntries", () => {
  it("reads repo-filtered audit rows", () => {
    const root = makeTempRoot();
    const dir = join(root, "vbrief", ".eval");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "candidates.jsonl"),
      [
        JSON.stringify({ repo: REPO, issue_number: 1, decision: "accept", timestamp: "t1" }),
        JSON.stringify({ repo: "other/repo", issue_number: 2, decision: "defer", timestamp: "t2" }),
      ].join("\n"),
      { encoding: "utf8" },
    );
    const rows = readAuditEntries(REPO, {
      auditLogPath: join(dir, "candidates.jsonl"),
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.issue_number).toBe(1);
  });
  it("returns empty when audit log is missing", () => {
    const root = makeTempRoot();
    expect(readAuditEntries(REPO, { auditLogPath: join(root, "missing.jsonl") })).toEqual([]);
  });

  it("skips malformed audit lines", () => {
    const root = makeTempRoot();
    const dir = join(root, "vbrief", ".eval");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "candidates.jsonl"), "not-json\n", { encoding: "utf8" });
    expect(readAuditEntries(REPO, { auditLogPath: join(dir, "candidates.jsonl") })).toEqual([]);
  });
});

describe("loadCachedIssues extended", () => {
  it("includes closed issues when requested", () => {
    const root = makeTempRoot();
    writeCachedIssue(root, issue(1, { state: "open" }));
    writeCachedIssue(root, issue(2, { state: "closed" }));
    const rows = loadCachedIssues(REPO, { projectRoot: root, includeClosed: true });
    expect(rows.map((row) => row.number).sort()).toEqual([1, 2]);
  });

  it("rejects invalid repo slug", () => {
    expect(() => loadCachedIssues("bad-slug", { projectRoot: makeTempRoot() })).toThrow(
      "repo must be 'owner/name'",
    );
  });

  it("skips malformed cache payloads and non-directories", () => {
    const root = makeTempRoot();
    const base = join(root, ".deft-cache", "github-issue", "owner", "repo");
    mkdirSync(join(base, "9"), { recursive: true });
    writeFileSync(join(base, "9", "raw.json"), "not-json", { encoding: "utf8" });
    writeFileSync(join(base, "readme.txt"), "x", { encoding: "utf8" });
    expect(loadCachedIssues(REPO, { projectRoot: root })).toEqual([]);
  });

  it("annotates rank and blocked state from scope vbriefs", () => {
    const root = makeTempRoot();
    writeCachedIssue(root, issue(8, { title: "Ranked" }));
    const pending = join(root, "vbrief", "pending");
    mkdirSync(pending, { recursive: true });
    writeFileSync(
      join(pending, "ranked.vbrief.json"),
      JSON.stringify({
        plan: {
          metadata: { rank: 1 },
          references: [
            { type: "x-vbrief/github-issue", uri: `https://github.com/${REPO}/issues/8` },
          ],
        },
      }),
      { encoding: "utf8" },
    );
    const rows = loadCachedIssues(REPO, { projectRoot: root });
    expect(rows[0]?.metadataRank).toBe(1);
  });
});

describe("scope helpers extended", () => {
  it("parses scope metadata rank", () => {
    expect(scopeMetadataRank({ metadata: { rank: 3 } })).toBe(3);
    expect(scopeMetadataRank({ metadata: { rank: "7" } })).toBe(7);
    expect(scopeMetadataRank({ metadata: { rank: true } })).toBeNull();
  });

  it("extracts issue numbers from plan references", () => {
    const nums = issueNumbersFromPlan({
      references: [
        { type: "x-vbrief/github-issue", uri: "https://github.com/owner/repo/issues/42" },
      ],
    });
    expect([...nums]).toEqual([42]);
  });

  it("detects unresolved and resolved dependency blocks", () => {
    const unresolved = {
      status: "running",
      metadata: { swarm: { depends_on: ["dep-a", "dep-b"] } },
    };
    expect(scopeIsBlocked(unresolved, new Set(["dep-a"]))).toBe(true);
    expect(scopeIsBlocked(unresolved, new Set(["dep-a", "dep-b"]))).toBe(false);
  });

  it("detects blocked scopes and maps them to issue numbers", () => {
    const root = makeTempRoot();
    const pending = join(root, "vbrief", "pending");
    mkdirSync(pending, { recursive: true });
    writeFileSync(
      join(pending, "blocked.vbrief.json"),
      JSON.stringify({
        plan: {
          status: "blocked",
          references: [
            { type: "x-vbrief/github-issue", uri: `https://github.com/${REPO}/issues/9` },
          ],
        },
      }),
      { encoding: "utf8" },
    );
    expect(scopeIsBlocked({ status: "blocked" }, new Set())).toBe(true);
    expect([...blockedByIssueNumber(root)]).toEqual([9]);
  });

  it("collects active referenced issue numbers", () => {
    const root = makeTempRoot();
    const active = join(root, "vbrief", "active");
    mkdirSync(active, { recursive: true });
    writeFileSync(
      join(active, "running.vbrief.json"),
      JSON.stringify({
        plan: {
          status: "running",
          references: [
            { type: "x-vbrief/github-issue", uri: `https://github.com/${REPO}/issues/12` },
          ],
        },
      }),
      { encoding: "utf8" },
    );
    expect([...activeReferencedIssueNumbers(root)]).toEqual([12]);
  });

  it("ignores corrupt scope vbrief files while walking", () => {
    const root = makeTempRoot();
    const pending = join(root, "vbrief", "pending");
    mkdirSync(pending, { recursive: true });
    writeFileSync(join(pending, "bad.vbrief.json"), "not-json", { encoding: "utf8" });
    expect([...blockedByIssueNumber(root)]).toEqual([]);
    expect([...activeReferencedIssueNumbers(root)]).toEqual([]);
  });
  it("maps rank from pending scopes", () => {
    const root = makeTempRoot();
    const pending = join(root, "vbrief", "pending");
    mkdirSync(pending, { recursive: true });
    writeFileSync(
      join(pending, "ranked.vbrief.json"),
      JSON.stringify({
        plan: {
          metadata: { rank: 2 },
          references: [
            { type: "x-vbrief/github-issue", uri: `https://github.com/${REPO}/issues/5` },
          ],
        },
      }),
      { encoding: "utf8" },
    );
    expect(rankByIssueNumber(root).get(5)).toBe(2);
  });
});

describe("orphan helpers", () => {
  it("collects orphan children with closed umbrellas", () => {
    const records = [
      {
        umbrella: 100,
        children: [{ n: 101 }],
      },
    ];
    const issues = new Map<number, CachedIssue>([
      [100, issue(100, { state: "closed" })],
      [101, issue(101, { state: "open" })],
    ]);
    expect([...collectOrphanIssueNumbers(records, issues)]).toEqual([101]);
  });

  it("ignores non-orphan slice records", () => {
    const records = [{ umbrella: 200, children: [{ n: 201 }] }];
    const issues = new Map<number, CachedIssue>([
      [200, issue(200, { state: "open" })],
      [201, issue(201, { state: "open" })],
    ]);
    expect([...collectOrphanIssueNumbers(records, issues)]).toEqual([]);
  });

  it("loads slice records from jsonl", () => {
    const root = makeTempRoot();
    const dir = join(root, "vbrief", ".eval");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "slices.jsonl"), `${JSON.stringify({ slice_id: "s1" })}\n`, {
      encoding: "utf8",
    });
    expect(loadSliceRecords({ slicesLogPath: join(dir, "slices.jsonl") })[0]?.slice_id).toBe("s1");
  });

  it("resolveSlicesLogPath uses frameworkRoot by default", () => {
    const root = makeTempRoot();
    expect(resolveSlicesLogPath({ frameworkRoot: root })).toBe(
      join(root, "vbrief", ".eval", "slices.jsonl"),
    );
  });
});

describe("ranking labels", () => {
  it("validates ranking label payloads", () => {
    expect(validateRankingLabels(null).errors).toEqual([]);
    expect(validateRankingLabels("bad").errors.length).toBeGreaterThan(0);
    expect(validateRankingLabels(["urgent"]).errors).toEqual([]);
    expect(validateRankingLabels([""]).errors.length).toBeGreaterThan(0);
    expect(validateRankingLabels([42]).errors.length).toBeGreaterThan(0);
    expect(validateRankingLabels(["urgent", "urgent"]).warnings.length).toBeGreaterThan(0);
  });

  it("reads consumer ranking labels from project definition", () => {
    const root = makeTempRoot();
    const dir = join(root, "vbrief");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "PROJECT-DEFINITION.vbrief.json"),
      JSON.stringify({
        plan: { policy: { triageRankingLabels: ["urgent", "breaking-change"] } },
      }),
      { encoding: "utf8" },
    );
    expect(resolveRankingLabels(root)).toEqual(["urgent", "breaking-change"]);
  });

  it("returns empty default when project definition is absent", () => {
    expect(resolveRankingLabels("/nonexistent-root")).toEqual([]);
  });
  it("returns empty default for malformed project definition shapes", () => {
    const root = makeTempRoot();
    const dir = join(root, "vbrief");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "PROJECT-DEFINITION.vbrief.json"), '{"plan":"bad"}', {
      encoding: "utf8",
    });
    expect(resolveRankingLabels(root)).toEqual([]);
    writeFileSync(
      join(dir, "PROJECT-DEFINITION.vbrief.json"),
      JSON.stringify({ plan: { policy: { triageRankingLabels: [] } } }),
      { encoding: "utf8" },
    );
    expect(resolveRankingLabels(root)).toEqual([]);
  });

  it("reads audit entries from custom audit log path", () => {
    const root = makeTempRoot();
    const custom = join(root, "custom-audit.jsonl");
    writeFileSync(
      custom,
      `${JSON.stringify({ repo: REPO, issue_number: 8, decision: "defer", timestamp: "t" })}\n`,
      { encoding: "utf8" },
    );
    const rows = readAuditEntries(REPO, { auditLogPath: custom });
    expect(rows[0]?.issue_number).toBe(8);
  });
});

describe("selection extended", () => {
  it("applies bucket deficit ordering for net-new work", () => {
    const left = { ...issue(1), _continuation: false, _bucketDeficit: 1, _resolvedRank: null };
    const right = { ...issue(2), _continuation: false, _bucketDeficit: 5, _resolvedRank: null };
    expect(
      compareSelectionKeys(withinGroupSortKey(left, []), withinGroupSortKey(right, [])),
    ).toBeGreaterThan(0);
  });
});

describe("repo resolution extended", () => {
  it("prefers explicit repo over env", () => {
    const root = makeTempRoot();
    const previous = process.env.DEFT_TRIAGE_REPO;
    process.env.DEFT_TRIAGE_REPO = "env/repo";
    expect(resolveRepo("explicit/repo", root)).toBe("explicit/repo");
    process.env.DEFT_TRIAGE_REPO = previous;
  });

  it("uses env repo when explicit repo is absent", () => {
    const root = makeTempRoot();
    const previous = process.env.DEFT_TRIAGE_REPO;
    process.env.DEFT_TRIAGE_REPO = "env/repo";
    expect(resolveRepo(null, root)).toBe("env/repo");
    process.env.DEFT_TRIAGE_REPO = previous;
  });

  it("infers repo from git origin in the worktree", () => {
    const inferred = inferRepoFromGit(process.cwd());
    expect(inferred).toMatch(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
  });

  it("returns null for invalid git roots", () => {
    const root = makeTempRoot();
    const previous = process.env.DEFT_TRIAGE_REPO;
    delete process.env.DEFT_TRIAGE_REPO;
    expect(inferRepoFromGit(root)).toBeNull();
    expect(resolveRepo(null, root)).toBeNull();
    process.env.DEFT_TRIAGE_REPO = previous;
  });
});

describe("selectionOrderingKey", () => {
  it("prefers continuation over net-new", () => {
    const continuation = selectionOrderingKey({ labelIndex: 1, isContinuation: true });
    const netNew = selectionOrderingKey({ labelIndex: 1, isContinuation: false });
    expect(continuation[1]).toBeLessThan(netNew[1]);
  });

  it("uses empty continuation order bucket when order is absent", () => {
    const key = selectionOrderingKey({
      labelIndex: 0,
      isContinuation: true,
      continuationOrder: "",
    });
    expect(key[2]).toEqual([1, ""]);
  });

  it("uses rank bucket when rank is not an integer", () => {
    const key = selectionOrderingKey({ labelIndex: 0, isContinuation: false, rank: 1.5 });
    expect(key[3]).toBe(1);
    expect(key[4]).toBe(0);
  });

  it("uses default secondary when bucket deficit is not finite", () => {
    const key = selectionOrderingKey({
      labelIndex: 0,
      isContinuation: false,
      bucketDeficit: Number.NaN,
    });
    expect(key[2]).toEqual([0, ""]);
  });
});

describe("dateSortKey", () => {
  it("uses created_at ascending when present", () => {
    const older = dateSortKey(issue(1, { createdAt: "2026-05-01T00:00:00Z" }));
    const newer = dateSortKey(issue(2, { createdAt: "2026-05-02T00:00:00Z" }));
    expect(older[0]).toBe(0);
    expect(newer[0]).toBe(0);
    expect(older[1] < newer[1]).toBe(true);
  });

  it("falls back to complemented updated_at when created_at is absent", () => {
    const key = dateSortKey(issue(1, { updatedAt: "", createdAt: "" }));
    expect(key).toEqual([1, "\u0000"]);
  });

  it("inverts updated_at for descending sort", () => {
    const newer = dateSortKey(issue(1, { updatedAt: "2026-05-02T00:00:00Z" }));
    const older = dateSortKey(issue(2, { updatedAt: "2026-05-01T00:00:00Z" }));
    expect(newer[0]).toBe(1);
    expect(older[0]).toBe(1);
    expect(newer[1] < older[1]).toBe(true);
  });
});

describe("renderQueue", () => {
  it("renders empty-cache guidance", () => {
    const out = renderQueue({ items: [], repo: REPO, limit: 5 });
    expect(out).toContain("consumer ranking labels: <empty>");
    expect(out).toContain("limit: 5");
    expect(out).toContain("no cached issues");
  });

  it("lists consumer ranking labels when configured", () => {
    const out = renderQueue({
      items: [],
      repo: REPO,
      rankingLabels: ["urgent", "breaking-change"],
    });
    expect(out).toContain("urgent, breaking-change");
  });

  it("renders queue rows with markers", () => {
    const out = renderQueue({
      items: [
        {
          number: 7,
          title: "Sample",
          state: "open",
          labels: ["urgent"],
          updatedAt: "2026-05-17T10:00:00Z",
          group: "URGENT",
          latestDecision: "needs-ac",
          matchedLabel: "urgent",
          repo: REPO,
        },
      ],
      repo: REPO,
      rankingLabels: ["urgent"],
    });
    expect(out).toContain("[URGENT]");
    expect(out).toContain("#7");
    expect(out).toContain("(label: urgent)");
  });

  it("truncates long titles in output", () => {
    const out = renderQueue({
      items: [
        {
          number: 99,
          title: "x".repeat(100),
          state: "open",
          labels: [],
          updatedAt: "2026-05-17T10:00:00Z",
          group: "untriaged",
          latestDecision: null,
          matchedLabel: null,
          repo: REPO,
        },
      ],
      repo: REPO,
    });
    expect(out).toContain("...");
  });
});
