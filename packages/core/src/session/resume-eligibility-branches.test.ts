import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { evaluateResumeEligibility, RESUME_ELIGIBLE_DECISION } from "./resume-conditions.js";

const temps: string[] = [];
afterEach(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true });
  temps.length = 0;
});

describe("evaluateResumeEligibility branches", () => {
  it("returns empty when log module is null", () => {
    expect(evaluateResumeEligibility("/tmp", { logModule: null })).toEqual([]);
  });

  it("appends resume-eligible when defer condition fires", () => {
    const root = mkdtempSync(join(tmpdir(), "resume-elig-"));
    temps.push(root);
    mkdirSync(join(root, "vbrief", "pending"), { recursive: true });
    const appended: Record<string, unknown>[] = [];
    const result = evaluateResumeEligibility(root, {
      today: "2026-06-09",
      logModule: {
        readAll: () => [
          {
            decision_id: "d1",
            timestamp: "2026-06-01",
            repo: "org/repo",
            issue_number: 42,
            decision: "defer",
            resume_on: "date:>=2026-06-01",
          },
        ],
        append: (entry) => {
          appended.push(entry);
        },
        newDecisionId: () => "new-id",
      },
      nowIso: () => "2026-06-09T12:00:00Z",
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.decision).toBe(RESUME_ELIGIBLE_DECISION);
    expect(appended).toHaveLength(1);
  });

  it("writes via auditLogPath option", () => {
    const root = mkdtempSync(join(tmpdir(), "resume-path-"));
    temps.push(root);
    mkdirSync(join(root, "vbrief", "pending"), { recursive: true });
    let pathUsed = "";
    evaluateResumeEligibility(root, {
      today: "2026-06-09",
      auditLogPath: "/tmp/audit.jsonl",
      logModule: {
        readAll: () => [
          {
            decision_id: "d1",
            timestamp: "2026-06-01",
            repo: "org/repo",
            issue_number: 1,
            decision: "defer",
            resume_on: "pending-count:<=5",
          },
        ],
        append: (_entry, opts) => {
          pathUsed = opts?.path ?? "";
        },
      },
    });
    expect(pathUsed).toBe("/tmp/audit.jsonl");
  });

  it("skips superseded defer and invalid resume_on types", () => {
    const root = mkdtempSync(join(tmpdir(), "resume-skip-"));
    temps.push(root);
    expect(
      evaluateResumeEligibility(root, {
        logModule: {
          readAll: () => [
            {
              decision_id: "d1",
              timestamp: "2026-06-01",
              repo: "org/repo",
              issue_number: 1,
              decision: "defer",
              resume_on: "date:>=2026-06-09",
            },
            {
              decision_id: "d2",
              timestamp: "2026-06-02",
              repo: "org/repo",
              issue_number: 1,
              decision: "accept",
            },
            {
              decision_id: "d3",
              timestamp: "2026-06-01",
              repo: "org/repo",
              issue_number: 2,
              decision: "defer",
            },
          ],
          append: () => {},
        },
        today: "2026-06-09",
      }),
    ).toEqual([]);
  });

  it("buildContext counts merged cache entries", () => {
    const root = mkdtempSync(join(tmpdir(), "resume-cache-"));
    temps.push(root);
    const rawPath = join(root, ".deft-cache", "github-issue", "org", "repo", "7", "raw.json");
    mkdirSync(join(rawPath, ".."), { recursive: true });
    writeFileSync(rawPath, JSON.stringify({ state: "open", mergedAt: "2026-06-01" }), "utf8");
    const result = evaluateResumeEligibility(root, {
      today: "2026-06-09",
      repo: "org/repo",
      logModule: {
        readAll: () => [
          {
            decision_id: "d1",
            timestamp: "2026-06-01",
            repo: "org/repo",
            issue_number: 9,
            decision: "defer",
            resume_on: "ref:merged:#7",
          },
        ],
        append: () => {},
      },
    });
    expect(result).toHaveLength(1);
  });
});
