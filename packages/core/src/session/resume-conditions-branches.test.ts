import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildContext,
  evaluate,
  evaluateResumeEligibility,
  parse,
  ResumeGrammarError,
} from "./resume-conditions.js";

const temps: string[] = [];
afterEach(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true });
  temps.length = 0;
});

describe("resume-conditions branches", () => {
  it("parse rejects non-string input and multi-operator forms", () => {
    expect(() => parse(1 as unknown as string)).toThrow(ResumeGrammarError);
    expect(() => parse("ref:closed:#1 AND ref:merged:#2 OR date:>=2026-01-01")).toThrow(
      ResumeGrammarError,
    );
    expect(() => parse("ref:closed:#1 AND ref:merged:#2 AND date:>=2026-01-01")).toThrow(
      ResumeGrammarError,
    );
  });

  it("buildContext filters cache by repo slug", () => {
    const root = mkdtempSync(join(tmpdir(), "resume-repo-"));
    temps.push(root);
    for (const [owner, repo, n] of [
      ["deftai", "directive", 1],
      ["other", "proj", 2],
    ] as const) {
      mkdirSync(join(root, ".deft-cache", "github-issue", owner, repo, String(n)), {
        recursive: true,
      });
      writeFileSync(
        join(root, ".deft-cache", "github-issue", owner, repo, String(n), "raw.json"),
        JSON.stringify({ state: "closed" }),
        "utf8",
      );
    }
    const scoped = buildContext(root, { repo: "deftai/directive" });
    expect(scoped.closedRefs.has(1)).toBe(true);
    expect(scoped.closedRefs.has(2)).toBe(false);
  });

  it("evaluateResumeEligibility skips superseded defers", () => {
    const log = {
      entries: [] as Record<string, unknown>[],
      readAll: () => log.entries,
      append: (entry: Record<string, unknown>) => {
        log.entries.push(entry);
      },
      newDecisionId: () => "new",
    };
    log.entries.push(
      {
        decision_id: "d1",
        timestamp: "2026-06-01T00:00:00Z",
        repo: "r/o",
        issue_number: 1,
        decision: "defer",
        resume_on: "pending-count:>=0",
      },
      {
        decision_id: "d2",
        timestamp: "2026-06-02T00:00:00Z",
        repo: "r/o",
        issue_number: 1,
        decision: "accept",
      },
      {
        decision_id: "d3",
        timestamp: "2026-06-03T00:00:00Z",
        repo: "r/o",
        issue_number: 2,
        decision: "defer",
        resume_on: "pending-count:>=0",
      },
    );
    const root = mkdtempSync(join(tmpdir(), "resume-eval-"));
    temps.push(root);
    const out = evaluateResumeEligibility(root, {
      logModule: log,
      nowIso: () => "2026-06-09T00:00:00Z",
    });
    expect(out.length).toBe(1);
    expect(out[0]?.issue_number).toBe(2);
  });

  it("slice-wave-ready returns false without earlier children", () => {
    const sid = "22222222-2222-2222-2222-222222222222";
    const expr = parse(`slice-wave-ready:${sid}:1`);
    const ctx = buildContext("/tmp", {
      today: "2026-06-09",
      slices: [{ slice_id: sid, children: [{ wave: 1, n: 1 }] }],
    });
    expect(evaluate(expr, ctx)).toBe(false);
  });
});
