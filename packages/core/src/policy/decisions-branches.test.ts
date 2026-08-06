/**
 * Branch coverage for pending human-decisions backlog (#3144 coverage-debt hairline).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_PENDING_DECISIONS_THRESHOLD,
  pendingDecisionsLogPath,
  pendingDecisionsNudgeLine,
  readDecisionEvents,
  summarizeDecisionBacklog,
} from "./decisions.js";

const roots: string[] = [];
const NOW = new Date("2026-08-06T12:00:00Z");

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "deft-decisions-br-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

describe("readDecisionEvents branches (#3144)", () => {
  it("returns empty when the log is missing", () => {
    const root = tempRoot();
    expect(readDecisionEvents(root)).toEqual([]);
  });

  it("skips blank, malformed, non-object, and decision_id-less lines", () => {
    const root = tempRoot();
    const path = pendingDecisionsLogPath(root);
    mkdirSync(join(root, "xbrief", ".audit"), { recursive: true });
    writeFileSync(
      path,
      [
        "",
        "   ",
        "not-json",
        JSON.stringify(["array"]),
        JSON.stringify({ status: "pending" }),
        JSON.stringify({ decision_id: "ok-1", status: "pending", kind: "gate" }),
        JSON.stringify({ decision_id: 42, status: "pending" }),
      ].join("\n"),
    );
    const events = readDecisionEvents(root);
    expect(events).toHaveLength(1);
    expect(events[0]?.decision_id).toBe("ok-1");
  });

  it("honors an explicit log path override", () => {
    const root = tempRoot();
    const custom = join(root, "custom.jsonl");
    writeFileSync(
      custom,
      `${JSON.stringify({ decision_id: "c1", status: "pending", kind: "review" })}\n`,
    );
    expect(readDecisionEvents(root, custom)).toHaveLength(1);
  });
});

describe("summarizeDecisionBacklog branches (#3144)", () => {
  it("counts pending kinds and uses unspecified when kind missing", () => {
    const backlog = summarizeDecisionBacklog(tempRoot(), {
      now: NOW,
      events: [
        { decision_id: "a", status: "pending", kind: "gate" },
        { decision_id: "b", status: "pending" },
        { decision_id: "b", status: "pending", kind: "merge" },
        { decision_id: "c", status: "resolved", timestamp: "2026-08-05T00:00:00Z" },
      ],
    });
    expect(backlog.pending_count).toBe(2);
    expect(backlog.by_kind.gate).toBe(1);
    expect(backlog.by_kind.merge).toBe(1);
    expect(backlog.resolved_in_window).toBe(1);
  });

  it("applies window filter, override rate, and p0 reversal", () => {
    const backlog = summarizeDecisionBacklog(tempRoot(), {
      now: NOW,
      window_days: 7,
      events: [
        {
          decision_id: "r1",
          status: "resolved",
          timestamp: "2026-08-05T00:00:00Z",
          override: true,
          p0_reversal: true,
        },
        {
          decision_id: "r2",
          status: "resolved",
          timestamp: "2026-08-01T00:00:00Z",
          override: false,
        },
        {
          decision_id: "old",
          status: "resolved",
          timestamp: "2026-06-01T00:00:00Z",
          override: true,
        },
        {
          decision_id: "bad-ts",
          status: "resolved",
          timestamp: "not-a-date",
          override: true,
        },
        {
          decision_id: "future",
          status: "resolved",
          timestamp: "2026-08-20T00:00:00Z",
          override: true,
        },
        { decision_id: "still", status: "pending", kind: "gate" },
      ],
    });
    expect(backlog.pending_count).toBe(1);
    expect(backlog.resolved_in_window).toBe(2);
    expect(backlog.override_count).toBe(1);
    expect(backlog.p0_reversal_in_window).toBe(true);
    expect(backlog.override_rate).toBeCloseTo(0.5);
  });

  it("returns zero override rate when no resolved events", () => {
    const backlog = summarizeDecisionBacklog(tempRoot(), {
      now: NOW,
      events: [{ decision_id: "p", status: "pending", kind: "gate" }],
    });
    expect(backlog.override_rate).toBe(0);
    expect(backlog.resolved_in_window).toBe(0);
  });

  it("skips empty decision_id when building latest map", () => {
    const backlog = summarizeDecisionBacklog(tempRoot(), {
      events: [
        { decision_id: "", status: "pending" },
        { decision_id: "x", status: "pending", kind: "gate" },
      ],
    });
    expect(backlog.pending_count).toBe(1);
  });
});

describe("pendingDecisionsNudgeLine branches (#3144)", () => {
  it("returns empty at or under threshold", () => {
    expect(pendingDecisionsNudgeLine(DEFAULT_PENDING_DECISIONS_THRESHOLD)).toBe("");
    expect(pendingDecisionsNudgeLine(0)).toBe("");
    expect(pendingDecisionsNudgeLine(3, 5)).toBe("");
  });

  it("emits tier-1 nudge above threshold", () => {
    const line = pendingDecisionsNudgeLine(9, 5);
    expect(line).toMatch(/\[TIER-1\]/);
    expect(line).toMatch(/9 decision/);
    expect(line).toMatch(/threshold 5/);
  });
});
