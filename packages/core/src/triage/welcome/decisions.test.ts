import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { detectPriorState } from "./prior-state.js";
import { computeSummary, formatOneLiner } from "./summary.js";

function writeCache(root: string, num: number): void {
  const dir = join(root, ".deft-cache", "github-issue", "deftai", "directive", String(num));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "raw.json"), JSON.stringify({ number: num, state: "open" }), "utf8");
}

describe("summary decision branches", () => {
  it("counts reject defer and reset as untriaged variants", () => {
    const root = mkdtempSync(join(tmpdir(), "sum-dec-"));
    for (const n of [1, 2, 3, 4]) writeCache(root, n);
    mkdirSync(join(root, "vbrief", ".eval"), { recursive: true });
    writeFileSync(
      join(root, "vbrief", ".eval", "candidates.jsonl"),
      [
        { repo: "deftai/directive", issue_number: 1, decision: "reject" },
        { repo: "deftai/directive", issue_number: 2, decision: "defer" },
        { repo: "deftai/directive", issue_number: 3, decision: "reset" },
        { repo: "deftai/directive", issue_number: 4, decision: "accept" },
      ]
        .map((e) => JSON.stringify(e))
        .join("\n"),
      "utf8",
    );
    const result = computeSummary(root);
    expect(result.untriaged).toBeGreaterThan(0);
    expect(result.inFlightCacheScoped).toBe(1);
    expect(formatOneLiner(result)).toContain("in-flight");
    rmSync(root, { recursive: true, force: true });
  });
});

describe("prior-state pending decisions", () => {
  it("counts pending human decisions", () => {
    const root = mkdtempSync(join(tmpdir(), "prior-pend-"));
    mkdirSync(join(root, "vbrief", ".audit"), { recursive: true });
    writeFileSync(
      join(root, "vbrief", ".audit", "pending-human-decisions.jsonl"),
      [
        { decision_id: "a", status: "pending" },
        { decision_id: "b", status: "resolved" },
        { decision_id: "a", status: "pending" },
      ]
        .map((e) => JSON.stringify(e))
        .join("\n"),
      "utf8",
    );
    expect(detectPriorState(root).pendingDecisions).toBe(1);
    rmSync(root, { recursive: true, force: true });
  });
});
