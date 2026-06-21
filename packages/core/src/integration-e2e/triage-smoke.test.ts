import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { acceptAction, createDefaultDeps, deferAction } from "../triage/actions/index.js";
import {
  bulkAction,
  CacheEmptyError,
  createFilesystemCacheModule,
  createFilesystemCandidatesLogModule,
} from "../triage/bulk/index.js";
import { makeTempRoot, populateCacheLayout, REPO } from "./helpers.js";

function readCandidateAudit(root: string): Array<{ issue_number: number; decision: string }> {
  const auditLog = join(root, "vbrief", ".eval", "candidates.jsonl");
  try {
    return readFileSync(auditLog, "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as { issue_number: number; decision: string });
  } catch {
    return [];
  }
}

describe("integration-e2e triage smoke (mirrors test_triage_smoke.py)", () => {
  it("bulk defer actions only cached issues", () => {
    const root = makeTempRoot("deft-triage-smoke-");
    const cacheRoot = join(root, ".deft-cache");
    populateCacheLayout(cacheRoot, REPO, [1, 2, 3, 4, 5]);
    const deps = createDefaultDeps(root);
    const actions = {
      accept: (n: number, repo: string) => acceptAction(n, repo, deps),
      reject: () => {},
      defer: (n: number, repo: string) =>
        deferAction(n, repo, "bulk defer", deps, { projectRoot: root }),
      needs_ac: () => {},
    };

    bulkAction("defer", REPO, {
      cacheRoot,
      cacheModule: createFilesystemCacheModule(),
      candidatesLogModule: createFilesystemCandidatesLogModule(
        join(root, "vbrief", ".eval", "candidates.jsonl"),
      ),
      actionsModule: actions,
      issuesProvider: undefined,
      out: { write: () => {} },
    });

    const records = readCandidateAudit(root);
    expect(records.map((r) => r.issue_number).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
    expect(records.every((r) => r.decision === "defer")).toBe(true);
    expect(records.some((r) => r.issue_number >= 100)).toBe(false);
  });

  it("bulk defer is idempotent on second pass", () => {
    const root = makeTempRoot("deft-triage-idempotent-");
    const cacheRoot = join(root, ".deft-cache");
    populateCacheLayout(cacheRoot, REPO, [1, 2, 3, 4, 5]);
    const deps = createDefaultDeps(root);
    const actions = {
      accept: (n: number, repo: string) => acceptAction(n, repo, deps),
      reject: () => {},
      defer: (n: number, repo: string) =>
        deferAction(n, repo, "bulk defer", deps, { projectRoot: root }),
      needs_ac: () => {},
    };
    const common = {
      cacheRoot,
      cacheModule: createFilesystemCacheModule(),
      candidatesLogModule: createFilesystemCandidatesLogModule(
        join(root, "vbrief", ".eval", "candidates.jsonl"),
      ),
      actionsModule: actions,
      out: { write: () => {} },
    };

    bulkAction("defer", REPO, common);
    const firstCount = readCandidateAudit(root).length;
    expect(firstCount).toBe(5);

    bulkAction("defer", REPO, common);
    expect(readCandidateAudit(root).length).toBe(firstCount);
  });

  it("empty cache hard fails with canonical message", () => {
    const root = makeTempRoot("deft-triage-empty-");
    const stderr: string[] = [];
    const prevErr = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderr.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      let caught: CacheEmptyError | null = null;
      try {
        bulkAction("defer", REPO, {
          cacheRoot: join(root, ".deft-cache"),
          cacheModule: createFilesystemCacheModule(),
          candidatesLogModule: createFilesystemCandidatesLogModule(
            join(root, "vbrief", ".eval", "candidates.jsonl"),
          ),
          actionsModule: {
            accept: () => {},
            reject: () => {},
            defer: () => {},
            needs_ac: () => {},
          },
          out: { write: () => {} },
        });
      } catch (error) {
        caught = error as CacheEmptyError;
      }
      expect(caught).toBeInstanceOf(CacheEmptyError);
      expect(caught?.message).toContain("cache is empty for deftai/directive");
      expect(caught?.message).toContain("task triage:bootstrap");
      expect(readCandidateAudit(root)).toEqual([]);
    } finally {
      process.stderr.write = prevErr;
    }
  });
});
