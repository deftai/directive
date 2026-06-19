import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  append,
  CandidatesLogError,
  findByIssue,
  latestDecision,
  newDecisionId,
  readAll,
} from "./candidates-log.js";

function entry(overrides: Record<string, unknown> = {}) {
  return {
    decision_id: newDecisionId(),
    timestamp: "2026-05-03T16:32:54Z",
    repo: "deftai/directive",
    issue_number: 845,
    decision: "accept",
    actor: "agent:test",
    ...overrides,
  };
}

describe("candidates-log", () => {
  it("append and read round trip", () => {
    const dir = mkdtempSync(join(tmpdir(), "candidates-"));
    const log = join(dir, "candidates.jsonl");
    const e1 = entry({ issue_number: 1 });
    append(e1, { path: log });
    const rows = readAll(undefined, { path: log });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.decision_id).toBe(e1.decision_id);
    rmSync(dir, { recursive: true, force: true });
  });

  it("skips malformed lines", () => {
    const dir = mkdtempSync(join(tmpdir(), "candidates-malformed-"));
    const log = join(dir, "candidates.jsonl");
    const valid = entry({ issue_number: 10 });
    append(valid, { path: log });
    writeFileSync(log, "not json\n", { flag: "a" });
    const warnings: string[] = [];
    const rows = readAll(undefined, {
      path: log,
      warn: (m) => warnings.push(m),
    });
    expect(rows).toHaveLength(1);
    expect(warnings.length).toBeGreaterThan(0);
    rmSync(dir, { recursive: true, force: true });
  });

  it("rejects invalid entries", () => {
    expect(() =>
      append({} as Record<string, unknown>, { path: join(tmpdir(), "x.jsonl") }),
    ).toThrow(CandidatesLogError);
  });

  it("latestDecision sorts by timestamp", () => {
    const dir = mkdtempSync(join(tmpdir(), "candidates-latest-"));
    const log = join(dir, "candidates.jsonl");
    append(entry({ issue_number: 7, timestamp: "2026-05-01T00:00:00Z" }), { path: log });
    append(entry({ issue_number: 7, timestamp: "2026-05-02T00:00:00Z", decision: "defer" }), {
      path: log,
    });
    const latest = latestDecision(7, "deftai/directive", { path: log });
    expect(latest?.decision).toBe("defer");
    expect(findByIssue(7, "deftai/directive", { path: log })).toHaveLength(2);
    rmSync(dir, { recursive: true, force: true });
  });
});
